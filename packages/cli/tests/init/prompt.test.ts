import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer } from 'effect';
import { Terminal } from '@effect/platform';
import type { ProjectProfile } from '../../src/init/detect';
import type { InitFlags } from '../../src/init/write';

/** Answers the wizard will "type", set per test. */
const answers = { select: '', multiSelect: [] as string[], confirm: [] as boolean[] };

vi.mock('@effect/cli', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const Prompt = {
    select: () => Effect.succeed(answers.select),
    multiSelect: () => Effect.succeed(answers.multiSelect),
    confirm: () => Effect.succeed(answers.confirm.shift() ?? false),
  };
  return { ...actual, Prompt };
});

const { runWizard } = await import('../../src/init/prompt');

/** The wizard never touches the terminal because Prompt is stubbed. */
const TerminalStub = Layer.succeed(Terminal, {} as never);

const profile = (overrides: Partial<ProjectProfile> = {}): ProjectProfile => ({
  cwd: '/tmp/proj',
  framework: 'generic',
  suggestedPreset: 'generic',
  detectedTools: [],
  packageManager: 'npm',
  hasExistingConfig: false,
  hasSrc: true,
  hasRoutes: false,
  hasComponents: false,
  hasDomains: false,
  isLaravel: false,
  ...overrides,
});

const flags = (overrides: Partial<InitFlags> = {}): InitFlags => ({
  force: false,
  install: false,
  qaScript: false,
  interactive: true,
  ...overrides,
});

const run = (p: ProjectProfile, f: InitFlags) =>
  Effect.runPromise(Effect.provide(runWizard(p, f), TerminalStub) as never);

beforeEach(() => {
  answers.select = 'react';
  answers.multiSelect = [];
  answers.confirm = [];
});

describe('runWizard', () => {
  it('returns a plan built from the answers', async () => {
    const plan = (await run(profile(), flags())) as { preset: string; install: boolean; qaScript: boolean };
    expect(plan.preset).toBe('react');
    expect(plan.install).toBe(false);
    expect(plan.qaScript).toBe(false);
  });

  it('turns the selected tools into a Set', async () => {
    answers.multiSelect = ['oxlint', 'vitest'];
    const plan = (await run(profile(), flags({ preset: 'react' }))) as { tools: Set<string> };
    expect([...plan.tools].sort()).toEqual(['oxlint', 'vitest']);
  });

  it('asks about install and qa only when the flags allow it', async () => {
    answers.confirm = [true, true];
    const plan = (await run(profile(), flags({ install: true, qaScript: true }))) as { install: boolean; qaScript: boolean };
    expect(plan.install).toBe(true);
    expect(plan.qaScript).toBe(true);
  });

  it('does not consume a confirm answer when the flags are off', async () => {
    answers.confirm = [true, true];
    const plan = (await run(profile(), flags({ install: false, qaScript: false }))) as { install: boolean; qaScript: boolean };
    expect(plan.install).toBe(false);
    expect(plan.qaScript).toBe(false);
    expect(answers.confirm).toEqual([true, true]);
  });

  it('fails with cancelled when an existing config is not to be overwritten', async () => {
    answers.confirm = [false];
    await expect(run(profile({ hasExistingConfig: true }), flags())).rejects.toThrow(/cancelled/);
  });

  it('proceeds past the overwrite gate when a new config is being created', async () => {
    const plan = await run(profile({ hasExistingConfig: false }), flags());
    expect(plan).toBeDefined();
  });

  it('carries the profile into the plan', async () => {
    const p = profile({ framework: 'react' });
    const plan = (await run(p, flags())) as { profile: ProjectProfile };
    expect(plan.profile).toEqual(p);
  });
});
