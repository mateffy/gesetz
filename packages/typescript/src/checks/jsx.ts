import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind, startLine } from './shared';

/**
 * Checks that JSX files contain no raw text (letters) in JSX text nodes.
 * Use this to enforce i18n: all user-facing strings must go through a translation API.
 *
 * Prefer `noHardcodedStrings` from `./i18n` for comprehensive coverage.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * noLiteralJsxText({ hasLetterRegex: /[A-Za-zÄÖÜäöü]/ })
 */
export function noLiteralJsxText(
  opts: {
    readonly hasLetterRegex?: RegExp;
    readonly message?: string;
  } = {},
): Check {
  const hasLetter = opts.hasLetterRegex ?? /[A-Za-zÄÖÜäöüß]/;

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const jsxTexts = findByKind(root, 'jsx_text');
      for (const node of jsxTexts) {
        const text = node.text();
        if (hasLetter.test(text)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message ?? `Raw text in JSX is not allowed — use a translation API`,
            path: file.path,
            line: startLine(node),
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
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * noLiteralJsxProp(['label', 'placeholder', 'title', 'aria-label'])
 */
export function noLiteralJsxProp(
  translatableProps: string[],
  opts: {
    readonly message?: (propName: string) => string;
  } = {},
): Check {
  const propSet = new Set(translatableProps);

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      const jsxAttrs = findByKind(root, 'jsx_attribute');
      for (const attr of jsxAttrs) {
        const name = attr.child(0)?.text() ?? '';
        if (!propSet.has(name)) continue;

        // Find a string-literal value child (exclude jsx_expression like {foo})
        const valueNode = attr.children().find((c) => c.kind() === 'string');
        if (!valueNode) continue;

        violations.push({
          rule: '',
          severity: 'error',
          source: 'core',
          message:
            opts.message?.(name) ??
            `Prop '${name}' must not use a raw string literal — use a translation API`,
          path: file.path,
          line: startLine(attr),
        });
      }
      return violations;
    });
}

/**
 * Checks that no JSX elements with the given tag names are used.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * // Route components must not render raw HTML elements
 * noJsxElements(['div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'table'])
 */
export function noJsxElements(
  elements: string[],
  opts: {
    readonly message?: (tagName: string) => string;
  } = {},
): Check {
  const elementSet = new Set(elements);

  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      // <Tag>...</Tag>  → jsx_opening_element
      // <Tag />         → jsx_self_closing_element
      // In both, child(1) is the tag identifier (child(0) is `<`).
      const checkElement = (node: import('@ast-grep/napi').SgNode): void => {
        const tagNode = node.children()[1];
        if (!tagNode) return;
        const tagName = tagNode.text();
        if (elementSet.has(tagName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: opts.message?.(tagName) ?? `Raw HTML element <${tagName}> is not allowed here`,
            path: file.path,
            line: startLine(node),
          });
        }
      };

      for (const node of findByKind(root, 'jsx_opening_element')) checkElement(node);
      for (const node of findByKind(root, 'jsx_self_closing_element')) checkElement(node);

      return violations;
    });
}
