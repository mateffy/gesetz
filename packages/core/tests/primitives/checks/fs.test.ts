import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { requireSibling, forbidFile } from '../../../src/primitives/checks/fs';
import { MemoryFileSystem } from '../../../src/services/fs';
import type { File } from '../../../src/engine/rule';

const CWD = process.cwd();

function makeFile(path: string, content = ''): File {
  const absolutePath = nodePath.resolve(CWD, path);
  const name = nodePath.basename(path);
  const ext = nodePath.extname(name);
  return {
    path,
    absolutePath,
    name,
    stem: name.slice(0, name.length - ext.length),
    ext,
    dir: nodePath.dirname(path),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// Helper: runs a Check against the given in-memory files
const runCheck = (files: Record<string, string>) =>
  (effect: Effect.Effect<unknown, unknown, any>): Promise<any> => {
    const layer = Layer.mergeAll(MemoryFileSystem(files));
    return Effect.provide(effect, layer).pipe(Effect.runPromise as any);
  };

describe('requireSibling', () => {
  it('passes when sibling exists', async () => {
    const file = makeFile('src/Button.tsx');
    const siblingAbsPath = nodePath.resolve(CWD, 'src/Button.stories.tsx');
    const run = runCheck({ [siblingAbsPath]: '' });
    const violations = await run(requireSibling('.stories.tsx')(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when sibling is missing', async () => {
    const file = makeFile('src/Button.tsx');
    const run = runCheck({});
    const violations = await run(requireSibling('.stories.tsx')(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Button.stories.tsx');
  });

  it('uses custom message when provided', async () => {
    const file = makeFile('src/Button.tsx');
    const run = runCheck({});
    const violations = await run(requireSibling('.test.tsx', { message: 'Custom error message' })(file));
    expect(violations[0]?.message).toBe('Custom error message');
  });
});

describe('forbidFile', () => {
  it('always returns a violation for the matched file', async () => {
    const file = makeFile('src/legacy/old.ts');
    const run = runCheck({});
    const violations = await run(forbidFile()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('src/legacy/old.ts');
  });

  it('uses custom message', async () => {
    const file = makeFile('src/foo.ts');
    const run = runCheck({});
    const violations = await run(forbidFile({ message: 'Do not use this file' })(file));
    expect(violations[0]?.message).toBe('Do not use this file');
  });
});
