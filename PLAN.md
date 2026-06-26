# Quality Assurance Framework — Comprehensive Plan

> **Status:** Draft v1.0 | **Scope:** Architecture, Design, and Implementation Roadmap

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Prior Art Analysis](#2-prior-art-analysis)
3. [Core Philosophy & Design Principles](#3-core-philosophy--design-principles)
4. [Architecture Overview](#4-architecture-overview)
5. [The Rule Engine](#5-the-rule-engine)
6. [Primitives Layer](#6-primitives-layer)
7. [Built-in Rules Catalog](#7-built-in-rules-catalog)
8. [Configuration Format](#8-configuration-format)
9. [Test Runner Integrations](#9-test-runner-integrations)
10. [Presets](#10-presets)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Self-Testing Strategy](#12-self-testing-strategy)
13. [Open Questions & Decisions](#13-open-questions--decisions)

---

## 1. Executive Summary

### The Problem

Current codebase quality enforcement (as demonstrated in `immoui/`) is implemented as a collection of **manual, ad-hoc structural tests** — each test independently implements:
- File system traversal (glob, fs)
- Import extraction (regex or AST)
- TypeScript AST parsing (ts compiler API)
- Violation collection and reporting
- Test runner integration

This leads to:
- **Massive duplication** — every test reimplements file walking, AST parsing, import resolution
- **No composability** — rules are monolithic, cannot be reused or combined
- **Hard to customize** — changing a rule requires modifying TypeScript test code
- **Hard to port** — copying QA to another codebase means copying dozens of test files
- **No standard reporting** — each test formats errors differently

### The Solution

A **Quality Assurance Framework** that provides:

1. **A Rule Engine** — a minimal, fast execution engine that runs rules and reports violations
2. **Primitives** — reusable building blocks (file walking, AST analysis, import graphs, pattern matching) that rules compose
3. **Built-in Rules** — out-of-the-box implementations of common architectural, structural, and quality rules
4. **A Unified Config Format** — one TypeScript config file declares all rules for a codebase
5. **Test Runner Integration** — one-line setup for Vitest (and others) that auto-generates test suites
6. **Presets** — opinionated rule sets (e.g., "React SaaS", "Clean Architecture", "Feature-Sliced Design") that can be dropped in

### Key Insight

**We are not building a linter, a type checker, or an AST parser.**

We are building **a rule engine that composes these tools** into a unified, testable, configurable framework.

- **Linting** → use oxlint / ESLint (don't replace)
- **Type checking** → use tsc (don't replace)
- **Formatting** → use oxfmt / Prettier (don't replace)
- **AST parsing** → use ts-morph (don't reinvent)
- **Dependency graph** → use dependency-cruiser API (don't reinvent)
- **File walking** → use glob (don't reinvent)

Our value is the **unification layer** and the **rule primitives**.

---

## 2. Prior Art Analysis

### 2.1 Evaluated Tools

| Tool | What It Does | Strengths | Weaknesses | Our Relationship |
|------|-------------|-----------|------------|------------------|
| **ts-arch / ts-arch** | File-based architecture testing | Fluent API, dependency graphs, cycle detection | Limited to file-level; no AST rules; Jest-centric | Inspiration for fluent API; we go deeper with AST |
| **ArchUnitTS** | Comprehensive architecture testing | File + slice testing, metrics (LCOM), custom rules, Vitest support | Heavy, opinionated, no AST-based structural rules | Closest competitor; we provide more granular primitives |
| **dependency-cruiser** | Dependency validation & visualization | Mature (7k stars), rich rule format, graph output, circular deps | CLI-first, not designed as a library, JS-heavy | **Optional dependency** for graph analysis |
| **eslint-plugin-boundaries** | ESLint layer enforcement | Works inside existing lint workflow, well-defined layer rules | ESLint-only, no file-structure or AST rules | **Complementary** — users can keep this or use our rules |
| **ts-morph** | TypeScript AST manipulation | Best-in-class TS AST wrapper, 6k stars, type-safe | Slower for large projects, memory-heavy | **Primary dependency** for AST-based rules |
| **unimported** | Find unused files | Simple, effective | Only one concern | **Not needed** — our rules cover this |
| **cosmiconfig** | Config file discovery | Standard, widely used | | **Optional** for config file discovery |

### 2.2 What None of Them Provide

1. **A unified rule engine** — ts-arch and ArchUnitTS have their own test runners, but they don't provide a composable engine for arbitrary rules
2. **AST-based structural rules** — no existing tool checks test quality via AST, SDK hook pairs, or i18n raw strings
3. **A single config file** — dependency-cruiser has its own config, ESLint has another, tests are scattered
4. **Test runner integration** — ArchUnitTS has `toPassAsync()` but it's limited to their rules
5. **Primitives for custom rules** — no existing tool exposes file-walking, AST analysis, and import resolution as reusable primitives

### 2.3 What We Will Leverage

- **ts-morph** — for all AST-based analysis (test files, components, SDK hooks, routes, i18n)
- **dependency-cruiser** (optional) — for dependency graph rules (circular deps, layer violations, reachability)
- **glob / fast-glob** — for file walking
- **Vitest** — for test runner integration
- **Zod** — for configuration validation (optional, but recommended)

---

## 3. Core Philosophy & Design Principles

### 3.1 Don't Reinvent, Compose

The framework's job is not to parse TypeScript or resolve imports. Its job is to:
1. **Provide a shared context** (parsed AST, file graph, project config) that all rules can use
2. **Define a standard interface** for rules
3. **Run rules efficiently** (shared caches, parallel execution)
4. **Report violations consistently**

### 3.2 Rules Are Pure Functions

```typescript
// A rule is just a function: Context => Violation[]
interface Rule {
  name: string;
  description?: string;
  check: (ctx: RuleContext) => Violation[] | Promise<Violation[]>;
}
```

No side effects. No test runner dependency. Just data in, violations out.

### 3.3 Primitives Over Presets

Presets (like "immoui") are important for out-of-the-box usability, but the **primitives** are the core value.

A user should be able to write a custom rule in 10 lines using primitives:

```typescript
{
  name: 'no-console-in-production',
  check: (ctx) => {
    const files = ctx.walkFiles('src/**/*.ts');
    return files
      .flatMap(f => ctx.findNodes(f, { kind: 'CallExpression', callee: 'console.log' }))
      .map(node => ctx.violation(node, 'console.log found in production code'));
  }
}
```

### 3.4 Configuration Is Code

A TypeScript config file is the primary interface. This gives:
- Type safety and autocomplete
- Ability to import and compose configs
- Ability to use logic (if/else, functions, variables)
- Easy to share via git

### 3.5 Dogfooding

The framework must be tested using its own rules. The `quality-assurance` package's own source code should be validated by its own engine.

### 3.6 Performance First

The current immoui structural tests run in ~1s. We must maintain this speed:
- Parse AST once, share across rules
- Cache file listings
- Support incremental analysis (only check changed files)
- Lazy-load expensive analysis (dependency graph only computed if needed)

---

## 4. Architecture Overview

### 4.1 Package Structure

```
quality-assurance/
  src/
    core/                    # The rule engine
      index.ts               # Public API exports
      rule.ts                # Rule interface and types
      context.ts             # RuleContext implementation
      runner.ts              # RuleRunner — executes rules
      violation.ts           # Violation type and formatting
      reporter.ts            # Reporter interface + console/JSON reporters
      
    primitives/              # Reusable building blocks
      index.ts
      fs.ts                  # File walking, filtering, caching
      ast.ts                 # ts-morph wrapper with caching
      imports.ts             # Import extraction and resolution
      patterns.ts            # Glob, regex, path matching
      graph.ts               # Dependency graph (wraps dependency-cruiser or ts-morph)
      
    rules/                   # Built-in rules
      index.ts               # Rule factories
      architecture.ts        # Layer enforcement, cross-domain checks
      file-structure.ts      # Required files, forbidden patterns
      imports.ts             # Import discipline (forbidden imports, direct calls)
      test-quality.ts        # AST-based test scoring
      component-coverage.ts # File pair coverage (stories, tests)
      i18n.ts                # Hardcoded string detection
      sdk-conventions.ts     # SDK-specific conventions
      routes.ts              # Route discipline
      generated-types.ts     # Generated type boundary
      
    presets/                 # Opinionated rule sets
      index.ts
      immoui.ts              # The immoui preset
      clean-architecture.ts  # Standard clean arch
      fsd.ts                 # Feature-Sliced Design
      
    integrations/            # Test runner integrations
      vitest.ts              # Vitest matchers + test generator
      
  package.json
  tsconfig.json
  quality-assurance.config.ts   # Framework's own QA config
  PLAN.md
```

### 4.2 Core Data Flow

```
User Config
    │
    ▼
RuleRunner
    │
    ├─► loads ts-morph Project (once)
    ├─► walks files (cached)
    ├─► builds dependency graph (lazy, cached)
    │
    ▼
Rule 1 ──► RuleContext ──► Violations[]
Rule 2 ──► RuleContext ──► Violations[]
Rule 3 ──► RuleContext ──► Violations[]
    │
    ▼
Reporter
    │
    ▼
Console / JSON / Vitest
```

### 4.3 RuleContext Design

The `RuleContext` is the **shared interface** all rules use. It provides:

```typescript
interface RuleContext {
  // ─── File System ───
  walkFiles(pattern: string, options?: WalkOptions): FileInfo[];
  readFile(path: string): string;
  resolvePath(path: string): string;
  
  // ─── AST Analysis ───
  getAst(path: string): SourceFile; // ts-morph SourceFile
  findNodes(path: string, query: NodeQuery): Node[];
  parseExpression(path: string, code: string): Node;
  
  // ─── Import Analysis ───
  getImports(path: string): ImportInfo[];
  getDependencyGraph(): DependencyGraph; // lazy
  resolveImport(from: string, importPath: string): string | null;
  
  // ─── Pattern Matching ───
  matchPattern(path: string, pattern: string | RegExp): boolean;
  matchGlob(path: string, pattern: string): boolean;
  
  // ─── Violation Helpers ───
  violation(node: Node, message: string, options?: ViolationOptions): Violation;
  violationAt(path: string, line: number, message: string): Violation;
  
  // ─── Config Access ───
  config: UserConfig;
  projectRoot: string;
  tsConfigPath?: string;
}
```

**Key design decision:** All expensive operations are **cached and lazy**.
- `getAst()` — parses the file once, caches the SourceFile
- `walkFiles()` — caches the glob results
- `getDependencyGraph()` — only runs dependency-cruiser if a rule calls it
- `getImports()` — can be derived from AST (fast) or dependency graph (accurate)

---

## 5. The Rule Engine

### 5.1 Rule Interface

```typescript
export interface Rule {
  name: string;
  description?: string;
  severity?: 'error' | 'warn' | 'info';
  check: (ctx: RuleContext) => Violation[] | Promise<Violation[]>;
}

export interface Violation {
  rule: string;
  message: string;
  path: string;
  line?: number;
  column?: number;
  context?: string; // e.g., the import path, the node snippet
  fix?: string; // suggested fix (optional)
}
```

### 5.2 Rule Runner

```typescript
export class RuleRunner {
  constructor(private context: RuleContext, private rules: Rule[]) {}
  
  async run(options?: RunOptions): Promise<RunResult> {
    const results: RuleResult[] = [];
    
    for (const rule of this.rules) {
      const start = performance.now();
      const violations = await rule.check(this.context);
      const duration = performance.now() - start;
      
      results.push({ rule: rule.name, violations, duration });
    }
    
    return { results, totalViolations: results.reduce((sum, r) => sum + r.violations.length, 0) };
  }
}
```

### 5.3 Custom Rule Example

```typescript
// A custom rule using only primitives
export const noConsoleLogRule: Rule = {
  name: 'no-console-log',
  description: 'Prevent console.log in production code',
  check: (ctx) => {
    const files = ctx.walkFiles('src/**/*.ts');
    const violations: Violation[] = [];
    
    for (const file of files) {
      const ast = ctx.getAst(file.path);
      const calls = ast.getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter(node => {
          const expr = node.getExpression();
          return expr.getText() === 'console.log';
        });
      
      for (const call of calls) {
        violations.push(ctx.violation(call, 'console.log is not allowed in production'));
      }
    }
    
    return violations;
  }
};
```

---

## 6. Primitives Layer

### 6.1 File System (`primitives/fs.ts`)

```typescript
export interface FileWalker {
  walk(pattern: string, options?: WalkOptions): Promise<FileInfo[]>;
  walkSync(pattern: string, options?: WalkOptions): FileInfo[];
  exists(path: string): boolean;
  read(path: string): string;
}

export interface FileInfo {
  path: string;        // relative to project root
  absolutePath: string;
  name: string;
  ext: string;
  dir: string;
  stats: Stats;
}
```

**Implementation:** Use `fast-glob` with caching. Cache key = `pattern + options`.

### 6.2 AST (`primitives/ast.ts`)

```typescript
export interface AstAnalyzer {
  // Parse a file and return ts-morph SourceFile
  parse(path: string): SourceFile;
  
  // Find nodes matching a query
  find(file: string, query: NodeQuery): Node[];
  
  // Extract specific node types
  getImports(file: string): ImportDeclaration[];
  getExports(file: string): ExportDeclaration[];
  getFunctions(file: string): FunctionDeclaration[];
  getClasses(file: string): ClassDeclaration[];
  
  // Check if a file contains a pattern
  contains(file: string, query: NodeQuery): boolean;
  
  // Extract text of a node
  getText(node: Node): string;
  getLineAndColumn(node: Node): { line: number; column: number };
}

export interface NodeQuery {
  kind?: SyntaxKind | SyntaxKind[];
  text?: string | RegExp;
  hasChild?: NodeQuery;
  hasParent?: NodeQuery;
  // ... extensible
}
```

**Implementation:** Wrap `ts-morph` with a `Project` singleton. Cache `SourceFile` instances.

### 6.3 Import Analysis (`primitives/imports.ts`)

```typescript
export interface ImportAnalyzer {
  // Extract all imports from a file
  extract(file: string): ImportInfo[];
  
  // Resolve an import path to an absolute file path
  resolve(from: string, importPath: string): string | null;
  
  // Check if an import is relative
  isRelative(importPath: string): boolean;
  
  // Check if an import points to a node_modules package
  isExternal(importPath: string): boolean;
}

export interface ImportInfo {
  source: string;        // raw import path
  resolved: string | null; // resolved file path
  isRelative: boolean;
  isExternal: boolean;
  isTypeOnly: boolean;
  specifiers: string[];  // named imports
  defaultSpecifier?: string;
  namespace?: string;
  line: number;
}
```

**Implementation:** Use ts-morph's `ImportDeclaration` for extraction. For resolution, use `ts-morph`'s module resolution or `dependency-cruiser`'s resolution.

### 6.4 Pattern Matching (`primitives/patterns.ts`)

```typescript
export interface PatternMatcher {
  matchGlob(path: string, pattern: string): boolean;
  matchRegex(path: string, pattern: RegExp): boolean;
  matchAny(path: string, patterns: (string | RegExp)[]): boolean;
  
  // Extract capture groups from regex
  extractGroups(path: string, pattern: RegExp): string[] | null;
}
```

**Implementation:** Use `micromatch` for glob, native `RegExp` for regex.

### 6.5 Dependency Graph (`primitives/graph.ts`)

```typescript
export interface DependencyGraph {
  // Get all nodes (files)
  getNodes(): string[];
  
  // Get all edges (imports)
  getEdges(): { from: string; to: string }[];
  
  // Get dependencies of a file
  getDependencies(file: string): string[];
  
  // Get dependents of a file
  getDependents(file: string): string[];
  
  // Check if there are circular dependencies
  getCycles(): string[][];
  
  // Check if there's a path from A to B
  hasPath(from: string, to: string): boolean;
  
  // Get all files in a folder
  getFolder(folder: string): string[];
}
```

**Implementation:** Optional dependency on `dependency-cruiser` API. If not available, build a simple graph from ts-morph import data.

---

## 7. Built-in Rules Catalog

### 7.1 Architecture Rules

```typescript
export interface ArchitectureRuleOptions {
  layers: Layer[];
  enforcePublicApi?: boolean; // require index.ts for each layer
  publicApiPattern?: string;    // default: 'index.ts'
}

export interface Layer {
  name: string;
  pattern: string | RegExp;     // glob or regex
  allowedImports?: string[];    // layer names allowed
  forbiddenImports?: string[]; // layer names forbidden
}
```

**What it checks:**
- No file in layer A imports from layer B if forbidden
- Every layer has a public API (index.ts)
- No deep imports into layer internals

**Implementation:**
1. Walk all files matching layer patterns
2. Extract imports from each file
3. Resolve import path to target layer
4. Check against layer rules
5. Check for index.ts in each layer

### 7.2 File Structure Rules

```typescript
export interface FileStructureRuleOptions {
  required?: RequiredFile[];
  forbidden?: ForbiddenPattern[];
  naming?: NamingConvention[];
}

export interface RequiredFile {
  pattern: string;      // glob pattern
  description?: string;
}

export interface ForbiddenPattern {
  pattern: string;
  description?: string;
}

export interface NamingConvention {
  path: string;         // glob for files to check
  pattern: string | RegExp; // naming pattern
  description?: string;
}
```

**What it checks:**
- Required files exist (e.g., `src/index.ts`)
- Forbidden patterns don't exist (e.g., `src/**/components/**`)
- Files follow naming conventions

### 7.3 Import Discipline Rules

```typescript
export interface ImportDisciplineRuleOptions {
  rules: ImportRule[];
}

export interface ImportRule {
  path: string | RegExp;       // files to check
  forbiddenImports?: string[];  // forbidden import patterns
  requiredImports?: string[];   // required import patterns
  forbiddenPatterns?: string[]; // forbidden code patterns (e.g., 'useState(')
  allowedImports?: string[];    // whitelist
}
```

**What it checks:**
- Files matching `path` don't import from forbidden sources
- Files matching `path` don't contain forbidden patterns
- Required imports are present

### 7.4 Component Coverage Rules

```typescript
export interface ComponentCoverageRuleOptions {
  componentPattern: string;     // e.g., 'src/**/*.tsx'
  requiredPairs: FilePair[];
  exclusions?: string[];        // legacy exemptions
}

export interface FilePair {
  suffix: string;               // e.g., '.stories.tsx'
  pattern?: string;             // glob to find the pair
  required?: boolean;           // default: true
}
```

**What it checks:**
- Every `.tsx` file (matching componentPattern) has a corresponding `.stories.tsx` and `.test.tsx`

### 7.5 Test Quality Rules

```typescript
export interface TestQualityRuleOptions {
  testPattern: string;          // e.g., 'src/**/*.test.tsx'
  minScore?: number;            // default: 50
  requirements?: TestRequirements;
}

export interface TestRequirements {
  minHappyPathTests?: number;   // default: 2
  minBadPathTests?: number;     // default: 2
  minInteractionTests?: number; // default: 1
  minAsyncTests?: number;       // default: 1
  forbidTrivialAssertions?: boolean; // default: true
  forbidSnapshotOnly?: boolean; // default: true
}
```

**What it checks (via AST analysis):**
- Number of test blocks (`it` / `test`)
- Number of assertions (`expect()`)
- Presence of interaction tests (`userEvent` / `fireEvent`)
- Presence of async tests (`waitFor` / `async`)
- Presence of error tests (`toThrow` / `rejects`)
- Absence of trivial assertions (`toBe(true)` / `toBeDefined()`)
- Absence of snapshot-only tests
- Scores tests and reports failures

### 7.6 i18n Rules

```typescript
export interface I18nRuleOptions {
  pattern: string;            // files to check
  translatableProps?: string[]; // e.g., ['label', 'placeholder', 'title']
  i18nFunction?: string | string[]; // e.g., 'm.' or ['t', 'translate']
  backend?: 'paraglide' | 'react-intl' | 'custom';
  customChecker?: (node: Node) => boolean;
}
```

**What it checks (via AST):**
- No raw JSX text children with letters
- No raw string literals in translatable props
- Supports different i18n backends via abstraction

### 7.7 SDK Convention Rules

```typescript
export interface SdkConventionRuleOptions {
  basePath: string;             // e.g., 'src/sdk/domains'
  requiredFiles: string[];
  hooks?: {
    requiredFiles: string[];
    forbiddenFiles: string[];
  };
  enforceQueryPairs?: boolean;  // useX + useSuspenseX
  enforceQueryOptions?: boolean; // queryKey + queryFn + staleTime
  enforceMutations?: boolean;   // onMutate + onError + onSettled
  enforceTypeBoundary?: boolean; // generated types don't leak
}
```

**What it checks:**
- Required file structure per sub-domain
- No forbidden files (split query files, legacy hooks.ts)
- Hook pairs (useX + useSuspenseX)
- queryOptions discipline (via AST)
- Mutation discipline (via AST)
- Generated type boundary (via import analysis)

### 7.8 Route Discipline Rules

```typescript
export interface RouteDisciplineRuleOptions {
  pattern: string;              // e.g., 'src/routes/**/*.tsx'
  forbidHtml?: boolean;         // default: true
  forbidUseState?: boolean;     // default: true
  forbidDirectImports?: string[]; // e.g., ['@tanstack/react-query']
  requireQueryOptions?: boolean; // loaders must use *QueryOptions
  forbidLocalComponents?: boolean; // no local helper components
}
```

**What it checks (via AST):**
- No HTML elements in route files
- No `useState` calls
- No direct imports from forbidden packages
- Route loaders use queryOptions factories
- No local helper component definitions

---

## 8. Configuration Format

### 8.1 The Config File

```typescript
// quality-assurance.config.ts
import { defineConfig } from '@immocore/quality-assurance';

export default defineConfig({
  // Project settings
  project: './tsconfig.json',
  rootDir: './src',
  
  // Rules
  rules: [
    // Use a preset
    presets.immoui(),
    
    // Or use individual rules
    rules.architecture({
      layers: [
        { name: 'lib', pattern: 'src/lib/**', allowedImports: [] },
        { name: 'sdk', pattern: 'src/sdk/**', allowedImports: ['lib'] },
        { name: 'ui', pattern: 'src/components/ui/**', allowedImports: ['lib'] },
        { name: 'generic', pattern: 'src/components/generic/**', allowedImports: ['ui', 'sdk', 'lib'] },
        { name: 'layout', pattern: 'src/components/layout/**', allowedImports: ['generic', 'ui', 'sdk', 'lib'] },
        { name: 'domains', pattern: 'src/components/domains/*/**', allowedImports: ['layout', 'generic', 'ui', 'sdk', 'lib'] },
        { name: 'routes', pattern: 'src/routes/**', allowedImports: ['*'] },
      ],
      enforcePublicApi: true,
    }),
    
    rules.fileStructure({
      required: [
        { pattern: 'src/components/domains/*/index.ts' },
        { pattern: 'src/components/generic/*/index.ts' },
        { pattern: 'src/components/layout/*/index.ts' },
      ],
      forbidden: [
        { pattern: 'src/components/domains/*/components/**', description: 'Use pure/ instead of components/' },
        { pattern: 'src/routes/**/$tab.tsx', description: 'Each tab must be an explicit route file' },
      ],
    }),
    
    rules.imports({
      rules: [
        {
          path: 'src/components/**/*.{ts,tsx}',
          forbiddenImports: ['@tanstack/react-query'],
          description: 'Components must use SDK hooks instead of direct TanStack Query',
        },
        {
          path: 'src/routes/**/*.tsx',
          forbiddenImports: ['@tanstack/react-query'],
          forbiddenPatterns: ['useState('],
        },
      ],
    }),
    
    rules.componentCoverage({
      componentPattern: 'src/**/*.tsx',
      requiredPairs: [
        { suffix: '.stories.tsx' },
        { suffix: '.test.tsx' },
      ],
    }),
    
    rules.testQuality({
      testPattern: 'src/**/*.test.tsx',
      minScore: 50,
    }),
    
    rules.i18n({
      pattern: 'src/components/**/*.tsx',
      translatableProps: ['label', 'placeholder', 'title', 'aria-label', 'description'],
    }),
    
    // Custom rule
    {
      name: 'no-raw-buttons',
      check: (ctx) => {
        const files = ctx.walkFiles('src/components/**/*.tsx');
        const violations = [];
        for (const file of files) {
          const ast = ctx.getAst(file.path);
          const rawButtons = ast.getDescendantsOfKind(SyntaxKind.JsxElement)
            .filter(el => el.getOpeningElement().getTagNameNode().getText() === 'button');
          for (const btn of rawButtons) {
            violations.push(ctx.violation(btn, 'Use <Button> from shadcn/ui instead of raw <button>'));
          }
        }
        return violations;
      },
    },
  ],
});
```

### 8.2 Type Safety

The `defineConfig` helper provides full type inference and autocomplete. The `rules` object has factory functions for all built-in rules with typed options.

### 8.3 Config Composition

```typescript
// base.config.ts
export const baseConfig = defineConfig({
  rules: [rules.architecture({ ... })],
});

// project.config.ts
import { baseConfig } from './base.config';

export default defineConfig({
  ...baseConfig,
  rules: [
    ...baseConfig.rules,
    rules.i18n({ ... }),
  ],
});
```

---

## 9. Test Runner Integrations

### 9.1 Vitest Integration

**Option A: Single Test (simple)**

```typescript
// src/__tests__/quality.test.ts
import { defineQualityTest } from '@immocore/quality-assurance/vitest';
import config from '../quality-assurance.config';

const qa = defineQualityTest(config);

describe('Quality Assurance', () => {
  it('passes all rules', async () => {
    await expect(qa).toPass();
  });
});
```

**Option B: Per-Rule Tests (detailed)**

```typescript
// src/__tests__/quality.test.ts
import { createQATests } from '@immocore/quality-assurance/vitest';
import config from '../quality-assurance.config';

// Auto-generates describe/it blocks for each rule
createQATests(config);
```

This generates output like:
```
Quality Assurance
  architecture
    ✓ layers are respected
    ✓ public APIs have index.ts
  file-structure
    ✓ required files exist
    ✓ no forbidden patterns
  test-quality
    ✓ all test files pass minimum score
```

**Option C: Custom Matcher (current immoui style)**

```typescript
import { expect } from 'vitest';
import { toPassQuality } from '@immocore/quality-assurance/vitest';

expect.extend({ toPassQuality });

const rule = rules.architecture({ ... });
await expect(rule).toPassQuality();
```

### 9.2 Other Test Runners

For Jest, Mocha, or other runners:

```typescript
import { RuleRunner } from '@immocore/quality-assurance';
import config from './quality-assurance.config';

const runner = new RuleRunner(config);
const result = await runner.run();

if (result.totalViolations > 0) {
  console.error(result.format());
  process.exit(1);
}
```

---

## 10. Presets

### 10.1 The Immoui Preset

```typescript
// presets/immoui.ts
export const immoui = (options?: Partial<ImmouiOptions>): Rule[] => [
  rules.architecture({
    layers: [
      { name: 'lib', pattern: 'src/lib/**', allowedImports: [] },
      { name: 'sdk', pattern: 'src/sdk/**', allowedImports: ['lib'] },
      { name: 'ui', pattern: 'src/components/ui/**', allowedImports: ['lib'] },
      { name: 'generic', pattern: 'src/components/generic/**', allowedImports: ['ui', 'sdk', 'lib'] },
      { name: 'layout', pattern: 'src/components/layout/**', allowedImports: ['generic', 'ui', 'sdk', 'lib'] },
      { name: 'domains', pattern: 'src/components/domains/*/**', allowedImports: ['layout', 'generic', 'ui', 'sdk', 'lib'] },
      { name: 'bridges', pattern: 'src/components/domains/*/bridges/**', allowedImports: ['domains', 'layout', 'generic', 'ui', 'sdk', 'lib'] },
      { name: 'routes', pattern: 'src/routes/**', allowedImports: ['*'] },
    ],
    enforcePublicApi: true,
  }),
  
  rules.fileStructure({
    required: [
      { pattern: 'src/components/domains/*/index.ts' },
      { pattern: 'src/components/generic/*/index.ts' },
      { pattern: 'src/components/layout/*/index.ts' },
      { pattern: 'src/components/domains/*/pages/index.ts' },
      { pattern: 'src/sdk/domains/*/index.ts' },
      { pattern: 'src/sdk/domains/*/*/index.ts' },
    ],
    forbidden: [
      { pattern: 'src/components/domains/*/components/**', description: 'Use pure/ instead' },
      { pattern: 'src/routes/**/$tab.tsx', description: 'Each tab must be an explicit route file' },
    ],
  }),
  
  rules.imports({
    rules: [
      { path: 'src/components/**/*.{ts,tsx}', forbiddenImports: ['@tanstack/react-query'] },
      { path: 'src/routes/**/*.tsx', forbiddenImports: ['@tanstack/react-query'] },
      { path: 'src/components/**/*.tsx', forbiddenPatterns: ['useQuery(', 'useSuspenseQuery('] },
    ],
  }),
  
  rules.componentCoverage({
    componentPattern: 'src/**/*.tsx',
    requiredPairs: [{ suffix: '.stories.tsx' }, { suffix: '.test.tsx' }],
  }),
  
  rules.testQuality({
    testPattern: 'src/**/*.test.tsx',
    minScore: 50,
  }),
  
  rules.i18n({
    pattern: 'src/components/**/*.tsx',
    translatableProps: ['label', 'placeholder', 'title', 'aria-label', 'description'],
  }),
  
  rules.sdkConventions({
    basePath: 'src/sdk/domains',
    requiredFiles: ['index.ts', 'interface.ts', 'http.ts', 'memory.ts', 'types.ts', 'fakes.ts'],
    hooks: {
      requiredFiles: ['index.ts', 'queries.ts'],
      forbiddenFiles: ['query-keys.ts', 'query-options.ts', 'hooks.ts'],
    },
    enforceQueryPairs: true,
    enforceQueryOptions: true,
    enforceMutations: true,
    enforceTypeBoundary: true,
  }),
  
  rules.routes({
    pattern: 'src/routes/**/*.tsx',
    forbidHtml: true,
    forbidUseState: true,
    forbidDirectImports: ['@tanstack/react-query'],
    requireQueryOptions: true,
    forbidLocalComponents: true,
  }),
  
  rules.generatedTypes({
    generatedPath: 'src/sdk/generated',
    allowedConsumers: ['src/sdk/**'],
  }),
  
  rules.storybookGrouping({
    pattern: 'src/components/**/*.stories.tsx',
    forbidExplicitTitle: true,
  }),
  
  rules.relativeImports({
    pattern: 'src/**/*.{ts,tsx}',
  }),
];
```

### 10.2 Future Presets

- **Clean Architecture** — domain / application / infrastructure layers
- **Feature-Sliced Design** — app, processes, pages, widgets, features, entities, shared
- **NestJS** — module boundaries, dependency injection rules
- **Next.js** — app router discipline, server/client boundaries

---

## 11. Implementation Roadmap

### Phase 1: Foundation (Week 1)

**Goal:** Core engine + primitives + 3 basic rules

- [ ] Set up package structure (`src/core/`, `src/primitives/`, `src/rules/`, `src/integrations/`)
- [ ] Implement `Rule` interface, `Violation` type, `RuleRunner`
- [ ] Implement `RuleContext` with lazy caching
- [ ] Implement `FileWalker` primitive (wraps fast-glob)
- [ ] Implement `AstAnalyzer` primitive (wraps ts-morph)
- [ ] Implement `ImportAnalyzer` primitive
- [ ] Implement `PatternMatcher` primitive
- [ ] Implement **Architecture Rule**
- [ ] Implement **File Structure Rule**
- [ ] Implement **Import Discipline Rule**
- [ ] Implement Vitest integration (`createQATests`)
- [ ] Write comprehensive tests for core + primitives

**Deliverable:** Can run basic architecture tests via Vitest.

### Phase 2: Immoui Rule Port (Week 2)

**Goal:** Port all immoui structural tests to built-in rules

- [ ] Implement **Component Coverage Rule**
- [ ] Implement **Test Quality Rule** (AST-based scoring)
- [ ] Implement **i18n Rule** (raw string detection)
- [ ] Implement **SDK Convention Rule**
- [ ] Implement **Route Discipline Rule**
- [ ] Implement **Generated Types Rule**
- [ ] Implement **Storybook Grouping Rule**
- [ ] Implement **Relative Imports Rule**
- [ ] Create the `immoui` preset
- [ ] Add configuration file with `defineConfig`

**Deliverable:** Can replace all 13 immoui structural tests with one config file.

### Phase 3: Polish & Integration (Week 3)

**Goal:** Make it production-ready

- [ ] Add caching layer (cache AST, file listings, import data across rule runs)
- [ ] Add performance benchmarks
- [ ] Add CLI (`qa check`, `qa init`)
- [ ] Add multiple reporters (console, JSON, HTML)
- [ ] Add configuration validation (Zod schema)
- [ ] Add documentation
- [ ] Add error messages with line numbers, file paths, and fix suggestions
- [ ] Test with immoui codebase (ensure same violations are caught)

**Deliverable:** Library is usable as a drop-in replacement for immoui's manual tests.

### Phase 4: Extensibility (Week 4)

**Goal:** Make it easy for others to build custom rules

- [ ] Document all primitives with examples
- [ ] Create "custom rule" tutorial
- [ ] Add `createRule()` helper for common patterns
- [ ] Add middleware support (transform violations, add metadata)
- [ ] Add preset composition helpers
- [ ] Add community preset templates
- [ ] Consider publishing as npm package

**Deliverable:** Framework is extensible and documented.

---

## 12. Self-Testing Strategy

The framework must dogfood itself:

```typescript
// quality-assurance.config.ts (the framework's own QA)
import { defineConfig } from './src/core';
import { rules } from './src/rules';

export default defineConfig({
  project: './tsconfig.json',
  rules: [
    rules.fileStructure({
      required: [
        { pattern: 'src/core/index.ts' },
        { pattern: 'src/primitives/index.ts' },
        { pattern: 'src/rules/index.ts' },
      ],
    }),
    
    rules.componentCoverage({
      componentPattern: 'src/**/*.ts',
      requiredPairs: [{ suffix: '.test.ts' }],
    }),
    
    rules.testQuality({
      testPattern: 'src/**/*.test.ts',
      minScore: 70,
    }),
    
    rules.imports({
      rules: [
        { path: 'src/core/**', forbiddenImports: ['src/rules'] },
      ],
    }),
  ],
});
```

Every rule must have:
- Unit tests (testing the rule logic in isolation)
- Integration tests (testing the rule against real file structures)
- The rule itself should be tested by the test quality rule

---

## 13. Open Questions & Decisions

### Q1: Should we use dependency-cruiser or build our own graph?

**Options:**
- A) Use dependency-cruiser as a hard dependency (mature, handles all edge cases)
- B) Use dependency-cruiser as an optional dependency (only if user needs graph rules)
- C) Build our own graph from ts-morph imports (lighter, no extra deps)

**Recommendation:** B) Optional dependency. Use ts-morph for simple import analysis in most rules. Use dependency-cruiser only when graph rules (cycles, reachability, complex layer checks) are enabled. This keeps the core lightweight.

### Q2: How do we handle configuration validation?

**Options:**
- A) Pure TypeScript types (no runtime validation)
- B) Zod schemas (runtime validation + type inference)
- C) JSON Schema (standard, but verbose)

**Recommendation:** A) for the core library, with B) as an optional add-on. Since the config is TypeScript, compile-time checking is sufficient. Runtime validation is nice-to-have for CLI usage.

### Q3: Should we provide a CLI?

**Options:**
- A) Yes, with `qa check`, `qa init`, `qa --watch`
- B) No, only test runner integration

**Recommendation:** A) Yes, but Phase 3. A CLI is useful for CI pipelines and quick checks. The test runner integration is the primary interface.

### Q4: How do we handle exemptions/baselines?

**Options:**
- A) Inline in config (exemptions array)
- B) Separate exemptions file (like .eslintignore)
- C) Both

**Recommendation:** C) Both. Inline exemptions for simple cases, separate file for large baselines (e.g., migrating a legacy codebase). Support ESLint-style ignore comments too (`// qa-disable-next-line`).

### Q5: Monorepo vs. Single Package?

**Options:**
- A) Single package (simpler)
- B) Monorepo with multiple packages (core, rules, presets, integrations)

**Recommendation:** A) Single package for now. The library is small enough that a single package with clear exports is sufficient. We can split later if needed.

### Q6: How do we handle the fact that immoui uses Bun, but other projects might use npm/pnpm?

**Recommendation:** The library should be package-manager agnostic. It should work with any runtime that supports Node.js APIs. Use standard `fs`, `path`, and `glob` — no Bun-specific APIs.

### Q7: Should we support non-TypeScript projects?

**Options:**
- A) Yes, support JS projects too
- B) No, TypeScript only

**Recommendation:** B) TypeScript only. The library is heavily built on ts-morph and AST analysis. JavaScript projects can use dependency-cruiser directly. We can revisit this if there's demand.

### Q8: How do we handle the `eslint-plugin-boundaries` overlap?

**Recommendation:** Make them complementary. The ESLint plugin is great for editor feedback and pre-commit hooks. Our framework is great for test suites and CI. The immoui preset can include both: use ESLint for real-time linting, and our rules for structural/metatest validation. Our architecture rule can optionally generate an ESLint config.

---

## Appendix: Comparing Before and After

### Before (Current immoui)

```typescript
// src/__tests__/architecture.test.ts — 120 lines
// src/__tests__/component-coverage.test.ts — 200 lines
// src/__tests__/test-quality.test.ts — 250 lines
// src/__tests__/sdk-convention.test.ts — 180 lines
// src/__tests__/sdk-hook-pairs.test.ts — 80 lines
// src/__tests__/sdk-query-options.test.ts — 150 lines
// src/__tests__/sdk-mutation-invalidation.test.ts — 120 lines
// src/__tests__/sdk-types.test.ts — 100 lines
// src/__tests__/component-data-fetching.test.ts — 60 lines
// src/__tests__/route-data-fetching.test.ts — 120 lines
// src/__tests__/route-pages.test.ts — 100 lines
// src/__tests__/i18n-raw-strings.test.ts — 120 lines
// src/__tests__/storybook-grouping.test.ts — 60 lines
// src/__tests__/relative-imports.test.ts — 60 lines
// 
// Total: ~1,700 lines of duplicated structural test logic
// Each test imports glob, fs, path, ts, has its own AST traversal
```

### After (With Framework)

```typescript
// quality-assurance.config.ts — 80 lines
// src/__tests__/quality.test.ts — 5 lines
//
// Total: 85 lines of declarative configuration
// All rules reuse the same primitives (cached AST, cached file listings)
```

**The framework reduces structural test code by 95% while making it reusable, configurable, and type-safe.**

---

## Next Steps

1. **Review this plan** — Does the scope, architecture, and priorities align with your vision?
2. **Approve or modify** — Any changes to the philosophy, primitives, or built-in rules?
3. **Start Phase 1** — I can begin implementing the core engine and first three rules.

This plan is designed to be a living document. As we build, we will refine the API and add rules based on real-world usage.
