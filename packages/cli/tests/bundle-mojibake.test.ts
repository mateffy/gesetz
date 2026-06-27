import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
// vitest may run under node; find bun explicitly.
const BUN_BIN = nodeFs.existsSync('/usr/local/bin/bun')
  ? '/usr/local/bin/bun'
  : nodeFs.existsSync('/Users/mat/.bun/bin/bun')
    ? '/Users/mat/.bun/bin/bun'
    : process.execPath;

/**
 * Regression tests for the bundle output.
 *
 * 1. Mojibake: the bundled `dist/main.js` emitted multi-byte UTF-8 chars
 *    (─ U+2500, ❯ U+276F, — U+2014, █ U+2588, etc.) as double-encoded
 *    sequences (e.g. e2 94 80 → c3 a2 c2 94 c2 80: the bytes were mis-decoded
 *    as Latin-1 then re-encoded as UTF-8).
 *
 *    Root cause: `bun build --target node` emits a bundle that, when loaded
 *    by `bun` at runtime, double-encodes UTF-8 string literals in the bundled
 *    source AND in transitive deps that get bundled in. Fix: build with
 *    `--target bun` (the CLI is always run by bun via its shebang) and
 *    externalize `@effect/*` packages so their (correctly-encoded) source is
 *    loaded from node_modules at runtime.
 *
 * 2. Ctrl+C crash: `gesetz init` used to dump a full `QuitException` stack
 *    trace when the user pressed Ctrl+C during an interactive prompt. Fixed
 *    by catching `QuitException` in the init command and exiting cleanly
 *    with a one-line `gesetz init cancelled` message.
 *
 * These tests run the built binary under a pseudo-PTY so the pretty-glyph
 * path (the historically buggy one) executes.
 */
describe('bundle: box-char mojibake regression', () => {
  const runInPty = (
    args: string[],
    opts: { settleMs?: number; cwd?: string; feed?: string } = {},
  ): Buffer => {
    const settleMs = opts.settleMs ?? 1500;
    const feed = opts.feed ?? '\r';
    const python = [
      '-c',
      `import pty,os,sys,select,time
out=bytearray()
pid,fd=pty.fork()
if pid==0:
    os.chdir(${JSON.stringify(opts.cwd ?? REPO_ROOT)})
    os.execvp(${JSON.stringify(BUN_BIN)}, ${JSON.stringify([BUN_BIN, DIST_MAIN, ...args])})
else:
    deadline=time.time()+10
    fed=False
    while time.time()<deadline:
        r,_,_=select.select([fd],[],[],0.3)
        if r:
            try:
                c=os.read(fd,4096)
            except OSError: break
            if not c: break
            out+=c
        elif not fed and len(out)>0:
            # Output arrived; now feed input and let it settle.
            try: os.write(fd, ${JSON.stringify(feed)}.encode())
            except OSError: pass
            time.sleep(${settleMs / 1000})
            fed=True
        elif fed:
            # Drain any remaining output.
            time.sleep(0.2)
    try: os.kill(pid,9)
    except: pass
    os.waitpid(pid,0)
sys.stdout.buffer.write(bytes(out))`,
    ];
    return execFileSync('python3', python, {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    });
  };

  const distExists = (): boolean => nodeFs.existsSync(DIST_MAIN);

  // Double-encoded UTF-8 byte signatures (the bug).
  const DOUBLE_ENCODED_HLINE = Buffer.from([0xc3, 0xa2, 0xc2, 0x94, 0xc2, 0x80]); // e2 94 80 (─)
  const DOUBLE_ENCODED_POINTER = Buffer.from([0xc3, 0xa2, 0xc2, 0x9d, 0xc2, 0xaf]); // e2 9d af (❯)
  const DOUBLE_ENCODED_EMDASH = Buffer.from([0xc3, 0xa2, 0xc2, 0x80, 0xc2, 0x94]); // e2 80 94 (—)

  it('gesetz check: emits correct UTF-8 box chars, no double-encoded bytes in pretty TTY mode', () => {
    if (!distExists()) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    // Run against the gesetz repo itself (has a gesetz.config.ts + src/).
    const out = runInPty(['check', '--category', 'cleanup'], { settleMs: 5000 });
    expect(out.includes(DOUBLE_ENCODED_HLINE)).toBe(false);
    expect(out.includes(DOUBLE_ENCODED_EMDASH)).toBe(false);
    // Correct ─ divider present (the score table uses it).
    expect(out.includes(Buffer.from([0xe2, 0x94, 0x80]))).toBe(true);
  }, 40000);

  it('gesetz check: emits ASCII fallback (no box chars) when piped', () => {
    if (!distExists()) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    const out = execFileSync(BUN_BIN, [DIST_MAIN, 'check', '--format=pretty'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    });
    expect(out).not.toMatch(/\u2500/);
    expect(out).not.toMatch(/\u00c3/);
    expect(out).toMatch(/-{20,}/);
  }, 40000);

  it('gesetz init: interactive prompt renders ❯ pointer and — em-dash correctly (no double-encoding)', () => {
    if (!distExists()) {
      console.warn(`skipping: ${DIST_MAIN} not built`);
      return;
    }
    // Use a temp project with react deps so detection picks 'react' preset.
    const tmp = nodeFs.mkdtempSync(nodePath.join(require('node:os').tmpdir(), 'gesetz-mojibake-'));
    try {
      nodeFs.writeFileSync(
        nodePath.join(tmp, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { react: '^19', 'react-dom': '^19' } }),
      );
      nodeFs.mkdirSync(nodePath.join(tmp, 'src'), { recursive: true });
      // Feed Enter to select the default preset and advance.
      const out = runInPty(['init', '--no-install', '--interactive'], {
        cwd: tmp,
        settleMs: 1000,
        feed: '\r',
      });
      // No double-encoded bytes anywhere.
      expect(out.includes(DOUBLE_ENCODED_POINTER)).toBe(false);
      expect(out.includes(DOUBLE_ENCODED_EMDASH)).toBe(false);
      // Correct ❯ pointer from @effect/cli's Prompt must appear.
      expect(out.includes(Buffer.from([0xe2, 0x9d, 0xaf]))).toBe(true);
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 40000);
});
