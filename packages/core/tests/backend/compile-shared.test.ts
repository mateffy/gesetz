import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import type { ExtensionContext } from 'netzwerk';
import {
  hasStoredMarkers,
  networkFileFromStorage,
  projectRuleContext,
  refreshSharedPaths,
  ruleFingerprint,
} from '../../src/backend/compile-shared';
import type { CompileContext } from '../../src/backend/compile';
import type { Rule } from '../../src/engine/rule';
import { select } from '../../src/primitives/select';
import type { Check } from '../../src/engine/rule';

type Storage = ExtensionContext['storage'];

/** The slice of netzwerk's storage these helpers use, in memory. */
const storage = (
  files: Record<string, { extension: string; type: string; data: unknown }[]> = {},
) => ({
  async listFiles(): Promise<{ path: string }[]> {
    return Object.keys(files).map((path) => ({ path }));
  },
  async getFile(path: string): Promise<unknown> {
    return path in files ? { path } : undefined;
  },
  async markersFor(path: string): Promise<{ extension: string; type: string; data: unknown }[]> {
    return files[path] ?? [];
  },
  async allMarkers(): Promise<[string, { extension: string }[]][]> {
    return Object.entries(files).map(([path, markers]) => [path, markers]);
  },
});

const rule = (id: string, patterns: string[] = ['src/**/*.ts']): Rule =>
  select(...patterns)
    .label(id)
    .category('cleanup')
    .check((async () => []) as Check);

describe('hasStoredMarkers', () => {
  it('is true when the rule left a marker anywhere', async () => {
    const store = storage({ 'src/a.ts': [{ extension: 'my-rule', type: 'violation', data: {} }] });
    expect(await hasStoredMarkers(store as unknown as Storage, 'my-rule')).toBe(true);
  });

  it('is false when only other rules left markers', async () => {
    const store = storage({ 'src/a.ts': [{ extension: 'other', type: 'violation', data: {} }] });
    expect(await hasStoredMarkers(store as unknown as Storage, 'my-rule')).toBe(false);
  });

  it('is false for an empty storage', async () => {
    expect(await hasStoredMarkers(storage() as unknown as Storage, 'my-rule')).toBe(false);
  });
});

describe('refreshSharedPaths', () => {
  it('fills the shared path set from storage', async () => {
    const shared = new Set<string>(['stale']);
    const store = storage({ 'src/a.ts': [], 'src/b.ts': [] });
    await refreshSharedPaths(
      { sharedPaths: shared } as unknown as CompileContext,
      { storage: store } as unknown as ExtensionContext,
    );
    expect([...shared].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('does nothing when the context has no shared set', async () => {
    const store = storage({ 'src/a.ts': [] });
    await expect(
      refreshSharedPaths(
        {} as unknown as CompileContext,
        { storage: store } as unknown as ExtensionContext,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('networkFileFromStorage', () => {
  it('carries the raw marker type plus the extension that stored it', async () => {
    // Regression: prefixing the type produced `gesetz-syntax.import`, which this
    // module's own matcher accepted and netzwerk did not, so import resolution and
    // cycle detection were dead on every path that read from storage.
    const store = storage({
      'src/a.ts': [{ extension: 'gesetz-syntax', type: 'import', data: { file: 'src/b.ts' } }],
    });
    const file = await networkFileFromStorage(store as unknown as Storage, '/project', 'src/a.ts');
    expect(file.markers[0]?.type).toBe('import');
    expect(file.markers[0]?.extension).toBe('gesetz-syntax');
    expect(file.hasMarker('import')).toBe(true);
    expect(file.hasMarker('call')).toBe(false);
    expect(file.markersOf('import')).toHaveLength(1);
    expect(file.markersOf('call')).toEqual([]);
  });
});

describe('projectRuleContext', () => {
  it('passes the request through to the rule', async () => {
    const store = storage({ 'src/a.ts': [] });
    const context = projectRuleContext(
      { storage: store } as unknown as ExtensionContext,
      { rootDir: '/project' } as unknown as CompileContext,
      ['src/a.ts'],
      ['src/a.ts'],
    );
    expect(context.changedFiles).toEqual(['src/a.ts']);
    expect(context.requestedPaths).toEqual(['src/a.ts']);
    expect(context.rootDir).toBe('/project');
  });

  it('reports null requested paths for an unscoped run', () => {
    const context = projectRuleContext(
      { storage: storage() } as unknown as ExtensionContext,
      { rootDir: '/project' } as unknown as CompileContext,
      [],
      null,
    );
    expect(context.requestedPaths).toBeNull();
  });

  it('resolves a file through the network only when storage has it', async () => {
    const store = storage({ 'src/a.ts': [] });
    const context = projectRuleContext(
      { storage: store } as unknown as ExtensionContext,
      { rootDir: '/project' } as unknown as CompileContext,
      [],
      null,
    );
    expect(await context.network.file('src/a.ts')).not.toBeNull();
    expect(await context.network.file('src/gone.ts')).toBeNull();
  });

  it('globs the network', async () => {
    const store = storage({ 'src/a.ts': [], 'src/b.php': [] });
    const context = projectRuleContext(
      { storage: store } as unknown as ExtensionContext,
      { rootDir: '/project' } as unknown as CompileContext,
      [],
      null,
    );
    const matched = await context.network.glob('src/**/*.ts');
    expect(matched.map((file) => file.path)).toEqual(['src/a.ts']);
  });
});

describe('ruleFingerprint', () => {
  it('is stable for the same rule', () => {
    expect(ruleFingerprint(rule('a'))).toBe(ruleFingerprint(rule('a')));
  });

  it('changes when the patterns change, because the rule looks elsewhere', () => {
    expect(ruleFingerprint(rule('a', ['src/**/*.ts']))).not.toBe(
      ruleFingerprint(rule('a', ['app/**/*.php'])),
    );
  });

  it('changes when the check changes', () => {
    const other = select('src/**/*.ts')
      .label('a')
      .category('cleanup')
      .check((async () => [{ message: 'x' }]) as unknown as Check);
    expect(ruleFingerprint(other)).not.toBe(ruleFingerprint(rule('a')));
  });

  it('does not depend on which files exist', () => {
    // The property that a fingerprint of the whole file set destroyed: netzwerk
    // reprocesses every file when any extension fingerprint changes, so a
    // file-set-dependent fingerprint made adding one file re-parse the project.
    // This function takes only the rule; there is nothing else it could hash.
    const fingerprint = ruleFingerprint(rule('a'));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ruleFingerprint(rule('a'))).toBe(fingerprint);
  });
});
