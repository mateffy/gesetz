import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNetwork, type Network } from 'netzwerk';
import { createCheckServices } from '../../src/backend/check-services';
import { syntaxExtension } from '../../src/backend/syntax-extension';
import type { SyntaxBackend } from '../../src/services/syntax-tree';

let dir: string;
const networks: Network[] = [];

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-check-services-'));
});

afterEach(async () => {
  for (const network of networks.splice(0)) await network.close();
  await rm(dir, { recursive: true, force: true });
});

function track(network: Network): Network {
  networks.push(network);
  return network;
}

async function write(relative: string, content: string): Promise<void> {
  const absolute = nodePath.join(dir, relative);
  await mkdir(nodePath.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

const tsBackend: SyntaxBackend = {
  extensions: ['.ts'],
  extractImports: (content) =>
    content.includes('from')
      ? [{ specifier: './b', names: ['b'], line: 1 }]
      : [],
  extractCalls: (content) =>
    content.includes('console.log') ? [{ name: 'console.log', line: 2 }] : [],
  extractExports: () => [{ name: 'a', kind: 'const', line: 3 }],
  extractStructure: () => [
    { kind: 'const', name: 'a', startLine: 3, endLine: 3, docstring: null, children: [] },
  ],
};

async function setup(): Promise<Awaited<ReturnType<typeof createCheckServices>>> {
  await write('src/a.ts', 'import { b } from "./b";\nconsole.log(b);\nexport const a = 1;\n');
  await write('src/b.ts', 'export const b = 2;\n');
  await write('README.md', '# readme\n');
  const network = track(
    createNetwork({ rootPath: dir, extensions: [syntaxExtension([tsBackend])] }),
  );
  await network.scan();
  return createCheckServices(network, [tsBackend], dir);
}

describe('createCheckServices.fs', () => {
  it('globs over scanned files and returns gesetz File objects', async () => {
    const services = await setup();
    const files = await services.fs.glob('src/**/*.ts');
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const a = files[0]!;
    expect(a.name).toBe('a.ts');
    expect(a.stem).toBe('a');
    expect(a.ext).toBe('.ts');
    expect(a.dir).toBe('src');
    expect(a.absolutePath).toBe(nodePath.join(dir, 'src/a.ts'));
    expect(a.content).toContain('console.log');
  });

  it('supports multiple patterns and dedupes', async () => {
    const services = await setup();
    const files = await services.fs.glob(['src/**/*.ts', 'src/a.ts', '*.md']);
    expect(files.map((f) => f.path)).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('reads files through the network and from disk as fallback', async () => {
    const services = await setup();
    const scanned = await services.fs.readFile(nodePath.join(dir, 'src/b.ts'));
    expect(scanned).toBe('export const b = 2;\n');
    await write('untracked.txt', 'late\n');
    const fromDisk = await services.fs.readFile(nodePath.join(dir, 'untracked.txt'));
    expect(fromDisk).toBe('late\n');
  });

  it('reports existence for scanned and unscanned disk files', async () => {
    const services = await setup();
    expect(await services.fs.exists(nodePath.join(dir, 'src/a.ts'))).toBe(true);
    await write('new.ts', 'x');
    expect(await services.fs.exists(nodePath.join(dir, 'new.ts'))).toBe(true);
    expect(await services.fs.exists(nodePath.join(dir, 'nope.ts'))).toBe(false);
  });
});

describe('createCheckServices.syntax', () => {
  it('serves imports, calls, exports, structure from markers — never parses', async () => {
    const services = await setup();
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.syntax.canProcess(file!)).toBe(true);

    const result = await services.syntax.process(file!, {
      imports: true,
      calls: true,
      exports: true,
      structure: true,
    });
    expect(result.imports).toEqual([{ specifier: './b', names: ['b'], line: 1 }]);
    expect(result.calls).toEqual([{ name: 'console.log', line: 2 }]);
    expect(result.exports).toEqual([{ name: 'a', kind: 'const', line: 3 }]);
    expect(result.structure).toEqual([
      { kind: 'const', name: 'a', startLine: 3, endLine: 3, docstring: null, children: [] },
    ]);
  });

  it('respects option flags and returns empty arrays for unrequested facets', async () => {
    const services = await setup();
    const [file] = await services.fs.glob('src/a.ts');
    const result = await services.syntax.process(file!, { imports: true });
    expect(result.imports).toHaveLength(1);
    expect(result.calls).toEqual([]);
    expect(result.exports).toEqual([]);
    expect(result.structure).toEqual([]);
  });

  it('fails for files without a registered backend', async () => {
    const services = await setup();
    const [file] = await services.fs.glob('README.md');
    expect(services.syntax.canProcess(file!)).toBe(false);
    await expect(services.syntax.process(file!, { imports: true })).rejects.toThrow();
  });
});

describe('createCheckServices.imports', () => {
  it('resolves relative specifiers to absolute paths of scanned files', async () => {
    const services = await setup();
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.imports.resolve(file!, './b')).toBe(nodePath.join(dir, 'src/b.ts'));
  });

  it('returns null for external packages and unresolvable specifiers', async () => {
    const services = await setup();
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.imports.resolve(file!, 'react')).toBeNull();
    expect(services.imports.resolve(file!, './missing')).toBeNull();
  });
});
