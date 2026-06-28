import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { noDirectCalls } from '../../../src/primitives/checks/calls';
import { makeSyntaxTreeLayer, SyntaxTreeUnavailable } from '../../helpers/syntax-tree';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>, layer: any): Promise<any> =>
  Effect.provide(effect, layer).pipe(Effect.runPromise as any);

describe('noDirectCalls', () => {
  it('flags calls whose name is in the banned set', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [
        { name: 'eval', line: 3 },
        { name: 'fetch', line: 7 },
        { name: 'eval', line: 12 },
      ],
    });
    const violations = await run(noDirectCalls(['eval'])(makeFile()), layer);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(12);
    expect(violations[0]?.message).toContain('eval');
  });

  it('does not flag calls not in the banned set', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'fetch', line: 1 }, { name: 'console.log', line: 2 }],
    });
    const violations = await run(noDirectCalls(['eval'])(makeFile()), layer);
    expect(violations).toHaveLength(0);
  });

  it('returns [] when no SyntaxBackend is registered (canProcess: false)', async () => {
    const layer = SyntaxTreeUnavailable;
    const violations = await run(noDirectCalls(['eval'])(makeFile()), layer);
    expect(violations).toHaveLength(0);
  });

  it('uses a custom message callback', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'eval', line: 3 }],
    });
    const violations = await run(
      noDirectCalls(['eval'], { message: (n) => `do not call ${n}!` })(makeFile()),
      layer,
    );
    expect(violations[0]?.message).toBe('do not call eval!');
  });

  it('respects custom severity', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'eval', line: 3 }],
    });
    const violations = await run(noDirectCalls(['eval'], { severity: 'warn' })(makeFile()), layer);
    expect(violations[0]?.severity).toBe('warn');
  });

  it('handles member-access call names like console.log', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'console.log', line: 5 }],
    });
    const violations = await run(noDirectCalls(['console.log'])(makeFile()), layer);
    expect(violations).toHaveLength(1);
  });
});
