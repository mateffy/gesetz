import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { execTool, runWithTempFile, extractLocation } from '../../src/engine/exec';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    mkdtempSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

describe('execTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns stdout on success', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockReturnValue('success output');

    const result = await Effect.runPromise(execTool('cmd', ['arg'], '/cwd', 'tool'));
    expect(result).toBe('success output');
    expect(spy).toHaveBeenCalledWith(
      'cmd',
      ['arg'],
      expect.objectContaining({ cwd: '/cwd', encoding: 'utf-8' }),
    );
  });

  it('returns stdout from error when tool exits non-zero with stdout', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    const execError = Object.assign(new Error('exit 1'), {
      stdout: 'violation output',
      status: 1,
    });
    spy.mockImplementation(() => {
      throw execError;
    });

    const result = await Effect.runPromise(execTool('cmd', ['arg'], '/cwd', 'tool'));
    expect(result).toBe('violation output');
  });

  it('returns empty string and logs warning on failure without stdout', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => {
      throw new Error('command not found');
    });

    const result = await Effect.runPromise(execTool('missing', [], '/cwd', 'tool'));
    expect(result).toBe('');
  });

  it('handles Buffer stdout', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockReturnValue(Buffer.from('buffer output'));

    const result = await Effect.runPromise(execTool('cmd', [], '/cwd', 'tool'));
    expect(result).toBe('buffer output');
  });
});

describe('runWithTempFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('creates temp file and passes it to the callback', async () => {
    const tmpDir = '/tmp/gesetz-test-123';
    const tmpFile = nodePath.join(tmpDir, 'output.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);

    const callback = vi.fn().mockReturnValue(Effect.succeed('result'));

    const result = await Effect.runPromise(runWithTempFile('gesetz-test-', 'output.xml', callback));
    expect(result).toBe('result');
    expect(callback).toHaveBeenCalledWith(tmpFile);
  });

  it('cleans up temp directory after success', async () => {
    const tmpDir = '/tmp/gesetz-test-456';
    const tmpFile = nodePath.join(tmpDir, 'output.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);

    await Effect.runPromise(
      runWithTempFile('gesetz-test-', 'output.xml', () => Effect.succeed('ok')),
    );

    expect(nodeFs.rmSync as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('cleans up temp directory even when callback fails', async () => {
    const tmpDir = '/tmp/gesetz-test-789';
    const tmpFile = nodePath.join(tmpDir, 'output.xml');
    (nodeFs.mkdtempSync as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);

    await Effect.runPromise(
      runWithTempFile('gesetz-test-', 'output.xml', () => Effect.succeed('ok')),
    );

    expect(nodeFs.rmSync as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});

describe('extractLocation', () => {
  it('extracts path and line from stack trace', () => {
    const result = extractLocation('at /project/src/foo.ts:42:13');
    expect(result.path).toBe('/project/src/foo.ts');
    expect(result.line).toBe(42);
  });

  it('extracts from file:// URLs', () => {
    const result = extractLocation('at file:///project/src/foo.ts:42:13');
    expect(result.path).toBe('/project/src/foo.ts');
    expect(result.line).toBe(42);
  });

  it('returns empty path and undefined line for unmatched strings', () => {
    const result = extractLocation('some random text');
    expect(result.path).toBe('');
    expect(result.line).toBeUndefined();
  });

  it('extracts the first match from multiline trace', () => {
    const trace = `Error: something
    at /project/src/a.ts:10:5
    at /project/src/b.ts:20:8`;
    const result = extractLocation(trace);
    expect(result.path).toBe('/project/src/a.ts');
    expect(result.line).toBe(10);
  });
});
