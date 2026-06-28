#!/usr/bin/env python3
"""
Create a per-package tsdown.config.ts for every standard library package
that doesn't already have one (core and cli have custom configs already).

This prevents tsdown from walking up to the root workspace config when
`prepack` runs `tsdown` from inside a sub-package — the root config uses
`workspace: 'packages/*'` which fails (and historically caused issues) when
invoked from a package cwd.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKGS = os.path.join(ROOT, "packages")

TEMPLATE = '''import {{ defineConfig }} from 'tsdown';

/**
 * Per-package build config for {name}.
 *
 * Prevents tsdown from walking up to the root workspace config (which uses
 * `workspace: 'packages/*'` and fails when prepack runs tsdown from inside
 * a sub-package). This config builds the single src/index.ts entry with the
 * same options as the root workspace config.
 */
export default defineConfig({{
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outExtensions: () => ({{ js: '.js', dts: '.d.ts' }}),
}});
'''

# Packages with custom configs already
SKIP = {"core", "cli"}

created = []
for d in sorted(os.listdir(PKGS)):
    pkg_dir = os.path.join(PKGS, d)
    if not os.path.isdir(pkg_dir):
        continue
    pkgjson = os.path.join(pkg_dir, "package.json")
    if not os.path.exists(pkgjson):
        continue
    if d in SKIP:
        continue
    # Only create if the package actually has src/index.ts
    if not os.path.exists(os.path.join(pkg_dir, "src", "index.ts")):
        continue
    with open(pkgjson) as f:
        name = json.load(f).get("name", d)
    cfg = os.path.join(pkg_dir, "tsdown.config.ts")
    with open(cfg, "w") as f:
        f.write(TEMPLATE.format(name=name))
    created.append(name)

print(f"Created {len(created)} per-package tsdown.config.ts files:")
for n in created:
    print(f"  {n}")
