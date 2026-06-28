#!/usr/bin/env python3
"""
Transform every library package.json for JS-runtime publishing:
- exports: { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
- types: ./dist/index.d.ts
- files: ["dist"]
- scripts.build: "tsdown"
- scripts.prepack: "tsdown"  (tsdown workspace mode builds all, but per-package
  prepack ensures a standalone `pnpm publish` from the package dir also works)
- Remove scripts that referenced bun.

The CLI and gesetz meta-package are handled specially (CLI keeps its own
build; gesetz just re-exports). Core gets an extra ./reporters subpath.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKGS_DIR = os.path.join(ROOT, "packages")

# (dir, extra_exports dict to merge beyond ".")
SPECIAL = {
    "core": {"./reporters": {
        "types": "./dist/reporters.d.ts",
        "import": "./dist/reporters.js",
    }},
}


def standard_exports():
    return {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.js",
        }
    }


def transform(dir_name: str) -> str:
    pkg_path = os.path.join(PKGS_DIR, dir_name, "package.json")
    with open(pkg_path) as f:
        pkg = json.load(f)

    exports = standard_exports()
    if dir_name in SPECIAL:
        exports.update(SPECIAL[dir_name])
    pkg["exports"] = exports
    pkg["types"] = "./dist/index.d.ts"
    pkg["files"] = ["dist"]

    scripts = pkg.setdefault("scripts", {})
    scripts["build"] = "tsdown"
    scripts["prepack"] = "tsdown"
    # Remove bun-specific dev/test scripts we no longer use.
    scripts.pop("dev", None)

    with open(pkg_path, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    return pkg["name"]


# All library packages (not the CLI, not the gesetz meta-package which is
# handled below — gesetz re-exports @gesetz/core so it builds the same way
# but its exports stay as the standard shape).
library_pkgs = sorted(
    d for d in os.listdir(PKGS_DIR)
    if os.path.isdir(os.path.join(PKGS_DIR, d))
    and os.path.exists(os.path.join(PKGS_DIR, d, "package.json"))
    and d != "cli"
)

names = []
for d in library_pkgs:
    names.append(transform(d))

print(f"Transformed {len(names)} library packages:")
for n in names:
    print(f"  {n}")
