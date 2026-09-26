import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '../src/test-helpers';
import type { Check } from '../src/engine/rule';

const always: Check = async (file) => [
  { message: 'always', path: file.path, severity: 'error', source: 'core' },
];
const never: Check = async () => [];

const abs = (rel: string) => `${process.cwd()}/${rel}`;

describe('makeFile', () => {
  it('derives the metadata a check reads', () => {
    const f = makeFile('src/components/Button.tsx', 'export default 1;');
    expect(f.name).toBe('Button.tsx');
    expect(f.stem).toBe('Button');
    expect(f.ext).toBe('.tsx');
    expect(f.dir).toBe('src/components');
    expect(f.content).toBe('export default 1;');
    expect(f.size).toBeGreaterThan(0);
  });

  it('resolves the absolute path against the cwd', () => {
    expect(makeFile('src/a.ts').absolutePath).toBe(abs('src/a.ts'));
  });

  it('defaults the content to empty', () => {
    expect(makeFile('src/a.ts').content).toBe('');
  });

  it('handles a file with no extension', () => {
    const f = makeFile('Makefile');
    expect(f.ext).toBe('');
    expect(f.stem).toBe('Makefile');
  });
});

describe('makeCheckServices', () => {
  it('reports a virtual file as existing', async () => {
    const services = makeCheckServices({
      projectRoot: process.cwd(),
      files: { [abs('src/a.ts')]: 'x' },
    });
    expect(await services.fs.exists(abs('src/a.ts'))).toBe(true);
    expect(await services.fs.exists(abs('src/missing.ts'))).toBe(false);
  });

  it('reads a virtual file back', async () => {
    const services = makeCheckServices({
      projectRoot: process.cwd(),
      files: { [abs('src/a.ts')]: 'contents' },
    });
    expect(await services.fs.readFile(abs('src/a.ts'))).toBe('contents');
  });

  it('returns the stubbed syntax data', async () => {
    const services = makeCheckServices({
      projectRoot: process.cwd(),
      syntax: { calls: [{ name: 'eval', line: 3 }] },
    });
    const r = await services.syntax.process(makeFile('src/a.ts'), { calls: true });
    expect(r.calls).toEqual([{ name: 'eval', line: 3 }]);
  });

  it('lets an override win over the nice options', async () => {
    const services = makeCheckServices({
      projectRoot: process.cwd(),
      syntax: { calls: [{ name: 'a', line: 1 }] },
      overrides: {
        syntax: {
          process: async () => ({
            imports: [],
            calls: [{ name: 'b', line: 2 }],
            exports: [],
            structure: [],
          }),
        },
      },
    });
    const r = await services.syntax.process(makeFile('src/a.ts'), { calls: true });
    expect(r.calls).toEqual([{ name: 'b', line: 2 }]);
  });

  it('resolves imports through the provided map', () => {
    const services = makeCheckServices({
      projectRoot: process.cwd(),
      imports: { './b': abs('src/b.ts') },
    });
    expect(services.imports.resolve(makeFile('src/a.ts'), './b')).toBe(abs('src/b.ts'));
  });

  it('resolves an unmapped specifier to null', () => {
    const services = makeCheckServices({ projectRoot: process.cwd() });
    expect(services.imports.resolve(makeFile('src/a.ts'), './missing')).toBeNull();
  });
});

describe('runCheck', () => {
  it('returns what the check returned', async () => {
    expect(await runCheck(always, makeFile('src/a.ts'), makeCheckServices())).toHaveLength(1);
  });

  it('returns an empty list when the check is silent', async () => {
    expect(await runCheck(never, makeFile('src/a.ts'), makeCheckServices())).toHaveLength(0);
  });

  it('stamps the file path onto each violation', async () => {
    const v = await runCheck(always, makeFile('src/deep/a.ts'), makeCheckServices());
    expect(v[0]?.path).toBe('src/deep/a.ts');
  });
});
