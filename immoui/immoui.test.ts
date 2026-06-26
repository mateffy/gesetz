/**
 * immoui integration test.
 *
 * Runs the quality-assurance rules against immoui/src/ using the real FileSystem
 * and TsAdapter. This proves that the primitive composition works end-to-end.
 *
 * NOTE: These tests validate that the RULES work, not that immoui source is
 * violation-free. Violations are expected from active development.
 */
import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import * as nodePath from 'node:path';
import { runAll, defineConfig, FileSystemLive, PhpAdapterStub, ProjectRootLive, FileFilterLive } from '@regeln/core';
import { TsAdapterLive } from '@regeln/typescript';
import { relativeImportsRule } from './relative-imports';
import { storybookNoExplicitTitle } from './storybook-grouping';
import { componentStories } from './component-coverage';

// Point at the actual immoui source
const IMMOUI_ROOT = nodePath.resolve(__dirname, '../../immoui');

const TestLayer = Layer.mergeAll(
  FileSystemLive,
  TsAdapterLive,
  PhpAdapterStub,
  ProjectRootLive(IMMOUI_ROOT),
  FileFilterLive(null),
);

const runRules = (rules: import('@regeln/core').Rule[]) => {
  const config = defineConfig({
    projectRoot: IMMOUI_ROOT,
    rules,
  });
  return runAll(config).pipe(
    Effect.provide(TestLayer),
    Effect.runPromise,
  );
};

describe('immoui integration — quality-assurance primitives', () => {
  it('relativeImports rule runs without crashing', async () => {
    // The rule may find violations or not — we just verify it runs cleanly
    const result = await runRules([relativeImportsRule]);
    expect(result.byRule).toHaveLength(1);
    expect(result.byRule[0]?.description).toContain('relative imports');
    // If violations exist, they should have valid structure
    for (const v of result.byRule[0]?.violations ?? []) {
      expect(v.path).toBeTruthy();
      expect(v.message).toBeTruthy();
      expect(v.source).toBe('core');
    }
  });

  it('storybookGrouping rule runs and reports violations with correct structure', async () => {
    const result = await runRules([storybookNoExplicitTitle]);
    expect(result.byRule).toHaveLength(1);
    expect(result.byRule[0]?.description).toContain('Storybook');
    // The ruleId is a slug of the description
    expect(result.byRule[0]?.ruleId).toBe(storybookNoExplicitTitle.id);
    // If violations: they must be properly typed violations
    for (const v of result.byRule[0]?.violations ?? []) {
      expect(v.severity).toBe('error');
      expect(v.path).toMatch(/\.stories\./);
    }
  });

  it('componentStories rule produces well-formed violations', async () => {
    const result = await runRules([componentStories]);
    expect(result.byRule).toHaveLength(1);
    expect(result.byRule[0]?.description).toContain('stories');
    for (const v of result.byRule[0]?.violations ?? []) {
      expect(v.message).toContain('.stories.tsx');
    }
  });

  it('multiple rules run concurrently and both complete', async () => {
    const result = await runRules([relativeImportsRule, storybookNoExplicitTitle]);
    expect(result.byRule).toHaveLength(2);
    // Verify both rules ran (by matching their stable IDs)
    const ruleIds = result.byRule.map((r) => r.ruleId);
    expect(ruleIds).toContain(relativeImportsRule.id);
    expect(ruleIds).toContain(storybookNoExplicitTitle.id);
  });
});
