import { describe, expect, it } from 'vitest';
import { parseTscOutput, tsc, tscArgs } from '../src/adapter';

const run = (over: Partial<{ stdout: string; stderr: string; status: number | null }> = {}) => ({
  stdout: '',
  stderr: '',
  status: 0,
  ...over,
});

const context = { cwd: '/proj', projectRoot: '/proj', ruleId: 'tsc' };

const NEWLINE = String.fromCharCode(10);

describe('parseTscOutput', () => {
  it('turns each diagnostic into a violation with its file and line', () => {
    const violations = parseTscOutput(
      run({
        stdout:
          'src/a.ts(12,5): error TS2322: Type "string" is not assignable to type "number".' +
          NEWLINE +
          'src/b.ts(3,1): error TS2554: Expected 2 arguments, but got 1.' +
          NEWLINE,
        status: 1,
      }),
      context,
    );

    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({
      rule: 'tsc',
      path: 'src/a.ts',
      line: 12,
      severity: 'error',
      source: 'tsc',
    });
    expect(violations[0]?.message).toContain('TS2322');
    expect(violations[0]?.message).toContain('not assignable');
    expect(violations[1]?.path).toBe('src/b.ts');
    expect(violations[1]?.line).toBe(3);
  });

  it('resolves a path relative to where the tool ran, not to where it is reported', () => {
    // A tool `cwd` inside the project: tsc prints paths relative to *its* cwd, and
    // violations must stay project-root-relative or every scoped filter misses them.
    const violations = parseTscOutput(
      run({ stdout: 'src/deep.ts(1,1): error TS1000: boom' + NEWLINE, status: 1 }),
      { cwd: '/proj/apps/web', projectRoot: '/proj', ruleId: 'tsc' },
    );
    expect(violations[0]?.path).toBe('apps/web/src/deep.ts');
  });

  it('keeps an absolute path inside the project root', () => {
    const violations = parseTscOutput(
      run({ stdout: '/proj/src/a.ts(1,1): error TS1000: boom' + NEWLINE, status: 1 }),
      context,
    );
    expect(violations[0]?.path).toBe('src/a.ts');
  });

  it('ignores the summary line tsc prints after the diagnostics', () => {
    const violations = parseTscOutput(
      run({
        stdout:
          NEWLINE +
          'src/a.ts(1,1): error TS1000: boom' +
          NEWLINE +
          NEWLINE +
          'Found 1 error in src/a.ts:1' +
          NEWLINE,
        status: 1,
      }),
      context,
    );
    expect(violations).toHaveLength(1);
  });

  it('is silent when the checker ran and found nothing', () => {
    expect(parseTscOutput(run(), context)).toEqual([]);
  });

  it('refuses to call a failed run clean', () => {
    // The case this parser exists for. A config error produces no diagnostic line and
    // no stdout at all: without the status it is indistinguishable from "clean", and
    // the gate would report a project it never looked at as type-safe.
    const violations = parseTscOutput(
      run({
        status: 2,
        stderr: "error TS5058: The specified path does not exist: 'tsconfig.json'.",
      }),
      context,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ path: '.', severity: 'error', source: 'tsc' });
    expect(violations[0]?.message).toContain('nothing was checked');
    expect(violations[0]?.message).toContain('TS5058');
  });

  it('reports a diagnostic even when the run also failed', () => {
    const violations = parseTscOutput(
      run({ stdout: 'src/a.ts(1,1): error TS1000: boom' + NEWLINE, status: 2 }),
      context,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('TS1000');
  });

  it('says what it does know when the status is there but the output is not', () => {
    const violations = parseTscOutput(run({ status: 3 }), context);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('status 3');
  });
});

describe('tscArgs', () => {
  it('passes no files when there was no request, so the project config decides', () => {
    expect(tscArgs([], null)).toEqual(['--noEmit', '--pretty', 'false']);
  });

  it('passes the requested files as paths, because tsc does not expand globs', () => {
    expect(tscArgs([], ['src/a.ts'])).toEqual([
      '--noEmit',
      '--pretty',
      'false',
      'src/a.ts',
    ]);
  });

  it('drops the files when a project is named, which tsc would reject', () => {
    expect(tscArgs(['--project', 'tsconfig.build.json'], ['src/a.ts'])).toEqual([
      '--noEmit',
      '--pretty',
      'false',
      '--project',
      'tsconfig.build.json',
    ]);
    expect(tscArgs(['-p', 'x.json'], ['src/a.ts'])).not.toContain('src/a.ts');
    expect(tscArgs(['--project=x.json'], ['src/a.ts'])).not.toContain('src/a.ts');
  });
});

describe('replaces', () => {
  it('names the command it makes unnecessary, so the recipe is generated, not guessed', () => {
    // `gesetz skill` prints this. A declaration that drifts from what the adapter
    // really runs is a small lie told to every agent that reads the skill.
    const entries = tsc({}).replaces ?? [];
    expect(entries.map((entry) => entry.use)).toEqual(['gesetz check --rule tsc', 'gesetz check --rule tsc']);
    expect(entries.every((entry) => entry.instead.length > 0)).toBe(true);
  });
});
