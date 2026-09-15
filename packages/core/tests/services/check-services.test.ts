import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckServices } from '../../src/services/check-services';
import type { SyntaxBackend } from '../../src/services/syntax-tree';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-check-services-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'import x from "./x";\nexport const a = 1;\n', 'utf8');
  await writeFile(nodePath.join(dir, 'src/b.ts'), 'export const b = 2;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createCheckServices', () => {
  it('globs the file listing and reads content lazily', async () => {
    const services = createCheckServices({ rootDir: dir, backends: [], allPaths: ['src/a.ts', 'src/b.ts'] });
    const files = await services.fs.glob('src/**/*.ts');
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0]?.content).toContain('export const a');
    expect(files[0]?.size).toBeGreaterThan(0);
  });

  it('reads and checks existence on disk', async () => {
    const services = createCheckServices({ rootDir: dir, backends: [], allPaths: ['src/a.ts'] });
    expect(await services.fs.readFile(nodePath.join(dir, 'src/a.ts'))).toContain('export const a');
    expect(await services.fs.exists(nodePath.join(dir, 'src/a.ts'))).toBe(true);
    expect(await services.fs.exists(nodePath.join(dir, 'nope.ts'))).toBe(false);
  });

  it('resolves relative imports and rejects external specifiers', async () => {
    const services = createCheckServices({ rootDir: dir, backends: [], allPaths: ['src/a.ts'] });
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.imports.resolve(file!, './b')).toBe(nodePath.join(dir, 'src/b'));
    expect(services.imports.resolve(file!, 'react')).toBeNull();
  });

  it('extracts syntax on demand and memoizes per file and kind', async () => {
    let importCalls = 0;
    let structureCalls = 0;
    const backend: SyntaxBackend = {
      extensions: ['.ts'],
      extractImports: () => {
        importCalls += 1;
        return [{ specifier: './x', names: [], line: 1 }];
      },
      extractCalls: () => [{ name: 'foo', line: 2 }],
      extractExports: () => [{ name: 'a', kind: 'const', line: 2 }],
      extractStructure: () => {
        structureCalls += 1;
        return [];
      },
    };
    const services = createCheckServices({
      rootDir: dir,
      backends: [backend],
      allPaths: ['src/a.ts'],
    });
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.syntax.canProcess(file!)).toBe(true);

    const first = await services.syntax.process(file!, { imports: true });
    expect(first.imports).toEqual([{ specifier: './x', names: [], line: 1 }]);
    await services.syntax.process(file!, { imports: true });
    expect(importCalls).toBe(1);

    // A different kind triggers its own extraction, and only that kind.
    expect(structureCalls).toBe(0);
    await services.syntax.process(file!, { structure: true });
    expect(structureCalls).toBe(1);
    expect(importCalls).toBe(1);
  });

  it('returns an empty result when no backend claims the extension', async () => {
    const services = createCheckServices({ rootDir: dir, backends: [], allPaths: ['src/a.ts'] });
    const [file] = await services.fs.glob('src/a.ts');
    expect(services.syntax.canProcess(file!)).toBe(false);
    await expect(services.syntax.process(file!, { imports: true })).rejects.toThrow(
      /No SyntaxBackend/,
    );
  });
});
