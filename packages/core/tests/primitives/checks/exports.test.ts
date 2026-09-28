import { describe, it, expect } from 'vitest';
import {
  requireExportsMatching,
  requireRelatedExports,
} from '../../../src/primitives/checks/exports';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';
import type { ParsedExport } from '../../../src/services/syntax-tree';

function svcs(exports: ParsedExport[]) {
  return makeCheckServices({ syntax: { exports } });
}

describe('requireExportsMatching', () => {
  it('passes when at least minCount exports match the pattern', async () => {
    const v = await runCheck(
      requireExportsMatching(/Keys$/, 1),
      makeFile('src/foo.ts'),
      svcs([
        { name: 'queryKeys', kind: 'function', line: 1 },
        { name: 'mutationKeys', kind: 'function', line: 2 },
        { name: 'unrelated', kind: 'function', line: 3 },
      ]),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when fewer than minCount exports match', async () => {
    const v = await runCheck(
      requireExportsMatching(/Keys$/, 2),
      makeFile('src/foo.ts'),
      svcs([{ name: 'onlyOne', kind: 'function', line: 1 }]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('2');
    expect(v[0]?.message).toContain('found 0');
  });

  it('returns [] when canProcess is false', async () => {
    const services = makeCheckServices({ overrides: { syntax: { canProcess: () => false } } });
    const v = await runCheck(requireExportsMatching(/x/), makeFile('src/foo.ts'), services);
    expect(v).toHaveLength(0);
  });
});

describe('requireRelatedExports', () => {
  it('flags an export whose required counterparts are missing', async () => {
    const v = await runCheck(
      requireRelatedExports((name) =>
        name === 'useFoo' ? ['useSuspenseFoo', 'useCachedFoo'] : null,
      ),
      makeFile('src/foo.ts'),
      svcs([
        { name: 'useFoo', kind: 'function', line: 1 },
        { name: 'useSuspenseFoo', kind: 'function', line: 2 },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('useCachedFoo');
    expect(v[0]?.message).not.toContain('useSuspenseFoo');
  });

  it('passes when all required counterparts are present', async () => {
    const v = await runCheck(
      requireRelatedExports((name) =>
        name === 'useFoo' ? ['useSuspenseFoo', 'useCachedFoo'] : null,
      ),
      makeFile('src/foo.ts'),
      svcs([
        { name: 'useFoo', kind: 'function', line: 1 },
        { name: 'useSuspenseFoo', kind: 'function', line: 2 },
        { name: 'useCachedFoo', kind: 'function', line: 3 },
      ]),
    );
    expect(v).toHaveLength(0);
  });

  it('skips exports for which getRelated returns null', async () => {
    const v = await runCheck(
      requireRelatedExports((name) => (name.startsWith('use') ? ['useXyz'] : null)),
      makeFile('src/foo.ts'),
      svcs([
        { name: 'unrelated', kind: 'function', line: 1 },
        { name: 'useFoo', kind: 'function', line: 2 },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('useXyz');
  });

  it('uses custom message callback with name and missing', async () => {
    const v = await runCheck(
      requireRelatedExports((name) => (name === 'useFoo' ? ['useBar'] : null), {
        message: (name, missing) => `${name} needs ${missing.join(',')}`,
      }),
      makeFile('src/foo.ts'),
      svcs([{ name: 'useFoo', kind: 'function', line: 1 }]),
    );
    expect(v[0]?.message).toBe('useFoo needs useBar');
  });

  it('returns [] when canProcess is false', async () => {
    const services = makeCheckServices({ overrides: { syntax: { canProcess: () => false } } });
    const v = await runCheck(
      requireRelatedExports(() => null),
      makeFile('src/foo.ts'),
      services,
    );
    expect(v).toHaveLength(0);
  });
});
