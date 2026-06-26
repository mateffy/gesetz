import { Effect } from 'effect';
import type { Check } from '@regeln/core';

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
    assertionThresholds = [1, 3, 5, 8],
    assertionBonus = 5,
    testCountThresholds = [2, 4, 6],
    testCountBonus = 5,
    assertionNames = ['expect('],
    trivialAssertions = ['toBeTrue(', 'toBeTruthy(', 'toBeDefined('],
    trivialPenalty = -20,
    asyncIndicators = ['waitFor(', 'act('],
    interactionMethods = ['userEvent.', 'fireEvent.'],
    errorIndicators = ['.toThrow(', '.rejects.', 'toThrow('],
    asyncBonus = 5,
    interactionBonus = 5,
    errorBonus = 5,
    varietyBonus = 5,
  } = scoring;

  return (file) =>
    Effect.sync(() => {
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
      const hasVariety = assertionTypes.size >= 3;

      let score = 40; // base score for having any tests

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
          rule: '',
          severity: 'warn' as const,
          source: 'core' as const,
          message: `Test quality score ${score} is below minimum ${minScore}. Add more assertions, async tests, or interaction coverage.`,
          path: file.path,
        },
      ];
    });
}
