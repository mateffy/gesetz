#!/usr/bin/env bun
/**
 * Publish all workspace packages to the npm registry.
 *
 * Publishes in dependency order (core first, then leaf packages).
 * Assumes `bun login` / `bun publish --dry-run` already works.
 *
 * Before publishing, verifies that `workspace:*` specifiers resolve to the
 * versions actually in each package.json — guarding against the known Bun
 * bug where `bun.lock` keeps stale workspace versions after a bump, which
 * would produce internally-inconsistent published packages.
 *
 * Usage:
 *   bun run scripts/publish-all.ts
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeChildProcess from 'node:child_process';

const ROOT = nodePath.resolve(import.meta.dir, '..');

const PACKAGES = [
  'packages/core',
  'packages/junit',
  'packages/typescript',
  'packages/php',
  'packages/effect-ts',
  'packages/eslint',
  'packages/oxlint',
  'packages/prettier',
  'packages/oxfmt',
  'packages/vitest',
  'packages/bun-test',
  'packages/storybook',
  'packages/phpstan',
  'packages/phpunit',
  'packages/pest',
  'packages/laravel',
  'packages/cli',
  'packages/gesetz',
];

async function publish(dir: string): Promise<void> {
  const pkgPath = nodePath.join(ROOT, dir, 'package.json');
  if (!nodeFs.existsSync(pkgPath)) {
    console.log(`  ${dir} — no package.json, skipping`);
    return;
  }
  const pkg = JSON.parse(nodeFs.readFileSync(pkgPath, 'utf-8')) as {
    name?: string;
    version?: string;
    private?: boolean;
    scripts?: Record<string, string>;
  };
  if (pkg.private) {
    console.log(`  ${pkg.name} — private, skipping`);
    return;
  }
  // Run the package's `prepack` script if it declares one. This guarantees
  // build artifacts (e.g. @gesellschaft/cli's dist/main.js) exist before the
  // tarball is packed, even if `bun publish` does not honour the lifecycle
  // hook itself. Belt-and-suspenders alongside the package.json prepack hook.
  const prepack = pkg.scripts?.prepack;
  if (prepack) {
    console.log(`  → prepack: ${prepack}`);
    const buildProc = Bun.spawn(['bun', 'run', 'prepack'], {
      cwd: nodePath.join(ROOT, dir),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await buildProc.exited;
    if (buildProc.exitCode !== 0) {
      console.error(`\n❌ prepack failed for ${pkg.name}`);
      process.exit(1);
    }
  }
  console.log(`  Publishing ${pkg.name}@${pkg.version} …`);
  const proc = Bun.spawn(['bun', 'publish', '--access', 'public'], {
    cwd: nodePath.join(ROOT, dir),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    console.error(`\n❌ Failed to publish ${pkg.name}`);
    process.exit(1);
  }
}

console.log('Publishing all packages…\n');

// Pre-publish guard: verify workspace dependency consistency.
// Packs @gesellschaft/cli (the package with the deepest @gesellschaft/* dep
// chain) and asserts every @gesellschaft/* dependency in the tarball resolves
// to the version declared in that dependency's own package.json. This catches
// the known Bun bug where bun.lock keeps stale workspace versions after a
// version bump, which would ship packages whose @gesellschaft/* deps point at
// old registry versions.
await verifyWorkspaceConsistency();

for (const dir of PACKAGES) {
  await publish(dir);
}
console.log('\n✅ All packages published.');

// ─── Verification ────────────────────────────────────────────────────────

async function verifyWorkspaceConsistency(): Promise<void> {
  // Build a map of @gesellschaft/* package name → expected version, read from
  // each workspace's package.json (the source of truth after a bump).
  const expectedVersions = new Map<string, string>();
  for (const dir of PACKAGES) {
    const pkgPath = nodePath.join(ROOT, dir, 'package.json');
    if (!nodeFs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(nodeFs.readFileSync(pkgPath, 'utf-8')) as {
      name?: string;
      version?: string;
      private?: boolean;
    };
    if (pkg.private || !pkg.name || !pkg.version) continue;
    expectedVersions.set(pkg.name, pkg.version);
  }

  // Pack @gesellschaft/cli (deepest dep chain: core, typescript, php).
  // `bun pm pack` resolves workspace:* from bun.lock, so this is the real
  // test of what would ship.
  const probeDir = nodePath.join(ROOT, 'packages/cli');
  console.log('Verifying workspace consistency (@gesellschaft/cli pack)…');
  const packOut = nodeChildProcess.execSync('bun pm pack', {
    cwd: probeDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tgzMatch = packOut.match(/(gesetz-cli-[\w.-]+\.tgz)/);
  if (!tgzMatch) {
    console.error('❌ Could not find packed tarball name in `bun pm pack` output');
    process.exit(1);
  }
  const tgzPath = nodePath.join(probeDir, tgzMatch[1]!);
  try {
    // Extract the tarball's package.json and read its resolved dependencies.
    const tarPackageJson = nodeChildProcess.execSync(
      `tar -xzf "${tgzPath}" -O package/package.json`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const packed = JSON.parse(tarPackageJson) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
    };
    const packedDeps = packed.dependencies ?? {};
    const mismatches: string[] = [];
    for (const [dep, resolvedVersion] of Object.entries(packedDeps)) {
      if (!dep.startsWith('@gesetz/') && dep !== 'gesetz') continue;
      const expected = expectedVersions.get(dep);
      if (expected === undefined) continue; // not a workspace package
      if (resolvedVersion !== expected) {
        mismatches.push(
          `  ${dep}: tarball resolves to ${resolvedVersion}, expected ${expected}`,
        );
      }
    }
    if (mismatches.length > 0) {
      console.error(
        '\n❌ Workspace dependency consistency check FAILED.\n' +
          'The packed tarball resolves @gesellschaft/* deps to versions that do not match the package.json versions.\n' +
          'This is the known Bun bug (oven-sh/bun#18906, #20477) where bun.lock keeps stale workspace versions after a bump.\n' +
          'Fix: run `bun install --force` (or `bun run scripts/bump-version.ts <patch|minor|major>`) to refresh the lockfile, then re-run publish.\n\n' +
          mismatches.join('\n'),
      );
      process.exit(1);
    }
    console.log('  ✓ all @gesellschaft/* deps resolve to expected versions\n');
  } finally {
    // Clean up the probe tarball.
    if (nodeFs.existsSync(tgzPath)) {
      nodeFs.unlinkSync(tgzPath);
    }
  }
}
