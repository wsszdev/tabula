import type { DatabaseSync } from 'node:sqlite';
import { astroToYear, fold, formatRange, formatYear, parseYear, similarity, trigrams, type SearchHit } from '@tabula/shared';

export { fold, similarity, trigrams };

/** Turns free text into an FTS5 prefix query that cannot be read as FTS syntax. */
export function ftsQuery(q: string): string {
  const toks = fold(q).match(/[\p{L}\p{N}]+/gu) ?? [];
  return toks.map((w) => `"${w}"*`).join(' ');
}

function midYear(from: number, to: number): number {
  const y = astroToYear(Math.floor((from + to) / 2));
  return y === 0 ? 1 : y;
}

export function search(db: DatabaseSync, q: string, limit = 12): SearchHit[] {
  const text = q.trim();
  if (text.length < 2) return [];
  const hits: SearchHit[] = [];
  const y = parseYear(text);
  if (y != null) hits.push({ type: 'date', id: String(y), title: formatYear(y), subtitle: 'Go to this year', year: y });

  const fq = ftsQuery(text);
  let rows: any[] = [];
  if (fq) {
    // bm25 is weak on one-word name fields; rank exact and starts-with first, then fame.
    rows = db.prepare(`SELECT text, ref_type, ref_id, weight FROM search_fts WHERE search_fts MATCH ? LIMIT 400`).all(fq) as any[];
  }
  if (!rows.length && text.length >= 3) {
    // Trigram matching catches word-internal text ("byzant") and spelling variants ("Ottomane").
    rows = db.prepare(`SELECT text, ref_type, ref_id, weight FROM search_tri WHERE search_tri MATCH ? LIMIT 200`).all(`"${text.replace(/"/g, '""')}"`) as any[];
    if (!rows.length && text.length >= 5) {
      const grams = trigrams(fold(text));
      const near = db.prepare(`SELECT text, ref_type, ref_id, weight FROM search_tri WHERE search_tri MATCH ? LIMIT 800`).all([...grams].map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ')) as any[];
      rows = near.filter((r) => String(r.text).split(' | ').some((n) => similarity(grams, trigrams(fold(n))) >= 0.45));
    }
  }
  const needle = fold(text);
  const scored = rows.map((r) => {
    const names = fold(String(r.text)).split(' | ');
    const exact = names.includes(needle) ? 20 : names.some((n) => n.startsWith(needle)) ? 8 : 0;
    return { ...r, score: Number(r.weight) + exact };
  }).sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const seenTitle = new Set<string>();
  for (const r of scored) {
    if (hits.length >= limit) break;
    const key = `${r.ref_type}:${r.ref_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = resolveHit(db, r.ref_type, r.ref_id);
    if (!hit) continue;
    // One city can have many dated records; the search list needs it once.
    const tk = hit.type === 'place' ? `place|${hit.title}` : `${hit.type}|${hit.title}|${hit.subtitle}`;
    if (seenTitle.has(tk)) continue;
    seenTitle.add(tk);
    hits.push(hit);
  }
  return hits;
}

export function resolveHit(db: DatabaseSync, type: string, id: string): SearchHit | null {
  if (type === 'entity') {
    const e = db.prepare(`SELECT * FROM entity WHERE id=?`).get(id) as any;
    if (!e) return null;
    // The moment of greatest extent is the most telling view of a polity.
    const t = db.prepare(`SELECT * FROM territory WHERE entity_id=? ORDER BY area_km2 DESC LIMIT 1`).get(id) as any;
    if (!t) return null;
    return {
      type: 'entity', id, title: e.name, subtitle: `${e.kind === 'polity' ? 'Polity' : e.kind[0].toUpperCase() + e.kind.slice(1)}, mapped ${formatRange(e.first_t, e.last_t)}`,
      year: midYear(t.valid_from, Math.min(t.valid_to, t.valid_from + 1)), territoryId: t.id, bbox: [t.min_lon, t.min_lat, t.max_lon, t.max_lat], lon: t.label_lon, lat: t.label_lat,
    };
  }
  if (type === 'person') {
    const p = db.prepare(`SELECT label, description FROM wd_item WHERE qid=?`).get(id) as any;
    const f = db.prepare(`SELECT f.from_t, f.to_t, f.title, f.qid, i.entity_id FROM fact f JOIN entity_identity i ON i.qid=f.qid WHERE f.kind='ruler' AND f.value_qid=? AND f.from_t IS NOT NULL ORDER BY f.from_t LIMIT 1`).get(id) as any;
    if (!f) return null;
    const year = midYear(f.from_t, f.to_t ?? f.from_t + 1);
    const terr = pickTerritory(db, f.entity_id, f.from_t, f.to_t ?? f.from_t + 1);
    return { type: 'person', id, title: p.label, subtitle: `${f.title ?? 'Ruler'}, ${formatRange(f.from_t, f.to_t)}`, year, territoryId: terr?.id ?? null, bbox: terr ? [terr.min_lon, terr.min_lat, terr.max_lon, terr.max_lat] : null, lon: terr?.label_lon, lat: terr?.label_lat };
  }
  if (type === 'place') {
    const p = db.prepare(`SELECT * FROM place WHERE id=?`).get(Number(id)) as any;
    if (!p) return null;
    return { type: 'place', id, title: p.name, subtitle: `${p.kind === 'capital' ? 'Capital' : 'City'}, ${formatRange(p.from_t, p.to_t)}`, year: midYear(p.from_t, p.to_t ?? Math.min(p.from_t + 1, 2019)), lon: p.lon, lat: p.lat };
  }
  if (type === 'event') {
    const ev = db.prepare(`SELECT * FROM event WHERE qid=?`).get(id) as any;
    if (!ev) return null;
    return { type: 'event', id, title: ev.label, subtitle: `${ev.kind[0].toUpperCase() + ev.kind.slice(1)}, ${formatRange(ev.from_t, ev.to_t)}`, year: astroToYear(Math.floor(ev.from_t)) || 1, lon: ev.lon, lat: ev.lat };
  }
  return null;
}

function pickTerritory(db: DatabaseSync, entityId: string, from: number, to: number) {
  return db.prepare(`SELECT * FROM territory WHERE entity_id=? AND valid_from < ? AND valid_to > ? ORDER BY area_km2 DESC LIMIT 1`).get(entityId, to, from) as any;
}
