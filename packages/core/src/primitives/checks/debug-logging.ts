/**
 * noDebugLogging — regex-based, extension-aware debug-logging detector.
 *
 * This is intentionally NOT built on SyntaxTree. It maps file extensions to
 * known debug function names and scans line by line. It has no parser
 * dependency and works on any file type with a known extension.
 *
 * For precise call detection of user-specified names, use `noDirectCalls()`
 * (which requires a SyntaxBackend). These serve different purposes.
 */
import { Effect } from 'effect';
import type { Check, Violation } from '../../engine/rule';

const DEBUG_CALLS_BY_EXT: Record<string, readonly string[]> = {
  '.ts': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.tsx': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.js': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.jsx': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.mjs': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.cjs': ['console.log', 'console.debug', 'console.info', 'console.warn', 'console.error', 'console.dir', 'console.table', 'console.trace'],
  '.py': ['print', 'pprint', 'breakpoint'],
  '.php': ['var_dump', 'print_r', 'dd', 'dump', 'debug'],
  '.go': ['fmt.Println', 'fmt.Printf', 'log.Println', 'log.Printf'],
  '.rs': ['println!', 'eprintln!', 'dbg!'],
  '.rb': ['puts', 'p', 'pp'],
};

export interface NoDebugLoggingOptions {
  /** Additional function names to ban (applied to all extensions). */
  readonly extraNames?: readonly string[];
  readonly severity?: Violation['severity'];
  readonly message?: string;
}

/** Escapes a name for use in a regex, handling `.` and `!`. */
function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function noDebugLogging(opts: NoDebugLoggingOptions = {}): Check {
  const extraSet = new Set(opts.extraNames ?? []);

  return (file) =>
    Effect.sync(() => {
      const knownForExt = DEBUG_CALLS_BY_EXT[file.ext];
      if (knownForExt === undefined) return [];

      const knownSet = new Set(knownForExt);
      const names = [...knownSet, ...extraSet];
      const lines = file.content.split('\n');
      const violations: Violation[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const name of names) {
          // Match the name followed by ( or ! — avoid matching partial names
          // e.g. "console.log(" matches but "notconsole.log(" does not
          const pattern = new RegExp(`(?<![\\w.])${escapeForRegex(name)}\\s*[(!]`);
          if (pattern.test(line)) {
            violations.push({
              rule: '',
              severity: opts.severity ?? 'warn',
              source: 'core',
              message: opts.message ?? `Remove debug logging: ${name}`,
              path: file.path,
              line: i + 1,
            });
            break; // one violation per line max
          }
        }
      }

      return violations;
    });
}
