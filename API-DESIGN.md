# Quality Assurance Framework — API Design v2

> **Status:** Draft for review | **Scope:** Complete API redesign based on prior art research

---

## Table of Contents

1. [Philosophy Change](#1-philosophy-change)
2. [What We Learned from Prior Art](#2-what-we-learned-from-prior-art)
3. [The New API Design](#3-the-new-api-design)
4. [Core Concepts](#4-core-concepts)
5. [Primitive Checks](#5-primitive-checks)
6. [Composing Rules](#6-composing-rules)
7. [Language-Specific Subpackages](#7-language-specific-subpackages)
8. [Auto-Detection](#8-auto-detection)
9. [Full Examples](#9-full-examples)
10. [Comparison: Old vs New](#10-comparison-old-vs-new)
11. [Open Questions for Review](#11-open-questions-for-review)

---

## 1. Philosophy Change

### The Old Approach (Monolithic)

```typescript
import { rules } from '@qa/core';

rules.componentCoverage({
  componentPattern: 'src/**/*.tsx',
  requiredPairs: [
    { suffix: '.stories.tsx' },
    { suffix: '.test.tsx' },
  ],
});
```

**Problems:**
- One big rule that does many things
- Hard to customize (what if you want `.spec.tsx` instead of `.test.tsx`?)
- Can't combine with other checks
- Global `rules.` namespace
- Explicit `adapter: 'php'` is redundant

### The New Approach (Primitive + Composable)

```typescript
import { select, noImports, requireSibling } from '@qa/core';
import { testQuality } from '@qa/typescript';

select('src/**/*.tsx')
  .exclude('**/*.stories.tsx', '**/*.test.tsx')
  .check(requireSibling('.stories.tsx'))
  .check(requireSibling('.test.tsx'))
  .check(noImports('@tanstack/react-query'));
```

**Why this is better:**
- Each check is a small, reusable function
- Checks compose together arbitrarily
- No global namespace — import what you need
- Language auto-detected from file extension
- Language-specific packages are explicit (`@qa/typescript`)

---

## 2. What We Learned from Prior Art

### YASA (Ant Group)
- **Approach:** Unified AST (UAST) + JSON config files
- **Insight:** Declarative rule configs are powerful but inflexible
- **Lesson:** Don't use JSON for rules — use TypeScript functions
- **Lesson:** Checker-based architecture is good but needs better composability

### graphlens (Neko1313)
- **Approach:** Shared graph IR with language adapters as separate packages
- **Insight:** Adapters are pure data producers — they parse into a common graph
- **Lesson:** Separate packages per language is the right model (`graphlens-typescript`, `graphlens-php`)
- **Lesson:** Tree-sitter is the common parser for all non-TS languages

### Desloppify
- **Approach:** Plugin-based multi-language scanner
- **Insight:** LangConfig (immutable) + LangRun (mutable) separation is clean
- **Lesson:** Generic detectors + language-specific hooks = best of both worlds
- **Lesson:** Import direction discipline matters (`languages/` → `engine/`, never reversed)
- **Lesson:** Full plugins for deep language support, generic plugins for basic support

### tree-sitter-analyzer
- **Approach:** MCP server with tree-sitter for 13 languages
- **Insight:** Family-gated call graphs (language-specific call graph wiring)
- **Lesson:** Cross-language analysis is hard — each language needs its own resolution logic

### The Convergence

All four tools converge on the same architecture:

```
┌─────────────────────────┐
│    Rule Engine (core)    │
│  Language-agnostic         │
└─────────────────────────┘
           │
    ┌──────┴──────┬──────────┐
    ▼             ▼          ▼
┌────────┐  ┌──────────┐ ┌──────────┐
│  TS    │  │    PHP   │ │  Python  │
│Adapter │  │ Adapter  │ │ Adapter  │
│ts-morph│  │tree-sitter│ │tree-sitter│
└────────┘  └──────────┘ └──────────┘
```

**Our unique take:** The rule engine is not just a runner — it's a **composition toolkit**. Rules are built from small, reusable functions, not configured from big objects.

---

## 3. The New API Design

### 3.1 The Rule Type

```typescript
// A rule is just a function. No classes, no magic.
type Rule = (ctx: Context) => Violation[] | Promise<Violation[]>;

// A check is a function that examines a single file
type Check = (file: File) => Violation[] | null;

// A selector narrows which files to check
type Selector = {
  check(...checks: Check[]): Rule;
  forEach(fn: (file: File) => Violation[]): Rule;
  filter(fn: (file: File) => boolean): Selector;
  exclude(...patterns: string[]): Selector;
  include(...patterns: string[]): Selector;
};
```

### 3.2 The Entry Point

```typescript
import { select, defineConfig } from '@qa/core';

// select() returns a Selector
const rule: Rule = select('src/**/*.tsx')
  .check(/* ...checks */);

// defineConfig() accepts an array of rules
export default defineConfig({
  rules: [
    // Rules are just functions in an array
    rule1,
    rule2,
    rule3,
  ],
});
```

### 3.3 No Global Namespace

```typescript
// ❌ OLD — global namespace
import { rules } from '@qa/core';
rules.architecture({...});
rules.fileStructure({...});

// ✅ NEW — import specific functions
import { architecture, fileStructure } from '@qa/core';
import { testQuality } from '@qa/typescript';
import { noRawDb } from '@qa/php';

architecture({...});
fileStructure({...});
```

### 3.4 Auto-Detection

```typescript
// The framework auto-detects the adapter from the file extension
select('src/**/*.tsx');     // → TypeScript adapter (ts-morph)
select('app/**/*.php');     // → PHP adapter (tree-sitter-php)
select('src/**/*.py');      // → Python adapter (tree-sitter-python)
select('src/**/*.go');      // → Go adapter (tree-sitter-go)

// Mixed selection works too — each file gets its own adapter
select('src/**/*.{ts,tsx,php}');
```

---

## 4. Core Concepts

### 4.1 The File Object

```typescript
interface File {
  // Metadata
  path: string;           // Relative to project root
  absolutePath: string;
  name: string;
  ext: string;
  
  // Content
  content: string;
  
  // Lazy-loaded analysis (cached)
  imports: Import[];
  ast: AstNode;           // Adapter-specific AST node
  
  // Language
  language: string;       // 'typescript', 'php', 'python'
  adapter: LanguageAdapter;
  
  // Helpers
  sibling(suffix: string): File | null;
  resolveImport(path: string): string | null;
  
  // Pattern matching
  matches(pattern: string | RegExp): boolean;
  inFolder(pattern: string): boolean;
}
```

### 4.2 The Context Object

```typescript
interface Context {
  // Project
  projectRoot: string;
  tsConfigPath?: string;
  
  // File system
  files: File[];          // All files selected by the rule
  
  // Graph (lazy)
  graph: DependencyGraph;
  
  // Violation helper
  violation(file: File, message: string, options?: {
    line?: number;
    column?: number;
    context?: string;
  }): Violation;
}
```

### 4.3 The Violation Object

```typescript
interface Violation {
  rule: string;           // Rule name (auto-inferred from function name)
  message: string;
  path: string;
  line?: number;
  column?: number;
  context?: string;
  severity?: 'error' | 'warn' | 'info';
}
```

---

## 5. Primitive Checks

Primitive checks are the building blocks. They work with any language.

### 5.1 File System Checks

```typescript
import { requireSibling, forbidSibling, requireFile, forbidFile } from '@qa/core';

// Check that a sibling file exists
requireSibling('.stories.tsx');
requireSibling('.test.tsx');
requireSibling('Factory.php', { 
  transform: (path) => path.replace('Models/', 'Factories/').replace('.php', 'Factory.php')
});

// Check that a sibling file does NOT exist
forbidSibling('.backup');

// Check that a specific file exists anywhere
requireFile('src/index.ts');

// Check that a specific pattern does NOT exist
forbidFile('src/**/tmp/**');
```

### 5.2 Import Checks

```typescript
import { noImports, requireImports, onlyImports } from '@qa/core';

// Forbid imports matching a pattern
noImports('@tanstack/react-query');
noImports('~/components/domains/*');       // no cross-domain imports
noImports('src/sdk/generated/**');        // no generated types

// Require imports (must import at least one of these)
requireImports('react', 'vue');

// Only allow imports from these sources
onlyImports('~/components/**', '~/lib/**');
```

### 5.3 AST Checks (Generic)

```typescript
import { noCalls, requireCalls, noNodes } from '@qa/core';

// Forbid function calls
noCalls('console.log');
noCalls('useQuery', 'useSuspenseQuery');
noCalls('DB::table', 'DB::raw');           // PHP

// Require function calls
requireCalls('__()');                      // PHP i18n

// Forbid AST node types
noNodes('function', { maxCount: 10 });     // max 10 functions per file
```

### 5.4 Text Pattern Checks

```typescript
import { noPattern, requirePattern } from '@qa/core';

// Forbid text patterns
noPattern('useState(');
noPattern('eval(');
noPattern('DB::table(');

// Require text patterns
requirePattern('declare(strict_types=1)');
```

### 5.5 Graph Checks

```typescript
import { noCycles, noDeadCode, noOrphans } from '@qa/core';

// Dependency graph checks
noCycles();                                // no circular dependencies
noDeadCode({ entryPoints: ['src/index.ts'] }); // no unreachable files
noOrphans();                               // no files with no dependents
```

### 5.6 Custom Checks

```typescript
import { check } from '@qa/core';

// Write your own check in 5 lines
const noHardcodedStrings = check((file) => {
  const strings = file.ast.findNodes('string');
  return strings
    .filter(s => s.isInJsx && !s.isInTranslateCall)
    .map(s => file.violation(s, 'Hardcoded string: use i18n'));
});
```

---

## 6. Composing Rules

### 6.1 The Select-Check Pattern

```typescript
import { select } from '@qa/core';

// Basic composition
const rule = select('src/**/*.tsx')
  .exclude('**/*.stories.tsx', '**/*.test.tsx')
  .check(
    requireSibling('.stories.tsx'),
    requireSibling('.test.tsx'),
    noImports('@tanstack/react-query'),
  );
```

### 6.2 The ForEach Pattern

```typescript
// For custom logic that doesn't fit a primitive
const rule = select('src/**/*.tsx')
  .forEach((file) => {
    const violations: Violation[] = [];
    
    // Check something specific
    if (file.content.includes('TODO:')) {
      violations.push(file.violation('TODO found in source'));
    }
    
    return violations;
  });
```

### 6.3 The Filter Pattern

```typescript
// Only check files that match a condition
const rule = select('src/**/*.tsx')
  .filter(file => file.name.includes('Component'))
  .check(requireSibling('.stories.tsx'));
```

### 6.4 Combining Multiple Selectors

```typescript
import { ruleSet } from '@qa/core';

// A ruleSet is just a Rule[]
const componentRules = ruleSet(
  select('src/**/*.tsx')
    .exclude('**/*.stories.tsx', '**/*.test.tsx')
    .check(requireSibling('.stories.tsx')),
  
  select('src/**/*.tsx')
    .exclude('**/*.stories.tsx', '**/*.test.tsx')
    .check(requireSibling('.test.tsx')),
);
```

### 6.5 Reusing Checks

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

## 7. Language-Specific Subpackages

### 7.1 The Package Structure

```
@qa/core          → primitives, select, file checks, import checks, graph checks
@qa/typescript    → TypeScript-specific: testQuality, tsConventions, tsxRules
@qa/php           → PHP-specific: noRawDb, laravelRules, psrConventions
@qa/python        → Python-specific: djangoRules, flake8Integration
@qa/go            → Go-specific: goConventions
```

### 7.2 TypeScript Subpackage

```typescript
import { testQuality, sdkConventions, noTsxErrors } from '@qa/typescript';

// Pre-built complex checks
const rule1 = select('src/**/*.test.tsx')
  .check(testQuality({ minScore: 50 }));

const rule2 = select('src/sdk/domains/**')
  .check(sdkConventions({
    requiredFiles: ['index.ts', 'interface.ts', 'http.ts', 'memory.ts'],
    hooks: {
      requirePairs: true,           // useX + useSuspenseX
      queryOptions: true,           // queryKey + queryFn + staleTime
      mutations: true,              // onMutate + onError + onSettled
    },
  }));

const rule3 = select('src/**/*.tsx')
  .check(noTsxErrors({ 
    forbidRawHtml: ['button', 'input', 'select'],
  }));
```

### 7.3 PHP Subpackage

```typescript
import { noRawDb, laravelConventions, psrCompliance } from '@qa/php';

const rule1 = select('app/Http/Controllers/**/*.php')
  .check(noRawDb());

const rule2 = select('app/**/*.php')
  .check(laravelConventions({
    models: 'app/Domains/*/Models/*.php',
    factories: 'database/factories/**/*.php',
    controllers: 'app/Http/Controllers/**/*.php',
    rules: {
      'models-have-factories': true,
      'controllers-use-requests': true,
    },
  }));

const rule3 = select('app/**/*.php')
  .check(psrCompliance({
    namespace: 'App',
    autoload: 'composer.json',
  }));
```

### 7.4 Why No `adapter` Parameter?

```typescript
// ❌ OLD — explicit adapter
phpNamespaceRules({
  pattern: 'app/**/*.php',
  adapter: 'php', // Redundant!
});

// ✅ NEW — import from subpackage, pattern auto-detects
import { noRawDb } from '@qa/php';

select('app/**/*.php')
  .check(noRawDb());

// The `@qa/php` import tells us the language
// The `.php` extension tells us the adapter
// No explicit adapter needed
```

---

## 8. Auto-Detection

### 8.1 Extension to Adapter Mapping

```typescript
const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.php': 'php',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

// Auto-detect from select() pattern
select('src/**/*.tsx'); // → typescript adapter
select('app/**/*.php'); // → php adapter
```

### 8.2 Project Root Detection

```typescript
// Auto-detect project type from root markers
const PROJECT_MARKERS: Record<string, string> = {
  'tsconfig.json': 'typescript',
  'package.json': 'typescript',
  'composer.json': 'php',
  'pyproject.toml': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
};

// The framework auto-detects the project type
// and loads the appropriate adapters
```

### 8.3 Multi-Project Repos

```typescript
import { defineConfig } from '@qa/core';

export default defineConfig({
  projects: [
    { name: 'frontend', path: 'frontend', language: 'typescript' },
    { name: 'backend', path: 'backend', language: 'php' },
  ],
  rules: [
    // Rules target specific projects
    select('frontend/src/**/*.tsx')
      .check(noImports('@tanstack/react-query')),
    
    select('backend/app/**/*.php')
      .check(noRawDb()),
  ],
});
```

---

## 9. Full Examples

### 9.1 immoui (TypeScript Frontend)

```typescript
// immoui/quality-assurance.config.ts
import { defineConfig, select, architecture, fileStructure } from '@qa/core';
import { requireSibling, noImports, noCalls, noPattern } from '@qa/core';
import { testQuality, sdkConventions } from '@qa/typescript';

export default defineConfig({
  rules: [
    // Architecture
    architecture({
      layers: [
        { name: 'lib', pattern: 'src/lib/**', imports: [] },
        { name: 'sdk', pattern: 'src/sdk/**', imports: ['lib'] },
        { name: 'ui', pattern: 'src/components/ui/**', imports: ['lib'] },
        { name: 'generic', pattern: 'src/components/generic/**', imports: ['ui', 'sdk', 'lib'] },
        { name: 'layout', pattern: 'src/components/layout/**', imports: ['generic', 'ui', 'sdk', 'lib'] },
        { name: 'domains', pattern: 'src/components/domains/*/**', imports: ['layout', 'generic', 'ui', 'sdk', 'lib'] },
        { name: 'bridges', pattern: 'src/components/domains/*/bridges/**', imports: ['domains', 'layout', 'generic', 'ui', 'sdk', 'lib'] },
        { name: 'routes', pattern: 'src/routes/**', imports: ['*'] },
      ],
    }),
    
    // File structure
    fileStructure({
      required: [
        { pattern: 'src/components/{domains,generic,layout}/*/index.ts' },
        { pattern: 'src/components/domains/*/pages/index.ts' },
        { pattern: 'src/sdk/domains/*/index.ts' },
        { pattern: 'src/sdk/domains/*/*/index.ts' },
      ],
      forbidden: [
        { pattern: 'src/components/domains/*/components/**', reason: 'Use pure/' },
        { pattern: 'src/routes/**/$tab.tsx', reason: 'Explicit tab routes only' },
      ],
    }),
    
    // No direct TanStack Query in components
    select('src/components/**/*.{ts,tsx}')
      .check(noImports('@tanstack/react-query'))
      .check(noCalls('useQuery', 'useSuspenseQuery')),
    
    // No direct TanStack Query in routes
    select('src/routes/**/*.tsx')
      .check(noImports('@tanstack/react-query'))
      .check(noPattern('useState(')),
    
    // Component coverage: every .tsx needs .stories.tsx and .test.tsx
    select('src/**/*.tsx')
      .exclude('**/*.stories.tsx', '**/*.test.tsx', 'src/components/ui/**')
      .check(requireSibling('.stories.tsx'))
      .check(requireSibling('.test.tsx')),
    
    // Test quality
    select('src/**/*.test.tsx')
      .check(testQuality({ minScore: 50 })),
    
    // i18n: no raw strings
    select('src/components/**/*.tsx')
      .check(noPattern('label=', 'placeholder=', 'title=')), // raw props
    
    // SDK conventions
    select('src/sdk/domains/**/hooks/*.ts')
      .check(sdkConventions({
        requirePairs: true,
        queryOptions: true,
        mutations: true,
      })),
    
    // No generated types outside SDK
    select('src/**/*.{ts,tsx}')
      .exclude('src/sdk/**')
      .check(noImports('~/sdk/generated')),
    
    // No HTML in route files
    select('src/routes/**/*.tsx')
      .check(noPattern('<div', '<span', '<h1')),
    
    // No local components in routes
    select('src/routes/**/*.tsx')
      .check(noPattern('function *Route*')), // heuristic
  ],
});
```

### 9.2 immocore (PHP Backend)

```typescript
// immocore/quality-assurance.config.ts
import { defineConfig, select, architecture, fileStructure } from '@qa/core';
import { requireSibling, noImports, noCalls } from '@qa/core';
import { noRawDb, laravelConventions } from '@qa/php';

export default defineConfig({
  rules: [
    // Architecture
    architecture({
      layers: [
        { name: 'support', pattern: 'app/Support/**', imports: [] },
        { name: 'domains', pattern: 'app/Domains/*/**', imports: ['support'] },
        { name: 'http', pattern: 'app/Http/**', imports: ['domains', 'support'] },
        { name: 'providers', pattern: 'app/Providers/**', imports: ['domains', 'support'] },
        { name: 'routes', pattern: 'routes/**', imports: ['http', 'domains', 'support'] },
      ],
    }),
    
    // File structure
    fileStructure({
      required: [
        { pattern: 'app/Domains/*/index.php' },
      ],
      forbidden: [
        { pattern: 'app/Http/Controllers/**/components/**', reason: 'Use views/' },
      ],
    }),
    
    // No cross-domain imports in PHP
    select('app/Domains/*/*.php')
      .check(noImports('App\\Domains\\')), // regex
    
    // No raw DB in controllers
    select('app/Http/Controllers/**/*.php')
      .check(noRawDb())
      .check(noCalls('DB::table', 'DB::raw')),
    
    // Laravel conventions
    select('app/**/*.php')
      .check(laravelConventions({
        models: 'app/Domains/*/Models/*.php',
        factories: 'database/factories/**/*.php',
        rules: {
          'models-have-factories': true,
        },
      })),
    
    // Models must have factories
    select('app/Domains/*/Models/*.php')
      .check(requireSibling('Factory.php', {
        transform: (path) => path
          .replace('Models/', 'Factories/')
          .replace('.php', 'Factory.php')
      })),
    
    // i18n: all strings must use __()
    select('app/**/*.php')
      .check(noCalls('echo', 'print')), // require __() instead
    
    // Strict types
    select('app/**/*.php')
      .check(noPattern('declare(strict_types=1)')), // require it
  ],
});
```

### 9.3 Monorepo (Both)

```typescript
// root/quality-assurance.config.ts
import { defineConfig, select, architecture } from '@qa/core';
import { requireSibling, noImports, noCalls } from '@qa/core';
import { testQuality } from '@qa/typescript';
import { noRawDb } from '@qa/php';

export default defineConfig({
  projects: [
    { name: 'frontend', path: 'immoui', language: 'typescript' },
    { name: 'backend', path: 'brave-tiger', language: 'php' },
  ],
  
  rules: [
    // Frontend rules
    select('immoui/src/**/*.tsx')
      .check(noImports('@tanstack/react-query'))
      .check(requireSibling('.stories.tsx'))
      .check(requireSibling('.test.tsx')),
    
    select('immoui/src/**/*.test.tsx')
      .check(testQuality({ minScore: 50 })),
    
    // Backend rules
    select('brave-tiger/app/Http/Controllers/**/*.php')
      .check(noRawDb()),
    
    select('brave-tiger/app/Domains/*/Models/*.php')
      .check(requireSibling('Factory.php', {
        transform: (p) => p.replace('Models/', 'Factories/').replace('.php', 'Factory.php')
      })),
    
    // Cross-project rules
    // No orphaned API endpoints
    // No unused frontend routes
  ],
});
```

---

## 10. Comparison: Old vs New

### The Component Coverage Rule

```typescript
// ❌ OLD — one big monolithic rule
rules.componentCoverage({
  componentPattern: 'src/**/*.tsx',
  requiredPairs: [
    { suffix: '.stories.tsx' },
    { suffix: '.test.tsx' },
  ],
  exclusions: [
    'src/components/ui/**',
    'src/routes/**',
  ],
});

// ✅ NEW — composed from primitives
select('src/**/*.tsx')
  .exclude('**/*.stories.tsx', '**/*.test.tsx', 'src/components/ui/**')
  .check(requireSibling('.stories.tsx'))
  .check(requireSibling('.test.tsx'));
```

### The SDK Convention Rule

```typescript
// ❌ OLD — massive configuration object
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
});

// ✅ NEW — composed from smaller checks
import { sdkConventions } from '@qa/typescript';

select('src/sdk/domains/**')
  .check(sdkConventions({
    requiredFiles: ['index.ts', 'interface.ts', 'http.ts', 'memory.ts', 'types.ts', 'fakes.ts'],
    hooks: {
      requiredFiles: ['index.ts', 'queries.ts'],
      forbiddenFiles: ['query-keys.ts', 'query-options.ts', 'hooks.ts'],
    },
    queryPairs: true,
    queryOptions: true,
    mutations: true,
  }));
```

### The Route Discipline Rule

```typescript
// ❌ OLD — many boolean flags
rules.routes({
  pattern: 'src/routes/**/*.tsx',
  forbidHtml: true,
  forbidUseState: true,
  forbidDirectImports: ['@tanstack/react-query'],
  requireQueryOptions: true,
  forbidLocalComponents: true,
});

// ✅ NEW — composed primitives
select('src/routes/**/*.tsx')
  .check(noPattern('<div', '<span', '<h1', '<section'))
  .check(noPattern('useState('))
  .check(noImports('@tanstack/react-query'))
  .check(noPattern('function *Route*'));
```

---

## 11. Open Questions for Review

### Q1: Should `select()` accept multiple patterns?

```typescript
// Option A: single pattern
select('src/**/*.tsx');

// Option B: multiple patterns
select('src/**/*.tsx', 'src/**/*.ts');

// Option C: array
select(['src/**/*.tsx', 'src/**/*.ts']);
```

### Q2: Should checks be pipe-able or variadic?

```typescript
// Option A: variadic .check()
select('src/**/*.tsx')
  .check(check1, check2, check3);

// Option B: chained .check()
select('src/**/*.tsx')
  .check(check1)
  .check(check2)
  .check(check3);

// Option C: both (variadic + chainable)
select('src/**/*.tsx')
  .check(check1, check2)
  .check(check3);
```

### Q3: How should custom checks access the AST?

```typescript
// Option A: file.ast is a generic node
file.ast.findNodes('call');

// Option B: file.ast is language-specific
// TypeScript: file.tsAst.getFunctions()
// PHP: file.phpAst.getFunctions()

// Option C: both (generic + typed)
file.ast.findNodes('call'); // generic
file.ts?.getFunctions();     // typed, if available
```

### Q4: Should the framework provide a `pipe()` helper?

```typescript
// Option A: explicit pipe
import { pipe, select, check, filter } from '@qa/core';

const rule = pipe(
  select('src/**/*.tsx'),
  filter(f => f.name.includes('Component')),
  check(requireSibling('.stories.tsx')),
);

// Option B: method chaining (current design)
const rule = select('src/**/*.tsx')
  .filter(f => f.name.includes('Component'))
  .check(requireSibling('.stories.tsx'));
```

### Q5: How should the framework handle exemptions/baselines?

```typescript
// Option A: inline in rule
select('src/**/*.tsx')
  .exclude('src/legacy/**')
  .check(...);

// Option B: global exemptions
export default defineConfig({
  exemptions: [
    { path: 'src/legacy/**', reason: 'Legacy code' },
  ],
  rules: [...],
});

// Option C: both
```

### Q6: Should there be a `presets` concept?

```typescript
// Option A: presets as functions
import { immouiPreset } from '@qa/presets';

export default defineConfig({
  rules: immouiPreset({ root: 'src' }),
});

// Option B: presets as rule sets
import { preset } from '@qa/core';

export default defineConfig({
  rules: preset.immoui({ root: 'src' }),
});

// Option C: no presets, just examples in docs
```

### Q7: How should the framework handle test runner integration?

```typescript
// Option A: auto-generated tests
import { defineQualityTests } from '@qa/vitest';
import config from './quality-assurance.config';

defineQualityTests(config); // Auto-generates describe/it blocks

// Option B: single test
import { run } from '@qa/vitest';
import config from './quality-assurance.config';

it('passes all QA rules', async () => {
  await run(config);
});

// Option C: both
```

### Q8: How should language-specific packages be structured?

```typescript
// Option A: flat exports
import { testQuality, sdkConventions } from '@qa/typescript';

// Option B: namespaced
import { ts } from '@qa/typescript';
ts.testQuality({...});
ts.sdkConventions({...});

// Option C: both
import { testQuality } from '@qa/typescript';
import { ts } from '@qa/typescript';
ts.testQuality === testQuality; // same function
```

---

## Summary

The new API is:

1. **Primitive** — checks are small, reusable functions
2. **Composable** — checks combine with `.check()` and `.forEach()`
3. **No global namespace** — import specific functions
4. **Language-specific subpackages** — `@qa/typescript`, `@qa/php`
5. **Auto-detection** — adapters inferred from file extensions
6. **No explicit adapter parameter** — redundant with imports + extensions
7. **Declarative but flexible** — TypeScript functions, not JSON config

The framework becomes a **composition toolkit** rather than a **configuration framework**. Users build rules by composing small primitives, rather than filling in large configuration objects.

---

*Ready for review. Feedback wanted on the 8 open questions and the overall API design.*
