/**
 * defineArchitecture — TS-native declarative architecture rules.
 *
 * Defines layers as file-glob patterns and enforces import constraints between
 * them. Returns Rule[] that can be passed directly to defineConfig().
 *
 * Import extraction uses the `SyntaxTree` service (a registered SyntaxBackend)
 * when available, with a JS/TS regex fallback. Relative specifiers are resolved
 * to file paths via the `ImportResolver` service.
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
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { FileSystem, ProjectRoot } from './services/fs';
import { SyntaxTree } from './services/syntax-tree';
import type { ParsedImport } from './services/syntax-tree';
import { ImportResolver } from './services/import-resolver';
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

/** Returns true if the import path is a relative or absolute path, not a package. */
function isRelativeImport(importPath: string): boolean {
  return importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('~');
}

/** Returns true if the import path is an external npm package. */
function isExternalPackage(importPath: string): boolean {
  return !isRelativeImport(importPath);
}

/** Regex fallback for extracting import specifiers from JS/TS-like source. */
function regexExtractImports(content: string): string[] {
  const results: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(['"]([^'"]+)['"]\)/g,
    /\bimport\(['"]([^'"]+)['"]\)/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(content)) !== null) {
      if (m[1]) results.push(m[1]);
    }
  }
  return results;
}

// ─── Rule builder ─────────────────────────────────────────────────────────────

function buildLayerRule(config: ArchitectureConfig): Rule {
  const id = 'architecture-layer-violations';
  const description = 'Architecture layer constraints must not be violated';

  const run = Effect.gen(function* () {
    const fs = yield* FileSystem;
    const projectRoot = yield* ProjectRoot;
    const st = yield* SyntaxTree;
    const resolver = yield* ImportResolver;

    // Gather all patterns across all layers
    const allPatterns = config.layers.flatMap((l) =>
      Array.isArray(l.pattern) ? l.pattern : [l.pattern],
    );
    const allFiles = yield* fs.glob(allPatterns, { cwd: projectRoot }).pipe(
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

    // Build a lookup of absolute path -> layer name for resolved-import matching.
    const absToLayer = new Map<string, string>();
    for (const file of allFiles) {
      absToLayer.set(nodePath.normalize(file.absolutePath), fileToLayer.get(file.path) ?? '');
    }

    const violations: Violation[] = [];

    for (const file of allFiles) {
      const fromLayer = fileToLayer.get(file.path);
      if (!fromLayer) continue;

      // Extract imports: SyntaxTree when available, regex fallback otherwise.
      let importSpecifiers: string[];
      if (st.canProcess(file)) {
        const result = yield* st.process(file, { imports: true }).pipe(
          Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
        );
        importSpecifiers = result.imports.map((i: ParsedImport) => i.specifier);
      } else {
        importSpecifiers = regexExtractImports(file.content);
      }

      const allowedForFrom = allowedImports.get(fromLayer);
      const forbiddenForFrom = forbiddenPairs.get(fromLayer);
      const bannedForFrom = bannedExternals[fromLayer] ?? [];

      for (const importPath of importSpecifiers) {
        // Check banned external packages
        if (isExternalPackage(importPath) && bannedForFrom.length > 0) {
          const pkg = importPath.startsWith('@')
            ? importPath.split('/').slice(0, 2).join('/')
            : (importPath.split('/')[0] ?? importPath);
          if (bannedForFrom.includes(pkg) || bannedForForLayer(bannedForFrom, importPath)) {
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

        // Resolve the import to an absolute path via ImportResolver
        const resolved = resolver.resolve(file, importPath);
        if (resolved === null) continue;

        // Find which layer the resolved target belongs to. Try exact match
        // and extension-stripped variants (e.g. './foo' → './foo.ts').
        const candidates = [
          nodePath.normalize(resolved),
          nodePath.normalize(resolved + '.ts'),
          nodePath.normalize(resolved + '.tsx'),
          nodePath.normalize(resolved + '.js'),
          nodePath.normalize(resolved + '.jsx'),
          nodePath.normalize(resolved + '.php'),
          nodePath.normalize(nodePath.join(resolved, 'index.ts')),
          nodePath.normalize(nodePath.join(resolved, 'index.tsx')),
          nodePath.normalize(nodePath.join(resolved, 'index.js')),
          nodePath.normalize(nodePath.join(resolved, 'index.php')),
        ];

        let toLayer: string | undefined;
        for (const candidate of candidates) {
          const layerName = absToLayer.get(candidate);
          if (layerName) {
            toLayer = layerName;
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

function bannedForForLayer(banned: string[], importPath: string): boolean {
  return banned.includes(importPath);
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
