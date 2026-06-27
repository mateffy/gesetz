/**
 * Project detection for `gesetz init`.
 *
 * Pure function `detectProject(cwd)` → `ProjectProfile`. Uses only `node:fs`,
 * `node:path` — no Effect, no adapter imports, no side effects beyond reads.
 *
 * The profile drives the wizard's defaults and the non-interactive resolver.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Framework =
  | 'tanstack-start'
  | 'react'
  | 'effect-ts'
  | 'laravel'
  | 'generic';

export type PresetId = 'blank' | 'generic' | 'tanstack-start' | 'react' | 'laravel';

/** A QA tool we can wire in via an adapter rule. */
export interface DetectedTool {
  readonly tool: ToolId;
  /** How we detected it: 'devDep' | 'dep' | 'binary' | 'config' | 'dir' */
  readonly via: string;
  readonly version?: string | undefined;
}

export type ToolId =
  | 'oxlint'
  | 'oxfmt'
  | 'prettier'
  | 'eslint'
  | 'vitest'
  | 'bun-test'
  | 'storybook'
  | 'phpstan'
  | 'pest'
  | 'phpunit';

export type PackageManager = 'bun' | 'pnpm' | 'npm' | 'yarn' | 'composer';

export interface ProjectProfile {
  readonly cwd: string;
  readonly framework: Framework;
  readonly suggestedPreset: PresetId;
  readonly detectedTools: DetectedTool[];
  readonly packageManager: PackageManager;
  readonly hasExistingConfig: boolean;
  readonly hasSrc: boolean;
  readonly hasRoutes: boolean;
  readonly hasComponents: boolean;
  readonly hasDomains: boolean;
  readonly isLaravel: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T = unknown>(filePath: string): T | null {
  try {
    const txt = nodeFs.readFileSync(filePath, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    return nodeFs.existsSync(p);
  } catch {
    return false;
  }
}

function hasDep(pkg: PkgJson, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
}

// ─── Detection pieces ─────────────────────────────────────────────────────────

const CONFIG_FILES: Record<string, ToolId> = {
  '.oxlintrc.json': 'oxlint',
  'oxlint.json': 'oxlint',
  '.oxfmtrc.json': 'oxfmt',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintrc.json': 'eslint',
  'phpstan.neon': 'phpstan',
  'phpstan.neon.dist': 'phpstan',
};

/** Tools detected from package.json deps/devDeps + local binaries + config files. */
function detectTools(cwd: string, pkg: PkgJson | null): DetectedTool[] {
  const tools: DetectedTool[] = [];
  const seen = new Set<ToolId>();
  const add = (tool: ToolId, via: string, version?: string) => {
    if (seen.has(tool)) return;
    seen.add(tool);
    tools.push({ tool, via, version });
  };

  // 1. From package.json deps
  if (pkg) {
    const depMap: Record<string, ToolId> = {
      oxlint: 'oxlint',
      oxfmt: 'oxfmt',
      prettier: 'prettier',
      eslint: 'eslint',
      vitest: 'vitest',
      '@storybook/test-runner': 'storybook',
      storybook: 'storybook',
    };
    for (const [depName, toolId] of Object.entries(depMap)) {
      const v = hasDep(pkg, depName);
      if (v) add(toolId, `devDep:${depName}`, v);
    }
  }

  // 2. From local node_modules/.bin (TS/JS tools)
  const jsBin = nodePath.join(cwd, 'node_modules', '.bin');
  const jsBinTools: Record<string, ToolId> = {
    oxlint: 'oxlint',
    oxfmt: 'oxfmt',
    prettier: 'prettier',
    eslint: 'eslint',
    vitest: 'vitest',
    storybook: 'storybook',
  };
  for (const [binName, toolId] of Object.entries(jsBinTools)) {
    if (exists(nodePath.join(jsBin, binName))) add(toolId, `binary:${binName}`);
  }

  // 3. From PHP vendor/bin (PHP tools)
  const phpBin = nodePath.join(cwd, 'vendor', 'bin');
  const phpBinTools: Record<string, ToolId> = {
    phpstan: 'phpstan',
    pest: 'pest',
    phpunit: 'phpunit',
  };
  for (const [binName, toolId] of Object.entries(phpBinTools)) {
    if (exists(nodePath.join(phpBin, binName))) add(toolId, `binary:${binName}`);
  }

  // 4. From config files (covers cases where tool is installed globally)
  for (const [cfgFile, toolId] of Object.entries(CONFIG_FILES)) {
    if (exists(nodePath.join(cwd, cfgFile))) add(toolId, `config:${cfgFile}`);
  }

  // 5. Storybook via .storybook/ directory
  if (exists(nodePath.join(cwd, '.storybook'))) add('storybook', 'dir:.storybook');

  // 6. PHP tools from composer.json requires-dev
  const composer = readJson<{ 'require-dev'?: Record<string, string> }>(
    nodePath.join(cwd, 'composer.json'),
  );
  if (composer?.['require-dev']) {
    const dev = composer['require-dev'];
    if (dev['phpstan/phpstan']) add('phpstan', 'composer:phpstan/phpstan', dev['phpstan/phpstan']);
    if (dev['pestphp/pest']) add('pest', 'composer:pestphp/pest', dev['pestphp/pest']);
    if (dev['phpunit/phpunit']) add('phpunit', 'composer:phpunit/phpunit', dev['phpunit/phpunit']);
  }

  return tools;
}

function detectFramework(
  pkg: PkgJson | null,
  hasComposer: boolean,
): Framework {
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@tanstack/react-start']) return 'tanstack-start';
    if (deps['react'] && deps['react-dom']) return 'react';
    if (deps['effect'] && !deps['react']) return 'effect-ts';
  }
  if (hasComposer || exists('artisan')) return 'laravel';
  return 'generic';
}

function frameworkToPreset(fw: Framework): PresetId {
  switch (fw) {
    case 'tanstack-start':
      return 'tanstack-start';
    case 'react':
      return 'react';
    case 'laravel':
      return 'laravel';
    case 'effect-ts':
    case 'generic':
      return 'generic';
  }
}

function detectPackageManager(cwd: string, isLaravel: boolean): PackageManager {
  if (isLaravel) return 'composer';
  if (exists(nodePath.join(cwd, 'bun.lock'))) return 'bun';
  if (exists(nodePath.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(nodePath.join(cwd, 'package-lock.json'))) return 'npm';
  if (exists(nodePath.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const CONFIG_FILENAMES = ['gesetz.config.ts', 'gesetz.config.js', 'gesetz.config.mts', 'gesetz.config.mjs'];

// ─── Public entry point ───────────────────────────────────────────────────────

export function detectProject(cwd: string): ProjectProfile {
  const pkgPath = nodePath.join(cwd, 'package.json');
  const pkg = readJson<PkgJson>(pkgPath);
  const hasComposer = exists(nodePath.join(cwd, 'composer.json'));

  const framework = detectFramework(pkg, hasComposer);
  const detectedTools = detectTools(cwd, pkg);
  const packageManager = detectPackageManager(cwd, framework === 'laravel');

  const hasSrc = exists(nodePath.join(cwd, 'src'));
  const hasRoutes = exists(nodePath.join(cwd, 'src', 'routes'));
  const hasComponents = exists(nodePath.join(cwd, 'src', 'components'));
  const hasDomains = exists(nodePath.join(cwd, 'src', 'components', 'domains'));
  const hasExistingConfig = CONFIG_FILENAMES.some((f) => exists(nodePath.join(cwd, f)));

  return {
    cwd,
    framework,
    suggestedPreset: frameworkToPreset(framework),
    detectedTools,
    packageManager,
    hasExistingConfig,
    hasSrc,
    hasRoutes,
    hasComponents,
    hasDomains,
    isLaravel: framework === 'laravel',
  };
}
