/**
 * JUnit XML parser — shared by bun:test, Pest, PHPUnit, and any tool that
 * emits JUnit XML (`--log-junit`, `--reporter=junit`, etc.).
 *
 * JUnit XML is the de-facto interchange format for test results. Structure:
 *   <testsuites>
 *     <testsuite name="..." file="..." >
 *       <testcase name="..." classname="..." file="..." line="N">
 *         <failure type="..." message="...">stack trace</failure>
 *         <error type="..." message="...">stack trace</error>
 *       </testcase>
 *     </testsuite>
 *   </testsuites>
 *
 * `file` and `line` attributes on `<testcase>` are non-standard but emitted
 * by bun:test and Pest. When absent, we fall back to the parent `<testsuite>`
 * `file` attribute and leave the line undefined.
 */
import * as nodePath from 'node:path';
import type { Violation } from '@regeln/core';

export interface ParsedTestCase {
  readonly name: string;
  readonly classname: string;
  readonly file: string;
  readonly line: number | undefined;
  readonly status: 'passed' | 'failed' | 'skipped' | 'errored';
  readonly message: string;
  readonly stack: string;
}

function extractAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1];
}

/**
 * Parses a JUnit XML document into a list of test cases.
 *
 * Uses a regex-based approach: finds all `<testsuite file="...">` opening tags
 * to track the current suite's file, then finds all `<testcase ...>` blocks
 * (self-closing or with children) and extracts their status from
 * `<failure>`/`<error>`/`<skipped>` children.
 */
export function parseJUnitXml(xml: string, cwd: string): ParsedTestCase[] {
  const cases: ParsedTestCase[] = [];

  // Find each <testsuite ... file="..." ...> opening tag to track suite file.
  // (Closing </testsuite> tags don't carry a file attribute, so we just let
  // the next opening tag overwrite suiteFile.)
  const suiteOpenRe = /<testsuite\b([^>]*)>/gi;

  // Find each <testcase ...> block — either self-closing or with a body
  // up to </testcase>.
  const caseRe =
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;

  // Build a map of testcase positions to the nearest preceding suite file.
  // Walk through suite openings and testcase matches in order.
  let suiteFile = '';

  // Collect suite file changes with their positions
  const suiteFiles: Array<{ pos: number; file: string }> = [];
  let suiteMatch: RegExpExecArray | null;
  while ((suiteMatch = suiteOpenRe.exec(xml)) !== null) {
    const attrs = suiteMatch[1] ?? '';
    const file = extractAttr(attrs, 'file');
    if (file) {
      suiteFiles.push({ pos: suiteMatch.index, file });
    }
  }

  let caseMatch: RegExpExecArray | null;
  let suiteIdx = 0;
  while ((caseMatch = caseRe.exec(xml)) !== null) {
    const casePos = caseMatch.index;
    // Advance suiteFile to the latest suite opening before this testcase
    while (suiteIdx < suiteFiles.length && suiteFiles[suiteIdx]!.pos <= casePos) {
      suiteFile = suiteFiles[suiteIdx]!.file;
      suiteIdx++;
    }

    const attrs = caseMatch[1] ?? '';
    const body = caseMatch[2] ?? '';

    const name = extractAttr(attrs, 'name') ?? 'unknown';
    const classname = extractAttr(attrs, 'classname') ?? '';
    const file = extractAttr(attrs, 'file') ?? suiteFile;
    const lineStr = extractAttr(attrs, 'line');
    const line = lineStr !== undefined ? Number(lineStr) : undefined;

    let status: ParsedTestCase['status'] = 'passed';
    let message = '';
    let stack = '';

    const failureMatch = /<failure\b([^>]*)>([\s\S]*?)<\/failure>/i.exec(body)
      ?? (/<failure\b([^>]*?)\/>/i.exec(body));
    if (failureMatch) {
      status = 'failed';
      message = extractAttr(failureMatch[1] ?? '', 'message') ?? '';
      stack = (failureMatch[2] ?? '').trim();
    }

    if (status === 'passed') {
      const errorMatch = /<error\b([^>]*)>([\s\S]*?)<\/error>/i.exec(body)
        ?? (/<error\b([^>]*?)\/>/i.exec(body));
      if (errorMatch) {
        status = 'errored';
        message = extractAttr(errorMatch[1] ?? '', 'message') ?? '';
        stack = (errorMatch[2] ?? '').trim();
      }
    }

    if (status === 'passed' && /<skipped\b/i.test(body)) {
      status = 'skipped';
    }

    const relativePath = file ? nodePath.relative(cwd, nodePath.resolve(cwd, file)) : cwd;
    cases.push({
      name,
      classname,
      file: relativePath || file || cwd,
      line: Number.isFinite(line) ? line : undefined,
      status,
      message: message || (status === 'failed' ? `${classname} > ${name} failed` : ''),
      stack,
    });
  }

  return cases;
}

/**
 * Converts parsed JUnit test cases to Violations.
 * Only failed and errored tests produce violations.
 */
export function junitToViolations(
  cases: readonly ParsedTestCase[],
  ruleId: string,
): Violation[] {
  return cases
    .filter((c) => c.status === 'failed' || c.status === 'errored')
    .map((c): Violation => {
      const detail = c.message || `${c.classname} > ${c.name} failed`;
      return {
        rule: ruleId,
        message: `${c.name}: ${detail}`,
        path: c.file,
        line: c.line,
        severity: 'error',
        source: 'custom',
        context: c.stack ? c.stack.split('\n').slice(0, 5).join('\n') : undefined,
      };
    });
}
