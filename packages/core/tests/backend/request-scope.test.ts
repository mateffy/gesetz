import { describe, it, expect } from 'vitest';
import type { Rule } from '../../src/engine/rule';
import { expandRequest, rulesForRequest } from '../../src/backend/request-scope';

const perFileRule = (id: string, patterns: string[], exclusions: string[] = []): Rule =>
  ({
    id,
    description: id,
    run: async () => [],
    perFile: { patterns, exclusions, predicates: [], checks: [] },
  }) as unknown as Rule;

const projectRule = (id: string, patterns: string[]): Rule =>
  ({
    id,
    description: id,
    run: async () => [],
    project: { patterns, run: async () => [] },
  }) as unknown as Rule;

const looseRule = (id: string): Rule =>
  ({ id, description: id, run: async () => [] }) as unknown as Rule;

describe('rulesForRequest', () => {
  const requested = ['src/components/Button.tsx', 'src/lib/math.ts'];

  it('keeps a rule whose patterns can match a requested file', () => {
    const rules = [perFileRule('tsx', ['src/**/*.tsx'])];
    expect(rulesForRequest(rules, requested).map((r) => r.id)).toEqual(['tsx']);
  });

  it('drops a rule whose patterns cannot match any requested file', () => {
    // The point of the whole exercise: a rule with nothing to look at does not
    // run at all, rather than running and being filtered out of the report.
    const rules = [perFileRule('php', ['app/**/*.php'])];
    expect(rulesForRequest(rules, requested)).toEqual([]);
  });

  it('keeps only the rules that have something to say about the request', () => {
    const rules = [
      perFileRule('tsx', ['src/**/*.tsx']),
      perFileRule('php', ['app/**/*.php']),
      projectRule('cycles', ['src/**/*.ts']),
    ];
    expect(rulesForRequest(rules, requested).map((r) => r.id)).toEqual(['tsx', 'cycles']);
  });

  it('drops a rule when every requested file is excluded from it', () => {
    const rules = [perFileRule('source', ['src/**/*.ts'], ['**/*.test.ts'])];
    expect(rulesForRequest(rules, ['src/lib/math.test.ts'])).toEqual([]);
  });

  it('keeps a rule when some requested file is not excluded', () => {
    const rules = [perFileRule('source', ['src/**/*.ts'], ['**/*.test.ts'])];
    expect(rulesForRequest(rules, ['src/lib/math.test.ts', 'src/lib/math.ts'])).toHaveLength(1);
  });

  it('keeps a rule that declares no patterns, because nothing can prove it idle', () => {
    expect(rulesForRequest([looseRule('everything')], requested)).toHaveLength(1);
  });

  it('keeps every rule when the request matched no files', () => {
    // An empty request means "nothing matched", and dropping every rule would
    // turn a typo in a glob into a clean run.
    const rules = [perFileRule('tsx', ['src/**/*.tsx']), perFileRule('php', ['app/**/*.php'])];
    expect(rulesForRequest(rules, [])).toHaveLength(2);
  });

  it('does not mutate the rules it is given', () => {
    const rules = [perFileRule('tsx', ['src/**/*.tsx'])];
    const kept = rulesForRequest(rules, requested);
    kept.push(looseRule('added'));
    expect(rules).toHaveLength(1);
  });
});

describe('expandRequest', () => {
  it('returns the project files matching the globs', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-request-'));
    try {
      await mkdir(nodePath.join(dir, 'src/lib'), { recursive: true });
      await writeFile(nodePath.join(dir, 'src/a.ts'), '');
      await writeFile(nodePath.join(dir, 'src/lib/b.ts'), '');
      await writeFile(nodePath.join(dir, 'src/c.php'), '');
      expect(expandRequest(dir, ['src/**/*.ts'])).toEqual(['src/a.ts', 'src/lib/b.ts']);
      expect(expandRequest(dir, ['src/lib/**'])).toEqual(['src/lib/b.ts']);
      expect(expandRequest(dir, ['src/a.ts'])).toEqual(['src/a.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns every file when the request has no usable globs', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-request-'));
    await writeFile(nodePath.join(dir, 'a.ts'), '');
    expect(expandRequest(dir, ['', '   '])).toEqual(['a.ts']);
  });
});
