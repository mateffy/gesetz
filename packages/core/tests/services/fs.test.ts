import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { FileSystem, FileSystemLive, MemoryFileSystem } from '../../src/services/fs';
import { FileReadError } from '../../src/engine/errors';

describe('FileSystem service — MemoryFileSystem', () => {
  it('exists returns true for known file', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const result = yield* fs.exists('/some/file.ts');
      expect(result).toBe(true);
    }).pipe(
      Effect.provide(MemoryFileSystem({ '/some/file.ts': 'hello' })),
      Effect.runPromise,
    );
  });

  it('exists returns false for unknown file', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const result = yield* fs.exists('/missing.ts');
      expect(result).toBe(false);
    }).pipe(
      Effect.provide(MemoryFileSystem({})),
      Effect.runPromise,
    );
  });

  it('readFile returns content for known file', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const content = yield* fs.readFile('/src/foo.ts');
      expect(content).toBe('export const x = 1;');
    }).pipe(
      Effect.provide(MemoryFileSystem({ '/src/foo.ts': 'export const x = 1;' })),
      Effect.runPromise,
    );
  });

  it('readFile fails with FileReadError for unknown file', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const result = yield* fs.readFile('/missing.ts').pipe(Effect.either);
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(FileReadError);
      }
    }).pipe(
      Effect.provide(MemoryFileSystem({})),
      Effect.runPromise,
    );
  });
});

describe('FileSystem service — FileSystemLive (integration)', () => {
  it('exists returns true for an existing file', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const result = yield* fs.exists(
        new URL('../../package.json', import.meta.url).pathname,
      );
      expect(result).toBe(true);
    }).pipe(
      Effect.provide(FileSystemLive),
      Effect.runPromise,
    );
  });

  it('readFile reads real files', async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem;
      const content = yield* fs.readFile(
        new URL('../../package.json', import.meta.url).pathname,
      );
      expect(content).toContain('@regeln/core');
    }).pipe(
      Effect.provide(FileSystemLive),
      Effect.runPromise,
    );
  });
});
