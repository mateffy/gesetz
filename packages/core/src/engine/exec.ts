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
/** A captured stream from an `execFileSync` error, or an empty string. */
function getExecStream(e: unknown, field: 'stdout' | 'stderr'): string {
  if (e instanceof Error && field in e) {
    const value = (e as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
  }
  return '';
}

/**
 * The exit status, or null when the process was killed by a signal.
 *
 * This is the difference between "the tool ran and found nothing" and "the tool did
 * not run". Without it both look like empty output, and an adapter that cannot tell
 * them apart reports a crashed tool as a clean project.
 */
function getExecStatus(e: unknown): number | null {
  if (e instanceof Error && 'status' in e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
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
/** What a tool run produced, and how it ended. */
export interface ToolRun {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `0` for a clean exit, the tool's own code otherwise, `null` when a signal killed
   * it. A non-zero status is not itself a failure — most of these tools exit non-zero
   * precisely *because* they found something, and their findings are on stdout.
   */
  readonly status: number | null;
}

/**
 * Runs a tool and reports its output *and* its exit status.
 *
 * Prefer this over {@link execTool} in any adapter where empty output is ambiguous:
 * a type checker that ran and found nothing, and one that died before it looked,
 * both produce no diagnostics. With the status, the first is a pass and the second
 * is an error.
 *
 * A process that could not be started at all still throws: that is not a finding
 * about the code, and reporting it as one would be worse than failing the rule.
 */
export function execToolResult(
  bin: string,
  args: string[],
  cwd: string,
  toolName: string,
): Effect.Effect<ToolRun, never> {
  return Effect.sync(() => {
    try {
      const stdout = childProcess
        .execFileSync(bin, args, {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        .toString();
      return { stdout, stderr: '', status: 0 };
    } catch (e: unknown) {
      if (isSpawnFailure(e)) {
        throw new Error(
          `[gesetz] ${toolName} could not run (${describeExecFailure(e, bin)}). ` +
            'Fix the tool so it can run, or remove its rule from gesetz.config.ts.',
        );
      }
      return {
        stdout: getExecStream(e, 'stdout'),
        stderr: getExecStream(e, 'stderr'),
        status: getExecStatus(e),
      };
    }
  });
}

/**
 * {@link execToolResult}'s stdout, for adapters whose tool reports everything it has
 * to say on stdout whatever its exit status.
 */
export function execTool(
  bin: string,
  args: string[],
  cwd: string,
  toolName: string,
): Effect.Effect<string, never> {
  return execToolResult(bin, args, cwd, toolName).pipe(Effect.map((run) => run.stdout));
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
              // Already gone, or unwritable — nothing useful to do, and the
              // caller's own error (if any) is the one that matters.
              return;
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
