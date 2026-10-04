/**
 * Where a daemon lives, and whether one is there.
 *
 * No spawning: starting a process is the CLI's job, because only the CLI knows how it
 * was invoked. This module is the rendezvous — the socket's path, and the questions
 * "is someone answering", "may I remove this file".
 */
import * as nodeCrypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

/** Where per-project daemon state lives, beside the coordination files. */
export function daemonDirFor(root: string): string {
  return nodePath.join(root, '.gesetz');
}

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, including the terminator, and
 * exceeding it fails at `bind` with a message that says nothing about length. A long
 * project path — a deeply nested worktree, a temp directory — would hit that, so a
 * path that is too long moves to the OS temp directory under a hash of the root,
 * which every client can compute identically.
 */
export const MAX_SOCKET_PATH = 100;

/** Hex characters of the root hash used to name a fallback socket. */
const ROOT_HASH_LENGTH = 16;

export function socketPathFor(root: string): string {
  const preferred = nodePath.join(daemonDirFor(root), 'daemon.sock');
  if (preferred.length <= MAX_SOCKET_PATH) return preferred;
  const digest = nodeCrypto
    .createHash('sha256')
    .update(root)
    .digest('hex')
    .slice(0, ROOT_HASH_LENGTH);
  return nodePath.join(nodeOs.tmpdir(), `gesetz-${digest}.sock`);
}

/**
 * Creates the directory a socket will live in.
 *
 * `bind` reports a **missing parent directory** as `EACCES: permission denied`,
 * which sends you looking at file modes for a directory that does not exist. A
 * project that has never run a daemon has no `.gesetz` yet, so this is the common
 * case, not an edge one.
 */
export function ensureSocketDir(socketPath: string): void {
  nodeFs.mkdirSync(nodePath.dirname(socketPath), { recursive: true });
}

/** Removes a socket file. Safe when it is already gone. */
export function removeSocketFile(socketPath: string): void {
  try {
    nodeFs.unlinkSync(socketPath);
  } catch {
    // Already gone, or never created. Either way there is nothing to do, and a failure
    // to clean up must not stop the caller from starting. `return` is the whole
    // handling: this function exists to be called and forgotten.
    return;
  }
}

/** Whether a socket file exists at all. Says nothing about anyone listening. */
export function socketExists(socketPath: string): boolean {
  try {
    return nodeFs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}
