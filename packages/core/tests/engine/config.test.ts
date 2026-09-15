import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { defineConfig } from '../../src/engine/config';

describe('defineConfig storage', () => {
  it('leaves storage unspecified by default', () => {
    // Undefined means "not specified": programmatic `runAll` stays in memory,
    // the CLI picks its default location.
    expect(defineConfig({ rules: [] }).storage).toBeUndefined();
  });

  it('passes an explicit opt-out through', () => {
    const config = defineConfig({ rules: [], storage: { kind: 'memory' } });
    expect(config.storage).toEqual({ kind: 'memory' });
  });

  it('keeps an absolute sqlite path as-is', () => {
    const config = defineConfig({ rules: [], storage: { kind: 'sqlite', path: '/tmp/x.db' } });
    expect(config.storage).toEqual({ kind: 'sqlite', path: '/tmp/x.db' });
  });

  it('resolves a relative sqlite path against the project root', () => {
    const config = defineConfig({
      projectRoot: '/project',
      rules: [],
      storage: { kind: 'sqlite', path: '.gesetz/cache.db' },
    });
    expect(config.storage).toEqual({
      kind: 'sqlite',
      path: nodePath.join('/project', '.gesetz/cache.db'),
    });
  });
});
