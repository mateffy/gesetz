import { Effect } from 'effect';
import { SyntaxTree } from '../../services/syntax-tree';
import type { Check, Violation } from '../../engine/rule';

export interface NoDirectCallsOptions {
  readonly message?: (name: string) => string;
  readonly severity?: Violation['severity'];
}

/**
 * Bans specific function calls by name. Requires a SyntaxBackend registered
 * for the file's extension. If no backend is registered for this file type,
 * returns no violations (silent skip).
 *
 * For a simpler regex-based alternative, use `noDebugLogging()` for common
 * debug functions.
 *
 * @example
 * // No direct calls to eval
 * noDirectCalls(['eval'], { message: (n) => `Forbidden call: ${n}()` })
 */
export function noDirectCalls(names: readonly string[], opts: NoDirectCallsOptions = {}): Check {
  const nameSet = new Set(names);

  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { calls: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      return result.calls
        .filter((call) => nameSet.has(call.name))
        .map(
          (call): Violation => ({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message?.(call.name) ?? `Forbidden call: ${call.name}()`,
            path: file.path,
            line: call.line,
          }),
        );
    });
}
