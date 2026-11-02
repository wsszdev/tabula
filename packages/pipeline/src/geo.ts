import turfArea from '@turf/area';
import polylabel from 'polylabel';
import type { Geometry, MultiPolygon, Polygon, Position } from 'geojson';

export type Poly = Polygon | MultiPolygon;

export const polygonsOf = (g: Poly): Position[][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** Merges parts of one name into a MultiPolygon without dissolving (rendering hides nothing). */
export function mergeGeometries(geoms: Poly[]): Poly {
  const polys = geoms.flatMap(polygonsOf);
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0]! } : { type: 'MultiPolygon', coordinates: polys };
}

export function isPolygonal(g: Geometry | null | undefined): g is Poly {
  return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

export function bboxOf(g: Poly): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const poly of polygonsOf(g)) for (const ring of poly) for (const [x, y] of ring as [number, number][]) {
    if (x < a) a = x;
    if (x > c) c = x;
    if (y < b) b = y;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

export function areaKm2(g: Poly): number {
  return turfArea({ type: 'Feature', geometry: g, properties: {} }) / 1e6;
}

/** Visual centre of the largest part: where a label reads as belonging to the territory. */
export function labelPoint(g: Poly): [number, number] {
  let best: Position[][] | null = null;
  let bestArea = -1;
  for (const poly of polygonsOf(g)) {
    const a = areaKm2({ type: 'Polygon', coordinates: poly });
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  const p = polylabel(best! as number[][][], 0.1) as unknown as [number, number];
  return [p[0], p[1]];
}

export function pointInRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(x: number, y: number, g: Poly): boolean {
  return polygonsOf(g).some((poly) => pointInRing(x, y, poly[0]!) && !poly.slice(1).some((h) => pointInRing(x, y, h)));
}

/** Slug for stable ids; keeps Unicode letters so "Đại Việt" and "Dai Viet" stay apart only by diacritics folding. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function slug(name: string): string {
  return normalizeName(name).replace(/ /g, '-');
}
