#!/usr/bin/env bun
/**
 * Publish all workspace packages to the npm registry.
 *
 * Publishes in dependency order (core first, then leaf packages).
 * Assumes `bun login` / `bun publish --dry-run` already works.
 *
 * Usage:
 *   bun run scripts/publish-all.ts
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

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
for (const dir of PACKAGES) {
  await publish(dir);
}
console.log('\n✅ All packages published.');
