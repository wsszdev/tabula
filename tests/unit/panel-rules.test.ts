import { describe, expect, it } from 'vitest';
import { factApplies, flagItemTooLoose, rulerApplies } from '../../packages/server/src/panel.ts';

describe('flag and fact matching', () => {
  const kingdom = { inception: 987, dissolved: 1792.7 };
  const modern = { inception: 843, dissolved: null };
  it('uses a stated period when there is one', () => {
    expect(factApplies(1600, { from: 1500, to: 1700 }, kingdom)).toBe('dated');
    expect(factApplies(1701, { from: 1500, to: 1700 }, kingdom)).toBe(false);
    expect(factApplies(1400, { from: 1500, to: 1700 }, kingdom)).toBe(false);
  });
  it('accepts an undated flag of a state that ended, within its life, flagged as such', () => {
    expect(factApplies(1789, { from: null, to: null }, kingdom)).toBe('undated');
    expect(factApplies(1800, { from: null, to: null }, kingdom)).toBe(false);
  });
  it('does not show the modern flag in the past', () => {
    expect(factApplies(1789, { from: null, to: null }, modern)).toBe(false);
    expect(factApplies(1950, { from: null, to: null }, modern)).toBe(false);
    expect(factApplies(2010, { from: null, to: null }, modern)).toBe('undated');
  });
  it('bounds an open-ended fact by the state itself', () => {
    expect(factApplies(1900, { from: 1700, to: null }, kingdom)).toBe(false);
  });
});

describe('ruler matching', () => {
  const louis = { birth: 1754, death: 1793.05 };
  it('requires a stated term', () => {
    expect(rulerApplies(1789, { from: null, to: null }, louis)).toBe(false);
    expect(rulerApplies(1789, { from: 1774.3, to: 1792.7 }, louis)).toBe(true);
    expect(rulerApplies(1793, { from: 1774.3, to: 1792.7 }, louis)).toBe(false);
  });
  it('ends an open term at death, or after a generation when death is unknown', () => {
    expect(rulerApplies(1800, { from: 1774.3, to: null }, louis)).toBe(false);
    expect(rulerApplies(1790, { from: 1774.3, to: null }, louis)).toBe(true);
    expect(rulerApplies(1900, { from: 1800, to: null }, { birth: null, death: null })).toBe(false);
  });
  it('rejects a term with only an end before the person was born', () => {
    expect(rulerApplies(1700, { from: null, to: 1792 }, louis)).toBe(false);
  });
});

describe('flag items', () => {
  it('does not apply today\'s design to a state\'s past', () => {
    expect(flagItemTooLoose({ property: 'P163', to_t: null }, { dissolved: null }, 1863)).toBe(true);
    expect(flagItemTooLoose({ property: 'P163', to_t: null }, { dissolved: null }, 2010)).toBe(false);
    expect(flagItemTooLoose({ property: 'P163', to_t: null }, { dissolved: 1918 }, 1900)).toBe(false);
    expect(flagItemTooLoose({ property: 'P41', to_t: null }, { dissolved: null }, 1863)).toBe(false);
  });
});
