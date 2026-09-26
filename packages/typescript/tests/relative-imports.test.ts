import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import { relativeImports } from '../src';

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

describe('relativeImports (moved from core)', () => {
  it('passes when all relative imports resolve', async () => {
    const file = makeFile(
      'src/foo.ts',
      `import { x } from './bar';\nimport { y } from './baz/index';`,
    );
    const services = makeCheckServices({
      projectRoot: CWD,
      files: {
        [nodePath.resolve(CWD, 'src/bar.ts')]: '',
        [nodePath.resolve(CWD, 'src/baz/index.ts')]: '',
      },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it('fails when a relative import does not resolve', async () => {
    const file = makeFile('src/foo.ts', `import { x } from './missing';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('./missing');
  });

  it('ignores non-relative imports', async () => {
    const file = makeFile('src/foo.ts', `import React from 'react';\nimport { z } from 'zod';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it('resolves .tsx extensions', async () => {
    const file = makeFile('src/foo.ts', `import { Comp } from './Comp';`);
    const services = makeCheckServices({
      projectRoot: CWD,
      files: { [nodePath.resolve(CWD, 'src/Comp.tsx')]: '' },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });
});
