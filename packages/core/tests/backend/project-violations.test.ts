import { describe, it, expect } from 'vitest';
import type { ExtensionContext } from 'netzwerk';
import {
  groupByPath,
  normalizeRulePath,
  storeProjectViolations,
} from '../../src/backend/project-violations';
import type { CompileContext, Rule, Violation } from '../../src/engine/rule';

const RULE = { id: 'oxfmt', description: 'formats' } as Rule;

const violation = (path: string, message = 'not formatted'): Violation => ({
  rule: 'oxfmt',
  message,
  path,
  severity: 'warn',
  source: 'custom',
});

/** The parts of netzwerk's storage this module uses, in memory. */
const storage = (initial: Record<string, readonly string[]> = {}) => {
  const markers = new Map<string, { extension: string }[]>();
  for (const [path, extensions] of Object.entries(initial)) {
    markers.set(
      path,
      extensions.map((extension) => ({ extension })),
    );
  }
  const files = new Set(Object.keys(initial));
  return {
    markers,
    files,
    async allMarkers(): Promise<[string, { extension: string }[]][]> {
      return [...markers.entries()];
    },
    async putMarkers(path: string, extension: string, next: readonly unknown[]): Promise<void> {
      if (next.length === 0) {
        const remaining = (markers.get(path) ?? []).filter((m) => m.extension !== extension);
        markers.set(path, remaining);
        return;
      }
      const kept = (markers.get(path) ?? []).filter((m) => m.extension !== extension);
      markers.set(path, [...kept, ...next.map(() => ({ extension }))]);
    },
    async getFile(path: string): Promise<unknown> {
      return files.has(path) ? { path } : undefined;
    },
  };
};

type Storage = ExtensionContext['storage'];

const ctx = (pendingViolations?: Violation[]): CompileContext =>
  ({
    rootDir: '/project',
    getServices: () => {
      throw new Error('not used');
    },
    ...(pendingViolations === undefined ? {} : { pendingViolations }),
  }) as unknown as CompileContext;

const extensionsOn = (store: ReturnType<typeof storage>, path: string): string[] =>
  (store.markers.get(path) ?? []).map((m) => m.extension);

describe('normalizeRulePath', () => {
  it('leaves a relative path alone', () => {
    expect(normalizeRulePath('src/a.ts', '/project')).toBe('src/a.ts');
  });

  it('makes an absolute path relative to the root', () => {
    expect(normalizeRulePath('/project/src/a.ts', '/project')).toBe('src/a.ts');
  });

  it('uses forward slashes, which is how the network stores paths', () => {
    const nested = normalizeRulePath('/project/src/deep/a.ts', '/project');
    expect(nested).not.toContain('\\');
    expect(nested).toBe('src/deep/a.ts');
  });
});

describe('groupByPath', () => {
  it('groups violations by their path', () => {
    const { byPath } = groupByPath(
      [violation('src/a.ts'), violation('src/a.ts', 'other')],
      '/project',
    );
    expect(byPath.get('src/a.ts')).toHaveLength(2);
  });

  it('normalizes the path it stores each violation under', () => {
    const { byPath } = groupByPath([violation('/project/src/a.ts')], '/project');
    expect([...byPath.keys()]).toEqual(['src/a.ts']);
    expect(byPath.get('src/a.ts')?.[0]?.path).toBe('src/a.ts');
  });

  it('orphans a violation that is not under the root', () => {
    const { byPath, orphaned } = groupByPath([violation('/elsewhere/a.ts')], '/project');
    expect([...byPath.keys()]).toEqual([]);
    expect(orphaned).toHaveLength(1);
  });

  it('orphans an empty path', () => {
    expect(groupByPath([violation('')], '/project').orphaned).toHaveLength(1);
  });
});

describe('storeProjectViolations', () => {
  it('replaces the marks wholesale when the rule named no scope', async () => {
    const store = storage({ 'src/a.ts': ['oxfmt'], 'src/clean.ts': ['oxfmt'] });
    await storeProjectViolations(store as unknown as Storage, RULE, [violation('src/a.ts')], ctx());
    expect(extensionsOn(store, 'src/a.ts')).toEqual(['oxfmt']);
    // Nothing was said about src/clean.ts, and a rule that examined the whole
    // project has said "src/clean.ts is clean" by not mentioning it.
    expect(extensionsOn(store, 'src/clean.ts')).toEqual([]);
  });

  it('leaves unexamined paths alone when the rule named its scope', async () => {
    const store = storage({ 'src/edited.ts': ['oxfmt'], 'src/untouched.ts': ['oxfmt'] });
    await storeProjectViolations(
      store as unknown as Storage,
      RULE,
      [violation('src/edited.ts')],
      ctx(),
      ['src/edited.ts'],
    );
    expect(extensionsOn(store, 'src/edited.ts')).toEqual(['oxfmt']);
    expect(extensionsOn(store, 'src/untouched.ts')).toEqual(['oxfmt']);
  });

  it('clears an examined path that is now clean', async () => {
    const store = storage({ 'src/edited.ts': ['oxfmt'] });
    await storeProjectViolations(store as unknown as Storage, RULE, [], ctx(), ['src/edited.ts']);
    expect(extensionsOn(store, 'src/edited.ts')).toEqual([]);
  });

  it("does not touch another rule's marks", async () => {
    const store = storage({ 'src/a.ts': ['oxfmt', 'oxlint'] });
    await storeProjectViolations(store as unknown as Storage, RULE, [], ctx());
    expect(extensionsOn(store, 'src/a.ts')).toEqual(['oxlint']);
  });

  it('normalizes an absolute path in the scope list', async () => {
    const store = storage({ 'src/a.ts': ['oxfmt'] });
    await storeProjectViolations(store as unknown as Storage, RULE, [], ctx(), [
      '/project/src/a.ts',
    ]);
    expect(extensionsOn(store, 'src/a.ts')).toEqual([]);
  });

  it('reports an orphaned violation on the pending channel', async () => {
    // A path with no file in the network cannot carry a marker, so the violation
    // would otherwise be lost.
    const pending: Violation[] = [];
    const store = storage({ 'src/a.ts': ['oxfmt'] });
    await storeProjectViolations(
      store as unknown as Storage,
      RULE,
      [violation('src/gone.ts')],
      ctx(pending),
    );
    expect(pending.map((v) => v.path)).toEqual(['src/gone.ts']);
  });
});
