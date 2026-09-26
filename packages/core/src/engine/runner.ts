import * as childProcess from 'node:child_process';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { createNetwork } from 'netzwerk';
import type { Violation, Exemption, CheckServices } from './rule';
import type { ResolvedConfig } from './config';
import { compileConfig, type CompileContext } from '../backend/compile';
import { createCheckServices } from '../backend/check-services';
import { isViolationMarker, markerToViolation } from '../backend/violation-markers';

/** A category starts at this score and loses weight per violation. */
const MAX_SCORE = 10;
/** What each severity costs, matching the documented scoring formula. */
const SEVERITY_WEIGHT = { error: 1, warn: 0.5, info: 0.1 } as const;
/** A category must reach this score unless the config sets its own threshold. */
const DEFAULT_MIN_SCORE = 7;

export interface RuleResult {
  readonly ruleId: string;
  readonly description: string;
  readonly category: string | undefined;
  readonly violations: Violation[];
}

/**
 * Score for a single category, computed from all rules in that category.
 *
 * Score formula (same as Gesetz):
 *   weighted = errors * 1.0 + warnings * 0.5 + infos * 0.1
 *   score    = max(0, 10 - weighted)
 */
export interface CategoryScore {
  readonly category: string;
  /** 0–10, higher is better */
  readonly score: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly totalViolations: number;
  /** Rule IDs that contributed to this category */
  readonly ruleIds: string[];
  /** Whether this category meets its configured threshold */
  readonly passing: boolean;
}

export interface RunResult {
  readonly byRule: RuleResult[];
  readonly byCategory: CategoryScore[];
  readonly totalViolations: number;
  /** True when all category scores are at or above their thresholds */
  readonly passing: boolean;
}

export interface RunAllOptions {
  /**
   * When set (CLI `--files`), violations for files not matching these
   * micromatch globs are suppressed. Pure aggregation-time filter — the
   * marker cache is unaffected.
   */
  readonly fileFilter?: readonly string[] | null | undefined;
  /** Called with the scan statistics after each scan (for CLI reporting). */
  readonly onScan?: ((result: ScanStats) => void) | undefined;
}

/** Scan statistics from the incremental scanner (netzwerk ScanResult). */
export interface ScanStats {
  readonly filesSeen: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly reused: number;
  readonly durationMs: number;
}

/**
 * Resolves the git-changed file set for `changedSince`.
 * Returns `null` when not filtering (all files included).
 */
function resolveChangedFiles(
  changedSince: string | undefined,
  projectRoot: string,
): Set<string> | null {
  if (!changedSince) return null;
  try {
    const output = childProcess
      .execFileSync('git', ['diff', '--name-only', changedSince], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
      .trim();
    if (!output) return new Set();
    return new Set(output.split('\n').map((p) => p.trim()).filter(Boolean));
  } catch {
    // git not available or ref invalid — fall through to no filter
    return null;
  }
}

/**
 * Computes category scores from rule results and config thresholds.
 */
function computeCategoryScores(
  results: RuleResult[],
  thresholds: ResolvedConfig['thresholds'],
): CategoryScore[] {
  const byCategory = new Map<string, { errors: number; warnings: number; infos: number; ruleIds: string[] }>();

  for (const result of results) {
    if (!result.category) continue;
    const existing = byCategory.get(result.category) ?? { errors: 0, warnings: 0, infos: 0, ruleIds: [] };
    for (const v of result.violations) {
      if (v.severity === 'error') existing.errors++;
      else if (v.severity === 'warn') existing.warnings++;
      else existing.infos++;
    }
    existing.ruleIds.push(result.ruleId);
    byCategory.set(result.category, existing);
  }

  return Array.from(byCategory.entries()).map(([category, counts]) => {
    const weighted =
      counts.errors * SEVERITY_WEIGHT.error +
      counts.warnings * SEVERITY_WEIGHT.warn +
      counts.infos * SEVERITY_WEIGHT.info;
    const score = Math.max(0, Math.round((MAX_SCORE - weighted) * 10) / 10);
    const threshold = thresholds.find((t) => t.category === category)?.minScore ?? DEFAULT_MIN_SCORE;
    return {
      category,
      score,
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      totalViolations: counts.errors + counts.warnings + counts.infos,
      ruleIds: counts.ruleIds,
      passing: score >= threshold,
    };
  });
}

/**
 * Applies exemptions to a list of violations.
 * An exemption suppresses a violation when:
 * 1. The violation path matches the exemption path glob
 * 2. The violation rule matches the exemption rule glob (default: '*')
 * 3. The exemption is not expired (until date is absent or in the future)
 */
export function applyExemptions(
  violations: Violation[],
  exemptions: Exemption[],
  ruleId: string,
): Violation[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // An exemption suppresses only when all three hold: it has not expired, its
  // rule glob matches (default `*`), and its path glob matches.
  return violations.filter((violation) =>
    !exemptions.some((exemption) => {
      if (exemption.until !== undefined && exemption.until < today) return false;
      if (!micromatch.isMatch(ruleId, exemption.rule ?? '*')) return false;
      return micromatch.isMatch(violation.path, exemption.path);
    }),
  );
}

/**
 * Runs all rules in the config and returns a RunResult.
 *
 * Backend: rules are compiled to netzwerk extensions, the project is scanned
 * incrementally (content-hash diff; unchanged files keep their cached
 * violation markers), and violations are read back from marker storage and
 * aggregated. Exemptions, `--files`, and `--since` are aggregation-time
 * filters — they never invalidate the cache.
 */
export const runAll = (
  config: ResolvedConfig,
  options: RunAllOptions = {},
): Effect.Effect<RunResult, never, never> =>
  Effect.promise(async () => {
    const pendingViolations: Violation[] = [];
    const sharedPaths = new Set<string>();
    let services: CheckServices;
    const compileCtx: CompileContext = {
      rootDir: config.projectRoot,
      getServices: () => services,
      pendingViolations,
      sharedPaths,
    };
    const network = createNetwork({
      rootPath: config.projectRoot,
      extensions: compileConfig(config, compileCtx),
      // GesetzStorageConfig is structurally identical to NetworkStorageConfig.
      storage: config.storage as import('netzwerk').NetworkStorageConfig,
    });

    try {
      services = await createCheckServices(
        network,
        config.adapters,
        config.projectRoot,
        sharedPaths,
      );
      const scanResult = await network.scan();
      options.onScan?.(scanResult);

      // Collect stored violation markers, grouped by rule id.
      const violationsByRule = new Map<string, Violation[]>();
      const metaByRule = new Map<string, { description: string; category: string | undefined }>();
      const entries = await network.query({ limit: Number.MAX_SAFE_INTEGER });
      for (const entry of entries) {
        for (const marker of entry.markers) {
          if (!isViolationMarker(marker)) continue;
          const violation = markerToViolation(entry.path, marker);
          const ruleId = violation.rule ?? '';
          const list = violationsByRule.get(ruleId) ?? [];
          list.push(violation);
          violationsByRule.set(ruleId, list);
          if (!metaByRule.has(ruleId)) {
            const data = marker.data as { description: string; category: string | null };
            metaByRule.set(ruleId, {
              description: data.description,
              category: data.category ?? undefined,
            });
          }
        }
      }
      // Orphaned violations from after-hook rules (paths without a scanned
      // file record, e.g. the project root).
      for (const violation of pendingViolations) {
        const ruleId = violation.rule ?? '';
        const list = violationsByRule.get(ruleId) ?? [];
        list.push(violation);
        violationsByRule.set(ruleId, list);
      }

      const changedFiles = resolveChangedFiles(config.changedSince, config.projectRoot);
      const fileFilter = options.fileFilter ?? null;
      const fileFilterActive = fileFilter !== null && fileFilter.length > 0;

      const buildResult = (
        ruleId: string,
        description: string,
        category: string | undefined,
      ): RuleResult => {
        let violations = violationsByRule.get(ruleId) ?? [];
        if (fileFilterActive) {
          violations = violations.filter((v) => micromatch.isMatch(v.path, fileFilter));
        }
        if (changedFiles !== null) {
          violations = violations.filter((v) => changedFiles.has(v.path));
        }
        violations = applyExemptions(violations, config.exemptions, ruleId);
        return { ruleId, description, category, violations };
      };

      // Rule results in config order; ids seen only in storage (stale rules
      // from a previous config) trail at the end.
      const configIds = new Set(config.rules.map((r) => r.id));
      const results: RuleResult[] = config.rules.map((rule) =>
        buildResult(rule.id, rule.description, rule.category),
      );
      for (const [ruleId, violations] of violationsByRule) {
        if (configIds.has(ruleId) || violations.length === 0) continue;
        const meta = metaByRule.get(ruleId);
        results.push(buildResult(ruleId, meta?.description ?? ruleId, meta?.category));
      }

      const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);
      const byCategory = computeCategoryScores(results, config.thresholds);
      // `every` is vacuously true on an empty list, so no separate length check is needed
      const passing = byCategory.every((c) => c.passing);

      return { byRule: results, byCategory, totalViolations, passing };
    } finally {
      await network.close();
    }
  });
