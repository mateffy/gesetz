import { describe, it, expect } from 'vitest';
import { noPattern, requirePattern } from '../../../src/primitives/checks/patterns';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';

describe('noPattern', () => {
  it('passes when pattern is not found', async () => {
    const v = await runCheck(noPattern(/DB::/), makeFile('src/foo.ts', 'const x = 1;'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('fails on each line matching the pattern', async () => {
    const v = await runCheck(noPattern(/DB::/), makeFile('src/foo.ts', 'DB::table("users");\nDB::raw("SELECT 1");'), makeCheckServices());
    expect(v).toHaveLength(2);
    expect(v[0]?.line).toBe(1);
    expect(v[1]?.line).toBe(2);
  });

  it('whole-file mode reports one violation even if pattern appears multiple times', async () => {
    const v = await runCheck(noPattern(/DB::/, { fullFile: true }), makeFile('src/foo.ts', 'DB::table("users");\nDB::raw("SELECT 1");'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const v = await runCheck(noPattern(/echo/, { message: 'Use print() instead' }), makeFile('src/foo.ts', 'echo "hello";'), makeCheckServices());
    expect(v[0]?.message).toBe('Use print() instead');
  });
});

describe('requirePattern', () => {
  it('passes when pattern is found', async () => {
    const v = await runCheck(requirePattern(/declare\(strict_types=1\)/), makeFile('src/foo.php', 'declare(strict_types=1);'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('fails when pattern is not found', async () => {
    const v = await runCheck(requirePattern(/declare\(strict_types=1\)/, { message: 'PHP files must declare strict_types' }), makeFile('src/foo.php', '<?php\n\nclass Foo {}'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toBe('PHP files must declare strict_types');
  });
});