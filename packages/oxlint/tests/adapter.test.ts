import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { Effect, Layer } from 'effect';
import { oxlint } from '../src/adapter';
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

// Realistic oxlint JSON output (v1.63+ format)
const OXLINT_JSON = JSON.stringify({
  diagnostics: [
    {
      message: "Parameter 'children' is declared but never used. Unused parameters should start with a '_'.",
      code: 'eslint(no-unused-vars)',
      severity: 'warning',
      filename: 'src/components/ui/Button.tsx',
      labels: [{ span: { line: 42, column: 12 } }],
    },
    {
      message: 'React Hook useCallback has a missing dependency.',
      code: 'react-hooks(exhaustive-deps)',
      severity: 'error',
      filename: 'src/components/ui/Dialog.tsx',
      labels: [{ span: { line: 10, column: 5 } }],
    },
  ],
  number_of_files: 2,
  number_of_rules: 103,
});

describe('oxlint', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('parses diagnostics from the { diagnostics: [...] } JSON format', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => OXLINT_JSON);

    const rule = oxlint({ cwd: '/project', label: 'oxlint' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.severity).toBe('warn');
    expect(violations[0]?.message).toContain('eslint(no-unused-vars)');
    expect(violations[0]?.path).toBe('src/components/ui/Button.tsx');
    expect(violations[0]?.line).toBe(42);
    expect(violations[1]?.severity).toBe('error');
    expect(violations[1]?.path).toBe('src/components/ui/Dialog.tsx');
    expect(violations[1]?.line).toBe(10);
  });

  it('returns no violations when oxlint finds nothing', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ diagnostics: [], number_of_files: 0 }),
    );

    const rule = oxlint({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('handles non-zero exit codes by reading stdout from the error', async () => {
    // oxlint exits 1 on violations but still writes JSON to stdout
    const execError = Object.assign(new Error('Command failed'), {
      stdout: OXLINT_JSON,
      status: 1,
    });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw execError;
    });

    const rule = oxlint({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toHaveLength(2);
  });

  it('passes the config file when provided', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => JSON.stringify({ diagnostics: [] }));

    const rule = oxlint({ cwd: '/project', configFile: '.oxlintrc.json' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'oxlint',
      expect.arrayContaining(['--config', '.oxlintrc.json']),
      expect.any(Object),
    );
  });

  it('returns empty array when stdout is not valid JSON', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => 'not json at all');

    const rule = oxlint({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });
});
