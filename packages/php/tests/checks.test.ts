import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { strictTypes, psrNamespace, noInlineQueries } from '../src/checks';
import type { File } from '@gesetz/core';

function makeFile(content: string, path = 'app/User.php', name = 'User.php'): File {
  return {
    path,
    absolutePath: `/project/${path}`,
    name,
    stem: name.replace(/\.php$/, ''),
    ext: '.php',
    dir: path.split('/').slice(0, -1).join('/') || '.',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

describe('strictTypes', () => {
  it('passes when declare(strict_types=1) is present', async () => {
    const file = makeFile('<?php\ndeclare(strict_types=1);\nclass User {}');
    const violations = await run(strictTypes()(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when strict_types declaration is missing', async () => {
    const file = makeFile('<?php\nclass User {}');
    const violations = await run(strictTypes()(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('declare(strict_types=1)');
  });

  it('uses custom message', async () => {
    const file = makeFile('<?php\nclass User {}');
    const violations = await run(strictTypes({ message: 'Strict types required' })(file));
    expect(violations[0]?.message).toBe('Strict types required');
  });
});

describe('psrNamespace', () => {
  it('passes when namespace matches directory structure', async () => {
    const file = makeFile(
      '<?php\nnamespace App\\Models;\nclass User {}',
      'app/Models/User.php',
      'User.php',
    );
    const violations = await run(psrNamespace({ baseNamespace: 'App', basePath: 'app' })(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when namespace does not match directory', async () => {
    const file = makeFile(
      '<?php\nnamespace App\\Controllers;\nclass User {}',
      'app/Models/User.php',
      'User.php',
    );
    const violations = await run(psrNamespace({ baseNamespace: 'App', basePath: 'app' })(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('App\\Controllers');
    expect(violations[0]?.message).toContain('App\\Models');
  });

  it('skips files outside base path', async () => {
    const file = makeFile(
      '<?php\nnamespace Vendor;\nclass Tool {}',
      'vendor/Tool.php',
      'Tool.php',
    );
    const violations = await run(psrNamespace({ baseNamespace: 'App', basePath: 'app' })(file));
    expect(violations).toHaveLength(0);
  });

  it('handles root-level files', async () => {
    const file = makeFile(
      '<?php\nnamespace App;\nclass Kernel {}',
      'app/Kernel.php',
      'Kernel.php',
    );
    const violations = await run(psrNamespace({ baseNamespace: 'App', basePath: 'app' })(file));
    expect(violations).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const file = makeFile(
      '<?php\nnamespace Wrong;\nclass User {}',
      'app/Models/User.php',
      'User.php',
    );
    const violations = await run(
      psrNamespace({ baseNamespace: 'App', basePath: 'app', message: 'Namespace mismatch' })(file),
    );
    expect(violations[0]?.message).toBe('Namespace mismatch');
  });
});

describe('noInlineQueries', () => {
  it('passes when no forbidden patterns exist', async () => {
    const file = makeFile('<?php\nUser::all();');
    const violations = await run(noInlineQueries(['DB::raw', 'DB::statement'])(file));
    expect(violations).toHaveLength(0);
  });

  it('flags forbidden call patterns line by line', async () => {
    const file = makeFile('<?php\nDB::raw("SELECT * FROM users");\nDB::table("users");');
    const violations = await run(noInlineQueries(['DB::raw', 'DB::statement'])(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('DB::raw');
    expect(violations[0]?.line).toBe(2);
  });

  it('flags multiple matching patterns', async () => {
    const file = makeFile('<?php\nDB::raw("SELECT 1");\nDB::statement("UPDATE");');
    const violations = await run(noInlineQueries(['DB::raw', 'DB::statement'])(file));
    expect(violations).toHaveLength(2);
  });

  it('uses custom message and severity', async () => {
    const file = makeFile('<?php\nPDO::query("SELECT 1");');
    const violations = await run(
      noInlineQueries(['PDO::query'], { message: 'Use Eloquent instead', severity: 'warn' })(file),
    );
    expect(violations[0]?.message).toBe('Use Eloquent instead');
    expect(violations[0]?.severity).toBe('warn');
  });
});
