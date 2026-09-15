/**
 * CheckServices built from a plain file listing plus lazily-computed syntax.
 *
 * Implements the exact v2.0 `CheckServices` contract, so every existing Check
 * in the @gesetz/* packages runs unmodified:
 *
 *   fs.glob/readFile/exists  → the project file listing (+ disk access)
 *   syntax.process           → backend extraction, memoized per file
 *   imports.resolve          → relative-path resolution
 *
 * Syntax is computed on demand. A file that no rule asks to parse is never
 * parsed, and a file parsed for one kind (imports, calls, exports, structure)
 * is only parsed again when a different kind is requested.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import micromatch from 'micromatch';
import type { CheckServices, File } from '../engine/rule';
import type {
  ParsedCall,
  ParsedExport,
  ParsedImport,
  StructureItem,
  SyntaxBackend,
  SyntaxBackendProcessResult,
  SyntaxTreeProcessOptions,
} from './syntax-tree';
import { buildFile } from './fs';

export interface CreateCheckServicesInput {
  readonly rootDir: string;
  readonly backends: readonly SyntaxBackend[];
  /** Every non-ignored project file, repo-relative with posix separators. */
  readonly allPaths: readonly string[];
}

/** Per-file memo of backend extraction results. */
interface SyntaxSlot {
  imports?: readonly ParsedImport[];
  calls?: readonly ParsedCall[];
  exports?: readonly ParsedExport[];
  structure?: readonly StructureItem[];
  structureWithDocstrings?: readonly StructureItem[];
}

function readFileOrEmpty(absolutePath: string): string {
  try {
    return nodeFs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Returns the cached structure extraction, computing it once per (file, mode).
 * Split out of `process` because the docstring variant made the inline ternary
 * deeply nested.
 */
function structureMarkers(
  backend: SyntaxBackend,
  slot: SyntaxSlot,
  content: string,
  filePath: string,
  withDocstrings: boolean,
): readonly StructureItem[] {
  if (withDocstrings) {
    return (slot.structureWithDocstrings ??= backend.extractStructure(content, filePath, true));
  }
  return (slot.structure ??= backend.extractStructure(content, filePath, false));
}

/** Builds the CheckServices bag over a project file listing. */
export function createCheckServices(input: CreateCheckServicesInput): CheckServices {
  const { rootDir, backends, allPaths } = input;

  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) byExt.set(ext, backend);
    }
  }

  const slots = new Map<string, SyntaxSlot>();

  function fileFor(relativePath: string): File {
    const absolutePath = nodePath.join(rootDir, relativePath);
    let stat: nodeFs.Stats | null = null;
    try {
      stat = nodeFs.statSync(absolutePath);
    } catch {
      stat = null;
    }
    return buildFile(relativePath, absolutePath, () => readFileOrEmpty(absolutePath), stat);
  }

  return {
    projectRoot: rootDir,

    fs: {
      async glob(pattern: string | string[]): Promise<File[]> {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        return allPaths
          .filter((path) => micromatch.isMatch(path, patterns, { dot: true }))
          .map((path) => fileFor(path));
      },

      async readFile(absolutePath: string): Promise<string> {
        return readFileOrEmpty(absolutePath);
      },

      async exists(absolutePath: string): Promise<boolean> {
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

        let slot = slots.get(file.path);
        if (slot === undefined) {
          slot = {};
          slots.set(file.path, slot);
        }

        const content = file.content;
        const withDocstrings = options.docstrings === true;

        return {
          imports: options.imports
            ? (slot.imports ??= backend.extractImports(content, file.path))
            : [],
          calls: options.calls ? (slot.calls ??= backend.extractCalls(content, file.path)) : [],
          exports: options.exports
            ? (slot.exports ??= backend.extractExports(content, file.path))
            : [],
          structure: options.structure
            ? structureMarkers(backend, slot, content, file.path, withDocstrings)
            : [],
        };
      },
    },

    imports: {
      resolve(fromFile, specifier): string | null {
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
        return nodePath.resolve(nodePath.dirname(fromFile.absolutePath), specifier);
      },
    },
  };
}
