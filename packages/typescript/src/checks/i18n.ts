import { Effect } from 'effect';
import type { Check, Severity, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';
import type { SgNode } from '@ast-grep/napi';

/**
 * Default set of HTML/ARIA attributes known to carry user-visible text.
 * Derived from the HTML spec + common React component libraries.
 *
 * Source: consensus across eslint-plugin-no-hardcoded-strings,
 * eslint-plugin-react/jsx-no-literals, and Shopify's jsx-no-hardcoded-content.
 */
export const DEFAULT_TEXT_ATTRIBUTES = [
  'label',
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'heading',
  'subtitle',
  'description',
  'helperText',
  'hint',
  'caption',
  'summary',
  'content',
  'text',
  'message',
  'tooltip',
  'emptyStateHeading',
  'emptyStateDescription',
  'modalHeading',
  'modalLabel',
  'confirmText',
  'cancelText',
  'okText',
  'submitText',
  'buttonText',
] as const;

export interface NoHardcodedStringsOptions {
  /**
   * Attributes whose string-literal values are flagged as translatable.
   * Defaults to {@link DEFAULT_TEXT_ATTRIBUTES}.
   */
  readonly textAttributes?: readonly string[];
  /**
   * Severity for attribute violations. Defaults to `'warn'` — attributes like
   * `className` or `href` are not translatable, so we only check a known
   * allowlist and warn (rather than error) to avoid false positives on
   * edge cases like `alt="logo"`.
   */
  readonly attributeSeverity?: Severity;
  /** Severity for JSX text nodes and expression-container strings. Default: 'error'. */
  readonly textSeverity?: Severity;
  /**
   * Regex to detect "letter" content. Strings matching this are considered
   * user-facing text. Default: any Latin/German letter.
   */
  readonly hasLetterRegex?: RegExp;
}

/** Returns the unquoted string value of a `string` node, or null. */
function stringLiteralValue(node: SgNode): string | null {
  if (node.kind() !== 'string') return null;
  const frag = node.find({ rule: { kind: 'string_fragment' } });
  return frag ? frag.text() : '';
}

/**
 * Flags hardcoded user-visible strings in JSX that should go through a
 * translation API (e.g. Paraglide `m.*()`, react-intl `FormattedMessage`).
 *
 * Catches three cases in one pass:
 *
 * 1. **JSX text nodes** — `<div>Hello world</div>` → flagged (letters present)
 * 2. **String literals in JSX expressions** — `<div>{"Hello world"}</div>` → flagged
 * 3. **Known text-bearing attributes** — `<input placeholder="Search" />` → flagged
 *
 * Implemented with ast-grep (syntactic). Replaces the ts-morph version.
 *
 * @example
 * noHardcodedStrings()                                    // defaults
 * noHardcodedStrings({ attributeSeverity: 'error' })      // strict
 * noHardcodedStrings({ textAttributes: ['label', 'placeholder'] })
 */
export function noHardcodedStrings(opts: NoHardcodedStringsOptions = {}): Check {
  const textAttributes = new Set(opts.textAttributes ?? DEFAULT_TEXT_ATTRIBUTES);
  const attributeSeverity: Severity = opts.attributeSeverity ?? 'warn';
  const textSeverity: Severity = opts.textSeverity ?? 'error';
  const hasLetter = opts.hasLetterRegex ?? /[A-Za-zÄÖÜäöüßÀ-ÿ]/;

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];

      // ── Case 1: JSX text nodes ──
      for (const node of findByKind(root, 'jsx_text')) {
        const text = node.text();
        if (hasLetter.test(text)) {
          violations.push({
            rule: '',
            severity: textSeverity,
            source: 'core',
            message: `JSX text "${text.trim().slice(0, 40)}" must use a translation API`,
            path: file.path,
            line: startLine(node),
            context: `JSX text: ${JSON.stringify(text.trim().slice(0, 60))}`,
          });
        }
      }

      // ── Case 2: String literals directly inside JSX expression containers ──
      for (const expr of findByKind(root, 'jsx_expression')) {
        // The inner string literal (if any) is a direct `string` child.
        const innerStr = expr.find({ rule: { kind: 'string' } });
        if (!innerStr) continue;
        const value = stringLiteralValue(innerStr) ?? '';
        if (hasLetter.test(value)) {
          violations.push({
            rule: '',
            severity: textSeverity,
            source: 'core',
            message: `String literal "${value.slice(0, 40)}" in JSX must use a translation API`,
            path: file.path,
            line: startLine(innerStr),
            context: `JSX expression: ${JSON.stringify(value.slice(0, 60))}`,
          });
        }
      }

      // ── Case 3: Known text-bearing attributes with string-literal values ──
      for (const attr of findByKind(root, 'jsx_attribute')) {
        const name = attr.child(0)?.text() ?? '';
        if (!textAttributes.has(name)) continue;

        // Only flag raw string literals, not expression containers like {m.foo()}
        const valueNode = attr.children().find((c) => c.kind() === 'string');
        if (!valueNode) continue;

        const value = stringLiteralValue(valueNode) ?? '';
        if (hasLetter.test(value)) {
          violations.push({
            rule: '',
            severity: attributeSeverity,
            source: 'core',
            message: `Prop '${name}'="${value.slice(0, 40)}" should use a translation API`,
            path: file.path,
            line: startLine(attr),
            context: `prop ${name}=${JSON.stringify(value.slice(0, 60))}`,
          });
        }
      }

      return violations;
    });
}
