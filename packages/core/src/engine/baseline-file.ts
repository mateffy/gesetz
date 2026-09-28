/**
 * Violation baseline — persistence.
 *
 * The file lives at the project root, belongs in git, and has a deterministic
 * byte order so the diff is stable and a reviewer can see exactly what moved.
 * The domain types and the hash live in `baseline.ts`.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { BaselineFileError } from './errors';
import {
  BASELINE_FILE_NAME,
  BASELINE_FILE_VERSION,
  normalizePath,
  type BaselineEntry,
  type BaselineFile,
  type LocatedEntry,
} from './baseline';

/** Stable bytes: same input, same file. */
export function serializeBaseline(file: BaselineFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function baselinePathFor(projectRoot: string): string {
  return nodePath.join(projectRoot, BASELINE_FILE_NAME);
}

/** Writes the baseline file atomically so a crash cannot truncate it. */
export function writeBaselineFile(path: string, file: BaselineFile): void {
  const temporaryPath = `${path}.tmp`;
  nodeFs.writeFileSync(temporaryPath, serializeBaseline(file), 'utf-8');
  nodeFs.renameSync(temporaryPath, path);
}

/** The path each entry was recorded under. */
export function locate(file: BaselineFile): LocatedEntry[] {
  const located: LocatedEntry[] = [];
  for (const [path, list] of Object.entries(file.entries)) {
    for (const entry of list) located.push({ path: normalizePath(path), entry });
  }
  return located;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is BaselineEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value['rule'] === 'string' &&
    typeof value['hash'] === 'string' &&
    typeof value['message'] === 'string' &&
    typeof value['count'] === 'number' &&
    value['count'] > 0 &&
    (value['line'] === undefined || typeof value['line'] === 'number')
  );
}

/**
 * Reads `.gesetz-baseline.json`. Returns null when the file is absent.
 *
 * A malformed file throws. Ignoring it would silently turn every baselined
 * violation into a new one, or worse, into a pass — a gate that cannot read
 * its own baseline must not guess.
 */
export function readBaselineFile(path: string): BaselineFile | null {
  if (!nodeFs.existsSync(path)) return null;
  const text = nodeFs.readFileSync(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new BaselineFileError({
      path,
      message: `${path} is not valid JSON: ${String(cause)}`,
      cause,
    });
  }
  if (!isRecord(raw)) {
    throw new BaselineFileError({ path, message: `${path} is not a JSON object.` });
  }
  if (raw['version'] !== BASELINE_FILE_VERSION) {
    throw new BaselineFileError({
      path,
      message: `${path} has version ${String(raw['version'])}; this gesetz reads version ${BASELINE_FILE_VERSION}.`,
    });
  }
  if (!isRecord(raw['entries'])) {
    throw new BaselineFileError({ path, message: `${path} has no "entries" object.` });
  }
  const entries: Record<string, BaselineEntry[]> = {};
  for (const [key, value] of Object.entries(raw['entries'])) {
    if (!Array.isArray(value)) {
      throw new BaselineFileError({
        path,
        message: `${path} has a malformed entry under "${key}".`,
      });
    }
    const list: BaselineEntry[] = [];
    for (const candidate of value) {
      if (!isEntry(candidate)) {
        throw new BaselineFileError({
          path,
          message: `${path} has a malformed entry under "${key}".`,
        });
      }
      list.push(candidate);
    }
    entries[normalizePath(key)] = list;
  }
  const total = Object.values(entries).reduce(
    (sum, list) => sum + list.reduce((listSum, entry) => listSum + entry.count, 0),
    0,
  );
  return {
    version: BASELINE_FILE_VERSION,
    gesetz: typeof raw['gesetz'] === 'string' ? raw['gesetz'] : 'unknown',
    total,
    entries,
  };
}
