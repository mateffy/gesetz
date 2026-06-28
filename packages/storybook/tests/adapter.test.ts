import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { storybook } from '../src/adapter';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive, SyntaxTreeStub, ImportResolverDefault } from '@gesetz/core';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive('/project'),
  FileFilterLive(null),
);

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    mkdtempSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// Jest-compatible JSON emitted by `test-storybook --json --outputFile <file>`
const STORYBOOK_JSON = JSON.stringify({
  numFailedTests: 1,
  testResults: [
    {
      name: '/project/src/components/ui/Button.stories.tsx',
      assertionResults: [
        {
          fullName: 'Button > default interaction',
          title: 'Button',
          status: 'passed',
          failureMessages: [],
        },
        {
          fullName: 'Button > a11y',
          title: 'Button a11y',
          status: 'failed',
          failureMessages: [
            'Element does not have enough contrast\n    at /project/src/components/ui/Button.tsx:42:5',
          ],
        },
      ],
    },
  ],
});

describe('storybook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('maps failed story assertions to violations', async () => {
    const tmpDir = '/tmp/gesetz-storybook-test-1';
    const tmpFile = nodePath.join(tmpDir, 'results.json');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(STORYBOOK_JSON);
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('exit 1');
    });

    const rule = storybook({ cwd: '/project', url: 'http://localhost:6006' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('storybook');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('Button > a11y');
    expect(violations[0]?.path).toBe('src/components/ui/Button.tsx');
    expect(violations[0]?.line).toBe(42);
  });

  it('passes the URL and --ci flag', async () => {
    const tmpDir = '/tmp/gesetz-storybook-test-2';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = storybook({ cwd: '/project', url: 'http://localhost:9009' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--url', 'http://localhost:9009', '--ci']),
      expect.any(Object),
    );
  });

  it('returns empty array when no failures', async () => {
    const tmpDir = '/tmp/gesetz-storybook-test-3';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ numFailedTests: 0, testResults: [] }),
    );
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = storybook({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });
});
