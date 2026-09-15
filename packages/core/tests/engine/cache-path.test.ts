import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCacheDir, defaultCachePath } from '../../src/engine/cache-path';

const originalXdg = process.env['XDG_CACHE_HOME'];

afterEach(() => {
  if (originalXdg === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = originalXdg;
});

describe('defaultCacheDir', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    process.env['XDG_CACHE_HOME'] = '/custom/cache';
    expect(defaultCacheDir()).toBe(nodePath.join('/custom/cache', 'gesetz'));
  });

  it('falls back to ~/.cache', () => {
    delete process.env['XDG_CACHE_HOME'];
    expect(defaultCacheDir()).toBe(nodePath.join(nodeOs.homedir(), '.cache', 'gesetz'));
  });

  it('ignores an empty XDG_CACHE_HOME', () => {
    process.env['XDG_CACHE_HOME'] = '';
    expect(defaultCacheDir()).toBe(nodePath.join(nodeOs.homedir(), '.cache', 'gesetz'));
  });

  it('lives outside any repository, so nothing needs gitignoring', () => {
    delete process.env['XDG_CACHE_HOME'];
    expect(defaultCacheDir().startsWith(nodePath.join(nodeOs.homedir(), '.cache'))).toBe(true);
  });
});

describe('defaultCachePath', () => {
  it('is the cache database inside the cache directory', () => {
    process.env['XDG_CACHE_HOME'] = '/custom/cache';
    expect(defaultCachePath()).toBe(nodePath.join('/custom/cache', 'gesetz', 'cache.db'));
  });
});