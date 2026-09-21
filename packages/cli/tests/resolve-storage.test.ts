import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { resolveStorage } from '../src/resolve-storage';

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'gesetz-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  nodeFs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveStorage — fresh HOME', () => {
  it('creates the .gesetz parent directory and returns sqlite config', () => {
    const root = nodePath.join(tmpHome, 'project');
    nodeFs.mkdirSync(root, { recursive: true });
    const storage = resolveStorage(root, /* full */ false);
    expect(storage.kind).toBe('sqlite');
    expect(nodeFs.existsSync(nodePath.join(root, '.gesetz'))).toBe(true);
  });

  it('returns memory when full=true', () => {
    const root = nodePath.join(tmpHome, 'project');
    nodeFs.mkdirSync(root, { recursive: true });
    const storage = resolveStorage(root, /* full */ true);
    expect(storage.kind).toBe('memory');
  });

  it('respects GESETZ_DB override', () => {
    const customDb = nodePath.join(tmpHome, 'custom.db');
    process.env.GESETZ_DB = customDb;
    const root = nodePath.join(tmpHome, 'project');
    nodeFs.mkdirSync(root, { recursive: true });
    const storage = resolveStorage(root, /* full */ false);
    expect(storage.kind).toBe('sqlite');
    expect((storage as { path: string }).path).toBe(customDb);
    delete process.env.GESETZ_DB;
  });
});
