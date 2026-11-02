/**
 * Time model shared by pipeline, server and client.
 *
 * Historical years have no year zero (1 BC is followed by AD 1) and are written
 * as signed integers: -44 = 44 BC. All interval arithmetic uses "t", a continuous
 * astronomical decimal year where 1 BC = 0 and 2 BC = -1. Intervals are half-open
 * [from, to). A selected whole year is looked at mid-year (`yearToT`), so a state
 * dissolved on 26 December 1991 is still on the map when the user selects 1991.
 */
export function yearToAstro(year: number): number {
  if (!Number.isInteger(year) || year === 0) throw new RangeError(`invalid historical year: ${year}`);
  return year > 0 ? year : year + 1;
}

export function astroToYear(astro: number): number {
  return astro > 0 ? astro : astro - 1;
}

export function yearToT(year: number): number {
  return yearToAstro(year) + 0.5;
}

const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Decimal astronomical year of a calendar date. `year` is a historical year. */
export function dateToT(year: number, month = 1, day = 1): number {
  const astro = yearToAstro(year);
  const leap = isLeap(astro);
  const doy = CUM_DAYS[month - 1]! + (leap && month > 2 ? 1 : 0) + day - 1;
  return astro + doy / (leap ? 366 : 365);
}

/**
 * Parses a Wikidata time value ("+1871-01-18T00:00:00Z", "-0043-00-00T00:00:00Z")
 * honouring its precision: 9 = year, 10 = month, 11 = day; coarser values round to the
 * start of the decade/century/millennium. Wikibase JSON numbers BC years historically
 * (-0044 = 44 BC). WDQS SPARQL results use XSD 1.1 (-0043 = 44 BC): see `sparqlTimeToT`.
 */
export function wikidataTimeToT(value: string): number | null {
  const m = /^([+-])(\d+)-(\d\d)-(\d\d)T/.exec(value);
  if (!m) return null;
  const y = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  if (y === 0) return null;
  const month = Number(m[3]) || 1;
  const day = Number(m[4]) || 1;
  return dateToT(y, month, day);
}

export function sparqlTimeToT(value: string): number | null {
  const m = /^(-?)(\d+)-(\d\d)-(\d\d)T/.exec(value);
  if (!m) return null;
  const astro = Number(m[2]) * (m[1] ? -1 : 1);
  return dateToT(astroToYear(astro), Number(m[3]) || 1, Number(m[4]) || 1);
}

export function formatYear(year: number): string {
  return year < 0 ? `${-year} BC` : String(year);
}

export function formatT(t: number): string {
  return formatYear(astroToYear(Math.floor(t)));
}

export function formatRange(from: number | null, to: number | null): string {
  if (from == null && to == null) return 'dates undocumented';
  if (from == null) return `until ${formatT(to!)}`;
  if (to == null) return `from ${formatT(from)}`;
  return `${formatT(from)} to ${formatT(to)}`;
}

/** Half-open interval test with null meaning "no documented bound". */
export function isValidAt(t: number, from: number | null, to: number | null): boolean {
  return (from == null || t >= from) && (to == null || t < to);
}

export function overlaps(aFrom: number, aTo: number, bFrom: number | null, bTo: number | null): boolean {
  return (bTo == null || aFrom < bTo) && (bFrom == null || aTo > bFrom);
}

/** Parses "1453", "44 BC", "44 av. J.-C.", "BC 44", "1453 AD". Returns null when not a date. */
export function parseYear(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  let m = /^(?:ad |ce )?(\d{1,6})(?: ad| ce)?$/.exec(s);
  if (m) return Number(m[1]) >= 1 ? Number(m[1]) : null;
  m = /^(?:(\d{1,6}) ?(?:bc|bce|b\.c\.|b\.c\.e\.|av\.? ?j\.?-?c\.?|v\.? ?chr\.?)|(?:bc|bce) ?(\d{1,6}))$/.exec(s);
  if (m) {
    const n = Number(m[1] ?? m[2]);
    return n >= 1 ? -n : null;
  }
  return null;
}

/** Timeline bounds; these are the actual data coverage, not an aspiration. */
export const TIME_MIN_YEAR = -123000;
export const TIME_MAX_YEAR = 2019;
export const CSHAPES_START_T = 1886;

/**
 * Piecewise timeline scale. Screen space is not linear in time: recent centuries
 * are documented far more densely than prehistory, so each band gets its own share.
 */
export const TIME_BANDS: { from: number; to: number; share: number }[] = [
  { from: -123000, to: -10000, share: 0.03 },
  { from: -10000, to: -3000, share: 0.07 },
  { from: -3000, to: 1, share: 0.2 },
  { from: 1, to: 1500, share: 0.3 },
  { from: 1500, to: 1800, share: 0.15 },
  { from: 1800, to: 2019, share: 0.25 },
];

export function yearToPos(year: number): number {
  const a = yearToAstro(year);
  let acc = 0;
  for (const b of TIME_BANDS) {
    const from = yearToAstro(b.from);
    const to = yearToAstro(b.to);
    if (a <= to) return acc + (Math.max(a - from, 0) / (to - from)) * b.share;
    acc += b.share;
  }
  return 1;
}

export function posToYear(pos: number): number {
  const p = Math.min(Math.max(pos, 0), 1);
  let acc = 0;
  for (const b of TIME_BANDS) {
    if (p <= acc + b.share) {
      const from = yearToAstro(b.from);
      const to = yearToAstro(b.to);
      return astroToYear(Math.round(from + ((p - acc) / b.share) * (to - from)));
    }
    acc += b.share;
  }
  return TIME_MAX_YEAR;
}

export type Certainty = 'verified-geo' | 'external' | 'estimated' | 'derived' | 'unavailable';

export interface Provenance {
  source: string;
  url?: string;
  retrieved?: string;
  method?: string;
  confidence?: number;
}

export interface TimedFact {
  label: string;
  qid?: string | null;
  from: number | null;
  to: number | null;
  /** 'dated' = covers the selected date explicitly; 'undated' = source states no period. */
  temporal: 'dated' | 'undated';
  source: Provenance;
  extra?: Record<string, unknown>;
}

export interface MediaInfo {
  file: string;
  url: string;
  page: string;
  author?: string | null;
  license?: string | null;
}

export interface RulerFact extends TimedFact {
  title?: string | null;
  portrait?: MediaInfo | null;
  bio?: string | null;
  wikipedia?: string | null;
  birth?: number | null;
  death?: number | null;
}

export interface FlagFact extends TimedFact {
  image: MediaInfo;
  match: 'period-stated' | 'state-lifetime' | 'flag-item-inception';
  context?: string | null;
}

export interface TerritoryPanel {
  territoryId: number;
  entityId: string;
  year: number;
  name: string;
  altNames: string[];
  kind: string;
  mapSource: { dataset: string; license: string; url: string; note: string };
  validFrom: number;
  validTo: number;
  snapshotHeld: boolean;
  areaKm2: number;
  borderPrecision: number | null;
  sovereign: { name: string; note: string } | null;
  capital: TimedFact | null;
  bbox: [number, number, number, number];
  identity: {
    qid: string;
    label: string;
    description: string | null;
    from: number | null;
    to: number | null;
    method: string;
    confidence: number;
    wikipedia: string | null;
    summary: string | null;
  } | null;
  otherIdentities: { qid: string; label: string; from: number | null; to: number | null }[];
  modernEquivalent: string | null;
  government: TimedFact[];
  rulers: RulerFact[];
  languages: { official: TimedFact[]; spoken: TimedFact[] };
  religions: { official: TimedFact[]; major: TimedFact[] };
  flags: FlagFact[];
  coats: FlagFact[];
  predecessors: TimedFact[];
  successors: TimedFact[];
  references: { label: string; url: string; license?: string }[];
}

export interface SearchHit {
  type: 'entity' | 'person' | 'place' | 'event' | 'date';
  id: string;
  title: string;
  subtitle: string;
  year: number | null;
  lon?: number | null;
  lat?: number | null;
  territoryId?: number | null;
  bbox?: [number, number, number, number] | null;
}

export interface EventItem {
  qid: string;
  label: string;
  description: string | null;
  from: number;
  to: number | null;
  year: number;
  kind: string;
  lon: number | null;
  lat: number | null;
}

export interface MetaPayload {
  version: string;
  sets: { id: string; dataset: 'cshapes' | 'basemaps'; from: number; to: number; year: number | null }[];
  timeMin: number;
  timeMax: number;
  counts: Record<string, number>;
  sources: { name: string; url: string; license: string; retrieved: string; records: number; sha256: string }[];
}

/** Which map layer set answers `t`. Basemaps snapshots hold until the next one. */
export function setForT<T extends { from: number; to: number; dataset: string }>(sets: T[], t: number, dataset?: string): T | null {
  const pool = dataset ? sets.filter((s) => s.dataset === dataset) : sets;
  const hit = pool.filter((s) => t >= s.from && t < s.to);
  // The dated dataset wins whenever it covers the date.
  return hit.find((s) => s.dataset === 'cshapes') ?? hit[0] ?? null;
}

export * from './panel.ts';
export * from './search.ts';
