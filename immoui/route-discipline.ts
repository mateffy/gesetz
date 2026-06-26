/**
 * Route pages discipline — composition of core primitives.
 *
 * Route files must:
 * - Not import raw UI primitives
 * - Not define local helper components
 * - Not use useState for tab switching
 * - Not use useState at all
 */
import { select } from '@regeln/core';
import { noImportFrom } from '@regeln/core';
import { noFunctionCalls, noLocalFunctionComponents } from '@regeln/typescript';

const HTML_ELEMENTS = [
  'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'a', 'button', 'form', 'input',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'section', 'article', 'header', 'footer', 'main', 'nav',
];

export const noUiPrimitiveImports = select('src/routes/**/*.tsx')
  .label('Route pages must not import raw UI primitives')
  .check(
    noImportFrom(/^~\/components\/ui\//, {
      message: 'Route pages must not import UI primitives directly — use layout or domain components',
    }),
  );

export const noLocalComponentsInRoutes = select('src/routes/**/*.tsx')
  .label('Route pages must not define local helper components')
  .check(noLocalFunctionComponents());

export const noUseStateInRoutes = select('src/routes/**/*.tsx')
  .label('Route pages should not use useState — move state to domain components')
  .check(
    noFunctionCalls(['useState'], {
      message: () =>
        'Route pages must be thin orchestrators — move state management to domain components',
    }),
  );
