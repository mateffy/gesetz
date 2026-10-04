import { describe, expect, it } from 'vitest';
import { renderSkillDocument } from '../src/skill-command';
import type { Rule } from '@gesetz/core';

const rule = (replaces: Rule['replaces']): Rule => ({ id: 'x', description: 'x', run: null, replaces }) as unknown as Rule;

describe('renderSkillDocument', () => {
  it('includes the static document and the generated recipe', () => {
    const text = renderSkillDocument([
      rule([{ instead: 'tsc --noEmit', use: 'gesetz check --rule tsc' }]),
    ]);
    expect(text).toContain('Run checks');
    expect(text).toContain('- `tsc --noEmit` → `gesetz check --rule tsc`');
    expect(text).toContain('Tools not listed here are not covered by gesetz');
  });

  it('says there is no config rather than printing an empty list', () => {
    const text = renderSkillDocument(null);
    expect(text).toContain('No gesetz config found here');
    expect(text).toContain('Run checks');
  });

  it('ends with exactly one trailing newline', () => {
    const text = renderSkillDocument([]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});
