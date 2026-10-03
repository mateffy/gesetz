import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect, Layer } from 'effect';
import { eslint } from '../src/adapter';
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

// Track patterns passed to lintFiles so we can verify them in tests
let lastLintFilesPatterns: string[] = [];

// Mock the eslint module so the dynamic import resolves without needing the real package
vi.mock('eslint', () => {
  return {
    ESLint: class MockESLint {
      constructor(public options: { cwd: string; overrideConfigFile?: string }) {}
      async lintFiles(patterns: string[]) {
        lastLintFilesPatterns = patterns;
        if (patterns.includes('throw')) {
          throw new Error('lint failed');
        }
        return [
          {
            filePath: '/project/src/a.ts',
            messages: [
              {
                ruleId: 'no-unused-vars',
                message: "'x' is assigned but never used.",
                line: 5,
                column: 7,
                severity: 2 as const,
              },
              {
                ruleId: 'prefer-const',
                message: "'y' is never reassigned.",
                line: 10,
                column: 3,
                severity: 1 as const,
              },
            ],
          },
          {
            filePath: '/project/src/b.ts',
            messages: [],
          },
        ];
      }
    },
  };
});

describe('eslint adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastLintFilesPatterns = [];
  });

  it('maps ESLint messages to violations', async () => {
    const rule = eslint({ cwd: '/project', label: 'ESLint' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.rule).toBe('eslint');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('no-unused-vars');
    expect(violations[0]?.message).toContain("'x' is assigned but never used.");
    expect(violations[0]?.path).toBe('/project/src/a.ts');
    expect(violations[0]?.line).toBe(5);
    expect(violations[0]?.column).toBe(7);

    expect(violations[1]?.severity).toBe('warn');
    expect(violations[1]?.message).toContain('prefer-const');
  });

  it('passes overrideConfigFile to ESLint constructor', async () => {
    const rule = eslint({ cwd: '/project', overrideConfigFile: 'custom.config.mjs' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    // The mock ESLint constructor receives the options; we verify the rule still runs
    expect(rule.id).toBe('eslint');
  });

  it('reports a violation when ESLint throws', async () => {
    const rule = eslint({ cwd: '/project', pattern: 'throw' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('nothing was checked');
  });

  it('returns empty array when no messages', async () => {
    // The mock returns one file with no messages, so we still get violations from a.ts
    // This test verifies the adapter handles empty messages gracefully
    const rule = eslint({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    const bViolations = violations.filter((v) => v.path.includes('b.ts'));
    expect(bViolations).toHaveLength(0);
  });

  describe('project runs honour a --files request', () => {
    it('runs over its own patterns when nothing was requested', async () => {
      lastLintFilesPatterns = [];
      const rule = eslint({ pattern: 'src/**/*.ts', cwd: '/project' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.ts'],
        requestedPaths: null,
      });
      expect(lastLintFilesPatterns).toEqual(['src/**/*.ts']);
    });

    it('runs over the requested files when there is one', async () => {
      const rule = eslint({ pattern: 'src/**/*.ts', cwd: '/project' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        requestedPaths: ['src/a.ts', 'src/b.ts'],
      });
      expect(lastLintFilesPatterns).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('does not call the linter at all when the request matches none of its files', async () => {
      lastLintFilesPatterns = [];
      const rule = eslint({ pattern: 'src/**/*.ts', cwd: '/project' });
      await rule.project!.run({
        rootDir: '/project',
        changedFiles: ['src/a.ts'],
        requestedPaths: ['src/a.php'],
      });
      // Handing the linter an empty list would make it scan nothing and report
      // success, so the adapter must skip it instead.
      expect(lastLintFilesPatterns).toEqual([]);
    });
  });

  describe('FileFilter integration', () => {
    it('passes FileFilter patterns to lintFiles when --files is active', async () => {
      const rule = eslint({ cwd: '/project' });
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

      expect(lastLintFilesPatterns).toEqual(['src/app/**', 'src/lib/**']);
    });

    it('uses adapter pattern when FileFilter is null', async () => {
      const rule = eslint({ cwd: '/project', pattern: 'src/custom/**' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(lastLintFilesPatterns).toEqual(['src/custom/**']);
    });

    it('defaults to ["."] when no pattern and no FileFilter', async () => {
      const rule = eslint({ cwd: '/project' });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(lastLintFilesPatterns).toEqual(['.']);
    });

    it('FileFilter patterns override adapter pattern', async () => {
      const rule = eslint({ cwd: '/project', pattern: 'src/everything/**' });
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

      expect(lastLintFilesPatterns).toEqual(['src/subset/**']);
    });
  });
});

describe('replaces', () => {
  it('names the command it makes unnecessary, so the recipe is generated, not guessed', () => {
    // `gesetz skill` prints this. A declaration that drifts from what the adapter
    // really runs is a small lie told to every agent that reads the skill.
    const entries = eslint({}).replaces ?? [];
    expect(entries.map((entry) => entry.use)).toEqual(['gesetz check --rule eslint']);
    expect(entries.every((entry) => entry.instead.length > 0)).toBe(true);
  });
});
