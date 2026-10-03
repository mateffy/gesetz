import { describe, expect, it } from 'vitest';
import { renderReplacements } from '../src/replacements';
import type { Rule } from '@gesetz/core';

const rule = (replaces?: Rule['replaces']) =>
  ({ id: 'x', description: 'x', run: null, replaces }) as unknown as Rule;

describe('renderReplacements', () => {
  it('says plainly when nothing is configured, rather than printing an empty list', () => {
    expect(renderReplacements([])).toContain('No configured adapter replaces a command');
  });

  it('prints one line per replacement, with the caveat when there is one', () => {
    const text = renderReplacements([
      rule([
        { instead: 'tsc --noEmit', use: 'gesetz check --rule tsc' },
        { instead: 'bun run typecheck', use: 'gesetz check --rule tsc', note: 'when that runs tsc' },
      ]),
    ]);
    expect(text).toContain('- `tsc --noEmit` → `gesetz check --rule tsc`');
    expect(text).toContain('- `bun run typecheck` → `gesetz check --rule tsc` (when that runs tsc)');
  });

  it('always says what is not covered', () => {
    // A list of replacements reads as "everything is covered", and an agent that
    // assumes coverage stops looking.
    const text = renderReplacements([rule([{ instead: 'a', use: 'b' }])]);
    expect(text).toContain('Tools not listed here are not covered by gesetz');
  });

  it('ignores rules that declare nothing, and collects from all that do', () => {
    const text = renderReplacements([
      rule(undefined),
      rule([{ instead: 'oxlint', use: 'gesetz check --rule oxlint' }]),
      rule([{ instead: 'vitest run', use: 'gesetz check --rule vitest' }]),
    ]);
    expect(text).toContain('oxlint');
    expect(text).toContain('vitest run');
  });
});
