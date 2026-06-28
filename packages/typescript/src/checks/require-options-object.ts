import { Effect } from 'effect';
import type { SgNode } from '@ast-grep/napi';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, getCallArgs, startLine } from './shared';

export interface RequireOptionsObjectOptions {
  /** Which argument must be an object literal. Default: 0 (first argument). */
  readonly argIndex?: number;
  /** Keys that must be present on the object literal argument. */
  readonly requiredKeys: readonly string[];
  readonly message?: (missing: readonly string[]) => string;
}

/**
 * Checks that every call to `fnName()` in the file passes an object literal
 * (at argument position `argIndex`, default 0) containing all `requiredKeys`.
 *
 * Renamed from `requireCallShape` — now takes a single options object with
 * `argIndex` and `requiredKeys`.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * // queryOptions() must define queryKey and queryFn (first argument)
 * requireOptionsObject('queryOptions', { requiredKeys: ['queryKey', 'queryFn'] })
 */
export function requireOptionsObject(
  fnName: string,
  opts: RequireOptionsObjectOptions,
): Check {
  const argIndex = opts.argIndex ?? 0;
  const requiredKeys = opts.requiredKeys;

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const calls = findByKind(root, 'call_expression');

      for (const call of calls) {
        const callName = call.child(0)?.text() ?? '';
        if (callName !== fnName) continue;

        const args = getCallArgs(call);
        const arg = args[argIndex];
        if (arg === undefined || arg.kind() !== 'object') {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `${fnName}() must be called with an object literal as argument ${argIndex}`,
            path: file.path,
            line: startLine(call),
          });
          continue;
        }

        // Collect property keys from `pair` children of the object literal.
        const presentKeys = new Set<string>();
        for (const child of arg.children()) {
          if (child.kind() === 'pair') {
            const key = child.child(0)?.text();
            if (key) presentKeys.add(key);
          }
        }
        const missing = requiredKeys.filter((k) => !presentKeys.has(k));

        if (missing.length > 0) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(missing) ??
              `${fnName}() is missing required properties: ${missing.join(', ')}`,
            path: file.path,
            line: startLine(call),
          });
        }
      }

      return violations;
    });
}
