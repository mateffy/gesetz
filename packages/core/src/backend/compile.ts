/**
 * Rule compiler.
 *
 * Compiles gesetz Rules into netzwerk extensions:
 *
 *   per-file rule (select)  → extension { include/exclude, process } —
 *     netzwerk re-runs it only for content-changed files; violation markers
 *     of unchanged files persist in storage (the cache).
 *
 *   project rule            → extension { after } — runs once per scan against
 *     a storage-backed network facade. Phase 4 adds change-aware skipping.
 *
 *   run-only rule (legacy)  → extension { after } — executes rule.run against
 *     marker-backed service shims on EVERY scan (conservative: old behavior).
 *
 * Violations whose path has no scanned file record (e.g. the project root, a
 * directory) cannot be stored as markers; they land in
 * `ctx.pendingViolations` and the runner merges them at aggregation time.
 *
 * Every rule is its own extension (name = rule.id) so netzwerk's per-
 * (extension, file) marker replacement gives rule-scoped idempotency.
 */
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { readFile } from 'node:fs/promises';
import { Effect, Layer } from 'effect';
import micromatch from 'micromatch';
import { globMatch } from 'netzwerk';
import type { ExtensionContext, NetworkExtension, NetworkFile, SourceFile } from 'netzwerk';
import type { ResolvedConfig } from '../engine/config';
import type { CheckServices, File, ProjectRuleContext, Rule, Violation } from '../engine/rule';
import { FileSystem, FileFilter, FileFilterLive, ProjectRoot } from '../services/fs';
import { ImportResolver } from '../services/import-resolver';
import { SyntaxTree, SyntaxTreeError } from '../services/syntax-tree';
import { syntaxExtension } from './syntax-extension';
import { violationToMarker } from './violation-markers';
import { storeProjectViolations } from './project-violations';
import { compileFileSetRule, needsFileSet } from './file-set-rule';
import {
  hasStoredMarkers,
  networkFileFromStorage,
  projectRuleContext,
  refreshSharedPaths,
  ruleFingerprint,
} from './compile-shared';

export interface CompileContext {
  readonly rootDir: string;
  /**
   * Paths the caller asked about (`--files`), or null for an unscoped run.
   * Rules are compiled to look only at these, which is what makes a scoped run
   * cheaper rather than merely quieter.
   */
  readonly requestedPaths?: readonly string[] | null | undefined;
  /**
   * Lazy: the CheckServices are created from the network, which is created
   * from the compiled extensions — resolved by the time scan() calls hooks.
   */
  readonly getServices: () => CheckServices;
  /**
   * Violations that could not be attached to a scanned file (unknown path).
   * The runner drains this after each scan. Only after-hook rules produce
   * these, and those re-run on every scan, so the channel is always fresh.
   */
  readonly pendingViolations?: Violation[];
  /**
   * Shared set of known file paths backing the synchronous
   * `services.imports.resolve`. After-hook rules refill it from storage
   * before running so import resolution sees the fresh file set.
   */
  readonly sharedPaths?: Set<string>;
}

function gesetzFileFromSource(file: SourceFile, content: string): File {
  const relativePath = file.relativePath;
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const ext = file.extension;
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
  const slash = relativePath.lastIndexOf('/');
  return {
    path: relativePath,
    absolutePath: file.absolutePath,
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : relativePath.slice(0, slash),
    content,
    size: file.byteSize,
    mtimeMs: 0,
  };
}

/**
 * A `File` for a record in storage, without going through a `SourceFile`.
 *
 * `gesetzFileFromSource` takes netzwerk's own source-file type, which the scan
 * builds. A project rule walks the stored records instead, so it builds the same
 * shape from a path and the content it read.
 */
function fileFromRecord(rootDir: string, relativePath: string, content: string): File {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const ext = nodePath.extname(name);
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
  const slash = relativePath.lastIndexOf('/');
  return {
    path: relativePath,
    absolutePath: nodePath.join(rootDir, relativePath),
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : relativePath.slice(0, slash),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// ─── per-file rules ──────────────────────────────────────────────────────────

/**
 * Compiles a rule whose checks consult the file system into a project rule.
 *
 * It runs once per scan over every file the rule matches, in memory — no parsing,
 * just `fs.exists` against the network — and reports which paths it examined, so
 * the marks of everything else are left alone. It re-runs whenever a file is
 * added, changed or removed inside its patterns, which is exactly when a
 * `requireSibling`-style answer can change.
 */
function compilePerFileRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  const perFile = rule.perFile!;
  return {
    name: rule.id,
    fingerprint: ruleFingerprint(rule),
    // Deliberately NOT narrowed to the request. A rule whose file list is narrowed
    // never examines the files it left out, and an unexamined file has no marks —
    // so a later `--files` request for one of them would find nothing to report
    // and read as clean. The saving would be small anyway: a caller asking about
    // the files it just edited has already narrowed the changed set to those same
    // files. What a scoped run does not report, it still leaves correct.
    include: [...perFile.patterns],
    ...(perFile.exclusions.length > 0 ? { exclude: [...perFile.exclusions] } : {}),

    async process(file, content) {
      const services = ctx.getServices();
      const gesetzFile = gesetzFileFromSource(file, content);
      if (!perFile.predicates.every((pred) => pred(gesetzFile))) return [];

      const violations: Violation[] = [];
      for (const [index, check] of perFile.checks.entries()) {
        try {
          violations.push(...(await check(gesetzFile, services)));
        } catch (cause) {
          // A throwing check used to contribute nothing, which is
          // indistinguishable from "this file is clean" — the fail-open shape
          // this project exists to find in other codebases. A broken check is
          // reported instead, matching how a throwing rule is handled in
          // compileRunOnlyRule.
          violations.push({
            rule: rule.id,
            message: `Check #${index + 1} threw: ${String(cause)}. This file was not fully checked.`,
            path: gesetzFile.path,
            severity: 'error',
            source: 'core',
          });
        }
      }
      return violations.map((violation) =>
        violationToMarker({ ...violation, rule: violation.rule ?? rule.id }, rule),
      );
    },
  };
}

// ─── after-hook rules (project + run-only) ──────────────────────────────────

/** Groups violations by repo-relative path; absolute paths are relativized. */
/** Legacy service shims: the old Effect tags backed by the async services bag. */
function shimLayers(
  services: CheckServices,
  rootDir: string,
): Layer.Layer<FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter> {
  return Layer.mergeAll(
    Layer.succeed(FileSystem, {
      glob: (pattern, options) => Effect.promise(() => services.fs.glob(pattern, options)),
      readFile: (absolutePath) => Effect.promise(() => services.fs.readFile(absolutePath)),
      exists: (absolutePath) => Effect.promise(() => services.fs.exists(absolutePath)),
    }),
    Layer.succeed(SyntaxTree, {
      canProcess: (file) => services.syntax.canProcess(file),
      process: (file, options) =>
        Effect.tryPromise({
          try: () => services.syntax.process(file, options),
          catch: (e) => new SyntaxTreeError({ cause: String(e) }),
        }),
    }),
    Layer.succeed(ImportResolver, {
      resolve: (fromFile, specifier) => services.imports.resolve(fromFile, specifier),
    }),
    Layer.succeed(ProjectRoot, rootDir),
    FileFilterLive(null),
  );
}

/** Storage-backed NetworkFile facade for project rules. */
function compileRunOnlyRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  return {
    name: rule.id,
    fingerprint: ruleFingerprint(rule),

    // Conservative: re-executes on every scan (legacy behavior). Violation
    // markers are replaced wholesale per path, so warm runs stay correct.
    async after(entries, extCtx) {
      await refreshSharedPaths(ctx, extCtx);
      let violations: Violation[];
      try {
        violations = await Effect.runPromise(
          Effect.provide(rule.run, shimLayers(ctx.getServices(), ctx.rootDir)),
        );
      } catch (cause) {
        // Defensive: mirrors the legacy runner's catchAllCause.
        violations = [
          {
            rule: rule.id,
            message: `Rule threw an unexpected error: ${String(cause)}`,
            path: ctx.rootDir,
            severity: 'error',
            source: 'core',
          },
        ];
      }
      await storeProjectViolations(extCtx.storage, rule, violations, ctx);
    },
  };
}

function compileProjectRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  const project = rule.project!;
  return {
    name: rule.id,
    fingerprint: ruleFingerprint(rule),

    async after(entries, extCtx) {
      // Skip when nothing relevant changed — cached markers survive. Runs
      // when any reprocessed OR REMOVED file matches the rule's patterns
      // (a deletion can dissolve a cycle / layer violation), or when the
      // rule has never produced markers (first scan / fingerprint reset).
      const reprocessed = entries.map((entry) => entry.path);
      // A scoped run only cares about the files it was asked about. Everything
      // else is somebody else's question, and its marks stay as they are.
      const requested = ctx.requestedPaths ?? null;
      const changed =
        requested === null ? reprocessed : reprocessed.filter((path) => requested.includes(path));
      const removed =
        requested === null
          ? extCtx.removedPaths
          : extCtx.removedPaths.filter((path) => requested.includes(path));
      const relevant = micromatch.some([...changed, ...removed], [...project.patterns], {
        dot: true,
      });
      if (!relevant && (await hasStoredMarkers(extCtx.storage, rule.id))) return;

      await refreshSharedPaths(ctx, extCtx);
      let violations: Violation[];
      let examinedPaths: readonly string[] | undefined;
      try {
        const outcome = await project.run(projectRuleContext(extCtx, ctx, changed, requested));
        if ('violations' in outcome) {
          violations = [...outcome.violations];
          examinedPaths = outcome.examinedPaths;
        } else {
          violations = [...outcome];
        }
      } catch (cause) {
        // A project rule that threw contributes nothing otherwise, which is
        // indistinguishable from "this project is clean". Adapters reach here
        // when their tool cannot run, so the failure must be reported.
        violations = [
          {
            rule: rule.id,
            message: `Rule threw an unexpected error: ${String(cause)}`,
            path: ctx.rootDir,
            severity: 'error',
            source: 'core',
          },
        ];
      }
      await storeProjectViolations(extCtx.storage, rule, violations, ctx, examinedPaths);
    },
  };
}

/** Refills the shared path set from storage so imports.resolve is fresh. */
/** Compiles one rule to a netzwerk extension. */
export function compileRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  if (rule.perFile !== undefined) {
    return needsFileSet(rule) ? compileFileSetRule(rule, ctx) : compilePerFileRule(rule, ctx);
  }
  if (rule.project !== undefined) return compileProjectRule(rule, ctx);
  return compileRunOnlyRule(rule, ctx);
}

/**
 * Compiles a full config: the syntax extension FIRST (its markers must exist
 * before any rule extension processes the same file), then one extension
 * per rule.
 */
export function compileConfig(config: ResolvedConfig, ctx: CompileContext): NetworkExtension[] {
  return [syntaxExtension(config.adapters), ...config.rules.map((rule) => compileRule(rule, ctx))];
}
