# Language-Agnostic Architecture Analysis

> **Question:** Can the quality assurance framework be language-agnostic, so it can test PHP, Python, and TypeScript projects with the same rule engine and configuration format?

**Answer:** Yes — but with a specific, carefully bounded definition of "language-agnostic." This document explains the analysis, the architecture, and the pragmatic trade-offs.

---

## Table of Contents

1. [The Core Insight](#1-the-core-insight)
2. [What "Language-Agnostic" Means (And Doesn't Mean)](#2-what-language-agnostic-means-and-doesnt-mean)
3. [Prior Art: Multi-Language Static Analysis](#3-prior-art-multi-language-static-analysis)
4. [The Technical Architecture](#4-the-technical-architecture)
5. [What Is Already Language-Agnostic](#5-what-is-already-language-agnostic)
6. [What Needs Language-Specific Adapters](#6-what-needs-language-specific-adapters)
7. [The Adapter Interface](#7-the-adapter-interface)
8. [Cross-Language Rules vs. Language-Specific Rules](#8-cross-language-rules-vs-language-specific-rules)
9. [The PHP / immocore Use Case](#9-the-php--immocore-use-case)
10. [Feasibility Assessment](#10-feasibility-assessment)
11. [Implementation Strategy](#11-implementation-strategy)
12. [Open Questions](#12-open-questions)

---

## 1. The Core Insight

> **The rule engine is language-agnostic. The analysis primitives are language-specific. Rules are written against primitives, not against raw ASTs.**

This is the key architectural decision that makes everything work.

If we design the framework as:

```
┌─────────────────────────────────────┐
│         Rule Engine (agnostic)       │  ← Pure functions, no language knowledge
│    Context → Rule[] → Violation[]    │
└─────────────────────────────────────┘
                   │
                   │ uses
                   ▼
┌─────────────────────────────────────┐
│    Language-Specific Adapter       │  ← Provides primitives for one language
│  - FileSystem (already universal)  │
│  - AstAnalyzer (ts-morph / php-parser) │
│  - ImportAnalyzer (language-specific) │
│  - PatternMatcher (already universal) │
└─────────────────────────────────────┘
```

Then we get the best of both worlds:
- **One config format** for all projects
- **One test runner integration** for all projects
- **One reporting format** for all projects
- **One rule engine** for all projects
- **Language-specific analysis** that is accurate and powerful

---

## 2. What "Language-Agnostic" Means (And Doesn't Mean)

### What It DOES Mean

- ✅ **One rule engine** runs rules for TypeScript, PHP, Python, Go, etc.
- ✅ **One configuration file** declares rules for a multi-language repo
- ✅ **One test suite** validates all languages
- ✅ **One CI command** checks the entire codebase
- ✅ **Shared structural rules** work across languages (file structure, naming, dependencies)
- ✅ **Shared reporting format** (same violation structure, same error messages)

### What It DOES NOT Mean

- ❌ **One AST query language** that works identically across all languages (this is a research project, not a product)
- ❌ **Universal AST representation** (UAST) — mapping Python's `def` to TypeScript's `function` to PHP's `function` is lossy and complex
- ❌ **One rule that works in all languages** — a rule checking "no direct useQuery calls" is meaningless in PHP
- ❌ **No language-specific knowledge** — a PHP rule needs to know about Laravel, a TypeScript rule needs to know about React

### The Correct Mental Model

> **The framework is polyglot, not universal.**

It supports multiple languages through adapters, but rules are still written for specific languages. The framework provides the **infrastructure**; the adapters provide the **language analysis**; the rules provide the **domain knowledge**.

---

## 3. Prior Art: Multi-Language Static Analysis

### Research Findings

| Tool | Approach | Strengths | Weaknesses | Our Takeaway |
|------|----------|-----------|------------|--------------|
| **YASA (Ant Group)** | Unified Abstract Syntax Tree (UAST) — normalizes multiple languages into one IR | Academic rigor, handles taint analysis across languages | Research project, 287 stars, limited language support, TypeScript implementation | **UAST is possible but overkill.** We don't need semantic normalization, just structural analysis. |
| **tree-sitter + ctsq** | tree-sitter parses 100+ languages; ctsq maps grammar-specific nodes to abstract types (function, class, variable) | Mature parser ecosystem, consistent API, fast | Node names are still language-specific; mapping is incomplete; no type information | **Best primitive for parsing.** We should use tree-sitter as an optional parser backend. |
| **graphlens** | Parses multiple languages into a shared graph IR (nodes = files, symbols, types; edges = imports, calls, inheritance) | Polyglot dependency graph, dead-code detection | Graph-level only, no AST-level rules | **Good for dependency rules.** We can use this approach for cross-language import analysis. |
| **Metastatic** | Three-layer MetaAST: surface AST (language-specific), meta AST (language-agnostic), semantic graph | Theoretical purity, mutation testing across languages | 3 stars, academic, not production-ready | **Too complex.** Three layers of abstraction is overkill for our use case. |
| **CodeCraft** | Unified API for code generation across PHP, JS, CSS, JSON | Practical, path-based API | Code generation, not analysis | **Inspiration for API design.** Simple path-based interfaces are good. |
| **LiSA** | Language-agnostic static analysis for Java-like languages (Java, Go, PHP, Rust) | CFG, pointer analysis, taint analysis | Java-centric, not easily extensible | **Analysis depth is hard.** Our rules are structural, not semantic. |
| **Rigour** | Hybrid validation engine: native structural analysis + universal AST parsing | Enterprise-grade, multi-language | Commercial, closed-source | **Validation:** The market wants this. |
| **Desloppify** | Plugin-based architecture: generic detectors + language-specific parsers + LLM review | Clean separation of concerns | New, unproven | **Architecture validation:** Our plugin-based approach is correct. |

### Key Research Conclusion

**The industry is actively pursuing multi-language static analysis, but no one has solved the "universal AST" problem in a practical way.** The successful approaches (tree-sitter, graphlens) don't try to unify ASTs — they unify at a higher level (graphs, or provide consistent APIs across different parsers).

**Our approach should be: don't unify the AST, unify the framework.**

---

## 4. The Technical Architecture

### 4.1 Multi-Adapter Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     QUALITY ASSURANCE FRAMEWORK                   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    RULE ENGINE (Language-Agnostic)          │ │
│  │                                                             │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │ │
│  │  │   Config    │  │   Runner    │  │  Reporter   │            │ │
│  │  │   Loader    │  │             │  │             │            │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘            │ │
│  │                                                             │ │
│  │  Rule: Context → Violation[]                                 │ │
│  │  Context: { project, adapter, cache, helpers }              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│                              │ uses                                │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              LANGUAGE ADAPTER (Language-Specific)             │ │
│  │                                                             │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │ │
│  │  │  AstAnalyzer │ │ ImportAnalyzer│ │  TypeResolver│         │ │
│  │  │  (ts-morph)  │ │  (ts-morph)   │ │  (ts-morph)  │         │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘         │ │
│  │                                                             │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │ │
│  │  │  AstAnalyzer │ │ ImportAnalyzer│ │  TypeResolver│         │ │
│  │  │ (tree-sitter)│ │ (tree-sitter) │ │ (tree-sitter)│         │ │
│  │  │   for PHP    │ │    for PHP    │ │    for PHP   │         │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘         │ │
│  │                                                             │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │ │
│  │  │  AstAnalyzer │ │ ImportAnalyzer│ │  TypeResolver│         │ │
│  │  │ (tree-sitter)│ │ (tree-sitter) │ │ (tree-sitter)│         │ │
│  │  │  for Python  │ │  for Python   │ │  for Python  │         │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│                              │ uses                                │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              FILE SYSTEM PRIMITIVES (Universal)              │ │
│  │                                                             │ │
│  │  - fast-glob (file walking)                                 │ │
│  │  - fs (reading files)                                       │ │
│  │  - path (path manipulation)                                 │ │
│  │  - micromatch (glob matching)                               │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 The RuleContext is Adapter-Based

```typescript
// The rule doesn't know which language it's analyzing
interface Rule {
  name: string;
  languages: string[]; // ['typescript', 'php'] — which adapters this rule needs
  check: (ctx: RuleContext) => Violation[] | Promise<Violation[]>;
}

// The context is built from the project's adapters
interface RuleContext {
  // Universal (all languages)
  fs: FileSystem;
  patterns: PatternMatcher;
  project: ProjectConfig;
  
  // Language-specific (accessed by language name)
  for(language: string): LanguageContext;
  
  // Helper for multi-language projects
  allLanguages(): string[];
}

interface LanguageContext {
  ast: AstAnalyzer;
  imports: ImportAnalyzer;
  types: TypeResolver;
  graph: DependencyGraph;
}
```

---

## 5. What Is Already Language-Agnostic

### 5.1 File System Operations

These are truly universal. They work for any language:

- ✅ File existence (`existsSync`)
- ✅ File listing (`glob`)
- ✅ File naming (`matchGlob`, `matchRegex`)
- ✅ Folder structure (`inFolder`, `hasChildren`)
- ✅ File size, modification time

**Example rule (works for all languages):**
```typescript
rules.fileStructure({
  required: [
    { pattern: 'src/**/index.{ts,php,py}' },
  ],
  forbidden: [
    { pattern: 'src/**/tmp/**' },
  ],
});
```

### 5.2 Dependency Graphs

At the file level, dependencies are language-agnostic:

- ✅ File A imports file B
- ✅ Circular dependencies between files
- ✅ Dead code (files with no dependents)
- ✅ Entry point reachability

**Example rule (works for all languages):**
```typescript
rules.noCircularDependencies({
  pattern: 'src/**/*.ts', // or 'src/**/*.php', 'src/**/*.py'
});
```

### 5.3 Naming Conventions

- ✅ File naming patterns (`*.Controller.php`, `*.service.ts`, `*_test.py`)
- ✅ Folder naming conventions
- ✅ Class/function naming (via regex on file content or AST)

### 5.4 Required / Forbidden Patterns

- ✅ No files matching a pattern should exist
- ✅ All files matching a pattern must exist
- ✅ Files must contain required patterns (text-level)

---

## 6. What Needs Language-Specific Adapters

### 6.1 AST Analysis

Each language has a different AST structure:

| Language | Parser | AST Nodes | Unique Features |
|----------|--------|-----------|----------------|
| **TypeScript** | ts-morph / tree-sitter | `FunctionDeclaration`, `CallExpression`, `JsxElement` | JSX, generics, decorators, interfaces |
| **PHP** | tree-sitter-php / php-parser | `function_definition`, `method_declaration`, `call_expression` | Namespaces, traits,魔术方法, `use` imports |
| **Python** | tree-sitter-python / astroid | `function_definition`, `class_definition`, `call` | Indentation-based, decorators, list comprehensions |
| **Go** | tree-sitter-go | `function_declaration`, `call_expression` | Interfaces, goroutines, channels |
| **Rust** | tree-sitter-rust | `function_item`, `call_expression` | Lifetimes, macros, traits |

**The adapter's job:** Normalize these to a common interface for the rule's needs.

### 6.2 Import Resolution

Each language resolves imports differently:

- **TypeScript:** `import { X } from './foo'` → resolves via tsconfig paths, node_modules
- **PHP:** `use App\Domains\Estate\Services\EstateService;` → resolves via PSR-4 autoloading, composer
- **Python:** `from app.domains.estate import EstateService` → resolves via PYTHONPATH, package structure
- **Go:** `import "github.com/user/pkg"` → resolves via GOPATH, go modules

**The adapter's job:** Extract imports and resolve them to file paths.

### 6.3 Type Systems

- **TypeScript:** Structural types, generics, union types, interfaces
- **PHP:** Nominal types, class hierarchy, interfaces, traits
- **Python:** Duck typing (until type hints), `typing` module
- **Go:** Structural interfaces, no generics (until 1.18)

**The adapter's job:** Provide type information if needed by rules.

### 6.4 Language-Specific Constructs

- **TypeScript:** JSX, `useState`, `useQuery`, `interface`, `type`, `enum`
- **PHP:** `class`, `trait`, `namespace`, `use`, `__construct`, `extends`
- **Python:** `def`, `class`, `async def`, `with`, decorators, `__init__`
- **Go:** `func`, `struct`, `interface`, `chan`, `go` keyword

**The adapter's job:** Allow rules to query these constructs.

---

## 7. The Adapter Interface

### 7.1 Design Philosophy

The adapter interface is **intentionally minimal**. It doesn't try to capture every language feature. It captures the 80% of features that 80% of rules need.

```typescript
// Core adapter interface — every language adapter implements this
interface LanguageAdapter {
  readonly name: string;
  readonly extensions: string[]; // ['.ts', '.tsx']
  
  // Parse a file into an AST
  parse(path: string): AstNode;
  
  // Find nodes matching a query
  findNodes(ast: AstNode, query: NodeQuery): AstNode[];
  
  // Extract imports from a file
  getImports(path: string): ImportInfo[];
  
  // Resolve an import path to an absolute file path
  resolveImport(from: string, importPath: string): string | null;
  
  // Get the text of a node
  getText(node: AstNode): string;
  
  // Get line and column of a node
  getLocation(node: AstNode): { line: number; column: number };
  
  // Check if a node is of a given type
  is(node: AstNode, type: NodeType): boolean;
}

// The query language is abstract, not grammar-specific
interface NodeQuery {
  // Node types are abstracted where possible
  type?: NodeType | NodeType[];
  text?: string | RegExp;
  hasChild?: NodeQuery;
  hasParent?: NodeQuery;
  
  // Language-specific node types can be used too
  grammarType?: string; // e.g., 'jsx_element' for TS, 'function_definition' for PHP
}

// Abstract node types (common across languages)
type NodeType = 
  | 'function'        // function, method, def, func
  | 'class'           // class, struct, interface
  | 'call'            // function call, method call
  | 'variable'        // variable declaration, assignment
  | 'import'          // import, use, from, include
  | 'export'          // export, return, public
  | 'comment'         // //, /*, #, <!--
  | 'string'          // string literal
  | 'jsx'             // JSX/Blade/template element
  | 'type'            // type annotation, type hint, interface
  ;
```

### 7.2 TypeScript Adapter

```typescript
class TypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'];
  
  private project: Project; // ts-morph
  
  parse(path: string): AstNode {
    return this.project.getSourceFile(path);
  }
  
  findNodes(ast: AstNode, query: NodeQuery): AstNode[] {
    // Map abstract NodeType to ts-morph SyntaxKind
    const kind = this.mapNodeType(query.type);
    return ast.getDescendantsOfKind(kind);
  }
  
  getImports(path: string): ImportInfo[] {
    const file = this.project.getSourceFile(path);
    return file.getImportDeclarations().map(imp => ({
      source: imp.getModuleSpecifierValue(),
      resolved: this.resolveImport(path, imp.getModuleSpecifierValue()),
      // ...
    }));
  }
  
  resolveImport(from: string, importPath: string): string | null {
    // Use ts-morph's module resolution
    const resolved = this.project.resolveSourceFileDependencies();
    // ...
  }
  
  is(node: AstNode, type: NodeType): boolean {
    switch (type) {
      case 'function': return node.isKind(SyntaxKind.FunctionDeclaration);
      case 'class': return node.isKind(SyntaxKind.ClassDeclaration);
      case 'call': return node.isKind(SyntaxKind.CallExpression);
      // ...
    }
  }
}
```

### 7.3 PHP Adapter (using tree-sitter-php)

```typescript
class PhpAdapter implements LanguageAdapter {
  readonly name = 'php';
  readonly extensions = ['.php'];
  
  private parser: Parser; // tree-sitter
  
  parse(path: string): AstNode {
    const source = fs.readFileSync(path, 'utf-8');
    return this.parser.parse(source);
  }
  
  findNodes(ast: AstNode, query: NodeQuery): AstNode[] {
    // Use tree-sitter query API
    const grammarType = this.mapNodeType(query.type);
    return this.queryTree(ast, grammarType);
  }
  
  getImports(path: string): ImportInfo[] {
    const ast = this.parse(path);
    // PHP imports are `use` statements and `include`/`require`
    const useStatements = this.findNodes(ast, { grammarType: 'use_statement' });
    const includes = this.findNodes(ast, { grammarType: 'include_expression' });
    // Map to ImportInfo
    return [...useStatements, ...includes].map(node => ({
      source: this.extractImportPath(node),
      resolved: this.resolveImport(path, this.extractImportPath(node)),
      // ...
    }));
  }
  
  resolveImport(from: string, importPath: string): string | null {
    // Use PSR-4 autoloading rules from composer.json
    // Map namespace to folder
    // ...
  }
  
  is(node: AstNode, type: NodeType): boolean {
    switch (type) {
      case 'function': return node.type === 'function_definition';
      case 'class': return node.type === 'class_declaration';
      case 'call': return node.type === 'function_call_expression';
      // ...
    }
  }
}
```

### 7.4 Python Adapter (using tree-sitter-python)

```typescript
class PythonAdapter implements LanguageAdapter {
  readonly name = 'python';
  readonly extensions = ['.py'];
  
  private parser: Parser;
  
  parse(path: string): AstNode {
    const source = fs.readFileSync(path, 'utf-8');
    return this.parser.parse(source);
  }
  
  getImports(path: string): ImportInfo[] {
    const ast = this.parse(path);
    // Python imports: `import x`, `from x import y`
    const imports = this.findNodes(ast, { grammarType: 'import_statement' });
    const fromImports = this.findNodes(ast, { grammarType: 'import_from_statement' });
    // ...
  }
  
  resolveImport(from: string, importPath: string): string | null {
    // Use PYTHONPATH and package structure
    // Map `app.domains.estate` to `app/domains/estate.py` or `app/domains/estate/__init__.py`
    // ...
  }
}
```

---

## 8. Cross-Language Rules vs. Language-Specific Rules

### 8.1 Cross-Language Rules (Already Universal)

These rules work with any adapter because they only use the file system and dependency graph:

```typescript
// architecture rule — works for any language
rules.architecture({
  layers: [
    { name: 'lib', pattern: 'src/lib/**', allowedImports: [] },
    { name: 'domains', pattern: 'src/domains/*/**', allowedImports: ['lib'] },
    { name: 'routes', pattern: 'src/routes/**', allowedImports: ['*'] },
  ],
});

// file structure rule — works for any language
rules.fileStructure({
  required: [
    { pattern: 'src/**/index.{ts,php,py}' },
  ],
  forbidden: [
    { pattern: 'src/**/components/**' },
  ],
});

// component coverage rule — works for any language
rules.componentCoverage({
  componentPattern: 'src/**/*.{tsx,vue,php,py}', // any language
  requiredPairs: [
    { suffix: '.test.tsx' },      // TypeScript
    { suffix: '.spec.php' },      // PHP
    { suffix: '_test.py' },       // Python
  ],
});

// dependency graph rules — works for any language
rules.noCircularDependencies({
  pattern: 'src/**/*.{ts,php,py}',
});

rules.noDeadCode({
  pattern: 'src/**/*.{ts,php,py}',
});
```

### 8.2 Language-Specific Rules (Require Adapter)

These rules need language-specific knowledge and are written for a specific adapter:

```typescript
// TypeScript-specific rules
rules.noDirectTanstackQuery({
  pattern: 'src/**/*.tsx',
  adapter: 'typescript', // explicit adapter
});

rules.sdkConventions({
  basePath: 'src/sdk',
  adapter: 'typescript',
});

rules.reactComponentRules({
  pattern: 'src/**/*.tsx',
  adapter: 'typescript',
});

// PHP-specific rules
rules.laravelControllerRules({
  pattern: 'app/Http/Controllers/**/*.php',
  adapter: 'php',
});

rules.noRawEloquentInControllers({
  pattern: 'app/Http/Controllers/**/*.php',
  adapter: 'php',
});

rules.phpNamespaceRules({
  pattern: 'app/**/*.php',
  adapter: 'php',
});

// Python-specific rules
rules.noRawSqlInViews({
  pattern: '**/views.py',
  adapter: 'python',
});

rules.djangoModelRules({
  pattern: '**/models.py',
  adapter: 'python',
});
```

### 8.3 Multi-Language Rules (One Rule, Multiple Adapters)

Some rules can be written to work across multiple languages by using the abstract NodeType:

```typescript
// Works for any language that has functions and calls
rules.noConsoleLog({
  pattern: 'src/**/*.{ts,php,py}', // multiple languages
  forbiddenCalls: ['console.log', 'var_dump', 'print'],
  adapters: ['typescript', 'php', 'python'],
});

// The adapter resolves the forbidden call to the correct AST node:
// - TypeScript: `console.log` → CallExpression with identifier 'console.log'
// - PHP: `var_dump` → function_call_expression with name 'var_dump'
// - Python: `print` → call with function 'print'
```

**How this works:** The rule defines the semantic intent ("no debug output"), and the adapter maps it to the language-specific syntax.

---

## 9. The PHP / immocore Use Case

This is the most compelling use case. Let's design what immocore rules would look like:

### 9.1 immocore PHP Architecture

```typescript
// quality-assurance.config.ts
import { defineConfig } from '@immocore/quality-assurance';

export default defineConfig({
  project: './tsconfig.json', // TypeScript frontend
  adapters: ['typescript', 'php'], // enable both
  
  rules: [
    // === TypeScript Rules (immoui) ===
    rules.architecture({
      layers: [
        { name: 'lib', pattern: 'immoui/src/lib/**', allowedImports: [] },
        { name: 'sdk', pattern: 'immoui/src/sdk/**', allowedImports: ['lib'] },
        { name: 'ui', pattern: 'immoui/src/components/ui/**', allowedImports: ['lib'] },
        { name: 'domains', pattern: 'immoui/src/components/domains/*/**', allowedImports: ['ui', 'sdk', 'lib'] },
        { name: 'routes', pattern: 'immoui/src/routes/**', allowedImports: ['*'] },
      ],
    }),
    
    rules.sdkConventions({
      basePath: 'immoui/src/sdk/domains',
      adapter: 'typescript',
    }),
    
    // === PHP Rules (immocore) ===
    rules.architecture({
      layers: [
        { name: 'support', pattern: 'app/Support/**', allowedImports: [] },
        { name: 'domains', pattern: 'app/Domains/*/**', allowedImports: ['support'] },
        { name: 'http', pattern: 'app/Http/**', allowedImports: ['domains', 'support'] },
        { name: 'providers', pattern: 'app/Providers/**', allowedImports: ['domains', 'support'] },
        { name: 'routes', pattern: 'routes/**', allowedImports: ['http', 'domains', 'support'] },
      ],
    }),
    
    rules.fileStructure({
      required: [
        { pattern: 'app/Domains/*/index.php' },
        { pattern: 'app/Domains/*/index.ts' }, // if using TypeScript in backend too
      ],
      forbidden: [
        { pattern: 'app/Http/Controllers/**/components/**', description: 'Use views/ or pure/' },
      ],
    }),
    
    rules.imports({
      rules: [
        {
          path: 'app/Domains/*/*.php',
          forbiddenImports: ['App\\Domains\\'], // no cross-domain imports in PHP
          description: 'Domains must not import from other domains',
        },
        {
          path: 'app/Http/Controllers/**/*.php',
          forbiddenPatterns: ['DB::', 'DB::table(', 'Eloquent\\'], // no raw DB in controllers
          description: 'Controllers must use repositories, not raw DB',
        },
      ],
    }),
    
    rules.phpConventions({
      pattern: 'app/**/*.php',
      adapter: 'php',
      rules: [
        {
          name: 'no-raw-strings',
          check: (ctx, file) => {
            // Find string literals in PHP that are not in __() calls
            const ast = ctx.parse(file);
            const strings = ctx.findNodes(ast, { type: 'string' });
            const violations = [];
            for (const str of strings) {
              const parent = str.getParent();
              if (!ctx.is(parent, 'call') || !ctx.getText(parent).startsWith('__')) {
                violations.push(ctx.violation(str, 'Hardcoded string — use __() for i18n'));
              }
            }
            return violations;
          },
        },
        {
          name: 'every-model-has-factory',
          check: (ctx, file) => {
            // Check if models have corresponding factories
            const files = ctx.walkFiles('app/Domains/*/Models/*.php');
            const violations = [];
            for (const model of files) {
              const factoryPath = model.path.replace('Models/', 'Factories/').replace('.php', 'Factory.php');
              if (!ctx.exists(factoryPath)) {
                violations.push(ctx.violationAt(model.path, 1, 'Model missing factory'));
              }
            }
            return violations;
          },
        },
      ],
    }),
    
    // === Cross-Project Rules ===
    rules.noOrphanedFiles({
      patterns: [
        'immoui/src/**/*.ts',
        'app/**/*.php',
      ],
    }),
  ],
});
```

### 9.2 What This Enables

- **One config file** for the entire immocore + immoui monorepo
- **One test command** (`bun run qa` or `php artisan qa` or `npx qa`)
- **One CI pipeline** checks both frontend and backend architecture
- **Shared rules** (no circular dependencies, no dead code, file structure)
- **Language-specific rules** (TanStack Query for TS, Eloquent for PHP)
- **Cross-project rules** (no orphaned API endpoints, no unused frontend routes)

---

## 10. Feasibility Assessment

### 10.1 What Is Easy (Low Effort, High Value)

| Feature | Difficulty | Value | Priority |
|---------|-----------|-------|----------|
| **File system rules** (exists, naming, structure) | Trivial | High | P0 |
| **Dependency graph rules** (circular, dead code) | Easy | High | P0 |
| **Text pattern rules** (forbidden strings, required imports) | Easy | High | P0 |
| **TypeScript adapter** (ts-morph) | Easy | High | P0 |
| **PHP adapter** (tree-sitter-php) | Medium | High | P1 |
| **Python adapter** (tree-sitter-python) | Medium | Medium | P2 |
| **Cross-language rules** (no debug output) | Medium | Medium | P2 |
| **Universal AST query language** | Hard | Low | P3 (never) |

### 10.2 What Is Hard (High Effort, Low Value)

- ❌ **Building a universal AST (UAST)** — YASA and Metastatic are trying this. It requires mapping every language construct to a common IR. This is a research project, not a product feature. The mappings are lossy and break on edge cases.
- ❌ **Semantic analysis across languages** — Type checking, data flow analysis, taint analysis across language boundaries requires a unified type system. This is what YASA and LiSA do. It's far beyond our scope.
- ❌ **One rule language that works everywhere** — Trying to write a single query like `find all function calls to console.log` that works across TypeScript, PHP, and Python is impractical. Each language's AST is too different.

### 10.3 The Pragmatic Boundary

> **We are language-agnostic at the framework level, not at the rule level.**

Rules are written for specific languages. The framework makes it easy to:
1. Run TypeScript rules and PHP rules in the same test suite
2. Share configuration format and reporting
3. Write cross-language structural rules (file system, dependency graph)
4. Add new languages via adapters

---

## 11. Implementation Strategy

### 11.1 Phase 1: TypeScript-Only (Foundation)

Build the framework with TypeScript as the primary language. The adapter interface is designed but not yet generalized.

```typescript
// Phase 1: TypeScript only
interface RuleContext {
  ast: TypeScriptAstAnalyzer; // direct, not generic
  imports: TypeScriptImportAnalyzer;
  fs: FileSystem;
  patterns: PatternMatcher;
}
```

### 11.2 Phase 2: Extract Adapter Interface

Refactor the TypeScript-specific code into an adapter. The rest of the framework becomes language-agnostic.

```typescript
// Phase 2: Adapter interface
interface RuleContext {
  for(language: string): LanguageContext;
  fs: FileSystem;
  patterns: PatternMatcher;
}

interface LanguageContext {
  ast: AstAnalyzer;
  imports: ImportAnalyzer;
}

// TypeScript adapter implements the interface
class TypeScriptAdapter implements LanguageAdapter { ... }
```

### 11.3 Phase 3: Add PHP Adapter

Implement the PHP adapter using tree-sitter-php. Port immocore's architectural rules.

```typescript
// Phase 3: PHP support
class PhpAdapter implements LanguageAdapter {
  readonly name = 'php';
  readonly extensions = ['.php'];
  // Parse with tree-sitter-php
  // Resolve imports via PSR-4 / composer.json
}
```

### 11.4 Phase 4: Additional Languages

Add Python, Go, etc. on demand. Each new language is just a new adapter.

---

## 12. Open Questions

### Q1: Should we use tree-sitter for all languages, or language-specific parsers?

**Analysis:**
- **ts-morph** for TypeScript is superior to tree-sitter because it has type information, symbol resolution, and project-wide analysis.
- **tree-sitter** for PHP/Python is the best option because it has mature grammars, is fast, and has a consistent API.

**Recommendation:** Use the best parser for each language:
- TypeScript: ts-morph (primary) + tree-sitter (fallback)
- PHP: tree-sitter-php
- Python: tree-sitter-python
- Go: tree-sitter-go
- Rust: tree-sitter-rust

The adapter interface abstracts the parser, so the rule engine doesn't care.

### Q2: How do we resolve PHP imports (PSR-4 autoloading)?

**Analysis:** PHP imports are `use` statements with namespaces. Resolution requires:
1. Reading `composer.json` to get PSR-4 mappings
2. Mapping namespace prefixes to folder paths
3. Handling `vendor/` dependencies

**Recommendation:** The PHP adapter includes a `composer.json` parser. It builds a namespace → path map. Import resolution uses this map.

### Q3: How do we handle multi-language monorepos?

**Analysis:** A project might have:
```
project/
  frontend/     ← TypeScript (React)
  backend/      ← PHP (Laravel)
  mobile/       ← Swift / Kotlin
  infrastructure/ ← Terraform / YAML
```

**Recommendation:** The config supports multiple adapters and multiple rule sets:
```typescript
export default defineConfig({
  adapters: ['typescript', 'php'],
  projects: [
    { name: 'frontend', path: 'frontend', adapter: 'typescript' },
    { name: 'backend', path: 'backend', adapter: 'php' },
  ],
  rules: [
    // Rules can target specific projects
    rules.architecture({ project: 'frontend', layers: [...] }),
    rules.architecture({ project: 'backend', layers: [...] }),
    // Or cross-project rules
    rules.noOrphanedFiles({ projects: ['frontend', 'backend'] }),
  ],
});
```

### Q4: What about language-agnostic rules that need AST access?

**Example:** "No function should have more than 50 lines."

This needs to find functions in the AST, but the concept of "function" exists in all languages. The adapter can abstract this.

```typescript
rules.functionMetrics({
  pattern: 'src/**/*.{ts,php,py}',
  maxLines: 50,
  adapters: ['typescript', 'php', 'python'],
});

// The adapter provides: getFunctions(file) → FunctionInfo[]
// Each adapter maps its AST nodes to FunctionInfo
```

### Q5: What about rules that need type information?

**Example:** "No controller should call the database directly."

In TypeScript: Check if a function calls `useQuery` or `fetch` directly.
In PHP: Check if a controller uses `DB::` or `Eloquent` directly.
In Python: Check if a view uses `cursor.execute()` directly.

These rules need language-specific knowledge. They can't be abstracted.

**Recommendation:** Language-specific rules are fine. The framework supports them natively. The value is in having them in the same config file, not in making them universal.

### Q6: How do we test the PHP adapter without a PHP runtime?

**Analysis:** The adapter parses PHP code using tree-sitter (which is a WASM/native parser). It doesn't need the PHP interpreter. However, some advanced features (like resolving composer dependencies) might need `composer` installed.

**Recommendation:** The core adapter works without PHP. Optional features (like composer resolution) require `composer` or a `composer.json` file.

### Q7: What about existing PHP static analysis tools?

**Analysis:** PHP has excellent tools:
- **PHPStan** — static analysis, type checking
- **Psalm** — static analysis with advanced types
- **PHP_CodeSniffer** — coding standards
- **PHPMD** — mess detection (complexity, dead code)
- **Deptrac** — dependency analysis (architecture layers)

**Recommendation:** Our PHP adapter should integrate with these tools, not replace them. The adapter can:
- Use Deptrac for dependency graphs (instead of building our own)
- Use PHPStan for type information (instead of building our own)
- Use our framework for the rules that these tools don't cover (e.g., "every model has a factory", "no hardcoded strings")

### Q8: What about the Laravel ecosystem?

**Analysis:** Laravel has specific conventions:
- `app/Models/` → Eloquent models
- `app/Http/Controllers/` → Controllers
- `app/Http/Requests/` → Form requests
- `app/Providers/` → Service providers
- `database/factories/` → Model factories
- `routes/web.php`, `routes/api.php` → Routes

**Recommendation:** The PHP adapter includes Laravel-specific helpers:
```typescript
// Laravel-specific rules
rules.laravel({
  models: 'app/Domains/*/Models/*.php',
  controllers: 'app/Http/Controllers/**/*.php',
  factories: 'database/factories/**/*.php',
  rules: [
    { name: 'models-have-factories', check: ... },
    { name: 'controllers-use-requests', check: ... },
  ],
});
```

---

## Conclusion

### Yes, Language-Agnostic Is Possible — With the Right Definition

**The framework can absolutely be language-agnostic if we define it as:**

> A unified rule engine, configuration format, and test runner that supports multiple programming languages through language-specific adapters. Rules are written for specific languages, but the framework makes it easy to manage them together.

**This is the right approach because:**

1. **It's technically feasible** — tree-sitter provides parsers for 100+ languages. The adapter pattern is well-understood.
2. **It's pragmatic** — We don't try to build a universal AST. We build a universal framework.
3. **It's valuable** — A team with TypeScript frontend + PHP backend can use one tool for both.
4. **It's extensible** — Adding a new language is just writing a new adapter. No framework changes needed.
5. **It leverages existing tools** — We don't replace PHPStan or Deptrac. We integrate them.

**The TypeScript adapter is the primary implementation.** PHP and Python adapters are added later. The framework is designed for this from day one.

### The Recommendation

**Design the framework with a language-agnostic core from the start.**

- The `RuleEngine` knows nothing about languages
- The `RuleContext` has a `for(language)` method
- The `LanguageAdapter` interface is the extension point
- The TypeScript adapter is the reference implementation
- The PHP adapter is the second implementation (for immocore)

This gives us:
- ✅ TypeScript-first development (fast, type-safe, familiar)
- ✅ Path to multi-language support (no rewrite needed)
- ✅ Shared infrastructure across projects
- ✅ One tool for the entire stack

---

*This document should be appended to the main PLAN.md or referenced from it. The architecture section of PLAN.md should be updated to reflect the adapter-based design.*
