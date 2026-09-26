import { describe, it, expect } from 'vitest';
import { PRESETS, PRESET_CHOICES } from '../../src/init/presets';
import { BLUEPRINTS } from '../../src/init/rules';

describe('PRESETS', () => {
  it('has an entry for every preset id the choices offer', () => {
    for (const choice of PRESET_CHOICES) {
      expect(PRESETS[choice.value], choice.value).toBeDefined();
    }
  });

  it('gives the blank preset no rules, which is its purpose', () => {
    expect(PRESETS.blank).toEqual([]);
  });

  it('selects only blueprints that declare the preset', () => {
    // The filter is the contract: a blueprint appears in a preset only when it
    // opted in, so adding a rule to a preset is a blueprint change, not a map change.
    for (const [preset, blueprints] of Object.entries(PRESETS)) {
      if (preset === 'blank') continue;
      for (const b of blueprints) {
        expect(b.presets.has(preset as never), `${b.id} in ${preset}`).toBe(true);
      }
    }
  });

  it('draws every blueprint in a preset from the catalog', () => {
    const ids = new Set(BLUEPRINTS.map((b) => b.id));
    for (const blueprints of Object.values(PRESETS)) {
      for (const b of blueprints) expect(ids.has(b.id), b.id).toBe(true);
    }
  });

  it('does not repeat a blueprint within a preset', () => {
    for (const [preset, blueprints] of Object.entries(PRESETS)) {
      const ids = blueprints.map((b) => b.id);
      expect(new Set(ids).size, preset).toBe(ids.length);
    }
  });
});

describe('PRESET_CHOICES', () => {
  it('offers every preset exactly once', () => {
    const values = PRESET_CHOICES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(values)).toEqual(new Set(Object.keys(PRESETS)));
  });

  it('gives each choice a title and a description for the wizard', () => {
    for (const c of PRESET_CHOICES) {
      expect(c.title.length, c.value).toBeGreaterThan(0);
      expect(c.description.length, c.value).toBeGreaterThan(0);
    }
  });
});
