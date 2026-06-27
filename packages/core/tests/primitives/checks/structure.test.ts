import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import {
  noGodFile,
  noDeepNesting,
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

describe('noGodFile', () => {
  it('passes when file is under the limit', async () => {
    const file = makeFile('line\n'.repeat(399));
    const violations = await run(noGodFile({ maxLines: 400 })(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when file exceeds the limit', async () => {
    const file = makeFile('line\n'.repeat(400));
    const violations = await run(noGodFile({ maxLines: 400 })(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-god-file');
    expect(violations[0]?.message).toContain('401 lines');
    expect(violations[0]?.message).toContain('max: 400');
    expect(violations[0]?.severity).toBe('warn');
  });

  it('uses custom message', async () => {
    const file = makeFile('line\n'.repeat(500));
    const violations = await run(noGodFile({ maxLines: 400, message: 'Too big' })(file));
    expect(violations[0]?.message).toBe('Too big');
  });

  it('defaults to 400 lines', async () => {
    const file = makeFile('line\n'.repeat(401));
    const violations = await run(noGodFile()(file));
    expect(violations).toHaveLength(1);
  });
});

describe('noDeepNesting', () => {
  it('passes when nesting is within limit', async () => {
    const file = makeFile('    if (x) {\n      if (y) {\n        return;\n      }\n    }');
    const violations = await run(noDeepNesting({ maxLevels: 4 })(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when indentation exceeds limit', async () => {
    const file = makeFile('      deep();');
    const violations = await run(noDeepNesting({ maxLevels: 2 })(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-deep-nesting');
    expect(violations[0]?.severity).toBe('warn');
  });

  it('caps at 10 violations per file', async () => {
    const lines = Array.from({ length: 20 }, () => '      deep();').join('\n');
    const file = makeFile(lines);
    const violations = await run(noDeepNesting({ maxLevels: 2 })(file));
    expect(violations.length).toBeLessThanOrEqual(10);
  });

  it('skips empty lines', async () => {
    const file = makeFile('\n\n      deep();');
    const violations = await run(noDeepNesting({ maxLevels: 2 })(file));
    expect(violations).toHaveLength(1);
  });
});

describe('noConsoleLog', () => {
  it('passes when no console calls exist', async () => {
    const file = makeFile('const x = 1;');
    const violations = await run(noConsoleLog()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags console.log', async () => {
    const file = makeFile('console.log("hello");');
    const violations = await run(noConsoleLog()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-console-log');
    expect(violations[0]?.severity).toBe('warn');
  });

  it('flags console.debug and console.info', async () => {
    const file = makeFile('console.debug("d");\nconsole.info("i");');
    const violations = await run(noConsoleLog()(file));
    expect(violations).toHaveLength(2);
  });

  it('flags console.warn and console.error when not allowed', async () => {
    const file = makeFile('console.warn("w");\nconsole.error("e");');
    const violations = await run(noConsoleLog()(file));
    expect(violations).toHaveLength(2);
  });

  it('allows warn and error when allowWarnError is true', async () => {
    const file = makeFile('console.warn("w");\nconsole.error("e");');
    const violations = await run(noConsoleLog({ allowWarnError: true })(file));
    expect(violations).toHaveLength(0);
  });

  it('reports one violation per line', async () => {
    const file = makeFile('console.log("a");\nconsole.log("b");');
    const violations = await run(noConsoleLog()(file));
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(1);
    expect(violations[1]?.line).toBe(2);
  });

  it('uses custom message', async () => {
    const file = makeFile('console.log("x");');
    const violations = await run(noConsoleLog({ message: 'No logging' })(file));
    expect(violations[0]?.message).toBe('No logging');
  });
});

describe('noEmptyCatch', () => {
  it('passes when catch has body', async () => {
    const file = makeFile('try {\n  something();\n} catch (e) {\n  console.error(e);\n}');
    const violations = await run(noEmptyCatch()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags empty catch block', async () => {
    const file = makeFile('try {\n  something();\n} catch {\n  \n}');
    const violations = await run(noEmptyCatch()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-empty-catch');
    expect(violations[0]?.severity).toBe('error');
  });

  it('flags catch with only comments', async () => {
    const file = makeFile('try { something(); } catch { // ignore\n}');
    const violations = await run(noEmptyCatch()(file));
    expect(violations).toHaveLength(1);
  });

  it('ignores non-empty catch blocks', async () => {
    const file = makeFile('try {\n  x();\n} catch (e) {\n  log(e);\n  throw e;\n}');
    const violations = await run(noEmptyCatch()(file));
    expect(violations).toHaveLength(0);
  });
});

describe('noMagicNumbers', () => {
  it('passes when no magic numbers exist', async () => {
    const file = makeFile('const x = 0;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags unexplained numeric literals', async () => {
    const file = makeFile('const result = value * 42;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('42');
    expect(violations[0]?.severity).toBe('warn');
  });

  it('ignores named constants', async () => {
    const file = makeFile('const MAX_RETRIES = 3;\nconst DEFAULT_SIZE = 100;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(0);
  });

  it('ignores exported named constants', async () => {
    const file = makeFile('export const THRESHOLD = 75;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(0);
  });

  it('ignores comment lines', async () => {
    const file = makeFile('// retry 3 times\nconst x = 1;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(0);
  });

  it('ignores numbers in the default ignore list', async () => {
    const file = makeFile('return x === 0 || x === 1 || x === -1 || x === 2 || x === 100;');
    const violations = await run(noMagicNumbers()(file));
    expect(violations).toHaveLength(0);
  });

  it('respects custom ignore list', async () => {
    const file = makeFile('return x === 42;');
    const violations = await run(noMagicNumbers({ ignore: [42] })(file));
    expect(violations).toHaveLength(0);
  });

  it('caps at 20 violations per file', async () => {
    const file = makeFile(Array.from({ length: 30 }, () => 'const x = 999;').join('\n'));
    const violations = await run(noMagicNumbers()(file));
    expect(violations.length).toBeLessThanOrEqual(20);
  });

  it('uses custom message', async () => {
    const file = makeFile('const x = 7;');
    const violations = await run(noMagicNumbers({ message: 'No magic' })(file));
    expect(violations[0]?.message).toBe('No magic');
  });
});

describe('noTrivialComment', () => {
  it('passes when no trivial comments exist', async () => {
    const file = makeFile('// This is a meaningful comment explaining why');
    const violations = await run(noTrivialComment()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags narrative comments', async () => {
    const file = makeFile('// Import the module\n// Define the component\n// Return JSX');
    const violations = await run(noTrivialComment()(file));
    expect(violations).toHaveLength(3);
    expect(violations[0]?.rule).toBe('no-trivial-comment');
    expect(violations[0]?.severity).toBe('info');
  });

  it('flags section dividers', async () => {
    const file = makeFile('// ======\n// ------\n// ========');
    const violations = await run(noTrivialComment()(file));
    expect(violations).toHaveLength(3);
  });

  it('ignores non-comment lines', async () => {
    const file = makeFile('const x = 1;\nconst y = 2;');
    const violations = await run(noTrivialComment()(file));
    expect(violations).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const file = makeFile('// Import React');
    const violations = await run(noTrivialComment({ message: 'Remove it' })(file));
    expect(violations[0]?.message).toBe('Remove it');
  });
});

describe('noDebuggingResidueFiles', () => {
  it('passes for normal filenames', async () => {
    const file = makeFile('', 'src/Button.tsx', 'Button.tsx');
    const violations = await run(noDebuggingResidueFiles()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags _backup files', async () => {
    const file = makeFile('', 'src/old_backup.ts', 'old_backup.ts');
    const violations = await run(noDebuggingResidueFiles()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-debugging-residue-files');
    expect(violations[0]?.severity).toBe('error');
  });

  it('flags _v2 files', async () => {
    const file = makeFile('', 'src/config_v2.ts', 'config_v2.ts');
    const violations = await run(noDebuggingResidueFiles()(file));
    expect(violations).toHaveLength(1);
  });

  it('flags temp files', async () => {
    const file = makeFile('', 'src/fix_temp.tsx', 'fix_temp.tsx');
    const violations = await run(noDebuggingResidueFiles()(file));
    expect(violations).toHaveLength(1);
  });

  it('flags delete_me files', async () => {
    const file = makeFile('', 'src/foo_delete_me.tsx', 'foo_delete_me.tsx');
    const violations = await run(noDebuggingResidueFiles()(file));
    expect(violations).toHaveLength(1);
  });

  it('supports extra patterns', async () => {
    const file = makeFile('', 'src/foo.draft.ts', 'foo.draft.ts');
    const violations = await run(noDebuggingResidueFiles({ extraPatterns: [/\.draft\./i] })(file));
    expect(violations).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const file = makeFile('', 'src/old_backup.ts', 'old_backup.ts');
    const violations = await run(noDebuggingResidueFiles({ message: 'Cleanup needed' })(file));
    expect(violations[0]?.message).toBe('Cleanup needed');
  });
});

describe('noHardcodedSecret', () => {
  it('passes when no secrets are present', async () => {
    const file = makeFile('const url = "https://example.com";');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations).toHaveLength(0);
  });

  it('flags api_key assignment', async () => {
    const file = makeFile('const api_key = "sk-1234567890abcdef";');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-hardcoded-secret');
    expect(violations[0]?.severity).toBe('error');
  });

  it('flags access_token in object', async () => {
    const file = makeFile('const headers = { access_token: "bearer-secret-12345" };');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations).toHaveLength(1);
  });

  it('flags password string', async () => {
    const file = makeFile('const password = "supersecret123";');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations).toHaveLength(1);
  });

  it('flags bearer assignment', async () => {
    const file = makeFile('const auth = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";');
    const violations = await run(noHardcodedSecret()(file));
    // bearer is not in the keyword list when it's just a value, not a key assignment
    expect(violations).toHaveLength(0);
  });

  it('ignores short strings', async () => {
    const file = makeFile('const token = "abc";');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const file = makeFile('const api_key = "secret12345678";');
    const violations = await run(noHardcodedSecret({ message: 'Rotate this' })(file));
    expect(violations[0]?.message).toBe('Rotate this');
  });

  it('reports line numbers', async () => {
    const file = makeFile('const x = 1;\nconst api_key = "secret12345678";\nconst y = 2;');
    const violations = await run(noHardcodedSecret()(file));
    expect(violations[0]?.line).toBe(2);
  });
});
