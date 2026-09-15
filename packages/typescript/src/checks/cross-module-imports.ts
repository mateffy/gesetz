import * as nodePath from 'node:path';
import type { Check, Violation } from '@gesetz/core';

export interface NoCrossModuleImportsOptions {
  /**
   * Captures a module name in group 1 from a repo-relative path, e.g.
   * `/src\/components\/domains\/([^/]+)\//` captures `billing` from
   * `src/components/domains/billing/Invoice.tsx`.
   */
  readonly modulePattern: RegExp;
  /** Violation message, given the importing and imported module names. */
  readonly message: (from: string, to: string) => string;
  readonly severity?: Violation['severity'] | undefined;
}

/**
 * Flags imports that cross from one module into another module's internals.
 *
 * Both the importing file and the resolved import target are matched against
 * `modulePattern`; a violation is reported only when both match *and* the
 * captured names differ. Imports that stay inside their own module, and imports
 * that leave the pattern's scope entirely, are ignored.
 *
 * Resolution is relative-path based (`services.imports.resolve`), so bare
 * package specifiers never match — this check is about internal boundaries.
 *
 * @example
 * const domains = select('src/components/domains/**\/*.{ts,tsx}')
 *   .label('No deep imports across domains')
 *   .check(
 *     noCrossModuleImports({
 *       modulePattern: /\/domains\/([^/]+)\//,
 *       message: (from, to) => `Domain '${from}' must not import '${to}' internals.`,
 *     }),
 *   );
 */
export function noCrossModuleImports(opts: NoCrossModuleImportsOptions): Check {
  return async (file, services) => {
    const from = opts.modulePattern.exec(file.path)?.[1];
    if (from === undefined) return [];

    const { syntax, imports, projectRoot } = services;
    if (!syntax.canProcess(file)) return [];

    let parsed;
    try {
      parsed = await syntax.process(file, { imports: true });
    } catch {
      return [];
    }

    const violations: Violation[] = [];
    for (const imported of parsed.imports) {
      if (!imported.specifier.startsWith('.')) continue;

      const resolved = imports.resolve(file, imported.specifier);
      if (resolved === null) continue;

      const relative = nodePath.relative(projectRoot, resolved).split(nodePath.sep).join('/');
      const to = opts.modulePattern.exec(relative)?.[1];
      if (to === undefined || to === from) continue;

      violations.push({
        severity: opts.severity ?? 'error',
        source: 'core',
        message: opts.message(from, to),
        path: file.path,
        line: imported.line,
      });
    }
    return violations;
  };
}
