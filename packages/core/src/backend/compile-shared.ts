/**
 * Helpers shared by the rule compilers.
 *
 * They live here rather than in `compile.ts` so that both it and
 * `file-set-rule.ts` can use them without importing each other: a rule compiler
 * that needs to read the storage and one that needs to write to it are two
 * modules, not a cycle.
 */
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ExtensionContext, NetworkFile } from 'netzwerk';
import { globMatch } from 'netzwerk';
import type { ProjectRuleContext, Rule } from '../engine/rule';
import type { CompileContext } from './compile';

export async function networkFileFromStorage(
  storage: ExtensionContext['storage'],
  rootDir: string,
  path: string,
): Promise<NetworkFile> {
  const stored = await storage.markersFor(path);
  // Raw `type` plus `extension`, matching what netzwerk hands back for a file it
  // processed. Prefixing the type instead produced `gesetz-syntax.import`, which
  // this module's own `markersOf` matched but netzwerk did not: `resolveImportEdges`
  // requires `type === 'import'` and silently skips anything else, so the import
  // graph and cycle detection were dead on every path that reads from storage.
  const markers = stored.map((m) => ({
    type: m.type,
    extension: m.extension,
    data: m.data,
    ...(m.lines === undefined ? {} : { lines: m.lines }),
  }));
  return {
    path,
    markers,
    hasMarker(type: string) {
      return markers.some((m) => m.type === type);
    },
    markersOf(type: string) {
      return markers.filter((m) => m.type === type) as never;
    },
    content: () => readFile(nodePath.join(rootDir, path), 'utf8'),
  };
}

export async function refreshSharedPaths(
  ctx: CompileContext,
  extCtx: ExtensionContext,
): Promise<void> {
  if (ctx.sharedPaths === undefined) return;
  ctx.sharedPaths.clear();
  for (const record of await extCtx.storage.listFiles()) ctx.sharedPaths.add(record.path);
}

export async function hasStoredMarkers(
  storage: ExtensionContext['storage'],
  ruleId: string,
): Promise<boolean> {
  for (const [, markers] of await storage.allMarkers()) {
    if (markers.some((m) => m.extension === ruleId)) return true;
  }
  return false;
}

export function projectRuleContext(
  extCtx: ExtensionContext,
  ctx: CompileContext,
  changedFiles: readonly string[],
  requestedPaths: readonly string[] | null,
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
    requestedPaths,
    rootDir: ctx.rootDir,
  };
}

function hash(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function ruleFingerprint(rule: Rule): string {
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
