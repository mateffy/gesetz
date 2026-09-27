import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
const CORE_DIST = nodePath.join(REPO_ROOT, 'packages/core/dist/index.js');

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly coordination?: { mode: string; waitedMs: number; recheckedFiles: number };
}

/**
 * Runs the real CLI. `spawn` rather than `spawnSync`, because these two runs must
 * be alive at the same time — that is the whole point of the test.
 */
const runCli = (cwd: string, extraArgs: readonly string[] = []): Promise<CliRun> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_MAIN, 'check', '--format=json', ...extraArgs], {
      cwd,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split(String.fromCharCode(10)).at(-1) ?? '{}';
      let coordination: CliRun['coordination'];
      try {
        coordination = (JSON.parse(line) as { coordination?: CliRun['coordination'] }).coordination;
      } catch {
        coordination = undefined;
      }
      resolve({ stdout, stderr, ...(coordination === undefined ? {} : { coordination }) });
    });
  });

/**
 * A project whose single rule takes long enough for a second process to arrive
 * while the first is still working. The sleep is the fixture, not a rule.
 */
const writeProject = async (dir: string, sleepMs: number): Promise<void> => {
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(
    nodePath.join(dir, 'gesetz.config.ts'),
    [
      `import { defineConfig, select } from ${JSON.stringify(CORE_DIST)};`,
      'const slow = async (file) => {',
      `  await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));`,
      "  return file.content.includes('BAD')",
      "    ? [{ rule: 'slow', message: 'bad', path: file.path, severity: 'error', source: 'core' }]",
      '    : [];',
      '};',
      'export default defineConfig({',
      `  projectRoot: ${JSON.stringify(dir)},`,
      "  rules: [select('src/**/*.ts').label('Slow').category('cleanup').check(slow)],",
      '});',
      '',
    ].join('\n'),
  );
};

const scanLines = (run: CliRun): string[] =>
  run.stderr.split(String.fromCharCode(10)).filter((line) => line.startsWith('scan: '));

describe('two concurrent checks in one worktree', () => {
  it('performs the work once and hands the second caller the same result', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-cli-'));
    try {
      await writeProject(dir, 4000);

      const first = runCli(dir);
      // Let the first process claim the slot before the second starts, so this
      // measures coordination rather than startup order.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = runCli(dir);
      const outcomes = await Promise.all([first, second]);

      const modes = outcomes.map((outcome) => outcome.coordination?.mode);
      // A missing mode means the envelope was not on stdout at all, so the failure
      // should say what was there: these two processes run under load, where a
      // bare `undefined` tells you nothing.
      const transcript = outcomes.map((outcome) => `[${outcome.stdout.slice(0, 400)}]`).join(' | ');
      expect(modes, transcript).toContain('ran');
      expect(modes.filter((mode) => mode === 'ran')).toHaveLength(1);
      expect(modes.filter((mode) => mode === 'reused' || mode === 'ran-after-wait')).toHaveLength(
        1,
      );

      // The reused caller did no scan of its own: one run, not two.
      const scans = outcomes.map(scanLines);
      expect(scans.filter((lines) => lines.length > 0)).toHaveLength(1);

      // Both callers get the same answer, whatever else the coordination block
      // says about how each of them obtained it.
      const report = (run: CliRun): { total: number; violations: unknown } => {
        const parsed = JSON.parse(
          run.stdout.trim().split(String.fromCharCode(10)).at(-1) ?? '{}',
        ) as { total: number; violations: unknown };
        return { total: parsed.total, violations: parsed.violations };
      };
      expect(report(outcomes[1]!)).toEqual(report(outcomes[0]!));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('runs both, and shares nothing, when --standalone is passed', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-cli-'));
    try {
      await writeProject(dir, 200);

      const first = runCli(dir, ['--standalone']);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = runCli(dir, ['--standalone']);
      const outcomes = await Promise.all([first, second]);

      expect(
        outcomes.map((outcome) => outcome.coordination?.mode),
        outcomes.map((outcome) => `[${outcome.stdout.slice(0, 400)}]`).join(' | '),
      ).toEqual(['standalone', 'standalone']);
      // Standalone means standalone: each process did its own scan.
      expect(outcomes.map((outcome) => scanLines(outcome).length)).toEqual([1, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('tells the caller that a reused run covered a shared worktree', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-cli-'));
    try {
      await writeProject(dir, 200);
      await runCli(dir);
      const second = await runCli(dir);
      expect(second.coordination?.mode).toBe('reused');
      expect(second.stderr).toContain('coord: reused a run from');
      expect(second.stderr).toContain('this worktree is shared');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
