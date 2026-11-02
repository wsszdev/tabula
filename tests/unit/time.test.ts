import { describe, expect, it } from 'vitest';
import { astroToYear, dateToT, formatRange, formatYear, isValidAt, overlaps, parseYear, posToYear, setForT, sparqlTimeToT, wikidataTimeToT, yearToAstro, yearToPos, yearToT } from '@tabula/shared';

describe('historical dates', () => {
  it('has no year zero', () => {
    expect(yearToAstro(1)).toBe(1);
    expect(yearToAstro(-1)).toBe(0);
    expect(yearToAstro(-44)).toBe(-43);
    expect(astroToYear(0)).toBe(-1);
    expect(astroToYear(-43)).toBe(-44);
    expect(() => yearToAstro(0)).toThrow();
  });
  it('round-trips years', () => {
    for (const y of [-123000, -3000, -44, -1, 1, 476, 1453, 2019]) expect(astroToYear(yearToAstro(y))).toBe(y);
  });
  it('computes decimal dates including leap years', () => {
    expect(dateToT(2000, 1, 1)).toBe(2000);
    expect(dateToT(2000, 3, 1)).toBeCloseTo(2000 + 60 / 366, 6);
    expect(dateToT(1999, 3, 1)).toBeCloseTo(1999 + 59 / 365, 6);
  });
  it('reads Wikibase JSON and SPARQL BC years differently', () => {
    // Both mean 44 BC: Wikibase JSON numbers it -0044, XSD 1.1 numbers it -0043.
    expect(wikidataTimeToT('-0044-03-15T00:00:00Z')).toBeCloseTo(sparqlTimeToT('-0043-03-15T00:00:00Z')!, 6);
    expect(wikidataTimeToT('+1871-01-18T00:00:00Z')).toBeCloseTo(1871.046, 2);
    expect(wikidataTimeToT('+1500-00-00T00:00:00Z')).toBe(1500);
    expect(wikidataTimeToT('garbage')).toBeNull();
  });
  it('formats and parses', () => {
    expect(formatYear(-44)).toBe('44 BC');
    expect(formatRange(1871, 1918.8)).toBe('1871 to 1918');
    expect(formatRange(null, null)).toBe('dates undocumented');
    for (const [s, y] of [['1453', 1453], ['44 BC', -44], ['44 bce', -44], ['BC 44', -44], ['476 AD', 476], ['44 av. J.-C.', -44], [' 1789 ', 1789]] as const) expect(parseYear(s)).toBe(y);
    for (const s of ['Rome', '0', '', '12abc']) expect(parseYear(s)).toBeNull();
  });
});

describe('validity periods', () => {
  it('uses half-open intervals', () => {
    expect(isValidAt(1900, 1900, 1901)).toBe(true);
    expect(isValidAt(1901, 1900, 1901)).toBe(false);
    expect(isValidAt(5, null, null)).toBe(true);
    expect(overlaps(1, 2, 2, 3)).toBe(false);
    expect(overlaps(1, 2.1, 2, 3)).toBe(true);
    expect(overlaps(1, 2, null, null)).toBe(true);
  });
  it('looks at a year mid-year', () => {
    // USSR dissolved 26 Dec 1991, so it is present in 1991.
    const end = dateToT(1991, 12, 26);
    expect(isValidAt(yearToT(1991), 1922, end)).toBe(true);
    expect(isValidAt(yearToT(1992), 1922, end)).toBe(false);
  });
  it('prefers dated CShapes over a held snapshot', () => {
    const sets = [{ id: 'hb_1880', dataset: 'basemaps', from: 1880, to: 1900 }, { id: 'hb_1900', dataset: 'basemaps', from: 1900, to: 1914 }, { id: 'cs', dataset: 'cshapes', from: 1886, to: 2020 }];
    expect(setForT(sets, yearToT(1885))!.id).toBe('hb_1880');
    expect(setForT(sets, yearToT(1890))!.id).toBe('cs');
    expect(setForT(sets, yearToT(1890), 'basemaps')!.id).toBe('hb_1880');
    expect(setForT(sets, yearToT(3000))).toBeNull();
  });
});

describe('timeline scale', () => {
  it('is monotonic and invertible enough to land on the same year in modern times', () => {
    let prev = -1;
    for (const y of [-123000, -10000, -3000, -44, 1, 500, 1453, 1800, 1914, 2019]) {
      const p = yearToPos(y);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(yearToPos(2019)).toBeCloseTo(1, 6);
    for (const y of [1789, 1914, 1991]) expect(posToYear(yearToPos(y))).toBe(y);
  });
  it('never yields year zero', () => {
    for (let i = 0; i <= 2000; i++) expect(posToYear(i / 2000)).not.toBe(0);
  });
});
