/**
 * The `--watch` loop: re-run the checks when a file changes.
 *
 * Kept apart from the command definition so the debounce and the ignore list —
 * the two parts with behaviour worth testing — are not buried in a handler.
 */
import * as nodeFs from 'node:fs';

/** How long to wait after the last event before re-running. */
export const WATCH_DEBOUNCE_MS = 150;

/**
 * Paths whose changes must not trigger a run: the cache the run writes, VCS
 * metadata, and dependencies. Without this the watcher triggers itself, and every
 * run it triggers writes to the cache again.
 */
const IGNORED_PATHS = /(\/|^)(\.gesetz|\.git|node_modules)(\/|$)/;

export const shouldIgnoreWatchEvent = (filename: string | null): boolean =>
  filename === null || IGNORED_PATHS.test(filename);

export interface WatchHandle {
  close(): void;
}

/**
 * Watches `root` and calls `onSettled` once the writes stop.
 *
 * A burst of writes — saving five files, a formatter touching twenty — becomes
 * one run rather than twenty.
 */
export const watchForChanges = (options: {
  root: string;
  onSettled: () => void;
  debounceMs?: number;
}): WatchHandle => {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | undefined;
  const watcher = nodeFs.watch(options.root, { recursive: true }, (_event, filename) => {
    if (shouldIgnoreWatchEvent(filename)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      options.onSettled();
    }, debounceMs);
  });
  return {
    close: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    },
  };
};
