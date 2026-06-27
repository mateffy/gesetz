/**
 * Component coverage — uses core requireSibling primitive.
 *
 * Every component file must have a sibling .stories.tsx and .test.tsx.
 */
import { select } from '@gesetz/core';
import { requireSibling } from '@gesetz/core';

export const componentStories = select('src/components/**/*.tsx')
  .exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx')
  .label('All components need Storybook stories')
  .check(requireSibling('.stories.tsx'));

export const componentTests = select('src/components/**/*.tsx')
  .exclude('**/*.test.tsx', '**/*.stories.tsx', '**/index.tsx')
  .label('All components need test files')
  .check(requireSibling('.test.tsx'));
