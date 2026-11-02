import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import geojsonvt from 'geojson-vt';
import { tx } from './db.ts';
import { pointInGeometry, polygonsOf, type Poly } from './geo.ts';
import { classFromInstances } from './match.ts';

const require = createRequire(import.meta.url);
const vtpbf = require('vt-pbf') as { fromGeojsonVt: (l: any, o?: any) => Uint8Array };

export const PALETTE_SIZE = 10;

/** Greedy graph colouring: neighbours (over all time) get different washes. */
export function colorGraph(adj: Map<string, Set<string>>, weight: (id: string) => number): Map<string, number> {
  const order = [...adj.keys()].sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size) || (weight(b) - weight(a)) || a.localeCompare(b));
  const color = new Map<string, number>();
  for (const id of order) {
    const used = new Set<number>();
    for (const n of adj.get(id)!) if (color.has(n)) used.add(color.get(n)!);
    let c = 0;
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    for (let i = 0; i < PALETTE_SIZE; i++) {
      c = (hash + i) % PALETTE_SIZE;
      if (!used.has(c)) break;
    }
    color.set(id, c);
  }
  return color;
}

const geomOf = (blob: Uint8Array) => JSON.parse(gunzipSync(blob).toString()) as Poly;

export async function finalize(db: DatabaseSync, log: (m: string) => void) {
  const terr = db.prepare(`SELECT id,entity_id,set_id,name,valid_from,valid_to,raw_valid_to,area_km2,border_precision,sovereign,label_lon,label_lat,capital_name,capital_lon,capital_lat,geojson FROM territory ORDER BY valid_from`).all() as any[];

  // Clip snapshot-held intervals: a polygon must not outlive a documented dissolution.
  const lastTerr = db.prepare(`SELECT entity_id, max(valid_from) v FROM territory WHERE snapshot_held=1 GROUP BY entity_id`).all() as any[];
  const lastByEntity = new Map(lastTerr.map((r) => [r.entity_id, r.v]));
  const identities = db.prepare(`SELECT i.entity_id, i.qid, i.from_t, i.to_t, i.confidence, w.dissolved, w.inception FROM entity_identity i JOIN wd_item w ON w.qid=i.qid`).all() as any[];
  const idsByEntity = new Map<string, any[]>();
  for (const i of identities) (idsByEntity.get(i.entity_id) ?? idsByEntity.set(i.entity_id, []).get(i.entity_id)!).push(i);

  const clip = db.prepare(`UPDATE territory SET valid_to=? WHERE id=?`);
  let clipped = 0;
  // Instance-of labels per item, to classify a territory by what it was at that moment.
  const instanceRows = db.prepare(`SELECT qid, value_label FROM fact WHERE kind IN ('instance','government') UNION SELECT qid, label FROM wd_item WHERE qid IN (SELECT qid FROM entity_identity) AND label IS NOT NULL`).all() as any[];
  const instances = new Map<string, string[]>();
  for (const r of instanceRows) (instances.get(r.qid) ?? instances.set(r.qid, []).get(r.qid)!).push(r.value_label);
  const setClass = db.prepare(`UPDATE territory SET class=?, modern_name=? WHERE id=?`);
  const entKind = new Map((db.prepare(`SELECT id,kind FROM entity`).all() as any[]).map((r) => [r.id, r.kind]));

  // 2019 borders answer "what is here today?"
  const modern = terr.filter((t) => t.set_id === 'cs' && t.valid_to > 2019.9).map((t) => ({ name: t.name as string, g: geomOf(t.geojson), bb: t }));
  const modernOf = (lon: number, lat: number) => modern.find((m) => pointInGeometry(lon, lat, m.g))?.name ?? null;

  tx(db, () => {
    for (const t of terr) {
      const ids = idsByEntity.get(t.entity_id) ?? [];
      const mid = (t.valid_from + t.valid_to) / 2;
      const main = ids.filter((i) => mid >= i.from_t && mid < i.to_t).sort((a, b) => b.confidence - a.confidence)[0];
      if (lastByEntity.get(t.entity_id) === t.valid_from && main && main.confidence >= 0.8 && main.dissolved != null && main.dissolved > t.valid_from && main.dissolved < t.valid_to) {
        clip.run(main.dissolved, t.id);
        t.valid_to = main.dissolved;
        clipped++;
      }
      const cls = t.sovereign ? 'dependency' : (main && classFromInstances(instances.get(main.qid) ?? [])) || entKind.get(t.entity_id) || 'polity';
      t.cls = cls;
      setClass.run(cls, modernOf(t.label_lon, t.label_lat), t.id);
    }
  });
  log(`clipped ${clipped} snapshot intervals by documented dissolution`);

  // Adjacency from shared vertices (rounded); deliberately ignores non-touching overlaps.
  for (const dataset of ['cs', 'hb']) {
    const rows = terr.filter((t) => (dataset === 'cs') === (t.set_id === 'cs'));
    const adj = new Map<string, Set<string>>();
    const byVertex = new Map<string, Set<string>>();
    for (const t of rows) {
      if (!adj.has(t.entity_id)) adj.set(t.entity_id, new Set());
      for (const poly of polygonsOf(geomOf(t.geojson))) for (let i = 0; i < poly[0]!.length; i += 3) {
        const [x, y] = poly[0]![i]! as [number, number];
        const k = `${t.set_id}:${x.toFixed(1)},${y.toFixed(1)}`;
        (byVertex.get(k) ?? byVertex.set(k, new Set()).get(k)!).add(t.entity_id);
      }
    }
    for (const s of byVertex.values()) if (s.size > 1 && s.size < 12) for (const a of s) for (const b of s) if (a !== b) adj.get(a)!.add(b);
    const areas = new Map(rows.map((t) => [t.entity_id, t.area_km2]));
    const colors = colorGraph(adj, (id) => areas.get(id) ?? 0);
    tx(db, () => {
      const up = db.prepare(`UPDATE entity SET color=? WHERE id=?`);
      for (const [id, c] of colors) up.run(c, id);
    });
  }
  const colorOf = new Map((db.prepare(`SELECT id,color FROM entity`).all() as any[]).map((r) => [r.id, r.color]));

  // Colonies wear their ruler's wash, so empires read as one thing across oceans.
  const nameToEntity = new Map<string, string>();
  for (const r of db.prepare(`SELECT name, entity_id FROM entity_name WHERE lang='en' UNION SELECT name, id FROM entity`).all() as any[]) if (!nameToEntity.has(r.name)) nameToEntity.set(r.name, r.entity_id);
  const SOV_ALIASES: Record<string, string> = { 'United Kingdom of Great Britain and Ireland': 'United Kingdom', 'UK': 'United Kingdom', 'Great Britain': 'United Kingdom', USA: 'United States of America', 'United States': 'United States of America' };

  db.exec(`DELETE FROM tile; DELETE FROM place WHERE origin='cshapes';`);
  const insCap = db.prepare(`INSERT INTO place(name,lon,lat,from_t,to_t,kind,origin,entity_id) VALUES(?,?,?,?,?,'capital','cshapes',?)`);
  tx(db, () => {
    const open = new Map<string, any>();
    for (const t of terr.filter((x) => x.set_id === 'cs' && x.capital_name && x.capital_lon != null)) {
      const k = `${t.entity_id}|${t.capital_name}`;
      const cur = open.get(k);
      if (cur && Math.abs(cur.to - t.valid_from) < 0.02) cur.to = t.valid_to;
      else open.set(k + '|' + t.valid_from, (open.set(k, { name: t.capital_name, lon: t.capital_lon, lat: t.capital_lat, from: t.valid_from, to: t.valid_to, e: t.entity_id }), open.get(k)));
    }
    for (const c of new Set(open.values())) insCap.run(c.name, c.lon, c.lat, c.from, c.to, c.e);
  });

  const wdLabel = new Map((db.prepare(`SELECT qid,label FROM wd_item WHERE qid IN (SELECT qid FROM entity_identity)`).all() as any[]).map((r) => [r.qid, r.label as string]));
  const ins = db.prepare(`INSERT OR REPLACE INTO tile VALUES(?,?,?,?,?)`);
  const up = db.prepare(`UPDATE tile_set SET labels=?, tile_count=?, bytes=? WHERE id=?`);
  const sets = db.prepare(`SELECT id FROM tile_set`).all() as any[];
  let done = 0;
  for (const { id } of sets) {
    const isCs = id === 'cs';
    const rows = terr.filter((t) => t.set_id === id);
    const features = rows.map((t) => ({
      type: 'Feature' as const,
      id: t.id,
      geometry: geomOf(t.geojson),
      properties: {
        t: t.id, n: t.name, k: t.cls, p: t.border_precision ?? 1, a: Math.round(t.area_km2), s: t.valid_from, e: t.valid_to, eid: t.entity_id,
        c: colorOf.get((t.sovereign && nameToEntity.get(SOV_ALIASES[t.sovereign] ?? t.sovereign)) || t.entity_id) ?? 0,
      },
    }));
    const maxZ = isCs ? 7 : 6;
    const idx = geojsonvt({ type: 'FeatureCollection', features }, { maxZoom: maxZ, indexMaxZoom: maxZ, indexMaxPoints: 0, tolerance: 3, buffer: 64, extent: 4096 });
    let count = 0, bytes = 0;
    tx(db, () => {
      for (const coord of (idx as any).tileCoords as { z: number; x: number; y: number }[]) {
        const tile = idx.getTile(coord.z, coord.x, coord.y);
        if (!tile || !tile.features.length) continue;
        const pbf = gzipSync(Buffer.from(vtpbf.fromGeojsonVt({ territories: tile }, { version: 2 })), { level: 7 });
        ins.run(id, coord.z, coord.x, coord.y, pbf);
        count++;
        bytes += pbf.length;
      }
    });
    const labels = {
      type: 'FeatureCollection',
      features: rows.flatMap((t) => labelSpans(t, idsByEntity.get(t.entity_id) ?? [], wdLabel).map((span) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [+t.label_lon.toFixed(3), +t.label_lat.toFixed(3)] },
        properties: { t: t.id, n: span.name, k: t.cls, a: Math.round(t.area_km2), s: span.from, e: span.to, c: colorOf.get(t.entity_id) ?? 0 },
      }))),
    };
    up.run(gzipSync(JSON.stringify(labels)), count, bytes, id);
    log(`tiles ${id}: ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB (${++done}/${sets.length})`);
  }
  buildSearch(db, log);
  db.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);');
}

/**
 * A map row can outlast a regime: CShapes keeps "Russia (Soviet Union)" from 1945 to 1991 and beyond.
 * Labels therefore follow high-confidence identities, so the globe says Soviet Union in 1980 and Russia in 2000.
 */
export function labelSpans(t: { name: string; valid_from: number; valid_to: number }, ids: { qid: string; from_t: number; to_t: number; method: string; confidence: number }[], labelOf: Map<string, string>) {
  const trusted = ids.filter((i) => (i.method === 'curated' || (i.method === 'name-template+date' && i.confidence >= 0.85)) && labelOf.get(i.qid) && i.from_t < t.valid_to && i.to_t > t.valid_from).sort((a, b) => a.from_t - b.from_t);
  const spans: { name: string; from: number; to: number }[] = [];
  let cur = t.valid_from;
  for (const i of trusted) {
    const from = Math.max(i.from_t, t.valid_from), to = Math.min(i.to_t, t.valid_to);
    if (to <= cur) continue;
    if (from > cur) spans.push({ name: displayName(t.name), from: cur, to: from });
    spans.push({ name: labelOf.get(i.qid)!, from: Math.max(from, cur), to });
    cur = to;
  }
  if (cur < t.valid_to) spans.push({ name: displayName(t.name), from: cur, to: t.valid_to });
  return spans;
}

/** CShapes writes "Germany (Prussia)"; the label on the globe only needs the name. */
export function displayName(name: string): string {
  return name.replace(/\s*\((?:[^)]*)\)\s*$/, '').split('/')[0]!.trim() || name;
}

function buildSearch(db: DatabaseSync, log: (m: string) => void) {
  db.exec('DELETE FROM search_fts; DELETE FROM search_tri;');
  const a = db.prepare(`INSERT INTO search_fts(text,ref_type,ref_id,weight) VALUES(?,?,?,?)`);
  const b = db.prepare(`INSERT INTO search_tri(text,ref_type,ref_id,weight) VALUES(?,?,?,?)`);
  const add = (text: string, type: string, id: string, w: number) => { a.run(text, type, id, w); b.run(text, type, id, w); };
  tx(db, () => {
    const ents = db.prepare(`SELECT e.id,e.name,e.max_area,e.kind,(SELECT max(w.sitelinks) FROM entity_identity i JOIN wd_item w ON w.qid=i.qid WHERE i.entity_id=e.id) sl FROM entity e`).all() as any[];
    const names = db.prepare(`SELECT name FROM entity_name WHERE entity_id=?`);
    const fameOf = (e: any) => Math.log10(e.max_area + 10) + Math.log10((e.sl ?? 0) + 1) * 2;
    for (const e of ents) {
      const w = fameOf(e);
      const all = new Set([e.name, ...(names.all(e.id) as any[]).map((n) => n.name)]);
      add([...all].join(' | '), 'entity', e.id, w);
    }
    for (const q of db.prepare(`SELECT DISTINCT w.qid,w.label,w.sitelinks FROM wd_item w JOIN fact f ON f.value_qid=w.qid WHERE f.kind='ruler' AND f.from_t IS NOT NULL AND w.label IS NOT NULL`).all() as any[]) add(q.label, 'person', q.qid, Math.log10(q.sitelinks + 1) * 2);
    for (const p of db.prepare(`SELECT id,name,kind FROM place WHERE from_t IS NOT NULL`).all() as any[]) add(p.name, 'place', String(p.id), p.kind === 'capital' ? 1.5 : 1);
    for (const ev of db.prepare(`SELECT qid,label,sitelinks FROM event`).all() as any[]) add(ev.label, 'event', ev.qid, Math.log10(ev.sitelinks + 1) * 2);
  });
  log(`search index ready`);
}
