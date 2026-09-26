/**
 * The generator emits import statements for the checks a plan selects. A
 * generated config that imports something the package does not export does not
 * compile — and five of them did not:
 *
 *   noConsoleLog, noEmptyCatch, noTrivialComment, relativeImports  from @gesetz/core
 *   noCrossModuleImports                                          from @gesetz/typescript
 *
 * Those checks had moved to `@gesetz/typescript` (or, for the last one, did not
 * exist anywhere). Nothing noticed, because no test ever resolved the emitted
 * specifiers against the packages that have to provide them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { generateConfig, BLUEPRINTS, blueprintsForPreset } from '../src/init/rules';
import type { Plan } from '../src/init/rules';
import type { ProjectProfile } from '../src/init/detect';

const WORKSPACE = nodePath.resolve(import.meta.dirname, '../../..');

/** Every export name a built package declares, from its generated `.d.ts`. */
function exportsOf(pkg: string): Set<string> {
  const dir = nodePath.join(WORKSPACE, 'packages', pkg.replace('@gesetz/', ''));
  const dts = readFileSync(nodePath.join(dir, 'dist', 'index.d.ts'), 'utf8');
  const names = new Set<string>();
  for (const match of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(',')) {
      const entry = part.trim();
      if (!entry) continue;
      // `x`, `x as y`, `type x as y`
      const aliased = /^(?:type\s+)?\w+\s+as\s+(\w+)$/.exec(entry);
      names.add(aliased ? aliased[1]! : entry.replace(/^type\s+/, ''));
    }
    // `export { a } from './x'` and `export * as ns` are covered by the above
  }
  return names;
}

/** The `import { ... } from '<pkg>'` specifiers in generated source. */
function importsOf(source: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)';$/gm)) {
    const names = match[1]!
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean);
    out.push({ from: match[2]!, names });
  }
  return out;
}

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    cwd: '/tmp/x',
    framework: 'generic',
    suggestedPreset: 'generic',
    detectedTools: [],
    packageManager: 'npm',
    hasExistingConfig: false,
    hasSrc: true,
    hasRoutes: true,
    hasComponents: true,
    hasDomains: true,
    isLaravel: true,
    ...overrides,
  };
}

/** A plan that selects every blueprint in the catalog. */
function planWithEverything(): Plan {
  return {
    preset: 'generic',
    tools: new Set(),
    rules: new Set(BLUEPRINTS.map((b) => b.id)),
    install: false,
    qaScript: false,
    profile: makeProfile(),
  };
}

describe('generated configs only import what exists', () => {
  const cache = new Map<string, Set<string>>();
  const exportsFor = (pkg: string): Set<string> => {
    if (!cache.has(pkg)) cache.set(pkg, exportsOf(pkg));
    return cache.get(pkg)!;
  };

  it('every emitted import resolves against the owning package', () => {
    const source = generateConfig(planWithEverything());
    const imports = importsOf(source);
    expect(imports.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const { from, names } of imports) {
      if (!from.startsWith('@gesetz/')) continue; // external packages are not our contract
      const available = exportsFor(from);
      for (const name of names) {
        if (!available.has(name)) missing.push(`${name} is not exported from ${from}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('holds for every preset, not just the one that was hand-checked', () => {
    const missing: string[] = [];
    for (const preset of ['generic', 'react', 'ts', 'laravel', 'component-library'] as const) {
      const plan: Plan = {
        preset,
        tools: new Set(),
        rules: new Set(blueprintsForPreset(preset).map((b) => b.id)),
        install: false,
        qaScript: false,
        profile: makeProfile(),
      };
      for (const { from, names } of importsOf(generateConfig(plan))) {
        if (!from.startsWith('@gesetz/')) continue;
        const available = exportsFor(from);
        for (const name of names) {
          if (!available.has(name)) missing.push(`${preset}: ${name} is not exported from ${from}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
