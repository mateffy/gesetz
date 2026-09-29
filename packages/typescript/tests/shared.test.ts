import { describe, it, expect } from 'vitest';
import {
  findByKind,
  findChildText,
  getCallArgs,
  parseFile,
  startLine,
  walkDescendants,
} from '../src/checks/shared';

const parse = (source: string) => parseFile(source, 'src/foo.ts');

describe('parseFile', () => {
  it('parses TypeScript', () => {
    expect(parse('const x = 1;')).not.toBeNull();
  });

  it('gives .tsx the JSX grammar, which the .ts grammar does not even know', () => {
    // Asking the plain TS grammar for a `jsx_element` is an invalid query, not an
    // empty result — which is exactly why the extension has to pick the parser.
    const source = 'const A = () => <p>x</p>;';
    const root = parseFile(source, 'src/A.tsx');
    expect(root).not.toBeNull();
    expect(findByKind(root!, 'jsx_element')).toHaveLength(1);
  });

  it('picks the grammar from the last extension, not the first', () => {
    const root = parseFile('const A = () => <p>x</p>;', 'src/A.component.tsx');
    expect(findByKind(root!, 'jsx_element')).toHaveLength(1);
  });

  it('parses JSX through the .jsx grammar too', () => {
    const root = parseFile('const A = () => <p>x</p>;', 'src/A.jsx');
    expect(findByKind(root!, 'jsx_element')).toHaveLength(1);
  });

  it('returns a root whose text is the source', () => {
    expect(parse('const x = 1;')?.text()).toContain('const x = 1;');
  });
});

describe('findByKind', () => {
  it('finds every node of a kind, nested ones included', () => {
    const root = parse('function a() {}\nfunction b() {}')!;
    expect(findByKind(root, 'function_declaration')).toHaveLength(2);
  });

  it('returns an empty array when the kind is absent', () => {
    expect(findByKind(parse('const x = 1;')!, 'enum_declaration')).toEqual([]);
  });
});

describe('findChildText', () => {
  const fn = () => findByKind(parse('function named() {}')!, 'function_declaration')[0]!;

  it('returns the text of the first child of that kind', () => {
    expect(findChildText(fn(), 'identifier')).toBe('named');
  });

  it('returns null when no child has that kind', () => {
    expect(findChildText(fn(), 'enum_declaration')).toBeNull();
  });
});

describe('startLine', () => {
  it('is 1 for a node on the first line', () => {
    expect(startLine(parse('const a = 1;')!)).toBe(1);
  });

  it('counts lines, so a node on line two reports 2', () => {
    const root = parse('const a = 1;\nconst b = 2;')!;
    const decls = findByKind(root, 'lexical_declaration');
    expect(startLine(decls[1]!)).toBe(2);
  });
});

describe('getCallArgs', () => {
  const callIn = (source: string) => findByKind(parse(source)!, 'call_expression')[0]!;

  it('returns one node per argument', () => {
    expect(getCallArgs(callIn('f(1, 2, 3);'))).toHaveLength(3);
  });

  it('returns an empty array for a call with no arguments', () => {
    expect(getCallArgs(callIn('f();'))).toEqual([]);
  });

  it('counts a nested call as a single argument', () => {
    expect(getCallArgs(callIn('f(g(1), 2);'))).toHaveLength(2);
  });
});

describe('walkDescendants', () => {
  it('collects every node satisfying the predicate', () => {
    const root = parse('function a() { b(); }')!;
    expect(walkDescendants(root, (n) => n.kind() === 'call_expression').length).toBeGreaterThan(0);
  });

  it('returns an empty array when nothing matches', () => {
    expect(walkDescendants(parse('const x = 1;')!, () => false)).toEqual([]);
  });
});
