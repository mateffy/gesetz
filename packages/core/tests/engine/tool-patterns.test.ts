import { describe, it, expect } from 'vitest';
import micromatch from 'micromatch';
import { scopedPatterns, toolWatchPatterns } from '../../src/engine/tool-patterns';

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

describe('scopedPatterns', () => {
  it('returns the changed files that match the tool globs', () => {
    expect(scopedPatterns(['src/a.ts', 'src/b.php'], ['src/**/*.ts'])).toEqual(['src/a.ts']);
  });

  it('returns null when no changed file matches, meaning "nothing to do"', () => {
    // Null is distinct from []: [] would make a tool scan nothing and report a
    // clean project, which is the fail-open shape this returns null to avoid.
    expect(scopedPatterns(['src/a.php'], ['src/**/*.ts'])).toBeNull();
  });

  it('returns null for an empty changed list', () => {
    expect(scopedPatterns([], ['src/**/*.ts'])).toBeNull();
  });

  it('ignores paths outside the project', () => {
    expect(scopedPatterns(['../elsewhere/a.ts'], ['src/**/*.ts'])).toBeNull();
  });

  it('keeps every match, in the order they were given', () => {
    expect(scopedPatterns(['src/z.ts', 'src/a.ts', 'src/b.ts'], ['src/**/*.ts'])).toEqual([
      'src/z.ts',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('accepts a directory-style tool pattern through its watch glob', () => {
    // `oxfmt({ pattern: 'packages' })` becomes `packages/**\/*` for watching, and
    // that is what changed files must be matched against.
    expect(scopedPatterns(['packages/cli/src/a.ts'], toolWatchPatterns(['packages']))).toEqual([
      'packages/cli/src/a.ts',
    ]);
  });

  it('does not scope a rule whose tool config file changed', () => {
    // A changed config file is not a file to lint, so the scope comes back null
    // and the tool runs over the project instead.
    expect(scopedPatterns(['.oxfmtrc.json'], toolWatchPatterns(['packages']))).toBeNull();
  });
});
