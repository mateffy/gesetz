import { describe, it, expect } from 'vitest';
import {
  bannedForForLayer,
  isExternalPackage,
  isRelativeImport,
  packageOf,
  regexExtractImports,
} from '../../src/architecture/helpers';

describe('isRelativeImport', () => {
  it('recognises the relative forms', () => {
    for (const s of ['./a', '../a', './a/b', '/abs/a']) expect(isRelativeImport(s), s).toBe(true);
  });

  it('rejects a bare package name', () => {
    for (const s of ['react', '@scope/pkg', 'node:fs'])
      expect(isExternalPackage(s) && !isRelativeImport(s), s).toBe(true);
  });
});

describe('isExternalPackage', () => {
  it('treats a bare specifier as external', () => {
    for (const s of ['react', '@scope/pkg', 'node:fs']) expect(isExternalPackage(s), s).toBe(true);
  });

  it('rejects relative and absolute specifiers', () => {
    for (const s of ['./a', '../a/b', '/abs/a']) expect(isExternalPackage(s), s).toBe(false);
  });
});

describe('packageOf', () => {
  it('keeps the scope for a scoped package', () => {
    expect(packageOf('@scope/pkg/sub/path')).toBe('@scope/pkg');
  });

  it('takes the first segment otherwise', () => {
    expect(packageOf('lodash/fp/curry')).toBe('lodash');
    expect(packageOf('react')).toBe('react');
  });

  it('does not throw on an empty specifier', () => {
    expect(typeof packageOf('')).toBe('string');
  });
});

describe('regexExtractImports', () => {
  const nl = String.fromCharCode(10);

  it('finds static, type, require and dynamic imports', () => {
    const source = [
      "import a from './a';",
      "import type { B } from '@scope/b';",
      "const c = require('./c');",
      "const d = await import('./d');",
    ].join(nl);
    expect(regexExtractImports(source)).toEqual(['./a', '@scope/b', './c', './d']);
  });

  it('returns an empty list for source with no imports', () => {
    expect(regexExtractImports('const x = 1;')).toEqual([]);
  });

  it('finds a require or a dynamic import that shares a line with code', () => {
    // Only the `import` form is line-anchored; the other two patterns are not.
    const found = regexExtractImports("const x = require('./y');");
    expect(found).toContain('./y');
  });

  it('does not find an `import` statement that is not at the start of a line', () => {
    // Documented limit of the regex fallback: the syntax backend is used when a
    // backend is registered, and this fallback is only for unknown extensions.
    expect(regexExtractImports("const x = 1; import y from './y';")).toEqual([]);
  });
});

describe('bannedForForLayer', () => {
  it('matches an exact specifier', () => {
    expect(bannedForForLayer(['react'], 'react')).toBe(true);
  });

  it('does not match a subpath: package-level matching happens in the caller', () => {
    // The caller also tests `packageOf(specifier)` against the list, so this
    // function stays a plain membership check.
    expect(bannedForForLayer(['react'], 'react/jsx-runtime')).toBe(false);
  });

  it('does not match a prefix that is not a path boundary', () => {
    expect(bannedForForLayer(['react'], 'reactor')).toBe(false);
  });

  it('is false for an empty ban list', () => {
    expect(bannedForForLayer([], 'react')).toBe(false);
  });
});
