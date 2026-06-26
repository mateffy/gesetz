import { describe, it, expect } from 'vitest';
import { parseJUnitXml, junitToViolations } from '../src/index';

const BUN_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="buntest" tests="2" assertions="2" failures="1" skipped="0" time="0.008">
  <testsuite name="sample.test.ts" file="sample.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0">
    <testsuite name="sample" file="sample.test.ts" line="2" tests="2" assertions="2" failures="1" skipped="0" time="0">
      <testcase name="passes" classname="sample" time="0" file="sample.test.ts" line="3" assertions="1" />
      <testcase name="fails" classname="sample" time="0.00008" file="sample.test.ts" line="4" assertions="1">
        <failure type="AssertionError" message="expected 1 to be 2" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

const PEST_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/Unit/ExampleTest.php" tests="2" assertions="2" failures="1" errors="0" time="0.05">
    <testcase name="it passes" classname="Tests\\Unit\\ExampleTest" file="tests/Unit/ExampleTest.php" line="12" assertions="1" time="0.01"/>
    <testcase name="it fails" classname="Tests\\Unit\\ExampleTest" file="tests/Unit/ExampleTest.php" line="20" assertions="1" time="0.02">
      <failure type="AssertionError" message="Failed asserting that false is true.">Failed asserting that false is true.
at tests/Unit/ExampleTest.php:20</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('parseJUnitXml', () => {
  it('parses bun:test JUnit output', () => {
    const cases = parseJUnitXml(BUN_JUNIT, '/cwd');
    expect(cases).toHaveLength(2);
    expect(cases[0]?.name).toBe('passes');
    expect(cases[0]?.status).toBe('passed');
    expect(cases[1]?.name).toBe('fails');
    expect(cases[1]?.status).toBe('failed');
    expect(cases[1]?.line).toBe(4);
    expect(cases[1]?.message).toBe('expected 1 to be 2');
  });

  it('parses pest JUnit output', () => {
    const cases = parseJUnitXml(PEST_JUNIT, '/cwd');
    expect(cases).toHaveLength(2);
    expect(cases[0]?.status).toBe('passed');
    expect(cases[1]?.status).toBe('failed');
    expect(cases[1]?.line).toBe(20);
    expect(cases[1]?.message).toContain('Failed asserting');
  });

  it('returns empty array for invalid XML', () => {
    const cases = parseJUnitXml('not xml', '/cwd');
    expect(cases).toEqual([]);
  });
});

describe('junitToViolations', () => {
  it('maps only failed and errored tests to violations', () => {
    const cases = parseJUnitXml(BUN_JUNIT, '/cwd');
    const violations = junitToViolations(cases, 'bun-test');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('bun-test');
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.line).toBe(4);
  });
});
