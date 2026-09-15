/**
 * Memoized parsers for TypeScript/JavaScript syntax work.
 *
 * The same file content is parsed many times per run: once per ast-grep based
 * check (`checks/shared.ts#parseFile`), once per SyntaxBackend extractor kind
 * (`syntax-backend.ts`), and once for every consumer of `services.syntax`.
 * Parsing dominates the cost of a cold `gesetz check`, and the result is a pure
 * function of the content, so both layers share these content-keyed caches.
 *
 * Keys include the parser-relevant file extension, so identical content parsed
 * as `.ts` and as `.tsx` are distinct entries. Caches are bounded: gesetz runs
 * rules file-major, so only a handful of entries are ever live at once, and the
 * cap keeps memory flat on large repositories.
 */
import { js, jsx, ts, tsx } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import { parseSync as oxcParseSync, type ParseResult } from 'oxc-parser';

/** Maximum entries per cache. File-major execution means a handful are live. */
const MAX_ENTRIES = 64;

/** Pick the ast-grep parser for a file extension (including the dot). */
export function pickAstGrepParser(ext: string): typeof ts {
  if (ext === '.tsx') return tsx;
  if (ext === '.jsx') return jsx;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return js;
  return ts; // default to ts for .ts, .d.ts, etc.
}

function evictOldest<K, V>(cache: Map<K, V>): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}

function memoize<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const value = compute();
  cache.set(key, value);
  evictOldest(cache);
  return value;
}

const astGrepCache = new Map<string, SgNode | null>();
const oxcCache = new Map<string, ParseResult | null>();

/** Parses `content` with ast-grep, memoized by (extension, content). */
export function parseAstGrep(content: string, ext: string): SgNode | null {
  return memoize(astGrepCache, `${ext}\u0000${content}`, () => {
    try {
      return pickAstGrepParser(ext).parse(content).root();
    } catch {
      return null;
    }
  });
}

/** Parses `content` with oxc-parser, memoized by (filename, content). */
export function parseOxc(content: string, filePath: string): ParseResult | null {
  return memoize(oxcCache, `${filePath}\u0000${content}`, () => {
    try {
      return oxcParseSync(filePath, content, { sourceType: 'module' });
    } catch {
      return null;
    }
  });
}
