import { describe, it, expect } from 'vitest';
import { noGodFile, noDeepNesting, noDebuggingResidueFiles, noHardcodedSecret } from '../../../src/primitives/checks/structure';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

describe('noGodFile', () => {
  it('passes when file is under the limit', async () => {
    const v = await runCheck(noGodFile({ maxLines: 400 }), makeFile('src/foo.ts', 'line\n'.repeat(399)), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('fails when file exceeds the limit', async () => {
    const v = await runCheck(noGodFile({ maxLines: 400 }), makeFile('src/foo.ts', 'line\n'.repeat(400)), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('401 lines');
    expect(v[0]?.severity).toBe('warn');
  });

  it('uses custom message', async () => {
    const v = await runCheck(noGodFile({ maxLines: 400, message: 'Too big' }), makeFile('src/foo.ts', 'line\n'.repeat(500)), makeCheckServices());
    expect(v[0]?.message).toBe('Too big');
  });

  it('defaults to 400 lines', async () => {
    const v = await runCheck(noGodFile(), makeFile('src/foo.ts', 'line\n'.repeat(401)), makeCheckServices());
    expect(v).toHaveLength(1);
  });
});

describe('noDeepNesting', () => {
  it('passes when nesting is within limit', async () => {
    const v = await runCheck(noDeepNesting({ maxLevels: 4 }), makeFile('src/foo.ts', '    if (x) {\n      if (y) {\n        return;\n      }\n    }'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('fails when indentation exceeds limit', async () => {
    const v = await runCheck(noDeepNesting({ maxLevels: 2 }), makeFile('src/foo.ts', '      deep();'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });

  it('caps at 10 violations per file', async () => {
    const lines = Array.from({ length: 20 }, () => '      deep();').join('\n');
    const v = await runCheck(noDeepNesting({ maxLevels: 2 }), makeFile('src/foo.ts', lines), makeCheckServices());
    expect(v.length).toBeLessThanOrEqual(10);
  });

  it('skips empty lines', async () => {
    const v = await runCheck(noDeepNesting({ maxLevels: 2 }), makeFile('src/foo.ts', '\n\n      deep();'), makeCheckServices());
    expect(v).toHaveLength(1);
  });
});

describe('noDebuggingResidueFiles', () => {
  it('passes for normal filenames', async () => {
    const v = await runCheck(noDebuggingResidueFiles(), makeFile('src/Button.tsx'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('flags _backup files', async () => {
    const v = await runCheck(noDebuggingResidueFiles(), makeFile('src/old_backup.ts'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags _v2 files', async () => {
    const v = await runCheck(noDebuggingResidueFiles(), makeFile('src/config_v2.ts'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('flags temp files', async () => {
    const v = await runCheck(noDebuggingResidueFiles(), makeFile('src/fix_temp.tsx'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('flags delete_me files', async () => {
    const v = await runCheck(noDebuggingResidueFiles(), makeFile('src/foo_delete_me.tsx'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('supports extra patterns', async () => {
    const v = await runCheck(noDebuggingResidueFiles({ extraPatterns: [/\.draft\./i] }), makeFile('src/foo.draft.ts'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const v = await runCheck(noDebuggingResidueFiles({ message: 'Cleanup needed' }), makeFile('src/old_backup.ts'), makeCheckServices());
    expect(v[0]?.message).toBe('Cleanup needed');
  });
});

describe('noHardcodedSecret', () => {
  it('passes when no secrets are present', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const url = "https://example.com";'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('flags api_key assignment', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const api_key = "sk-1234567890abcdef";'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags access_token in object', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const headers = { access_token: "bearer-secret-12345" };'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('flags password string', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const password = "supersecret123";'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('does not flag standalone Bearer tokens (not a key assignment)', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const auth = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('ignores short strings', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const token = "abc";'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const v = await runCheck(noHardcodedSecret({ message: 'Rotate this' }), makeFile('src/foo.ts', 'const api_key = "secret12345678";'), makeCheckServices());
    expect(v[0]?.message).toBe('Rotate this');
  });

  it('reports line numbers', async () => {
    const v = await runCheck(noHardcodedSecret(), makeFile('src/foo.ts', 'const x = 1;\nconst api_key = "secret12345678";\nconst y = 2;'), makeCheckServices());
    expect(v[0]?.line).toBe(2);
  });
});