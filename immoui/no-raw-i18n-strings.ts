/**
 * No raw i18n strings in JSX — composition of core primitives.
 *
 * - No raw text between JSX tags
 * - No string literals in translatable props
 */
import { select } from '@regeln/core';
import { noLiteralJsxText, noLiteralJsxProp } from '@regeln/typescript';

const TRANSLATABLE_PROPS = [
  'label',
  'placeholder',
  'title',
  'heading',
  'helperText',
  'hint',
  'aria-label',
  'description',
  'emptyStateHeading',
  'emptyStateDescription',
  'modalHeading',
  'subtitle',
];

export const noRawJsxText = select('src/**/*.tsx')
  .exclude('**/*.test.tsx', '**/*.stories.tsx')
  .label('No raw text in JSX — use the translation API')
  .check(noLiteralJsxText());

export const noRawJsxProps = select('src/**/*.tsx')
  .exclude('**/*.test.tsx', '**/*.stories.tsx')
  .label('No raw string literals in translatable JSX props — use the translation API')
  .check(noLiteralJsxProp(TRANSLATABLE_PROPS));
