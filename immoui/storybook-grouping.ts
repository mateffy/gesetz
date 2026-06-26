/**
 * Storybook grouping rule — composition of core primitives.
 *
 * Stories in domains/, generic/, and layout/ must NOT have an explicit `title:`
 * in the meta object. Storybook derives titles from file paths.
 */
import { select } from '@regeln/core';
import { noObjectProperty } from '@regeln/typescript';

export const storybookNoExplicitTitle = select(
  'src/components/{domains,generic,layout}/**/*.stories.{ts,tsx}',
)
  .label('Storybook stories must not define an explicit meta title — let Storybook derive from path')
  .check(
    noObjectProperty('meta', 'title', {
      message:
        "Remove 'title' from the meta object. " +
        'Storybook will derive the story group from the file path automatically.',
    }),
  );
