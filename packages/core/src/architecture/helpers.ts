/**
 * Pure helpers for the architecture rule.
 *
 * Extracted from `architecture.ts`, which was over the file line budget.
 * Nothing here touches Effect or the service layer, so the helpers can be read
 * and tested on their own.
 */


/** Returns true if the import path is a relative or absolute path, not a package. */
export function isRelativeImport(importPath: string): boolean {
  return importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('~');
}

/** Returns true if the import path is an external npm package. */
export function isExternalPackage(importPath: string): boolean {
  return !isRelativeImport(importPath);
}

/** Regex fallback for extracting import specifiers from JS/TS-like source. */
export function regexExtractImports(content: string): string[] {
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

export function bannedForForLayer(banned: string[], importPath: string): boolean {
  return banned.includes(importPath);
}
