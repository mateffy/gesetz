/**
 * Effect-TS specific AST checks.
 *
 * Catches the four most common Effect-TS anti-patterns that AI agents introduce.
 *
 * Implemented with ast-grep (syntactic). No ts-morph, no type checker required.
 * The public API (exported function names + options) is unchanged from the
 * ts-morph version.
 */
import { Effect } from 'effect';
import { ts, tsx } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import type { Check, Violation } from '@gesetz/core';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeViolation(
  rule: string,
  message: string,
  path: string,
  line: number,
): Violation {
  return { rule, message, path, line, severity: 'error', source: 'core' };
}

function parseFile(content: string, filePath: string): SgNode | null {
  try {
    const ext = '.' + (filePath.split('.').pop() ?? '');
    const parser = ext === '.tsx' ? tsx : ts;
    return parser.parse(content).root();
  } catch {
    return null;
  }
}

function findByKind(root: SgNode, kind: string): SgNode[] {
  return root.findAll({ rule: { kind } });
}

function startLine(node: SgNode): number {
  return node.range().start.line + 1;
}

/** Returns the actual argument nodes of a call_expression (excludes parens). */
function getCallArgs(call: SgNode): SgNode[] {
  const args = call.field('arguments');
  if (!args) return [];
  return [...args.children()].filter((n) => n.isNamed());
}

/** True if `call` is `Effect.<method>` or `E.<method>`. */
function isEffectCall(call: SgNode, method: string): boolean {
  const fn = call.child(0);
  if (!fn || fn.kind() !== 'member_expression') return false;
  const obj = fn.child(0)?.text();
  const prop = fn.child(2)?.text();
  return (obj === 'Effect' || obj === 'E') && prop === method;
}

// ─── noRunPromiseScattered ────────────────────────────────────────────────────

export interface NoRunPromiseScatteredOptions {
  /**
   * File path suffixes that ARE allowed to call Effect.run*.
   * Typically entry points: `['src/main.ts', 'src/index.ts']`.
   * Default: no files are allowed (every call is flagged).
   */
  readonly entryPoints?: string[] | undefined;
  readonly message?: string | undefined;
}

const RUN_METHODS = new Set(['runPromise', 'runSync', 'runFork', 'runCallback', 'runPromiseExit']);

/**
 * Flags Effect.runPromise / runSync / runFork outside designated entry-point files.
 */
export function noRunPromiseScattered(options: NoRunPromiseScatteredOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      if (options.entryPoints?.some((ep) => file.path === ep || file.path.endsWith(ep))) {
        return [];
      }
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      for (const call of findByKind(root, 'call_expression')) {
        const fn = call.child(0);
        if (!fn || fn.kind() !== 'member_expression') continue;
        const obj = fn.child(0)?.text();
        const prop = fn.child(2)?.text();
        if ((obj === 'Effect' || obj === 'E') && RUN_METHODS.has(prop ?? '')) {
          violations.push(
            makeViolation(
              'no-run-promise-scattered',
              options.message ??
                `Effect.${prop}() should only be called at program entry points. Use yield* inside Effect.gen() to compose.`,
              file.path,
              startLine(call),
            ),
          );
        }
      }
      return violations;
    });
}

// ─── noThrowInEffectGen ───────────────────────────────────────────────────────

export interface NoThrowInEffectGenOptions {
  readonly message?: string | undefined;
}

/** True if `call` is Effect.gen / Effect.fn / Effect.fnUntraced. */
function isEffectGenLike(call: SgNode): boolean {
  return isEffectCall(call, 'gen') || isEffectCall(call, 'fn') || isEffectCall(call, 'fnUntraced');
}

/**
 * Flags `throw` statements inside `Effect.gen(function* ...)` bodies.
 */
export function noThrowInEffectGen(options: NoThrowInEffectGenOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      for (const call of findByKind(root, 'call_expression')) {
        if (!isEffectGenLike(call)) continue;
        for (const node of call.findAll({ rule: { kind: 'throw_statement' } })) {
          violations.push(
            makeViolation(
              'no-throw-in-effect-gen',
              options.message ??
                '`throw` inside Effect.gen() creates an untyped Defect. Use `yield* Effect.fail(new MyError())` instead.',
              file.path,
              startLine(node),
            ),
          );
        }
      }
      return violations;
    });
}

// ─── noYieldWithoutStar ───────────────────────────────────────────────────────

export interface NoYieldWithoutStarOptions {
  readonly message?: string | undefined;
}

/**
 * Flags plain `yield expr` (no `*`) inside Effect.gen() generators.
 */
export function noYieldWithoutStar(options: NoYieldWithoutStarOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      for (const call of findByKind(root, 'call_expression')) {
        if (!isEffectGenLike(call)) continue;
        for (const node of call.findAll({ rule: { kind: 'yield_expression' } })) {
          // `yield*` vs `yield`: ast-grep's yield_expression text starts with
          // "yield*" when starred, "yield " (or "yield\n") when not.
          const text = node.text();
          if (!text.startsWith('yield*')) {
            violations.push(
              makeViolation(
                'no-yield-without-star',
                options.message ??
                  '`yield` inside Effect.gen() does not unwrap the Effect. Write `yield*` (with asterisk) instead.',
                file.path,
                startLine(node),
              ),
            );
          }
        }
      }
      return violations;
    });
}

// ─── noUnboundedEffectAll ─────────────────────────────────────────────────────

export interface NoUnboundedEffectAllOptions {
  readonly message?: string | undefined;
}

/**
 * Flags `Effect.all([...])` calls without a `concurrency` options argument.
 */
export function noUnboundedEffectAll(options: NoUnboundedEffectAllOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      const violations: Violation[] = [];
      for (const call of findByKind(root, 'call_expression')) {
        if (!isEffectCall(call, 'all')) continue;
        const args = getCallArgs(call);
        if (args.length < 2) {
          violations.push(
            makeViolation(
              'no-unbounded-effect-all',
              options.message ??
                'Effect.all() is missing a concurrency option. Add `{ concurrency: N }` to make intent explicit.',
              file.path,
              startLine(call),
            ),
          );
        }
      }
      return violations;
    });
}
