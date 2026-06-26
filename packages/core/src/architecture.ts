/**
 * defineArchitecture — TS-native declarative architecture rules.
 *
 * Defines layers as file-glob patterns and enforces import constraints between
 * them. Returns Rule[] that can be passed directly to defineConfig().
 *
 * No YAML. Pure TypeScript.
 *
 * @example
 * ```ts
 * const arch = defineArchitecture({
 *   layers: [
 *     { name: 'entry',  pattern: 'src/cli/**', canImportFrom: ['core', 'util'] },
 *     { name: 'core',   pattern: 'src/core/**', canImportFrom: ['util'] },
 *     { name: 'util',   pattern: 'src/utils/**', canImportFrom: [] },
 *   ],
 *   bannedExternals: {
 *     util: ['react', 'react-dom'],
 *   },
 * });
 *
 * const config = defineConfig({ rules: arch });
 * ```
 */
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { FileSystem } from './services/fs';
import { TsAdapter } from './services/ts-adapter';
import type { PhpAdapter } from './services/php-adapter';
import type { Rule, Violation } from './engine/rule';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArchitectureLayer {
  /** Layer name used in `canImportFrom`, `forbidden.from/to`, and diagnostics. */
  readonly name: string;
  /**
   * Glob pattern(s) matching files that belong to this layer.
   * Relative to projectRoot (same convention as `select()`).
   */
  readonly pattern: string | string[];
  /**
   * Layer names this layer is allowed to import from.
   * Files in this layer may not import from any layer NOT in this list,
   * nor from layers above it in the declaration order.
   *
   * Omit or set to `undefined` to allow all imports (no enforcement).
   */
  readonly canImportFrom?: string[] | undefined;
}

export interface ForbiddenImport {
  /** Source layer name */
  readonly from: string;
  /** Target layer name */
  readonly to: string;
  /** Custom violation message */
  readonly message?: string | undefined;
}

export interface ArchitectureConfig {
  readonly layers: ArchitectureLayer[];
  /**
   * Additional forbidden import pairs beyond what `canImportFrom` expresses.
   * Use this for special cases that are easier to express as explicit denials.
   */
  readonly forbidden?: ForbiddenImport[] | undefined;
  /**
   * Banned external npm package imports per layer.
   * e.g. `{ util: ['react'] }` prevents utility modules from importing React.
   */
  readonly bannedExternals?: Record<string, string[]> | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extracts import paths from a file's content using a simple regex. */
function extractImports(content: string): string[] {
  const results: string[] = [];
  // Match static imports: import ... from '...'
  const staticImport = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  // Match require(): require('...')
  const requireImport = /require\(['"]([^'"]+)['"]\)/g;
  // Match dynamic import(): import('...')
  const dynamicImport = /\bimport\(['"]([^'"]+)['"]\)/g;

  for (const pattern of [staticImport, requireImport, dynamicImport]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1];
      if (path) results.push(path);
    }
  }
  return results;
}

/** Returns true if the import path is a relative or workspace-relative path, not a package. */
function isRelativeImport(importPath: string): boolean {
  return importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('~');
}

/** Returns true if the import path is an external npm package. */
function isExternalPackage(importPath: string): boolean {
  return !isRelativeImport(importPath);
}

// ─── Rule builder ─────────────────────────────────────────────────────────────

/**
 * Builds the layer-violation check rule.
 */
function buildLayerRule(config: ArchitectureConfig): Rule {
  const id = 'architecture-layer-violations';
  const description = 'Architecture layer constraints must not be violated';

  const run: Effect.Effect<Violation[], never, FileSystem | TsAdapter | PhpAdapter> =
    Effect.gen(function* () {
      const fs = yield* FileSystem;

      // Gather all patterns across all layers
      const allPatterns = config.layers.flatMap((l) =>
        Array.isArray(l.pattern) ? l.pattern : [l.pattern],
      );
      const allFiles = yield* fs.glob(allPatterns).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      );

      if (allFiles.length === 0) return [];

      // Build a map: filePath -> layer name
      const fileToLayer = new Map<string, string>();
      for (const file of allFiles) {
        for (const layer of config.layers) {
          const patterns = Array.isArray(layer.pattern) ? layer.pattern : [layer.pattern];
          if (micromatch.isMatch(file.path, patterns)) {
            fileToLayer.set(file.path, layer.name);
            break;
          }
        }
      }

      // Build allowlist map: layerName -> Set<allowed layer names>
      const allowedImports = new Map<string, Set<string>>();
      for (const layer of config.layers) {
        if (layer.canImportFrom !== undefined) {
          allowedImports.set(layer.name, new Set(layer.canImportFrom));
        }
      }

      // Build forbidden pairs map
      const forbiddenPairs = new Map<string, Set<string>>();
      for (const forbidden of config.forbidden ?? []) {
        const set = forbiddenPairs.get(forbidden.from) ?? new Set();
        set.add(forbidden.to);
        forbiddenPairs.set(forbidden.from, set);
      }

      // Build banned externals map
      const bannedExternals = config.bannedExternals ?? {};

      const violations: Violation[] = [];

      for (const file of allFiles) {
        const fromLayer = fileToLayer.get(file.path);
        if (!fromLayer) continue;

        const imports = extractImports(file.content);
        const allowedForFrom = allowedImports.get(fromLayer);
        const forbiddenForFrom = forbiddenPairs.get(fromLayer);
        const bannedForFrom = bannedExternals[fromLayer] ?? [];

        for (const importPath of imports) {
          // Check banned external packages
          if (isExternalPackage(importPath) && bannedForFrom.length > 0) {
            const pkg = importPath.startsWith('@')
              ? importPath.split('/').slice(0, 2).join('/')
              : (importPath.split('/')[0] ?? importPath);
            if (bannedForFrom.includes(pkg) || bannedForFrom.includes(importPath)) {
              violations.push({
                rule: id,
                message: `Layer '${fromLayer}' must not import external package '${pkg}'.`,
                path: file.path,
                severity: 'error',
                source: 'core',
              });
            }
          }

          // Only check relative imports for layer-to-layer rules
          if (!isRelativeImport(importPath)) continue;

          // Find which layer the import target belongs to
          // Resolve relative to file.dir
          const importedPath = importPath.startsWith('.')
            ? `${file.dir}/${importPath}`
            : importPath;

          let toLayer: string | undefined;
          for (const [targetPath, targetLayer] of fileToLayer.entries()) {
            // Rough match: the imported path is a prefix of the target file path
            const normalizedTarget = targetPath.replace(/\.(ts|tsx|js|jsx)$/, '');
            if (
              normalizedTarget.endsWith(importedPath.replace(/\.\//g, '/')) ||
              normalizedTarget === importedPath
            ) {
              toLayer = targetLayer;
              break;
            }
          }

          if (!toLayer || toLayer === fromLayer) continue;

          // Check canImportFrom allowlist
          if (allowedForFrom !== undefined && !allowedForFrom.has(toLayer)) {
            violations.push({
              rule: id,
              message: `Layer '${fromLayer}' must not import from layer '${toLayer}'. Allowed: [${[...allowedForFrom].join(', ')}].`,
              path: file.path,
              severity: 'error',
              source: 'core',
            });
            continue;
          }

          // Check explicit forbidden pairs
          if (forbiddenForFrom?.has(toLayer)) {
            const pair = config.forbidden?.find((f) => f.from === fromLayer && f.to === toLayer);
            violations.push({
              rule: id,
              message:
                pair?.message ??
                `Layer '${fromLayer}' must not import from layer '${toLayer}'.`,
              path: file.path,
              severity: 'error',
              source: 'core',
            });
          }
        }
      }

      return violations;
    });

  return { id, description, category: 'organization', run };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Defines TypeScript-native architecture constraints as rules.
 * Returns a `Rule[]` ready to pass to `defineConfig({ rules: [...] })`.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   rules: [
 *     ...defineArchitecture({
 *       layers: [
 *         { name: 'entry', pattern: 'src/cli/**', canImportFrom: ['core', 'util'] },
 *         { name: 'core',  pattern: 'src/core/**', canImportFrom: ['util'] },
 *         { name: 'util',  pattern: 'src/utils/**', canImportFrom: [] },
 *       ],
 *       bannedExternals: { util: ['react'] },
 *     }),
 *   ],
 * });
 * ```
 */
export function defineArchitecture(config: ArchitectureConfig): Rule[] {
  return [buildLayerRule(config)];
}
