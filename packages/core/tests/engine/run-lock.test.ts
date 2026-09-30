import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  acquireSlot,
  coordinateRun,
  findReusableRecord,
  readSlot,
  registerWaiter,
} from '../../src/engine/run-lock';
import { treeStateFor } from '../../src/engine/file-set';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('coordinateRun', () => {
  const FULL = 'scope-full';

  const options = (overrides: Record<string, unknown> = {}) => ({
    root,
    requestKey: 'k1',
    scopeKey: FULL,
    fullScopeKey: FULL,
    jobs: 1,
    waitTimeoutMs: 5_000,
    staleMs: 100,
    pollMs: 20,
    ...overrides,
  });

  it('runs when nothing else is running, and reports mode "ran"', async () => {
    const outcome = await coordinateRun({ ...options(), run: async () => 'mine' });
    expect(outcome.mode).toBe('ran');
    expect(outcome.result).toBe('mine');
  });

  it('publishes a record that the next caller reuses without running', async () => {
    await coordinateRun({ ...options(), run: async () => 'first' });
    let ran = false;
    const outcome = await coordinateRun({
      ...options(),
      run: async () => {
        ran = true;
        return 'second';
      },
    });
    expect(outcome.mode).toBe('reused');
    expect(outcome.result).toBe('first');
    expect(ran).toBe(false);
  });

  it('waits for the running process and then reuses its result', async () => {
    const first = coordinateRun({
      ...options(),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'slow';
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let secondRan = false;
    const second = await coordinateRun({
      ...options(),
      run: async () => {
        secondRan = true;
        return 'fast';
      },
    });
    expect(second.mode).toBe('reused');
    expect(second.result).toBe('slow');
    expect(secondRan).toBe(false);
    expect(second.waitedMs).toBeGreaterThan(0);
    expect(await first).toBeDefined();
  });

  it('marks a run dirty when the tree changes while it runs, and nobody reuses it', async () => {
    await writeFile(nodePath.join(root, 'before.ts'), 'x');
    await coordinateRun({
      ...options(),
      run: async () => {
        await writeFile(nodePath.join(root, 'during.ts'), 'y');
        return 'dirty-result';
      },
    });
    const second = await coordinateRun({ ...options(), run: async () => 'clean' });
    expect(second.mode).toBe('ran');
    expect(second.result).toBe('clean');
  });

  it('takes over a stale slot instead of waiting for a dead process', async () => {
    const slot = acquireSlot(root, 0)!;
    // Simulate a crash: the slot file survives, pointing at a process that cannot
    // exist, with a heartbeat from the beginning of time.
    nodeFs.writeFileSync(slot.path, JSON.stringify({ pid: 999_999, startedAt: 0, heartbeatAt: 0 }));
    slot.release(); // stops our heartbeat; the file is not ours, so it stays
    expect(readSlot(slot.path)).not.toBeNull();

    const outcome = await coordinateRun({ ...options(), run: async () => 'took-over' });
    expect(outcome.mode).toBe('ran');
    expect(outcome.result).toBe('took-over');
    expect(outcome.events.some((event) => event.type === 'took-over')).toBe(true);
  });

  it('runs without coordinating when standalone is set', async () => {
    await coordinateRun({ ...options(), run: async () => 'first' });
    const outcome = await coordinateRun({
      ...options(),
      standalone: true,
      run: async () => 'second',
    });
    expect(outcome.mode).toBe('standalone');
    expect(outcome.result).toBe('second');
  });

  it('does not publish a record when standalone, so nobody reuses it', async () => {
    await coordinateRun({ ...options(), standalone: true, run: async () => 'first' });
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))).toBeNull();
  });

  it('reports the number of listeners the run had', async () => {
    const first = coordinateRun({
      ...options(),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'slow';
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiter = registerWaiter(root);
    const outcome = await first;
    expect(outcome.listeners).toBeGreaterThanOrEqual(1);
    waiter.unregister();
  });

  it('runs after waiting when the other run covered a different state', async () => {
    const first = coordinateRun({
      ...options(),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'first';
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(nodePath.join(root, 'mine.ts'), 'my work');
    const second = await coordinateRun({ ...options(), run: async () => 'second' });
    expect(second.mode).toBe('ran-after-wait');
    expect(second.result).toBe('second');
    expect(second.waitedMs).toBeGreaterThan(0);
    expect(await first).toBeDefined();
  });

  it('gives up waiting at the timeout and runs', async () => {
    const first = coordinateRun({
      ...options(),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return 'first';
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await coordinateRun({
      ...options(),
      waitTimeoutMs: 60,
      run: async () => 'second',
    });
    expect(second.mode).toBe('ran-after-wait');
    expect(second.result).toBe('second');
    expect(await first).toBeDefined();
  });

  it('lets a second run proceed when jobs is 2', async () => {
    let concurrent = 0;
    let peak = 0;
    const slow = async (): Promise<string> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 150));
      concurrent -= 1;
      return 'done';
    };
    // Different request keys, so they cannot share a record and must both run.
    const both = await Promise.all([
      coordinateRun({ ...options({ requestKey: 'a' }), jobs: 2, run: slow }),
      coordinateRun({ ...options({ requestKey: 'b' }), jobs: 2, run: slow }),
    ]);
    expect(both.map((outcome) => outcome.mode).sort()).toEqual(['ran', 'ran']);
    expect(peak).toBe(2);
  });

  it('makes the second caller wait when jobs is 1', async () => {
    let concurrent = 0;
    let peak = 0;
    const slow = async (): Promise<string> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 150));
      concurrent -= 1;
      return 'done';
    };
    const both = await Promise.all([
      coordinateRun({ ...options({ requestKey: 'a' }), jobs: 1, run: slow }),
      coordinateRun({ ...options({ requestKey: 'b' }), jobs: 1, run: slow }),
    ]);
    expect(peak).toBe(1);
    expect(both.map((outcome) => outcome.mode).sort()).toEqual(['ran', 'ran-after-wait']);
  });

  it('reports how many files the run re-checked through the getter', async () => {
    await coordinateRun({
      ...options(),
      recheckedFiles: () => 4,
      run: async () => 'done',
    });
    expect(findReusableRecord(root, 'k1', FULL, FULL, treeStateFor(root))?.record.recheckedFiles).toBe(4);
  });
});

describe('one whole-tree run answers every scope', () => {
  const FULL = 'scope-full';

  const options = (overrides: Record<string, unknown> = {}) => ({
    root,
    requestKey: 'k1',
    scopeKey: FULL,
    fullScopeKey: FULL,
    jobs: 1,
    waitTimeoutMs: 5_000,
    staleMs: 100,
    pollMs: 20,
    ...overrides,
  });

  it('answers a narrow scope from a record of the whole tree', async () => {
    // The fleet's win: the full run is paid for once, and a scoped request after it
    // is answered from the record instead of scanning and checking the tree again.
    await coordinateRun({ ...options(), run: async () => 'full-result' });
    let ran = false;
    const outcome = await coordinateRun({
      ...options({ scopeKey: 'scope-mine' }),
      run: async () => {
        ran = true;
        return 'scoped-result';
      },
    });
    expect(ran).toBe(false);
    expect(outcome.mode).toBe('reused');
    expect(outcome.reusedScope).toBe('full');
    expect(outcome.result).toBe('full-result');
  });

  it('reports an identical scope as the same scope', async () => {
    await coordinateRun({ ...options({ scopeKey: 'scope-mine' }), run: async () => 'mine' });
    const outcome = await coordinateRun({
      ...options({ scopeKey: 'scope-mine' }),
      run: async () => 'never',
    });
    expect(outcome.reusedScope).toBe('same');
  });

  it('never answers one narrow scope from another narrow scope', async () => {
    // The safety property. A run at `scope-other` examined other files: reusing it
    // here would report this caller's files as clean without having looked at them.
    await coordinateRun({ ...options({ scopeKey: 'scope-other' }), run: async () => 'other' });
    const outcome = await coordinateRun({
      ...options({ scopeKey: 'scope-mine' }),
      run: async () => 'mine',
    });
    expect(outcome.mode).toBe('ran');
    expect(outcome.reusedScope).toBeUndefined();
    expect(outcome.result).toBe('mine');
  });

  it('keeps two instances apart even when their scopes coincide', async () => {
    await coordinateRun({ ...options({ requestKey: 'other-instance' }), run: async () => 'x' });
    const outcome = await coordinateRun({
      ...options({ scopeKey: 'scope-mine' }),
      run: async () => 'mine',
    });
    expect(outcome.mode).toBe('ran');
  });
});
