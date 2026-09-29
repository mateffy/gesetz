import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { vitest } from '../src/adapter';
import {
  MemoryFileSystem,
  ProjectRootLive,
  FileFilterLive,
  SyntaxTreeStub,
  ImportResolverDefault,
} from '@gesetz/core';

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

/**
 * Stands in for the tool: writes the report where the adapter asked for it.
 *
 * The adapter passes `--outputFile=<tmp>` and reads that file, rather than
 * parsing stdout, so a stub that only returns a string leaves no report and the
 * adapter (correctly) reports that nothing was checked.
 */
const writesReport = (json: string) =>
  ((_bin: string, args: readonly string[]) => {
    const flag = args.find((arg) => arg.startsWith('--outputFile='));
    if (flag !== undefined) nodeFs.writeFileSync(flag.slice('--outputFile='.length), json, 'utf8');
    return '';
  }) as unknown as () => string;

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
          failureMessages: ['expected 5 to be 3\n    at /project/src/utils/math.ts:12:5'],
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
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      writesReport(VITEST_JSON),
    );

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
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })),
    );

    const rule = vitest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes config file and project options', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

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
    spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

    const rule = vitest({ cwd: '/project', pattern: ['src/utils', 'src/helpers'] });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['src/utils', 'src/helpers']),
      expect.any(Object),
    );
  });

  it('reports a violation when stdout is not valid JSON', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'not json');

    const rule = vitest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('nothing was checked');
  });

  describe('FileFilter integration', () => {
    it('passes FileFilter patterns to vitest when --files is active', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

      const rule = vitest({ cwd: '/project' });
      await Effect.runPromise(
        Effect.provide(
          rule.run,
          Layer.mergeAll(
            MemoryFileSystem({}),
            SyntaxTreeStub,
            ImportResolverDefault,
            ProjectRootLive('/project'),
            FileFilterLive(['src/app/**', 'src/lib/**']),
          ),
        ),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['src/app/**', 'src/lib/**']),
        expect.any(Object),
      );
    });

    it('uses adapter pattern when FileFilter is null', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

      const rule = vitest({ cwd: '/project', pattern: 'src/custom.test.ts' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['src/custom.test.ts']),
        expect.any(Object),
      );
    });

    it('runs full suite when no pattern and no FileFilter', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

      const rule = vitest({ cwd: '/project' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      // No positional args → vitest runs its configured suite
      const callArgs = spy.mock.calls[spy.mock.calls.length - 1]?.[1] as string[];
      expect(callArgs).toContain('run');
      expect(callArgs).toContain('--reporter=json');
      // Verify no extra positional args beyond options
      const positionalAfterOpts = callArgs.indexOf('--reporter=json') + 1;
      // All remaining args should be config options or project flags, not file patterns
      const remaining = callArgs.slice(positionalAfterOpts);
      const hasNonOptPattern = remaining.some(
        (a) => !a.startsWith('--') && a !== '--project' && a !== 'unit' && a !== 'component',
      );
      expect(hasNonOptPattern).toBe(false);
    });

    it('FileFilter patterns override adapter pattern', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));

      const rule = vitest({ cwd: '/project', pattern: 'src/everything.test.ts' });
      await Effect.runPromise(
        Effect.provide(
          rule.run,
          Layer.mergeAll(
            MemoryFileSystem({}),
            SyntaxTreeStub,
            ImportResolverDefault,
            ProjectRootLive('/project'),
            FileFilterLive(['src/subset.test.ts']),
          ),
        ),
      );

      const callArgs = spy.mock.calls[spy.mock.calls.length - 1]?.[1] as string[];
      expect(callArgs).toContain('src/subset.test.ts');
      expect(callArgs).not.toContain('src/everything.test.ts');
    });
  });

  describe('project runs execute only the tests that cover the files in play', () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    const argsOf = (): string[] =>
      (spy.mock.calls.at(-1)?.[1] as string[]) ?? [];

    /**
     * A project whose files exist on disk, because the adapter asks the filesystem
     * whether a candidate test is there.
     */
    const project = async (files: string[]): Promise<string> => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-vitest-'));
      for (const file of files) {
        const absolute = nodePath.join(root, file);
        await mkdir(nodePath.dirname(absolute), { recursive: true });
        await writeFile(absolute, '');
      }
      return root;
    };

    it('passes the test that covers a changed source file', async () => {
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));
      const root = await project(['src/utils/math.ts', 'src/utils/math.test.ts']);
      const rule = vitest({ cwd: root, project: ['unit'] });

      await rule.project!.run({
        rootDir: root,
        changedFiles: ['src/utils/math.ts'],
        requestedPaths: null,
      });

      expect(argsOf()).toContain('src/utils/math.test.ts');
      expect(argsOf()).not.toContain('src/utils/other.test.ts');
    });

    it('runs a changed test file itself', async () => {
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));
      const root = await project(['src/utils/math.test.ts']);
      const rule = vitest({ cwd: root });

      await rule.project!.run({
        rootDir: root,
        changedFiles: ['src/utils/math.test.ts'],
        requestedPaths: null,
      });

      expect(argsOf()).toContain('src/utils/math.test.ts');
    });

    it('does not call the runner at all when no test covers the file in play', async () => {
      // Otherwise the run has no filter and executes the whole suite, which is
      // exactly the cost this scope exists to avoid.
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));
      const root = await project(['src/utils/math.ts']);
      const rule = vitest({ cwd: root });

      await rule.project!.run({
        rootDir: root,
        changedFiles: ['src/utils/math.ts'],
        requestedPaths: null,
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it('prefers the requested files over the changed ones', async () => {
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));
      const root = await project([
        'src/a.ts',
        'src/a.test.ts',
        'src/b.ts',
        'src/b.test.ts',
      ]);
      const rule = vitest({ cwd: root });

      await rule.project!.run({
        rootDir: root,
        changedFiles: ['src/b.ts'],
        requestedPaths: ['src/a.ts'],
      });

      expect(argsOf()).toContain('src/a.test.ts');
      expect(argsOf()).not.toContain('src/b.test.ts');
    });

    it('accepts a project-specific suffix list', async () => {
      spy.mockImplementation(writesReport(JSON.stringify({ numFailedTests: 0, testResults: [] })));
      const root = await project(['src/a.ts', 'src/a.spec.ts']);
      const rule = vitest({ cwd: root, testSuffixes: ['.spec.ts'] });

      await rule.project!.run({
        rootDir: root,
        changedFiles: ['src/a.ts'],
        requestedPaths: null,
      });

      expect(argsOf()).toContain('src/a.spec.ts');
    });
  });
});
