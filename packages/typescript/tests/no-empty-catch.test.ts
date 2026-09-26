import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import { noEmptyCatch } from '../src';

// ─── Pure sync checks — need no services at all ─────────────────────────────

describe('noEmptyCatch (moved from core)', () => {
  it('flags empty catch block', async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile('src/foo.ts', 'try { x(); } catch { \n }'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-empty-catch');
  });

  it('passes when catch has a body', async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile('src/foo.ts', 'try {\n  x();\n} catch (e) {\n  log(e);\n}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});
