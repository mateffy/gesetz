import { describe, it, expect } from 'vitest';
import { noDebugLogging } from '../../../src/primitives/checks/debug-logging';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

describe('noDebugLogging', () => {
  it('flags console.log in .ts files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.ts', 'console.log("hi");\nconst x = 1;'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
    expect(v[0]?.message).toContain('console.log');
  });

  it('flags console.warn and console.error in .ts files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.ts', 'console.warn("w");\nconsole.error("e");'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('flags console.log in .tsx, .js, .jsx, .mjs, .cjs', async () => {
    for (const name of ['a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      const v = await runCheck(noDebugLogging(), makeFile(`src/${name}`, 'console.log("x");'), makeCheckServices());
      expect(v).toHaveLength(1);
    }
  });

  it('flags print() in .py files but NOT console.log', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.py', 'print("hi")\n# console.log is not a python thing'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('print');
  });

  it('flags pprint and breakpoint in .py files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.py', 'pprint(x)\nbreakpoint()'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('flags var_dump and dd in .php files but NOT print()', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.php', 'var_dump($x);\ndd($y);\necho "ok";'), makeCheckServices());
    expect(v).toHaveLength(2);
    expect(v.some((x) => x.message.includes('var_dump'))).toBe(true);
    expect(v.some((x) => x.message.includes('dd'))).toBe(true);
  });

  it('flags fmt.Println in .go files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.go', 'fmt.Println("hi")\nlog.Printf("x")'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('flags println! and dbg! in .rs files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.rs', 'println!("hi")\ndbg!(x)'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('flags puts and pp in .rb files', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.rb', 'puts("hi")\npp(obj)'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('returns [] for unknown extensions', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.unknown', 'console.log("x");\nprint("y");'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('does not flag partial-name matches (e.g. myconsole.log)', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.ts', 'myconsole.log("x");\nnotconsole.log("y");'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('respects extraNames option (added to all extensions)', async () => {
    const v = await runCheck(noDebugLogging({ extraNames: ['myDebugFn'] }), makeFile('src/foo.ts', 'myDebugFn(x);\nconsole.log("y");'), makeCheckServices());
    expect(v).toHaveLength(2);
  });

  it('respects custom severity', async () => {
    const v = await runCheck(noDebugLogging({ severity: 'error' }), makeFile('src/foo.ts', 'console.log("x");'), makeCheckServices());
    expect(v[0]?.severity).toBe('error');
  });

  it('respects custom message', async () => {
    const v = await runCheck(noDebugLogging({ message: 'No logging!' }), makeFile('src/foo.ts', 'console.log("x");'), makeCheckServices());
    expect(v[0]?.message).toBe('No logging!');
  });

  it('emits at most one violation per line', async () => {
    const v = await runCheck(noDebugLogging(), makeFile('src/foo.ts', 'console.log("a"); console.log("b");'), makeCheckServices());
    expect(v).toHaveLength(1);
  });
});