#!/usr/bin/env node
/**
 * Runs `attw` over every workspace package without rebuilding them.
 *
 * Why this exists: `attw --pack` runs `npm pack`, and `npm pack` runs the
 * package's `prepack` script — which here is `tsdown`, a full build. Measured on
 * one small package, packing *with* scripts costs ~6.4s more wall time and
 * ~315 MB more peak RSS than packing without them (2.2s / 131 MB vs 8.6s /
 * 446 MB). Across 19 packages that is minutes of CPU and repeated memory spikes,
 * for no extra coverage.
 *
 * CI builds once up front, so this script packs with `--ignore-scripts` (packing
 * is just tarring the `files` entries) and analyses the resulting tarball — which
 * is the input attw actually wants.
 *
 * Usage: node scripts/attw.mjs [--profile <profile>] [--changed [<ref>]] [<package-name>...]
 *
 *   (no arguments)            every workspace package — used by CI
 *   --changed [<ref>]         only packages touched since <ref> (default origin/main)
 *   @gesetz/core @gesetz/cli  only the named packages
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const root = nodePath.resolve(import.meta.dirname, '..');
const packagesDir = nodePath.join(root, 'packages');
const attwBin = nodePath.join(root, 'node_modules', '.bin', 'attw');

const argv = process.argv.slice(2);

const profileArgIndex = argv.indexOf('--profile');
const profile = profileArgIndex === -1 ? (process.env['ATTW_PROFILE'] ?? 'esm-only') : argv[profileArgIndex + 1];

const changedIndex = argv.indexOf('--changed');
const changedRef = changedIndex === -1 ? undefined : (argv[changedIndex + 1] ?? 'origin/main');

// Indexes that hold a flag's *value*, so they are not mistaken for package
// names. Guarding on `!== -1` matters: an absent flag has index -1, and
// `-1 + 1` would otherwise swallow the first positional argument.
const flagValueIndexes = new Set();
if (profileArgIndex !== -1) flagValueIndexes.add(profileArgIndex + 1);
if (changedIndex !== -1) flagValueIndexes.add(changedIndex + 1);

const named = argv.filter(
  (arg, index) => !arg.startsWith('--') && !flagValueIndexes.has(index),
);

function manifest(dir) {
  return JSON.parse(readFileSync(nodePath.join(dir, 'package.json'), 'utf8'));
}

const packages = readdirSync(packagesDir)
  .map((entry) => nodePath.join(packagesDir, entry))
  .filter((dir) => {
    try {
      return manifest(dir).name !== undefined;
    } catch {
      return false;
    }
  })
  .filter((dir) => {
    const { name } = manifest(dir);
    if (named.length > 0) return named.includes(name);
    if (changedRef === undefined) return true;
    const touched = execFileSync('git', ['diff', '--name-only', changedRef, '--', nodePath.relative(root, dir)], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    return touched !== '';
  })
  .sort();

if (packages.length === 0) {
  process.stdout.write('attw: no packages to check\n');
  process.exit(0);
}

const scratch = mkdtempSync(nodePath.join(tmpdir(), 'gesetz-attw-'));
let failed = 0;

// Skipping `prepack` means a stale (or absent) build would be analysed silently,
// so require the artefact the tarball is supposed to contain.
const missingBuild = packages.filter((dir) => !existsSync(nodePath.join(dir, 'dist', 'index.js')));
if (missingBuild.length > 0) {
  process.stderr.write(
    'attw: these packages have no dist/index.js - run `pnpm build` first:\n' +
      missingBuild.map((dir) => `  ${manifest(dir).name}\n`).join(''),
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

try {
  for (const dir of packages) {
    const { name } = manifest(dir);
    const destination = mkdtempSync(nodePath.join(scratch, 'pkg-'));

    const packed = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', destination],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n')
      .at(-1);

    try {
      execFileSync(attwBin, [nodePath.join(destination, packed), '--profile', profile], {
        cwd: root,
        stdio: 'pipe',
      });
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n`);
      process.stdout.write(`${error.stdout ?? error.message}\n`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed > 0) {
  process.stderr.write(`${failed} package(s) failed attw\n`);
  process.exit(1);
}
process.stdout.write(`attw: ${packages.length} packages clean (profile: ${profile})\n`);
