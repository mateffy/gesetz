import { describe, expect, it } from 'vitest';
import { rulesNotRequested } from '../src/daemon-runner';
import type { Rule } from '@gesetz/core';

const rule = (id: string): Rule => ({ id, description: id, run: null }) as unknown as Rule;

describe('rulesNotRequested', () => {
  it('names every configured rule the request left out, sorted', () => {
    // The field that stops a filtered answer from implying the whole project is clean.
    const all = [rule('tsc'), rule('no-god-files'), rule('vitest')];
    expect(rulesNotRequested(all, [rule('tsc')])).toEqual(['no-god-files', 'vitest']);
  });

  it('names nothing when the request asked for everything', () => {
    const all = [rule('a'), rule('b')];
    expect(rulesNotRequested(all, all)).toEqual([]);
  });

  it('names everything when the request asked for a rule that does not exist', () => {
    // `resolveCheckScope` refuses that case before it gets here, and if it ever stops
    // doing so, this is the honest answer rather than an empty claim.
    expect(rulesNotRequested([rule('a')], [])).toEqual(['a']);
  });
});
