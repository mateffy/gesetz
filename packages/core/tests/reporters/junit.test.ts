import type { RunResult } from '../../src/engine/runner';

export const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  byRule: [
    {
      ruleId: 'rule-a',
      description: 'Rule A',
      category: 'cleanup',
      violations: [
        {
          rule: 'rule-a',
          message: 'bad thing',
          path: 'src/a.ts',
          line: 3,
          column: 5,
          severity: 'error',
          source: 'core',
        },
        {
          rule: 'rule-a',
          message: 'meh thing',
          path: 'src/b.ts',
          severity: 'warn',
          source: 'core',
        },
      ],
    },
    { ruleId: 'rule-b', description: 'Rule B', category: 'structure', violations: [] },
  ],
  byCategory: [],
  totalViolations: 2,
  passing: false,
  ...overrides,
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { JUnitReporter } from '../../src/reporters/junit';
import { Reporter } from '../../src/reporters/reporter';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-junit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const report = (path: string, r: RunResult) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reporter = yield* Reporter;
      return yield* reporter.report(r);
    }).pipe(Effect.provide(JUnitReporter(path))),
  );

describe('JUnitReporter', () => {
  it('writes valid XML with one testcase per rule', async () => {
    const out = nodePath.join(dir, 'junit.xml');
    await report(out, result());
    const xml = await readFile(out, 'utf8');
    expect(xml).toContain('<?xml');
    expect(xml.match(/<testcase/g)).toHaveLength(2);
  });

  it('counts only rules with violations as failures', async () => {
    const out = nodePath.join(dir, 'junit.xml');
    await report(out, result());
    const xml = await readFile(out, 'utf8');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('tests="2"');
  });

  it('emits a failure element carrying the path and message', async () => {
    const out = nodePath.join(dir, 'junit.xml');
    await report(out, result());
    const xml = await readFile(out, 'utf8');
    expect(xml).toContain('<failure');
    expect(xml).toContain('src/a.ts');
    expect(xml).toContain('bad thing');
  });

  it('reports zero failures for a clean result', async () => {
    const out = nodePath.join(dir, 'junit.xml');
    await report(out, result({ byRule: [], totalViolations: 0, passing: true }));
    const xml = await readFile(out, 'utf8');
    expect(xml).toContain('failures="0"');
  });
});
