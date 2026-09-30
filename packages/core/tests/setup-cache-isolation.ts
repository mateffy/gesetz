/**
 * Gives the whole test run its own cache directory.
 *
 * Without this, any test that calls `runAll` writes to the developer's real
 * cache — `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db` — which has two
 * consequences. The obvious one is that tests mutate a file the developer cares
 * about. The subtle one is that the cache is *shared*: when a gesetz process is
 * running elsewhere (a second agent in the same worktree, a check in another
 * terminal), those tests block on the SQLite write lock for the full 5 s
 * `busy_timeout` and fail on vitest's timeout, having found nothing wrong.
 *
 * A per-run directory makes them deterministic and independent of whatever else
 * is happening on the machine. `XDG_CACHE_HOME` is the variable the default
 * cache path already reads, so this needs no product change.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const dir = mkdtempSync(nodePath.join(tmpdir(), 'gesetz-test-cache-'));
process.env['XDG_CACHE_HOME'] = dir;

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover directory the size of a few test fixtures is not worth failing a
    // run over, and `exit` handlers are the wrong place to throw.
  }
});
