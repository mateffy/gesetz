import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import { select, slugify } from '../../src/primitives/select';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive } from '../../src/services/fs';
import { SyntaxTreeStub } from '../../src/services/syntax-tree';
import { ImportResolverDefault } from '../../src/services/import-resolver';
import type { File, CheckServices, Violation } from '../../src/engine/rule';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive(process.cwd()),
  FileFilterLive(null),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runWith = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Effect.provide(effect, TestLayer as any).pipe(Effect.runPromise as any);

const noop = async (_file: File, _services: CheckServices): Promise<Violation[]> => [];

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
      const rule = select('src/**/*.tsx')
        .label('All components need Storybook stories')
        .check(noop);
      expect(rule.description).toBe('All components need Storybook stories');
    });

    it('slugifies label into rule.id', () => {
      const rule = select('src/**/*.tsx')
        .label('All components need Storybook stories')
        .check(noop);
      expect(rule.id).toBe('all-components-need-storybook-stories');
    });

    it('is chainable before .check()', () => {
      const rule = select('src/**/*.ts').exclude('**/*.test.ts').label('My rule').check(noop);
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

  describe('.baselineMessage()', () => {
    it('leaves the mode unset by default, so the baseline normalises', () => {
      const rule = select('src/**/*.ts').label('Default mode').check(noop);
      expect(rule.baselineMessage).toBeUndefined();
    });

    it('sets an exact message mode on the produced rule', () => {
      const rule = select('src/**/*.ts').label('Exact mode').baselineMessage('exact').check(noop);
      expect(rule.baselineMessage).toBe('exact');
    });
  });

  describe('.check()', () => {
    it('produces no violations when no files match', async () => {
      const rule = select('src/**/*.nonexistent').label('No files test').check(noop);
      const violations = await runWith(rule.run);
      expect(violations).toEqual([]);
    });

    it('stamps rule id on violations', async () => {
      const check = async (file: File, _services: CheckServices): Promise<Violation[]> =>
        [{ message: 'test', path: file.path, severity: 'error', source: 'core' }] as Violation[];

      const rule = select('src/**/*.ts').label('Stamp test').check(check);

      const violations = await rule.run.pipe(
        Effect.provide(MemoryFileSystem({ 'src/foo.ts': 'export {}' })),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(null)),
        Effect.runPromise,
      );

      expect(violations.every((v: Violation) => v.rule === 'stamp-test')).toBe(true);
    });
  });

  describe('.exclude()', () => {
    it('excludes files matching the pattern', async () => {
      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
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
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(null)),
        Effect.runPromise,
      );

      expect(touched).not.toContain('src/foo.test.ts');
    });
  });

  describe('.filter()', () => {
    it('applies predicate to files', () => {
      const rule = select('src/**/*.ts')
        .filter((f) => f.name.startsWith('foo'))
        .label('Filter test')
        .check(noop);
      expect(rule.id).toBe('filter-test');
    });
  });

  describe('--files filter (FileFilter)', () => {
    it('narrows glob to FileFilter patterns instead of rule patterns', async () => {
      const files = {
        'src/app/foo.ts': 'export {}',
        'src/shared/bar.ts': 'export {}',
        'src/shared/baz.ts': 'export {}',
      };

      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
      };

      const rule = select('src/**/*.ts').label('FileFilter test').check(trackingCheck);

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(['src/app/**'])),
        Effect.runPromise,
      );

      // Only files in src/app/ should be checked, not src/shared/
      expect(touched).toEqual(['src/app/foo.ts']);
      expect(touched).not.toContain('src/shared/bar.ts');
      expect(touched).not.toContain('src/shared/baz.ts');
    });

    it('filters by rule patterns after narrowing glob with FileFilter', async () => {
      const files = {
        'src/app/foo.ts': 'export {}',
        'src/app/bar.tsx': 'export {}',
        'src/app/baz.css': '.foo { color: red; }',
      };

      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
      };

      // Rule selects only .ts files, but --files is broader (src/app/**)
      const rule = select('src/**/*.ts').label('Pattern intersection test').check(trackingCheck);

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(['src/app/**'])),
        Effect.runPromise,
      );

      // Only .ts files within src/app/ should reach the check
      expect(touched).toEqual(['src/app/foo.ts']);
      expect(touched).not.toContain('src/app/bar.tsx');
      expect(touched).not.toContain('src/app/baz.css');
    });

    it('does not filter when FileFilter is null (no --files)', async () => {
      const files = {
        'src/app/foo.ts': 'export {}',
        'src/shared/bar.ts': 'export {}',
      };

      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
      };

      const rule = select('src/**/*.ts').label('No filter test').check(trackingCheck);

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(null)),
        Effect.runPromise,
      );

      // All matching files should be checked
      expect(touched).toHaveLength(2);
      expect(touched).toContain('src/app/foo.ts');
      expect(touched).toContain('src/shared/bar.ts');
    });

    it('handles empty FileFilter patterns gracefully', async () => {
      const files = {
        'src/app/foo.ts': 'export {}',
      };

      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
      };

      const rule = select('src/**/*.ts').label('Empty filter test').check(trackingCheck);

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive([])),
        Effect.runPromise,
      );

      // Empty patterns should still scan (falls back to rule patterns)
      expect(touched).toEqual(['src/app/foo.ts']);
    });

    it('still respects .exclude() when FileFilter is active', async () => {
      const files = {
        'src/app/foo.ts': 'export {}',
        'src/app/foo.test.ts': 'export {}',
      };

      const touched: string[] = [];
      const trackingCheck = async (file: File, _services: CheckServices): Promise<Violation[]> => {
        touched.push(file.path);
        return [];
      };

      const rule = select('src/**/*.ts')
        .exclude('**/*.test.ts')
        .label('Exclusion with FileFilter test')
        .check(trackingCheck);

      await rule.run.pipe(
        Effect.provide(MemoryFileSystem(files)),
        Effect.provide(SyntaxTreeStub),
        Effect.provide(ImportResolverDefault),
        Effect.provide(ProjectRootLive(process.cwd())),
        Effect.provide(FileFilterLive(['src/app/**'])),
        Effect.runPromise,
      );

      // Only non-test files should be checked
      expect(touched).toEqual(['src/app/foo.ts']);
      expect(touched).not.toContain('src/app/foo.test.ts');
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
