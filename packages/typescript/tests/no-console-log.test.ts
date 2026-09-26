import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

import { noConsoleLog } from '../src';

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

describe('noConsoleLog (moved from core)', () => {
  it('flags console.log', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', 'console.log("hello");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-console-log');
  });

  it('flags warn and error by default', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });

  it('allows warn and error when allowWarnError is true', async () => {
    const v = await runCheck(
      noConsoleLog({ allowWarnError: true }),
      makeFile('src/foo.ts', 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('does not report a mention of console.log inside a comment', async () => {
    // Regression: this rule's own docblock example was reported as a violation.
    const v = await runCheck(
      noConsoleLog(),
      makeFile(
        'src/foo.ts',
        [
          '// e.g. "console.log(" matches but "notconsole.log(" does not',
          '/* console.log(1) */',
          ' * console.log(2)',
        ].join('\n'),
      ),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('still reports a real call, including one before a trailing comment', async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile('src/foo.ts', ['console.log(x);', 'console.info(y); // still a call'].join('\n')),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });
});
