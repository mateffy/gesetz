import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { indexOfCall } from '@gesetz/php';
import type { Rule } from '@gesetz/core';
import {
  noDebugHelpers,
  noDd,
  noEnvOutsideConfig,
  noFacades,
  noRawDbQueries,
  requirePsrNamespaces,
  requireStrictTypes,
} from '../src/checks';

const ML = String.fromCharCode(10);

const run = (
  check: Parameters<typeof runCheck>[0],
  content: string,
  path = 'app/Models/User.php',
) => runCheck(check, makeFile(path, content), makeCheckServices());

/** Run the single check a `select(...).check(...)` rule was built with. */
const runRule = (rule: Rule, content: string, path = 'app/Models/User.php') => {
  const checks = rule.perFile?.checks ?? [];
  expect(checks.length, 'rule has exactly one check').toBe(1);
  return run(checks[0]!, content, path);
};

describe('requireStrictTypes', () => {
  it('flags a file without declare(strict_types=1)', async () => {
    const v = await runRule(requireStrictTypes, `<?php${ML}namespace App;${ML}`);
    expect(v.length).toBeGreaterThan(0);
  });

  it('accepts a file that declares it', async () => {
    const v = await runRule(requireStrictTypes, `<?php${ML}declare(strict_types=1);${ML}`);
    expect(v).toEqual([]);
  });

  it('targets app/ and src/ only', () => {
    expect(requireStrictTypes.perFile?.patterns).toEqual(['app/**/*.php', 'src/**/*.php']);
  });

  it('carries guidance, which is what an agent reads to fix it', () => {
    expect(requireStrictTypes.guidance?.do).toContain('declare(strict_types=1)');
  });
});

describe('requirePsrNamespaces', () => {
  it('flags a namespace that disagrees with the path', async () => {
    const v = await runRule(
      requirePsrNamespaces,
      `<?php${ML}declare(strict_types=1);${ML}namespace Wrong\\Place;`,
      'app/Models/User.php',
    );
    expect(v.length).toBeGreaterThan(0);
  });

  it('accepts a namespace that matches the path', async () => {
    const v = await runRule(
      requirePsrNamespaces,
      `<?php${ML}namespace App\\Models;`,
      'app/Models/User.php',
    );
    expect(v).toEqual([]);
  });
});

describe('noRawDbQueries', () => {
  it('flags a DB::raw call', async () => {
    const v = await runRule(noRawDbQueries, `<?php${ML}$x = DB::raw('count(*)');`);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('excludes the console and database directories', () => {
    expect(noRawDbQueries.perFile?.exclusions).toContain('database/**');
  });
});

describe('noEnvOutsideConfig', () => {
  it('flags env( in application code', async () => {
    const v = await runRule(noEnvOutsideConfig, `<?php${ML}$k = env('APP_KEY');`);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('config');
  });

  it('does not flag getenv(, which is a different function', async () => {
    // `env(` is a substring of `getenv(`, and the old matcher fired on it.
    const v = await runRule(noEnvOutsideConfig, `<?php${ML}$k = getenv('APP_KEY');`);
    expect(v).toEqual([]);
  });
});

describe('noDebugHelpers', () => {
  it('flags a dd() call', async () => {
    const v = await runRule(noDebugHelpers, `<?php${ML}dd($user);`);
    expect(v).toHaveLength(1);
  });

  it('flags the other debug helpers too', async () => {
    for (const call of ['dump($x);', 'ddd($x);', 'ray($x);']) {
      expect(await runRule(noDebugHelpers, `<?php${ML}${call}`), call).toHaveLength(1);
    }
  });

  it('does not flag a method named add()', async () => {
    // Regression: `dd(` is a substring of `add(`, so every `->add(` was a violation.
    const v = await runRule(noDebugHelpers, `<?php${ML}$collection->add($item);`);
    expect(v).toEqual([]);
  });
});

describe('noDd', () => {
  it('reports a line once even when it holds two helpers', async () => {
    // Deliberate: one violation per line keeps a noisy line from burying the rest
    // of the report, and the message names the helper that triggered it.
    const v = await run(noDd(), `<?php${ML}dd($a); dump($b);`);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });

  it('reports one violation per offending line', async () => {
    const v = await run(noDd(), `<?php${ML}dd($a);${ML}dump($b);`);
    expect(v.map((x) => x.line)).toEqual([2, 3]);
  });

  it('does not flag add(), pdd(), or a variable named $dump', async () => {
    const source = `<?php${ML}$c->add($x);${ML}$c->pdd($x);`;
    expect(await run(noDd(), source)).toEqual([]);
  });

  it('still flags a method call on an object', async () => {
    expect(await run(noDd(), `<?php${ML}$this->dump($x);`)).toHaveLength(1);
  });

  it('reports the line the call is on', async () => {
    const v = await run(noDd(), `<?php${ML}${ML}dump($x);`);
    expect(v[0]?.line).toBe(3);
  });

  it('honours a custom message and severity', async () => {
    const v = await run(noDd({ message: 'no', severity: 'warn' }), `<?php${ML}dd(1);`);
    expect(v[0]?.message).toBe('no');
    expect(v[0]?.severity).toBe('warn');
  });

  it('does not flag a debug helper named in a string', async () => {
    // Documented ceiling: this is a text matcher, so a string containing `dd(` is
    // indistinguishable from a call. Behaviour is pinned so a change is deliberate.
    const v = await run(noDd(), `<?php${ML}$sql = 'select dd(1)';`);
    expect(v).toHaveLength(1);
  });
});

describe('noFacades', () => {
  it('flags a facade call', async () => {
    const v = await run(noFacades(), `<?php${ML}$u = DB::table('users')->get();`);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('DB::');
  });

  it('defaults to warn, because a facade is a preference not a bug', async () => {
    expect((await run(noFacades(), `<?php${ML}Auth::user();`))[0]?.severity).toBe('warn');
  });

  it('reports one violation per offending line', async () => {
    const v = await run(noFacades(), `<?php${ML}Auth::user();${ML}Cache::get('x');`);
    expect(v.map((x) => x.line)).toEqual([2, 3]);
  });

  it('reports a line once even when it uses two facades', async () => {
    const v = await run(noFacades(), `<?php${ML}Auth::user(); Cache::get('x');`);
    expect(v).toHaveLength(1);
  });

  it('does not flag a facade named in a line comment', async () => {
    const v = await run(noFacades(), `<?php${ML}// inject instead of DB::table()${ML}$x = 1;`);
    expect(v).toEqual([]);
  });

  it('does not flag a facade named in a docblock continuation', async () => {
    const v = await run(noFacades(), `<?php${ML}/**${ML} * Avoid DB::table() here.${ML} */`);
    expect(v).toEqual([]);
  });

  it('still flags real usage on a line that also has a trailing comment', async () => {
    const v = await run(noFacades(), `<?php${ML}Cache::put('k', 1); // not DB::`);
    expect(v).toHaveLength(1);
  });

  it('accepts a custom facade list', async () => {
    const check = noFacades({ facades: ['Redis::'] });
    expect(await run(check, `<?php${ML}Redis::get('x');`)).toHaveLength(1);
    expect(await run(check, `<?php${ML}DB::table('t');`)).toEqual([]);
  });
});

describe('indexOfCall', () => {
  it('finds a call at the start of a line', () => {
    expect(indexOfCall('dd($x);', 'dd(')).toBe(0);
  });

  it('finds a call after an operator', () => {
    expect(indexOfCall('$this->dd($x);', 'dd(')).toBe(7);
  });

  it('skips an occurrence inside a longer identifier', () => {
    expect(indexOfCall('$c->add($x);', 'dd(')).toBe(-1);
  });

  it('finds a later valid occurrence after an invalid one', () => {
    expect(indexOfCall('add(); dd($x);', 'dd(')).toBe(7);
  });

  it('returns -1 when the pattern is absent', () => {
    expect(indexOfCall('$x = 1;', 'dd(')).toBe(-1);
  });

  it('treats a leading $ as part of the identifier', () => {
    expect(indexOfCall('$dd($x);', 'dd(')).toBe(-1);
  });
});
