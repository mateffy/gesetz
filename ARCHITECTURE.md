# Quality Assurance Framework — Architecture & API Design

> **Version:** 0.1.0 | **Status:** Ready for review
> **Goal:** A concrete, working design for a language-agnostic code quality framework with excellent DX.

---

## Table of Contents

1. [Package Structure](#1-package-structure)
   - [v1 Scope](#11-v1-scope-typescript-first)
2. [Core API: The Rule Engine](#2-core-api-the-rule-engine)
3. [The Selector API](#3-the-selector-api)
4. [Primitive Checks](#4-primitive-checks)
5. [Language-Specific Packages](#5-language-specific-packages)
6. [Adapter Architecture](#6-adapter-architecture)
7. [Test Runner Integration](#7-test-runner-integration)
8. [Rule Engine Internals](#8-rule-engine-internals)
9. [Presets](#9-presets)
   - [Exemptions and Baselines](#91-exemptions-and-baselines)
10. [Complete Example: immoui + immocore](#10-complete-example-immoui--immocore)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Package Structure

```
packages/
  core/                  # @qa/core — Rule engine, selector, primitives, runner
  typescript/            # @qa/typescript — ts-morph adapter, generic TS/JS checks
  php/                   # @qa/php — tree-sitter adapter, generic PHP checks
  python/                # @qa/python — tree-sitter adapter, generic Python checks
  cli/                   # @qa/cli — CLI tool (qa check, qa init)
  vitest/                # @qa/vitest — Vitest integration (matchers, plugin, setup)
  presets/               # @qa/presets — Built-in presets (immoui, clean-arch, fsd)
  # Framework-specific packages
  laravel/               # @qa/laravel — Laravel conventions on top of @qa/php
  react/                 # @qa/react — React component conventions
  tanstack-query/        # @qa/tanstack-query — Query/mutation conventions
  filament/              # @qa/filament — Filament/Livewire conventions
```

### Dependency Direction

```
@qa/core                  ← zero external deps
  ↑
@qa/typescript            ← ts-morph + @qa/core
@qa/php                   ← tree-sitter + @qa/core
@qa/python                ← tree-sitter + @qa/core
  ↑
@qa/laravel               ← @qa/php + Laravel heuristics
@qa/react                 ← @qa/typescript + React heuristics
@qa/tanstack-query        ← @qa/typescript + query heuristics
@qa/filament              ← @qa/php + Livewire/Filament heuristics
  ↑
@qa/vitest                ← @qa/core
@qa/cli                   ← @qa/core + @qa/vitest
@qa/presets               ← @qa/core + @qa/typescript + @qa/php + @qa/laravel + @qa/react
```

### Core Design Principle

**@qa/core has zero parser dependencies.** It only provides:
- The rule engine
- The selector API
- Primitive checks (file system, pattern matching, graph analysis)
- The violation format
- The runner

**Language adapters** (`@qa/typescript`, `@qa/php`) provide:
- AST parsing
- Import resolution
- Generic language checks
- Auto-detection from file extensions

**Framework packages** (`@qa/laravel`, `@qa/react`) provide:
- Pre-composed, higher-level rules that encode team conventions
- Built on top of language adapters
- Pure convenience — everything they do can also be written with primitives

## 1.1 v1 Scope: TypeScript First

The architecture sketches a polyglot engine, but **v1 is TypeScript-only**. We will prove the framework by replacing the 13 immoui structural tests. PHP/Laravel/Python support remains a documented extension point, not a v1 deliverable.

| Phase | Scope |
|-------|-------|
| v1 | `@qa/core` + `@qa/typescript` + `@qa/react` + `@qa/tanstack-query` + `@qa/vitest` + immoui presets |
| v2 | `@qa/php` generic PHP checks |
| v3 | `@qa/laravel`, `@qa/filament` (only after PHP semantic resolution strategy is proven) |
| Future | Python, Go, etc. only if needed |

---

## 2. Core API: The Rule Engine

### The Rule Type

Rules and checks must have stable identities. Anonymous functions lose their names under minification and bundling, so identity is explicit.

```typescript
interface Rule {
  readonly name: string;
  run: (ctx: RuleContext) => Violation[] | Promise<Violation[]>;
}

interface Check {
  readonly name: string;
  run: (file: File, ctx: RuleContext) => Violation[] | Promise<Violation[]>;
}
```

`select()` returns a builder that produces a `Rule`. The Vitest matcher and CLI always operate on `Rule[]`.

### The File Object

```typescript
interface File {
  // Metadata
  path: string;           // Relative to project root
  absolutePath: string;
  name: string;
  ext: string;
  
  // Content
  content: string;
  
  // Language & Adapter
  language: string;
  adapter: LanguageAdapter;
  
  // Lazy-loaded (cached across rules)
  getImports(): Import[];
  getAst(): UnifiedAstNode;
  
  // Helpers
  sibling(suffix: string): File | null;
  resolveImport(path: string): string | null;
  matches(pattern: string | RegExp): boolean;
  inFolder(pattern: string): boolean;
  
  // Violation helper
  violation(message: string, options?: ViolationOptions): Violation;
}
```

### The RuleContext

```typescript
interface RuleContext {
  // Project
  projectRoot: string;
  tsConfigPath?: string;
  composerPath?: string;
  
  // Files (filtered by the selector)
  files: File[];
  
  // Graph (lazy — only computed if a rule accesses it)
  graph: Lazy<DependencyGraph>;
  
  // Violation helper
  violation(file: File, message: string, options?: ViolationOptions): Violation;
}
```

### The Violation

```typescript
interface Violation {
  rule: string;
  message: string;
  path: string;
  line?: number;
  column?: number;
  context?: string;
  severity?: 'error' | 'warn' | 'info';
  fix?: ViolationFix;
}

interface ViolationFix {
  description: string;
  apply?: () => Promise<void> | void;
}
```

### The Runner

```typescript
class RuleRunner {
  constructor(private rules: Rule[]) {}
  
  async run(context: RuleContext): Promise<RunResult> {
    const results: RuleResult[] = [];
    
    for (const rule of this.rules) {
      const start = performance.now();
      const violations = await rule.run(context);
      const duration = performance.now() - start;
      
      results.push({
        rule: rule.name,
        violations,
        duration,
      });
    }
    
    return { results, totalViolations: results.reduce((sum, r) => sum + r.violations.length, 0) };
  }
}
```

---

## 3. The Selector API

### Design Philosophy

The selector is the entry point. It narrows which files to check, then applies checks.

```typescript
import { select } from '@qa/core';

// Returns a Selector
const rule = select('src/**/*.tsx')
  .exclude('**/*.stories.tsx', '**/*.test.tsx')
  .check(
    requireSibling('.stories.tsx'),
    requireSibling('.test.tsx'),
  );
```

### Selector Interface

```typescript
interface Selector {
  // File filtering
  exclude(...patterns: string[]): Selector;
  include(...patterns: string[]): Selector;
  filter(fn: (file: File) => boolean): Selector;
  
  // Checks
  check(...checks: Check[]): Rule;
  forEach(fn: (file: File, ctx: RuleContext) => Violation[]): Rule;
  forEachDir(fn: (dir: Directory, ctx: RuleContext) => Violation[]): Rule;
  
  // Rule metadata
  named(name: string): Selector;
}
```

### How Selectors Work

1. `select('src/**/*.tsx')` — finds all files matching the glob
2. `.exclude('**/*.stories.tsx')` — removes matching files
3. `.check(...)` — runs each check on each remaining file
4. Returns a `Rule` function that can be passed to the runner

### Auto-Detection

```typescript
select('src/**/*.tsx');     // → TypeScript adapter (ts-morph)
select('app/**/*.php');     // → PHP adapter (tree-sitter-php)
select('src/**/*.py');      // → Python adapter (tree-sitter-python)
select('src/**/*.{ts,php}'); // → Mixed: each file gets its own adapter

> Caution: mixed selectors are powerful but dangerous. A generic `Check` that touches `file.ast` must know which language it is inspecting. Use language-specific checks (`@qa/typescript`, `@qa/php`) or guard inside the check via `file.language`.
```

The framework auto-detects the adapter from the file extension. No explicit `adapter` parameter needed.

---

## 4. Primitive Checks

Primitive checks are small, reusable, language-agnostic functions.

### File System

```typescript
import { requireSibling, forbidSibling, requireFile, forbidFile, requireChildren } from '@qa/core';

// Check that a sibling file exists
requireSibling('.stories.tsx');
requireSibling('.test.tsx');
requireSibling('Factory.php', { 
  transform: (path) => path.replace('Models/', 'Factories/').replace('.php', 'Factory.php')
});

// Check that a sibling file does NOT exist
forbidSibling('.backup');

// Check that a specific file exists
requireFile('src/index.ts');

// Check that every selected file exists (useful for generated paths)
requireFile();

// Check that a specific pattern does NOT exist
forbidFile('src/**/tmp/**');
forbidFile();  // when the selector already matches forbidden files

// Check that a directory contains required children
select('src/sdk/domains/*/*/')
  .check(requireChildren([
    'index.ts', 'interface.ts', 'http.ts', 'memory.ts', 'types.ts', 'fakes.ts',
    'hooks/index.ts',
  ]));
```

### Imports

```typescript
import { noImports, requireImports, onlyImports } from '@qa/core';

// Forbid imports matching a pattern
noImports('@tanstack/react-query');
noImports('~/components/domains/*');       // no cross-domain imports
noImports('src/sdk/generated/**');        // no generated types

// Require imports
requireImports('react', 'vue');

// Only allow imports from these sources
onlyImports('~/components/**', '~/lib/**');
```

### AST (Generic, Best-Effort)

```typescript
import { noCalls, requireCalls, noNodes } from '@qa/core';

// Best-effort call-name matching. For semantic accuracy, prefer language helpers.
noCalls('console.log');  // @qa/typescript: ts.noCalls({ callee: 'console.log' })
noCalls('DB::raw');      // @qa/php: php.noCalls({ class: 'DB', methods: ['raw'] })

// Require function calls
requireCalls('__()');

// Forbid AST node types
noNodes('function', { maxCount: 10 });
```

> These primitives inspect the `UnifiedAstNode` tree at a generic level. They catch obvious cases but cannot resolve types or aliases. Use `@qa/typescript` / `@qa/php` helpers when precision matters.

### Text Patterns (Coarse — Prefer Language Helpers)

```typescript
import { noPattern, requirePattern } from '@qa/core';

// Forbid text patterns. Use only for simple tokens; AST helpers are more accurate.
noPattern('\\beval\\(');

// Require text patterns
requirePattern('declare\\(strict_types=1\\)');
```

> Warning: `noPattern('useState(')` false-positives on comments/strings and false-negatives on aliases. Prefer `@qa/typescript` / `@qa/php` AST helpers for semantic checks.

### Graph

```typescript
import { noCycles, noDeadCode, noOrphans } from '@qa/core';

// Dependency graph checks
noCycles();
noDeadCode({ entryPoints: ['src/index.ts'] });
noOrphans();
```

### Custom Checks

```typescript
import { check } from '@qa/core';

// Write your own check in 5 lines — name is required
const noHardcodedStrings = check('no-hardcoded-strings', (file) => {
  const strings = file.ast.findNodes('string');
  return strings
    .filter(s => s.isInJsx && !s.isInTranslateCall)
    .map(s => s.violation('Hardcoded string: use i18n'));
});
```

### Composing Checks

```typescript
// Define checks once, reuse everywhere
const mustHaveStory = requireSibling('.stories.tsx');
const mustHaveTest = requireSibling('.test.tsx');
const noDirectQuery = noImports('@tanstack/react-query');

const componentRules = select('src/**/*.tsx')
  .check(mustHaveStory, mustHaveTest, noDirectQuery);

const pageRules = select('src/**/*.page.tsx')
  .check(mustHaveStory, noDirectQuery);
```

---

## 5. Language-Specific Packages

### TypeScript Package

```typescript
import { tsLang, noAny } from '@qa/typescript';

// Generic checks that work on any TypeScript project
const rule1 = select('src/**/*.ts')
  .check(noAny());

const rule2 = select('src/**/*.ts')
  .check(tsLang.exportsAreTyped());
```

### PHP Package

```typescript
import { phpLang, noRawDb } from '@qa/php';

// Generic PHP checks
const rule1 = select('app/Http/Controllers/**/*.php')
  .check(noRawDb());

const rule2 = select('app/**/*.php')
  .check(phpLang.classesAreNamespaced());
```

### Framework-Specific Packages

Framework packages **do not expose monolithic config objects**. They expose the same primitive check functions as core, just built on framework knowledge.

```typescript
// ❌ WRONG: monolithic convention checker
laravelConventions({ controllersUseRequests: true, modelsHaveFactories: true });

// ✅ RIGHT: composable primitive checks
import { controllersUseRequests, modelsHaveFactories } from '@qa/laravel';
import { requireStories, requireTests, noRouteState, noDirectQueries } from '@qa/react';
import { mutationInvalidation, queryOptions, hookPairs } from '@qa/tanstack-query';

select('app/Http/Controllers/**/*.php')
  .check(controllersUseRequests());

select('app/Domains/*/Models/*.php')
  .check(modelsHaveFactories());

select('src/components/**/*.tsx')
  .check(requireStories(), requireTests(), noDirectQueries());

select('src/routes/**/*.tsx')
  .check(noRouteState());

select('src/sdk/domains/**/mutations/**/*')
  .check(mutationInvalidation());
```

### Presets Compose Primitives

```typescript
// @qa/presets/immoui.ts — just an array of primitive rules
import { noPattern, select } from '@qa/core';
import { requireStories, requireTests, noDirectQueries, noRouteState } from '@qa/react';
import { hookPairs, queryOptions, mutationInvalidation, testQuality } from '@qa/tanstack-query';
export function immouiPreset(): Rule[] {
  return [
    select('src/components/**/*.tsx')
      .check(requireStories(), requireTests(), noDirectQueries()),

    select('src/routes/**/*.tsx')
      .check(noRouteState()),

    select('src/sdk/domains/**')
      .check(hookPairs(), queryOptions(), mutationInvalidation()),

    select('src/**/*.test.tsx')
      .check(testQuality({ minScore: 50 })),
  ];
}
```

Every check, at every layer, is just a function `(file) => Violation[] | null` composed with `select().check()`. Framework packages differ from core only by having more semantic knowledge baked in.

### Why No `adapter` Parameter?

```typescript
// ❌ OLD — explicit adapter
phpNamespaceRules({
  pattern: 'app/**/*.php',
  adapter: 'php',
});

// ✅ NEW — import from subpackage, pattern auto-detects
import { noDirectQueries } from '@qa/tanstack-query';

select('src/**/*.tsx')
  .check(noDirectQueries());

// The `@qa/tanstack-query` import tells us the framework
// The `.tsx` extension tells us the adapter
// No explicit adapter needed
```

---

## 6. Adapter Architecture

### LanguageAdapter Interface

```typescript
interface LanguageAdapter {
  readonly name: string;
  readonly extensions: string[];
  
  // Parse a file into a UnifiedAstNode
  parse(path: string, content: string): UnifiedAstNode;
  
  // Extract imports from a file
  getImports(path: string, content: string): Import[];
  
  // Resolve an import path to an absolute file path
  resolveImport(from: string, importPath: string): string | null;
  
  // Project detection
  detectProject(root: string): boolean;
}
```

### UnifiedAstNode

```typescript
interface UnifiedAstNode {
  // Universal
  type: string;
  text: string;
  line: number;
  column: number;
  
  // Navigation
  children: UnifiedAstNode[];
  parent?: UnifiedAstNode;
  find(selector: string): UnifiedAstNode[];
  
  // Language-specific (optional typed access)
  ts?: TsAstNode;
  php?: PhpAstNode;
  python?: PythonAstNode;
}
```

### TypeScript Adapter (ts-morph)

```typescript
class TypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'];
  
  private project: Project;
  
  parse(path: string, content: string): UnifiedAstNode {
    const sourceFile = this.project.createSourceFile(path, content, { overwrite: true });
    return new TsMorphNode(sourceFile);
  }
  
  getImports(path: string, content: string): Import[] {
    const sourceFile = this.project.createSourceFile(path, content, { overwrite: true });
    return sourceFile.getImportDeclarations().map(imp => ({
      source: imp.getModuleSpecifierValue(),
      resolved: this.resolveImport(path, imp.getModuleSpecifierValue()),
      // ...
    }));
  }
  
  resolveImport(from: string, importPath: string): string | null {
    // Use ts-morph's module resolution
    const ts = require('typescript');
    const resolved = ts.resolveModuleName(
      importPath,
      from,
      this.project.getCompilerOptions(),
      this.project.getModuleResolutionHost(),
    );
    return resolved.resolvedModule?.resolvedFileName ?? null;
  }
  
  detectProject(root: string): boolean {
    return existsSync(join(root, 'tsconfig.json')) || 
           existsSync(join(root, 'package.json'));
  }
}
```

### PHP Adapter (tree-sitter)

```typescript
class PhpAdapter implements LanguageAdapter {
  readonly name = 'php';
  readonly extensions = ['.php'];
  
  private parser: Parser;
  private psr4Map: Record<string, string[]>;
  
  parse(path: string, content: string): UnifiedAstNode {
    const tree = this.parser.parse(content);
    return new TreeSitterNode(tree.rootNode, 'php');
  }
  
  getImports(path: string, content: string): Import[] {
    const tree = this.parser.parse(content);
    const uses = tree.rootNode.descendantsOfType('use_declaration');
    return uses.map(u => ({
      source: this.extractImportPath(u),
      resolved: this.resolveImport(path, this.extractImportPath(u)),
      // ...
    }));
  }
  
  resolveImport(from: string, importPath: string): string | null {
    // Use PSR-4 autoloading from composer.json
    for (const [prefix, dirs] of Object.entries(this.psr4Map)) {
      if (importPath.startsWith(prefix)) {
        const suffix = importPath.slice(prefix.length).replace(/\\/g, '/') + '.php';
        for (const dir of dirs) {
          const candidate = join(dir, suffix);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }
  
  detectProject(root: string): boolean {
    return existsSync(join(root, 'composer.json'));
  }
}
```

---

## 7. Test Runner Integration

### Vitest Integration

The framework provides a **Vite plugin** + **custom matcher** + **setup file**.

#### 1. The Vite Plugin

```typescript
// packages/vitest/src/plugin.ts
import type { Plugin } from 'vite';

export function qaPlugin(options: { configFile?: string } = {}): Plugin {
  return {
    name: 'vitest:qa',
    configResolved(config) {
      // Inject setup file
      config.test ??= {};
      const setupFiles = Array.isArray(config.test.setupFiles) 
        ? config.test.setupFiles 
        : config.test.setupFiles ? [config.test.setupFiles] : [];
      
      const matcherSetup = new URL('./setup-matchers.js', import.meta.url).pathname;
      if (!setupFiles.includes(matcherSetup)) {
        setupFiles.push(matcherSetup);
      }
      config.test.setupFiles = setupFiles;
      
      // Pass config file path to runtime
      config.test.env ??= {};
      config.test.env.__QA_CONFIG__ = options.configFile ?? '';
    },
  };
}
```

#### 2. The Custom Matcher

```typescript
// packages/vitest/src/to-pass.ts
import type { MatcherResult, MatcherState } from 'vitest';
import { RuleRunner } from '@qa/core';
import type { Rule, RunResult } from '@qa/core';
import { buildContext } from './context';

export async function toPass(
  this: MatcherState,
  received: Rule | Rule[],
): Promise<MatcherResult> {
  const rules = Array.isArray(received) ? received : [received];
  const runner = new RuleRunner(rules);
  const ctx = await buildContext();
  const result: RunResult = await runner.run(ctx);
  const violations = result.flatMap(r => r.violations);
  
  return {
    pass: violations.length === 0,
    actual: violations,
    expected: [],
    message: () => formatViolations(rules, violations, this.isNot),
  };
}

function formatViolations(
  rules: Rule[],
  violations: Violation[],
  isNot = false,
): string {
  const names = rules.map(r => r.name).join(', ');
  const title = isNot
    ? `expected rules [${names}] to fail, but they passed`
    : `rules [${names}] failed with ${violations.length} violation(s)`;
  
  const lines = violations.map((v) => {
    const loc = `${v.path}:${v.line}${v.column ? `:${v.column}` : ''}`;
    return `  ${loc}\n    ${v.message}`;
  });
  
  return [title, ...lines].join('\n');
}
```

#### 3. The Setup File

```typescript
// packages/vitest/src/setup-matchers.ts
import { expect } from 'vitest';
import { toPass } from './to-pass';

expect.extend({ toPass });
```

#### 4. The Test Suite Helper

```typescript
// packages/vitest/src/index.ts
import { describe, expect, test } from 'vitest';
import { RuleRunner } from '@qa/core';
import type { Rule } from '@qa/core';
import { buildContext } from './context';

export function defineQualityTests(rules: Rule[], options?: { root?: string }) {
  for (const rule of rules) {
    describe(rule.name, () => {
      test('passes all checks', async () => {
        await expect(rule).toPass();
      });
    });
  }
}

export function defineQualityTestsDetailed(rules: Rule[], options?: { root?: string }) {
  for (const rule of rules) {
    describe(rule.name, () => {
      test('passes all checks', async () => {
        const runner = new RuleRunner([rule]);
        const ctx = await buildContext();
        const result = await runner.run(ctx);
        const violations = result.results.find(r => r.rule === rule.name)?.violations ?? [];
        expect(violations).toEqual([]);
      });
    });
  }
}
```

#### 5. User's Test File

```typescript
// src/__tests__/quality.test.ts
import { defineQualityTests } from '@qa/vitest';
import { rules } from '../quality-assurance.config';

defineQualityTests(rules);
```

#### 6. Multi-Project Config

```typescript
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './vitest.config.ts',
  {
    test: {
      name: 'quality',
      include: ['./quality-assurance/**/*.test.ts'],
      environment: 'node',
    },
  },
]);
```

---

## 8. Rule Engine Internals

### Caching Strategy

Cache keys use path + mtime + size to avoid hashing full file contents. Content hashing is used only as a fallback when mtime is unstable.

```typescript
class EngineCache {
  private fileCache = new Map<string, FileCache>();
  private astCache = new Map<string, Map<string, UnifiedAstNode>>(); // per-adapter AST cache
  private graphCache = new Map<string, DependencyGraph>();
  
  getFile(path: string): File {
    const stat = fs.statSync(path);
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.fileCache.get(key);
    if (cached) return cached;
    
    const file = this.readFile(path, stat);
    this.fileCache.set(key, file);
    return file;
  }
  
  getAst(file: File): UnifiedAstNode {
    const adapterCache = this.astCache.get(file.adapter.name) ?? new Map();
    const key = `${file.absolutePath}:${file.mtimeMs}:${file.size}`;
    const cached = adapterCache.get(key);
    if (cached) return cached;
    
    const ast = file.adapter.parse(file.path, file.content);
    adapterCache.set(key, ast);
    this.astCache.set(file.adapter.name, adapterCache);
    return ast;
  }
  
  getGraph(files: File[]): DependencyGraph {
    const hash = hashPaths(files);  // sorted paths + mtimes
    const cached = this.graphCache.get(hash);
    if (cached) return cached;
    
    const graph = buildGraph(files);
    this.graphCache.set(hash, graph);
    return graph;
  }
}
```

### Performance Targets (Must Be Measured on Real Projects)

| Metric | How to Measure |
|--------|----------------|
| Cold parse + all rules | Time `qa check` on immoui + immocore from a clean cache |
| Warm cache | Re-run immediately after a no-op change |
| Single file change | Re-run after editing one file |
| Memory peak | RSS at peak during cold run |

Do not commit to numbers before measuring. ts-morph memory use is the biggest unknown.

### Incremental Analysis

```typescript
class IncrementalEngine {
  async getChangedFiles(): Promise<string[]> {
    // Detect tracked modifications, untracked files, and deletions
    const tracked = await this.exec('git diff --name-only HEAD');
    const untracked = await this.exec('git ls-files --others --exclude-standard');
    const deleted = await this.exec('git diff --name-only --diff-filter=D HEAD');
    
    return [
      ...tracked.split('\n'),
      ...untracked.split('\n'),
      ...deleted.split('\n'),
    ].filter(Boolean);
  }
  
  async runIncremental(rules: Rule[]) {
    const changed = await this.getChangedFiles();
    
    // Include files that import changed files
    const dependents = changed.flatMap(f => this.graph.dependentsOf(f));
    
    const toAnalyze = [...new Set([...changed, ...dependents])];
    
    return this.engine.run(toAnalyze, rules);
  }
}
```

---

## 9. Presets

### Presets are Just Arrays

```typescript
// packages/presets/src/immoui.ts
import { select, requireFile, forbidFile, noImports } from '@qa/core';
import { requireStories, requireTests, noDirectQueries, noRouteState } from '@qa/react';
import { hookPairs, queryOptions, mutationInvalidation, testQuality } from '@qa/tanstack-query';

export function immouiPreset(options?: { root?: string }): Rule[] {
  const root = options?.root ?? 'src';
  
  return [
    // Architecture primitives
    select(`${root}/components/domains/*/components/**/*`)
      .check(forbidFile()),
    
    select(`${root}/routes/**/$tab.tsx`)
      .check(forbidFile()),
    
    select(`${root}/components/domains/*/{pure,bridges,pages}/*`)
      .check(noImports(`${root}/components/domains/*/{pure,bridges,pages}/*`)),
    
    // Required index files (selected paths must exist)
    select(`/dev/null`)
      .check(requireFile(`${root}/components/{domains,generic,layout}/*/index.ts`)),
    
    // Components
    select(`${root}/components/**/*.tsx`)
      .exclude('**/*.stories.tsx', '**/*.test.tsx', `${root}/components/ui/**`)
      .check(requireStories(), requireTests(), noDirectQueries()),
    
    // Tests
    select(`${root}/**/*.test.tsx`)
      .check(testQuality({ minScore: 50 })),
    
    // SDK
    select(`${root}/sdk/domains/**`)
      .check(hookPairs(), queryOptions(), mutationInvalidation()),
    
    // Routes
    select(`${root}/routes/**/*.tsx`)
      .check(noRouteState()),
  ];
}
```

### Using Presets

```typescript
// quality-assurance.config.ts
import { defineConfig } from '@qa/core';
import { immouiPreset } from '@qa/presets';

export default defineConfig({
  rules: [
    ...immouiPreset({ root: 'src' }),
    
    // Add custom rules
    select('src/**/*.tsx')
      .check(noPattern('console.log')),
  ],
});
```

## 9.1 Exemptions and Baselines

Real codebases have technical debt. Exemptions must be first-class, not an afterthought.

### Exemption Types

```typescript
interface Exemption {
  path: string;              // exact path or glob
  rule?: string;             // glob matching rule name; omit for all rules
  reason: string;           // required explanation
  ticket?: string;           // issue tracker reference
  until?: string;            // ISO date; expired exemptions become errors
}

interface Config {
  rules: Rule[];
  exemptions?: Exemption[];
  baseline?: string;          // path to a baseline file of known violations
}
```

### Inline Suppression

```typescript
// qa-disable-next-line no-direct-queries
const { data } = useQuery({ ... });
```

### Example

```typescript
export default defineConfig({
  rules: [
    select('src/**/*.tsx').check(requireStories()),
  ],
  exemptions: [
    {
      path: 'src/components/ui/**',
      rule: 'require-stories',
      reason: 'Third-party shadcn components; tracked in UI-482',
      ticket: 'UI-482',
    },
    {
      path: 'src/legacy/**/*.tsx',
      rule: '*',
      reason: 'Migration in progress',
      until: '2026-09-01',
    },
  ],
});
```

The runner subtracts exempted violations from the failure count but reports them separately, so teams see debt and expiry dates.

---

## 10. Complete Example: immoui + immocore

### Monorepo Config

```typescript
// root/quality-assurance.config.ts
import { defineConfig, select } from '@qa/core';
import { requireStories, requireTests, noRouteState, noDirectQueries } from '@qa/react';
import { hookPairs, queryOptions, mutationInvalidation, testQuality } from '@qa/tanstack-query';
import { controllersUseRequests, modelsHaveFactories } from '@qa/laravel';

export default defineConfig({
  projects: [
    { name: 'frontend', path: 'immoui', framework: 'react' },
    { name: 'backend', path: 'brave-tiger', framework: 'laravel' },
  ],
  
  rules: [
    // === Frontend ===
    select('immoui/src/components/**/*.tsx')
      .exclude('**/ui/**')
      .check(requireStories(), requireTests(), noDirectQueries()),
    
    select('immoui/src/sdk/domains/**')
      .check(hookPairs(), queryOptions(), mutationInvalidation()),
    
    select('immoui/src/**/*.test.tsx')
      .check(testQuality({ minScore: 50 })),
    
    select('immoui/src/routes/**/*.tsx')
      .check(noRouteState()),
    
    // === Backend ===
    select('brave-tiger/app/Http/Controllers/**/*.php')
      .check(controllersUseRequests()),
    
    select('brave-tiger/app/Domains/*/Models/*.php')
      .check(modelsHaveFactories()),
    
    // === Cross-Project ===
    // No orphaned API endpoints
    // No unused frontend routes
  ],
});
```

### Test File

```typescript
// src/__tests__/quality.test.ts
import { defineQualityTests } from '@qa/vitest';
import config from '../quality-assurance.config';

defineQualityTests(config.rules);
```

### CLI

```bash
# Check everything
npx qa check

# Check only frontend
npx qa check --project frontend

# Check only backend
npx qa check --project backend

# Check in watch mode
npx qa check --watch

# Check only changed files
npx qa check --changed
```

---

## 11. Implementation Roadmap

### Phase 1: Core + TypeScript-First Validation

Goal: Prove the framework works for immoui before adding polyglot scope.

- [ ] Set up monorepo with pnpm + turbo
- [ ] Implement `@qa/core`:
  - [ ] Named `Rule` and `Check` types
  - [ ] Exemption/baseline engine
  - [ ] Selector API (`select()`, `.exclude()`, `.check()`, `.forEach()`, `.forEachDir()`)
  - [ ] Primitive checks (`requireSibling`, `requireChildren`, `forbidFile`, `noImports`, `noPattern`, `noCalls`)
  - [ ] RuleRunner with mtime-based caching
- [ ] Implement `@qa/typescript`:
  - [ ] TypeScriptAdapter with ts-morph
  - [ ] Import resolution via tsconfig
  - [ ] Generic TS checks
- [ ] Port all 13 immoui structural tests to the framework
- [ ] Validate: pass/fail parity with existing tests
- [ ] Benchmark cold/warm runtime and memory on immoui
- [ ] Tests for core + typescript

### Phase 2: Framework Packages (Primitives Only)

- [ ] Implement `@qa/tanstack-query`:
  - [ ] `hookPairs()` check
  - [ ] `queryOptions()` check
  - [ ] `mutationInvalidation()` check
  - [ ] `testQuality()` check with AST scoring
- [ ] Implement `@qa/react`:
  - [ ] `requireStories()` check
  - [ ] `requireTests()` check
  - [ ] `noDirectQueries()` check
  - [ ] `noRouteState()` check
- [ ] Port all 13 immoui structural tests using framework packages
- [ ] Verify same violations are caught
- [ ] Performance benchmark vs. manual tests

### Phase 3: Test Runner & PHP

- [ ] Implement `@qa/vitest`:
  - [ ] Vite plugin
  - [ ] Custom matcher `toPass`
  - [ ] `defineQualityTests()` helper
  - [ ] Setup file
- [ ] Implement `@qa/php`:
  - [ ] PhpAdapter with tree-sitter-php
  - [ ] PSR-4 import resolution
  - [ ] Generic PHP checks
- [ ] Implement `@qa/laravel`:
  - [ ] `controllersUseRequests()` check
  - [ ] `modelsHaveFactories()` check
  - [ ] `noRawDb()` check
- [ ] Port immocore rules
- [ ] Test monorepo config

### Phase 4: Presets, CLI & Integrations

- [ ] Implement `@qa/presets`:
  - [ ] `immouiPreset()`
  - [ ] `laravelPreset()`
  - [ ] `cleanArchitecturePreset()`
- [ ] Implement `@qa/cli`:
  - [ ] `qa check` command
  - [ ] `qa init` command
  - [ ] `--watch` mode
  - [ ] `--changed` mode
- [ ] Research and prototype integration with existing linters (ESLint, Prettier, oxlint, pint, phpstan)
- [ ] Documentation
- [ ] Dogfooding (test the framework with itself)

---

*This document is ready for review. Please critique the API design, architecture decisions, and implementation plan.*
