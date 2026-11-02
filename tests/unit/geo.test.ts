import { describe, expect, it } from 'vitest';
import { areaKm2, bboxOf, labelPoint, mergeGeometries, normalizeName, pointInGeometry, slug } from '../../packages/pipeline/src/geo.ts';
import { deriveDependency, kindFromName, snapshotYear, splitCshapesName } from '../../packages/pipeline/src/ingest-geo.ts';
import { colorGraph, displayName, labelSpans } from '../../packages/pipeline/src/finalize.ts';

const sq = (x: number, y: number, s = 10) => ({ type: 'Polygon' as const, coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

describe('geometry', () => {
  it('measures on the sphere', () => {
    const a = areaKm2(sq(0, 0, 1));
    expect(a).toBeGreaterThan(12000);
    expect(a).toBeLessThan(12500);
  });
  it('merges parts and finds bbox', () => {
    const m = mergeGeometries([sq(0, 0), sq(20, 20)]);
    expect(m.type).toBe('MultiPolygon');
    expect(bboxOf(m)).toEqual([0, 0, 30, 30]);
  });
  it('labels the largest part', () => {
    const [x] = labelPoint(mergeGeometries([sq(0, 0, 1), sq(50, 0, 20)]));
    expect(x).toBeGreaterThan(50);
  });
  it('respects holes', () => {
    const donut = { type: 'Polygon' as const, coordinates: [sq(0, 0, 10).coordinates[0]!, sq(4, 4, 2).coordinates[0]!] };
    expect(pointInGeometry(1, 1, donut)).toBe(true);
    expect(pointInGeometry(5, 5, donut)).toBe(false);
  });
});

describe('ingestion parsing', () => {
  it('reads snapshot filenames', () => {
    expect(snapshotYear('world_1492.geojson')).toBe(1492);
    expect(snapshotYear('world_bc323.geojson')).toBe(-323);
    expect(snapshotYear('world_bc123000.geojson')).toBe(-123000);
    expect(snapshotYear('places.geojson')).toBeNull();
  });
  it('splits CShapes names', () => {
    expect(splitCshapesName('Germany (Prussia)')).toEqual({ name: 'Germany', aliases: ['Prussia'] });
    expect(splitCshapesName('Italy/Sardinia')).toEqual({ name: 'Italy', aliases: ['Sardinia'] });
    expect(splitCshapesName('Macedonia (FYROM/North Macedonia)').aliases).toEqual(['FYROM', 'North Macedonia']);
    expect(displayName('Germany (Prussia)')).toBe('Germany');
    expect(displayName('Italy/Sardinia')).toBe('Italy');
  });
  it('normalises names', () => {
    expect(normalizeName('Đại Việt')).toBe('dai viet');
    expect(slug("P’urhépecha")).toBe('purhepecha');
  });
  it('does not call a people a state', () => {
    expect(kindFromName('Australian aboriginal hunter-gatherers')).toBe('culture');
    expect(kindFromName('Ottoman Empire')).toBe('empire');
    expect(kindFromName('Kanem-Bornu')).toBeNull();
  });
  it('derives dependency from the snapshot in force, and says so', () => {
    const snaps = [{ year: 1900, t: 1900, features: [{ name: 'Algeria', subjecto: 'France', partOf: null, precision: 3, geom: sq(0, 20) }, { name: 'Morocco', subjecto: 'Morocco', partOf: null, precision: 3, geom: sq(-20, 20) }] }];
    expect(deriveDependency([5, 25], 1900, 1950, snaps)!.sovereign).toBe('France');
    expect(deriveDependency([5, 25], 1900, 1950, snaps)!.note).toContain('Derived');
    expect(deriveDependency([-15, 25], 1900, 1950, snaps)).toBeNull();
    expect(deriveDependency([5, 25], 1800, 1850, snaps)).toBeNull();
    // A snapshot from before the period must not outvote those inside it (Estonia 1918-40 was not Russian).
    const two = [{ year: 1914, t: 1914, features: [{ name: 'Baltic', subjecto: 'Russia', partOf: null, precision: 3, geom: sq(0, 20) }] }, { year: 1930, t: 1930, features: [{ name: 'Estonia', subjecto: 'Estonia', partOf: null, precision: 3, geom: sq(0, 20) }] }];
    expect(deriveDependency([5, 25], 1918, 1940, two)).toBeNull();
    expect(deriveDependency([5, 25], 1915, 1917, two, 'Russia (Soviet Union)')).toBeNull();
  });
  it('names a long map row after the regime of each moment', () => {
    const ids = [{ qid: 'A', from_t: 1900, to_t: 1920, method: 'curated', confidence: 0.98 }, { qid: 'B', from_t: 1920, to_t: 1990, method: 'curated', confidence: 0.98 }, { qid: 'C', from_t: 1995, to_t: 2020, method: 'name-alias+date', confidence: 0.7 }];
    const spans = labelSpans({ name: 'Russia (Soviet Union)', valid_from: 1910, valid_to: 2000 }, ids, new Map([['A', 'Russian Empire'], ['B', 'Soviet Union'], ['C', 'Elsewhere']]));
    expect(spans).toEqual([{ name: 'Russian Empire', from: 1910, to: 1920 }, { name: 'Soviet Union', from: 1920, to: 1990 }, { name: 'Russia', from: 1990, to: 2000 }]);
  });
  it('gives neighbours different colours', () => {
    const adj = new Map([['a', new Set(['b', 'c'])], ['b', new Set(['a', 'c'])], ['c', new Set(['a', 'b'])], ['d', new Set<string>()]]);
    const c = colorGraph(adj, () => 1);
    expect(new Set([c.get('a'), c.get('b'), c.get('c')]).size).toBe(3);
  });
});
