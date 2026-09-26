import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { detectProject } from '../../src/init/detect';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-detect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, content: string) => {
  const abs = nodePath.join(dir, rel);
  await mkdir(nodePath.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'x', dependencies: deps });

describe('detectProject', () => {
  it('reports a generic project for an empty directory', () => {
    const p = detectProject(dir);
    expect(p.framework).toBe('generic');
    expect(p.cwd).toBe(dir);
    expect(p.hasSrc).toBe(false);
    expect(p.isLaravel).toBe(false);
  });

  it('detects react from package.json dependencies', async () => {
    await write('package.json', pkg({ react: '^19.0.0', 'react-dom': '^19.0.0' }));
    expect(detectProject(dir).framework).toBe('react');
  });

  it('prefers tanstack-start over react', async () => {
    await write(
      'package.json',
      pkg({ react: '^19.0.0', 'react-dom': '^19.0.0', '@tanstack/react-start': '^1.0.0' }),
    );
    expect(detectProject(dir).framework).toBe('tanstack-start');
  });

  it('detects effect-ts when effect is present without react', async () => {
    await write('package.json', pkg({ effect: '^3.0.0' }));
    expect(detectProject(dir).framework).toBe('effect-ts');
  });

  it('detects laravel from composer.json', async () => {
    await write('composer.json', '{}');
    const p = detectProject(dir);
    expect(p.framework).toBe('laravel');
    expect(p.isLaravel).toBe(true);
    expect(p.packageManager).toBe('composer');
  });

  it('detects laravel from an artisan file in the detected directory', async () => {
    // Regression: `artisan` was looked up relative to the process cwd, so a
    // project in another directory was only detected via composer.json.
    await write('artisan', '#!/usr/bin/env php');
    expect(detectProject(dir).framework).toBe('laravel');
  });

  it('detects the package manager from the lockfile', async () => {
    await write('bun.lock', '');
    expect(detectProject(dir).packageManager).toBe('bun');
  });

  it('falls back to npm when there is no lockfile', () => {
    expect(detectProject(dir).packageManager).toBe('npm');
  });

  it('reports the layout flags it can see', async () => {
    await mkdir(nodePath.join(dir, 'src/components/domains'), { recursive: true });
    const p = detectProject(dir);
    expect(p.hasSrc).toBe(true);
    expect(p.hasComponents).toBe(true);
    expect(p.hasDomains).toBe(true);
    expect(p.hasRoutes).toBe(false);
  });

  it('detects an existing gesetz config', async () => {
    await write('gesetz.config.ts', 'export default {};');
    expect(detectProject(dir).hasExistingConfig).toBe(true);
  });

  it('detects tools declared in package.json', async () => {
    await write('package.json', pkg({ oxlint: '^1.0.0' }));
    expect(detectProject(dir).detectedTools.map((t) => t.tool)).toContain('oxlint');
  });

  it('does not throw on a malformed package.json', async () => {
    await write('package.json', '{ not json');
    expect(() => detectProject(dir)).not.toThrow();
  });

  it('suggests a preset', () => {
    expect(typeof detectProject(dir).suggestedPreset).toBe('string');
  });
});
