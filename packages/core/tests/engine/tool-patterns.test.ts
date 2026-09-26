import { describe, it, expect } from 'vitest';
import micromatch from 'micromatch';
import { toolWatchPatterns } from '../../src/engine/tool-patterns';

describe('toolWatchPatterns', () => {
  it('turns a directory into a recursive glob', () => {
    // Regression: `pattern: 'packages'` was used directly as a micromatch glob
    // against changed file paths, where it matches nothing — so the rule never
    // re-ran and kept reporting a stale result forever.
    expect(toolWatchPatterns(['packages'])).toEqual(['packages/**/*']);
  });

  it('turns the default `.` into a whole-project glob', () => {
    expect(toolWatchPatterns(['.'])).toEqual(['**/*']);
    expect(toolWatchPatterns(['./'])).toEqual(['**/*']);
  });

  it('keeps a pattern that is already a glob', () => {
    for (const glob of ['**/*.ts', 'src/**/*', '**/*.{js,ts}', 'a?c/*.ts', 'src/[ab]/*.ts']) {
      expect(toolWatchPatterns([glob]), glob).toEqual([glob]);
    }
  });

  it('keeps a path that names a specific file', () => {
    expect(toolWatchPatterns(['eslint.config.js'])).toEqual(['eslint.config.js']);
    expect(toolWatchPatterns(['.eslintrc'])).toEqual(['.eslintrc']);
  });

  it('does not double up the separator on a trailing slash', () => {
    expect(toolWatchPatterns(['packages/'])).toEqual(['packages/**/*']);
  });

  it('handles several patterns and dedupes them', () => {
    expect(toolWatchPatterns(['packages', 'src', 'packages'])).toEqual([
      'packages/**/*',
      'src/**/*',
    ]);
  });

  it('ignores empty and whitespace-only entries', () => {
    expect(toolWatchPatterns(['', '   ', 'src'])).toEqual(['src/**/*']);
  });

  it('trims before deciding', () => {
    expect(toolWatchPatterns(['  packages  '])).toEqual(['packages/**/*']);
  });

  it('returns nothing for an empty list', () => {
    expect(toolWatchPatterns([])).toEqual([]);
  });

  it('produces globs that actually match real changed paths', () => {
    // The property that matters, checked with the same matcher the compiled
    // project rule uses. `micromatch` is what decided the rule was never
    // relevant, so testing against anything else would miss the bug.
    const changed = ['packages/cli/src/format.ts', 'packages/core/src/a/b.ts'];
    const watch = toolWatchPatterns(['packages']);
    expect(micromatch.some(changed, watch, { dot: true })).toBe(true);
  });

  it('the raw directory path does not match, which is the bug this fixes', () => {
    const changed = ['packages/cli/src/format.ts'];
    expect(micromatch.some(changed, ['packages'], { dot: true })).toBe(false);
    expect(micromatch.some(changed, ['.'], { dot: true })).toBe(false);
  });

  it('a whole-project pattern matches a nested path', () => {
    expect(micromatch.some(['a/b/c/d.ts'], toolWatchPatterns(['.']), { dot: true })).toBe(true);
  });

  it('a scoped directory pattern matches only inside that directory', () => {
    const watch = toolWatchPatterns(['src']);
    expect(micromatch.some(['src/a/b.ts'], watch, { dot: true })).toBe(true);
    expect(micromatch.some(['packages/a/b.ts'], watch, { dot: true })).toBe(false);
  });
});
