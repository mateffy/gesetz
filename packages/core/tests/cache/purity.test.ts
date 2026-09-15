import { readdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CACHE_DIR = fileURLToPath(new URL('../../src/cache', import.meta.url));
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

describe('src/cache is dependency-free and self-contained', () => {
  const files = readdirSync(CACHE_DIR).filter((name) => name.endsWith('.ts'));

  it('contains the expected modules', () => {
    expect(files).toContain('kernel.ts');
    expect(files).toContain('types.ts');
    expect(files).toContain('store-memory.ts');
    expect(files).toContain('store-sqlite.ts');
    expect(files).toContain('drivers.ts');
  });

  for (const name of files) {
    it(`${name} imports only node: builtins and ./ siblings`, () => {
      const source = readFileSync(nodePath.join(CACHE_DIR, name), 'utf8');
      const specifiers = [...source.matchAll(IMPORT_RE)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        const ok = specifier.startsWith('node:') || specifier.startsWith('./');
        expect(ok, `${name} imports "${specifier}"`).toBe(true);
      }
    });
  }
});
