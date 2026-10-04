/**
 * `gesetz daemon` — start, stop, inspect, or run one in the foreground.
 *
 * Thin on purpose. The scheduling lives in `@gesetz/core`'s daemon modules, the
 * engine adapter in `daemon-runner.ts`, and this file only does the three things
 * neither can: find the project, spawn or signal a process, and say what happened in
 * words a person can read.
 */
import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import { Command, Options } from '@effect/cli';
import { Console, Effect, Option } from 'effect';
import {
  daemonStatus,
  removeSocketFile,
  socketExists,
  socketPathFor,
  startDaemonServer,
  stopDaemon,
} from '@gesetz/core';
import type { RunResult } from '@gesetz/core';
import { loadBaseline } from './baseline';
import { createDaemonRunner } from './daemon-runner';
import { loadConfig } from './load-config';
import { resolveStorage } from './storage';

/** How long `start` waits for a spawned daemon to answer before giving up. */
const START_TIMEOUT_MS = 15_000;
/** How long `stop` waits for a daemon to acknowledge and disappear. */
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

const projectRootOption = Options.text('project-root').pipe(
  Options.withDescription('Project to run in. Default: the current directory'),
  Options.optional,
);

const rootOf = (value: Option.Option<string>): string =>
  nodePath.resolve(Option.getOrElse(value, () => process.cwd()));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describeStatus = (status: Record<string, unknown>): string =>
  `running — pid ${String(status['pid'])}, up since ${new Date(Number(status['startedAt'])).toISOString()}, ` +
  `queued ${String(status['queued'])}, running ${String(status['running'])}, ` +
  `answered ${String(status['answered'])}` +
  (status['lastComputedAt'] === null
    ? ''
    : `, last recompute ${new Date(Number(status['lastComputedAt'])).toISOString()}`);

const statusCommand = Command.make(
  'status',
  { projectRoot: projectRootOption },
  (opts) =>
    Effect.gen(function* () {
      const root = rootOf(opts.projectRoot);
      const status = yield* Effect.promise(() => daemonStatus(socketPathFor(root)));
      if (status === null) {
        yield* Console.error(`no daemon is running for ${root} (socket: ${socketPathFor(root)})`);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      yield* Console.log(describeStatus(status));
    }),
).pipe(Command.withDescription('Report whether a daemon is running, and what it has done'));

const startCommand = Command.make(
  'start',
  { projectRoot: projectRootOption },
  (opts) =>
    Effect.gen(function* () {
      const root = rootOf(opts.projectRoot);
      const socket = socketPathFor(root);

      const already = yield* Effect.promise(() => daemonStatus(socket));
      if (already !== null) {
        yield* Console.log(`already running — ${describeStatus(already)}`);
        return;
      }
      // Nothing answered, so any file there is a leftover from a daemon that died.
      // Removing it is what lets the next start succeed.
      if (socketExists(socket)) removeSocketFile(socket);

      const entry = process.argv[1];
      if (entry === undefined) {
        yield* Console.error('cannot find my own entry point, so I cannot start a daemon');
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }
      childProcess
        .spawn(process.execPath, [entry, 'daemon', 'run', '--project-root', root], {
          detached: true,
          stdio: 'ignore',
        })
        .unref();

      const deadline = Date.now() + START_TIMEOUT_MS;
      for (;;) {
        const status = yield* Effect.promise(() => daemonStatus(socket));
        if (status !== null) {
          yield* Console.log(`started — ${describeStatus(status)}`);
          yield* Console.log(`socket: ${socket}`);
          return;
        }
        if (Date.now() > deadline) {
          yield* Console.error(
            `a daemon did not start within ${START_TIMEOUT_MS}ms. Run \`gesetz daemon run\` in the ` +
              'foreground to see why.',
          );
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        yield* Effect.promise(() => sleep(POLL_MS));
      }
    }),
).pipe(Command.withDescription('Start a daemon for this project, detached, and wait until it answers'));

const stopCommand = Command.make(
  'stop',
  { projectRoot: projectRootOption },
  (opts) =>
    Effect.gen(function* () {
      const root = rootOf(opts.projectRoot);
      const socket = socketPathFor(root);

      const before = yield* Effect.promise(() => daemonStatus(socket));
      if (before === null) {
        yield* Console.log('not running');
        return;
      }

      const acknowledged = yield* Effect.promise(() => stopDaemon(socket));
      if (!acknowledged) {
        // It is listening but not answering a shutdown request, which is a hung
        // daemon. A signal is the only thing left, and the pid came from the daemon
        // itself rather than from a file that could be stale.
        const pid = Number(before['pid']);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGTERM');
            yield* Console.error(`daemon did not acknowledge, so it was signalled (pid ${pid})`);
          } catch (cause) {
            yield* Console.error(`daemon did not acknowledge and could not be signalled: ${String(cause)}`);
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
            return;
          }
        }
      }

      const deadline = Date.now() + STOP_TIMEOUT_MS;
      for (;;) {
        const status = yield* Effect.promise(() => daemonStatus(socket));
        if (status === null) {
          if (socketExists(socket)) removeSocketFile(socket);
          yield* Console.log('stopped');
          return;
        }
        if (Date.now() > deadline) {
          yield* Console.error(`the daemon is still answering after ${STOP_TIMEOUT_MS}ms`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
          return;
        }
        yield* Effect.promise(() => sleep(POLL_MS));
      }
    }),
).pipe(Command.withDescription('Ask a running daemon to stop, and wait until it has'));

const runCommand = Command.make(
  'run',
  {
    projectRoot: projectRootOption,
    jobs: Options.integer('jobs').pipe(
      Options.withDescription('How many runs may proceed at once. Default 1'),
      Options.optional,
    ),
  },
  (opts) =>
    Effect.gen(function* () {
      const root = rootOf(opts.projectRoot);
      const socket = socketPathFor(root);

      const already = yield* Effect.promise(() => daemonStatus(socket));
      if (already !== null) {
        yield* Console.error(
          `a daemon is already running for ${root} (${describeStatus(already)}). Two would be two ` +
            'writers of one cache, which is the one thing the design forbids.',
        );
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        return;
      }

      const config = yield* loadConfig(root, {
        changedSince: undefined,
        configPath: undefined,
        projectRootOverride: Option.isSome(opts.projectRoot),
      });
      const storage = yield* Effect.promise(() => resolveStorage(root, false, config.storage));

      const runner = createDaemonRunner({
        config,
        // Read per run, so a maintainer rewriting the baseline is not served a stale
        // one until the daemon happens to restart.
        loadBaseline: () => Effect.runPromise(loadBaseline(root)),
        storage,
      });

      const server = yield* Effect.promise(() =>
        startDaemonServer<RunResult>({
          socketPath: socket,
          runner,
          ...(Option.getOrUndefined(opts.jobs) === undefined
            ? {}
            : { jobs: Option.getOrUndefined(opts.jobs) as number }),
        }),
      );

      const stop = (): void => {
        void server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      yield* Console.log(`listening on ${socket} — run \`gesetz daemon stop\` to stop it`);
      yield* Effect.never;
    }),
).pipe(Command.withDescription('Run a daemon in the foreground (for debugging)'));

export const daemonCommand = Command.make('daemon', {}, () =>
  Console.log('Run `gesetz daemon --help` to see the subcommands.'),
).pipe(
  Command.withDescription('Run a per-project daemon that answers checks from one kept-warm state'),
  Command.withSubcommands([startCommand, stopCommand, statusCommand, runCommand]),
);
