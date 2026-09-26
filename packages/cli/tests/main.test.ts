import { describe, it, expect, vi } from 'vitest';

describe('main entry point', () => {
  it('can be imported without running the CLI', async () => {
    // Regression guard for the `isEntryPoint` check: importing the module is how
    // tests and embedders reach `runGesetz`, and it must not execute a command.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const mod = await import('../src/main');
    expect(typeof mod.runGesetz).toBe('function');
    expect(exit).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('exposes runGesetz as a callable', async () => {
    const mod = await import('../src/main');
    expect(mod.runGesetz.length).toBeLessThanOrEqual(1);
  });
});
