import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { noDirectCalls } from '../../../src/primitives/checks/calls';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';
import type { CheckServices } from '../../../src/engine/rule';

const CWD = process.cwd();

function servicesWithCalls(calls: { name: string; line: number }[]): CheckServices {
  return makeCheckServices({
    projectRoot: nodePath.resolve(CWD, '..', '..', '..'),
    syntax: { calls },
  });
}

describe('noDirectCalls', () => {
  it('flags calls whose name is in the banned set', async () => {
    const file = makeFile('src/foo.ts');
    const services = servicesWithCalls([
      { name: 'eval', line: 3 },
      { name: 'fetch', line: 7 },
      { name: 'eval', line: 12 },
    ]);
    const violations = await runCheck(noDirectCalls(['eval']), file, services);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(12);
    expect(violations[0]?.message).toContain('eval');
  });

  it('does not flag calls not in the banned set', async () => {
    const file = makeFile('src/foo.ts');
    const services = servicesWithCalls([
      { name: 'fetch', line: 1 },
      { name: 'console.log', line: 2 },
    ]);
    const violations = await runCheck(noDirectCalls(['eval']), file, services);
    expect(violations).toHaveLength(0);
  });

  it('returns [] when no SyntaxBackend is registered (canProcess: false)', async () => {
    const file = makeFile('src/foo.rb');
    const services = makeCheckServices();
    const violations = await runCheck(noDirectCalls(['eval']), file, services);
    expect(violations).toHaveLength(0);
  });

  it('uses a custom message callback', async () => {
    const file = makeFile('src/foo.ts');
    const services = servicesWithCalls([{ name: 'eval', line: 3 }]);
    const violations = await runCheck(
      noDirectCalls(['eval'], { message: (n) => `do not call ${n}!` }),
      file,
      services,
    );
    expect(violations[0]?.message).toBe('do not call eval!');
  });

  it('respects custom severity', async () => {
    const file = makeFile('src/foo.ts');
    const services = servicesWithCalls([{ name: 'eval', line: 3 }]);
    const violations = await runCheck(
      noDirectCalls(['eval'], { severity: 'warn' }),
      file,
      services,
    );
    expect(violations[0]?.severity).toBe('warn');
  });

  it('handles member-access call names like console.log', async () => {
    const file = makeFile('src/foo.ts');
    const services = servicesWithCalls([{ name: 'console.log', line: 5 }]);
    const violations = await runCheck(noDirectCalls(['console.log']), file, services);
    expect(violations).toHaveLength(1);
  });
});
