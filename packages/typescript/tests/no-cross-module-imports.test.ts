import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { noCrossModuleImports } from '../src/checks/no-cross-module-imports';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

const CWD = process.cwd();
const MODULE = /src\/domains\/([^/]+)\//;
const FILE = 'src/domains/billing/Invoice.ts';

/** Services where each `specifier -> resolved` pair is a real import in the file. */
function withImports(pairs: [string, string | null][]) {
  return makeCheckServices({
    projectRoot: CWD,
    syntax: {
      imports: pairs.map(([specifier], i) => ({ specifier, names: [], line: i + 1 })),
    },
    imports: Object.fromEntries(
      pairs.map(([specifier, resolved]) => [
        specifier,
        resolved === null ? null : nodePath.resolve(CWD, resolved),
      ]),
    ),
  });
}

const run = (pairs: [string, string | null][], opts = {}) =>
  runCheck(
    noCrossModuleImports({ modulePattern: MODULE, ...opts }),
    makeFile(FILE),
    withImports(pairs),
  );

describe('noCrossModuleImports', () => {
  it('flags an import into another module internals', async () => {
    const v = await run([['../crm/internal/Thing', 'src/domains/crm/internal/Thing.ts']]);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain("'billing'");
    expect(v[0]?.message).toContain("'crm'");
  });

  it('allows another module entry point, because that is what the message asks for', async () => {
    for (const target of ['src/domains/crm/index.ts', 'src/domains/crm/index.tsx']) {
      const v = await run([['../crm', target]]);
      expect(v, target).toHaveLength(0);
    }
  });

  it('allows an import that resolves to the module root itself', async () => {
    const v = await run([['../crm/', 'src/domains/crm/']]);
    expect(v).toHaveLength(0);
  });

  it('allows an import inside the same module', async () => {
    const v = await run([['./Total', 'src/domains/billing/Total.ts']]);
    expect(v).toHaveLength(0);
  });

  it('ignores a file outside any module', async () => {
    const v = await runCheck(
      noCrossModuleImports({ modulePattern: MODULE }),
      makeFile('src/support/util.ts'),
      withImports([['../domains/crm/internal/x', 'src/domains/crm/internal/x.ts']]),
    );
    expect(v).toHaveLength(0);
  });

  it('ignores bare package specifiers', async () => {
    const v = await run([['react', null]]);
    expect(v).toHaveLength(0);
  });

  it('ignores an import that cannot be resolved', async () => {
    // A separate rule owns unresolvable imports; reporting here would double up.
    const v = await run([['../crm/internal/missing', null]]);
    expect(v).toHaveLength(0);
  });

  it('reports only the offending import when several are present', async () => {
    const v = await run([
      ['react', null],
      ['./Total', 'src/domains/billing/Total.ts'],
      ['../crm/internal/Thing', 'src/domains/crm/internal/Thing.ts'],
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("'crm'");
  });

  it('reports the line of the offending import', async () => {
    const v = await run([
      ['react', null],
      ['../crm/internal/Thing', 'src/domains/crm/internal/Thing.ts'],
    ]);
    expect(v[0]?.line).toBe(2);
  });

  it('accepts a custom message and severity', async () => {
    const v = await run([['../crm/internal/x', 'src/domains/crm/internal/x.ts']], {
      severity: 'warn',
      message: (from: string, to: string) => `no ${from} -> ${to}`,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toBe('no billing -> crm');
    expect(v[0]?.severity).toBe('warn');
  });

  it('does not mutate a caller-supplied global RegExp', async () => {
    const globalPattern = /src\/domains\/([^/]+)\//g;
    await runCheck(
      noCrossModuleImports({ modulePattern: globalPattern }),
      makeFile(FILE),
      withImports([['../crm/internal/x', 'src/domains/crm/internal/x.ts']]),
    );
    expect(globalPattern.lastIndex).toBe(0);
  });

  it('is repeatable across calls', async () => {
    const svc = withImports([['../crm/internal/x', 'src/domains/crm/internal/x.ts']]);
    const rule = noCrossModuleImports({ modulePattern: MODULE });
    const first = await runCheck(rule, makeFile(FILE), svc);
    const second = await runCheck(rule, makeFile(FILE), svc);
    expect(second).toHaveLength(first.length);
  });

  it('requires a modulePattern', async () => {
    // Without it nothing can be located, so the rule reports nothing rather than
    // flagging every import.
    const v = await runCheck(
      noCrossModuleImports({ modulePattern: /does-not-match/ }),
      makeFile(FILE),
      withImports([['../crm/internal/x', 'src/domains/crm/internal/x.ts']]),
    );
    expect(v).toHaveLength(0);
  });
});
