/**
 * The daemon: one socket, one queue, one runner.
 *
 * The server schedules and answers. It does not know what a check is, what a rule is,
 * or what an envelope contains — those arrive as an injected `DaemonRunner`. That is
 * the seam that keeps daemon mode optional: the engine has no idea this exists, and
 * these rules can be tested against a fake that returns instantly.
 */
import * as nodeFs from 'node:fs';
import * as nodeNet from 'node:net';
import {
  MAX_REQUEST_BYTES,
  decodeRequest,
  encodeLine,
  isDecodeError,
} from './protocol';
import type { CheckSpec, DaemonResponse, Scope } from './protocol';
import { ensureSocketDir } from './lifecycle';
import { createLimiter, orderBatches, planBatches } from './queue';
import type { Batch, Schedulable } from './queue';

/** What one run produced, as the server needs to see it. */
export interface DaemonRun<TEnvelope> {
  readonly envelope: TEnvelope;
  readonly servedFrom: 'recomputed' | 'cache' | 'mixed';
  readonly checksNotRun: readonly string[];
  readonly computedAt: number;
}

/** The engine, as the server sees it. */
export interface DaemonRunner<TEnvelope> {
  /** Runs one spec, covering at least the paths it names. */
  run(spec: CheckSpec): Promise<DaemonRun<TEnvelope>>;
  /**
   * Slices a run's result down to one member's scope. Called only when the run
   * covered more than the member asked for — the alternative is answering with
   * findings about files the member never asked about.
   */
  narrow(envelope: TEnvelope, scopes: { readonly batch: Scope; readonly member: Scope }): TEnvelope;
}

/**
 * How long requests are collected before a run starts, when the caller does not say.
 *
 * A window of milliseconds, not of seconds: long enough for requests that arrive
 * together to share one run, short enough that a solo request never notices.
 */
export const DEFAULT_COALESCE_MS = 15;

export interface DaemonServerOptions<TEnvelope> {
  readonly socketPath: string;
  readonly runner: DaemonRunner<TEnvelope>;
  /** Runs allowed at once. Default 1: one writer of the cache, by design. */
  readonly jobs?: number;
  /**
   * How long to collect requests before starting a run, in milliseconds. Defaults to
   * {@link DEFAULT_COALESCE_MS}.
   *
   * Without it, requests that arrive together are answered by separate runs: the
   * first one's run starts before the second is even parsed. The window is what turns
   * "two agents asked at the same time" into one run. It is a window of milliseconds,
   * not of seconds — a solo request pays this and nothing more, which is why it can
   * be on by default. Set to 0 to start a run as soon as a request arrives.
   */
  readonly coalesceMs?: number;
  /** What makes two requests share a run. Defaults to instance plus `--since`. */
  readonly batchKeyFor?: (spec: CheckSpec) => string;
  readonly now?: () => number;
}

export interface DaemonStats {
  readonly startedAt: number;
  readonly queued: number;
  readonly running: number;
  readonly answered: number;
  readonly lastComputedAt: number | null;
}

export interface DaemonServer {
  readonly socketPath: string;
  readonly stats: DaemonStats;
  /** Stops accepting, answers nothing further, and removes the socket file. */
  close(): Promise<void>;
}

/**
 * A request waiting for an answer.
 *
 * Implements `Schedulable` directly — instance, scope and arrival at the top level —
 * so the queue reasons about the request itself rather than a projection of it, and
 * the spec travels alongside for the runner.
 */
interface Pending<TEnvelope> extends Schedulable {
  readonly spec: CheckSpec;
  readonly settle: (response: DaemonResponse<TEnvelope>) => void;
}

const defaultBatchKey = (spec: CheckSpec): string => `${spec.instanceKey}|${spec.scope.since ?? ''}`;

/**
 * Starts the server on `socketPath`.
 *
 * Refuses to start when another daemon already answers there: two daemons on one
 * socket would be two writers of one cache, and the whole point of the design is that
 * there is one.
 */
export async function startDaemonServer<TEnvelope>(
  options: DaemonServerOptions<TEnvelope>,
): Promise<DaemonServer> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const limiter = createLimiter(options.jobs ?? 1);
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  let pumpScheduled = false;
  const batchKeyFor = options.batchKeyFor ?? defaultBatchKey;
  const queue: Pending<TEnvelope>[] = [];
  let answered = 0;
  let lastComputedAt: number | null = null;
  let closed = false;
  let pumping = false;

  const fail = (requestId: string, error: string): DaemonResponse<TEnvelope> => ({
    v: 1,
    id: requestId,
    ok: false,
    error,
  });

  const ship = (pending: Pending<TEnvelope>, run: DaemonRun<TEnvelope>, batch: Batch<Pending<TEnvelope>>): void => {
    const sameScope =
      (batch.files === null) === (pending.spec.scope.files === null) &&
      (batch.files === null ||
        (pending.spec.scope.files !== null &&
          batch.files.length === pending.spec.scope.files.length &&
          batch.files.every((file) => pending.spec.scope.files?.includes(file) === true)));
    const envelope =
      sameScope
        ? run.envelope
        : options.runner.narrow(run.envelope, {
            batch: { files: batch.files, since: batch.since },
            member: pending.spec.scope,
          });
    answered += 1;
    pending.settle({
      v: 1,
      id: '',
      ok: true,
      envelope,
      servedFrom: run.servedFrom,
      checksNotRun: run.checksNotRun,
      computedAt: run.computedAt,
    });
  };

  /** Takes one batch, runs it, answers its members. */
  const runBatch = async (batch: Batch<Pending<TEnvelope>>): Promise<void> => {
    const oldest = batch.members[0];
    if (oldest === undefined) return;
    const spec: CheckSpec = { ...oldest.spec, scope: { files: batch.files, since: batch.since } };
    try {
      const run = await options.runner.run(spec);
      lastComputedAt = run.computedAt;
      for (const member of batch.members) ship(member, run, batch);
    } catch (cause) {
      // A run that threw answers nobody, and says why. Silently dropping the
      // requests would leave clients waiting on a daemon that had already failed.
      for (const member of batch.members) {
        member.settle(fail('', `daemon run failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    }
  };

  /** Starts as many batches as the limiter allows. */
  const pump = async (): Promise<void> => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed && queue.length > 0 && limiter.tryAcquire()) {
        const batches = orderBatches(planBatches([...queue], (item) => batchKeyFor(item.spec)));
        const batch = batches[0];
        if (batch === undefined) {
          limiter.release();
          break;
        }
        const memberIds = new Set(batch.members.map((member) => member));
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const item = queue[index];
          if (item !== undefined && memberIds.has(item)) queue.splice(index, 1);
        }
        void runBatch(batch).finally(() => {
          limiter.release();
          void pump();
        });
      }
    } finally {
      pumping = false;
    }
  };

  const onLine = (line: string, connection: nodeNet.Socket): void => {
    if (line === '') return;
    const decoded = decodeRequest(line);
    if (isDecodeError(decoded)) {
      connection.write(encodeLine(fail('', decoded.error)));
      return;
    }
    if (decoded.kind === 'status') {
      connection.write(
        encodeLine({
          v: 1,
          id: decoded.id,
          ok: true,
          envelope: { pid: process.pid, ...server.stats },
          servedFrom: 'cache',
          checksNotRun: [],
          computedAt: lastComputedAt ?? startedAt,
        }),
      );
      return;
    }

    const response = new Promise<DaemonResponse<TEnvelope>>((resolve) => {
      const pending: Pending<TEnvelope> = {
        spec: decoded.spec,
        instanceKey: decoded.spec.instanceKey,
        scope: decoded.spec.scope,
        arrivedAt: now(),
        settle: (answer) => resolve({ ...answer, id: decoded.id }),
      };
      queue.push(pending);
      // A window of milliseconds, not seconds: long enough for requests that arrive
      // together to share one run, short enough that a solo request never notices.
      if (coalesceMs <= 0) {
        void pump();
      } else if (!pumpScheduled) {
        pumpScheduled = true;
        setTimeout(() => {
          pumpScheduled = false;
          void pump();
        }, coalesceMs).unref?.();
      }
      if (decoded.waitMs > 0) {
        setTimeout(() => {
          const index = queue.indexOf(pending);
          if (index !== -1) queue.splice(index, 1);
          // The client is going to run the check itself. Answering with an error
          // rather than nothing is what lets it do that deliberately.
          resolve(fail(decoded.id, `daemon did not answer within ${decoded.waitMs}ms`));
        }, decoded.waitMs).unref?.();
      }
    });
    void response.then((answer) => {
      if (!connection.destroyed) connection.write(encodeLine(answer));
    });
  };

  const server: DaemonServer = {
    socketPath: options.socketPath,
    get stats(): DaemonStats {
      return { startedAt, queued: queue.length, running: limiter.running, answered, lastComputedAt };
    },
    async close(): Promise<void> {
      closed = true;
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      try {
        nodeFs.unlinkSync(options.socketPath);
      } catch {
        // Already gone. Shutting down must not fail because cleanup had nothing to do.
        return;
      }
    },
  };

  const nodeServer = nodeNet.createServer((connection) => {
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        connection.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line, connection);
      }
    });
    connection.on('error', () => connection.destroy());
  });

  // Before listening: a project that has never run a daemon has no `.gesetz` yet, and
  // `bind` calls that missing directory EACCES.
  ensureSocketDir(options.socketPath);

  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(options.socketPath, () => {
      nodeServer.removeListener('error', reject);
      resolve();
    });
  });

  return server;
}
