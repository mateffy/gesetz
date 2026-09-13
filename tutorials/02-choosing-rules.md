# Choosing the Right Rules for Your Project

A rule that does not match your team's habits becomes noise. A missing rule becomes technical debt. This tutorial helps you build a rule set that catches real problems, stays quiet on legitimate patterns, and grows with your codebase. We will look at common project shapes, map them to concrete rule combinations, and walk through the process of testing your rules before you enforce them in CI.

---

## Table of contents

1. [How rules compose](#1-how-rules-compose)
2. [Categories and scoring](#2-categories-and-scoring)
3. [Archetype: React + TypeScript frontend](#3-archetype-react--typescript-frontend)
4. [Archetype: Next.js full-stack](#4-archetype-nextjs-full-stack)
5. [Archetype: Effect-TS service](#5-archetype-effect-ts-service)
6. [Archetype: PHP monolith (Laravel)](#6-archetype-php-monolith-laravel)
7. [Archetype: Polyglot monorepo](#7-archetype-polyglot-monorepo)
8. [Layering architecture rules](#8-layering-architecture-rules)
9. [Common mistakes when choosing rules](#9-common-mistakes-when-choosing-rules)
10. [Testing rules before enforcing them](#10-testing-rules-before-enforcing-them)
11. [Exemptions: when a rule must not apply](#11-exemptions-when-a-rule-must-not-apply)
12. [Evolving your rule set](#12-evolving-your-rule-set)

---

## 1. How rules compose

Rules do not replace each other. They layer. A file can be checked by multiple rules, and each rule reports its own violations. The runner collects all of them, deduplicates nothing (intentionally — overlapping violations are sometimes useful), and rolls them into category scores.

Think of your rule set as a **pyramid**:

```
┌─────────────────────────────┐
│  Project-specific customs   │  ← Your bespoke rules
│  (sibling files, naming,    │
│   export relationships)     │
├─────────────────────────────┤
│  Framework conventions      │  ← React, Effect-TS, Laravel rules
│  (no default exports,       │
│   Effect anti-patterns)     │
├─────────────────────────────┤
│  Language discipline        │  ← TypeScript / PHP rules
│  (no any, no enums,         │
│   strict types)             │
├─────────────────────────────┤
│  Universal hygiene          │  ← Core rules
│  (file size, secrets,       │
│   debug logging, nesting) │
└─────────────────────────────┘
```

Start from the bottom. Universal hygiene rules run on any project, any language. Add language discipline if you use TypeScript or PHP. Add framework conventions if you use React or Effect-TS. Only then write project-specific customs. This keeps your config short and your signal-to-noise ratio high.

---

## 2. Categories and scoring

Every rule optionally belongs to a `category`. The runner computes a 0–10 score per category from the violations it contains:

```
weighted = errors * 1.0 + warnings * 0.5 + infos * 0.1
score    = max(0, 10 - weighted)
```

| Category       | Typical rules                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `strictness`   | Type discipline: `noTypedAny`, `noAsUnknownAs`, `noEnum`, `noDefaultExport`, `requireExplicitReturnType` |
| `structure`    | Code shape: `noGodFile`, `noDeepNesting`, `noMagicNumbers`, `noEmptyCatch`                               |
| `organization` | Architecture: `defineArchitecture`, `noCycles`, `requireSibling`, `noImportFrom`                         |
| `cleanup`      | Dead code: `noDebugLogging`, `noTrivialComment`, `noDebuggingResidueFiles`                               |
| `security`     | Secrets, unsafe calls: `noHardcodedSecret`, `noDirectCalls(['eval'])`                                    |
| `react`        | Component conventions: `noLocalFunctionComponents`, `noLiteralJsxText`                                   |
| `effect-ts`    | Effect patterns: `noRunPromiseScattered`, `noThrowInEffectGen`                                           |

You can define your own categories. They are just strings. A `category: 'api-conventions'` rule will produce an `api-conventions` score alongside the standard ones.

### Thresholds

By default, every category must score at least 7. You can raise or lower per category:

```ts
defineConfig({
  rules: [...],
  thresholds: [
    { category: 'strictness', minScore: 9 },
    { category: 'cleanup',    minScore: 10 },
    { category: 'security',   minScore: 10 },
  ],
});
```

A failing category fails the build. Set `minScore: 10` for categories where you tolerate zero errors.

---

## 3. Archetype: React + TypeScript frontend

A typical Vite or Create React App project with components, hooks, utilities, and tests.

### Directory structure

```
src/
  components/
    Button.tsx
    Button.test.tsx
    Button.stories.tsx
  hooks/
    useAuth.ts
  utils/
    formatDate.ts
  legacy/
    oldHelpers.ts   ← migrating away
```

### Recommended rule set

```ts
import { defineConfig, select } from "gesetz";
import { typescriptSyntaxBackend } from "@gesetz/typescript";
import {
  noGodFile,
  noDeepNesting,
  noDebugLogging,
  noHardcodedSecret,
  noImportFrom,
  requireSibling,
  relativeImports,
} from "gesetz";
import {
  noTypedAny,
  noAsUnknownAs,
  noDefaultExport,
  noEnum,
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  noLocalFunctionComponents,
  noLiteralJsxText,
  requireExplicitReturnType,
} from "@gesetz/typescript";

export default defineConfig({
  adapters: [typescriptSyntaxBackend],
  rules: [
    // ── Universal hygiene ──
    select("src/**/*.{ts,tsx}")
      .label("Files should stay under 400 lines")
      .category("structure")
      .check(noGodFile({ maxLines: 400 })),

    select("src/**/*.{ts,tsx}")
      .label("Avoid deep nesting")
      .category("structure")
      .check(noDeepNesting({ maxLevels: 4 })),

    select("src/**/*")
      .label("No debug logging in production")
      .category("cleanup")
      .check(noDebugLogging({ severity: "warn" })),

    select("src/**/*")
      .label("No hardcoded secrets")
      .category("security")
      .check(noHardcodedSecret()),

    // ── TypeScript discipline ──
    select("src/**/*.{ts,tsx}")
      .label("No any type annotations")
      .category("strictness")
      .check(noTypedAny()),

    select("src/**/*.{ts,tsx}")
      .label("No as unknown as casts")
      .category("strictness")
      .check(noAsUnknownAs()),

    select("src/**/*.{ts,tsx}")
      .label("No default exports")
      .category("strictness")
      .check(noDefaultExport()),

    select("src/**/*.{ts,tsx}").label("No enums").category("strictness").check(noEnum()),

    select("src/**/*.{ts,tsx}")
      .label("Explicit return types on exported functions")
      .category("strictness")
      .check(requireExplicitReturnType({ exportedOnly: true })),

    select("src/**/*.{ts,tsx}")
      .label("No empty catch blocks")
      .category("structure")
      .check(noEmptyCatch()),

    select("src/**/*.{ts,tsx}")
      .label("Avoid magic numbers")
      .category("structure")
      .check(noMagicNumbers({ ignore: [0, 1, 100] })),

    select("src/**/*.{ts,tsx}")
      .label("Remove trivial comments")
      .category("cleanup")
      .check(noTrivialComment()),

    // ── React conventions ──
    select("src/components/**/*.tsx")
      .label("Components should not use local function components")
      .category("react")
      .check(noLocalFunctionComponents()),

    select("src/components/**/*.tsx")
      .label("No raw text in JSX")
      .category("react")
      .check(noLiteralJsxText()),

    // ── File pairing ──
    select("src/components/**/*.tsx")
      .exclude("**/*.test.tsx", "**/*.stories.tsx")
      .label("Components need tests and stories")
      .category("organization")
      .check(requireSibling(".test.tsx"), requireSibling(".stories.tsx")),

    // ── Import discipline ──
    select("src/**/*.{ts,tsx}")
      .label("Do not import from legacy helpers")
      .category("organization")
      .check(
        noImportFrom("src/legacy", {
          message: "Import from src/utils instead of src/legacy.",
        }),
      ),

    select("src/**/*.{ts,tsx}")
      .label("Relative imports must resolve")
      .category("organization")
      .check(relativeImports()),
  ],
});
```

### Why these rules?

- **File size and nesting** keep components small and readable. A 400-line component is almost always doing too much.
- **`noTypedAny` + `noAsUnknownAs`** keep the type system honest. They catch AI-generated escape hatches.
- **`noDefaultExport`** makes refactoring easier. Named exports are searchable and rename-safe.
- **`noEnum`** prevents brittle string enums that break when new values are added.
- **`noLocalFunctionComponents`** prevents re-mounting bugs: a function declared inside a render body gets recreated every render, destroying child state.
- **`noLiteralJsxText`** enforces i18n: every user-facing string must go through a translation API.
- **Sibling checks** ensure your component directory is complete: a component without a test or story is incomplete.

---

## 4. Archetype: Next.js full-stack

Next.js adds `app/` directory routing, server components, and API routes. Your rules must distinguish between client and server code.

### Directory structure

```
app/
  (marketing)/
    page.tsx          ← server component
    layout.tsx
  dashboard/
    page.tsx          ← server component
    ClientWidget.tsx  ← 'use client'
  api/
    users/
      route.ts        ← API handler
lib/
  db.ts
  auth.ts
components/
  ui/
    Button.tsx
```

### Recommended additions

```ts
// Server components must not use client-only hooks
select('app/**/*.tsx')
  .exclude("**/'use client'**")   // rough filter; better: check content
  .label('Server components must not call client hooks')
  .category('react')
  .check(noDirectCalls(['useState', 'useEffect', 'useRouter'])),

// API routes must declare HTTP method handlers
select('app/api/**/route.ts')
  .label('API routes must export GET, POST, PUT, or DELETE')
  .category('organization')
  .check(requirePattern(/export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE)/)),

// lib/ must not import from app/
select('lib/**/*.{ts,tsx}')
  .label('Library code must not depend on app routes')
  .category('organization')
  .check(noImportFrom('app/', { message: 'lib/ is a lower layer than app/' })),
```

### Important caveat

The `'use client'` check above is content-based, not path-based. A more robust approach is a custom check that reads the file content and skips files containing `'use client'`:

```ts
select("app/**/*.tsx")
  .label("Server components must not use client hooks")
  .filter((file) => !file.content.includes("'use client'"))
  .check(noDirectCalls(["useState", "useEffect"]));
```

This uses `.filter()` in the selector, which runs after globbing but before checks.

---

## 5. Archetype: Effect-TS service

A backend or CLI built entirely on Effect-TS. The biggest risk is leaking imperative patterns into a functional framework.

### Directory structure

```
src/
  main.ts           ← entry point: Effect.runPromise is allowed here
  program.ts        ← business logic: must NOT call runPromise
  services/
    http.ts
    db.ts
  errors/
    api-error.ts
```

### Recommended rule set

```ts
import { defineConfig, select } from "gesetz";
import { typescriptSyntaxBackend } from "@gesetz/typescript";
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from "@gesetz/effect-ts";

export default defineConfig({
  adapters: [typescriptSyntaxBackend],
  rules: [
    // Effect discipline
    select("src/**/*.ts")
      .exclude("src/main.ts")
      .label("Effect.runPromise only in entry points")
      .category("effect-ts")
      .check(noRunPromiseScattered()),

    select("src/**/*.ts")
      .label("No throw inside Effect.gen")
      .category("effect-ts")
      .check(noThrowInEffectGen()),

    select("src/**/*.ts")
      .label("Use yield* not yield inside Effect.gen")
      .category("effect-ts")
      .check(noYieldWithoutStar()),

    select("src/**/*.ts")
      .label("Effect.all must have concurrency option")
      .category("effect-ts")
      .check(noUnboundedEffectAll()),

    // Universal hygiene
    select("src/**/*.ts")
      .label("Files should stay under 300 lines")
      .category("structure")
      .check(noGodFile({ maxLines: 300 })),

    // Architecture
    select("src/**/*.ts")
      .label("Services must not import from main")
      .category("organization")
      .check(
        noImportFrom("src/main", {
          message: "Circular dependency: services should not depend on the entry point.",
        }),
      ),
  ],
});
```

### Why these rules?

- **`noRunPromiseScattered`** prevents `Effect.runPromise` from appearing in business logic. The only place an Effect program should be executed is the entry point. Everything else should compose via `yield*`.
- **`noThrowInEffectGen`** prevents `throw` inside generators, which creates untyped defects. Use `yield* Effect.fail(...)` instead.
- **`noYieldWithoutStar`** catches the most common beginner mistake: `yield someEffect` (wrong) instead of `yield* someEffect` (right). The star unwraps the Effect; without it, the generator yields the Effect object itself.
- **`noUnboundedEffectAll`** forces an explicit `concurrency` option on `Effect.all([...])`. Without it, the default is unbounded concurrency, which can exhaust resources.

---

## 6. Archetype: PHP monolith (Laravel)

A Laravel application with controllers, models, service classes, and tests.

### Directory structure

```
app/
  Http/
    Controllers/
      UserController.php
  Services/
    UserService.php
  Models/
    User.php
tests/
  Feature/
    UserTest.php
```

### Recommended rule set

```ts
import { defineConfig, select } from "gesetz";
import { phpSyntaxBackend } from "@gesetz/php";
import {
  noGodFile,
  noDebugLogging,
  noHardcodedSecret,
  noImportFrom,
  requirePattern,
  requireSibling,
  relativeImports,
} from "gesetz";

export default defineConfig({
  adapters: [phpSyntaxBackend],
  rules: [
    // Universal hygiene
    select("app/**/*.php")
      .label("Controllers should stay under 200 lines")
      .category("structure")
      .check(noGodFile({ maxLines: 200 })),

    select("app/**/*.php").label("No debug logging").category("cleanup").check(noDebugLogging()),

    select("app/**/*.php")
      .label("No hardcoded secrets")
      .category("security")
      .check(noHardcodedSecret()),

    // PHP discipline
    select("app/**/*.php")
      .label("Declare strict types")
      .category("strictness")
      .check(
        requirePattern(/declare\(strict_types=1\)/, {
          message: "Add declare(strict_types=1) at the top of the file.",
        }),
      ),

    // Architecture
    select("app/Services/**/*.php")
      .label("Services must not import from controllers")
      .category("organization")
      .check(
        noImportFrom("app/Http/Controllers", {
          message: "Services are a lower layer than controllers.",
        }),
      ),

    // Test pairing
    select("app/Http/Controllers/**/*.php")
      .label("Controllers need feature tests")
      .category("organization")
      .check(
        requireSibling(".php", {
          message: (missing) => `Missing test: tests/Feature/${missing}`,
        }), // Note: requireSibling checks same directory; for cross-dir tests write a custom check
      ),
  ],
});
```

### PHP-specific note

`requireSibling` checks the **same directory**. If your tests live in `tests/Feature/` and your controllers live in `app/Http/Controllers/`, `requireSibling` will not work directly. Write a custom `Check` that resolves the expected test path from the controller path:

```ts
import * as nodePath from "node:path";
import type { Check, Violation } from "gesetz";

export function requireFeatureTest(): Check {
  return async (file, { fs }) => {
    const base = nodePath.basename(file.stem); // "UserController"
    const expected = nodePath.resolve(
      nodePath.dirname(file.absolutePath),
      "../../../tests/Feature",
      base + "Test.php",
    );
    const exists = await fs.exists(expected);
    if (exists) return [];
    return [
      {
        severity: "error",
        source: "core",
        message: `Missing feature test: ${expected}`,
        path: file.path,
      },
    ];
  };
}
```

---

## 7. Archetype: Polyglot monorepo

A repo with TypeScript frontend, PHP backend, shared protobuf definitions, and a Go CLI.

### Directory structure

```
packages/
  web/           ← Next.js (TypeScript)
  api/           ← Laravel (PHP)
  cli/           ← Go
  proto/         ← Protocol Buffers
```

### Config strategy

Import all adapters and use `select` glob patterns to scope rules to the right packages:

```ts
import { defineConfig, select } from "gesetz";
import { typescriptSyntaxBackend } from "@gesetz/typescript";
import { phpSyntaxBackend } from "@gesetz/php";

export default defineConfig({
  adapters: [typescriptSyntaxBackend, phpSyntaxBackend],
  rules: [
    // TypeScript rules scoped to web/
    select("packages/web/**/*.ts").label("Web: no any").check(noTypedAny()),

    // PHP rules scoped to api/
    select("packages/api/**/*.php")
      .label("API: strict types")
      .check(requirePattern(/declare\(strict_types=1\)/)),

    // Universal rules run everywhere
    select("packages/**/*")
      .label("No god files")
      .check(noGodFile({ maxLines: 400 })),

    // Protobuf: no hand-edited files
    select("packages/proto/**/*.proto")
      .label("Protos must be generated, not hand-edited")
      .check(requirePattern(/Code generated by protoc/)),
  ],
});
```

### Important: adapter coverage

If you write `select('packages/cli/**/*.go').check(noDirectCalls(['fmt.Printf']))`, you must have a Go `SyntaxBackend` registered. If you do not, `st.canProcess(file)` returns `false` for `.go` files and the check silently skips them.

If a language does not have a Gesetz adapter yet, you have three options:

1. **Write a regex-based rule** using `noPattern` or `noDebugLogging` — works without a backend.
2. **Write the adapter** — implement `SyntaxBackend` for your language using any parser (tree-sitter, ANTLR, etc.).
3. **Skip the rule for that language** — use `select('packages/web/**/*.ts')` to scope it away.

---

## 8. Layering architecture rules

`defineArchitecture` is the most powerful tool in Gesetz. It enforces which parts of your codebase may depend on which other parts. Use it when you have a mental model of layers and want to prevent circular imports and upward dependencies.

### Clean Architecture example

```ts
import { defineArchitecture } from "gesetz";

const cleanArch = defineArchitecture({
  layers: [
    { name: "domain", pattern: "src/domain/**", canImportFrom: [] },
    { name: "usecase", pattern: "src/usecase/**", canImportFrom: ["domain"] },
    { name: "infra", pattern: "src/infra/**", canImportFrom: ["domain", "usecase"] },
    { name: "presenter", pattern: "src/presenter/**", canImportFrom: ["domain", "usecase"] },
    {
      name: "main",
      pattern: "src/main/**",
      canImportFrom: ["domain", "usecase", "infra", "presenter"],
    },
  ],
  bannedExternals: {
    domain: ["express", "react", "next"],
  },
});
```

This says:

- `domain` has no dependencies at all — it is pure business logic.
- `usecase` may import from `domain` only.
- `infra` and `presenter` may import from `domain` and `usecase`.
- `main` (the entry point / wiring layer) may import from everyone.
- `domain` must never import Express, React, or Next.js.

### Hexagonal / Ports-and-Adapters example

```ts
const hexagonal = defineArchitecture({
  layers: [
    { name: "core", pattern: "src/core/**", canImportFrom: [] },
    { name: "ports", pattern: "src/ports/**", canImportFrom: ["core"] },
    { name: "adapters", pattern: "src/adapters/**", canImportFrom: ["core", "ports"] },
    { name: "config", pattern: "src/config/**", canImportFrom: ["core", "ports", "adapters"] },
  ],
  forbidden: [
    { from: "adapters", to: "adapters", message: "Adapters must not import from other adapters." },
  ],
});
```

### When to use `defineArchitecture` vs. `noImportFrom`

| Situation                             | Use                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| One-off banned module                 | `noImportFrom('bad-module')`                                                    |
| Layer-to-layer constraints            | `defineArchitecture`                                                            |
| Circular dependency detection         | `noCycles()` (uses SyntaxTree + ImportResolver)                                 |
| Cross-package import bans in monorepo | `defineArchitecture` with patterns like `packages/web/**` and `packages/api/**` |

---

## 9. Common mistakes when choosing rules

### Mistake 1: Enforcing too many rules at once

If you add 20 rules and fail CI immediately, your team will treat Gesetz as noise and start ignoring it. Start with 3–5 rules that catch **unambiguous** problems (e.g. `noHardcodedSecret`, `noGodFile`, `noImportFrom('src/legacy')`). Let the team get used to the workflow. Add one new rule per week.

### Mistake 2: Using AST rules without the right adapter

If you write `.check(noTypedAny())` but forget to include `typescriptSyntaxBackend` in `adapters`, the rule will silently do nothing (or now, with the fix, throw a `SyntaxTreeError`). Always verify your adapter list matches your rule set.

### Mistake 3: Glob patterns that are too broad

```ts
select("src/**/*").check(noDebugLogging());
```

This includes `node_modules`, `.next`, `dist`, and generated files. Use exclusions:

```ts
select("src/**/*")
  .exclude("**/node_modules/**", "**/.next/**", "**/generated/**")
  .check(noDebugLogging());
```

Or, better, scope the glob:

```ts
select("src/app/**/*.tsx", "src/components/**/*.tsx", "src/hooks/**/*.ts").check(noDebugLogging());
```

### Mistake 4: Category mismatch

A rule about file size (`noGodFile`) categorized as `security` is misleading. Categories are human-facing. Put `noGodFile` in `structure`, `noHardcodedSecret` in `security`, `noImportFrom('src/legacy')` in `organization`.

### Mistake 5: Severity inflation

Not everything is an `error`. Use `warn` for style preferences (deep nesting, magic numbers) and `error` for things that will break production (secrets, import violations, missing tests). Use `info` for trivial comments or suggestions.

---

## 10. Testing rules before enforcing them

Before adding a rule to CI, run it locally with `--all` to see every violation without the 50-violation cap:

```bash
gesetz check --all
```

If the rule produces hundreds of violations across your existing codebase, you have two choices:

1. **Grandfather the existing code** with exemptions (see next section).
2. **Lower the severity to `warn`** so CI does not fail, but the violations are visible.

### Test a rule in isolation

Use `--category` to run only one category:

```bash
gesetz check --category=organization
```

Or use `--files` to test a rule on a subset:

```bash
gesetz check --files="src/components/**"
```

### Dry-run against existing code

Write the rule, run `gesetz check`, inspect the output. Ask yourself:

- Are the violations real problems?
- Are there false positives?
- Is the message actionable?

If you find false positives, tighten the rule. For example, if `noMagicNumbers` flags `const HTTP_PORT = 3000`, add `3000` to the `ignore` list or tighten the glob to exclude config files.

---

## 11. Exemptions: when a rule must not apply

Exemptions suppress violations for specific files or paths. They are part of the config, not code comments, so they are searchable and auditable.

```ts
defineConfig({
  rules: [...],
  exemptions: [
    // Exempt the auth module from the sibling rule until we write tests
    {
      path: 'src/auth/**',
      rule: 'components-need-tests-and-stories',
      reason: 'Auth module tests are tracked in PROJ-456.',
      ticket: 'PROJ-456',
      until: '2024-12-31',
    },
    // Exempt generated files from the no-any rule
    {
      path: 'src/generated/**',
      rule: '*',
      reason: 'Generated code is not hand-maintained.',
    },
  ],
});
```

### Exemption fields

| Field    | Required? | Meaning                                                     |
| -------- | --------- | ----------------------------------------------------------- |
| `path`   | Yes       | micromatch glob matching violation paths                    |
| `rule`   | No        | micromatch glob matching rule IDs. Default: `*` (all rules) |
| `reason` | Yes       | Why this exemption exists                                   |
| `ticket` | No        | Ticket reference for traceability                           |
| `until`  | No        | ISO 8601 expiry date. After this date, violations resurface |

### Expiry is the most important feature

An exemption without `until` is a permanent hole in your quality gate. Always set an expiry, even if it is a year out. This forces periodic review. When an exemption expires, the suppressed violations reappear in the next CI run, prompting the team to either fix the code or renew the exemption with a new ticket.

### When to use exemptions vs. `.exclude()`

|         | `.exclude()`                                             | Exemption                                      |
| ------- | -------------------------------------------------------- | ---------------------------------------------- |
| Scope   | Removes files from the rule entirely                     | Suppresses violations after they are detected  |
| Use for | Files that should never be scanned (generated, vendored) | Temporary exceptions for legitimate cases      |
| Example | `**/*.generated.ts`                                      | A known migration path that is tracked in Jira |

---

## 12. Evolving your rule set

Your rules should evolve with your codebase. Here is a simple cadence:

### Week 1–2: Foundation

- `noGodFile({ maxLines: 400 })`
- `noHardcodedSecret()`
- `noDebugLogging()`
- `relativeImports()`

### Week 3–4: Language discipline

- `noTypedAny()` (TypeScript)
- `noDefaultExport()` (TypeScript)
- `requirePattern(/declare\(strict_types=1\)/)` (PHP)

### Week 5–6: Framework conventions

- `noLocalFunctionComponents()` (React)
- `noLiteralJsxText()` (React)
- `noRunPromiseScattered()` (Effect-TS)

### Week 7–8: Architecture

- `defineArchitecture(...)` for your layer model
- `noCycles()` for circular dependency detection
- `requireSibling()` for file pairing conventions

### Ongoing: Tuning

- Review exemptions monthly. Close tickets or extend dates.
- Lower `maxLines` by 25 lines every quarter until the team pushes back.
- Add project-specific rules when code review finds the same issue three times.

### Metrics to watch

Run `gesetz check --format=json` and track these over time:

| Metric              | Healthy trend                           |
| ------------------- | --------------------------------------- |
| Total violations    | Decreasing                              |
| Exemptions count    | Stable or decreasing                    |
| Category scores     | Increasing toward 10                    |
| Violations per rule | Balanced (one rule should not dominate) |

If one rule produces 80% of violations, it is either too strict or the codebase has a systematic problem worth addressing as a team.

---

## Summary

Choosing rules is not about maximizing coverage. It is about **maximizing signal**. Start with universal hygiene, add language and framework discipline, then layer architecture and project-specific customs. Test each rule against your real codebase before enforcing it. Use exemptions with expiry dates for temporary exceptions. Review and tighten continuously.

A good rule set feels obvious to the team: "Of course we should not have 600-line files." A bad rule set feels arbitrary: "Why does this tool complain about our naming convention?" The difference is whether the rule captures a convention the team already believes in.
