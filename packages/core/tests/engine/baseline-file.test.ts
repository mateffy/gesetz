import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  baselinePathFor,
  locate,
  readBaselineFile,
  serializeBaseline,
  writeBaselineFile,
} from '../../src/engine/baseline-file';
import { BASELINE_FILE_NAME, BASELINE_FILE_VERSION, type BaselineFile } from '../../src/engine/baseline';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-baseline-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (overrides: Partial<BaselineFile> = {}): BaselineFile => ({
  version: BASELINE_FILE_VERSION,
  gesetz: '0.0.0',
  total: 1,
  entries: {
    'src/a.ts': [{ rule: 'r', hash: 'abc', message: 'm', count: 1, line: 3 }],
  },
  ...overrides,
});

const write = async (name: string, content: string) => {
  const path = nodePath.join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
};

describe('baselinePathFor', () => {
  it('places the baseline at the project root', () => {
    expect(baselinePathFor('/proj')).toBe(nodePath.join('/proj', BASELINE_FILE_NAME));
  });

  it('names a file that belongs in git, not a cache directory', () => {
    expect(BASELINE_FILE_NAME.startsWith('.')).toBe(true);
    expect(BASELINE_FILE_NAME).toContain('baseline');
  });
});

describe('serializeBaseline', () => {
  it('ends with a newline, so the file is diff- and POSIX-friendly', () => {
    expect(serializeBaseline(file()).endsWith('\n')).toBe(true);
  });

  it('is byte-identical for equal input', () => {
    expect(serializeBaseline(file())).toBe(serializeBaseline(file()));
  });

  it('round-trips through JSON', () => {
    expect(JSON.parse(serializeBaseline(file()))).toEqual(file());
  });

  it('is pretty-printed, so a reviewer can read the diff', () => {
    expect(serializeBaseline(file())).toContain('\n  ');
  });
});

describe('writeBaselineFile', () => {
  it('writes the serialized file', async () => {
    const path = nodePath.join(dir, 'b.json');
    writeBaselineFile(path, file());
    expect(await readFile(path, 'utf8')).toBe(serializeBaseline(file()));
  });

  it('leaves no temporary file behind', async () => {
    // The write goes through `<path>.tmp` + rename so a crash cannot truncate it.
    const path = nodePath.join(dir, 'b.json');
    writeBaselineFile(path, file());
    expect(await readdir(dir)).toEqual(['b.json']);
  });

  it('overwrites an existing baseline completely', async () => {
    const path = nodePath.join(dir, 'b.json');
    writeBaselineFile(path, file({ total: 99 }));
    writeBaselineFile(path, file({ total: 1 }));
    expect((await readBaselineFile(path))?.total).toBe(1);
  });
});

describe('locate', () => {
  it('flattens the entries, carrying the path each was recorded under', () => {
    const located = locate(
      file({
        entries: {
          'src/a.ts': [{ rule: 'r', hash: 'h1', message: 'm', count: 2 }],
          'src/b.ts': [{ rule: 'r', hash: 'h2', message: 'm', count: 1 }],
        },
      }),
    );
    expect(located.map((l) => l.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(located[0]?.entry.hash).toBe('h1');
  });

  it('normalizes a path that arrived with a leading ./', () => {
    const located = locate(file({ entries: { './src/a.ts': [] } }));
    expect(located).toEqual([]);
  });

  it('returns nothing for an empty baseline', () => {
    expect(locate(file({ entries: {} }))).toEqual([]);
  });
});

describe('readBaselineFile', () => {
  it('returns null when the file is absent', () => {
    expect(readBaselineFile(nodePath.join(dir, 'nope.json'))).toBeNull();
  });

  it('reads a file this module wrote', async () => {
    const path = nodePath.join(dir, 'b.json');
    writeBaselineFile(path, file());
    expect(await readBaselineFile(path)).toEqual(file());
  });

  it('recomputes total from the entries rather than trusting the field', async () => {
    const path = await write('b.json', JSON.stringify({ ...file(), total: 500 }));
    expect(readBaselineFile(path)?.total).toBe(1);
  });

  it('normalizes entry keys on the way in', async () => {
    const path = await write(
      'b.json',
      JSON.stringify({ ...file(), entries: { './src/a.ts': file().entries['src/a.ts'] } }),
    );
    expect(Object.keys(readBaselineFile(path)?.entries ?? {})).toEqual(['src/a.ts']);
  });

  it('keeps an unknown gesetz version rather than failing', async () => {
    const path = await write('b.json', JSON.stringify({ version: BASELINE_FILE_VERSION, entries: {} }));
    expect(readBaselineFile(path)?.gesetz).toBe('unknown');
  });

  it('throws on invalid JSON rather than silently treating it as empty', async () => {
    // An unreadable baseline must not pass: every entry would read as new, or
    // worse, as nothing at all.
    const path = await write('b.json', '{ not json');
    expect(() => readBaselineFile(path)).toThrow(/not valid JSON/);
  });

  it('throws on a version it does not understand', async () => {
    const path = await write('b.json', JSON.stringify({ version: 999, entries: {} }));
    expect(() => readBaselineFile(path)).toThrow(/version 999/);
  });

  it('throws when the top level is not an object', async () => {
    const path = await write('b.json', JSON.stringify([1, 2, 3]));
    expect(() => readBaselineFile(path)).toThrow(/not a JSON object/);
  });

  it('throws when entries is missing', async () => {
    const path = await write('b.json', JSON.stringify({ version: BASELINE_FILE_VERSION }));
    expect(() => readBaselineFile(path)).toThrow(/no "entries" object/);
  });

  it('throws when a path maps to something other than a list', async () => {
    const path = await write('b.json', JSON.stringify({ ...file(), entries: { 'src/a.ts': 1 } }));
    expect(() => readBaselineFile(path)).toThrow(/malformed entry under "src\/a.ts"/);
  });

  it('throws when an entry is malformed', async () => {
    const path = await write(
      'b.json',
      JSON.stringify({ ...file(), entries: { 'src/a.ts': [{ rule: 'r' }] } }),
    );
    expect(() => readBaselineFile(path)).toThrow(/malformed entry/);
  });

  it('throws on a count of zero, which cannot describe a violation', async () => {
    const path = await write(
      'b.json',
      JSON.stringify({
        ...file(),
        entries: { 'src/a.ts': [{ rule: 'r', hash: 'h', message: 'm', count: 0 }] },
      }),
    );
    expect(() => readBaselineFile(path)).toThrow(/malformed entry/);
  });

  it('accepts an entry with no line, because the hash ignores it', async () => {
    const path = await write(
      'b.json',
      JSON.stringify({
        ...file(),
        entries: { 'src/a.ts': [{ rule: 'r', hash: 'h', message: 'm', count: 1 }] },
      }),
    );
    expect(readBaselineFile(path)?.entries['src/a.ts']?.[0]?.line).toBeUndefined();
  });

  it('accepts an empty entry list for a path', async () => {
    const path = await write('b.json', JSON.stringify({ ...file(), entries: { 'src/a.ts': [] } }));
    expect(readBaselineFile(path)?.entries['src/a.ts']).toEqual([]);
  });
});
