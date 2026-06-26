import * as nodeFs from 'node:fs';
import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';

/**
 * Writes JUnit XML output. Compatible with phpunit, Pest, and any CI system.
 *
 * One `<testcase>` per rule. Violations become `<failure>` elements.
 *
 * @param outputPath Optional file path. If omitted, writes to stdout.
 */
export const JUnitReporter = (outputPath?: string): Layer.Layer<Reporter> =>
  Layer.succeed(Reporter, {
    report: (result: RunResult): Effect.Effect<void, ReporterError> =>
      Effect.try({
        try: () => {
          const totalTests = result.byRule.length;
          const totalFailures = result.byRule.filter((r) => r.violations.length > 0).length;

          const testCases = result.byRule.map((r) => {
            const failures = r.violations
              .map(
                (v) =>
                  `      <failure message="${escapeXml(v.message)}">${escapeXml(
                    `${v.path}:${v.line ?? '?'} \u2014 ${v.message}`,
                  )}</failure>`,
              )
              .join('\n');

            const lines = [
              `    <testcase name="${escapeXml(r.description || r.ruleId)}" classname="QualityAssurance">`,
              failures,
              `    </testcase>`,
            ];

            return lines.join('\n');
          });

          const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<testsuite name="Quality Assurance" tests="${totalTests}" failures="${totalFailures}" errors="0">`,
            ...testCases,
            '</testsuite>',
          ].join('\n');

          if (outputPath) {
            nodeFs.writeFileSync(outputPath, xml, 'utf-8');
          } else {
            process.stdout.write(xml + '\n');
          }
        },
        catch: (cause) => new ReporterError({ cause }),
      }),
  });

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
