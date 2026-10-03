import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { Effect, Layer } from 'effect';
import { phpstan } from '../src/adapter';
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

const PHPSTAN_JSON = JSON.stringify({
  totals: { errors: 0, file_errors: 2 },
  files: {
    '/project/src/User.php': {
      errors: 1,
      messages: [
        {
          message: 'Property User::$email is never read, only written.',
          line: 15,
          ignorable: true,
        },
      ],
    },
    '/project/src/Order.php': {
      errors: 1,
      messages: [
        {
          message: 'Method Order::process() should return int but returns string.',
          line: 42,
          ignorable: false,
        },
      ],
    },
  },
  errors: [],
});

describe('phpstan adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('parses file-specific errors from JSON output', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => PHPSTAN_JSON);

    const rule = phpstan({ cwd: '/project', label: 'PHPStan' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.rule).toBe('phpstan');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('Property User::$email');
    expect(violations[0]?.path).toBe('src/User.php');
    expect(violations[0]?.line).toBe(15);
    expect(violations[1]?.message).toContain('Method Order::process()');
    expect(violations[1]?.path).toBe('src/Order.php');
    expect(violations[1]?.line).toBe(42);
  });

  it('maps top-level errors with cwd as path', async () => {
    const json = JSON.stringify({
      totals: { errors: 1, file_errors: 0 },
      files: {},
      errors: ['Out of memory'],
    });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => json);

    const rule = phpstan({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe('Out of memory');
    expect(violations[0]?.path).toBe('/project');
  });

  it('returns empty array for valid JSON with no errors', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
    );

    const rule = phpstan({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('reports a violation when phpstan output is not valid JSON', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'not json');

    const rule = phpstan({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('phpstan');
    expect(violations[0]?.message).toContain('nothing was checked');
  });

  it('passes config file and memory limit', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() =>
      JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
    );

    const rule = phpstan({ cwd: '/project', configFile: 'phpstan.neon', memoryLimit: '1G' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        'analyse',
        '--error-format=json',
        '--no-progress',
        '--no-interaction',
        '--memory-limit=1G',
        '--configuration=phpstan.neon',
      ]),
      expect.any(Object),
    );
  });

  it('passes pattern as positional args', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() =>
      JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
    );

    const rule = phpstan({ cwd: '/project', pattern: ['src', 'app'] });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['src', 'app']),
      expect.any(Object),
    );
  });

  describe('project runs honour a --files request', () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    const argsOf = (): string[] =>
      (childProcess.execFileSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string[];

    it('runs over its own patterns when nothing was requested', async () => {
      spy.mockImplementation(() => '{"totals":{"errors":0,"file_errors":0},"files":{},"errors":[]}');
      const rule = phpstan({ pattern: 'src/**/*.php', cwd: '/project', bin: 'phpstan' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.ts'],
        requestedPaths: null,
      });
      expect(argsOf()).toContain('src/**/*.php');
    });

    it('runs over the requested files when there is one', async () => {
      spy.mockImplementation(() => '{"totals":{"errors":0,"file_errors":0},"files":{},"errors":[]}');
      const rule = phpstan({ pattern: 'src/**/*.php', cwd: '/project', bin: 'phpstan' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.php', 'src/b.php'],
        requestedPaths: ['src/a.php', 'src/b.php'],
      });
      expect(argsOf()).toContain('src/a.php');
      expect(argsOf()).toContain('src/b.php');
    });

    it('does not call the tool at all when the request matches none of its files', async () => {
      spy.mockImplementation(() => '{"totals":{"errors":0,"file_errors":0},"files":{},"errors":[]}');
      const rule = phpstan({ pattern: 'src/**/*.php', cwd: '/project', bin: 'phpstan' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.php'],
        requestedPaths: ['src/a.ts'],
      });
      // Handing the tool an empty list would make it scan nothing and report
      // success, so the adapter must skip it instead.
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('FileFilter integration', () => {
    it('passes FileFilter patterns to phpstan when --files is active', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() =>
        JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
      );

      const rule = phpstan({ cwd: '/project' });
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
      spy.mockImplementation(() =>
        JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
      );

      const rule = phpstan({ cwd: '/project', pattern: 'src/custom' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['src/custom']),
        expect.any(Object),
      );
    });

    it('runs configured paths when no pattern and no FileFilter', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() =>
        JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
      );

      const rule = phpstan({ cwd: '/project' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      // Without patterns, phpstan uses its configured paths — no extra positional args
      const callArgs = spy.mock.calls[spy.mock.calls.length - 1]?.[1] as string[];
      const positionalAfterOpts = callArgs.indexOf('--no-interaction') + 1;
      const remaining = callArgs.slice(positionalAfterOpts);
      expect(remaining.every((a) => a.startsWith('--'))).toBe(true);
    });

    it('FileFilter patterns override adapter pattern', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() =>
        JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
      );

      const rule = phpstan({ cwd: '/project', pattern: 'src/everything' });
      await Effect.runPromise(
        Effect.provide(
          rule.run,
          Layer.mergeAll(
            MemoryFileSystem({}),
            SyntaxTreeStub,
            ImportResolverDefault,
            ProjectRootLive('/project'),
            FileFilterLive(['src/subset/**']),
          ),
        ),
      );

      const callArgs = spy.mock.calls[spy.mock.calls.length - 1]?.[1] as string[];
      expect(callArgs).toContain('src/subset/**');
      expect(callArgs).not.toContain('src/everything');
    });
  });
});

describe('replaces', () => {
  it('names the command it makes unnecessary, so the recipe is generated, not guessed', () => {
    // `gesetz skill` prints this. A declaration that drifts from what the adapter
    // really runs is a small lie told to every agent that reads the skill.
    const entries = phpstan({}).replaces ?? [];
    expect(entries.map((entry) => entry.use)).toEqual(['gesetz check --rule phpstan']);
    expect(entries.every((entry) => entry.instead.length > 0)).toBe(true);
  });
});
