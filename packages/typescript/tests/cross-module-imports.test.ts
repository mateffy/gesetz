import { describe, expect, it } from 'vitest';
import { makeCheckServices, makeFile, runCheck } from '@gesetz/core';
import { noCrossModuleImports } from '../src';

const PATTERN = /\/domains\/([^/]+)\//;
const message = (from: string, to: string): string => `domain '${from}' -> '${to}'`;

describe('noCrossModuleImports', () => {
  it('flags an import into another module internals', async () => {
    const violations = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message }),
      makeFile('src/components/domains/billing/Invoice.tsx'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: {
          imports: [
            { specifier: '../../domains/auth/internal/session', names: [], line: 3 },
          ],
        },
        imports: {
          '../../domains/auth/internal/session':
            '/project/src/components/domains/auth/internal/session',
        },
      }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe("domain 'billing' -> 'auth'");
    expect(violations[0]?.path).toBe('src/components/domains/billing/Invoice.tsx');
    expect(violations[0]?.line).toBe(3);
    expect(violations[0]?.severity).toBe('error');
  });

  it('allows imports that stay inside the same module', async () => {
    const violations = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message }),
      makeFile('src/components/domains/billing/Invoice.tsx'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: { imports: [{ specifier: './Total', names: [], line: 1 }] },
        imports: { './Total': '/project/src/components/domains/billing/Total' },
      }),
    );

    expect(violations).toEqual([]);
  });

  it('ignores bare package specifiers', async () => {
    const violations = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message }),
      makeFile('src/components/domains/billing/Invoice.tsx'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: { imports: [{ specifier: 'react', names: [], line: 1 }] },
        imports: { react: '/project/node_modules/react/index.js' },
      }),
    );

    expect(violations).toEqual([]);
  });

  it('ignores files that are not inside a module the pattern matches', async () => {
    const violations = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message }),
      makeFile('src/lib/money.ts'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: { imports: [{ specifier: './domains/auth/internal', names: [], line: 1 }] },
        imports: { './domains/auth/internal': '/project/src/lib/domains/auth/internal' },
      }),
    );

    expect(violations).toEqual([]);
  });

  it('ignores imports that resolve outside the pattern scope', async () => {
    const violations = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message }),
      makeFile('src/components/domains/billing/Invoice.tsx'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: { imports: [{ specifier: '../../../lib/money', names: [], line: 1 }] },
        imports: { '../../../lib/money': '/project/src/lib/money' },
      }),
    );

    expect(violations).toEqual([]);
  });

  it('honours an explicit severity', async () => {
    const [violation] = await runCheck(
      noCrossModuleImports({ modulePattern: PATTERN, message, severity: 'warn' }),
      makeFile('src/components/domains/billing/Invoice.tsx'),
      makeCheckServices({
        projectRoot: '/project',
        syntax: { imports: [{ specifier: '../auth/internal', names: [], line: 2 }] },
        imports: { '../auth/internal': '/project/src/components/domains/auth/internal' },
      }),
    );

    expect(violation?.severity).toBe('warn');
  });
});
