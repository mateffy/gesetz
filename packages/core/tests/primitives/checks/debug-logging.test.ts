import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { noDebugLogging } from '../../../src/primitives/checks/debug-logging';
import type { File } from '../../../src/engine/rule';

function makeFile(content: string, name: string): File {
  const ext = name.slice(name.lastIndexOf('.')) || name;
  return {
    path: `src/${name}`,
    absolutePath: `/abs/src/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext,
    dir: 'src',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

describe('noDebugLogging', () => {
  it('flags console.log in .ts files', async () => {
    const file = makeFile('console.log("hi");\nconst x = 1;', 'foo.ts');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.message).toContain('console.log');
  });

  it('flags console.warn and console.error in .ts files', async () => {
    const file = makeFile('console.warn("w");\nconsole.error("e");', 'foo.ts');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
  });

  it('flags console.log in .tsx, .js, .jsx, .mjs, .cjs', async () => {
    for (const name of ['a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      const file = makeFile('console.log("x");', name);
      const violations = await run(noDebugLogging()(file));
      expect(violations).toHaveLength(1);
    }
  });

  it('flags print() in .py files but NOT console.log', async () => {
    const file = makeFile('print("hi")\n# console.log is not a python thing', 'foo.py');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('print');
  });

  it('flags pprint and breakpoint in .py files', async () => {
    const file = makeFile('pprint(x)\nbreakpoint()', 'foo.py');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
  });

  it('flags var_dump and dd in .php files but NOT print()', async () => {
    // print() is a PHP language construct, not a debug helper — not in the .php map.
    const file = makeFile('var_dump($x);\ndd($y);\necho "ok";', 'foo.php');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
    expect(violations.some((v: { message: string }) => v.message.includes('var_dump'))).toBe(true);
    expect(violations.some((v: { message: string }) => v.message.includes('dd'))).toBe(true);
  });

  it('flags fmt.Println in .go files', async () => {
    const file = makeFile('fmt.Println("hi")\nlog.Printf("x")', 'foo.go');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
  });

  it('flags println! and dbg! in .rs files', async () => {
    const file = makeFile('println!("hi")\ndbg!(x)', 'foo.rs');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
  });

  it('flags puts and pp in .rb files', async () => {
    const file = makeFile(`puts("hi")
pp(obj)`, 'foo.rb');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(2);
  });

  it('returns [] for unknown extensions', async () => {
    const file = makeFile('console.log("x");\nprint("y");', 'foo.unknown');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(0);
  });

  it('does not flag partial-name matches (e.g. myconsole.log)', async () => {
    // The lookbehind (?<![\w.]) prevents matching inside a longer identifier.
    const file = makeFile('myconsole.log("x");\nnotconsole.log("y");', 'foo.ts');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(0);
  });

  it('respects extraNames option (added to all extensions)', async () => {
    const file = makeFile('myDebugFn(x);\nconsole.log("y");', 'foo.ts');
    const violations = await run(noDebugLogging({ extraNames: ['myDebugFn'] })(file));
    expect(violations).toHaveLength(2);
  });

  it('respects custom severity', async () => {
    const file = makeFile('console.log("x");', 'foo.ts');
    const violations = await run(noDebugLogging({ severity: 'error' })(file));
    expect(violations[0]?.severity).toBe('error');
  });

  it('respects custom message', async () => {
    const file = makeFile('console.log("x");', 'foo.ts');
    const violations = await run(noDebugLogging({ message: 'No logging!' })(file));
    expect(violations[0]?.message).toBe('No logging!');
  });

  it('emits at most one violation per line', async () => {
    const file = makeFile('console.log("a"); console.log("b");', 'foo.ts');
    const violations = await run(noDebugLogging()(file));
    expect(violations).toHaveLength(1);
  });
});
