import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { Effect, Layer } from 'effect';
import { vitest } from '../src/adapter';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive, SyntaxTreeStub, ImportResolverDefault } from '@gesetz/core';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive('/project'),
  FileFilterLive(null),
);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const VITEST_JSON = JSON.stringify({
  numFailedTests: 1,
  testResults: [
    {
      name: '/project/src/utils/math.test.ts',
      assertionResults: [
        {
          fullName: 'math > add',
          title: 'add',
          status: 'passed',
          failureMessages: [],
        },
        {
          fullName: 'math > subtract',
          title: 'subtract',
          status: 'failed',
          failureMessages: [
            'expected 5 to be 3\n    at /project/src/utils/math.ts:12:5',
          ],
        },
      ],
    },
  ],
});

describe('vitest adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('parses failed test assertions from JSON output', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => VITEST_JSON);

    const rule = vitest({ cwd: '/project', label: 'Vitest' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('vitest');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('math > subtract');
    expect(violations[0]?.path).toBe('src/utils/math.ts');
    expect(violations[0]?.line).toBe(12);
  });

  it('returns empty array when all tests pass', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ numFailedTests: 0, testResults: [] }),
    );

    const rule = vitest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes config file and project options', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => JSON.stringify({ numFailedTests: 0, testResults: [] }));

    const rule = vitest({
      cwd: '/project',
      configFile: 'vitest.unit.config.ts',
      project: ['unit', 'component'],
    });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'run',
        '--reporter=json',
        '--config',
        'vitest.unit.config.ts',
        '--project',
        'unit',
        '--project',
        'component',
      ]),
      expect.any(Object),
    );
  });

  it('passes pattern as positional args', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => JSON.stringify({ numFailedTests: 0, testResults: [] }));

    const rule = vitest({ cwd: '/project', pattern: ['src/utils', 'src/helpers'] });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['src/utils', 'src/helpers']),
      expect.any(Object),
    );
  });

  it('returns empty array for invalid JSON', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'not json');

    const rule = vitest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });
});
