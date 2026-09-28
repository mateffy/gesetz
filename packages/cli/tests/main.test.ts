import { describe, it, expect, vi } from 'vitest';

// Importing this module pulls in @effect/cli and the whole command tree, which
// takes a couple of seconds on an idle machine and can pass five under a loaded
// suite. The timeout is the cost of testing the guard at all.
const IMPORT_TIMEOUT_MS = 30_000;

describe('main entry point', () => {
  it(
    'imports without running the CLI, and exposes runGesetz',
    async () => {
      // Regression guard for the `isEntryPoint` check: importing the module is
      // how tests and embedders reach `runGesetz`, so it must not execute a
      // command, print anything, or set an exit code.
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        const mod = await import('../src/main');
        expect(typeof mod.runGesetz).toBe('function');
        expect(exit).not.toHaveBeenCalled();
        expect(out).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
    IMPORT_TIMEOUT_MS,
  );
});
