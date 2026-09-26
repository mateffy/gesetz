import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { runAll } from '../../src/engine/runner';
import { defineConfig } from '../../src/engine/config';
import { noCycles } from '../../src/primitives/graph';
import { typescriptSyntaxBackend } from '@gesetz/typescript';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-graph-'));
  await mkdir(nodePath.join(dir, 'src/a'), { recursive: true });
  await mkdir(nodePath.join(dir, 'src/b'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, content: string) => {
  const abs = nodePath.join(dir, rel);
  await mkdir(nodePath.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

/** Runs through the real pipeline: syntax backend, netzwerk edges, project rule. */
const scan = async (rules: ReturnType<typeof noCycles>[]) => {
  const config = defineConfig({ projectRoot: dir, adapters: [typescriptSyntaxBackend], rules });
  const result = await Effect.runPromise(runAll(config));
  return result.byRule.find((r) => r.ruleId === rules[0]!.id)?.violations ?? [];
};

describe('noCycles', () => {
  it('is a project rule over the patterns it was given', () => {
    expect(noCycles('src/**/*.ts').project?.patterns).toEqual(['src/**/*.ts']);
  });

  it('accepts a list of patterns', () => {
    expect(noCycles(['a/**', 'b/**']).project?.patterns).toEqual(['a/**', 'b/**']);
  });

  it('reports a cycle between two files', async () => {
    await write(
      'src/a/one.ts',
      'import "../b/two";' + String.fromCharCode(10) + 'export const one = 1;',
    );
    await write(
      'src/b/two.ts',
      'import "../a/one";' + String.fromCharCode(10) + 'export const two = 2;',
    );
    const v = await scan([noCycles('src/**/*.ts')]);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('Circular dependency');
  });

  it('accepts an acyclic graph', async () => {
    await write(
      'src/a/one.ts',
      'import "../b/two";' + String.fromCharCode(10) + 'export const one = 1;',
    );
    await write('src/b/two.ts', 'export const two = 2;');
    expect(await scan([noCycles('src/**/*.ts')])).toHaveLength(0);
  });

  it('accepts a file with no imports', async () => {
    await write('src/a/one.ts', 'export const one = 1;');
    expect(await scan([noCycles('src/**/*.ts')])).toHaveLength(0);
  });

  it('honours a custom id, which the violation carries', async () => {
    await write(
      'src/a/one.ts',
      'import "../b/two";' + String.fromCharCode(10) + 'export const one = 1;',
    );
    await write(
      'src/b/two.ts',
      'import "../a/one";' + String.fromCharCode(10) + 'export const two = 2;',
    );
    const rule = noCycles('src/**/*.ts', { id: 'custom-cycles' });
    const config = defineConfig({
      projectRoot: dir,
      adapters: [typescriptSyntaxBackend],
      rules: [rule],
    });
    const result = await Effect.runPromise(runAll(config));
    const v = result.byRule.find((r) => r.ruleId === 'custom-cycles')?.violations ?? [];
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it('honours a custom label', () => {
    expect(noCycles('src/**', { label: 'No loops' }).description).toBe('No loops');
  });
});
