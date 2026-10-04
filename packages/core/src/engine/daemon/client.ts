/**
 * The client side: ask a daemon one question and read one answer.
 *
 * Every failure returns null or an error rather than throwing, because every caller
 * has the same response to a broken daemon — run the check directly instead. A daemon
 * that cannot be reached must never look like a gate that ran.
 */
import * as nodeNet from 'node:net';
import { MAX_RESPONSE_BYTES, decodeResponse, encodeLine } from './protocol';
import type { DaemonRequest, DaemonResponse } from './protocol';

export interface AskOptions {
  /** How long to wait for a connection. */
  readonly connectTimeoutMs?: number;
  /** How long to wait for the answer. */
  readonly responseTimeoutMs?: number;
}

const DEFAULTS = { connectTimeoutMs: 1_000, responseTimeoutMs: 120_000 } as const;

/**
 * Control requests are quick or they are not happening. A health probe and a shutdown
 * both answer from memory, so seconds — not the minutes a check may legitimately take.
 */
const CONTROL_CONNECT_TIMEOUT_MS = 500;
const CONTROL_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * Sends one request and returns its answer, or null when the daemon could not be
 * reached at all.
 *
 * A response the protocol refuses — a truncated line, a schema mismatch, a silent
 * socket — is also null: from the caller's side, an unusable answer and no answer
 * call for the same thing.
 */
export async function askDaemon<TEnvelope>(
  socketPath: string,
  request: DaemonRequest,
  options: AskOptions = {},
): Promise<DaemonResponse<TEnvelope> | null> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULTS.responseTimeoutMs;

  return new Promise((resolve) => {
    let settled = false;
    // Declared before `finish` uses them: a timeout that fired first would otherwise
    // hit the temporal dead zone and crash instead of returning null.
    let connectTimer: NodeJS.Timeout | undefined;
    let responseTimer: NodeJS.Timeout | undefined;
    const finish = (value: DaemonResponse<TEnvelope> | null): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (responseTimer !== undefined) clearTimeout(responseTimer);
      socket.destroy();
      resolve(value);
    };

    const socket = nodeNet.connect({ path: socketPath });
    connectTimer = setTimeout(() => finish(null), connectTimeoutMs);
    responseTimer = setTimeout(() => finish(null), responseTimeoutMs);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      socket.write(encodeLine(request));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_BYTES) return finish(null);
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const decoded = decodeResponse<TEnvelope>(buffer.slice(0, newline));
      finish('error' in decoded && !('ok' in decoded) ? null : decoded);
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/** A control request with a short patience: both are quick or the daemon is not there. */
async function askControl(
  socketPath: string,
  kind: 'status' | 'shutdown',
): Promise<Record<string, unknown> | null> {
  const answer = await askDaemon<Record<string, unknown>>(
    socketPath,
    { v: 1, id: kind, kind },
    { connectTimeoutMs: CONTROL_CONNECT_TIMEOUT_MS, responseTimeoutMs: CONTROL_RESPONSE_TIMEOUT_MS },
  );
  if (answer === null || !answer.ok || answer.kind !== 'control') return null;
  return (answer.envelope ?? {}) as Record<string, unknown>;
}

/** What a running daemon reports about itself, or null when none answers. */
export function daemonStatus(socketPath: string): Promise<Record<string, unknown> | null> {
  return askControl(socketPath, 'status');
}

/**
 * Asks a daemon to stop, and says whether it acknowledged.
 *
 * A request rather than a signal: the daemon closes its own socket, finishes what it
 * is doing and exits, and no caller has to guess a pid that a signal could deliver to
 * the wrong process. A daemon that does not acknowledge is a signal's problem, and
 * the caller can see that it did not.
 */
export async function stopDaemon(socketPath: string): Promise<boolean> {
  return (await askControl(socketPath, 'shutdown')) !== null;
}
