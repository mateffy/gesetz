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
  const paths = ['src/a.ts', 'src/lib/b.ts', 'src/c.php', 'app/M.php'];

  it('returns the paths the globs match', () => {
    expect(expandRequest(paths, ['src/**/*.ts'])).toEqual(['src/a.ts', 'src/lib/b.ts']);
    expect(expandRequest(paths, ['src/lib/**'])).toEqual(['src/lib/b.ts']);
    expect(expandRequest(paths, ['src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('accepts several globs, in the order the paths were given', () => {
    expect(expandRequest(paths, ['app/**', 'src/a.ts'])).toEqual(['src/a.ts', 'app/M.php']);
  });

  it('returns every path when the request has no usable globs', () => {
    expect(expandRequest(paths, ['', '   '])).toEqual(paths);
  });

  it('does not walk anything: it only filters what it is handed', () => {
    // The runner has already discovered the project; a request must not make it
    // walk the tree a second time.
    expect(expandRequest([], ['src/**/*.ts'])).toEqual([]);
  });
});
