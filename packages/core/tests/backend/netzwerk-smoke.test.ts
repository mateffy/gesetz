import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineNetwork } from 'netzwerk';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-netzwerk-smoke-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('netzwerk smoke (memory + sqlite storage)', () => {
  it('scans with memory storage', async () => {
    await writeFile(nodePath.join(dir, 'a.ts'), 'export const a = 1;\n');
    const network = defineNetwork({ rootPath: dir, extensions: [] });
    const result = await network.scan();
    expect(result.filesSeen).toBe(1);
    await network.close();
  });

  it('scans with sqlite storage and persists markers', async () => {
    await mkdir(nodePath.join(dir, 'src'), { recursive: true });
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    const dbPath = nodePath.join(dir, 'cache.db');
    const network = defineNetwork({
      rootPath: dir,
      extensions: [],
      storage: { kind: 'sqlite', path: dbPath },
    });
    await network.scan();
    await network.createMarker('src/a.ts', {
      type: 'gesetz.violation',
      data: { rule: 'r1', message: 'm', severity: 'error', source: 'core' },
    });
    await network.close();

    const reopened = defineNetwork({
      rootPath: dir,
      extensions: [],
      storage: { kind: 'sqlite', path: dbPath },
    });
    const file = await reopened.file('src/a.ts');
    expect(file?.hasMarker('gesetz.violation')).toBe(true);
    await reopened.close();
  });
});
