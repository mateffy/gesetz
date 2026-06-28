import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { pest } from '../src/adapter';
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
  <testsuite name="Unit" tests="2" failures="1" errors="0">
    <testcase name="it_can_add_numbers" classname="Tests\\Unit\\MathTest" file="/project/tests/Unit/MathTest.php" line="12" assertions="1"/>
    <testcase name="it_can_subtract_numbers" classname="Tests\\Unit\\MathTest" file="/project/tests/Unit/MathTest.php" line="20" assertions="1">
      <failure message="Failed asserting that 3 matches expected 5.">Failed asserting that 3 matches expected 5.</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('pest adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('parses failed tests from JUnit XML', async () => {
    const tmpDir = '/tmp/gesetz-pest-test-1';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JUNIT_XML);
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = pest({ cwd: '/project', label: 'Pest' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('pest');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('it_can_subtract_numbers');
    expect(violations[0]?.path).toBe('tests/Unit/MathTest.php');
    expect(violations[0]?.line).toBe(20);
  });

  it('returns empty array when all tests pass', async () => {
    const tmpDir = '/tmp/gesetz-pest-test-2';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '<?xml version="1.0"?><testsuites><testsuite tests="1" failures="0"/></testsuites>',
    );
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = pest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes extra args and pattern', async () => {
    const tmpDir = '/tmp/gesetz-pest-test-3';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      '<?xml version="1.0"?><testsuites><testsuite tests="0" failures="0"/></testsuites>',
    );
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = pest({ cwd: '/project', extraArgs: ['--parallel'], pattern: 'tests/Unit' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'vendor/bin/pest',
      expect.arrayContaining([
        '--log-junit',
        expect.stringContaining('junit.xml'),
        '--no-progress',
        '--parallel',
        'tests/Unit',
      ]),
      expect.any(Object),
    );
  });

  it('returns empty array when JUnit file is unreadable', async () => {
    const tmpDir = '/tmp/gesetz-pest-test-4';
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');

    const rule = pest({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });
});
