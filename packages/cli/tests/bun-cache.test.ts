import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
const CORE_DIST = nodePath.join(REPO_ROOT, 'packages/core/dist/index.js');
const BUN_BIN = nodeFs.existsSync('/Users/mat/.bun/bin/bun')
  ? '/Users/mat/.bun/bin/bun'
  : nodeFs.existsSync('/usr/local/bin/bun')
    ? '/usr/local/bin/bun'
    : 'bun';

/**
 * Runs `gesetz check` under Bun — the way an agent invokes it in a project where
 * gesetz is installed (`bun node_modules/.bin/gesetz check`).
 *
 * Bun defines `globalThis.Bun`, which used to make the CLI fall back to
 * in-memory storage, so every such run re-parsed every file and re-ran every
 * external tool. Ten agents doing that is what put the machine on the floor.
 */
const runCheckUnderBun = (
  cwd: string,
  extraArgs: readonly string[] = [],
): { stdout: string; stderr: string } => {
  const result = spawnSync(BUN_BIN, [DIST_MAIN, 'check', ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** A project with one deterministic violation and nothing else to run. */
const writeProject = async (dir: string): Promise<void> => {
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  // Without this the cache database is discovered as project source: it is
  // counted in the scan, re-hashed on every run, and its `-wal`/`-shm`
  // companions make the added/removed counts jump around. netzwerk's discovery
  // honours .gitignore, which is why the README says to ignore .gesetz/.
  await writeFile(nodePath.join(dir, '.gitignore'), '.gesetz/\nnode_modules/\n');
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(nodePath.join(dir, 'src/b.ts'), 'export const b = 2;\n');
  await writeFile(
    nodePath.join(dir, 'gesetz.config.ts'),
    [
      `import { defineConfig, select } from ${JSON.stringify(CORE_DIST)};`,
      'const flagBad = async (file) =>',
      "  file.content.includes('BAD')",
      "    ? [{ rule: 'flag-bad', message: 'bad', path: file.path, severity: 'error', source: 'core' }]",
      '    : [];',
      'export default defineConfig({',
      `  projectRoot: ${JSON.stringify(dir)},`,
      "  rules: [select('src/**/*.ts').label('Flag bad').category('cleanup').check(flagBad)],",
      '});',
      '',
    ].join('\n'),
  );
};

describe('the violation cache under Bun', () => {
  it('reuses markers on a second run instead of re-checking everything', async () => {
    if (!nodeFs.existsSync(DIST_MAIN) || !nodeFs.existsSync(CORE_DIST)) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-bun-cache-'));
    try {
      await writeProject(dir);

      // The scan line is the observable: a cold run reuses nothing, a warm run
      // reuses everything. Parsed rather than matched literally, because the
      // project's file count is not what this test is about.
      const scanLine = (stderr: string): string =>
        stderr.split(String.fromCharCode(10)).find((line) => line.startsWith('scan: ')) ?? '';

      const cold = runCheckUnderBun(dir);
      expect(scanLine(cold.stderr)).toMatch(/\+\d+ ~0 -0 =0 reused/);

      // A cache-less run looks exactly like a fast machine, so the banner is
      // part of the contract: it names the database and the runtime.
      expect(cold.stderr).toContain('cache: ');
      // The engine's default is the shared cross-project cache rather than a
      // project-local file; what matters is that a real path and the runtime are
      // named, so a cache-less run cannot look like a fast machine.
      expect(cold.stderr).toMatch(/cache: \S+cache\.db/);
      expect(cold.stderr).not.toContain('SQLite caching is unavailable');
      expect(cold.stderr).toContain('runtime: bun');

      // --standalone on the second run, so this measures the *cache* rather than
      // the coordination: without it the second run reuses the first one's record
      // and never scans at all, which is the coordination doing its job and would
      // leave no scan line to assert on.
      const warm = runCheckUnderBun(dir, ['--standalone']);
      expect(scanLine(warm.stderr)).toMatch(/\+0 ~0 -0 =\d+ reused/);
      expect(scanLine(warm.stderr)).not.toContain('=0 reused');
      expect(warm.stderr).not.toContain('(bun) violation cache disabled');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
