import { describe, expect, it } from 'vitest';
import {
  SYNTAX_EXTENSION,
  SYNTAX_MARKERS_VERSION,
  syntaxExtension,
} from '../../src/backend/syntax-extension';
import type { SyntaxBackend } from '../../src/services/syntax-tree';

function stubBackend(extensions: readonly string[] = ['.ts']): SyntaxBackend {
  return {
    extensions,
    extractImports: () => [{ specifier: './foo', names: ['a', 'b'], line: 1 }],
    extractCalls: () => [{ name: 'console.log', line: 3 }],
    extractExports: () => [{ name: 'doThing', kind: 'function', line: 5 }],
    extractStructure: () => [
      {
        kind: 'function',
        name: 'doThing',
        startLine: 5,
        endLine: 9,
        docstring: 'Does a thing.',
        children: [],
      },
    ],
  };
}

const FILE = { relativePath: 'src/a.ts' } as never;
const CTX = { rootPath: '/tmp', storage: {} } as never;

describe('syntaxExtension', () => {
  it('emits one marker per extracted item with lines', async () => {
    const ext = syntaxExtension([stubBackend()]);
    const markers = await ext.process!(FILE, 'content', CTX);

    expect(markers).toEqual([
      {
        type: 'import',
        extension: 'gesetz-syntax',
        data: {
          file: './foo',
          language: 'typescript',
          specifier: './foo',
          names: ['a', 'b'],
          line: 1,
        },
        lines: [1],
      },
      {
        type: 'call',
        extension: 'gesetz-syntax',
        data: { name: 'console.log', line: 3 },
        lines: [3],
      },
      {
        type: 'export',
        extension: 'gesetz-syntax',
        data: { name: 'doThing', kind: 'function', line: 5 },
        lines: [5],
      },
      {
        type: 'structure',
        extension: 'gesetz-syntax',
        data: {
          kind: 'function',
          name: 'doThing',
          startLine: 5,
          endLine: 9,
          docstring: 'Does a thing.',
          children: [],
        },
        lines: [5, 9],
      },
    ]);
  });

  it('emits nothing for files without a matching backend', async () => {
    const ext = syntaxExtension([stubBackend(['.ts'])]);
    const markers = await ext.process!({ relativePath: 'a.php' } as never, 'c', CTX);
    expect(markers).toEqual([]);
  });

  it('namespaces under the gesetz-syntax extension name', () => {
    const ext = syntaxExtension([stubBackend()]);
    expect(ext.name).toBe(SYNTAX_EXTENSION);
    expect(ext.include).toEqual(['**/*.ts']);
  });

  it('computes a fingerprint from the version and backend extension sets', () => {
    const one = syntaxExtension([stubBackend(['.ts', '.tsx'])]);
    const two = syntaxExtension([stubBackend(['.ts'])]);
    expect(one.fingerprint).toContain(SYNTAX_MARKERS_VERSION);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });

  it('first registered backend wins for a shared extension', async () => {
    const first = stubBackend(['.ts']);
    const second: SyntaxBackend = {
      ...stubBackend(['.ts']),
      extractCalls: () => [{ name: 'other', line: 1 }],
    };
    const ext = syntaxExtension([first, second]);
    const markers = await ext.process!(FILE, 'content', CTX);
    expect(markers.find((m) => m.type === 'call')?.data).toEqual({ name: 'console.log', line: 3 });
  });
});
