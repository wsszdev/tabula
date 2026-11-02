/**
 * Builds a territory panel from one entity's records. Pure, so the same code answers the
 * optional Node API and the static site, where the browser runs it on an exported bundle.
 */
import { yearToT, type FlagFact, type MediaInfo, type Provenance, type RulerFact, type TerritoryPanel, type TimedFact } from './index.ts';

/** Everything the panel of any territory of one entity needs, for any year. */
export interface EntityBundle {
  entity: { id: string; name: string; dataset: string; kind: string };
  territories: TerritoryRecord[];
  identities: IdentityRecord[];
  /** Facts of every identity, in database order, with the value item's label as `vl`. */
  facts: FactRecord[];
  /** Wikidata items of rulers, by QID. */
  people: Record<string, PersonRecord>;
  media: Record<string, Omit<MediaInfo, 'file'>>;
  /** Distinct names of the entity, sorted. */
  names: string[];
}

export interface TerritoryRecord {
  id: number; name: string; set_id: string; class: string;
  valid_from: number; valid_to: number; snapshot_held: number; area_km2: number; border_precision: number | null;
  capital_name: string | null; sovereign: string | null; sovereign_note: string | null; modern_name: string | null;
  min_lon: number; min_lat: number; max_lon: number; max_lat: number;
  source_file: string; source_row: string | null;
}
export interface IdentityRecord {
  qid: string; from_t: number; to_t: number; method: string; confidence: number;
  label: string | null; description: string | null; inception: number | null; dissolved: number | null; enwiki: string | null; summary: string | null;
}
export interface FactRecord {
  qid: string; kind: string; value_qid: string | null; value_label: string; from_t: number | null; to_t: number | null;
  title: string | null; property: string; retrieved: string; vl: string | null;
}
export interface PersonRecord {
  label: string | null; description: string | null; enwiki: string | null; summary: string | null; image: string | null; birth: number | null; death: number | null;
}

/** The present-day cutoff: undated claims on a state that still exists describe "now". */
export const PRESENT_FROM_T = 2000;

export function factApplies(
  t: number,
  fact: { from: number | null; to: number | null },
  item: { inception: number | null; dissolved: number | null },
): 'dated' | 'undated' | false {
  if (fact.from != null || fact.to != null) {
    if (fact.from != null && t < fact.from) return false;
    if (fact.to != null && t >= fact.to) return false;
    if (item.dissolved != null && t >= item.dissolved) return false;
    return 'dated';
  }
  if (item.inception != null && t < item.inception) return false;
  if (item.dissolved == null) return t >= PRESENT_FROM_T ? 'undated' : false;
  return t < item.dissolved ? 'undated' : false;
}

/** A ruler claim counts only with a stated start or end, and only while that person was alive. */
export function rulerApplies(t: number, f: { from: number | null; to: number | null }, person: { birth: number | null; death: number | null }): boolean {
  if (f.from == null && f.to == null) return false;
  // Wikidata has some terms that contradict the person's own dates; a contradiction is not shown.
  if (person.birth != null && t < person.birth) return false;
  if (person.death != null && t >= person.death + 1) return false;
  if (f.from != null && t < f.from) return false;
  if (f.to != null && t >= f.to) return false;
  if (f.to == null) {
    if (person.death != null && t >= person.death) return false;
    if (person.death == null && t - f.from! > 60) return false;
  }
  if (f.from == null && person.birth != null && t < person.birth) return false;
  return true;
}

/**
 * A flag item's image shows its current design even when its inception is old: the 50-star
 * US flag item dates from 1777. On a state that still exists it only speaks for the present.
 */
export function flagItemTooLoose(f: { property: string; to_t: number | null }, item: { dissolved: number | null }, t: number): boolean {
  return f.property === 'P163' && f.to_t == null && item.dissolved == null && t < PRESENT_FROM_T;
}

/** The territory an entity held in a year, or the nearest years it is mapped. */
export function entityAt(b: Pick<EntityBundle, 'territories'>, year: number): { territoryId: number | null; lastMapped?: number | null; nextMapped?: number | null } {
  const t = yearToT(year);
  const hit = b.territories.find((r) => r.valid_from <= t && r.valid_to > t);
  if (hit) return { territoryId: hit.id };
  let last: number | null = null, next: number | null = null;
  for (const r of b.territories) {
    if (r.valid_to <= t && (last == null || r.valid_to > last)) last = r.valid_to;
    if (r.valid_from > t && (next == null || r.valid_from < next)) next = r.valid_from;
  }
  return { territoryId: null, lastMapped: last, nextMapped: next };
}

const wd = (qid: string, retrieved?: string): Provenance => ({ source: 'Wikidata', url: `https://www.wikidata.org/wiki/${qid}`, retrieved });
const enwiki = (title: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export function panelFromBundle(b: EntityBundle, territoryId: number, year: number): TerritoryPanel | null {
  const t = yearToT(year);
  const row = b.territories.find((r) => r.id === territoryId);
  if (!row) return null;

  const identities = b.identities;
  const current = identities.filter((i) => t >= i.from_t && t < i.to_t).sort((a, c) => c.confidence - a.confidence)[0] ?? null;
  const q = current?.qid;
  const item = current ? { inception: current.inception, dissolved: current.dissolved } : { inception: null, dissolved: null };

  const facts = (kind: string) => (q ? b.facts.filter((f) => f.qid === q && f.kind === kind) : []);
  const timed = (kind: string): TimedFact[] => {
    const out = new Map<string, TimedFact>();
    for (const f of facts(kind)) {
      const a = factApplies(t, { from: f.from_t, to: f.to_t }, item);
      if (!a) continue;
      const key = f.value_qid ?? f.value_label;
      const existing = out.get(key);
      if (existing && existing.temporal === 'dated') continue;
      out.set(key, { label: f.vl ?? f.value_label, qid: f.value_qid, from: f.from_t, to: f.to_t, temporal: a, source: wd(q!, f.retrieved) });
    }
    return [...out.values()];
  };

  const media = (file: string | null): MediaInfo | null => {
    if (!file) return null;
    const m = b.media[file];
    return m ? { file, url: m.url, page: m.page, author: m.author, license: m.license } : null;
  };

  const flagged = (kind: 'flag' | 'coat'): FlagFact[] => {
    const out: FlagFact[] = [];
    for (const f of facts(kind)) {
      const a = factApplies(t, { from: f.from_t, to: f.to_t }, item);
      if (!a) continue;
      if (flagItemTooLoose(f, item, t)) continue;
      const image = media(f.value_label);
      if (!image) continue;
      out.push({
        label: f.title ?? f.value_label.replace(/\.\w+$/, ''), qid: f.value_qid, from: f.from_t, to: f.to_t, temporal: a, source: wd(q!, f.retrieved), image,
        match: a === 'undated' ? 'state-lifetime' : f.property === 'P163' ? 'flag-item-inception' : 'period-stated',
        context: f.title,
      });
    }
    // An explicitly dated flag is stronger evidence than one assumed for a state's whole life.
    const dated = out.filter((f) => f.match !== 'state-lifetime');
    const chosen = dated.length ? dated : out;
    const seen = new Set<string>();
    return chosen.filter((f) => !seen.has(f.image.file) && !!seen.add(f.image.file));
  };

  const rulers: RulerFact[] = [];
  const seenPeople = new Set<string>();
  for (const f of facts('ruler')) {
    const p: Partial<PersonRecord> = (f.value_qid && b.people[f.value_qid]) || {};
    if (!rulerApplies(t, { from: f.from_t, to: f.to_t }, { birth: p.birth ?? null, death: p.death ?? null })) continue;
    if (seenPeople.has(f.value_qid!)) continue;
    seenPeople.add(f.value_qid!);
    rulers.push({
      label: p.label ?? f.value_label, qid: f.value_qid, from: f.from_t, to: f.to_t, temporal: 'dated', source: { ...wd(f.value_qid!, f.retrieved), method: f.property },
      title: f.title, portrait: media(p.image ?? null), bio: p.summary ?? p.description ?? null, wikipedia: p.enwiki ? enwiki(p.enwiki) : null, birth: p.birth, death: p.death,
    });
  }
  // Heads of state before heads of government; longest-known term first within each.
  rulers.sort((a, c) => Number(/government|prime|chancellor/i.test(a.title ?? '')) - Number(/government|prime|chancellor/i.test(c.title ?? '')) || (a.from ?? 0) - (c.from ?? 0));

  const dataset = b.entity.dataset === 'cshapes'
    ? { dataset: 'CShapes 2.0', license: 'CC BY-NC-SA 4.0', url: 'https://icr.ethz.ch/data/cshapes/', note: `Dated border period. Row ${row.source_row}.` }
    : { dataset: 'Historical Basemaps', license: 'GPL-3.0', url: 'https://github.com/aourednik/historical-basemaps', note: `Snapshot ${row.source_file}, shown until the next snapshot. The project describes itself as work in progress.` };

  const capitalCs: TimedFact | null = row.capital_name
    ? { label: row.capital_name, from: row.valid_from, to: row.valid_to, temporal: 'dated', source: { source: 'CShapes 2.0', url: dataset.url } }
    : null;
  const capitalWd = timed('capital').sort((a, c) => Number(c.temporal === 'dated') - Number(a.temporal === 'dated'))[0] ?? null;

  const references: TerritoryPanel['references'] = [{ label: dataset.dataset, url: dataset.url, license: dataset.license }];
  if (q) references.push({ label: `Wikidata ${q}`, url: `https://www.wikidata.org/wiki/${q}`, license: 'CC0' });
  if (current?.enwiki) references.push({ label: `Wikipedia: ${current.enwiki}`, url: enwiki(current.enwiki), license: 'CC BY-SA 4.0' });

  return {
    territoryId, entityId: b.entity.id, year, name: row.name, altNames: b.names.filter((n) => n !== row.name).slice(0, 12), kind: row.class,
    mapSource: dataset, validFrom: row.valid_from, validTo: row.valid_to, snapshotHeld: !!row.snapshot_held,
    areaKm2: row.area_km2, borderPrecision: row.border_precision,
    sovereign: row.sovereign ? { name: row.sovereign, note: row.sovereign_note as string } : null,
    capital: capitalCs ?? capitalWd,
    bbox: [row.min_lon, row.min_lat, row.max_lon, row.max_lat],
    identity: current ? { qid: q!, label: current.label as string, description: current.description, from: current.inception ?? null, to: current.dissolved ?? null, method: current.method, confidence: current.confidence, wikipedia: current.enwiki ? enwiki(current.enwiki) : null, summary: current.summary } : null,
    otherIdentities: identities.filter((i) => i.qid !== q && i.label).map((i) => ({ qid: i.qid, label: i.label!, from: i.from_t, to: i.to_t })),
    modernEquivalent: row.modern_name,
    government: timed('government'),
    rulers,
    languages: { official: timed('official_language'), spoken: timed('language') },
    religions: { official: timed('official_religion'), major: timed('religion') },
    flags: flagged('flag'), coats: flagged('coat'),
    predecessors: q ? uniqueRefs(facts('predecessor'), q) : [],
    successors: q ? uniqueRefs(facts('successor'), q) : [],
    references,
  };
}

function uniqueRefs(rows: FactRecord[], q: string): TimedFact[] {
  const m = new Map<string, TimedFact>();
  for (const f of rows) if (f.vl && !m.has(f.value_qid!)) m.set(f.value_qid!, { label: f.vl, qid: f.value_qid, from: f.from_t, to: f.to_t, temporal: f.from_t != null ? 'dated' : 'undated', source: wd(q, f.retrieved) });
  return [...m.values()];
}
