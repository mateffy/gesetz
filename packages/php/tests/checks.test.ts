import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { strictTypes, psrNamespace, noInlineQueries } from '../src/checks';

describe('strictTypes', () => {
  it('passes when declare(strict_types=1) is present', async () => {
    const v = await runCheck(
      strictTypes(),
      makeFile('app/User.php', '<?php\ndeclare(strict_types=1);\nclass User {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when strict_types declaration is missing', async () => {
    const v = await runCheck(
      strictTypes(),
      makeFile('app/User.php', '<?php\nclass User {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('declare(strict_types=1)');
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      strictTypes({ message: 'Strict types required' }),
      makeFile('app/User.php', '<?php\nclass User {}'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Strict types required');
  });
});

describe('psrNamespace', () => {
  it('passes when namespace matches directory structure', async () => {
    const v = await runCheck(
      psrNamespace({ baseNamespace: 'App', basePath: 'app' }),
      makeFile('app/Models/User.php', '<?php\nnamespace App\\Models;\nclass User {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('fails when namespace does not match directory', async () => {
    const v = await runCheck(
      psrNamespace({ baseNamespace: 'App', basePath: 'app' }),
      makeFile('app/Models/User.php', '<?php\nnamespace App\\Controllers;\nclass User {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('App\\Controllers');
    expect(v[0]?.message).toContain('App\\Models');
  });

  it('skips files outside base path', async () => {
    const v = await runCheck(
      psrNamespace({ baseNamespace: 'App', basePath: 'app' }),
      makeFile('vendor/Tool.php', '<?php\nnamespace Vendor;\nclass Tool {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('handles root-level files', async () => {
    const v = await runCheck(
      psrNamespace({ baseNamespace: 'App', basePath: 'app' }),
      makeFile('app/Kernel.php', '<?php\nnamespace App;\nclass Kernel {}'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('uses custom message', async () => {
    const v = await runCheck(
      psrNamespace({ baseNamespace: 'App', basePath: 'app', message: 'Namespace mismatch' }),
      makeFile('app/Models/User.php', '<?php\nnamespace Wrong;\nclass User {}'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Namespace mismatch');
  });
});

describe('noInlineQueries', () => {
  it('passes when no forbidden patterns exist', async () => {
    const v = await runCheck(
      noInlineQueries(['DB::raw', 'DB::statement']),
      makeFile('app/User.php', '<?php\nUser::all();'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('flags forbidden call patterns line by line', async () => {
    const v = await runCheck(
      noInlineQueries(['DB::raw', 'DB::statement']),
      makeFile('app/User.php', '<?php\nDB::raw("SELECT * FROM users");\nDB::table("users");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('DB::raw');
    expect(v[0]?.line).toBe(2);
  });

  it('flags multiple matching patterns', async () => {
    const v = await runCheck(
      noInlineQueries(['DB::raw', 'DB::statement']),
      makeFile('app/User.php', '<?php\nDB::raw("SELECT 1");\nDB::statement("UPDATE");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });

  it('uses custom message and severity', async () => {
    const v = await runCheck(
      noInlineQueries(['PDO::query'], { message: 'Use Eloquent instead', severity: 'warn' }),
      makeFile('app/User.php', '<?php\nPDO::query("SELECT 1");'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('Use Eloquent instead');
    expect(v[0]?.severity).toBe('warn');
  });
});
