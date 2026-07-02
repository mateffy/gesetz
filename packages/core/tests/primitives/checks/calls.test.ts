import { describe, it, expect } from 'vitest';
import { Layer } from 'effect';
import { noDirectCalls } from '../../../src/primitives/checks/calls';
import { makeSyntaxTreeLayer, SyntaxTreeUnavailable } from '../../helpers/syntax-tree';
import { buildCheckServices } from '../../helpers/services';
import { ImportResolverDefault } from '../../../src/services/import-resolver';
import { ProjectRootLive, FileFilterLive } from '../../../src/services/fs';
import type { File } from '../../../src/engine/rule';

function makeFile(name = 'foo.ts'): File {
  return {
    path: `src/${name}`,
    absolutePath: `/abs/src/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: '.' + name.split('.').pop()!,
    dir: 'src',
    content: 'irrelevant — SyntaxTree is stubbed',
    size: 0,
    mtimeMs: 0,
  };
}

async function runCheck(
  check: (file: File, services: any) => Promise<any>,
  file: File,
  layer: Layer.Layer<any>,
) {
  const services = await buildCheckServices(
    layer,
    ProjectRootLive('/abs'),
    ImportResolverDefault,
    FileFilterLive(null),
  );
  return check(file, services);
}

describe('noDirectCalls', () => {
  it('flags calls whose name is in the banned set', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [
        { name: 'eval', line: 3 },
        { name: 'fetch', line: 7 },
        { name: 'eval', line: 12 },
      ],
    });
    const violations = await runCheck(noDirectCalls(['eval']), makeFile(), layer);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(12);
    expect(violations[0]?.message).toContain('eval');
  });

  it('does not flag calls not in the banned set', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'fetch', line: 1 }, { name: 'console.log', line: 2 }],
    });
    const violations = await runCheck(noDirectCalls(['eval']), makeFile(), layer);
    expect(violations).toHaveLength(0);
  });

  it('returns [] when no SyntaxBackend is registered (canProcess: false)', async () => {
    const layer = SyntaxTreeUnavailable;
    const violations = await runCheck(noDirectCalls(['eval']), makeFile(), layer);
    expect(violations).toHaveLength(0);
  });

  it('uses a custom message callback', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'eval', line: 3 }],
    });
    const violations = await runCheck(
      noDirectCalls(['eval'], { message: (n) => `do not call ${n}!` }),
      makeFile(),
      layer,
    );
    expect(violations[0]?.message).toBe('do not call eval!');
  });

  it('respects custom severity', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'eval', line: 3 }],
    });
    const violations = await runCheck(
      noDirectCalls(['eval'], { severity: 'warn' }),
      makeFile(),
      layer,
    );
    expect(violations[0]?.severity).toBe('warn');
  });

  it('handles member-access call names like console.log', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'console.log', line: 5 }],
    });
    const violations = await runCheck(noDirectCalls(['console.log']), makeFile(), layer);
    expect(violations).toHaveLength(1);
  });
});
