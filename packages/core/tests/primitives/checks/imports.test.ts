import { describe, it, expect } from 'vitest';
import { noImportFrom, requireImportFrom } from '../../../src/primitives/checks/imports';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

// The imports checks try SyntaxTree first, then fall back to regex extraction.
// Use canProcess: false to force the regex fallback path in tests.
function svcs() {
  return makeCheckServices({
    projectRoot: '/abs',
    overrides: { syntax: { canProcess: () => false } },
  });
}

describe('noImportFrom', () => {
  it('passes when the module is not imported', async () => {
    const v = await runCheck(
      noImportFrom('@tanstack/react-query'),
      makeFile('src/foo.ts', `import React from 'react';`),
      svcs(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when the exact module is imported', async () => {
    const v = await runCheck(
      noImportFrom('@tanstack/react-query'),
      makeFile('src/foo.ts', `import { useQuery } from '@tanstack/react-query';`),
      svcs(),
    );
    expect(v).toHaveLength(1);
  });

  it('fails for subpath imports', async () => {
    const v = await runCheck(
      noImportFrom('@tanstack/react-query'),
      makeFile('src/foo.ts', `import { something } from '@tanstack/react-query/internals';`),
      svcs(),
    );
    expect(v).toHaveLength(1);
  });

  it('uses regex matching', async () => {
    const v = await runCheck(
      noImportFrom(/sdk\/generated/),
      makeFile('src/foo.ts', `import { x } from 'sdk/generated/types.gen';`),
      svcs(),
    );
    expect(v).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      noImportFrom('bad-module', { message: 'Do not use bad-module' }),
      makeFile('src/foo.ts', `import { x } from 'bad-module';`),
      svcs(),
    );
    expect(v[0]?.message).toBe('Do not use bad-module');
  });

  it('catches dynamic imports', async () => {
    const v = await runCheck(
      noImportFrom('forbidden-pkg'),
      makeFile('src/foo.ts', `const m = await import('forbidden-pkg');`),
      svcs(),
    );
    expect(v).toHaveLength(1);
  });
});

describe('requireImportFrom', () => {
  it('passes when the module is imported', async () => {
    const v = await runCheck(
      requireImportFrom('vitest'),
      makeFile('src/foo.ts', `import { describe } from 'vitest';`),
      svcs(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when the module is not imported', async () => {
    const v = await runCheck(
      requireImportFrom('vitest'),
      makeFile('src/foo.ts', '// no imports'),
      svcs(),
    );
    expect(v).toHaveLength(1);
  });
});
