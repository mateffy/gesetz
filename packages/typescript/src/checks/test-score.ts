import type { Check, Violation } from '@gesetz/core';

export interface TestScoring {
  /** Minimum score required. Files below this score get a violation. */
  minScore: number;
  /** Score thresholds for assertion count bonuses. Default: [1, 3, 5, 8] */
  assertionThresholds?: number[];
  /** Score points per assertion threshold crossed. Default: 5 */
  assertionBonus?: number;
  /** Score thresholds for test count bonuses. Default: [2, 4, 6] */
  testCountThresholds?: number[];
  /** Score points per test count threshold crossed. Default: 5 */
  testCountBonus?: number;
  /** Function names counted as assertions. Default includes expect() patterns. */
  assertionNames?: string[];
  /** Patterns that indicate trivial assertions (penalty applies). Default: toBeTrue, toBeTruthy, toBeDefined */
  trivialAssertions?: string[];
  /** Score penalty for files with only trivial assertions. Default: -20 */
  trivialPenalty?: number;
  /** Patterns indicating async tests. Default: waitFor, act */
  asyncIndicators?: string[];
  /** Patterns indicating user interaction tests. Default: userEvent, fireEvent */
  interactionMethods?: string[];
  /** Patterns indicating error path tests. Default: toThrow, rejects */
  errorIndicators?: string[];
  /** Bonus per async test found */
  asyncBonus?: number;
  /** Bonus per interaction test found */
  interactionBonus?: number;
  /** Bonus for having error path tests */
  errorBonus?: number;
  /** Bonus for having varied assertion types (not all the same) */
  varietyBonus?: number;
}

/** Default scoring weights. Overridable per call via `TestScoring`. */
const ASSERTION_THRESHOLDS = [1, 3, 5, 8];
const ASSERTION_BONUS = 5;
const TEST_COUNT_THRESHOLDS = [2, 4, 6];
const TEST_COUNT_BONUS = 5;
const TRIVIAL_PENALTY = -20;
const ASYNC_BONUS = 5;
const INTERACTION_BONUS = 5;
const ERROR_BONUS = 5;
const VARIETY_BONUS = 5;
/** How many distinct assertion kinds count as "varied". */
const VARIETY_MIN_KINDS = 3;
/** Score every file starts from, before bonuses and penalties. */
const BASE_SCORE = 40;

/**
 * Scores a test file based on quality signals (assertion count, async tests,
 * interaction coverage, error paths) and returns a violation if below `minScore`.
 *
 * This is the generalized version of immoui's test-quality.test.ts scoring system.
 *
 * @example
 * requireMinTestScore({ minScore: 50 })
 */
export function requireMinTestScore(scoring: TestScoring): Check {
  const {
    minScore,
    assertionThresholds = ASSERTION_THRESHOLDS,
    assertionBonus = ASSERTION_BONUS,
    testCountThresholds = TEST_COUNT_THRESHOLDS,
    testCountBonus = TEST_COUNT_BONUS,
    assertionNames = ['expect('],
    trivialAssertions = ['toBeTrue(', 'toBeTruthy(', 'toBeDefined('],
    trivialPenalty = TRIVIAL_PENALTY,
    asyncIndicators = ['waitFor(', 'act('],
    interactionMethods = ['userEvent.', 'fireEvent.'],
    errorIndicators = ['.toThrow(', '.rejects.', 'toThrow('],
    asyncBonus = ASYNC_BONUS,
    interactionBonus = INTERACTION_BONUS,
    errorBonus = ERROR_BONUS,
    varietyBonus = VARIETY_BONUS,
  } = scoring;

  return async (file) => {
    const content = file.content;

    const assertionCount = assertionNames.reduce(
      (sum, name) => sum + (content.split(name).length - 1),
      0,
    );

    const testCount =
      (content.split('it(').length - 1) +
      (content.split('test(').length - 1);

    const hasTrivial = trivialAssertions.some((t) => content.includes(t));
    const hasAsync = asyncIndicators.some((a) => content.includes(a));
    const hasInteraction = interactionMethods.some((m) => content.includes(m));
    const hasErrors = errorIndicators.some((e) => content.includes(e));

    // Collect all assertion types used
    const assertionTypes = new Set<string>();
    const assertionTypePattern = /\.(to[A-Z][a-zA-Z]+|not\.[a-zA-Z]+)\(/g;
    for (const match of content.matchAll(assertionTypePattern)) {
      assertionTypes.add(match[1] ?? '');
    }
    const hasVariety = assertionTypes.size >= VARIETY_MIN_KINDS;

    // Base score for having any tests at all.
    let score = BASE_SCORE;

    // Assertion count bonuses
    for (const threshold of assertionThresholds) {
      if (assertionCount >= threshold) score += assertionBonus;
    }

    // Test count bonuses
    for (const threshold of testCountThresholds) {
      if (testCount >= threshold) score += testCountBonus;
    }

    // Quality bonuses
    if (hasAsync) score += asyncBonus;
    if (hasInteraction) score += interactionBonus;
    if (hasErrors) score += errorBonus;
    if (hasVariety) score += varietyBonus;

    // Trivial assertion penalty
    if (hasTrivial && assertionCount > 0) {
      const isTrivialOnly = !errorIndicators.some((e) => content.includes(e)) &&
        !interactionMethods.some((m) => content.includes(m));
      if (isTrivialOnly) score += trivialPenalty;
    }

    if (score >= minScore) return [];

    return [
      {
        severity: 'warn',
        source: 'core',
        message: `Test quality score ${score} is below minimum ${minScore}. Add more assertions, async tests, or interaction coverage.`,
        path: file.path,
      },
    ];
  };
}
