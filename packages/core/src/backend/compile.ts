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
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import micromatch from "micromatch";
import { globMatch } from "netzwerk";
import type { ExtensionContext, NetworkExtension, NetworkFile, SourceFile } from "netzwerk";
import type { ResolvedConfig } from "../engine/config";
import type { CheckServices, File, ProjectRuleContext, Rule, Violation } from "../engine/rule";
import { FileSystem, FileFilter, FileFilterLive, ProjectRoot } from "../services/fs";
import { ImportResolver } from "../services/import-resolver";
import { SyntaxTree, SyntaxTreeError } from "../services/syntax-tree";
import { syntaxExtension } from "./syntax-extension";
import { violationToMarker } from "./violation-markers";

export interface CompileContext {
  readonly rootDir: string;
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

function hash(material: unknown): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function ruleFingerprint(rule: Rule): string {
  return hash({
    id: rule.id,
    category: rule.category ?? null,
    patterns: rule.perFile?.patterns ?? rule.project?.patterns ?? null,
    exclusions: rule.perFile?.exclusions ?? null,
    checks: rule.perFile?.checks.map((fn) => fn.toString()) ?? null,
    predicates: rule.perFile?.predicates.map((fn) => fn.toString()) ?? null,
    // NOTE: fn.toString() misses closed-over constant changes; checks built
    // by factories take options objects, so editing gesetz.config.ts changes
    // the produced source. Dynamically generated checks must bump the config
    // to invalidate — same class of risk as any build cache.
  });
}

function gesetzFileFromSource(file: SourceFile, content: string): File {
  const relativePath = file.relativePath;
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const ext = file.extension;
  const stem = ext === "" ? name : name.slice(0, name.length - ext.length);
  const slash = relativePath.lastIndexOf("/");
  return {
    path: relativePath,
    absolutePath: file.absolutePath,
    name,
    stem,
    ext,
    dir: slash === -1 ? "" : relativePath.slice(0, slash),
    content,
    size: file.byteSize,
    mtimeMs: 0,
  };
}

// ─── per-file rules ──────────────────────────────────────────────────────────

function compilePerFileRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  const perFile = rule.perFile!;
  return {
    name: rule.id,
    fingerprint: ruleFingerprint(rule),
    include: [...perFile.patterns],
    ...(perFile.exclusions.length > 0 ? { exclude: [...perFile.exclusions] } : {}),

    async process(file, content) {
      const services = ctx.getServices();
      const gesetzFile = gesetzFileFromSource(file, content);
      if (!perFile.predicates.every((pred) => pred(gesetzFile))) return [];

      const violations: Violation[] = [];
      for (const check of perFile.checks) {
        try {
          violations.push(...(await check(gesetzFile, services)));
        } catch {
          // Checks never throw — same contract as the legacy runner.
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
function groupByPath(
  violations: readonly Violation[],
  rootDir: string,
): { byPath: Map<string, Violation[]>; orphaned: Violation[] } {
  const byPath = new Map<string, Violation[]>();
  const orphaned: Violation[] = [];
  for (const violation of violations) {
    let rel = violation.path;
    if (nodePath.isAbsolute(violation.path)) {
      rel = nodePath.relative(rootDir, violation.path).split(nodePath.sep).join("/");
    }
    if (rel === "" || rel.startsWith("..")) {
      orphaned.push(violation);
      continue;
    }
    const list = byPath.get(rel) ?? [];
    list.push({ ...violation, path: rel });
    byPath.set(rel, list);
  }
  return { byPath, orphaned };
}

/**
 * Replaces this rule's stored violation markers with the fresh set: every
 * path that previously carried this rule's markers is overwritten (with the
 * empty set when the violation disappeared), and new paths are stored.
 */
async function storeProjectViolations(
  storage: ExtensionContext["storage"],
  rule: Rule,
  violations: readonly Violation[],
  ctx: CompileContext,
): Promise<void> {
  const { byPath, orphaned } = groupByPath(violations, ctx.rootDir);
  for (const [path, markers] of await storage.allMarkers()) {
    if (!byPath.has(path) && markers.some((m) => m.extension === rule.id)) {
      await storage.putMarkers(path, rule.id, []);
    }
  }
  for (const [path, pathViolations] of byPath) {
    if ((await storage.getFile(path)) === undefined) {
      orphaned.push(...pathViolations);
      continue;
    }
    await storage.putMarkers(
      path,
      rule.id,
      pathViolations.map((v) => violationToMarker({ ...v, rule: v.rule ?? rule.id }, rule)),
    );
  }
  if (orphaned.length > 0 && ctx.pendingViolations !== undefined) {
    ctx.pendingViolations.push(...orphaned);
  }
}

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
async function networkFileFromStorage(
  storage: ExtensionContext["storage"],
  rootDir: string,
  path: string,
): Promise<NetworkFile> {
  const stored = await storage.markersFor(path);
  const markers = stored.map((m) => ({
    type: `${m.extension}.${m.type}`,
    data: m.data,
    ...(m.lines === undefined ? {} : { lines: m.lines }),
  }));
  return {
    path,
    markers,
    hasMarker(type: string) {
      return markers.some((m) => m.type === type);
    },
    markersOf<D>(type: string) {
      return markers.filter((m) => m.type === type) as never;
    },
    content: () => readFile(nodePath.join(rootDir, path), "utf8"),
  };
}

function projectRuleContext(
  extCtx: ExtensionContext,
  ctx: CompileContext,
  changedFiles: readonly string[],
): ProjectRuleContext {
  return {
    network: {
      glob: async (pattern: string) => {
        const records = await extCtx.storage.listFiles();
        return Promise.all(
          records
            .filter((record) => globMatch(pattern, record.path))
            .map((record) => networkFileFromStorage(extCtx.storage, ctx.rootDir, record.path)),
        );
      },
      file: async (path: string) => {
        if ((await extCtx.storage.getFile(path)) === undefined) return null;
        return networkFileFromStorage(extCtx.storage, ctx.rootDir, path);
      },
    },
    changedFiles,
    rootDir: ctx.rootDir,
  };
}

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
            severity: "error",
            source: "core",
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
      const changed = entries.map((entry) => entry.path);
      const relevant = micromatch.some(
        [...changed, ...extCtx.removedPaths],
        [...project.patterns],
        { dot: true },
      );
      if (!relevant && (await hasStoredMarkers(extCtx.storage, rule.id))) return;

      await refreshSharedPaths(ctx, extCtx);
      const violations = await project.run(projectRuleContext(extCtx, ctx, changed));
      await storeProjectViolations(extCtx.storage, rule, violations, ctx);
    },
  };
}

/** Refills the shared path set from storage so imports.resolve is fresh. */
async function refreshSharedPaths(ctx: CompileContext, extCtx: ExtensionContext): Promise<void> {
  if (ctx.sharedPaths === undefined) return;
  ctx.sharedPaths.clear();
  for (const record of await extCtx.storage.listFiles()) ctx.sharedPaths.add(record.path);
}

async function hasStoredMarkers(
  storage: ExtensionContext["storage"],
  ruleId: string,
): Promise<boolean> {
  for (const [, markers] of await storage.allMarkers()) {
    if (markers.some((m) => m.extension === ruleId)) return true;
  }
  return false;
}

/** Compiles one rule to a netzwerk extension. */
export function compileRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  if (rule.perFile !== undefined) return compilePerFileRule(rule, ctx);
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
