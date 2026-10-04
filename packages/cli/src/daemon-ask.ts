/**
 * Asking a daemon for one check, and saying in words what happened.
 *
 * Kept out of the command body for two reasons: `main.ts` is already the largest file
 * in the CLI, and the sentence a person reads afterwards is the part worth testing —
 * it is where "answered from a run that decided nothing about four rules" has to be
 * understandable rather than merely accurate.
 */
import { askDaemon } from '@gesetz/core';
import type { CheckSpec, DaemonResponse, RunResult } from '@gesetz/core';

/** Milliseconds in a second, for the notice's one conversion. */
const MS_PER_SECOND = 1_000;

export interface AskOutcome {
  /** The daemon's answer, or null when it could not be had. */
  readonly result: RunResult | null;
  /** One line for stderr, always present: the fallback must never be silent. */
  readonly notice: string;
}

/** The line that goes to stderr, for either outcome. */
export function describeDaemonAnswer(
  answer: DaemonResponse<RunResult> | null,
  now: number,
): string {
  if (answer === null) return 'daemon: no answer — running the check here instead';
  if (!answer.ok) return `daemon: ${answer.error} — running the check here instead`;
  if (answer.kind !== 'check') {
    return 'daemon: answered a control request to a check request — running the check here instead';
  }
  const ageSeconds = Math.max(0, now - answer.computedAt) / MS_PER_SECOND;
  const undecided =
    answer.checksNotRun.length === 0
      ? ''
      : ` — this request decided nothing about: ${answer.checksNotRun.join(', ')}`;
  return `daemon: answered from a state computed ${ageSeconds.toFixed(1)}s ago${undecided}`;
}

/** Asks, and never throws: a daemon that is unreachable is a fallback, not an error. */
export async function askDaemonForCheck(input: {
  readonly socketPath: string;
  readonly spec: CheckSpec;
  readonly waitMs: number;
  readonly now?: () => number;
}): Promise<AskOutcome> {
  const now = input.now ?? Date.now;
  const answer = await askDaemon<RunResult>(input.socketPath, {
    v: 1,
    id: `check-${process.pid}-${now()}`,
    kind: 'check',
    spec: input.spec,
    waitMs: input.waitMs,
  });
  const notice = describeDaemonAnswer(answer, now());
  const result = answer !== null && answer.ok && answer.kind === 'check' ? answer.envelope : null;
  return { result, notice };
}
