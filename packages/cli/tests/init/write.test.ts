import { describe, it, expect } from 'vitest';
import { resolvePlanFromFlags } from '../../src/init/write';
import type { ProjectProfile } from '../../src/init/detect';
import type { InitFlags } from '../../src/init/write';

/** The flag object the CLI builds from argv; every field is required. */
const flags = (overrides: Partial<InitFlags> = {}): InitFlags => ({
  force: false,
  install: false,
  qaScript: false,
  interactive: false,
  ...overrides,
});

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

describe('resolvePlanFromFlags', () => {
  it('uses the suggested preset when no preset flag is given', () => {
    expect(resolvePlanFromFlags(profile(), flags()).preset).toBe('generic');
  });

  it('lets an explicit preset flag win over the suggestion', () => {
    expect(resolvePlanFromFlags(profile(), flags({ preset: 'react' })).preset).toBe('react');
  });

  it('takes tools from an explicit flag', () => {
    const p = resolvePlanFromFlags(profile(), flags({ tools: 'oxlint,vitest' }));
    expect([...p.tools].sort()).toEqual(['oxlint', 'vitest']);
  });

  it('carries the profile through by value', () => {
    const prof = profile({ framework: 'laravel' });
    expect(resolvePlanFromFlags(prof, flags()).profile).toEqual(prof);
  });

  it('is deterministic for the same inputs', () => {
    const a = resolvePlanFromFlags(profile(), flags({ preset: 'react' }));
    const b = resolvePlanFromFlags(profile(), flags({ preset: 'react' }));
    expect([...a.rules].sort()).toEqual([...b.rules].sort());
  });

  it('always selects at least one rule for a non-blank preset', () => {
    expect(
      resolvePlanFromFlags(profile(), flags({ preset: 'generic' })).rules.size,
    ).toBeGreaterThan(0);
  });

  it('reflects the install and qa-script flags', () => {
    const p = resolvePlanFromFlags(profile(), {
      force: true,
      install: true,
      qaScript: true,
      interactive: false,
    });
    expect(p.install).toBe(true);
    expect(p.qaScript).toBe(true);
  });

  it('reflects them being off as well', () => {
    const p = resolvePlanFromFlags(profile(), {
      force: false,
      install: false,
      qaScript: false,
      interactive: false,
    });
    expect(p.install).toBe(false);
    expect(p.qaScript).toBe(false);
  });
});
