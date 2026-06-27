# Gesetz

> **Gesetz** (German for "laws") — a unified code-quality gate that lets you write your own project rules as easily as writing a config file.

[View the full documentation on GitHub](https://github.com/mateffy/gesetz)

## Why Gesetz exists

Every codebase has conventions that no generic linter knows about:

- *"Every module in `src/` must have a `README.md`"*
- *"No file should exceed 400 lines"*
- *"No one should import from `src/legacy/` — we're migrating away"*
- *"Every API endpoint file needs a sibling `.test.ts`"*
- *"Console logs left in production code break our log pipeline"*
- *"Feature A must not import internals from Feature B"*

ESLint, PHPStan, and Vitest are excellent at what they do. But they don't know *your* architecture. Gesetz bridges that gap: **you write project-specific rules in plain TypeScript, and Gesetz runs them alongside your existing tools in a single, scored report.**

**Gesetz does not replace your linters.** It wraps them. You still run ESLint, Vitest, PHPStan — but their output and your custom rules all feed into one unified `Violation` format, one category score, one CLI. Because the rule engine is language-agnostic, the same `gesetz check` covers your TypeScript frontend, your PHP backend, and whatever else lives in the repo.

| Category | What it measures |
|---|---|
| **strictness** | Type safety, `any`, `as`, non-null assertions, floating promises |
| **structure** | Code shape: file/function size, nesting, magic numbers, empty catch blocks |
| **organization** | Monorepo health: cycles, layer violations, import discipline, file pairing |
| **cleanup** | Dead code, AI residue: console logs, trivial comments, debugging files |
| **security** | Secrets, SQL injection, unsafe innerHTML, hardcoded tokens |

Categories are extensible — `category` is just a string, so you can define your own (e.g. `category: 'api-conventions'` or `category: 'react'`).

The goal is simple: **one command, one score, one decision.** Pass or fail.

## Quick start

### 1. Install Gesetz and the adapters you need

```bash
# Core + CLI (lightweight — no heavy deps)
bun add -d gesetz

# Adapters for your stack (install only what you use)
bun add -d @gesetz/eslint @gesetz/vitest @gesetz/typescript
```

### 2. Initialize a config

```bash
gesetz init
```

This creates a `gesetz.config.ts` at your project root. In a TTY it runs an interactive wizard; in CI or agent mode it auto-detects your framework and installed tools.

### 3. Run checks

```bash
gesetz check
```

Output (TTY):

```
┌─────────────┬───────┬────────┬─────────┬─────────┐
│ Category    │ Score │ Errors │ Warns   │ Infos   │
├─────────────┼───────┼────────┼─────────┼─────────┤
│ strictness  │ 9.0   │ 0      │ 2       │ 0       │
│ structure   │ 7.5   │ 1      │ 5       │ 0       │
│ cleanup     │ 10.0  │ 0      │ 0       │ 0       │
└─────────────┴───────┴────────┴─────────┴─────────┘
✅ All categories above threshold
```


## License

MIT

© Lukas Mateffy
