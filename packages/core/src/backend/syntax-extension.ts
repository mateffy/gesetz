/**
 * Syntax-marker extension.
 *
 * Wraps gesetz's existing SyntaxBackend implementations (oxc/ast-grep based,
 * from @gesetz/typescript, @gesetz/php, …) as ONE netzwerk extension. Each
 * changed file is parsed exactly once per scan; every rule then reads the
 * cached `gesetz-syntax.*` markers instead of re-parsing per rule.
 *
 * Marker shapes (public types are prefixed: `gesetz-syntax.call`, …):
 *   import    { specifier, names, line }            lines: [line]
 *   call      { name, line }                        lines: [line]
 *   export    { name, kind, line }                  lines: [line]
 *   structure StructureItem (nested, JSON)          lines: [startLine, endLine]
 */
import type { NetworkExtension } from 'netzwerk';
import type { FileMarker } from 'netzwerk';
import type { SyntaxBackend } from '../services/syntax-tree';

export const SYNTAX_EXTENSION = 'gesetz-syntax';

/**
 * Marker-shape version. Bump when any marker data shape changes — the
 * extension fingerprint includes it, so shape changes force a full rescan.
 */
export const SYNTAX_MARKERS_VERSION = '2';

function languageForExt(ext: string): string {
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.php') return 'php-laravel';
  return 'generic';
}

/** Bump-safe fingerprint: version + which backend claims which extensions. */
function fingerprintFor(backends: readonly SyntaxBackend[]): string {
  const material = backends.map((b) => b.extensions.join(',')).join('|');
  return `${SYNTAX_MARKERS_VERSION}:${material}`;
}

/**
 * Creates the syntax extension for the given backends. First registered
 * backend wins for a shared file extension (same rule as the legacy
 * SyntaxTreeLive router).
 */
export function syntaxExtension(backends: readonly SyntaxBackend[]): NetworkExtension {
  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) byExt.set(ext, backend);
    }
  }
  const include = [...byExt.keys()].map((ext) => `**/*${ext}`);

  return {
    name: SYNTAX_EXTENSION,
    fingerprint: fingerprintFor(backends),
    include,
    // Dependencies are not this project's source. netzwerk's discovery already
    // honours .gitignore, so this matters for a project whose .gitignore does not
    // list `node_modules` — the include globs below would otherwise parse every
    // bundled `.js` file in the dependency tree.
    exclude: ['.gesetz/**', '.git/**', 'node_modules/**'],

    process(file, content): readonly FileMarker[] {
      const dot = file.relativePath.lastIndexOf('.');
      const ext = dot === -1 ? '' : file.relativePath.slice(dot);
      const backend = byExt.get(ext);
      if (backend === undefined) return [];

      const language = languageForExt(ext);
      const markers: FileMarker[] = [];
      for (const imp of backend.extractImports(content, file.relativePath)) {
        // One marker carries two consumers' fields.
        //
        // netzwerk's `resolveImportEdges` reads `type: 'import'` and requires
        // string `data.file` and `data.language`; anything else is skipped
        // silently, which left the whole import graph empty and cycle detection
        // reporting nothing. `language` must be one of netzwerk's resolver keys
        // ('typescript', 'php-laravel', ...) because it drives resolution.
        //
        // gesetz's own `services.syntax.process` reads `specifier`, `names` and
        // `line` from the same marker.
        //
        // The previous `file-import` marker was a third shape that nothing
        // consumed: it is not a netzwerk marker type.
        markers.push({
          type: 'import',
          extension: SYNTAX_EXTENSION,
          data: {
            file: imp.specifier,
            language,
            specifier: imp.specifier,
            names: imp.names,
            line: imp.line,
          },
          lines: [imp.line],
        });
      }
      for (const call of backend.extractCalls(content, file.relativePath)) {
        markers.push({
          type: 'call',
          extension: SYNTAX_EXTENSION,
          data: { name: call.name, line: call.line },
          lines: [call.line],
        });
      }
      for (const exp of backend.extractExports(content, file.relativePath)) {
        markers.push({
          type: 'export',
          extension: SYNTAX_EXTENSION,
          data: { name: exp.name, kind: exp.kind, line: exp.line },
          lines: [exp.line],
        });
      }
      for (const item of backend.extractStructure(content, file.relativePath, true)) {
        markers.push({
          type: 'structure',
          extension: SYNTAX_EXTENSION,
          data: item as unknown as Record<string, unknown>,
          lines: [item.startLine, item.endLine],
        });
      }
      return markers;
    },
  };
}
