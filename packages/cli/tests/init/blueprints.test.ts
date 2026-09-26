import { describe, it, expect } from 'vitest';
import { BLUEPRINTS, getBlueprint, blueprintsForPreset, toolsForPreset } from '../../src/init/rules';

describe('BLUEPRINTS catalog', () => {
  it('is not empty', () => {
    expect(BLUEPRINTS.length).toBeGreaterThan(0);
  });

  it('gives every blueprint a unique kebab-case id', () => {
    const ids = BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every blueprint a label, description, and at least one preset', () => {
    for (const b of BLUEPRINTS) {
      expect(b.label.length, b.id).toBeGreaterThan(0);
      expect(b.description.length, b.id).toBeGreaterThan(0);
      expect(b.presets.size, b.id).toBeGreaterThan(0);
    }
  });

  it('emits source text for every blueprint, and every emit is deterministic', () => {
    // The emitted string is what lands in a generated config, so an emit that
    // throws or varies is a broken generator rather than a broken project.
    for (const b of BLUEPRINTS) {
      const first = b.emit({});
      expect(first.length, b.id).toBeGreaterThan(0);
      expect(b.emit({}), b.id).toBe(first);
    }
  });

});

describe('getBlueprint', () => {
  it('finds a blueprint by id', () => {
    expect(getBlueprint(BLUEPRINTS[0]!.id)?.id).toBe(BLUEPRINTS[0]!.id);
  });

  it('returns undefined for an unknown id rather than throwing', () => {
    expect(getBlueprint('no-such-blueprint')).toBeUndefined();
  });
});

describe('blueprintsForPreset', () => {
  it('returns only blueprints that opted into the preset', () => {
    for (const b of blueprintsForPreset('react')) expect(b.presets.has('react')).toBe(true);
  });

  it('returns the same list on repeat calls', () => {
    expect(blueprintsForPreset('generic').map((b) => b.id)).toEqual(blueprintsForPreset('generic').map((b) => b.id));
  });
});

describe('toolsForPreset', () => {
  it('is deterministic', () => {
    expect(toolsForPreset('generic')).toEqual(toolsForPreset('generic'));
  });

  it('only offers tool ids', () => {
    for (const t of toolsForPreset('generic')) expect(typeof t).toBe('string');
  });
});
