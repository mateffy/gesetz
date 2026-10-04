import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { askDaemon, daemonStatus, stopDaemon } from '../../../src/engine/daemon/client';
import { ensureSocketDir, socketPathFor } from '../../../src/engine/daemon/lifecycle';

import { startDaemonServer } from '../../../src/engine/daemon/server';
import type { DaemonRun, DaemonRunner } from '../../../src/engine/daemon/server';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-daemon-client-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ensureSocketDirTarget = (): string => {
  // `bind` needs the directory to exist; the same setup the server does for itself.
  ensureSocketDir(socketPathFor(dir));
  return socketPathFor(dir);
};

const fakeRunner = (): DaemonRunner<{ total: number }> & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async run(spec): Promise<DaemonRun<{ total: number }>> {
      calls.push(spec.scope.files === null ? '(whole project)' : spec.scope.files.join(','));
      return { envelope: { total: spec.scope.files?.length ?? 0 }, servedFrom: 'recomputed', checksNotRun: [], computedAt: 1 };
    },
    narrow(envelope, scopes) {
      return { total: scopes.member.files?.length ?? envelope.total };
    },
  };
};

describe('askDaemon', () => {
  it('round-trips a check request and its answer', async () => {
    const runner = fakeRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const answer = await askDaemon<{ total: number }>(socketPathFor(dir), {
        v: 1,
        id: 'a',
        kind: 'check',
        spec: { instanceKey: 'i', scope: { files: ['src/a.ts'], since: null }, rules: null, categories: null, baseline: 'apply' },
        waitMs: 5_000,
      });
      expect(answer?.ok).toBe(true);
      if (answer === null || !answer.ok) throw new Error('expected an answer');
      expect(answer.envelope).toEqual({ total: 1 });
      expect(answer.checksNotRun).toEqual([]);
      expect(runner.calls).toEqual(['src/a.ts']);
    } finally {
      await server.close();
    }
  });

  it('returns null when nothing is listening, so the caller can run the check itself', async () => {
    const answer = await askDaemon(socketPathFor(dir), { v: 1, id: 'a', kind: 'status' }, { connectTimeoutMs: 300 });
    expect(answer).toBeNull();
  });

  it('returns null rather than hanging when the daemon never answers', async () => {
    // A socket that accepts and then says nothing: a hung daemon must not hold a
    // client forever, because the client's fallback is strictly better.
    const net = await import('node:net');
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(ensureSocketDirTarget(), resolve));
    silent.unref();
    const answer = await askDaemon(socketPathFor(dir), { v: 1, id: 'a', kind: 'status' }, { responseTimeoutMs: 300 });
    expect(answer).toBeNull();
    silent.close();
  });

  it('reads the status the daemon reports', async () => {
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner: fakeRunner() });
    try {
      const answer = await askDaemon<never>(socketPathFor(dir), { v: 1, id: 's', kind: 'status' });
      if (answer === null || !answer.ok || answer.kind !== 'control') {
        throw new Error('expected a control answer');
      }
      // A control answer's payload is not a check result, which is why it is typed
      // separately: the discriminator has to be checked before reading it.
      const status = answer.envelope as { pid: number; answered: number };
      expect(status.pid).toBe(process.pid);
      expect(status.answered).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('control helpers', () => {
  it('reports a running daemon and stops it', async () => {
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner: fakeRunner() });
    const status = await daemonStatus(socketPathFor(dir));
    expect(status?.pid).toBe(process.pid);
    expect(status?.answered).toBe(0);

    expect(await stopDaemon(socketPathFor(dir))).toBe(true);
    // The daemon closes itself, and says so first: the caller learns the request
    // arrived rather than guessing from a dead socket.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await daemonStatus(socketPathFor(dir))).toBeNull();
    await server.close().catch(() => undefined);
  }, 20_000);

  it('reports nothing for a daemon that is not there', async () => {
    expect(await daemonStatus(socketPathFor(dir))).toBeNull();
    expect(await stopDaemon(socketPathFor(dir))).toBe(false);
  });

});
