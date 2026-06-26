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
  });

  it('maps failed tests to violations from JUnit XML', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit.xml');
    vi.spyOn(nodeFs, 'mkdtempSync').mockReturnValue(nodePath.dirname(tmpFile));
    vi.spyOn(nodeFs, 'readFileSync').mockReturnValue(PHPUNIT_JUNIT);
    vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => undefined);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
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
    vi.spyOn(nodeFs, 'mkdtempSync').mockReturnValue(nodePath.dirname(tmpFile));
    vi.spyOn(nodeFs, 'readFileSync').mockReturnValue('');
    vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation(() => '');

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
    vi.spyOn(nodeFs, 'mkdtempSync').mockReturnValue(nodePath.dirname(tmpFile));
    vi.spyOn(nodeFs, 'readFileSync').mockReturnValue('');
    vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => undefined);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('exit 1');
    });

    const rule = phpunit({ cwd: '/project' });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it('passes the filter option as --filter', async () => {
    const tmpFile = nodePath.join(nodeOs.tmpdir(), 'regeln-phpunit-test-junit4.xml');
    vi.spyOn(nodeFs, 'mkdtempSync').mockReturnValue(nodePath.dirname(tmpFile));
    vi.spyOn(nodeFs, 'readFileSync').mockReturnValue('');
    vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation(() => '');

    const rule = phpunit({ cwd: '/project', filter: 'testOnlyFeature' });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      'vendor/bin/phpunit',
      expect.arrayContaining(['--filter', 'testOnlyFeature']),
      expect.any(Object),
    );
  });
});
