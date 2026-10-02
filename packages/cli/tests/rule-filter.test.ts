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
 * A project with two rules that both report, and both record that they ran.
 *
 * `--rule` is a scope, not a report filter: the rule it excludes must not run at
 * all. Filtering violations out of the report would look identical in the output
 * and would save nothing, so the side effect is the only honest evidence.
 */
const writeProject = async (dir: string): Promise<void> => {
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(
    nodePath.join(dir, 'gesetz.config.ts'),
    [
      `import { defineConfig, select } from ${JSON.stringify(CORE_DIST)};`,
      "import * as fs from 'node:fs';",
      'const produces = (label) => async (file) => {',
      "  fs.appendFileSync('ran.log', label + String.fromCharCode(10));",
      '  return [{ severity: "error", source: "core", message: label + " finding",',
      '            path: file.path }];',
      '};',
      'export default defineConfig({',
      `  projectRoot: ${JSON.stringify(dir)},`,
      '  rules: [',
      "    select('src/**/*.ts').label('Rule one').category('cleanup').check(produces('one')),",
      "    select('src/**/*.ts').label('Rule two').category('cleanup').check(produces('two')),",
      '  ],',
      '});',
      '',
    ].join('\n'),
  );
};

const run = (cwd: string, args: readonly string[]) =>
  spawnSync(process.execPath, [DIST_MAIN, 'check', ...args], { cwd, encoding: 'utf8' });

const ranLines = async (dir: string): Promise<string[]> => {
  try {
    return (await readFile(nodePath.join(dir, 'ran.log'), 'utf8'))
      .split(String.fromCharCode(10))
      .filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
};

describe('--rule selects rules, and the ones it excludes do not run', () => {
  it('runs only the named rule', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-rule-filter-'));
    try {
      await writeProject(dir);
      const result = run(dir, ['--rule', 'rule-one', '--format=json', '--all']);

      const envelope = JSON.parse(result.stdout) as {
        total: number;
        violations: { rule: string }[];
      };
      expect(envelope.total).toBe(1);
      expect(envelope.violations.map((v) => v.rule)).toEqual(['rule-one']);

      const lines = await ranLines(dir);
      expect(lines).toContain('one');
      expect(lines).not.toContain('two');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs everything when no filter is given', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) return;
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-rule-filter-'));
    try {
      await writeProject(dir);
      const result = run(dir, ['--format=json', '--all']);
      const envelope = JSON.parse(result.stdout) as { total: number };
      expect(envelope.total).toBe(2);
      expect((await ranLines(dir)).sort()).toEqual(['one', 'two']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a filter matching no rule, and says which rules exist', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) return;
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-rule-filter-'));
    try {
      await writeProject(dir);
      const result = run(dir, ['--rule', 'typo', '--format=json']);

      // A run that checked nothing must not look like a clean run.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no rule matches 'typo'");
      expect(result.stderr).toContain('rule-one');
      expect(result.stderr).toContain('rule-two');
      expect(result.stdout.trim()).toBe('');
      expect(await ranLines(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a glob, so a family is one flag', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) return;
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-rule-filter-'));
    try {
      await writeProject(dir);
      const result = run(dir, ['--rule', 'rule-*', '--format=json', '--all']);
      const envelope = JSON.parse(result.stdout) as { total: number };
      expect(envelope.total).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
