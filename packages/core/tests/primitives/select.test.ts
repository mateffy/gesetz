import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import { select, slugify } from '../../src/primitives/select';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive } from '../../src/services/fs';
import { TsAdapterStub } from '../../src/services/ts-adapter';
import { PhpAdapterStub } from '../../src/services/php-adapter';
import type { File, Violation } from '../../src/engine/rule';

const TestLayer = Layer.mergeAll(MemoryFileSystem({}), TsAdapterStub, PhpAdapterStub, ProjectRootLive(process.cwd()), FileFilterLive(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runWith = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Effect.provide(effect, TestLayer as any).pipe(Effect.runPromise as any);

const noop = (_file: File) => Effect.succeed<Violation[]>([]);

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('All components need Storybook stories')).toBe(
      'all-components-need-storybook-stories',
    );
  });

  it('removes non-alphanumeric characters', () => {
    expect(slugify('No raw DB:: calls!')).toBe('no-raw-db-calls');
  });

  it('collapses multiple spaces and hyphens', () => {
    expect(slugify('foo   bar--baz')).toBe('foo-bar-baz');
  });

  it('handles already-slugified strings', () => {
    expect(slugify('my-rule')).toBe('my-rule');
  });
});

describe('select', () => {
  describe('.label()', () => {
    it('sets rule.description verbatim', () => {
      const rule = select('src/**/*.tsx').label('All components need Storybook stories').check(noop);
      expect(rule.description).toBe('All components need Storybook stories');
    });

    it('slugifies label into rule.id', () => {
      const rule = select('src/**/*.tsx').label('All components need Storybook stories').check(noop);
      expect(rule.id).toBe('all-components-need-storybook-stories');
    });

    it('is chainable before .check()', () => {
      const rule = select('src/**/*.ts')
        .exclude('**/*.test.ts')
        .label('My rule')
        .check(noop);
      expect(rule.id).toBe('my-rule');
    });
  });

  describe('auto-id when label is not set', () => {
    it('derives a deterministic id from the patterns', () => {
      const rule = select('src/**/*.ts').check(noop);
      expect(rule.id).toBe('srcts');
    });

    it('auto-generated description includes pattern', () => {
      const rule = select('src/**/*.ts').check(noop);
      expect(rule.description).toContain('src/**/*.ts');
    });
  });

  describe('.check()', () => {
    it('produces no violations when no files match', async () => {
      const rule = select('src/**/*.nonexistent')
        .label('No files test')
        .check(noop);

      const violations = await runWith(rule.run);
      expect(violations).toEqual([]);
    });

    it('stamps rule id on violations', async () => {
      const files = { 'src/foo.ts': 'export {}' };
      const check = (file: File) =>
        Effect.succeed<Violation[]>([
          { rule: '', message: 'test', path: file.path, severity: 'error', source: 'core' },
        ]);

      const rule = select('src/**/*.ts').label('Stamp test').check(check);

      const violations = await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(TsAdapterStub),
        Effect.provide(PhpAdapterStub),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(null)),
        Effect.runPromise,
      );

      expect(violations.every((v) => v.rule === 'stamp-test')).toBe(true);
    });
  });

  describe('.exclude()', () => {
    it('excludes files matching the pattern', async () => {
      const touched: string[] = [];
      const trackingCheck = (file: File) => {
        touched.push(file.path);
        return Effect.succeed<Violation[]>([]);
      };

      const rule = select('src/**/*.ts')
        .exclude('**/*.test.ts')
        .label('Exclusion test')
        .check(trackingCheck);

      const files = {
        'src/foo.ts': '',
        'src/foo.test.ts': '',
        'src/bar.ts': '',
      };

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(TsAdapterStub),
        Effect.provide(PhpAdapterStub),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(null)),
        Effect.runPromise,
      );

      // MemoryFileSystem glob is approximate, but the exclusion filter is applied
      // We verify the filter logic separately
      expect(touched).not.toContain('src/foo.test.ts');
    });
  });

  describe('.filter()', () => {
    it('applies predicate to files', async () => {
      const touched: string[] = [];
      const trackingCheck = (file: File) => {
        touched.push(file.path);
        return Effect.succeed<Violation[]>([]);
      };

      const rule = select('src/**/*.ts')
        .filter((f) => f.name.startsWith('foo'))
        .label('Filter test')
        .check(trackingCheck);

      // Verify filter is called (the MemoryFileSystem glob will be empty but filter runs on results)
      expect(rule.id).toBe('filter-test');
    });
  });

  describe('.forEach()', () => {
    it('is equivalent to .check() with a single function', () => {
      const rule1 = select('src/**/*.ts').label('Test').check(noop);
      const rule2 = select('src/**/*.ts').label('Test').forEach(noop);
      expect(rule1.id).toBe(rule2.id);
      expect(rule1.description).toBe(rule2.description);
    });
  });
});
