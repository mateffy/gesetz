/**
 * The daemon's wire protocol: JSON Lines over a unix socket.
 *
 * Deliberately dumb, and deliberately here rather than in the CLI. It knows how to
 * turn a request and a response into bytes and back, and nothing about sockets,
 * checks, or the shape of a result — so both sides of the conversation can be tested
 * without either, and the server can be driven by a fake runner. It lives in core
 * because the server lives in core; putting it in the CLI would make core import the
 * command layer, which is the one direction that must not happen.
 *
 * The envelope a check produces is opaque here: `DaemonResponse<Envelope>` is generic
 * over it, so this module never learns what a violation looks like.
 */

/** A request names paths and rules, so a megabyte is generous. */
export const MAX_REQUEST_BYTES = 1 << 20;

/**
 * A response can carry every violation in a project, with messages. 64 MiB is far
 * above any real answer and low enough that a runaway process cannot exhaust the
 * client's memory before the cap is noticed.
 */
export const MAX_RESPONSE_BYTES = 64 << 20;

/** What a request asks to be checked. */
export interface Scope {
  /** `--files`: globs, or null for the whole project. */
  readonly files: readonly string[] | null;
  /** `--since`. Two requests with different cuts cannot share one run. */
  readonly since: string | null;
}

/**
 * A check request, as the client states it.
 *
 * `instanceKey` is what makes two requests the same *question* — rules, thresholds,
 * baseline, storage. Two requests that agree on it can be answered by one run;
 * requests that do not, cannot, whatever their scopes.
 */
export interface CheckSpec {
  readonly instanceKey: string;
  readonly scope: Scope;
  /** `--rule`: ids and globs, already resolved, or null for every rule. */
  readonly rules: readonly string[] | null;
  /** `--category`. */
  readonly categories: readonly string[] | null;
  /** `--baseline` / `--no-baseline`. */
  readonly baseline: 'apply' | 'ignore';
}

export type DaemonRequest =
  | { readonly v: 1; readonly id: string; readonly kind: 'status' }
  | { readonly v: 1; readonly id: string; readonly kind: 'shutdown' }
  | {
      readonly v: 1;
      readonly id: string;
      readonly kind: 'check';
      readonly spec: CheckSpec;
      /** How long the client is willing to wait, in milliseconds. */
      readonly waitMs: number;
    };

/**
 * What the daemon answers.
 *
 * `checksNotRun` is the load-bearing field: a rule this response could not decide —
 * because the request excluded it, or because its scope needed files outside the
 * request — is named there. An empty list is a claim that every rule was decided,
 * and that claim has to be earned.
 */
export type DaemonResponse<TEnvelope = unknown> =
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: true;
      /** A health probe or a shutdown, which carry their own small payload. */
      readonly kind: 'control';
      readonly envelope: unknown;
      readonly checksNotRun: readonly string[];
      readonly computedAt: number;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: true;
      /** A check, whose payload is whatever the caller's engine produces. */
      readonly kind: 'check';
      readonly envelope: TEnvelope;
      readonly servedFrom: 'recomputed' | 'cache' | 'mixed';
      readonly checksNotRun: readonly string[];
      /** When the tree state this answers for was computed, in ms epoch. */
      readonly computedAt: number;
    }
  | { readonly v: 1; readonly id: string; readonly ok: false; readonly error: string };

/** One message, ready to write. Newline-terminated because the framing is lines. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function parseCheckSpec(value: unknown): CheckSpec | string {
  if (!isRecord(value)) return 'spec must be an object';
  const { instanceKey, scope, rules, categories, baseline } = value;
  if (typeof instanceKey !== 'string' || instanceKey === '') return 'spec.instanceKey is required';
  if (!isRecord(scope)) return 'spec.scope must be an object';
  const files = scope['files'];
  if (files !== null && !isStringArray(files)) return 'spec.scope.files must be an array or null';
  const since = scope['since'];
  if (since !== null && typeof since !== 'string') return 'spec.scope.since must be a string or null';
  if (rules !== null && !isStringArray(rules)) return 'spec.rules must be an array or null';
  if (categories !== null && !isStringArray(categories)) {
    return 'spec.categories must be an array or null';
  }
  if (baseline !== 'apply' && baseline !== 'ignore') return "spec.baseline must be 'apply' or 'ignore'";
  return {
    instanceKey,
    scope: { files: files === null ? null : [...files], since: since ?? null },
    rules: rules === null ? null : [...rules],
    categories: categories === null ? null : [...categories],
    baseline,
  };
}

/**
 * A request from a line.
 *
 * Returns a message rather than throwing: a malformed line is the client's mistake,
 * and the answer to it is an error response that names itself, not a crashed daemon
 * and not silence.
 */
export function decodeRequest(line: string): DaemonRequest | { readonly error: string } {
  if (line.length > MAX_REQUEST_BYTES) {
    return { error: `request is ${line.length} bytes, over the ${MAX_REQUEST_BYTES} byte cap` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return { error: `request is not JSON: ${String(cause)}` };
  }
  if (!isRecord(parsed)) return { error: 'request must be an object' };
  if (parsed['v'] !== 1) return { error: `unsupported protocol version ${String(parsed['v'])}` };
  const id = parsed['id'];
  if (typeof id !== 'string' || id === '') return { error: 'request.id is required' };

  const kind = parsed['kind'];
  if (kind === 'status' || kind === 'shutdown') return { v: 1, id, kind };
  if (kind !== 'check') return { error: `unknown request kind ${String(kind)}` };

  const spec = parseCheckSpec(parsed['spec']);
  if (typeof spec === 'string') return { error: spec };
  const waitMs = parsed['waitMs'];
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
    return { error: 'request.waitMs must be a non-negative number' };
  }
  return { v: 1, id, kind: 'check', spec, waitMs };
}

/** A response from a line. Validated for the same reason requests are. */
export function decodeResponse<TEnvelope>(line: string): DaemonResponse<TEnvelope> | { readonly error: string } {
  if (line.length > MAX_RESPONSE_BYTES) {
    return { error: `response is ${line.length} bytes, over the ${MAX_RESPONSE_BYTES} byte cap` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return { error: `response is not JSON: ${String(cause)}` };
  }
  if (!isRecord(parsed)) return { error: 'response must be an object' };
  const id = parsed['id'];
  if (typeof id !== 'string') return { error: 'response.id is required' };
  if (parsed['ok'] === false) {
    return { v: 1, id, ok: false, error: typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown error' };
  }
  if (parsed['ok'] !== true) return { error: 'response.ok must be true or false' };
  const checksNotRun = parsed['checksNotRun'];
  if (!isStringArray(checksNotRun)) return { error: 'response.checksNotRun must be an array' };
  const computedAt = parsed['computedAt'];
  if (typeof computedAt !== 'number') return { error: 'response.computedAt must be a number' };

  const kind = parsed['kind'];
  if (kind === 'control') {
    return { v: 1, id, ok: true, kind: 'control', envelope: parsed['envelope'], checksNotRun, computedAt };
  }
  if (kind !== 'check') return { error: `unknown response kind ${String(kind)}` };
  const servedFrom = parsed['servedFrom'];
  if (servedFrom !== 'recomputed' && servedFrom !== 'cache' && servedFrom !== 'mixed') {
    return { error: `unknown servedFrom ${String(servedFrom)}` };
  }
  return {
    v: 1,
    id,
    ok: true,
    kind: 'check',
    envelope: parsed['envelope'] as TEnvelope,
    servedFrom,
    checksNotRun,
    computedAt,
  };
}

/** Whether a decoded line is an error rather than a message. */
export function isDecodeError<T>(value: T | { readonly error: string }): value is { readonly error: string } {
  return isRecord(value) && typeof (value as { error?: unknown }).error === 'string' && !('v' in (value as object));
}
