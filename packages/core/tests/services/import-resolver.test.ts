import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import * as nodePath from 'node:path';
import { ImportResolver, ImportResolverDefault } from '../../src/services/import-resolver';
import { makeFile } from '../../src/test-helpers';

const resolve = (specifier: string, from: string) =>
  Effect.runSync(
    Effect.gen(function* () {
      const resolver = yield* ImportResolver;
      return resolver.resolve(makeFile(from), specifier);
    }).pipe(Effect.provide(ImportResolverDefault)),
  );

describe('ImportResolverDefault', () => {
  it('resolves a sibling module to an absolute path', () => {
    expect(resolve('./b', 'src/a.ts')).toBe(nodePath.resolve(process.cwd(), 'src/b'));
  });

  it('resolves a parent-relative module', () => {
    expect(resolve('../lib/b', 'src/deep/a.ts')).toBe(nodePath.resolve(process.cwd(), 'src/lib/b'));
  });

  it('returns null for a bare package name, which it cannot resolve', () => {
    expect(resolve('react', 'src/a.ts')).toBeNull();
  });

  it('resolves an absolute path unchanged', () => {
    expect(resolve('/tmp/x.ts', 'src/a.ts')).toBe('/tmp/x.ts');
  });

  it('returns null for an empty specifier rather than throwing', () => {
    expect(resolve('', 'src/a.ts')).toBeNull();
  });

  it('is repeatable for the same input', () => {
    expect(resolve('./b', 'src/a.ts')).toBe(resolve('./b', 'src/a.ts'));
  });

  it('does not require the target to exist, because resolution is lexical', () => {
    expect(resolve('./does-not-exist', 'src/a.ts')).toContain('does-not-exist');
  });

  it('resolves relative to the importing file, not the cwd', () => {
    const fromDeep = resolve('./b', 'src/deep/nested/a.ts');
    const fromTop = resolve('./b', 'src/a.ts');
    expect(fromDeep).not.toBe(fromTop);
    expect(fromDeep).toContain('nested');
  });
});
