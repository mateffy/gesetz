import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
const CORE_DIST = nodePath.join(REPO_ROOT, 'packages/core/dist/index.js');

/**
 * A project whose rules record that they ran.
 *
 * The only way to observe work reduction from outside the process is a side
 * effect: a rule that cannot match the request must not run at all, not merely
 * have its violations filtered out of the report.
 */
const writeProject = async (dir: string): Promise<void> => {
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await mkdir(nodePath.join(dir, 'app'), { recursive: true });
  await mkdir(nodePath.join(dir, '.gesetz'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(nodePath.join(dir, 'src/b.ts'), 'export const b = 2;\n');
  await writeFile(nodePath.join(dir, 'app/Model.php'), '<?php\n');
  await writeFile(
    nodePath.join(dir, 'gesetz.config.ts'),
    [
      `import { defineConfig, select } from ${JSON.stringify(CORE_DIST)};`,
      "import * as fs from 'node:fs';",
      'const recorder = (label) => async (file) => {',
      "  fs.appendFileSync('ran.log', label + ' ' + file.path + String.fromCharCode(10));",
      '  return [];',
      '};',
      'export default defineConfig({',
      `  projectRoot: ${JSON.stringify(dir)},`,
      '  rules: [',
      "    select('src/**/*.ts').label('TS rule').category('cleanup').check(recorder('ts')),",
      "    select('app/**/*.php').label('PHP rule').category('cleanup').check(recorder('php')),",
      '  ],',
      '});',
      '',
    ].join('\n'),
  );
};

const runCheck = (cwd: string, args: readonly string[]): void => {
  spawnSync(process.execPath, [DIST_MAIN, 'check', ...args], { cwd, encoding: 'utf8' });
};

const ranLines = async (dir: string): Promise<string[]> => {
  try {
    return (await readFile(nodePath.join(dir, 'ran.log'), 'utf8'))
      .split(String.fromCharCode(10))
      .filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
};

describe('--files narrows the work, observed from outside the process', () => {
  it('does not run a rule that cannot match the request', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-scope-cli-'));
    try {
      await writeProject(dir);
      runCheck(dir, ['--files', 'src/**/*.ts', '--format=json']);

      const lines = await ranLines(dir);
      expect(lines.some((line) => line.startsWith('ts '))).toBe(true);
      // The PHP rule has nothing to say about src/, so it never ran: no
      // invocation, not an invocation whose result was discarded.
      expect(lines.some((line) => line.startsWith('php '))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('takes both spellings of the request, and they mean the same thing', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-scope-cli-'));
    try {
      await writeProject(dir);
      // --full for both runs: otherwise the second finds the marks current and
      // does no work at all, which is correct and proves nothing about spelling.
      runCheck(dir, ['--files', 'src/a.ts,src/b.ts', '--format=json', '--full']);
      const comma = (await ranLines(dir)).filter((line) => line.startsWith('ts ')).sort();

      await rm(nodePath.join(dir, 'ran.log'), { force: true });
      runCheck(dir, ['--files', 'src/a.ts', '--files', 'src/b.ts', '--format=json', '--full']);
      const repeated = (await ranLines(dir)).filter((line) => line.startsWith('ts ')).sort();

      expect(repeated).toEqual(comma);
      expect(comma).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
