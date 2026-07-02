import { describe, it, expect } from 'vitest';
import {
  requireExportsMatching,
  requireRelatedExports,
} from '../../../src/primitives/checks/exports';
import { makeSyntaxTreeLayer, SyntaxTreeUnavailable } from '../../helpers/syntax-tree';
import { buildCheckServices } from '../../helpers/services';
import { ProjectRootLive } from '../../../src/services/fs';
import { ImportResolverDefault } from '../../../src/services/import-resolver';
import type { File } from '../../../src/engine/rule';

function makeFile(name = 'foo.ts'): File {
  return {
    path: `src/${name}`,
    absolutePath: `/abs/src/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: '.' + name.split('.').pop()!,
    dir: 'src',
    content: '',
    size: 0,
    mtimeMs: 0,
  };
}

async function runCheck(
  check: (file: File, services: any) => Promise<any>,
  file: File,
  layer: any,
) {
  const services = await buildCheckServices(
    layer,
    ProjectRootLive('/abs'),
    ImportResolverDefault,
  );
  return check(file, services);
}

describe('requireExportsMatching', () => {
  it('passes when at least minCount exports match the pattern', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [
        { name: 'queryKeys', kind: 'function', line: 1 },
        { name: 'mutationKeys', kind: 'function', line: 2 },
        { name: 'unrelated', kind: 'function', line: 3 },
      ],
    });
    const violations = await runCheck(requireExportsMatching(/Keys$/, 1), makeFile(), layer);
    expect(violations).toHaveLength(0);
  });

  it('fails when fewer than minCount exports match', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [{ name: 'onlyOne', kind: 'function', line: 1 }],
    });
    const violations = await runCheck(requireExportsMatching(/Keys$/, 2), makeFile(), layer);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('2');
    expect(violations[0]?.message).toContain('found 0');
  });

  it('returns [] when canProcess is false', async () => {
    const violations = await runCheck(requireExportsMatching(/x/), makeFile(), SyntaxTreeUnavailable);
    expect(violations).toHaveLength(0);
  });
});

describe('requireRelatedExports', () => {
  it('flags an export whose required counterparts are missing', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [
        { name: 'useFoo', kind: 'function', line: 1 },
        { name: 'useSuspenseFoo', kind: 'function', line: 2 },
      ],
    });
    const violations = await runCheck(
      requireRelatedExports((name) => {
        if (name !== 'useFoo') return null;
        return ['useSuspenseFoo', 'useCachedFoo'];
      }),
      makeFile(),
      layer,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('useCachedFoo');
    expect(violations[0]?.message).not.toContain('useSuspenseFoo'); // present, not missing
  });

  it('passes when all required counterparts are present', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [
        { name: 'useFoo', kind: 'function', line: 1 },
        { name: 'useSuspenseFoo', kind: 'function', line: 2 },
        { name: 'useCachedFoo', kind: 'function', line: 3 },
      ],
    });
    const violations = await runCheck(
      requireRelatedExports((name) =>
        name === 'useFoo' ? ['useSuspenseFoo', 'useCachedFoo'] : null,
      ),
      makeFile(),
      layer,
    );
    expect(violations).toHaveLength(0);
  });

  it('skips exports for which getRelated returns null', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [
        { name: 'unrelated', kind: 'function', line: 1 },
        { name: 'useFoo', kind: 'function', line: 2 },
      ],
    });
    const violations = await runCheck(
      requireRelatedExports((name) => (name.startsWith('use') ? ['useXyz'] : null)),
      makeFile(),
      layer,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('useXyz');
  });

  it('uses custom message callback with name and missing', async () => {
    const layer = makeSyntaxTreeLayer({
      exports: [{ name: 'useFoo', kind: 'function', line: 1 }],
    });
    const violations = await runCheck(
      requireRelatedExports(
        (name) => (name === 'useFoo' ? ['useBar'] : null),
        { message: (name, missing) => `${name} needs ${missing.join(',')}` },
      ),
      makeFile(),
      layer,
    );
    expect(violations[0]?.message).toBe('useFoo needs useBar');
  });

  it('returns [] when canProcess is false', async () => {
    const violations = await runCheck(
      requireRelatedExports(() => null),
      makeFile(),
      SyntaxTreeUnavailable,
    );
    expect(violations).toHaveLength(0);
  });
});
