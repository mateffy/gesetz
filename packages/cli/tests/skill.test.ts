import { describe, it, expect } from 'vitest';
import { SKILL_MARKDOWN } from '../src/skill';

describe('SKILL_MARKDOWN', () => {
  it('has YAML front matter, which is what makes it a skill', () => {
    expect(SKILL_MARKDOWN.startsWith('---')).toBe(true);
    expect(SKILL_MARKDOWN).toContain('name:');
    expect(SKILL_MARKDOWN).toContain('description:');
  });

  it('names gesetz and how to run it', () => {
    expect(SKILL_MARKDOWN).toContain('gesetz');
    expect(SKILL_MARKDOWN).toContain('gesetz check');
  });

  it('tells an agent how to fix a failing category, not just that it failed', () => {
    expect(SKILL_MARKDOWN).toContain('guidance');
  });

  it('is non-trivial in size', () => {
    expect(SKILL_MARKDOWN.length).toBeGreaterThan(200);
  });

  it('closes the front matter it opened', () => {
    const rest = SKILL_MARKDOWN.slice(3);
    expect(rest.indexOf('---')).toBeGreaterThan(0);
  });
});
