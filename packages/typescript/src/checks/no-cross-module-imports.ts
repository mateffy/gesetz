import type { Check, Violation } from '@gesetz/core';

export interface NoCrossModuleImportsOptions {
  /**
   * Captures the module name from a path in group 1. The match should end at the
   * module boundary, e.g. `/src\/domains\/([^/]+)\//`.
   */
  readonly modulePattern: RegExp;
  readonly message?: (from: string, to: string) => string;
  readonly severity?: Violation['severity'] | undefined;
}

interface Located {
  readonly module: string;
  /** the path after the module boundary */
  readonly rest: string;
}

/**
 * Splits a path into its module name and everything below it.
 *
 * A module may be imported through its own entry point — `../crm` or
 * `../crm/index` — and that is the supported way to cross a boundary. Reaching
 * past it into `../crm/internal/thing` is what this check is for, so the two
 * cases are told apart by what follows the module segment.
 */
function locate(path: string, pattern: RegExp): Located | null {
  const match = pattern.exec(path);
  if (match === null || match[1] === undefined) return null;
  return { module: match[1], rest: path.slice(match.index + match[0].length) };
}

const isEntryPoint = (rest: string): boolean =>
  rest === '' || /^index\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(rest);

/**
 * Bans imports that cross a module boundary without going through the target
 * module's entry point.
 *
 * Modules are named by `modulePattern`, which is applied to both the importing
 * file's path and the resolved path of each relative import. A violation is
 * reported when the two module names differ and the import target is not the
 * other module's `index`.
 *
 * Bare specifiers are ignored: `react` has no module segment to compare. An
 * import that cannot be resolved is also ignored, which is deliberate — a
 * separate rule owns unresolvable imports.
 *
 * @example
 * noCrossModuleImports({
 *   modulePattern: /src\/components\/domains\/([^/]+)\//,
 *   message: (from, to) => `Domain '${from}' must not import into '${to}' internals.`,
 * })
 */
export function noCrossModuleImports(opts: NoCrossModuleImportsOptions): Check {
  // a shared RegExp with the `g` flag keeps lastIndex between calls
  const pattern = new RegExp(opts.modulePattern.source, opts.modulePattern.flags.replace(/g/g, ''));

  return async (file, { syntax, imports }) => {
    if (!syntax.canProcess(file)) return [];

    const here = locate(file.path, pattern);
    if (here === null) return [];

    const result = await syntax.process(file, { imports: true });
    const violations: Violation[] = [];

    for (const imported of result.imports) {
      if (!imported.specifier.startsWith('.')) continue;
      const resolved = imports.resolve(file, imported.specifier);
      if (resolved === null) continue;

      const there = locate(resolved, pattern);
      if (there === null || there.module === here.module) continue;
      if (isEntryPoint(there.rest)) continue;

      violations.push({
        rule: 'no-cross-module-imports',
        severity: opts.severity ?? 'error',
        source: 'custom',
        message:
          opts.message?.(here.module, there.module) ??
          `Module '${here.module}' must not import into module '${there.module}' internals. Import from its index instead.`,
        path: file.path,
        line: imported.line,
      });
    }

    return violations;
  };
}
