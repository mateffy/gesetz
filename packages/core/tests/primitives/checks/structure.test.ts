import { describe, it, expect } from 'vitest';
import {
  noGodFile,
  noDeepNesting,
  noDebuggingResidueFiles,
  noHardcodedSecret,
} from '../../../src/primitives/checks/structure';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

describe('noGodFile', () => {
  it('passes when file is under the limit', async () => {
    const v = await runCheck(
      noGodFile({ maxLines: 400 }),
      makeFile('src/foo.ts', 'line\n'.repeat(399)),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when file exceeds the limit', async () => {
    const v = await runCheck(
      noGodFile({ maxLines: 400 }),
      makeFile('src/foo.ts', 'line\n'.repeat(400)),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('401 lines');
    expect(v[0]?.severity).toBe('warn');
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      noGodFile({ maxLines: 400, message: 'Too big' }),
      makeFile('src/foo.ts', 'line\n'.repeat(500)),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Too big');
  });

  it('defaults to 400 lines', async () => {
    const v = await runCheck(
      noGodFile(),
      makeFile('src/foo.ts', 'line\n'.repeat(401)),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });
});

describe('noDeepNesting', () => {
  it('passes when nesting is within limit', async () => {
    const v = await runCheck(
      noDeepNesting({ maxLevels: 4 }),
      makeFile('src/foo.ts', '    if (x) {\n      if (y) {\n        return;\n      }\n    }'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when brace depth exceeds the limit', async () => {
    // function { if { for { w(); } } } — w() sits inside three open braces
    const deep = 'function a() {\n  if (x) {\n    for (const y of z) {\n      w();\n    }\n  }\n}';
    const v = await runCheck(
      noDeepNesting({ maxLevels: 2 }),
      makeFile('src/foo.ts', deep),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
    expect(v[0]?.message).toContain('3 levels deep');
  });

  it('ignores indentation that is layout rather than nesting', async () => {
    // Regression: depth came from indentation width, so a wrapped expression —
    // a chained call, a multi-line ternary — was reported as deep nesting. At
    // two-space indentation twelve columns scored as level six.
    const wrapped = [
      'function a() {',
      '  return items',
      '    .filter((x) => x.ok)',
      '    .map((x) => ({',
      '      id: x.id,',
      '      name: x.name,',
      '    }))',
      '    .join(",");',
      '}',
    ].join('\n');
    const v = await runCheck(
      noDeepNesting({ maxLevels: 2 }),
      makeFile('src/foo.ts', wrapped),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('reports one violation per deep region, not one per line', async () => {
    // Regression: every line of a block was reported and the list was then
    // truncated at ten behind a comment claiming it had deduplicated.
    const oneRegion =
      'function a() {\n  if (x) {\n    if (y) {\n      if (z) {\n        w();\n        u();\n        t();\n      }\n    }\n  }\n}';
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', oneRegion),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('is not capped at ten violations', async () => {
    const lines = Array.from(
      { length: 20 },
      () => 'function f() { if (a) { if (b) { if (c) { x(); } } } }',
    ).join('\n');
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', lines),
      makeCheckServices(),
    );
    expect(v.length).toBe(20);
  });

  it('sees a whole nest written on one line', async () => {
    // Regression: depth was sampled only at line start, so a minified or
    // generated line beginning and ending at depth zero was invisible.
    const oneLine = 'function f() { if (a) { if (b) { if (c) { x(); } } } }';
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', oneLine),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('4 levels deep');
  });

  it('reports each of two separate deep regions', async () => {
    const two = [
      'function a() { if (x) { if (y) { if (z) { w(); } } } }',
      '',
      'function b() { if (x) { if (y) { if (z) { w(); } } } }',
    ].join('\n');
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', two),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
    expect(v[0]?.line).toBe(1);
    expect(v[1]?.line).toBe(3);
  });

  it('does not count braces inside strings or comments', async () => {
    const tricky = [
      'function a() {',
      '  if (x) {',
      '    // } } }',
      '    const s = "} } }";',
      '    return s;',
      '  }',
      '}',
    ].join('\n');
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', tricky),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('reports the peak depth reached in the region', async () => {
    const deeper =
      'function a() {\n  if (x) {\n    if (y) {\n      if (z) {\n        if (q) {\n          w();\n        }\n      }\n    }\n  }\n}';
    const v = await runCheck(
      noDeepNesting({ maxLevels: 3 }),
      makeFile('src/foo.ts', deeper),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('5 levels deep');
  });

  it('skips empty lines', async () => {
    const v = await runCheck(
      noDeepNesting({ maxLevels: 2 }),
      makeFile('src/foo.ts', '\n\nfunction a() { if (x) { if (y) { z(); } } }'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('tolerates unbalanced braces without throwing', async () => {
    const v = await runCheck(
      noDeepNesting({ maxLevels: 2 }),
      makeFile('src/foo.ts', '} } }\nfunction a() {'),
      makeCheckServices(),
    );
    expect(Array.isArray(v)).toBe(true);
  });
});

describe('noDebuggingResidueFiles', () => {
  it('passes for normal filenames', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles(),
      makeFile('src/Button.tsx'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('flags _backup files', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles(),
      makeFile('src/old_backup.ts'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags _v2 files', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles(),
      makeFile('src/config_v2.ts'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('flags temp files', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles(),
      makeFile('src/fix_temp.tsx'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('flags delete_me files', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles(),
      makeFile('src/foo_delete_me.tsx'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('supports extra patterns', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles({ extraPatterns: [/\.draft\./i] }),
      makeFile('src/foo.draft.ts'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      noDebuggingResidueFiles({ message: 'Cleanup needed' }),
      makeFile('src/old_backup.ts'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Cleanup needed');
  });
});

describe('noHardcodedSecret', () => {
  it('passes when no secrets are present', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const url = "https://example.com";'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('flags api_key assignment', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const api_key = "sk-1234567890abcdef";'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags access_token in object', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const headers = { access_token: "bearer-secret-12345" };'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('flags password string', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const password = "supersecret123";'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });

  it('does not flag standalone Bearer tokens (not a key assignment)', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const auth = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('ignores short strings', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const token = "abc";'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      noHardcodedSecret({ message: 'Rotate this' }),
      makeFile('src/foo.ts', 'const api_key = "secret12345678";'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Rotate this');
  });

  it('reports line numbers', async () => {
    const v = await runCheck(
      noHardcodedSecret(),
      makeFile('src/foo.ts', 'const x = 1;\nconst api_key = "secret12345678";\nconst y = 2;'),
      makeCheckServices(),
    );
    expect(v[0]?.line).toBe(2);
  });
});
