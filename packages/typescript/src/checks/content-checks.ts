import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';

/**
 * Checks that no variable named `varName` defines a property named `propName`
 * in its object literal. Uses content-based detection (no AST) for performance.
 *
 * @example
 * // Storybook stories must not have explicit `title:` in the meta object
 * noObjectProperty('meta', 'title')
 */
export function noObjectProperty(
  varName: string,
  propName: string,
  opts: { message?: string } = {},
): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];

      // Find `const varName = {` and extract the meta object body
      const metaMatch = file.content.match(
        new RegExp(`\\bconst\\s+${varName}\\s*=\\s*\\{`),
      );
      if (!metaMatch || metaMatch.index === undefined) return [];

      const metaStart = metaMatch.index + metaMatch[0].length - 1;
      let braceCount = 1;
      let metaEnd = metaStart + 1;

      while (metaEnd < file.content.length && braceCount > 0) {
        if (file.content[metaEnd] === '{') braceCount++;
        else if (file.content[metaEnd] === '}') braceCount--;
        metaEnd++;
      }

      const metaBody = file.content.slice(metaStart, metaEnd);
      const lines = metaBody.split('\n');
      let insideNested = 0;
      let lineNumber = file.content.slice(0, metaStart).split('\n').length;

      for (const line of lines) {
        lineNumber++;
        const openBraces = (line.match(/\{/g) ?? []).length;
        const closeBraces = (line.match(/\}/g) ?? []).length;
        insideNested += openBraces - closeBraces;

        if (insideNested === 0) {
          const titleProp = new RegExp(`\\b${propName}\\s*:`).exec(line);
          if (titleProp) {
            violations.push({
              rule: '',
              severity: 'error',
              source: 'core',
              message:
                opts.message ??
                `'${varName}' object must not define property '${propName}'`,
              path: file.path,
              line: lineNumber,
            });
            break;
          }
        }
      }

      return violations;
    });
}

/**
 * Checks that files do not import from outside their allowed module boundary.
 * Each module is identified by a path segment; files within a module can only
 * import from the same module or from explicitly allowed paths.
 *
 * @example
 * // Files within src/domains/X can't deep-import into src/domains/Y
 * noCrossModuleImports({
 *   modulePattern: 'src/domains/([^/]+)/',
 *   allowedPattern: (module) => [`src/domains/${module}/`],
 * })
 */
export function noCrossModuleImports(opts: {
  modulePattern: RegExp;
  allowedPattern?: (module: string) => string[];
  message?: (from: string, to: string) => string;
}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const moduleMatch = opts.modulePattern.exec(file.path);
      if (!moduleMatch) return [];

      const currentModule = moduleMatch[1] ?? '';
      const allowed = opts.allowedPattern?.(currentModule) ?? [];

      // Extract all imports from the file
      const importMatches = [...file.content.matchAll(/from\s+['"]([^'"]+)['"]/g)];

      for (const match of importMatches) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('.')) continue; // Relative imports are fine

        // Check if importing from another module boundary
        const targetMatch = opts.modulePattern.exec(specifier);
        if (!targetMatch) continue;

        const targetModule = targetMatch[1] ?? '';
        if (targetModule === currentModule) continue;

        // Check if it's in the allowed list
        const isAllowed = allowed.some((a) => specifier.startsWith(a));
        if (isAllowed) continue;

        violations.push({
          rule: '',
          severity: 'error',
          source: 'core',
          message:
            opts.message?.(currentModule, targetModule) ??
            `Module '${currentModule}' must not import from module '${targetModule}'`,
          path: file.path,
        });
      }

      return violations;
    });
}
