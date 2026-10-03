# `@gesetz/tsc`

Runs the TypeScript compiler as a gesetz rule, so type errors are violations like any
other finding — with a file, a line, a category score and a baseline entry.

```ts
import { defineConfig } from '@gesetz/core';
import { tsc } from '@gesetz/tsc';

export default defineConfig({
  rules: [
    // The whole project, using its own tsconfig.json
    tsc({ pattern: '**/*.{ts,tsx}' }),

    // Or a workspace package, with its own project file
    tsc({ pattern: 'apps/web', args: ['--project', 'apps/web/tsconfig.json'] }),
  ],
});
```

Then, instead of running the compiler yourself:

```bash
gesetz check --rule tsc
```

## Options

| Option | Meaning |
| --- | --- |
| `pattern` | What this rule is responsible for — used to scope and watch, never passed to tsc. Default: every `.ts`/`.tsx` file. |
| `bin` | The binary. Default `tsc`; use `vue-tsc` for Vue projects. |
| `args` | Extra arguments. With `--project`/`-p`, file paths are not appended. |
| `cwd` | Directory to run in. Default: the project root. |
| `label`, `id`, `category` | The rule's label, id and scoring category. |

With no `--files` request the rule passes **no file arguments**, so tsc checks the
project as its own `tsconfig.json` defines it — keep one, or name it with
`args: ['--project', 'path/to/tsconfig.json']`. With a request, only the requested
files this rule covers are passed; tsc does not expand globs, so patterns are resolved
here.

## Making type errors a hard gate

The category score decides the run's verdict, so a single error in a category with
many rules can still pass the threshold. If type errors must block, set a threshold of
10 for the category:

```ts
export default defineConfig({
  rules: [tsc({ category: 'correctness' })],
  thresholds: [{ category: 'correctness', minScore: 10 }],
});
```

## What it refuses to do

A compiler that **ran and found nothing** and one that **never ran** both produce no
diagnostics. The second is reported as an error violation naming the exit status and
the tool's own message, never as a clean project — a green gate over a project nobody
examined is worse than a red one.

It is a **project** rule, not a per-file one. A type error is usually a fact about a
file *and* the files it imports, so a per-file rule would report "clean" for a file
whose types depend on a neighbour that changed.
