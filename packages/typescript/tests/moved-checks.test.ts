import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import {
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  relativeImports,
} from '../src';
import type { File, CheckServices } from '@gesetz/core';

function makeFile(content: string, path = 'src/foo.ts', name = 'foo.ts'): File {
  const ext = nodePath.extname(name);
  return {
    path,
    absolutePath: nodePath.resolve(process.cwd(), path),
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext,
    dir: nodePath.dirname(path),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Stub services for pure sync checks. */
const noServices = {} as any;

describe('noConsoleLog (moved from core)', () => {
  it('flags console.log', async () => {
    const v = await noConsoleLog()(makeFile('console.log("hello");'), noServices);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-console-log');
  });

  it('flags warn and error by default', async () => {
    const v = await noConsoleLog()(makeFile('console.warn("w");\nconsole.error("e");'), noServices);
    expect(v).toHaveLength(2);
  });

  it('allows warn and error when allowWarnError is true', async () => {
    const v = await noConsoleLog({ allowWarnError: true })(makeFile('console.warn("w");\nconsole.error("e");'), noServices);
    expect(v).toHaveLength(0);
  });
});

describe('noEmptyCatch (moved from core)', () => {
  it('flags empty catch block', async () => {
    const v = await noEmptyCatch()(makeFile('try { x(); } catch { \n }'), noServices);
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-empty-catch');
  });

  it('passes when catch has a body', async () => {
    const v = await noEmptyCatch()(makeFile('try {\n  x();\n} catch (e) {\n  log(e);\n}'), noServices);
    expect(v).toHaveLength(0);
  });
});

describe('noMagicNumbers (moved from core)', () => {
  it('flags unexplained numeric literals', async () => {
    const v = await noMagicNumbers()(makeFile('const r = value * 42;'), noServices);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('42');
  });

  it('ignores named constants and the default ignore list', async () => {
    const v = await noMagicNumbers()(makeFile('const MAX_RETRIES = 3;\nreturn x === 0 || x === 1;'), noServices);
    expect(v).toHaveLength(0);
  });
});

describe('noTrivialComment (moved from core)', () => {
  it('flags narrative comments', async () => {
    const v = await noTrivialComment()(makeFile('// Import the module\n// Define the component'), noServices);
    expect(v).toHaveLength(2);
    expect(v[0]?.rule).toBe('no-trivial-comment');
  });

  it('ignores meaningful comments', async () => {
    const v = await noTrivialComment()(makeFile('// This explains why we retry on ECONNRESET'), noServices);
    expect(v).toHaveLength(0);
  });
});

/** Simple local mock for the fs.exists call that relativeImports needs. */
function makeFs(existsSet: Set<string>): CheckServices['fs'] {
  return {
    glob: async () => [],
    readFile: async () => '',
    exists: async (path) => existsSet.has(path),
  };
}

const makeServices = (existsSet: Set<string>): CheckServices => ({
  fs: makeFs(existsSet),
  syntaxTree: { canProcess: () => false, process: async () => ({ imports: [], calls: [], exports: [], structure: [] }) },
  importResolver: { resolve: () => null },
  projectRoot: process.cwd(),
});

describe('relativeImports (moved from core)', () => {
  const CWD = process.cwd();

  it('passes when all relative imports resolve', async () => {
    const file = makeFile(
      `import { x } from './bar';\nimport { y } from './baz/index';`,
      'src/foo.ts',
    );
    const barAbs = nodePath.resolve(CWD, 'src/bar.ts');
    const bazIndex = nodePath.resolve(CWD, 'src/baz/index.ts');
    const services = makeServices(new Set([barAbs, bazIndex]));
    const v = await relativeImports()(file, services);
    expect(v).toHaveLength(0);
  });

  it('fails when a relative import does not resolve', async () => {
    const file = makeFile(`import { x } from './missing';`, 'src/foo.ts');
    const services = makeServices(new Set());
    const v = await relativeImports()(file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('./missing');
  });

  it('ignores non-relative imports', async () => {
    const file = makeFile(`import React from 'react';\nimport { z } from 'zod';`, 'src/foo.ts');
    const services = makeServices(new Set());
    const v = await relativeImports()(file, services);
    expect(v).toHaveLength(0);
  });

  it('resolves .tsx extensions', async () => {
    const file = makeFile(`import { Comp } from './Comp';`, 'src/foo.ts');
    const compTsx = nodePath.resolve(CWD, 'src/Comp.tsx');
    const services = makeServices(new Set([compTsx]));
    const v = await relativeImports()(file, services);
    expect(v).toHaveLength(0);
  });
});
