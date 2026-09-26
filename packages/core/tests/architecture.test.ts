import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { runAll } from '../src/engine/runner';
import { defineConfig } from '../src/engine/config';
import { defineArchitecture } from '../src/architecture';
import { typescriptSyntaxBackend } from '@gesetz/typescript';

const NL = String.fromCharCode(10);

const config = {
  layers: [
    { name: 'core', pattern: 'src/core/**', canImportFrom: [] as string[] },
    { name: 'ui', pattern: 'src/ui/**', canImportFrom: ['core'] },
  ],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-arch-'));
  await mkdir(nodePath.join(dir, 'src/core'), { recursive: true });
  await mkdir(nodePath.join(dir, 'src/ui'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, content: string) => {
  const abs = nodePath.join(dir, rel);
  await mkdir(nodePath.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

const scan = async (rules: ReturnType<typeof defineArchitecture>) => {
  const cfg = defineConfig({ projectRoot: dir, adapters: [typescriptSyntaxBackend], rules });
  const result = await Effect.runPromise(runAll(cfg));
  return result.byRule.flatMap((r) => r.violations.map((v) => v.message));
};

describe('defineArchitecture', () => {
  it('returns project rules', () => {
    const rules = defineArchitecture(config);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.project !== undefined)).toBe(true);
  });

  it('gives every rule a unique kebab-case id', () => {
    const ids = defineArchitecture(config).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('accepts a layer with no canImportFrom, meaning unconstrained', () => {
    expect(
      defineArchitecture({ layers: [{ name: 'a', pattern: 'src/**' }] }).length,
    ).toBeGreaterThan(0);
  });

  it('produces the same rules for the same config', () => {
    expect(defineArchitecture(config).map((r) => r.id)).toEqual(
      defineArchitecture(config).map((r) => r.id),
    );
  });

  it('accepts an empty layer list without throwing', () => {
    expect(() => defineArchitecture({ layers: [] })).not.toThrow();
  });

  it('reports an import that a layer forbids', async () => {
    // `core` may import from nothing, so reaching into `ui` is a violation.
    await write('src/core/a.ts', 'import "../ui/b";' + NL + 'export const a = 1;');
    await write('src/ui/b.ts', 'export const b = 2;');
    const messages = await scan(defineArchitecture(config));
    expect(messages.some((m) => m.includes('core') && m.includes('ui'))).toBe(true);
  });

  it('accepts an import a layer allows', async () => {
    // `ui` may import from `core`.
    await write('src/ui/a.ts', 'import "../core/b";' + NL + 'export const a = 1;');
    await write('src/core/b.ts', 'export const b = 2;');
    expect(await scan(defineArchitecture(config))).toHaveLength(0);
  });

  it('accepts a file that imports nothing', async () => {
    await write('src/core/a.ts', 'export const a = 1;');
    expect(await scan(defineArchitecture(config))).toHaveLength(0);
  });

  it('reports nothing for a file outside every layer', async () => {
    await write('src/other/a.ts', 'import "../ui/b";' + NL + 'export const a = 1;');
    await write('src/ui/b.ts', 'export const b = 2;');
    expect(await scan(defineArchitecture(config))).toHaveLength(0);
  });
});
