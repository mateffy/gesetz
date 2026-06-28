import { describe, it, expect } from 'vitest';
import { typescriptSyntaxBackend } from '../src/syntax-backend';

const TS = `import { useState, useEffect } from 'react';
import foo from './foo';
import type { Foo } from './types';
import { bar } from '@/lib/bar';

export const counter = 1;
export function useThing() {
  console.log('x');
  fetch('y');
  return 1;
}
export default function def() {}

class UserService {
  getUser(): string { return 'x'; }
  private helper(): void {}
}

function nonExported(): number { return 2; }

/** Doc for named */
export function named(): void {}`;

describe('typescriptSyntaxBackend', () => {
  describe('extensions', () => {
    it('handles .ts, .tsx, .js, .jsx, .mjs, .cjs', () => {
      expect(typescriptSyntaxBackend.extensions).toEqual([
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      ]);
    });
  });

  describe('extractImports', () => {
    it('returns clean module specifiers with named imports', () => {
      const imports = typescriptSyntaxBackend.extractImports(TS, 'test.ts');
      const specifiers = imports.map((i) => i.specifier);
      expect(specifiers).toEqual(['react', './foo', './types', '@/lib/bar']);
    });

    it('captures named import names', () => {
      const imports = typescriptSyntaxBackend.extractImports(TS, 'test.ts');
      const react = imports.find((i) => i.specifier === 'react');
      expect(react?.names).toEqual(['useState', 'useEffect']);
    });

    it('reports 1-indexed line numbers', () => {
      const imports = typescriptSyntaxBackend.extractImports(TS, 'test.ts');
      expect(imports[0]?.line).toBe(1);
      expect(imports[1]?.line).toBe(2);
    });

    it('returns [] for unparseable input', () => {
      const imports = typescriptSyntaxBackend.extractImports('@@@ not valid js @@@', 'bad.ts');
      expect(imports).toEqual([]);
    });

    it('handles default imports (no names)', () => {
      const imports = typescriptSyntaxBackend.extractImports(
        `import foo from './foo';`,
        'test.ts',
      );
      expect(imports[0]?.specifier).toBe('./foo');
      expect(imports[0]?.names).toEqual([]);
    });
  });

  describe('extractExports', () => {
    it('returns exported identifier names, excluding default', () => {
      const exports = typescriptSyntaxBackend.extractExports(TS, 'test.ts');
      const names = exports.map((e) => e.name);
      expect(names).toContain('counter');
      expect(names).toContain('useThing');
      expect(names).toContain('named');
      // default export has no name — must be excluded
      expect(names).not.toContain('default');
      expect(names.every((n) => n !== '')).toBe(true);
    });
  });

  describe('extractCalls', () => {
    it('returns call names including member access', () => {
      const calls = typescriptSyntaxBackend.extractCalls(TS, 'test.ts');
      const names = calls.map((c) => c.name);
      expect(names).toContain('console.log');
      expect(names).toContain('fetch');
    });

    it('reports 1-indexed line numbers', () => {
      const calls = typescriptSyntaxBackend.extractCalls(TS, 'test.ts');
      const consoleLog = calls.find((c) => c.name === 'console.log');
      expect(consoleLog?.line).toBe(8);
    });

    it('uses the correct parser for .tsx', () => {
      const tsx = `const x = <Comp onClick={() => handleClick()}>hi</Comp>;`;
      const calls = typescriptSyntaxBackend.extractCalls(tsx, 'test.tsx');
      expect(calls.map((c) => c.name)).toContain('handleClick');
    });
  });

  describe('extractStructure', () => {
    it('finds function and class declarations', () => {
      const items = typescriptSyntaxBackend.extractStructure(TS, 'test.ts', false);
      const kinds = items.map((i) => i.kind);
      expect(kinds).toContain('function');
      expect(kinds).toContain('class');
      const fnNames = items.filter((i) => i.kind === 'function').map((i) => i.name);
      expect(fnNames).toContain('useThing');
      expect(fnNames).toContain('nonExported');
    });

    it('attaches methods as children of classes', () => {
      const items = typescriptSyntaxBackend.extractStructure(TS, 'test.ts', false);
      const cls = items.find((i) => i.kind === 'class');
      expect(cls?.name).toBe('UserService');
      const methodNames = cls?.children.map((c) => c.name);
      expect(methodNames).toContain('getUser');
      expect(methodNames).toContain('helper');
    });

    it('reports 1-indexed start lines', () => {
      const items = typescriptSyntaxBackend.extractStructure(TS, 'test.ts', false);
      const cls = items.find((i) => i.kind === 'class');
      expect(cls?.startLine).toBe(14); // `class UserService {`
    });

    it('extracts docstrings when includeDocstrings is true', () => {
      const items = typescriptSyntaxBackend.extractStructure(TS, 'test.ts', true);
      const named = items.find((i) => i.kind === 'function' && i.name === 'named');
      expect(named?.docstring).toContain('Doc for named');
    });

    it('returns null docstrings when includeDocstrings is false', () => {
      const items = typescriptSyntaxBackend.extractStructure(TS, 'test.ts', false);
      const named = items.find((i) => i.kind === 'function' && i.name === 'named');
      expect(named?.docstring).toBeNull();
    });

    it('returns [] for unparseable input', () => {
      const items = typescriptSyntaxBackend.extractStructure('@@@ bad', 'bad.ts', false);
      expect(items).toEqual([]);
    });
  });
});
