import { describe, it, expect } from 'vitest';
import {
  noGodFile,
  noDeepNesting,
  noDebuggingResidueFiles,
  noHardcodedSecret,
} from '../../../src/primitives/checks/structure';
import type { File } from '../../../src/engine/rule';

function makeFile(content: string, path = 'src/foo.ts', name = 'foo.ts'): File {
  return {
    path,
    absolutePath: `/abs/${path}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: name.slice(name.lastIndexOf('.')) || '.ts',
    dir: path.split('/').slice(0, -1).join('/') || '.',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Stub services for checks that don't need them. */
const noServices = {} as any;

describe('noGodFile', () => {
  it('passes when file is under the limit', async () => {
    const file = makeFile('line\n'.repeat(399));
    const violations = await noGodFile({ maxLines: 400 })(file, noServices);
    expect(violations).toHaveLength(0);
  });

  it('fails when file exceeds the limit', async () => {
    const file = makeFile('line\n'.repeat(400));
    const violations = await noGodFile({ maxLines: 400 })(file, noServices);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('401 lines');
    expect(violations[0]?.message).toContain('max: 400');
    expect(violations[0]?.severity).toBe('warn');
  });

  it('uses custom message', async () => {
    const file = makeFile('line\n'.repeat(500));
    const violations = await noGodFile({ maxLines: 400, message: 'Too big' })(file, noServices);
    expect(violations[0]?.message).toBe('Too big');
  });

  it('defaults to 400 lines', async () => {
    const file = makeFile('line\n'.repeat(401));
    const violations = await noGodFile()(file, noServices);
    expect(violations).toHaveLength(1);
  });
});

describe('noDeepNesting', () => {
  it('passes when nesting is within limit', async () => {
    const file = makeFile('    if (x) {\n      if (y) {\n        return;\n      }\n    }');
    const violations = await noDeepNesting({ maxLevels: 4 })(file, noServices);
    expect(violations).toHaveLength(0);
  });

  it('fails when indentation exceeds limit', async () => {
    const file = makeFile('      deep();');
    const violations = await noDeepNesting({ maxLevels: 2 })(file, noServices);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('warn');
  });

  it('caps at 10 violations per file', async () => {
    const lines = Array.from({ length: 20 }, () => '      deep();').join('\n');
    const file = makeFile(lines);
    const violations = await noDeepNesting({ maxLevels: 2 })(file, noServices);
    expect(violations.length).toBeLessThanOrEqual(10);
  });

  it('skips empty lines', async () => {
    const file = makeFile('\n\n      deep();');
    const violations = await noDeepNesting({ maxLevels: 2 })(file, noServices);
    expect(violations).toHaveLength(1);
  });
});

describe('noDebuggingResidueFiles', () => {
  it('passes for normal filenames', async () => {
    const file = makeFile('', 'src/Button.tsx', 'Button.tsx');
    const violations = await noDebuggingResidueFiles()(file, noServices);
    expect(violations).toHaveLength(0);
  });

  it('flags _backup files', async () => {
    const file = makeFile('', 'src/old_backup.ts', 'old_backup.ts');
    const violations = await noDebuggingResidueFiles()(file, noServices);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
  });

  it('flags _v2 files', async () => {
    const file = makeFile('', 'src/config_v2.ts', 'config_v2.ts');
    const violations = await noDebuggingResidueFiles()(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('flags temp files', async () => {
    const file = makeFile('', 'src/fix_temp.tsx', 'fix_temp.tsx');
    const violations = await noDebuggingResidueFiles()(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('flags delete_me files', async () => {
    const file = makeFile('', 'src/foo_delete_me.tsx', 'foo_delete_me.tsx');
    const violations = await noDebuggingResidueFiles()(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('supports extra patterns', async () => {
    const file = makeFile('', 'src/foo.draft.ts', 'foo.draft.ts');
    const violations = await noDebuggingResidueFiles({ extraPatterns: [/\.draft\./i] })(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const file = makeFile('', 'src/old_backup.ts', 'old_backup.ts');
    const violations = await noDebuggingResidueFiles({ message: 'Cleanup needed' })(file, noServices);
    expect(violations[0]?.message).toBe('Cleanup needed');
  });
});

describe('noHardcodedSecret', () => {
  it('passes when no secrets are present', async () => {
    const file = makeFile('const url = "https://example.com";');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations).toHaveLength(0);
  });

  it('flags api_key assignment', async () => {
    const file = makeFile('const api_key = "sk-1234567890abcdef";');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
  });

  it('flags access_token in object', async () => {
    const file = makeFile('const headers = { access_token: "bearer-secret-12345" };');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('flags password string', async () => {
    const file = makeFile('const password = "supersecret123";');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations).toHaveLength(1);
  });

  it('flags bearer assignment', async () => {
    const file = makeFile('const auth = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";');
    const violations = await noHardcodedSecret()(file, noServices);
    // bearer is not in the keyword list when it's just a value, not a key assignment
    expect(violations).toHaveLength(0);
  });

  it('ignores short strings', async () => {
    const file = makeFile('const token = "abc";');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const file = makeFile('const api_key = "secret12345678";');
    const violations = await noHardcodedSecret({ message: 'Rotate this' })(file, noServices);
    expect(violations[0]?.message).toBe('Rotate this');
  });

  it('reports line numbers', async () => {
    const file = makeFile('const x = 1;\nconst api_key = "secret12345678";\nconst y = 2;');
    const violations = await noHardcodedSecret()(file, noServices);
    expect(violations[0]?.line).toBe(2);
  });
});
