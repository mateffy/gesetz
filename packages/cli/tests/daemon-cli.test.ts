import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
const CORE_DIST = nodePath.join(REPO_ROOT, 'packages/core/dist/index.js');

const built = (): boolean => nodeFs.existsSync(DIST_MAIN) && nodeFs.existsSync(CORE_DIST);

/** A project that opts into a daemon and has exactly one violation to find. */
const writeProject = async (dir: string): Promise<void> => {
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\nconsole.log(a);\n');
  await writeFile(
    nodePath.join(dir, 'gesetz.config.ts'),
    [
      `import { defineConfig, select } from ${JSON.stringify(CORE_DIST)};`,
      'export default defineConfig({',
      `  projectRoot: ${JSON.stringify(dir)},`,
      '  daemon: true,',
      '  rules: [',
      "    select('src/**/*.ts').label('No console calls').category('cleanup').check(async (file) =>",
      "      file.content.includes('console.log')",
      "        ? [{ severity: 'error', source: 'core', message: 'no console.log', path: file.path, line: 2 }]",
      '        : []),',
      '  ],',
      '});',
      '',
    ].join('\n'),
  );
};

const run = (cwd: string, args: readonly string[]) =>
  spawnSync(process.execPath, [DIST_MAIN, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });

describe('gesetz daemon: the whole lifecycle', () => {
  it('starts, reports itself, answers a check, stops, and leaves checks working', async () => {
    if (!built()) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-daemon-cli-'));
    try {
      await writeProject(dir);

      // With no daemon, the check does the work itself and says that it did.
      const before = run(dir, ['check', '--format=json']);
      expect(before.stderr).toContain('daemon: no answer');
      expect((JSON.parse(before.stdout) as { total: number }).total).toBe(1);

      const started = run(dir, ['daemon', 'start']);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain('started');
      // The socket path, wherever it landed: a temp project's path is long enough to
      // exceed `sun_path`, so the fallback location is the normal case here.
      expect(started.stdout).toContain('socket: ');
      expect(started.stdout).toMatch(/socket: \S+\.sock/);

      const status = run(dir, ['daemon', 'status']);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain('running');
      expect(status.stdout).toMatch(/running — pid \d+/);

      // The same question, answered from the daemon's state.
      const served = run(dir, ['check', '--format=json']);
      expect(served.stderr).toContain('daemon: answered from a state computed');
      expect((JSON.parse(served.stdout) as { total: number }).total).toBe(1);

      // A filter is a scope, and the answer says what it did *not* decide.
      const scoped = run(dir, ['check', '--rule', 'no-console-calls', '--format=json']);
      expect(scoped.stderr).toContain('daemon: answered');
      expect((JSON.parse(scoped.stdout) as { total: number }).total).toBe(1);

      const stopped = run(dir, ['daemon', 'stop']);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain('stopped');

      const notRunning = run(dir, ['daemon', 'status']);
      expect(notRunning.status).not.toBe(0);
      expect(notRunning.stderr).toContain('no daemon is running');

      // And with the daemon gone, the answer is the same answer.
      const after = run(dir, ['check', '--format=json']);
      expect(after.stderr).toContain('daemon: no answer');
      expect((JSON.parse(after.stdout) as { total: number }).total).toBe(1);
    } finally {
      // Never leave a daemon behind, however the assertions went.
      run(dir, ['daemon', 'stop']);
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses a second daemon for one project, since two would be two writers', async () => {
    if (!built()) return;
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-daemon-cli-'));
    try {
      await writeProject(dir);
      expect(run(dir, ['daemon', 'start']).status).toBe(0);

      const again = run(dir, ['daemon', 'start']);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('already running');

      const foreground = run(dir, ['daemon', 'run']);
      expect(foreground.status).not.toBe(0);
      expect(foreground.stderr).toContain('already running');
    } finally {
      run(dir, ['daemon', 'stop']);
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
