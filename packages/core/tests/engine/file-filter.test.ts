import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { runAll } from '../../src/engine/runner';
import { defineConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-file-scope-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A project's rule set narrowed by `--files`.
 *
 * `--files` is an aggregation-time filter today: every rule still runs, and every
 * file is still scanned. These tests pin what the filter does, so that narrowing
 * it further to "skip rules that cannot match" is a visible change rather than a
 * silent one.
 */
describe('--files', () => {
  it('suppresses violations for files outside the filter', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(nodePath.join(root, 'src'), { recursive: true });
    await writeFile(nodePath.join(root, 'src/inside.ts'), 'export const a = "BAD";\n');
    await writeFile(nodePath.join(root, 'src/outside.ts'), 'export const b = "BAD";\n');

    const flagBad = async (file: {
      content: string;
      path: string;
    }): Promise<
      { rule: string; message: string; path: string; severity: 'error'; source: 'core' }[]
    > =>
      file.content.includes('BAD')
        ? [
            {
              rule: 'flag-bad',
              message: 'bad',
              path: file.path,
              severity: 'error' as const,
              source: 'core' as const,
            },
          ]
        : [];

    const config = defineConfig({
      projectRoot: root,
      adapters: [],
      rules: [
        select('src/**/*.ts')
          .exclude('**/*.test.ts')
          .label('Flag bad')
          .category('cleanup')
          .check(flagBad),
      ],
    });

    const everything = await Effect.runPromise(runAll(config));
    expect(everything.byRule[0]?.violations.map((v) => v.path).sort()).toEqual([
      'src/inside.ts',
      'src/outside.ts',
    ]);

    const filtered = await Effect.runPromise(runAll(config, { fileFilter: ['src/inside.ts'] }));
    expect(filtered.byRule[0]?.violations.map((v) => v.path)).toEqual(['src/inside.ts']);
  });

  it('does not change what the scan re-checks, which is the point of the next step', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(nodePath.join(root, 'src'), { recursive: true });
    await writeFile(nodePath.join(root, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(nodePath.join(root, 'src/b.ts'), 'export const b = 2;\n');

    const seen: number[] = [];
    const config = defineConfig({
      projectRoot: root,
      adapters: [],
      rules: [
        select('src/**/*.ts')
          .label('Count')
          .category('cleanup')
          .check(async () => []),
      ],
    });

    await Effect.runPromise(
      runAll(config, {
        fileFilter: ['src/a.ts'],
        onScan: (scan) => seen.push(scan.added + scan.changed),
      }),
    );
    // Two files were reprocessed even though one was asked for: `--files` filters
    // the report, not the work.
    expect(seen).toEqual([2]);
  });
});
