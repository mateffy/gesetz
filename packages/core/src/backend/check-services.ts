/**
 * Marker-backed CheckServices.
 *
 * Implements the exact v2.0 `CheckServices` contract on top of a netzwerk
 * network, so every existing Check in @gesetz/* packages runs unmodified:
 *
 *   fs.glob/readFile/exists  → scanned file records (+ disk fallback)
 *   syntax.process           → reads cached `gesetz-syntax.*` markers (never parses)
 *   imports.resolve          → netzwerk import resolution over stored paths
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { FileMarker, Network, NetworkFile } from 'netzwerk';
import { resolverForLanguage } from 'netzwerk';
import type { CheckServices, File } from '../engine/rule';
import type {
  SyntaxBackend,
  SyntaxBackendProcessResult,
  SyntaxTreeProcessOptions,
  ParsedImport,
  ParsedCall,
  ParsedExport,
  StructureItem,
} from '../services/syntax-tree';
import { SYNTAX_EXTENSION } from './syntax-extension';

const EMPTY_RESULT: SyntaxBackendProcessResult = {
  imports: [],
  calls: [],
  exports: [],
  structure: [],
};

function languageForExt(ext: string): string {
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.php') return 'php-laravel';
  return 'generic';
}

function toGesetzFile(rootDir: string, networkFile: NetworkFile): File {
  const relativePath = networkFile.path;
  const absolutePath = nodePath.join(rootDir, relativePath);
  const name = nodePath.basename(relativePath);
  const ext = nodePath.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const dir = nodePath.dirname(relativePath);
  let cachedContent: string | undefined;
  let cachedStat: nodeFs.Stats | null | undefined;
  const stat = (): nodeFs.Stats | null => {
    if (cachedStat === undefined) {
      try {
        cachedStat = nodeFs.statSync(absolutePath);
      } catch {
        cachedStat = null;
      }
    }
    return cachedStat;
  };
  return {
    path: relativePath,
    absolutePath,
    name,
    stem,
    ext,
    dir: dir === '.' ? '' : dir,
    get content(): string {
      if (cachedContent === undefined) {
        try {
          cachedContent = nodeFs.readFileSync(absolutePath, 'utf-8');
        } catch {
          cachedContent = '';
        }
      }
      return cachedContent;
    },
    get size(): number {
      return stat()?.size ?? 0;
    },
    get mtimeMs(): number {
      return stat()?.mtimeMs ?? 0;
    },
  };
}

/**
 * Creates the CheckServices bag backed by the given network. `backends` are
 * the same SyntaxBackend objects the syntax extension was built from (used
 * only for `canProcess` routing — markers carry the actual data).
 */
export async function createCheckServices(
  network: Network,
  backends: readonly SyntaxBackend[],
  rootDir: string,
  sharedPaths?: Set<string>,
): Promise<CheckServices> {
  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) byExt.set(ext, backend);
    }
  }

  // Warm the stored-path cache up front: the CheckServices contract has a
  // synchronous imports.resolve, and netzwerk's Network API is fully async.
  // When `sharedPaths` is given, that set is used (and kept updated by the
  // compiler during scans) so after-hook rules resolve against fresh paths.
  const entries = await network.query({ limit: Number.MAX_SAFE_INTEGER });
  const cachedPaths: Set<string> = sharedPaths ?? new Set();
  cachedPaths.clear();
  for (const entry of entries) cachedPaths.add(entry.path);

  async function markersOf(file: File): Promise<NetworkFile | null> {
    return network.file(file.path);
  }

  return {
    projectRoot: rootDir,

    fs: {
      async glob(pattern, _options): Promise<File[]> {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        const byPath = new Map<string, File>();
        // patterns are resolved together; Promise.all keeps their order, so the
        // first pattern to match a path still wins
        const matches = (await Promise.all(patterns.map((p) => network.glob(p)))).flat();
        for (const networkFile of matches) {
          if (byPath.has(networkFile.path)) continue;
          byPath.set(networkFile.path, toGesetzFile(rootDir, networkFile));
        }
        return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
      },

      async readFile(absolutePath): Promise<string> {
        const relative = nodePath.relative(rootDir, absolutePath);
        if (!relative.startsWith('..')) {
          const networkFile = await network.file(relative);
          if (networkFile !== null) return networkFile.content();
        }
        return nodeFs.readFileSync(absolutePath, 'utf-8');
      },

      async exists(absolutePath): Promise<boolean> {
        const relative = nodePath.relative(rootDir, absolutePath);
        if (!relative.startsWith('..')) {
          const networkFile = await network.file(relative);
          if (networkFile !== null) return true;
        }
        return nodeFs.existsSync(absolutePath);
      },
    },

    syntax: {
      canProcess: (file) => byExt.has(file.ext),

      async process(file, options: SyntaxTreeProcessOptions): Promise<SyntaxBackendProcessResult> {
        const backend = byExt.get(file.ext);
        if (backend === undefined) {
          throw new Error(`No SyntaxBackend registered for extension "${file.ext}"`);
        }
        const networkFile = await markersOf(file);
        if (networkFile === null) return EMPTY_RESULT;

        /**
         * Read this extension's markers of one kind.
         *
         * `markersOf` matches the RAW `type` field, not a namespaced
         * `extension.type` name. Asking for `'gesetz-syntax.import'` therefore
         * matched nothing, so imports, calls, exports and structure all came back
         * empty and every syntax-backed rule — architecture boundaries, cycle
         * detection, import rules, docstring and naming rules that read structure
         * — silently reported zero violations.
         *
         * Filtering on both fields keeps other extensions that happen to use a
         * type called `import` out of the result.
         */
        const syntaxMarkers = <D>(kind: string): readonly FileMarker<D>[] =>
          networkFile.markers.filter(
            (m) => m.extension === SYNTAX_EXTENSION && m.type === kind,
          ) as readonly FileMarker<D>[];

        const imports: ParsedImport[] = options.imports
          ? syntaxMarkers<{ specifier: string; names: readonly string[]; line: number }>(
              'import',
            ).map((m) => ({ specifier: m.data.specifier, names: m.data.names, line: m.data.line }))
          : [];
        const calls: ParsedCall[] = options.calls
          ? syntaxMarkers<{ name: string; line: number }>('call').map((m) => ({
              name: m.data.name,
              line: m.data.line,
            }))
          : [];
        const exports_: ParsedExport[] = options.exports
          ? syntaxMarkers<{ name: string; kind: string; line: number }>('export').map((m) => ({
              name: m.data.name,
              kind: m.data.kind,
              line: m.data.line,
            }))
          : [];
        const structure: StructureItem[] = options.structure
          ? syntaxMarkers<StructureItem>('structure').map((m) => m.data)
          : [];

        return { imports, calls, exports: exports_, structure };
      },
    },

    imports: {
      resolve(fromFile, specifier): string | null {
        const resolver = resolverForLanguage(languageForExt(fromFile.ext));
        const resolution = resolver.resolve(specifier, fromFile.path, cachedPaths);
        return resolution.kind === 'resolved' ? nodePath.join(rootDir, resolution.path) : null;
      },
    },
  };
}
