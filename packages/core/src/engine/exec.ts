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

// ─── Adapter path resolution ────────────────────────────────────────────────

/**
 * Resolves an adapter's working directory against the project root.
 *
 * Adapter options are written in `gesetz.config.ts`, which is evaluated before
 * the project root is known. Resolving a relative `cwd` at construction time
 * would therefore anchor it to `process.cwd()` — the shell's directory — rather
 * than the tree being checked. Adapters call this at run time instead.
 *
 * An absolute `cwd` is used as-is.
 */
export function resolveToolCwd(configured: string | undefined, projectRoot: string): string {
  if (configured === undefined) return projectRoot;
  return nodePath.isAbsolute(configured) ? configured : nodePath.resolve(projectRoot, configured);
}

/**
 * Resolves an adapter's binary.
 *
 * An explicit `bin` wins. Otherwise the first candidate that exists **relative
 * to the tool's working directory** is used, falling back to `fallback`, which
 * lets the operating system resolve the tool from `PATH`.
 *
 * `cwd` is the directory the tool will run in (see `resolveToolCwd`), so a
 * relative candidate like `node_modules/.bin/vitest` means "the vitest installed
 * alongside this tool's own working directory" — which is what an adapter that
 * sets `cwd: 'packages/web'` expects.
 */
export function resolveToolBin(
  configured: string | undefined,
  cwd: string,
  localCandidates: readonly string[],
  fallback: string,
): string {
  if (configured !== undefined) return configured;
  for (const candidate of localCandidates) {
    if (nodeFs.existsSync(nodePath.resolve(cwd, candidate))) return candidate;
  }
  return fallback;
}

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

/** Error codes that mean the process could not be started at all. */
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'ENOTDIR', 'EISDIR']);

/**
 * True when the child process never ran to completion: it could not be spawned,
 * was killed by a signal, or produced no exit status.
 *
 * A plain non-zero exit is NOT a failure — most linters and test runners exit
 * non-zero when they find problems, and file-reporting tools (phpunit, storybook)
 * exit non-zero while writing their report to a file rather than stdout.
 */
function isSpawnFailure(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return true;
  const { code, signal, status } = cause as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
  };
  if (typeof code === 'string' && SPAWN_FAILURE_CODES.has(code)) return true;
  if (typeof signal === 'string' && signal !== '') return true;
  return status === null || status === undefined;
}

/** Human-readable reason a tool could not be started. */
function describeExecFailure(cause: unknown, bin: string): string {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return `command not found: ${bin}`;
  if (code === 'EACCES') return `not executable: ${bin}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Runs an external tool via `childProcess.execFileSync` and returns its stdout.
 *
 * Many tools (oxlint, prettier, vitest, …) exit non-zero when they find
 * violations but still write the report to stdout, and some (phpunit,
 * storybook) exit non-zero and write to a file. Both are normal: a non-zero exit
 * returns whatever stdout was captured.
 *
 * A tool that could not run at all (missing binary, killed process, no exit
 * status) is a real failure and throws, so the rule's adapter reports it as a
 * critical violation instead of silently contributing nothing. See
 * `executeProjectRule` in `runner.ts`.
 */
export function execTool(
  bin: string,
  args: string[],
  cwd: string,
  toolName: string,
): Effect.Effect<string, never> {
  return Effect.sync(() => {
    try {
      return childProcess
        .execFileSync(bin, args, {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        .toString();
    } catch (e: unknown) {
      if (isSpawnFailure(e)) {
        throw new Error(
          `[gesetz] ${toolName} could not run (${describeExecFailure(e, bin)}). ` +
            'Fix the tool so it can run, or remove its rule from gesetz.config.ts.',
        );
      }
      return getExecStdout(e) ?? '';
    }
  });
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
