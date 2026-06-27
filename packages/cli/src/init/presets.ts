/**
 * Preset definitions.
 *
 * Presets compose via the blueprint catalog: `react = generic + react-set`,
 * `tanstack-start = react + ts-set`, `laravel` = the 5 PHP rules.
 * `PRESET_CHOICES` is the `Prompt.select` choices array.
 */
import type { PresetId } from './detect';
import { BLUEPRINTS, type RuleBlueprint } from './rules';

export const PRESETS: Record<PresetId, RuleBlueprint[]> = {
  blank: [],
  generic: BLUEPRINTS.filter((b) => b.presets.has('generic')),
  react: BLUEPRINTS.filter((b) => b.presets.has('react')),
  'tanstack-start': BLUEPRINTS.filter((b) => b.presets.has('tanstack-start')),
  laravel: BLUEPRINTS.filter((b) => b.presets.has('laravel')),
};

export interface PresetChoice {
  readonly title: string;
  readonly value: PresetId;
  readonly description: string;
}

export const PRESET_CHOICES: PresetChoice[] = [
  { title: 'blank', value: 'blank', description: 'Empty config \u2014 build from scratch' },
  { title: 'generic', value: 'generic', description: 'Framework-agnostic TS/JS quality rules' },
  { title: 'react', value: 'react', description: 'Generic React app (Vite/Next)' },
  { title: 'tanstack-start', value: 'tanstack-start', description: 'TanStack Start: route discipline + domains' },
  { title: 'laravel', value: 'laravel', description: 'Laravel/PHP: strict types, PSR-4, no raw DB' },
];
