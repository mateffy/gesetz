import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { detectProject } from '../src/init/detect';

let tmpDir: string;

function setupProject(files: Record<string, unknown>): string {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'gesetz-init-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = nodePath.join(dir, relPath);
    nodeFs.mkdirSync(nodePath.dirname(fullPath), { recursive: true });
    nodeFs.writeFileSync(fullPath, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

beforeEach(() => {
  tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'gesetz-init-'));
});

afterEach(() => {
  nodeFs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectProject — framework detection', () => {
  it('detects tanstack-start from @tanstack/react-start dep', () => {
    const dir = setupProject({
      'package.json': { dependencies: { '@tanstack/react-start': '^1.0', react: '^19' } },
    });
    const p = detectProject(dir);
    expect(p.framework).toBe('tanstack-start');
    expect(p.suggestedPreset).toBe('tanstack-start');
  });

  it('detects react from react+react-dom deps', () => {
    const dir = setupProject({
      'package.json': { dependencies: { react: '^19', 'react-dom': '^19' } },
    });
    const p = detectProject(dir);
    expect(p.framework).toBe('react');
    expect(p.suggestedPreset).toBe('react');
  });

  it('detects effect-ts from effect dep', () => {
    const dir = setupProject({
      'package.json': { dependencies: { effect: '^3.0' } },
    });
    const p = detectProject(dir);
    expect(p.framework).toBe('effect-ts');
    expect(p.suggestedPreset).toBe('generic');
  });

  it('detects laravel from composer.json', () => {
    const dir = setupProject({
      'composer.json': { name: 'x', require: { php: '^8.2' } },
    });
    const p = detectProject(dir);
    expect(p.framework).toBe('laravel');
    expect(p.suggestedPreset).toBe('laravel');
    expect(p.isLaravel).toBe(true);
    expect(p.packageManager).toBe('composer');
  });

  it('falls back to generic for plain TS project', () => {
    const dir = setupProject({
      'package.json': { name: 'plain', dependencies: {} },
    });
    const p = detectProject(dir);
    expect(p.framework).toBe('generic');
    expect(p.suggestedPreset).toBe('generic');
  });

  it('falls back to generic when no package.json or composer.json', () => {
    const p = detectProject(tmpDir);
    expect(p.framework).toBe('generic');
    expect(p.suggestedPreset).toBe('generic');
  });
});

describe('detectProject — tool detection', () => {
  it('detects oxlint from devDependency', () => {
    const dir = setupProject({
      'package.json': { devDependencies: { oxlint: '^1.0' } },
    });
    const p = detectProject(dir);
    const tools = p.detectedTools.map((t) => t.tool);
    expect(tools).toContain('oxlint');
  });

  it('detects vitest from devDependency', () => {
    const dir = setupProject({
      'package.json': { devDependencies: { vitest: '^1.0' } },
    });
    const p = detectProject(dir);
    const tools = p.detectedTools.map((t) => t.tool);
    expect(tools).toContain('vitest');
  });

  it('detects storybook from .storybook/ directory', () => {
    const dir = setupProject({
      'package.json': { name: 'x' },
      '.storybook/main.ts': '// storybook config',
    });
    const p = detectProject(dir);
    const tools = p.detectedTools.map((t) => t.tool);
    expect(tools).toContain('storybook');
  });

  it('detects PHP tools from composer.json require-dev', () => {
    const dir = setupProject({
      'composer.json': {
        name: 'x',
        'require-dev': {
          'phpstan/phpstan': '^2.0',
          'pestphp/pest': '^3.0',
        },
      },
    });
    const p = detectProject(dir);
    const tools = p.detectedTools.map((t) => t.tool);
    expect(tools).toContain('phpstan');
    expect(tools).toContain('pest');
    expect(tools).not.toContain('phpunit');
  });

  it('does not double-add a tool detected via multiple sources', () => {
    const dir = setupProject({
      'package.json': { devDependencies: { oxlint: '^1.0' } },
    });
    // Also create the binary
    nodeFs.mkdirSync(nodePath.join(dir, 'node_modules', '.bin'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'node_modules', '.bin', 'oxlint'), '');
    const p = detectProject(dir);
    const oxlintCount = p.detectedTools.filter((t) => t.tool === 'oxlint').length;
    expect(oxlintCount).toBe(1);
  });
});

describe('detectProject — package manager detection', () => {
  it('detects bun from bun.lock', () => {
    const dir = setupProject({ 'package.json': { name: 'x' }, 'bun.lock': '' });
    expect(detectProject(dir).packageManager).toBe('bun');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    const dir = setupProject({ 'package.json': { name: 'x' }, 'pnpm-lock.yaml': '' });
    expect(detectProject(dir).packageManager).toBe('pnpm');
  });

  it('detects npm from package-lock.json', () => {
    const dir = setupProject({ 'package.json': { name: 'x' }, 'package-lock.json': '' });
    expect(detectProject(dir).packageManager).toBe('npm');
  });

  it('detects yarn from yarn.lock', () => {
    const dir = setupProject({ 'package.json': { name: 'x' }, 'yarn.lock': '' });
    expect(detectProject(dir).packageManager).toBe('yarn');
  });

  it('defaults to npm when no lockfile', () => {
    const dir = setupProject({ 'package.json': { name: 'x' } });
    expect(detectProject(dir).packageManager).toBe('npm');
  });

  it('uses composer for laravel regardless of node lockfiles', () => {
    const dir = setupProject({
      'composer.json': { name: 'x', require: { php: '^8.2' } },
      'package-lock.json': '',
    });
    expect(detectProject(dir).packageManager).toBe('composer');
  });
});

describe('detectProject — source layout', () => {
  it('detects src/, routes/, components/, domains/ dirs', () => {
    const dir = setupProject({
      'package.json': { name: 'x', dependencies: { react: '^19' } },
      'src/routes/index.tsx': '',
      'src/components/Button.tsx': '',
      'src/components/domains/foo/index.ts': '',
    });
    const p = detectProject(dir);
    expect(p.hasSrc).toBe(true);
    expect(p.hasRoutes).toBe(true);
    expect(p.hasComponents).toBe(true);
    expect(p.hasDomains).toBe(true);
  });

  it('detects existing gesetz config', () => {
    const dir = setupProject({
      'package.json': { name: 'x' },
      'gesetz.config.ts': '// existing',
    });
    expect(detectProject(dir).hasExistingConfig).toBe(true);
  });

  it('detects existing gesetz.config.mjs', () => {
    const dir = setupProject({
      'package.json': { name: 'x' },
      'gesetz.config.mjs': '// existing',
    });
    expect(detectProject(dir).hasExistingConfig).toBe(true);
  });
});
