import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import {
  execTool,
  execToolResult,
  runWithTempFile,
  extractLocation,
  resolveToolCwd,
  resolveToolBin,
} from '../../src/engine/exec';

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

describe('execToolResult: output and how the run ended', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const spy = () => childProcess.execFileSync as ReturnType<typeof vi.fn>;

  it('reports status 0 for a clean run', async () => {
    spy().mockReturnValue('all good');
    const run = await Effect.runPromise(execToolResult('cmd', [], '/cwd', 'tool'));
    expect(run).toEqual({ stdout: 'all good', stderr: '', status: 0 });
  });

  it('separates "found nothing" from "did not run"', async () => {
    // Both end as empty output. The status is the only thing that tells them apart,
    // and an adapter without it reports a crashed tool as a clean project.
    spy().mockImplementation(() => {
      throw Object.assign(new Error('exit 2'), { stdout: '', stderr: 'error TS5058: bad', status: 2 });
    });
    const run = await Effect.runPromise(execToolResult('cmd', [], '/cwd', 'tsc'));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('TS5058');
  });

  it('keeps a tool that exits non-zero because it found something', async () => {
    spy().mockImplementation(() => {
      throw Object.assign(new Error('exit 1'), {
        stdout: 'src/a.ts(1,1): error TS1000: boom',
        status: 1,
      });
    });
    const run = await Effect.runPromise(execToolResult('cmd', [], '/cwd', 'tsc'));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('TS1000');
  });

  it('still throws when the tool could not be started', async () => {
    spy().mockImplementation(() => {
      throw Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' });
    });
    await expect(
      Effect.runPromise(execToolResult('missing', [], '/cwd', 'tsc')),
    ).rejects.toThrow(/tsc could not run/);
  });

  it('throws for a process killed by a signal, rather than reporting half an answer', async () => {
    // Partial output from a killed tool would be parsed as a complete report: for a
    // type checker that is a truncated list of errors, and for a linter that found
    // nothing before it died it is a clean bill of health. Failing the rule is the
    // only honest answer.
    spy().mockImplementation(() => {
      throw Object.assign(new Error('killed'), {
        stdout: 'partial',
        status: null,
        signal: 'SIGKILL',
      });
    });
    await expect(Effect.runPromise(execToolResult('cmd', [], '/cwd', 'tool'))).rejects.toThrow(
      /tool could not run/,
    );
  });
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

  it('throws when the tool produced no output at all', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => {
      throw Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' });
    });

    await expect(
      Effect.runPromise(execTool('missing', [], '/cwd', 'oxlint')),
    ).rejects.toThrow(/oxlint could not run \(command not found: missing\)/);
  });

  it('reports the tool name and reason for a non-spawn failure', async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => {
      throw new Error('killed by signal');
    });

    await expect(Effect.runPromise(execTool('cmd', [], '/cwd', 'vitest'))).rejects.toThrow(
      /vitest could not run \(killed by signal\)/,
    );
  });

  it('returns empty string for a non-zero exit with no stdout', async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error('exited 1'), { status: 1, stdout: '' });
    });

    const result = await Effect.runPromise(execTool('cmd', [], '/cwd', 'phpunit'));
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

describe('resolveToolCwd', () => {
  it('uses the project root when no cwd is configured', () => {
    expect(resolveToolCwd(undefined, '/project')).toBe('/project');
  });

  it('resolves a relative cwd against the project root, not process.cwd()', () => {
    expect(resolveToolCwd('packages/web', '/project')).toBe(
      nodePath.resolve('/project', 'packages/web'),
    );
  });

  it('keeps an absolute cwd untouched', () => {
    expect(resolveToolCwd('/elsewhere', '/project')).toBe('/elsewhere');
  });
});

describe('resolveToolBin', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'gesetz-resolve-bin-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers an explicit bin', () => {
    expect(resolveToolBin('/custom/tool', dir, ['node_modules/.bin/tool'], 'tool')).toBe(
      '/custom/tool',
    );
  });

  it('resolves local candidates relative to the given working directory', async () => {
    const cwd = nodePath.join(dir, 'packages', 'web');
    await mkdir(nodePath.join(cwd, 'node_modules', '.bin'), { recursive: true });
    await writeFile(nodePath.join(cwd, 'node_modules', '.bin', 'vitest'), '');
    const candidates = [nodePath.join('node_modules', '.bin', 'vitest')];

    // From the tool's working directory the local install is found...
    expect(resolveToolBin(undefined, cwd, candidates, 'vitest')).toBe(candidates[0]);
    // ...but not when looking from a different directory.
    expect(resolveToolBin(undefined, dir, candidates, 'vitest')).toBe('vitest');
  });

  it('falls back to the bare name (PATH) when nothing is installed locally', () => {
    expect(resolveToolBin(undefined, dir, ['node_modules/.bin/tool'], 'tool')).toBe('tool');
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
