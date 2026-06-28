import { Effect } from 'effect';
import type { Check, Severity, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';
import type { SgNode } from '@ast-grep/napi';

/**
 * Allowlist of JSX attributes known to carry user-visible, natural-language
 * text that should go through a translation API.
 *
 * This is intentionally narrow. Props NOT in this list (e.g. `className`,
 * `href`, `to`, `variant`, `size`, `value`, `src`) carry utility tokens,
 * enum-like identifiers, URLs, or CSS classes — NOT translatable prose — and
 * must never be flagged.
 *
 * Derived from the original immoui rule. Do not broaden without evidence that
 * a prop actually carries user-facing natural language in real codebases.
 */
export const DEFAULT_TEXT_ATTRIBUTES = [
  'label',
  'placeholder',
  'title',
  'aria-label',
  'heading',
  'subtitle',
  'description',
  'helperText',
  'hint',
  'emptyStateHeading',
  'emptyStateDescription',
  'modalHeading',
] as const;

export interface NoHardcodedStringsOptions {
  /**
   * Attributes whose string-literal values are flagged as translatable.
   * Defaults to {@link DEFAULT_TEXT_ATTRIBUTES}.
   */
  readonly textAttributes?: readonly string[];
  /**
   * Severity for attribute violations. Defaults to `'warn'`.
   */
  readonly attributeSeverity?: Severity;
  /** Severity for JSX text nodes. Default: 'error'. */
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
 * Catches exactly two cases — the same two the original immoui rule flagged:
 *
 * 1. **Raw JSX text children** — `<div>Hello world</div>` → flagged
 *    (only when the text contains a letter, so whitespace/ punctuation-only
 *    text is ignored).
 * 2. **String literals on a known, narrow allowlist of translatable props** —
 *    `<input placeholder="Search" />` → flagged. Only props in
 *    {@link DEFAULT_TEXT_ATTRIBUTES} (label, placeholder, title, aria-label,
 *    heading, subtitle, description, helperText, hint, emptyStateHeading,
 *    emptyStateDescription, modalHeading) are checked.
 *
 * ## What is NOT flagged
 *
 * Strings inside JSX **expression containers** (`{...}`) are never flagged.
 * This is deliberate: expression containers carry utility tokens (Tailwind
 * classes inside `cn(...)`, route paths, enum-like prop values, numeric
 * toggles, CSS class strings) far more often than natural-language text, and
 * flagging them produces unworkable false-positive rates. User-facing text in
 * real codebases flows through either JSX text children or named props — both
 * of which are covered above.
 *
 * Non-allowlisted props (`className`, `href`, `to`, `variant`, `size`,
 * `value`, `src`, `alt`, …) are never flagged: they carry tokens/URLs/identifiers,
 * not translatable prose.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * noHardcodedStrings()                                    // defaults
 * noHardcodedStrings({ attributeSeverity: 'error' })      // strict props
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

      // ── Case 1: Raw JSX text children ──
      // <div>Hello world</div>  →  "Hello world" is a jsx_text node.
      // Only flagged when it contains a letter, so whitespace-only and
      // punctuation-only text nodes (commonly used for JSX formatting) are
      // ignored.
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

      // ── Case 2: Known text-bearing attributes with string-literal values ──
      // <input placeholder="Search" />  →  placeholder is in the allowlist and
      // its value is a raw string literal. Props not in the allowlist
      // (className, href, to, variant, size, value, src, ...) are skipped.
      // Expression-container values ({m.foo()}) are skipped — only raw string
      // literals are flagged.
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
