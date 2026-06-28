import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

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
