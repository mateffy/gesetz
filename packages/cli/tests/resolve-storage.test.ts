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
  it('creates ~/.fabrik so sqlite storage can open', () => {
    const root = nodePath.join(tmpHome, 'project');
    nodeFs.mkdirSync(root, { recursive: true });
    const storage = resolveStorage(root, /* full */ false);
    expect(storage.kind).toBe('sqlite');
    expect(nodeFs.existsSync(nodePath.join(tmpHome, '.fabrik'))).toBe(true);
  });

  it('returns memory when full=true', () => {
    const root = nodePath.join(tmpHome, 'project');
    nodeFs.mkdirSync(root, { recursive: true });
    const storage = resolveStorage(root, /* full */ true);
    expect(storage.kind).toBe('memory');
  });
});
