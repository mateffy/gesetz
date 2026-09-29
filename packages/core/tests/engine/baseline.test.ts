import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachLineTexts,
  BASELINE_FILE_VERSION,
  buildBaselineFile,
  normalizeMessage,
  normalizePath,
  STALE_RULE_ID,
  violationHash,
} from '../../src/engine/baseline';
import {
  readBaselineFile,
  serializeBaseline,
  writeBaselineFile,
} from '../../src/engine/baseline-file';
import { partitionByBaseline, planBaselineWrite } from '../../src/engine/baseline-apply';
import type { Violation } from '../../src/engine/rule';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-baseline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function violation(over: Partial<Violation> = {}): Violation {
  return {
    rule: 'r',
    message: 'a message',
    path: 'src/a.ts',
    severity: 'error',
    source: 'core',
    ...over,
  };
}

const single = (violations: readonly Violation[], rule = 'r') => [{ rule, violations }];

/** Groups by each violation's own rule, the way the runner does. */
const groupsOf = (violations: readonly Violation[]) => {
  const byRule = new Map<string, Violation[]>();
  for (const item of violations) {
    const rule = item.rule ?? 'r';
    const list = byRule.get(rule) ?? [];
    list.push(item);
    byRule.set(rule, list);
  }
  return [...byRule.entries()].map(([rule, list]) => ({ rule, violations: list }));
};

describe('normalizeMessage', () => {
  it('replaces bare integers and decimals', () => {
    expect(normalizeMessage('expected 3 arguments, got 4')).toBe('expected <n> arguments, got <n>');
    expect(normalizeMessage('score 6.5 below minimum 8')).toBe('score <n> below minimum <n>');
  });

  it('replaces UUIDs, hex ids and 0x ids', () => {
    expect(normalizeMessage('id 123e4567-e89b-12d3-a456-426614174000')).toBe('id <uuid>');
    expect(normalizeMessage('hash deadbeef12 unmatched')).toBe('hash <hex> unmatched');
    expect(normalizeMessage('address 0xff00')).toBe('address <hex>');
  });

  it('replaces quoted and bare paths', () => {
    expect(normalizeMessage("cannot import from './interface'")).toBe('cannot import from <path>');
    expect(normalizeMessage('src/sdk/domains/foo/index.ts is missing')).toBe('<path> is missing');
    expect(normalizeMessage("Layer 'x' must not import package '@scope/pkg'.")).toBe(
      "Layer 'x' must not import package <path>.",
    );
  });

  it('replaces template placeholders', () => {
    expect(normalizeMessage('key {{user.name}} is missing')).toBe('key <tpl> is missing');
  });

  it('keeps identifiers that say which violation this is', () => {
    expect(normalizeMessage('SchemaName.fieldName: array field missing items type')).toBe(
      'SchemaName.fieldName: array field missing items type',
    );
    expect(normalizeMessage('Use pure/ instead of components/ in domain estate')).toBe(
      'Use pure/ instead of components/ in domain estate',
    );
  });

  it('does not touch digits inside identifiers', () => {
    expect(normalizeMessage('ES2015 is unsupported')).toBe('ES2015 is unsupported');
  });
});

describe('violationHash', () => {
  it('is stable for the same rule, path and message', () => {
    expect(violationHash('r', 'src/a.ts', 'same')).toBe(violationHash('r', 'src/a.ts', 'same'));
  });

  it('changes when the rule, the path or the message changes', () => {
    const base = violationHash('r', 'src/a.ts', 'same');
    expect(violationHash('r2', 'src/a.ts', 'same')).not.toBe(base);
    expect(violationHash('r', 'src/b.ts', 'same')).not.toBe(base);
    expect(violationHash('r', 'src/a.ts', 'other')).not.toBe(base);
  });

  it('normalises the message by default and hashes it whole in exact mode', () => {
    expect(violationHash('r', 'src/a.ts', 'got 3')).toBe(violationHash('r', 'src/a.ts', 'got 4'));
    expect(violationHash('r', 'src/a.ts', 'got 3', 'exact')).not.toBe(
      violationHash('r', 'src/a.ts', 'got 4', 'exact'),
    );
  });

  it('normalises the path', () => {
    expect(violationHash('r', 'src\\a.ts', 'm')).toBe(violationHash('r', './src/a.ts', 'm'));
    expect(normalizePath('src\\a.ts')).toBe('src/a.ts');
  });
});

describe('buildBaselineFile', () => {
  it('groups entries by path and orders them deterministically', () => {
    const file = buildBaselineFile(
      single([
        violation({ path: 'src/b.ts', message: 'second' }),
        violation({ path: 'src/a.ts', message: 'first' }),
      ]),
      { gesetzVersion: '1.2.3' },
    );
    expect(Object.keys(file.entries)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(file.total).toBe(2);
    expect(file.version).toBe(BASELINE_FILE_VERSION);
    expect(file.gesetz).toBe('1.2.3');
  });

  it('collapses duplicate keys into one entry with a count', () => {
    const file = buildBaselineFile(
      single([
        violation({ line: 5 }),
        violation({ line: 9 }),
        violation({ line: 3 }),
        violation({ line: 1, message: 'another' }),
      ]),
      { gesetzVersion: '1.2.3' },
    );
    const entries = file.entries['src/a.ts'] ?? [];
    expect(entries).toHaveLength(2);
    const repeated = entries.find((entry) => entry.message === 'a message');
    expect(repeated?.count).toBe(3);
    expect(repeated?.line).toBe(3);
    expect(file.total).toBe(4);
  });

  it('writes identical bytes for identical input', () => {
    const groups = single([violation(), violation({ line: 7, path: 'src/b.ts' })]);
    const first = serializeBaseline(buildBaselineFile(groups, { gesetzVersion: '1.2.3' }));
    const second = serializeBaseline(buildBaselineFile(groups, { gesetzVersion: '1.2.3' }));
    expect(second).toBe(first);
  });

  it('writes identical bytes to disk on a second write', async () => {
    const path = nodePath.join(dir, '.gesetz-baseline.json');
    const file = buildBaselineFile(single([violation()]), { gesetzVersion: '1.2.3' });
    writeBaselineFile(path, file);
    const first = readBaselineFile(path);
    writeBaselineFile(path, file);
    const second = readBaselineFile(path);
    expect(serializeBaseline(second ?? file)).toBe(serializeBaseline(first ?? file));
  });

  it('honours a per-rule exact message mode', () => {
    const modes = new Map([['r', 'exact'] as const]);
    const file = buildBaselineFile(
      single([violation({ message: 'got 3' }), violation({ message: 'got 4' })]),
      { gesetzVersion: '1.2.3', modes },
    );
    expect(file.entries['src/a.ts']).toHaveLength(2);
  });
});

describe('readBaselineFile', () => {
  it('returns null when the file is absent', () => {
    expect(readBaselineFile(nodePath.join(dir, 'missing.json'))).toBeNull();
  });

  it('round-trips a written file', () => {
    const path = nodePath.join(dir, '.gesetz-baseline.json');
    const file = buildBaselineFile(single([violation({ line: 4 })]), { gesetzVersion: '1.2.3' });
    writeBaselineFile(path, file);
    expect(readBaselineFile(path)).toEqual(file);
  });

  it('throws on malformed JSON instead of reporting every violation as new', async () => {
    const path = nodePath.join(dir, '.gesetz-baseline.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json');
    expect(() => readBaselineFile(path)).toThrow(/not valid JSON/);
  });

  it('throws on an unsupported version', async () => {
    const path = nodePath.join(dir, '.gesetz-baseline.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ version: 99, entries: {} }));
    expect(() => readBaselineFile(path)).toThrow(/version 99/);
  });
});

describe('partitionByBaseline', () => {
  const baselineOf = (violations: readonly Violation[]) =>
    buildBaselineFile(single(violations), { gesetzVersion: '1.2.3' });

  it('keeps a baselined violation and reports no new one', () => {
    const baseline = baselineOf([violation()]);
    const partition = partitionByBaseline(single([violation({ line: 99 })]), baseline);
    expect(partition.stats.new).toBe(0);
    expect(partition.stats.baselined).toBe(1);
    expect(partition.stats.stale).toBe(0);
    expect(partition.newByRule.get('r')).toEqual([]);
  });

  it('reports the third violation as new when two are baselined', () => {
    const baseline = baselineOf([violation(), violation({ line: 2 })]);
    const partition = partitionByBaseline(
      single([violation({ line: 1 }), violation({ line: 2 }), violation({ line: 3 })]),
      baseline,
    );
    expect(partition.stats.baselined).toBe(2);
    expect(partition.stats.new).toBe(1);
    expect(partition.newByRule.get('r')).toHaveLength(1);
  });

  it('reports a stale entry when a baselined violation disappears', () => {
    const baseline = baselineOf([violation({ line: 1 }), violation({ line: 2 })]);
    const partition = partitionByBaseline(single([violation({ line: 1 })]), baseline);
    expect(partition.stats.baselined).toBe(1);
    expect(partition.stats.stale).toBe(1);
    expect(partition.stale[0]?.rule).toBe(STALE_RULE_ID);
    expect(partition.stale[0]?.path).toBe('src/a.ts');
    expect(partition.stale[0]?.message).toContain('r');
  });

  it('ignores stale entries outside the examined scope', () => {
    const baseline = baselineOf([violation({ path: 'src/untouched.ts' })]);
    const partition = partitionByBaseline(single([]), baseline, {
      inScope: (path) => path === 'src/changed.ts',
    });
    expect(partition.stats.stale).toBe(0);
  });

  it('drops stale entries the caller suppresses', () => {
    const baseline = baselineOf([violation()]);
    const partition = partitionByBaseline(single([]), baseline, { allowStale: () => false });
    expect(partition.stats.stale).toBe(0);
  });

  it('reports a new violation for a rule with no baseline entries at all', () => {
    const partition = partitionByBaseline(single([violation()]), baselineOf([]));
    expect(partition.stats.new).toBe(1);
    expect(partition.stats.stale).toBe(0);
  });
});

describe('planBaselineWrite', () => {
  const fileOf = (violations: readonly Violation[]) =>
    buildBaselineFile(groupsOf(violations), { gesetzVersion: '1.2.3' });

  it('accepts the whole backlog when no baseline exists yet', () => {
    const plan = planBaselineWrite(fileOf([violation(), violation({ path: 'src/b.ts' })]), null, {
      gesetzVersion: '1.2.3',
    });
    expect(plan.refused).toEqual([]);
    expect(plan.added).toBe(2);
    expect(plan.next.total).toBe(2);
  });

  it('refuses to absorb a new violation', () => {
    const plan = planBaselineWrite(
      fileOf([violation(), violation({ message: 'brand new' })]),
      fileOf([violation()]),
      { gesetzVersion: '1.2.3' },
    );
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.message).toBe('brand new');
  });

  it('refuses a fourth occurrence of a key that has three baselined', () => {
    const repeated = [violation(), violation({ line: 2 }), violation({ line: 3 })];
    const plan = planBaselineWrite(
      fileOf([...repeated, violation({ line: 4 })]),
      fileOf(repeated),
      {
        gesetzVersion: '1.2.3',
      },
    );
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.count).toBe(1);
  });

  it('accepts new violations for a rule named in --rule', () => {
    const plan = planBaselineWrite(
      fileOf([violation(), violation({ message: 'brand new' })]),
      fileOf([violation()]),
      { rules: ['r'], gesetzVersion: '1.2.3' },
    );
    expect(plan.refused).toEqual([]);
    expect(plan.added).toBe(1);
    expect(plan.kept).toBe(1);
  });

  it('ignores a new violation of an unnamed rule, so it cannot block the write', () => {
    // `--rule r` asks about `r`. An unnamed rule's new violation is not part of
    // that question; refusing on it blocked a 380-entry baseline of rule `r`
    // because of an unrelated false positive.
    const plan = planBaselineWrite(fileOf([violation({ rule: 'other' })]), fileOf([]), {
      rules: ['r'],
      gesetzVersion: '1.2.3',
    });
    expect(plan.refused).toEqual([]);
  });

  it('still refuses a new violation when no rule was named', () => {
    const plan = planBaselineWrite(fileOf([violation({ rule: 'other' })]), fileOf([]), {
      gesetzVersion: '1.2.3',
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.rule).toBe('other');
  });

  it('leaves other rules untouched when --rule names one rule', () => {
    const existing = fileOf([violation(), violation({ rule: 'other', path: 'src/other.ts' })]);
    const plan = planBaselineWrite(fileOf([]), existing, {
      rules: ['r'],
      gesetzVersion: '1.2.3',
    });
    expect(plan.deltas).toEqual([
      { rule: 'other', added: 0, removed: 0, kept: 1 },
      { rule: 'r', added: 0, removed: 1, kept: 0 },
    ]);
    expect(plan.next.total).toBe(1);
  });

  it('drops stale entries and reports them as removed', () => {
    const plan = planBaselineWrite(
      fileOf([violation()]),
      fileOf([violation(), violation({ path: 'src/gone.ts' })]),
      { gesetzVersion: '1.2.3' },
    );
    expect(plan.refused).toEqual([]);
    expect(plan.removed).toBe(1);
    expect(plan.kept).toBe(1);
    expect(plan.next.total).toBe(1);
  });
});

describe('baseline identity is per occurrence, keyed on the line text', () => {
  const at = (line: number, text: string) => ({ line, lineText: text });

  it('does not care which line the occurrence is on', () => {
    // An inserted import shifts every line below it. Position-keyed identity would
    // report all of them as new; text-keyed identity does not.
    const before = violationHash('r', 'src/a.ts', 'm', 'normalized', 'const x = 1;');
    const after = violationHash('r', 'src/a.ts', 'm', 'normalized', '  const x = 1;  ');
    expect(after).toBe(before);
    expect(at(1, 'const x = 1;').line).not.toBe(at(40, 'const x = 1;').line);
  });

  it('separates two occurrences of one rule and message in one file', () => {
    const one = violationHash('r', 'src/a.ts', 'm', 'normalized', 'db.raw("a")');
    const two = violationHash('r', 'src/a.ts', 'm', 'normalized', 'db.raw("b")');
    expect(two).not.toBe(one);
  });

  it('keeps the old identity for a violation with no line text', () => {
    // Adapters that report a whole project, and any caller that does not read the
    // source, must keep matching the way they always did.
    expect(violationHash('r', 'src/a.ts', 'm')).toBe(
      violationHash('r', 'src/a.ts', 'm', 'normalized', undefined),
    );
  });
});

describe('attachLineTexts', () => {
  it('attaches the offending line and reads each file once', () => {
    const reads: string[] = [];
    const texts = attachLineTexts(
      [
        { rule: 'r', message: 'm', path: 'src/a.ts', line: 2, severity: 'error', source: 'core' },
        { rule: 'r', message: 'm', path: 'src/a.ts', line: 1, severity: 'error', source: 'core' },
        { rule: 'r', message: 'm', path: 'src/b.ts', severity: 'error', source: 'core' },
      ],
      (path) => {
        reads.push(path);
        return path === 'src/a.ts' ? 'one\ntwo\nthree' : 'x';
      },
    );
    expect(reads).toEqual(['src/a.ts']);
    expect(texts[0]?.lineText).toBe('two');
    expect(texts[1]?.lineText).toBe('one');
    // No line to read: left alone rather than given an empty text.
    expect(texts[2]?.lineText).toBeUndefined();
  });

  it('leaves violations alone when the file cannot be read', () => {
    const texts = attachLineTexts(
      [{ rule: 'r', message: 'm', path: 'gone.ts', line: 9, severity: 'error', source: 'core' }],
      () => null,
    );
    expect(texts[0]?.lineText).toBeUndefined();
  });
});

describe('baseline identity over a real batch (the hole the count left open)', () => {
  type Group = Parameters<typeof buildBaselineFile>[0][number];
  const group = (violations: Violation[]): Group => ({ rule: 'r', violations });
  const v = (line: number, lineText: string): Violation => ({
    rule: 'r',
    message: 'Forbidden pattern',
    path: 'src/a.ts',
    line,
    lineText,
    severity: 'error',
    source: 'core',
  });
  const partition = (next: Violation[], file: ReturnType<typeof buildBaselineFile>) =>
    partitionByBaseline([group(next)], file, {
      modes: new Map(),
      inScope: () => true,
      allowStale: () => true,
    });

  it('sees a swap that leaves the number of violations unchanged', () => {
    // Two occurrences baselined. A batch fixes one and introduces a genuinely new
    // one: two in, two out, so a count-based identity reports nothing at all and
    // the gate passes blind to the new occurrence.
    const file = buildBaselineFile([group([v(1, 'db.raw("a")'), v(2, 'db.raw("b")')])], {
      gesetzVersion: '1.0.0',
    });
    const after = partition([v(1, 'db.raw("b")'), v(2, 'db.raw("c")')], file);
    expect(after.stats.new).toBe(1);
    expect(after.stats.stale).toBe(1);
    expect(after.newByRule.get('r')).toHaveLength(1);
    expect(after.stale[0]?.path).toBe('src/a.ts');
  });

  it('sees nothing to do when the same lines simply moved', () => {
    // The property the position-free identity was built for, kept.
    const file = buildBaselineFile([group([v(3, 'db.raw("a")')])], { gesetzVersion: '1.0.0' });
    const after = partition([v(57, 'db.raw("a")')], file);
    expect({ new: after.stats.new, stale: after.stats.stale }).toEqual({ new: 0, stale: 0 });
  });
});
