import * as nodeFs from 'node:fs';
import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult, RuleResult } from '../engine/runner';
import type { Violation } from '../engine/rule';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One `<failure>` element for a violation. */
function failureXml(violation: Violation): string {
  const location = `${violation.path}:${violation.line ?? '?'} — ${violation.message}`;
  return `      <failure message="${escapeXml(violation.message)}">${escapeXml(location)}</failure>`;
}

/** One `<testcase>` per rule, with the rule's violations as its failures. */
function testCaseXml(rule: RuleResult): string {
  return [
    `    <testcase name="${escapeXml(rule.description || rule.ruleId)}" classname="QualityAssurance">`,
    rule.violations.map(failureXml).join('\n'),
    '    </testcase>',
  ].join('\n');
}

/**
 * Renders a run as a JUnit XML document. Compatible with phpunit, Pest, and any
 * CI system: one `<testcase>` per rule, one `<failure>` per violation.
 */
export function junitXml(result: RunResult): string {
  const totalTests = result.byRule.length;
  const totalFailures = result.byRule.filter((rule) => rule.violations.length > 0).length;

  return [
    XML_DECLARATION,
    `<testsuite name="Quality Assurance" tests="${totalTests}" failures="${totalFailures}" errors="0">`,
    ...result.byRule.map(testCaseXml),
    '</testsuite>',
  ].join('\n');
}

/** Writes the JUnit document to a file, or to stdout when no path is given. */
export function writeJUnitReport(result: RunResult, outputPath?: string): void {
  const xml = junitXml(result);
  if (outputPath) nodeFs.writeFileSync(outputPath, xml, 'utf-8');
  else process.stdout.write(`${xml}\n`);
}

/**
 * Writes JUnit XML output.
 *
 * @param outputPath Optional file path. If omitted, writes to stdout.
 */
export const JUnitReporter = (outputPath?: string): Layer.Layer<Reporter> =>
  Layer.succeed(Reporter, {
    report: (result: RunResult): Effect.Effect<void, ReporterError> =>
      Effect.try({
        try: () => writeJUnitReport(result, outputPath),
        catch: (cause) => new ReporterError({ cause }),
      }),
  });
