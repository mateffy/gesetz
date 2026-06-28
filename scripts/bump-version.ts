#!/usr/bin/env bun
/**
 * Bump the version across all workspace packages.
 *
 * Usage:
 *   bun run scripts/bump-version.ts patch
 *   bun run scripts/bump-version.ts minor
 *   bun run scripts/bump-version.ts major
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const BUMP = process.argv[2] as 'patch' | 'minor' | 'major';
if (!['patch', 'minor', 'major'].includes(BUMP)) {
  console.error('Usage: bump-version.ts <patch|minor|major>');
  process.exit(1);
}

const ROOT = nodePath.resolve(import.meta.dir, '..');

function bump(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if (BUMP === 'major') return `${major + 1}.0.0`;
  if (BUMP === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function bumpFile(filePath: string): string {
  const raw = nodeFs.readFileSync(filePath, 'utf-8');
  const json = JSON.parse(raw) as { version?: string };
  if (!json.version) return '';
  const oldVersion = json.version;
  const newVersion = bump(oldVersion);
  const updated = raw.replace(
    new RegExp(`"version": "${oldVersion}"`, 'g'),
    `"version": "${newVersion}"`,
  );
  nodeFs.writeFileSync(filePath, updated, 'utf-8');
  return `${oldVersion} → ${newVersion}`;
}

const packages = [
  'package.json',
  ...[
    'packages/core',
    'packages/cli',
    'packages/gesetz',
    'packages/typescript',
    'packages/effect-ts',
    'packages/eslint',
    'packages/oxlint',
    'packages/prettier',
    'packages/oxfmt',
    'packages/vitest',
    'packages/bun-test',
    'packages/storybook',
    'packages/junit',
    'packages/phpstan',
    'packages/phpunit',
    'packages/pest',
    'packages/php',
    'packages/laravel',
    'immoui',
  ].map((d) => nodePath.join(d, 'package.json')),
];

console.log(`Bumping ${BUMP}…\n`);
for (const rel of packages) {
  const filePath = nodePath.join(ROOT, rel);
  if (!nodeFs.existsSync(filePath)) continue;
  const report = bumpFile(filePath);
  if (report) console.log(`  ${rel.padEnd(32)} ${report}`);
}

console.log('\nRegenerating lockfile (delete + fresh install)…');
// `bun install` alone no-ops on version-only changes and leaves the lockfile
// with stale versions. `bun pm pack` then resolves `workspace:*` from the
// stale lockfile, producing internally-inconsistent published packages
// (e.g. 1.2.0 adapters depending on @gesetz/core 1.1.1). Deleting the
// lockfile first forces a full rewrite that picks up the new versions.
const lockPath = nodePath.join(ROOT, 'bun.lock');
if (nodeFs.existsSync(lockPath)) {
  nodeFs.unlinkSync(lockPath);
}
const proc = Bun.spawn(['bun', 'install'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
await proc.exited;
console.log('\nDone.');
