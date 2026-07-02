import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { Layer } from 'effect';
import { requireSibling, forbidFile } from '../../../src/primitives/checks/fs';
import { MemoryFileSystem, ProjectRootLive } from '../../../src/services/fs';
import { SyntaxTreeStub } from '../../../src/services/syntax-tree';
import { ImportResolverDefault } from '../../../src/services/import-resolver';
import { buildCheckServices } from '../../helpers/services';
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

// Helper: builds CheckServices for the given in-memory files
async function makeServices(files: Record<string, string>) {
  return buildCheckServices(
    MemoryFileSystem(files),
    ProjectRootLive(CWD),
    SyntaxTreeStub,
    ImportResolverDefault,
  );
}

describe('requireSibling', () => {
  it('passes when sibling exists', async () => {
    const file = makeFile('src/Button.tsx');
    const siblingAbsPath = nodePath.resolve(CWD, 'src/Button.stories.tsx');
    const services = await makeServices({ [siblingAbsPath]: '' });
    const violations = await requireSibling('.stories.tsx')(file, services);
    expect(violations).toHaveLength(0);
  });

  it('fails when sibling is missing', async () => {
    const file = makeFile('src/Button.tsx');
    const services = await makeServices({});
    const violations = await requireSibling('.stories.tsx')(file, services);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Button.stories.tsx');
  });

  it('uses custom message when provided', async () => {
    const file = makeFile('src/Button.tsx');
    const services = await makeServices({});
    const violations = await requireSibling('.test.tsx', { message: 'Custom error message' })(file, services);
    expect(violations[0]?.message).toBe('Custom error message');
  });
});

describe('forbidFile', () => {
  it('always returns a violation for the matched file', async () => {
    const file = makeFile('src/legacy/old.ts');
    const services = await makeServices({});
    const violations = await forbidFile()(file, services);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('src/legacy/old.ts');
  });

  it('uses custom message', async () => {
    const file = makeFile('src/foo.ts');
    const services = await makeServices({});
    const violations = await forbidFile({ message: 'Do not use this file' })(file, services);
    expect(violations[0]?.message).toBe('Do not use this file');
  });
});
