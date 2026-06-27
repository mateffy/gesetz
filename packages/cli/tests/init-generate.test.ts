import { describe, it, expect } from 'vitest';
import { generateConfig, BLUEPRINTS, blueprintsForPreset } from '../src/init/rules';
import { PRESETS } from '../src/init/presets';
import type { Plan } from '../src/init/rules';
import type { ProjectProfile } from '../src/init/detect';

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    cwd: '/tmp/x',
    framework: 'generic',
    suggestedPreset: 'generic',
    detectedTools: [],
    packageManager: 'npm',
    hasExistingConfig: false,
    hasSrc: true,
    hasRoutes: false,
    hasComponents: true,
    hasDomains: false,
    isLaravel: false,
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    preset: 'generic',
    tools: new Set(),
    rules: new Set(blueprintsForPreset('generic').map((b) => b.id)),
    install: false,
    qaScript: false,
    profile: makeProfile(),
    ...overrides,
  };
}

describe('generateConfig — structure', () => {
  it('emits the defineConfig header + projectRoot', () => {
    const src = generateConfig(makePlan());
    expect(src).toContain('export default defineConfig({');
    expect(src).toContain('projectRoot: import.meta.dirname');
  });

  it('imports defineConfig from @gesetz/core', () => {
    const src = generateConfig(makePlan());
    expect(src).toMatch(/import \{ .*defineConfig.* \} from '@gesetz\/core';/);
  });

  it('imports select from @gesetz/core for non-laravel presets', () => {
    const src = generateConfig(makePlan());
    expect(src).toMatch(/import \{ .*select.* \} from '@gesetz\/core';/);
  });

  it('blank preset emits empty rules array', () => {
    const src = generateConfig(
      makePlan({ preset: 'blank', rules: new Set(), profile: makeProfile() }),
    );
    expect(src).toContain('rules: []');
  });
});

describe('generateConfig — generic preset', () => {
  it('emits noGodFile with maxLines: 600', () => {
    const src = generateConfig(makePlan());
    expect(src).toContain('noGodFile({ maxLines: 600 })');
  });

  it('emits noConsoleLog', () => {
    const src = generateConfig(makePlan());
    expect(src).toContain('noConsoleLog()');
  });

  it('emits relativeImports', () => {
    const src = generateConfig(makePlan());
    expect(src).toContain('relativeImports()');
  });

  it('does not emit react-only rules in generic preset', () => {
    const src = generateConfig(makePlan());
    expect(src).not.toContain('noHardcodedStrings');
    expect(src).not.toContain('@tanstack/react-query');
  });
});

describe('generateConfig — react preset', () => {
  it('emits noHardcodedStrings for react preset', () => {
    const profile = makeProfile({ framework: 'react' });
    const src = generateConfig(
      makePlan({ preset: 'react', rules: new Set(blueprintsForPreset('react').map((b) => b.id)), profile }),
    );
    expect(src).toContain('noHardcodedStrings()');
  });

  it('emits component-has-stories when storybook tool selected', () => {
    const profile = makeProfile({ framework: 'react' });
    const src = generateConfig(
      makePlan({
        preset: 'react',
        tools: new Set(['storybook']),
        rules: new Set(blueprintsForPreset('react').map((b) => b.id)),
        profile,
      }),
    );
    expect(src).toContain("requireSibling('.stories.tsx')");
  });
});

describe('generateConfig — tanstack-start preset', () => {
  it('emits route discipline rules when routes/ exist', () => {
    const profile = makeProfile({ framework: 'tanstack-start', hasRoutes: true, hasDomains: true });
    const src = generateConfig(
      makePlan({
        preset: 'tanstack-start',
        rules: new Set(blueprintsForPreset('tanstack-start').map((b) => b.id)),
        profile,
      }),
    );
    expect(src).toContain('noLocalFunctionComponents');
    expect(src).toContain('noCrossModuleImports');
  });
});

describe('generateConfig — laravel preset', () => {
  it('emits laravel rules as bare identifiers', () => {
    const profile = makeProfile({
      framework: 'laravel',
      suggestedPreset: 'laravel',
      isLaravel: true,
      packageManager: 'composer',
    });
    const src = generateConfig(
      makePlan({
        preset: 'laravel',
        rules: new Set(blueprintsForPreset('laravel').map((b) => b.id)),
        profile,
      }),
    );
    expect(src).toContain('requireStrictTypes');
    expect(src).toContain('noRawDbQueries');
    expect(src).toContain('requirePsrNamespaces');
  });

  it('imports from @gesetz/laravel', () => {
    const profile = makeProfile({ isLaravel: true, suggestedPreset: 'laravel' });
    const src = generateConfig(
      makePlan({
        preset: 'laravel',
        rules: new Set(blueprintsForPreset('laravel').map((b) => b.id)),
        profile,
      }),
    );
    expect(src).toMatch(/import \{ .*requireStrictTypes.* \} from '@gesetz\/laravel';/);
  });

  it('does not import select for laravel preset', () => {
    const profile = makeProfile({ isLaravel: true, suggestedPreset: 'laravel' });
    const src = generateConfig(
      makePlan({
        preset: 'laravel',
        rules: new Set(blueprintsForPreset('laravel').map((b) => b.id)),
        profile,
      }),
    );
    expect(src).not.toMatch(/\bselect\b/);
  });
});

describe('generateConfig — tool adapter rules', () => {
  it('emits oxlint adapter rule', () => {
    const src = generateConfig(
      makePlan({ tools: new Set(['oxlint'] as const) }),
    );
    expect(src).toContain("oxlint({ pattern: 'src/'");
    expect(src).toMatch(/import \{ oxlint \} from '@gesetz\/oxlint';/);
  });

  it('emits vitest adapter rule', () => {
    const src = generateConfig(
      makePlan({ tools: new Set(['vitest'] as const) }),
    );
    expect(src).toContain('vitest({');
    expect(src).toMatch(/import \{ vitest \} from '@gesetz\/vitest';/);
  });

  it('dedupes imports when multiple blueprints use the same import', () => {
    // requireSibling used by require-tests-sibling, component-has-stories, component-has-tests
    const profile = makeProfile({
      framework: 'react',
      hasComponents: true,
    });
    const src = generateConfig(
      makePlan({
        preset: 'react',
        tools: new Set(['storybook'] as const),
        rules: new Set(blueprintsForPreset('react').map((b) => b.id)),
        profile,
      }),
    );
    // requireSibling should appear exactly once in the import statement
    const importMatch = src.match(/import \{ ([^}]*) \} from '@gesetz\/core';/);
    expect(importMatch).toBeTruthy();
    const importedNames = importMatch![1].split(',').map((s) => s.trim());
    const requireSiblingCount = importedNames.filter((n) => n === 'requireSibling').length;
    expect(requireSiblingCount).toBe(1);
  });
});

describe('preset composition invariants', () => {
  it('tanstack-start ⊇ react ⊇ generic', () => {
    const generic = new Set(PRESETS.generic.map((b) => b.id));
    const react = new Set(PRESETS.react.map((b) => b.id));
    const ts = new Set(PRESETS['tanstack-start'].map((b) => b.id));
    // react contains all of generic
    for (const id of generic) expect(react.has(id)).toBe(true);
    // tanstack-start contains all of react
    for (const id of react) expect(ts.has(id)).toBe(true);
  });

  it('blank has no blueprints', () => {
    expect(PRESETS.blank).toHaveLength(0);
  });

  it('laravel has exactly 5 PHP rules', () => {
    expect(PRESETS.laravel).toHaveLength(5);
    expect(PRESETS.laravel.map((b) => b.id)).toEqual([
      'laravel-strict-types',
      'laravel-psr-namespaces',
      'laravel-no-raw-db',
      'laravel-no-env-outside-config',
      'laravel-no-debug-helpers',
    ]);
  });

  it('every blueprint id is unique', () => {
    const ids = BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
