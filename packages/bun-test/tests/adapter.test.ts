import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { bunTest } from '../src/adapter';
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

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    mkdtempSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

const JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="math.test" tests="2" failures="1" errors="0">
    <testcase name="adds numbers" classname="math.test" file="/project/src/math.test.ts" line="10" assertions="1"/>
    <testcase name="subtracts numbers" classname="math.test" file="/project/src/math.test.ts" line="20" assertions="1">
      <failure message="expected 3 to be 5">expected 3 to be 5\nat /project/src/math.ts:25:10</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('bun-test adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('parses failed tests from JUnit XML', async () => {
    const tmpDir = '/tmp/gesetz-bun-test-1';
    const tmpFile = nodePath.join(tmpDir, 'junit.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JUNIT_XML);
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = bunTest({ cwd: '/project', label: 'bun:test' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('bun-test');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('subtracts numbers');
    expect(violations[0]?.path).toBe('src/math.test.ts');
    expect(violations[0]?.line).toBe(20);
  });

  it('returns empty array when all tests pass', async () => {
    const tmpDir = '/tmp/gesetz-bun-test-2';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '<?xml version="1.0"?><testsuites><testsuite tests="1" failures="0"/></testsuites>',
    );
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = bunTest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes pattern as positional args', async () => {
    const tmpDir = '/tmp/gesetz-bun-test-3';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '<?xml version="1.0"?><testsuites><testsuite tests="0" failures="0"/></testsuites>',
    );
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = bunTest({ cwd: '/project', pattern: 'src/utils' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'bun',
      expect.arrayContaining(['test', '--reporter=junit', 'src/utils', expect.stringContaining('--reporter-outfile=')]),
      expect.any(Object),
    );
  });

  it('returns empty array when JUnit file is unreadable', async () => {
    const tmpDir = '/tmp/gesetz-bun-test-4';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = bunTest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });
});
