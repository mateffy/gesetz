import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { requireNamingConvention, noForbiddenNames } from '../../../src/primitives/checks/naming';
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
    content: '',
    size: 0,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>, layer: any): Promise<any> =>
  Effect.provide(effect, layer).pipe(Effect.runPromise as any);

describe('requireNamingConvention', () => {
  it('flags items whose name does not match the pattern', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'goodName', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'function', name: 'BadName', startLine: 3, endLine: 4, docstring: null, children: [] },
        { kind: 'function', name: 'also_bad', startLine: 5, endLine: 6, docstring: null, children: [] },
      ],
    });
    const violations = await run(
      requireNamingConvention({ kinds: ['function'], pattern: /^[a-z][a-zA-Z0-9]*$/ })(makeFile()),
      layer,
    );
    expect(violations).toHaveLength(2);
    expect(violations.map((v: { message: string }) => v.message).join('\n')).toContain('BadName');
    expect(violations.map((v: { message: string }) => v.message).join('\n')).toContain('also_bad');
  });

  it('checks all kinds when kinds is omitted', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'bad_name', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'class', name: 'BadClass', startLine: 3, endLine: 4, docstring: null, children: [] },
      ],
    });
    const violations = await run(
      requireNamingConvention({ pattern: /^[A-Z]/ })(makeFile()),
      layer,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('bad_name');
  });

  it('recurses into children', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        {
          kind: 'class',
          name: 'GoodClass',
          startLine: 1,
          endLine: 10,
          docstring: null,
          children: [
            { kind: 'method', name: 'bad_method', startLine: 2, endLine: 3, docstring: null, children: [] },
          ],
        },
      ],
    });
    const violations = await run(
      requireNamingConvention({ kinds: ['method'], pattern: /^[a-z][a-zA-Z0-9]*$/ })(makeFile()),
      layer,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('returns [] when canProcess is false', async () => {
    const violations = await run(
      requireNamingConvention({ pattern: /x/ })(makeFile()),
      SyntaxTreeUnavailable,
    );
    expect(violations).toHaveLength(0);
  });
});

describe('noForbiddenNames', () => {
  it('flags names in the banned string list', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'function', name: 'bar', startLine: 3, endLine: 4, docstring: null, children: [] },
        { kind: 'function', name: 'safe', startLine: 5, endLine: 6, docstring: null, children: [] },
      ],
    });
    const violations = await run(noForbiddenNames(['foo', 'bar'])(makeFile()), layer);
    expect(violations).toHaveLength(2);
  });

  it('flags names matching a regex', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'tmp_1', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'function', name: 'tmp_2', startLine: 3, endLine: 4, docstring: null, children: [] },
        { kind: 'function', name: 'real', startLine: 5, endLine: 6, docstring: null, children: [] },
      ],
    });
    const violations = await run(noForbiddenNames(/^tmp_/)(makeFile()), layer);
    expect(violations).toHaveLength(2);
  });

  it('respects the kinds filter', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'class', name: 'foo', startLine: 3, endLine: 4, docstring: null, children: [] },
      ],
    });
    const violations = await run(
      noForbiddenNames(['foo'], { kinds: ['function'] })(makeFile()),
      layer,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
  });

  it('uses custom message callback', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
      ],
    });
    const violations = await run(
      noForbiddenNames(['foo'], { message: (n) => `banned: ${n}` })(makeFile()),
      layer,
    );
    expect(violations[0]?.message).toBe('banned: foo');
  });
});
