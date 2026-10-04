import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { askDaemon } from '../../../src/engine/daemon/client';
import { socketPathFor, socketExists } from '../../../src/engine/daemon/lifecycle';
import { startDaemonServer } from '../../../src/engine/daemon/server';
import type { DaemonRun, DaemonRunner } from '../../../src/engine/daemon/server';
import type { CheckSpec } from '../../../src/engine/daemon/protocol';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-daemon-server-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spec = (files: readonly string[] | null, instanceKey = 'instance'): CheckSpec => ({
  instanceKey,
  scope: { files, since: null },
  rules: null,
  categories: null,
  baseline: 'apply',
});

const check = (id: string, files: readonly string[] | null, instanceKey = 'instance', waitMs = 5_000) =>
  ({ v: 1, id, kind: 'check', spec: spec(files, instanceKey), waitMs }) as const;

/** Records what it was asked to run, and which scope each answer was narrowed to. */
const recordingRunner = (): DaemonRunner<string> & { runs: string[]; narrowed: string[] } => {
  const runs: string[] = [];
  const narrowed: string[] = [];
  return {
    runs,
    narrowed,
    async run(request): Promise<DaemonRun<string>> {
      runs.push(request.scope.files === null ? '(whole project)' : request.scope.files.join(','));
      return {
        envelope: request.scope.files === null ? 'whole tree' : request.scope.files.join(','),
        servedFrom: 'recomputed',
        checksNotRun: [],
        computedAt: 42,
      };
    },
    narrow(envelope, scopes) {
      narrowed.push(scopes.member.files?.join(',') ?? '(whole project)');
      return `${envelope} -> ${scopes.member.files?.join(',') ?? '(whole project)'}`;
    },
  };
};

describe('the daemon answers scoped requests from one run', () => {
  it('runs once for two scopes of one instance, and narrows each answer', async () => {
    // The behaviour the whole design exists for.
    const runner = recordingRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const [a, b] = await Promise.all([
        askDaemon<string>(socketPathFor(dir), check('a', ['src/a.ts'])),
        askDaemon<string>(socketPathFor(dir), check('b', ['src/b.ts'])),
      ]);
      expect(runner.runs).toEqual(['src/a.ts,src/b.ts']);
      expect(runner.narrowed.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(a?.ok && a.envelope).toBe('src/a.ts,src/b.ts -> src/a.ts');
      expect(b?.ok && b.envelope).toBe('src/a.ts,src/b.ts -> src/b.ts');
    } finally {
      await server.close();
    }
  });

  it('answers both waiters of an identical scope without narrowing', async () => {
    const runner = recordingRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const [a, b] = await Promise.all([
        askDaemon<string>(socketPathFor(dir), check('a', ['src/**'])),
        askDaemon<string>(socketPathFor(dir), check('b', ['src/**'])),
      ]);
      expect(runner.runs).toEqual(['src/**']);
      expect(runner.narrowed).toEqual([]);
      expect(a?.ok && a.envelope).toBe('src/**');
      expect(b?.ok && b.envelope).toBe('src/**');
    } finally {
      await server.close();
    }
  });

  it('keeps two instances apart, because they are different questions', async () => {
    const runner = recordingRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      await Promise.all([
        askDaemon<string>(socketPathFor(dir), check('a', ['src/**'], 'one')),
        askDaemon<string>(socketPathFor(dir), check('b', ['src/**'], 'two')),
      ]);
      expect(runner.runs).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('answers a whole-project request without narrowing, whatever else is queued', async () => {
    const runner = recordingRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const answer = await askDaemon<string>(socketPathFor(dir), check('a', null));
      expect(runner.runs).toEqual(['(whole project)']);
      expect(answer?.ok && answer.envelope).toBe('whole tree');
    } finally {
      await server.close();
    }
  });
});

describe('failure', () => {
  it('refuses a malformed line and stays alive for the next request', async () => {
    const runner = recordingRunner();
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const net = await import('node:net');
      const bad = await new Promise<string>((resolve) => {
        const socket = net.connect({ path: socketPathFor(dir) }, () => socket.write('{not json}\n'));
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          resolve(chunk);
          socket.destroy();
        });
      });
      expect(bad).toContain('not JSON');
      // And the daemon is still answering: a client's mistake is not a crash.
      const after = await askDaemon(socketPathFor(dir), { v: 1, id: 's', kind: 'status' });
      expect(after?.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('tells every member when the run itself failed', async () => {
    const runner: DaemonRunner<string> = {
      async run() {
        throw new Error('engine exploded');
      },
      narrow: (envelope) => envelope,
    };
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const answer = await askDaemon<string>(socketPathFor(dir), check('a', ['src/a.ts']));
      expect(answer?.ok).toBe(false);
      if (answer === null || answer.ok) throw new Error('expected an error');
      expect(answer.error).toContain('engine exploded');
    } finally {
      await server.close();
    }
  });

  it('answers a client that will not wait, so it can run the check itself', async () => {
    const runner: DaemonRunner<string> = {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { envelope: 'late', servedFrom: 'recomputed', checksNotRun: [], computedAt: 1 };
      },
      narrow: (envelope) => envelope,
    };
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner });
    try {
      const answer = await askDaemon<string>(socketPathFor(dir), check('a', ['src/a.ts'], 'instance', 50));
      expect(answer?.ok).toBe(false);
      if (answer === null || answer.ok) throw new Error('expected an error');
      expect(answer.error).toContain('did not answer within');
    } finally {
      await server.close();
    }
  }, 20_000);

  it('removes its socket on close, so the next start is clean', async () => {
    const server = await startDaemonServer({ socketPath: socketPathFor(dir), runner: recordingRunner() });
    expect(socketExists(socketPathFor(dir))).toBe(true);
    await server.close();
    expect(socketExists(socketPathFor(dir))).toBe(false);
  });

  it('refuses to start a second daemon on the same socket', async () => {
    // Two daemons on one socket would be two writers of one cache, and one writer is
    // the design.
    const first = await startDaemonServer({ socketPath: socketPathFor(dir), runner: recordingRunner() });
    try {
      await expect(
        startDaemonServer({ socketPath: socketPathFor(dir), runner: recordingRunner() }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});
