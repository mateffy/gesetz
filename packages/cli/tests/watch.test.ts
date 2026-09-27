import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { shouldIgnoreWatchEvent, watchForChanges } from '../src/watch';

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, watch: vi.fn() };
});

type WatchListener = (event: string, filename: string | null) => void;

/**
 * Captures the listener `fs.watch` was given, so tests drive the watcher
 * themselves instead of racing the real one. The captured function is read
 * through this object, never destructured: it is only set when the module under
 * test calls `fs.watch`.
 */
const install = (): { fire: (filename: string) => void; close: ReturnType<typeof vi.fn> } => {
  const close = vi.fn();
  let listener: WatchListener | null = null;
  (nodeFs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_root: string, _options: unknown, cb: WatchListener) => {
      listener = cb;
      return { close };
    },
  );
  return {
    fire: (filename: string): void => {
      if (listener === null) throw new Error('fs.watch has not been called yet');
      (listener as WatchListener)('change', filename);
    },
    close,
  };
};

describe('shouldIgnoreWatchEvent', () => {
  it('ignores events with no filename, because there is nothing to act on', () => {
    expect(shouldIgnoreWatchEvent(null)).toBe(true);
  });

  it('ignores the cache directory the run writes to', () => {
    // Without this the watcher triggers itself: every run writes markers, which is
    // an event, which starts another run.
    expect(shouldIgnoreWatchEvent('.gesetz/cache.db')).toBe(true);
    expect(shouldIgnoreWatchEvent('nested/.gesetz/coord/lock')).toBe(true);
  });

  it('ignores VCS metadata and dependencies', () => {
    expect(shouldIgnoreWatchEvent('.git/index')).toBe(true);
    expect(shouldIgnoreWatchEvent('node_modules/effect/index.js')).toBe(true);
  });

  it('does not ignore a source file', () => {
    expect(shouldIgnoreWatchEvent('src/a.ts')).toBe(false);
  });

  it('does not ignore a file that merely contains the ignored words', () => {
    expect(shouldIgnoreWatchEvent('src/my.gesetz.ts')).toBe(false);
    expect(shouldIgnoreWatchEvent('src/node_modules_helper.ts')).toBe(false);
  });
});

describe('watchForChanges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of writes into one run', () => {
    const watcher = install();
    const runs: number[] = [];
    watchForChanges({ root: '/project', debounceMs: 50, onSettled: () => runs.push(1) });

    watcher.fire('src/a.ts');
    watcher.fire('src/b.ts');
    watcher.fire('src/c.ts');
    vi.advanceTimersByTime(49);
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(1);
  });

  it('runs again for a later, separate change', () => {
    const watcher = install();
    const runs: number[] = [];
    watchForChanges({ root: '/project', debounceMs: 50, onSettled: () => runs.push(1) });

    watcher.fire('src/a.ts');
    vi.advanceTimersByTime(50);
    watcher.fire('src/b.ts');
    vi.advanceTimersByTime(50);
    expect(runs).toHaveLength(2);
  });

  it('never settles for an ignored path', () => {
    const watcher = install();
    const runs: number[] = [];
    watchForChanges({ root: '/project', debounceMs: 50, onSettled: () => runs.push(1) });

    watcher.fire('.gesetz/cache.db');
    watcher.fire('node_modules/x/index.js');
    watcher.fire('.git/HEAD');
    vi.advanceTimersByTime(500);
    expect(runs).toHaveLength(0);
  });

  it('cancels a pending run when closed', () => {
    const watcher = install();
    const runs: number[] = [];
    const handle = watchForChanges({
      root: '/project',
      debounceMs: 50,
      onSettled: () => runs.push(1),
    });

    watcher.fire('src/a.ts');
    handle.close();
    vi.advanceTimersByTime(500);
    expect(runs).toHaveLength(0);
    expect(watcher.close).toHaveBeenCalled();
  });

  it('watches the root recursively', () => {
    install();
    watchForChanges({ root: '/project', onSettled: () => undefined });
    expect(nodeFs.watch).toHaveBeenCalledWith(
      '/project',
      { recursive: true },
      expect.any(Function),
    );
  });
});
