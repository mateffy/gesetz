import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { phpunit } from '../src/adapter';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive, TsAdapterStub, PhpAdapterStub } from '@regeln/core';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  TsAdapterStub,
  PhpAdapterStub,
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

const PHPUNIT_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Tests\\Unit\\ExampleTest" tests="2" assertions="2" failures="1" errors="0" time="0.05">
    <testcase name="it passes" classname="Tests\\Unit\\ExampleTest" file="/project/tests/Unit/ExampleTest.php" line="12" assertions="1" time="0.01"/>
    <testcase name="it fails" classname="Tests\\Unit\\ExampleTest" file="/project/tests/Unit/ExampleTest.php" line="20" assertions="1" time="0.02">
      <failure type="AssertionError" message="Failed asserting that false is true.">Failed asserting that false is true.
at /project/tests/Unit/ExampleTest.php:20</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('phpunit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('maps failed tests to violations from JUnit XML', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(nodePath.dirname(tmpFile));
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(PHPUNIT_JUNIT);
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('phpunit exited 1');
    });

    const rule = phpunit({ cwd: '/project', label: 'PHPUnit' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('phpunit');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.path).toBe('tests/Unit/ExampleTest.php');
    expect(violations[0]?.line).toBe(20);
    expect(violations[0]?.message).toContain('it fails');
    expect(violations[0]?.message).toContain('Failed asserting');
  });

  it('passes the config file when provided', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit2.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(nodePath.dirname(tmpFile));
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('');
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = phpunit({ cwd: '/project', configFile: 'phpunit.xml' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'vendor/bin/phpunit',
      expect.arrayContaining(['--configuration', 'phpunit.xml']),
      expect.any(Object),
    );
  });

  it('returns empty array when JUnit file is empty', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit3.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(nodePath.dirname(tmpFile));
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('');
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('exit 1');
    });

    const rule = phpunit({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes the filter option as --filter', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit4.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(nodePath.dirname(tmpFile));
    (nodeFs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('');
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => '');

    const rule = phpunit({ cwd: '/project', filter: 'testOnlyFeature' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'vendor/bin/phpunit',
      expect.arrayContaining(['--filter', 'testOnlyFeature']),
      expect.any(Object),
    );
  });
});
