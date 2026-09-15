import type { CheckServices, Check, File, Violation } from '../../engine/rule';

/**
 * Simple regex fallback for extracting import specifiers from JS/TS-like
 * source. Used when no SyntaxBackend is registered for the file's extension,
 * so users who haven't added adapters yet keep the existing behaviour.
 */
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

/**
 * Import entries for a file: the syntax backend when it handles the extension,
 * otherwise a regex scan of the source.
 *
 * Shared by the import checks so the "no backend, or a parse failure, falls back
 * to regex" rule lives in one place. Only the regex path leaves `line` undefined.
 */
async function importEntries(
  file: File,
  syntax: CheckServices['syntax'],
): Promise<readonly { specifier: string; line?: number | undefined }[]> {
  const viaRegex = (): { specifier: string }[] =>
    regexExtractImports(file.content).map((specifier) => ({ specifier }));

  if (!syntax.canProcess(file)) return viaRegex();

  try {
    const result = await syntax.process(file, { imports: true });
    return result.imports.map((imp) => ({ specifier: imp.specifier, line: imp.line }));
  } catch {
    return viaRegex();
  }
}

/**
 * Checks that the file does not import from a given module.
 * The module can be a string (exact match or prefix) or a RegExp.
 *
 * Uses `SyntaxTree.extractImports` when a backend is registered for the
 * file's extension; otherwise falls back to a JS/TS regex.
 *
 * @example
 * // Components must not use @tanstack/react-query directly
 * noImportFrom('@tanstack/react-query', { message: 'Use SDK hooks instead' })
 */
export function noImportFrom(
  module: string | RegExp,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  const matcher =
    typeof module === 'string'
      ? (specifier: string) => specifier === module || specifier.startsWith(module + '/')
      : (specifier: string) => module.test(specifier);

  const label = typeof module === 'string' ? module : module.source;

  return async (file, services) => {
    const violations: Violation[] = [];

    for (const { specifier, line } of await importEntries(file, services.syntax)) {
      if (!matcher(specifier)) continue;
      violations.push({
        severity: opts.severity ?? 'error',
        source: 'core',
        message: opts.message ?? `Forbidden import from '${label}'`,
        path: file.path,
        ...(line !== undefined ? { line } : {}),
      });
    }

    return violations;
  };
}

/**
 * Checks that the file imports from a given module (at least once).
 *
 * @example
 * // All test files must import from vitest
 * requireImportFrom('vitest')
 */
export function requireImportFrom(
  module: string | RegExp,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  const matcher =
    typeof module === 'string'
      ? (specifier: string) => specifier === module || specifier.startsWith(module + '/')
      : (specifier: string) => module.test(specifier);

  const label = typeof module === 'string' ? module : module.source;

  return async (file, services) => {
    const specifiers = (await importEntries(file, services.syntax)).map((e) => e.specifier);

    if (specifiers.some(matcher)) return [];

    return [
      {
        severity: opts.severity ?? 'error',
        source: 'core',
        message: opts.message ?? `Missing required import from '${label}'`,
        path: file.path,
      },
    ];
  };
}
