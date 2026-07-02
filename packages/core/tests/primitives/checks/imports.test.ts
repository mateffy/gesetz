import { describe, it, expect } from 'vitest';
import { noImportFrom, requireImportFrom } from '../../../src/primitives/checks/imports';
import { buildCheckServices } from '../../helpers/services';
import { SyntaxTreeStub } from '../../../src/services/syntax-tree';
import { ProjectRootLive } from '../../../src/services/fs';
import { ImportResolverDefault } from '../../../src/services/import-resolver';
import type { File } from '../../../src/engine/rule';

function makeFile(content: string, path = 'src/foo.ts'): File {
  return {
    path,
    absolutePath: `/abs/${path}`,
    name: 'foo.ts',
    stem: 'foo',
    ext: '.ts',
    dir: 'src',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// Provide SyntaxTreeStub so canProcess() returns false and the checks use
// the regex fallback (the behaviour these tests validate).
async function makeServices() {
  return buildCheckServices(
    SyntaxTreeStub,
    ProjectRootLive('/abs'),
    ImportResolverDefault,
  );
}

describe('noImportFrom', () => {
  it('passes when the module is not imported', async () => {
    const file = makeFile(`import React from 'react';`);
    const services = await makeServices();
    const violations = await noImportFrom('@tanstack/react-query')(file, services);
    expect(violations).toHaveLength(0);
  });

  it('fails when the exact module is imported', async () => {
    const file = makeFile(`import { useQuery } from '@tanstack/react-query';`);
    const services = await makeServices();
    const violations = await noImportFrom('@tanstack/react-query')(file, services);
    expect(violations).toHaveLength(1);
  });

  it('fails for subpath imports', async () => {
    const file = makeFile(`import { something } from '@tanstack/react-query/internals';`);
    const services = await makeServices();
    const violations = await noImportFrom('@tanstack/react-query')(file, services);
    expect(violations).toHaveLength(1);
  });

  it('uses regex matching', async () => {
    const file = makeFile(`import { x } from 'sdk/generated/types.gen';`);
    const services = await makeServices();
    const violations = await noImportFrom(/sdk\/generated/)(file, services);
    expect(violations).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const file = makeFile(`import { x } from 'bad-module';`);
    const services = await makeServices();
    const violations = await noImportFrom('bad-module', { message: 'Do not use bad-module' })(file, services);
    expect(violations[0]?.message).toBe('Do not use bad-module');
  });

  it('catches dynamic imports', async () => {
    const file = makeFile(`const m = await import('forbidden-pkg');`);
    const services = await makeServices();
    const violations = await noImportFrom('forbidden-pkg')(file, services);
    expect(violations).toHaveLength(1);
  });
});

describe('requireImportFrom', () => {
  it('passes when the module is imported', async () => {
    const file = makeFile(`import { describe } from 'vitest';`);
    const services = await makeServices();
    const violations = await requireImportFrom('vitest')(file, services);
    expect(violations).toHaveLength(0);
  });

  it('fails when the module is not imported', async () => {
    const file = makeFile(`// no imports`);
    const services = await makeServices();
    const violations = await requireImportFrom('vitest')(file, services);
    expect(violations).toHaveLength(1);
  });
});
