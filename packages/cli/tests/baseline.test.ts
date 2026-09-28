import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { buildBaselineFile, serializeBaseline, type Violation } from '@gesetz/core';
import { loadBaseline } from '../src/baseline';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cli-baseline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const violation: Violation = {
  rule: 'r',
  message: 'a message',
  path: 'src/a.ts',
  severity: 'error',
  source: 'core',
};

const writeBaseline = async (content: string) =>
  writeFile(nodePath.join(dir, '.gesetz-baseline.json'), content, 'utf-8');

describe('loadBaseline', () => {
  it('returns null when the file is absent', async () => {
    expect(await Effect.runPromise(loadBaseline(dir))).toBeNull();
  });

  it('reads a written baseline file', async () => {
    const file = buildBaselineFile([{ rule: 'r', violations: [violation] }], {
      gesetzVersion: 'test',
    });
    await writeBaseline(serializeBaseline(file));

    const loaded = await Effect.runPromise(loadBaseline(dir));
    expect(loaded?.total).toBe(1);
    expect(loaded?.entries['src/a.ts']).toHaveLength(1);
  });

  it('fails with a tagged error when the file is malformed', async () => {
    await writeBaseline('{ not json');

    const outcome = await Effect.runPromise(Effect.either(loadBaseline(dir)));
    expect(outcome._tag).toBe('Left');
    if (outcome._tag === 'Left') {
      expect(outcome.left._tag).toBe('BaselineFileError');
      expect(outcome.left.message).toContain('not valid JSON');
    }
  });
});
