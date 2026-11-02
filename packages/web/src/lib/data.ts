/**
 * Reads the atlas from static files (written by `npm run export`), so the site needs no server.
 * Everything resolves against the page's base URL, which makes the build work under any path,
 * such as https://<user>.github.io/<repo>/.
 */
import { entityAt, panelFromBundle, prepareSearch, searchIndex, yearToT, type EntityBundle, type EventItem, type MetaPayload, type SearchHit, type SearchIndex, type TerritoryPanel } from '@tabula/shared';

export const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
export const url = (path: string) => new URL(path, BASE).href;

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url(path), { signal });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** A fetch made once and shared; a failure is forgotten so the next call retries. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load().catch((e) => { p = null; throw e; }));
}

export const tilesUrl = (set: string) => `pmtiles://${url(`data/tiles/${set}.pmtiles`)}`;
export const glyphsUrl = () => `${url('glyphs/')}{fontstack}/{range}.pbf`;
export const labelsPath = (set: string) => `data/labels/${set}.json`;

export const loadMeta = once(() => getJson<MetaPayload>('data/meta.json'));
export const loadEvents = once(() => getJson<{ events: EventItem[] }>('data/events.json'));

type PlaceRow = [name: string, lon: number, lat: number, kind: string, from: number, to: number | null, origin: string];
const allPlaces = once(() => getJson<PlaceRow[]>('data/places.json'));

export async function placesAt(year: number) {
  const t = yearToT(year);
  // The same capital can be listed by both CShapes and Wikidata; one point is enough.
  const seen = new Set<string>();
  const features = (await allPlaces()).filter(([n, lon, lat, , from, to]) => {
    if (from > t || (to != null && to <= t)) return false;
    const k = `${n}|${lon.toFixed(1)}|${lat.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(([n, lon, lat, k, , , o]) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lon, lat] }, properties: { n, k, o } }));
  return { type: 'FeatureCollection' as const, features };
}

const loadIndex = once(async () => {
  const raw = await getJson<{ entities: string[]; territories: Record<string, number> }>('data/index.json');
  return { territories: raw.territories, entityFile: new Map(raw.entities.map((id, n) => [id, n])) };
});
export const warmIndex = () => void loadIndex().catch(() => {});

const bundles = new Map<number, Promise<EntityBundle>>();
function bundle(n: number): Promise<EntityBundle> {
  let p = bundles.get(n);
  if (!p) {
    p = getJson<EntityBundle>(`data/entities/${n}.json`);
    p.catch(() => bundles.delete(n));
    bundles.set(n, p);
    if (bundles.size > 200) bundles.delete(bundles.keys().next().value!);
  }
  return p;
}

export async function territoryPanel(territoryId: number, year: number): Promise<TerritoryPanel> {
  const n = (await loadIndex()).territories[territoryId];
  if (n == null) throw new Error(`territory ${territoryId} not found`);
  const panel = panelFromBundle(await bundle(n), territoryId, year);
  if (!panel) throw new Error(`territory ${territoryId} not found`);
  return panel;
}

/** The territory an entity held in a year, or the nearest years it is mapped. */
export async function entityAtYear(entityId: string, year: number) {
  const n = (await loadIndex()).entityFile.get(entityId);
  if (n == null) return { territoryId: null, lastMapped: null, nextMapped: null };
  return entityAt(await bundle(n), year);
}

const loadSearch = once(async (): Promise<SearchIndex> => prepareSearch(await getJson('data/search.json')));
export const warmSearch = () => void loadSearch().catch(() => {});
export async function search(q: string): Promise<SearchHit[]> {
  return searchIndex(await loadSearch(), q);
}
