/**
 * Shared helpers for running external tools and managing temp files.
 *
 * These wrap raw Node.js primitives in Effect so that errors hit the
 * error channel and temp files are cleaned up even on failure.
 */
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';

// ─── execTool ─────────────────────────────────────────────────────────────────

/** Extract stdout from a child-process exec error in a type-safe way. */
function getExecStdout(e: unknown): string | undefined {
  if (e instanceof Error && 'stdout' in e) {
    const out = (e as { stdout: unknown }).stdout;
    if (typeof out === 'string') return out;
    if (Buffer.isBuffer(out)) return out.toString();
  }
  return undefined;
}

/**
 * Runs an external tool via `childProcess.execFileSync`, captures stdout,
 * and degrades gracefully on failure.
 *
 * Many tools (oxlint, prettier, vitest, …) exit non-zero when they find
 * violations but still write the report to stdout. This helper catches
 * that case and returns the stdout string instead of failing.
 */
export function execTool(
  bin: string,
  args: string[],
  cwd: string,
  toolName: string,
): Effect.Effect<string, never> {
  return Effect.try({
    try: () => {
      try {
        return childProcess
          .execFileSync(bin, args, {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          .toString();
      } catch (e: unknown) {
        const out = getExecStdout(e);
        if (out !== undefined) return out;
        throw e;
      }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          `[regeln] ${toolName} failed (${String(cause)}) — ${toolName}() produced no violations.`,
        );
        return '';
      }),
    ),
  );
}

// ─── Temp-file lifecycle ──────────────────────────────────────────────────────

/**
 * Creates a temp directory, runs the given effect with a file path inside it,
 * and guarantees cleanup of the temp directory (even on failure).
 */
export function runWithTempFile<T, R>(
  prefix: string,
  suffix: string,
  use: (tmpFile: string) => Effect.Effect<T, never, R>,
): Effect.Effect<T, never, R> {
  return Effect.sync(() => {
    const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
    return nodePath.join(tmpDir, suffix);
  }).pipe(
    Effect.flatMap((tmpFile) =>
      use(tmpFile).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            try {
              nodeFs.rmSync(nodePath.dirname(tmpFile), { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }),
        ),
      ),
    ),
  );
}

// ─── Stack-trace extraction (vitest / storybook) ──────────────────────────────

/**
 * Extracts the first `path:line:col` from a stack-trace string.
 * Matches patterns like:
 *   at /abs/path/file.test.ts:42:13
 *   at file:///abs/path/file.test.ts:42:13
 */
export function extractLocation(failureMessage: string): { path: string; line: number | undefined } {
  const match = /at\s+(?:file:\/\/)?([^\s]+):(\d+):\d+/.exec(failureMessage);
  if (match) {
    return { path: match[1] ?? '', line: Number(match[2] ?? 0) };
  }
  return { path: '', line: undefined };
}
