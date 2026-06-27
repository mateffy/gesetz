/**
 * Test quality scoring — uses the requireMinTestScore core primitive.
 *
 * Adapted from immoui's test-quality.test.ts scoring algorithm.
 */
import { select } from '@gesetz/core';
import { requireMinTestScore } from '@gesetz/typescript';

export const testQualityScore = select('src/**/*.test.{ts,tsx}')
  .label('Test files must meet minimum quality score')
  .check(
    requireMinTestScore({
      minScore: 50,
      assertionThresholds: [1, 3, 5, 8],
      assertionBonus: 5,
      testCountThresholds: [2, 4, 6],
      testCountBonus: 5,
      trivialAssertions: ['toBeTrue(', 'toBeTruthy(', 'toBeDefined('],
      trivialPenalty: -20,
      asyncIndicators: ['waitFor(', 'act('],
      interactionMethods: ['userEvent.', 'fireEvent.'],
      errorIndicators: ['.toThrow(', '.rejects.', 'toThrow('],
      asyncBonus: 5,
      interactionBonus: 5,
      errorBonus: 5,
      varietyBonus: 5,
    }),
  );
