import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { noPattern, requirePattern } from '../../../src/primitives/checks/patterns';
import type { File } from '../../../src/engine/rule';

function makeFile(content: string, path = 'src/foo.ts'): File {
  return {
    path,
    absolutePath: `/abs/${path}`,
    name: 'foo.ts',
    stem: 'foo',
    ext: '.ts',
    dir: 'src',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

describe('noPattern', () => {
  it('passes when pattern is not found', async () => {
    const file = makeFile('const x = 1;');
    const violations = await run(noPattern(/DB::/)(file));
    expect(violations).toHaveLength(0);
  });

  it('fails on each line matching the pattern', async () => {
    const file = makeFile('DB::table("users");\nDB::raw("SELECT 1");');
    const violations = await run(noPattern(/DB::/)(file));
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(1);
    expect(violations[1]?.line).toBe(2);
  });

  it('whole-file mode reports one violation even if pattern appears multiple times', async () => {
    const file = makeFile('DB::table("users");\nDB::raw("SELECT 1");');
    const violations = await run(noPattern(/DB::/, { fullFile: true })(file));
    expect(violations).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const file = makeFile('echo "hello";');
    const violations = await run(noPattern(/echo/, { message: 'Use print() instead' })(file));
    expect(violations[0]?.message).toBe('Use print() instead');
  });
});

describe('requirePattern', () => {
  it('passes when pattern is found', async () => {
    const file = makeFile('declare(strict_types=1);');
    const violations = await run(requirePattern(/declare\(strict_types=1\)/)(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when pattern is not found', async () => {
    const file = makeFile('<?php\n\nclass Foo {}');
    const violations = await run(
      requirePattern(/declare\(strict_types=1\)/, {
        message: 'PHP files must declare strict_types',
      })(file),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe('PHP files must declare strict_types');
  });
});
