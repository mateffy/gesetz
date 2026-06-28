/**
 * SyntaxTree — abstract service tag + router factory.
 *
 * Core defines the `SyntaxBackend` interface (a plain object, NOT an Effect
 * Layer). Language adapters export `SyntaxBackend` objects. Core's
 * `SyntaxTreeLive(backends)` factory creates ONE Effect Layer that routes
 * requests to the correct backend by file extension.
 *
 * This avoids the polyglot conflict: each adapter does NOT provide its own
 * `SyntaxTree` Layer (they would conflict in a polyglot project — Effect
 * allows only one implementation of a service). Instead, users declare all
 * their backends once in `defineConfig({ adapters })` and the runner wires
 * `SyntaxTreeLive(config.adapters)` automatically.
 *
 * Core has zero parser dependencies — it only defines the contract.
 */
import { Context, Data, Effect, Layer } from 'effect';
import type { File } from '../engine/rule';

// ─── Parsed data shapes ──────────────────────────────────────────────────────

export interface ParsedImport {
  /** The module specifier, e.g. "react", "./foo", "Illuminate\\Models\\User" */
  readonly specifier: string;
  /** Named imports, e.g. ["useState", "useEffect"]. Empty for bare/wildcard imports. */
  readonly names: readonly string[];
  /** 1-indexed line number */
  readonly line: number;
}

export interface ParsedCall {
  /** The full function name including any member access, e.g. "console.log", "dd", "fmt.Println" */
  readonly name: string;
  /** 1-indexed line number */
  readonly line: number;
}

export interface ParsedExport {
  /** The exported identifier name, e.g. "doThing", "UserService" */
  readonly name: string;
  /** Kind string, lowercase: "function", "class", "const", "type", "interface", "enum" */
  readonly kind: string;
  /** 1-indexed line number */
  readonly line: number;
}

export interface StructureItem {
  /** Lowercase kind: "function", "class", "method", "interface", "enum", "struct", etc. */
  readonly kind: string;
  /** The name of the item */
  readonly name: string;
  /** 1-indexed start line */
  readonly startLine: number;
  /** 1-indexed end line */
  readonly endLine: number;
  /** Attached docstring text, if any and if requested. null if absent. */
  readonly docstring: string | null;
  /** Nested items (methods inside a class, etc.) */
  readonly children: readonly StructureItem[];
}

export interface SyntaxBackendProcessResult {
  readonly imports: readonly ParsedImport[];
  readonly calls: readonly ParsedCall[];
  readonly exports: readonly ParsedExport[];
  readonly structure: readonly StructureItem[];
}

// ─── SyntaxBackend interface (plain object) ──────────────────────────────────

/**
 * A SyntaxBackend is a plain object (NOT an Effect Layer) that provides
 * language-specific structural extraction for a set of file extensions.
 * Adapters export these objects. Core's `SyntaxTreeLive()` routes to the
 * correct backend by file extension.
 */
export interface SyntaxBackend {
  /** File extensions this backend handles. Include the dot, e.g. ['.ts', '.tsx'] */
  readonly extensions: readonly string[];
  extractImports(content: string, filePath: string): ParsedImport[];
  extractCalls(content: string, filePath: string): ParsedCall[];
  extractExports(content: string, filePath: string): ParsedExport[];
  /** includeDocstrings: whether to populate StructureItem.docstring */
  extractStructure(content: string, filePath: string, includeDocstrings: boolean): StructureItem[];
}

// ─── SyntaxTree service ──────────────────────────────────────────────────────

export interface SyntaxTreeProcessOptions {
  readonly imports?: boolean;
  readonly calls?: boolean;
  readonly exports?: boolean;
  readonly structure?: boolean;
  /** only meaningful when structure: true */
  readonly docstrings?: boolean;
}

export interface SyntaxTreeService {
  /** Returns true if a SyntaxBackend is registered for this file's extension */
  canProcess(file: File): boolean;
  /** Extract structured data from a file using the registered backend for its extension */
  process(
    file: File,
    options: SyntaxTreeProcessOptions,
  ): Effect.Effect<SyntaxBackendProcessResult, SyntaxTreeError>;
}

export class SyntaxTree extends Context.Tag('gesetz/SyntaxTree')<SyntaxTree, SyntaxTreeService>() {}

export class SyntaxTreeError extends Data.TaggedError('SyntaxTreeError')<{
  readonly cause: string;
}> {}

const EMPTY_RESULT: SyntaxBackendProcessResult = {
  imports: [],
  calls: [],
  exports: [],
  structure: [],
};

/**
 * Creates the live SyntaxTree service from a list of SyntaxBackend objects.
 * Routes to the correct backend by file extension. First registered backend
 * wins for a given extension.
 */
export function SyntaxTreeLive(backends: readonly SyntaxBackend[]): Layer.Layer<SyntaxTree> {
  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) {
        byExt.set(ext, backend);
      }
    }
  }

  return Layer.succeed(SyntaxTree, {
    canProcess: (file) => byExt.has(file.ext),
    process: (file, opts) =>
      Effect.try({
        try: () => {
          const backend = byExt.get(file.ext);
          if (!backend) {
            return EMPTY_RESULT;
          }
          return {
            imports: opts.imports ? backend.extractImports(file.content, file.path) : [],
            calls: opts.calls ? backend.extractCalls(file.content, file.path) : [],
            exports: opts.exports ? backend.extractExports(file.content, file.path) : [],
            structure: opts.structure
              ? backend.extractStructure(file.content, file.path, opts.docstrings ?? false)
              : [],
          };
        },
        catch: (e) => new SyntaxTreeError({ cause: String(e) }),
      }),
  });
}

/**
 * Stub for tests that don't need any parsing.
 * Reports no backend as available; `process` always fails.
 */
export const SyntaxTreeStub: Layer.Layer<SyntaxTree> = Layer.succeed(SyntaxTree, {
  canProcess: () => false,
  process: (_file, _opts) =>
    Effect.fail(new SyntaxTreeError({ cause: 'SyntaxTreeStub — register a backend' })),
});
