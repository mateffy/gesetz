/**
 * Violation ⇄ marker contract.
 *
 * Every gesetz Violation is stored as one netzwerk marker under the
 * `gesetz` extension namespace (public type `gesetz.violation`). The marker
 * denormalizes `rule`, `description`, and `category` into `data` so the
 * runner can rebuild RuleResults from markers alone — exemptions, thresholds,
 * `--files`, `--since`, and `--category` stay aggregation-time filters that
 * never invalidate the marker cache.
 */
import type { FileMarker } from "netzwerk";
import type { Violation } from "../engine/rule";

/** Extension namespace all gesetz-produced violation markers live under. */
export const GESETZ_EXTENSION = "gesetz";

/** Marker type within the gesetz namespace. */
export const VIOLATION_TYPE = "violation";

/** Public, namespaced marker type: `gesetz.violation`. */
export const VIOLATION_MARKER_TYPE = `${GESETZ_EXTENSION}.${VIOLATION_TYPE}`;

export interface ViolationMarkerData {
  readonly rule: string;
  readonly description: string;
  readonly category: string | null;
  readonly message: string;
  readonly severity: "error" | "warn" | "info";
  readonly source: "core" | "eslint" | "phpstan" | "oxlint" | "custom";
  readonly column?: number;
  readonly context?: string;
  readonly fix?: string;
}

export type ViolationMarker = FileMarker<ViolationMarkerData>;

/**
 * Maps a Violation to a netzwerk marker. `rule` supplies the denormalized
 * identity (id, description, category); `violation.rule` wins when present.
 */
export function violationToMarker(
  violation: Violation,
  rule: { id: string; description: string; category?: string | undefined },
): { type: "violation"; data: ViolationMarkerData; lines?: readonly [number] } {
  const data: ViolationMarkerData = {
    rule: violation.rule ?? rule.id,
    description: rule.description,
    category: rule.category ?? null,
    message: violation.message,
    severity: violation.severity,
    source: violation.source,
    ...(violation.column !== undefined ? { column: violation.column } : {}),
    ...(violation.context !== undefined ? { context: violation.context } : {}),
    ...(violation.fix !== undefined ? { fix: violation.fix } : {}),
  };
  return {
    type: VIOLATION_TYPE,
    data,
    ...(violation.line !== undefined ? { lines: [violation.line] as const } : {}),
  };
}

/**
 * True when the marker is a violation marker. Each rule is its own netzwerk
 * extension (so per-file marker replacement is rule-scoped), which makes the
 * public type `<rule-id>.violation` — match the unprefixed type.
 */
export function isViolationMarker(marker: FileMarker): boolean {
  return marker.type === VIOLATION_TYPE || marker.type.endsWith(`.${VIOLATION_TYPE}`);
}

/**
 * Rebuilds a Violation from a stored marker. `path` comes from the file the
 * marker is attached to (markers carry no path of their own).
 */
export function markerToViolation(
  path: string,
  marker: { type: string; data: unknown; lines?: readonly number[] },
): Violation {
  const data = marker.data as ViolationMarkerData;
  const line = marker.lines?.[0];
  return {
    rule: data.rule,
    message: data.message,
    path,
    ...(line !== undefined ? { line } : {}),
    ...(data.column !== undefined ? { column: data.column } : {}),
    severity: data.severity,
    ...(data.context !== undefined ? { context: data.context } : {}),
    ...(data.fix !== undefined ? { fix: data.fix } : {}),
    source: data.source,
  };
}
