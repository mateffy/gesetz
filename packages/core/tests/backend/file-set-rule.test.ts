import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { compileRule, type CompileContext } from '../../src/backend/compile';
import { needsFileSet } from '../../src/backend/file-set-rule';
import { select } from '../../src/primitives/select';
import { requireSibling } from '../../src/primitives/checks/fs';
import type { Check, Rule } from '../../src/engine/rule';

const ctx = (): CompileContext =>
  ({
    rootDir: '/project',
    getServices: () => {
      throw new Error('not used');
    },
  }) as unknown as CompileContext;

const plain: Check = async () => [];
const fileSet: Check = async () => [];
fileSet.needsFileSet = true;

const ruleWith = (checks: Check[], patterns: string[] = ['src/**/*.ts']): Rule =>
  select(...patterns)
    .label('Rule')
    .category('cleanup')
    .check(...checks);

describe('needsFileSet', () => {
  it('is false for a rule with no checks', () => {
    expect(needsFileSet({ id: 'r', description: 'r', run: Effect.succeed([]) } as Rule)).toBe(
      false,
    );
  });

  it('is false when no check reads the file system', () => {
    expect(needsFileSet(ruleWith([plain]))).toBe(false);
  });

  it('is true when a check reads the file system', () => {
    expect(needsFileSet(ruleWith([fileSet]))).toBe(true);
  });

  it('is true when only one of several checks reads the file system', () => {
    // The whole rule takes the project form, so the same file is not reported by
    // two different paths.
    expect(needsFileSet(ruleWith([plain, fileSet]))).toBe(true);
  });

  it('is true for the primitives that look for files beside the source', () => {
    expect(needsFileSet(ruleWith([requireSibling('.stories.tsx')]))).toBe(true);
  });

  it('is false for a rule with no per-file form', () => {
    const projectRule: Rule = {
      id: 'p',
      description: 'p',
      run: Effect.succeed([]),
      project: { patterns: ['src/**/*.ts'], run: async () => [] },
    };
    expect(needsFileSet(projectRule)).toBe(false);
  });
});

describe('compileRule routing', () => {
  it('compiles a file-system rule as a project rule, not per file', () => {
    const extension = compileRule(ruleWith([requireSibling('.test.ts')]), ctx());
    expect(extension.after).toBeDefined();
    expect(extension.process).toBeUndefined();
  });

  it('compiles an ordinary rule per file', () => {
    const extension = compileRule(ruleWith([plain]), ctx());
    expect(extension.process).toBeDefined();
    expect(extension.after).toBeUndefined();
  });

  it('gives a file-system rule the same name as the rule', () => {
    const rule = ruleWith([requireSibling('.test.ts')]);
    expect(compileRule(rule, ctx()).name).toBe(rule.id);
  });
});
