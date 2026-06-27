/**
 * Effect-TS specific AST checks.
 *
 * Catches the four most common Effect-TS anti-patterns that AI agents introduce.
 * Uses ts-morph via the TsAdapter service — same pattern as typescript/primitives.ts.
 */
import { Effect } from 'effect';
import { SyntaxKind } from 'ts-morph';
import type { CallExpression, Node, SourceFile } from 'ts-morph';
import { TsAdapter } from '@gesetz/core';
import type { Check, Violation } from '@gesetz/core';
import type { FileSystem } from '@gesetz/core';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeViolation(
  rule: string,
  message: string,
  path: string,
  line: number,
): Violation {
  return { rule, message, path, line, severity: 'error', source: 'core' };
}

function* walkNodes<T extends Node>(node: Node, kind: SyntaxKind): Generator<T> {
  if (node.getKind() === kind) yield node as T;
  for (const child of node.getChildren()) {
    yield* walkNodes<T>(child, kind);
  }
}

function isEffectCall(call: CallExpression, method: string): boolean {
  const expr = call.getExpression();
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  const obj = pa.getExpression().getText();
  return (obj === 'Effect' || obj === 'E') && pa.getName() === method;
}

/** Loads a ts-morph SourceFile via TsAdapter, returns null on failure. */
function loadSourceFile(
  absolutePath: string,
  tsConfigPath: string,
): Effect.Effect<SourceFile | null, never, TsAdapter> {
  return Effect.gen(function* () {
    const ts = yield* TsAdapter;
    const sf = yield* ts.getSourceFile(absolutePath, tsConfigPath).pipe(
      Effect.catchTag('TsAdapterError', () => Effect.succeed(null)),
    );
    if (sf === null) return null;
    return sf._tsMorph as SourceFile;
  });
}

// ─── noRunPromiseScattered ────────────────────────────────────────────────────

export interface NoRunPromiseScatteredOptions {
  /**
   * File path suffixes that ARE allowed to call Effect.run*.
   * Typically entry points: `['src/main.ts', 'src/index.ts']`.
   * Default: no files are allowed (every call is flagged).
   */
  readonly entryPoints?: string[] | undefined;
  /** Path to tsconfig.json relative to project root. Default: 'tsconfig.json' */
  readonly tsConfigPath?: string | undefined;
  readonly message?: string | undefined;
}

const RUN_METHODS = new Set(['runPromise', 'runSync', 'runFork', 'runCallback', 'runPromiseExit']);

/**
 * Flags Effect.runPromise / runSync / runFork outside designated entry-point files.
 *
 * Guidance:
 * - **What**: Detects Effect boundary crossings inside library code.
 * - **Do**: Call Effect.run* only in your program entry point (main.ts / index.ts).
 * - **Don't**: Sprinkle runPromise inside services, hooks, or utility functions.
 */
export function noRunPromiseScattered(options: NoRunPromiseScatteredOptions = {}): Check {
  return (file): Effect.Effect<Violation[], never, FileSystem | TsAdapter> => {
    if (options.entryPoints?.some((ep) => file.path === ep || file.path.endsWith(ep))) {
      return Effect.succeed([]);
    }
    return Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, options.tsConfigPath ?? 'tsconfig.json');
      if (!sourceFile) return [];

      const violations: Violation[] = [];
      for (const call of walkNodes<CallExpression>(sourceFile, SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
        const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        if ((pa.getExpression().getText() === 'Effect' || pa.getExpression().getText() === 'E') && RUN_METHODS.has(pa.getName())) {
          violations.push(
            makeViolation(
              'no-run-promise-scattered',
              options.message ??
                `Effect.${pa.getName()}() should only be called at program entry points. Use yield* inside Effect.gen() to compose.`,
              file.path,
              call.getStartLineNumber(),
            ),
          );
        }
      }
      return violations;
    });
  };
}

// ─── noThrowInEffectGen ───────────────────────────────────────────────────────

export interface NoThrowInEffectGenOptions {
  readonly tsConfigPath?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags `throw` statements inside `Effect.gen(function* ...)` bodies.
 *
 * Guidance:
 * - **What**: `throw` inside Effect.gen converts typed failures into untyped Defects.
 * - **Do**: Use `yield* Effect.fail(new MyError())` to keep errors typed.
 * - **Don't**: throw inside generators — it bypasses Effect's error channel.
 */
export function noThrowInEffectGen(options: NoThrowInEffectGenOptions = {}): Check {
  return (file): Effect.Effect<Violation[], never, FileSystem | TsAdapter> =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, options.tsConfigPath ?? 'tsconfig.json');
      if (!sourceFile) return [];

      const violations: Violation[] = [];

      for (const call of walkNodes<CallExpression>(sourceFile, SyntaxKind.CallExpression)) {
        if (!isEffectCall(call, 'gen') && !isEffectCall(call, 'fn') && !isEffectCall(call, 'fnUntraced')) continue;

        call.forEachDescendant((node) => {
          if (node.getKind() === SyntaxKind.ThrowStatement) {
            violations.push(
              makeViolation(
                'no-throw-in-effect-gen',
                options.message ??
                  '`throw` inside Effect.gen() creates an untyped Defect. Use `yield* Effect.fail(new MyError())` instead.',
                file.path,
                node.getStartLineNumber(),
              ),
            );
          }
        });
      }

      return violations;
    });
}

// ─── noYieldWithoutStar ───────────────────────────────────────────────────────

export interface NoYieldWithoutStarOptions {
  readonly tsConfigPath?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags plain `yield expr` (no `*`) inside Effect.gen() generators.
 *
 * Guidance:
 * - **What**: `yield effect` returns the raw channel output, not the Effect's value.
 * - **Do**: Always write `yield* effect` (with asterisk) inside Effect.gen().
 * - **Don't**: Omit the star — it silently produces wrong types at runtime.
 */
export function noYieldWithoutStar(options: NoYieldWithoutStarOptions = {}): Check {
  return (file): Effect.Effect<Violation[], never, FileSystem | TsAdapter> =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, options.tsConfigPath ?? 'tsconfig.json');
      if (!sourceFile) return [];

      const violations: Violation[] = [];

      for (const call of walkNodes<CallExpression>(sourceFile, SyntaxKind.CallExpression)) {
        if (
          !isEffectCall(call, 'gen') &&
          !isEffectCall(call, 'fn') &&
          !isEffectCall(call, 'fnUntraced')
        ) {
          continue;
        }

        call.forEachDescendant((node) => {
          if (node.getKind() === SyntaxKind.YieldExpression) {
            const yieldExpr = node.asKindOrThrow(SyntaxKind.YieldExpression);
            if (!yieldExpr.compilerNode.asteriskToken) {
              violations.push(
                makeViolation(
                  'no-yield-without-star',
                  options.message ??
                    '`yield` inside Effect.gen() does not unwrap the Effect. Write `yield*` (with asterisk) instead.',
                  file.path,
                  node.getStartLineNumber(),
                ),
              );
            }
          }
        });
      }

      return violations;
    });
}

// ─── noUnboundedEffectAll ─────────────────────────────────────────────────────

export interface NoUnboundedEffectAllOptions {
  readonly tsConfigPath?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags `Effect.all([...])` calls without a `concurrency` options argument.
 *
 * Guidance:
 * - **What**: Effect.all without concurrency option runs sequentially by default.
 * - **Do**: Add `{ concurrency: N }` or `{ concurrency: 'unbounded' }` to make intent explicit.
 * - **Don't**: Leave Effect.all without options — silent sequential execution is a footgun.
 */
export function noUnboundedEffectAll(options: NoUnboundedEffectAllOptions = {}): Check {
  return (file): Effect.Effect<Violation[], never, FileSystem | TsAdapter> =>
    Effect.gen(function* () {
      const sourceFile = yield* loadSourceFile(file.absolutePath, options.tsConfigPath ?? 'tsconfig.json');
      if (!sourceFile) return [];

      const violations: Violation[] = [];

      for (const call of walkNodes<CallExpression>(sourceFile, SyntaxKind.CallExpression)) {
        if (!isEffectCall(call, 'all')) continue;

        const args = call.getArguments();
        if (args.length < 2) {
          violations.push(
            makeViolation(
              'no-unbounded-effect-all',
              options.message ??
                'Effect.all() is missing a concurrency option. Add `{ concurrency: N }` to make intent explicit.',
              file.path,
              call.getStartLineNumber(),
            ),
          );
        }
      }

      return violations;
    });
}
