import { Effect } from 'effect';
import type { Check, Violation } from '@regeln/core';
import type { JsxAttribute, JsxOpeningElement, JsxSelfClosingElement, JsxText } from 'ts-morph';
import { loadSourceFile } from './shared';

/**
 * Checks that JSX files contain no raw text (letters) in JSX text nodes.
 * Use this to enforce i18n: all user-facing strings must go through a translation API.
 *
 * Prefer `noHardcodedStrings` from `./i18n` for comprehensive coverage.
 *
 * @example
 * noLiteralJsxText({ hasLetterRegex: /[A-Za-zÄÖÜäöü]/ })
 */
export function noLiteralJsxText(
  opts: {
    hasLetterRegex?: RegExp;
    tsConfigPath?: string;
    message?: string;
  } = {},
): Check {
  const hasLetter = opts.hasLetterRegex ?? /[A-Za-zÄÖÜäöüß]/;

  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // SyntaxKind.JsxText = 12
      const jsxTexts: readonly JsxText[] = sf.getDescendantsOfKind?.(12) ?? [];

      for (const node of jsxTexts) {
        const text = node.getText?.() ?? '';
        if (hasLetter.test(text)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message ?? `Raw text in JSX is not allowed — use a translation API`,
            path: file.path,
            line: node.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

/**
 * Checks that listed JSX attribute names do not have string literal values.
 * Use this alongside `noLiteralJsxText` to enforce i18n for all translatable props.
 *
 * Prefer `noHardcodedStrings` from `./i18n` for comprehensive coverage.
 *
 * @example
 * noLiteralJsxProp(['label', 'placeholder', 'title', 'aria-label'])
 */
export function noLiteralJsxProp(
  translatableProps: string[],
  opts: {
    tsConfigPath?: string;
    message?: (propName: string) => string;
  } = {},
): Check {
  const propSet = new Set(translatableProps);

  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // SyntaxKind.JsxAttribute = 287
      const jsxAttrs: readonly JsxAttribute[] = sf.getDescendantsOfKind?.(287) ?? [];

      for (const attr of jsxAttrs) {
        const name = attr.getNameNode?.()?.getText?.() ?? '';
        if (!propSet.has(name)) continue;

        const initializer = attr.getInitializer?.();
        if (!initializer) continue;

        // SyntaxKind.StringLiteral = 10
        if (initializer.getKind?.() === 10) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(name) ??
              `Prop '${name}' must not use a raw string literal — use a translation API`,
            path: file.path,
            line: attr.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}

/**
 * Checks that no JSX elements with the given tag names are used.
 *
 * @example
 * // Route components must not render raw HTML elements
 * noJsxElements(['div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'table'])
 */
export function noJsxElements(
  elements: string[],
  opts: {
    tsConfigPath?: string;
    message?: (tagName: string) => string;
  } = {},
): Check {
  const elementSet = new Set(elements);

  return (file) =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, opts.tsConfigPath);

      if (sourceFile === null) return [];

      const sf = sourceFile._tsMorph;
      const violations: Violation[] = [];

      // SyntaxKind.JsxOpeningElement = 281, SyntaxKind.JsxSelfClosingElement = 283
      const openingElements: readonly JsxOpeningElement[] = sf.getDescendantsOfKind?.(281) ?? [];
      const selfClosingElements: readonly JsxSelfClosingElement[] = sf.getDescendantsOfKind?.(283) ?? [];

      for (const el of [...openingElements, ...selfClosingElements]) {
        const tagName = el.getTagNameNode?.()?.getText?.() ?? '';
        if (elementSet.has(tagName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(tagName) ??
              `Raw HTML element <${tagName}> is not allowed here`,
            path: file.path,
            line: el.getStartLineNumber?.(),
          });
        }
      }

      return violations;
    });
}
