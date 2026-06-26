import { Effect } from 'effect';
import type { Check, Severity, Violation } from '@regeln/core';
import type {
  JsxAttribute,
  JsxExpression,
  JsxText,
  StringLiteral,
} from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Default set of HTML/ARIA attributes known to carry user-visible text.
 * Derived from the HTML spec + common React component libraries.
 * String literals assigned to these attributes are likely translatable.
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
  textAttributes?: readonly string[];
  /**
   * Severity for attribute violations. Defaults to `'warn'` — attributes like
   * `className` or `href` are not translatable, so we only check a known
   * allowlist and warn (rather than error) to avoid false positives on
   * edge cases like `alt="logo"`.
   */
  attributeSeverity?: Severity;
  /** Severity for JSX text nodes and expression-container strings. Default: 'error'. */
  textSeverity?: Severity;
  /**
   * Regex to detect "letter" content. Strings matching this are considered
   * user-facing text. Default: any Latin/German letter.
   */
  hasLetterRegex?: RegExp;
  tsConfigPath?: string;
}

/**
 * Flags hardcoded user-visible strings in JSX that should go through a
 * translation API (e.g. Paraglide `m.*()`, react-intl `FormattedMessage`).
 *
 * This is the recommended replacement for the separate `noLiteralJsxText` +
 * `noLiteralJsxProp` checks. It catches three cases in one pass:
 *
 * 1. **JSX text nodes** — `<div>Hello world</div>` → flagged (letters present)
 * 2. **String literals in JSX expressions** — `<div>{"Hello world"}</div>` → flagged
 * 3. **Known text-bearing attributes** — `<input placeholder="Search" />` → flagged
 *
 * Case 3 uses a configurable allowlist (`textAttributes`) because we cannot
 * generically distinguish translatable props from non-translatable ones
 * (`className`, `href`, `src`, `width`, …). By default these surface as
 * **warnings**, not errors, to allow for edge cases like `alt="logo"`.
 *
 * Non-translatable attributes (anything not in the allowlist) are ignored.
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
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // ── Case 1: JSX text nodes (SyntaxKind.JsxText = 12) ──
      const jsxTexts: readonly JsxText[] = sf.getDescendantsOfKind?.(12) ?? [];
      for (const node of jsxTexts) {
        const text = node.getText?.() ?? '';
        if (hasLetter.test(text)) {
          violations.push({
            rule: '',
            severity: textSeverity,
            source: 'core',
            message: `JSX text "${text.trim().slice(0, 40)}" must use a translation API`,
            path: file.path,
            line: node.getStartLineNumber?.(),
            context: `JSX text: ${JSON.stringify(text.trim().slice(0, 60))}`,
          });
        }
      }

      // ── Case 2: String literals inside JSX expression containers ──
      // SyntaxKind.JsxExpression = 285
      const jsxExpressions: readonly JsxExpression[] = sf.getDescendantsOfKind?.(285) ?? [];
      for (const expr of jsxExpressions) {
        // Only flag string literals directly inside the expression — not
        // nested calls like {m.foo()} or variables {title}.
        const inner = expr.getExpression?.();
        if (!inner) continue;
        // SyntaxKind.StringLiteral = 10
        if (inner.getKind?.() !== 10) continue;

        const strNode = inner as StringLiteral;
        const value = strNode.getLiteralValue?.() ?? '';
        if (hasLetter.test(value)) {
          violations.push({
            rule: '',
            severity: textSeverity,
            source: 'core',
            message: `String literal "${value.slice(0, 40)}" in JSX must use a translation API`,
            path: file.path,
            line: strNode.getStartLineNumber?.(),
            context: `JSX expression: ${JSON.stringify(value.slice(0, 60))}`,
          });
        }
      }

      // ── Case 3: Known text-bearing attributes with string-literal values ──
      // SyntaxKind.JsxAttribute = 287
      const jsxAttrs: readonly JsxAttribute[] = sf.getDescendantsOfKind?.(287) ?? [];
      for (const attr of jsxAttrs) {
        const name = attr.getNameNode?.()?.getText?.() ?? '';
        if (!textAttributes.has(name)) continue;

        const initializer = attr.getInitializer?.();
        if (!initializer) continue;

        // SyntaxKind.StringLiteral = 10 — only flag raw string literals,
        // not expression containers like placeholder={m.foo()}
        if (initializer.getKind?.() !== 10) continue;

        const value = (initializer as StringLiteral).getLiteralValue?.() ?? '';
        if (hasLetter.test(value)) {
          violations.push({
            rule: '',
            severity: attributeSeverity,
            source: 'core',
            message: `Prop '${name}'="${value.slice(0, 40)}" should use a translation API`,
            path: file.path,
            line: attr.getStartLineNumber?.(),
            context: `prop ${name}=${JSON.stringify(value.slice(0, 60))}`,
          });
        }
      }

      return violations;
    });
}
