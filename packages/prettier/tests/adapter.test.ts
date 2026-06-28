import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { Effect, Layer } from 'effect';
import { prettier } from '../src/adapter';
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

describe('prettier adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('maps unformatted files to warning violations', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
      'src/a.ts\nsrc/b.tsx\n',
    );

    const rule = prettier({ cwd: '/project', label: 'Prettier' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.rule).toBe('prettier');
    expect(violations[0]?.severity).toBe('warn');
    expect(violations[0]?.path).toBe('src/a.ts');
    expect(violations[0]?.message).toContain('not formatted');
    expect(violations[1]?.path).toBe('src/b.tsx');
  });

  it('returns empty array when all files are formatted', async () => {
    const execError = Object.assign(new Error('exit 1'), { stdout: '', status: 1 });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw execError;
    });

    const rule = prettier({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes config file option', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = prettier({ cwd: '/project', configFile: '.prettierrc.json' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--list-different', '.', '--config', '.prettierrc.json']),
      expect.any(Object),
    );
  });

  it('passes pattern instead of default dot', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = prettier({ cwd: '/project', pattern: 'src' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--list-different', 'src']),
      expect.any(Object),
    );
  });
});
