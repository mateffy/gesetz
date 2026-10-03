import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  candidateFileRefs,
  discoverCandidateFiles,
  listGitFiles,
  listProjectFiles,
} from '../../src/engine/discovery';
import { defineConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';
import { noCycles } from '../../src/primitives/graph';

function gitInit(path: string): void {
  // Isolated from the developer's git configuration: a global `commit.gpgsign`, a
  // hooks path, or a default branch setting must not change what this test observes.
  execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd: path,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

describe('discoverCandidateFiles (plain directory)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-'));
    await mkdir(nodePath.join(dir, 'src'), { recursive: true });
    await mkdir(nodePath.join(dir, 'node_modules/pkg'), { recursive: true });
    await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(nodePath.join(dir, 'src/b.php'), '<?php\n', 'utf8');
    await writeFile(nodePath.join(dir, 'node_modules/pkg/c.ts'), 'export const c = 1;\n', 'utf8');
    // 140 KB — over the 64 KB cap the old engine silently applied.
    await writeFile(nodePath.join(dir, 'src/big.ts'), '// pad\n'.repeat(20_000), 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('unions rule patterns and skips node_modules', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [select('src/**/*.ts').check(async () => [])],
    });
    const paths = (await discoverCandidateFiles(config)).map((file) => file.path);
    expect(paths).toEqual(['src/a.ts', 'src/big.ts']);
  });

  it('includes files larger than 64 KB', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [select('src/**/*.ts').check(async () => [])],
    });
    const files = await discoverCandidateFiles(config);
    expect(files.find((file) => file.path === 'src/big.ts')).toBeDefined();
  });

  it('deduplicates overlapping patterns', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [
        select('src/**/*.ts').check(async () => []),
        select('src/a.ts').check(async () => []),
      ],
    });
    const files = await discoverCandidateFiles(config);
    expect(files.filter((file) => file.path === 'src/a.ts')).toHaveLength(1);
  });

  it('returns nothing when there are no rules', async () => {
    const config = defineConfig({ projectRoot: dir, rules: [] });
    expect(await discoverCandidateFiles(config)).toEqual([]);
  });

  it('widens to the whole project when a rule has no patterns of its own', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [noCycles('src/**/*.ts')],
    });
    const paths = (await discoverCandidateFiles(config)).map((file) => file.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('node_modules/pkg/c.ts');
  });
});

describe('discovery inside a git repository', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-git-'));
    gitInit(repo);
    await mkdir(nodePath.join(repo, 'src'), { recursive: true });
    await mkdir(nodePath.join(repo, 'dist'), { recursive: true });
    await writeFile(nodePath.join(repo, '.gitignore'), 'dist/\n*.log\n', 'utf8');
    await writeFile(nodePath.join(repo, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(nodePath.join(repo, 'src/skip.log'), 'nope\n', 'utf8');
    await writeFile(nodePath.join(repo, 'dist/built.ts'), 'export const b = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lists tracked and untracked files but not ignored ones', () => {
    const listed = listGitFiles(repo) ?? [];
    expect(listed).toContain('src/a.ts');
    expect(listed).not.toContain('dist/built.ts');
    expect(listed).not.toContain('src/skip.log');
  });

  it('honours .gitignore when selecting candidates', async () => {
    const config = defineConfig({
      projectRoot: repo,
      rules: [select('**/*.ts').check(async () => [])],
    });
    const paths = (await discoverCandidateFiles(config)).map((file) => file.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('dist/built.ts');
  });

  it('still excludes node_modules when it is not gitignored', async () => {
    await mkdir(nodePath.join(repo, 'node_modules/pkg'), { recursive: true });
    await writeFile(nodePath.join(repo, 'node_modules/pkg/d.ts'), 'export const d = 1;\n', 'utf8');
    const all = await listProjectFiles(repo);
    expect(all).not.toContain('node_modules/pkg/d.ts');
  });

  it('returns null from listGitFiles outside a repository', async () => {
    const plain = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-plain-'));
    try {
      expect(listGitFiles(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('candidateFileRefs', () => {
  it('resolves absolute paths against the project root', () => {
    const config = defineConfig({
      projectRoot: '/project',
      rules: [select('src/**/*.ts').check(async () => [])],
    });
    const refs = candidateFileRefs(['src/a.ts', 'other/b.ts'], config);
    expect(refs).toEqual([{ path: 'src/a.ts', absolutePath: '/project/src/a.ts' }]);
  });
});
