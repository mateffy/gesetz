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

  return async (file, { syntax }) => {
    if (!syntax.canProcess(file)) return [];

    try {
      const result = await syntax.process(file, { calls: true });
      return result.calls
        .filter((call) => nameSet.has(call.name))
        .map(
          (call): Violation => ({
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message?.(call.name) ?? `Forbidden call: ${call.name}()`,
            path: file.path,
            line: call.line,
          }),
        );
    } catch {
      return [];
    }
  };
}
