import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import type { FeatureCollection } from 'geojson';
import { dateToT, yearToAstro, CSHAPES_START_T } from '@tabula/shared';
import { RAW, tx } from './db.ts';
import { areaKm2, bboxOf, isPolygonal, labelPoint, mergeGeometries, normalizeName, pointInGeometry, slug, type Poly } from './geo.ts';

const today = () => new Date().toISOString().slice(0, 10);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** "world_bc323.geojson" -> -323; "world_1492.geojson" -> 1492; bc123000 included. */
export function snapshotYear(file: string): number | null {
  const m = /^world_(bc)?(\d+)\.geojson$/.exec(file);
  return m ? Number(m[2]) * (m[1] ? -1 : 1) : null;
}

/** "Germany (Prussia)" -> { name: "Germany", alias: "Prussia" }, "Italy/Sardinia" -> two names. */
export function splitCshapesName(raw: string): { name: string; aliases: string[] } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(raw);
  const base = (m ? m[1]! : raw).trim();
  const inner = m ? m[2]!.split(/[\/,]/).map((s) => s.trim()).filter(Boolean) : [];
  const parts = base.split('/').map((s) => s.trim());
  return { name: parts[0]!, aliases: [...parts.slice(1), ...inner] };
}

const CULTURE_RE =
  /hunter|gather|culture|complex|tribe|peoples?$|farmers|fisher|herder|nomad|forag|civili[sz]ation|pastoral|shellfish|focus$|semites|bantu|austronesian|aboriginal|paleo|inuit|^arabs$|^slavs$|^celts$|^germans$|^berbers$/i;

export function kindFromName(name: string): string | null {
  if (CULTURE_RE.test(name)) return 'culture';
  if (/empire|caliphate|shogunate/i.test(name)) return 'empire';
  if (/kingdom|khanate|sultanate|emirate|duchy|principality|tsardom|county of|realm|chiefdom|imamate|dynasty/i.test(name)) return 'kingdom';
  if (/republic|confederation|commonwealth|federation|league/i.test(name)) return 'republic';
  if (/colony|viceroyalty|protectorate|settlements?$|mandate|dominion/i.test(name)) return 'dependency';
  return null;
}

interface HbSnap { year: number; t: number; file: string; features: { name: string; subjecto: string | null; partOf: string | null; precision: number | null; geom: Poly }[] }

export function loadBasemaps(dir = resolve(RAW, 'basemaps')): HbSnap[] {
  const snaps: HbSnap[] = [];
  for (const file of readdirSync(dir)) {
    const year = snapshotYear(file);
    if (year == null) continue;
    const fc = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as FeatureCollection;
    const byName = new Map<string, HbSnap['features'][number] & { parts: Poly[] }>();
    for (const f of fc.features) {
      const name = String(f.properties?.NAME ?? '').trim();
      if (!name || !isPolygonal(f.geometry)) continue; // unnamed land has no political meaning
      const key = name;
      const cur = byName.get(key);
      if (cur) cur.parts.push(f.geometry);
      else
        byName.set(key, {
          name,
          subjecto: (String(f.properties?.SUBJECTO ?? '').trim() || null),
          partOf: (String(f.properties?.PARTOF ?? '').trim() || null),
          precision: typeof f.properties?.BORDERPRECISION === 'number' && f.properties.BORDERPRECISION > 0 ? f.properties.BORDERPRECISION : null,
          geom: f.geometry,
          parts: [f.geometry],
        });
    }
    snaps.push({ year, t: yearToAstro(year), file, features: [...byName.values()].map((v) => ({ ...v, geom: mergeGeometries(v.parts) })) });
  }
  return snaps.sort((a, b) => a.t - b.t);
}

export function ingestBasemaps(db: DatabaseSync, snaps: HbSnap[]) {
  const insEntity = db.prepare(`INSERT INTO entity(id,name,dataset,kind,kind_source,first_t,last_t,max_area) VALUES(?,?,?,?,?,?,?,?)`);
  const insTerr = db.prepare(`INSERT INTO territory(entity_id,set_id,name,valid_from,valid_to,raw_valid_to,snapshot_held,area_km2,border_precision,sovereign,sovereign_note,part_of,label_lon,label_lat,min_lon,min_lat,max_lon,max_lat,geojson,source_file) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSet = db.prepare(`INSERT INTO tile_set(id,dataset,from_t,to_t,year) VALUES(?,?,?,?,?)`);
  const insR = db.prepare(`INSERT INTO territory_rtree VALUES(?,?,?,?,?)`);

  // Same name in consecutive snapshots = same entity. A name absent from more than
  // one following snapshot starts a new entity: "Georgia" of 1100 and of 1991 are not one.
  const open = new Map<string, { id: string; lastIdx: number; maxArea: number; lastT: number }>();
  let count = 0;
  snaps.forEach((snap, idx) => {
    const next = snaps[idx + 1];
    const to = next ? next.t : CSHAPES_START_T + 134; // last snapshot has no successor
    const setId = `hb_${snap.year}`;
    insSet.run(setId, 'basemaps', snap.t, to, snap.year);
    for (const f of snap.features) {
      const s = slug(f.name) || `x${sha(Buffer.from(f.name)).slice(0, 8)}`;
      let cur = open.get(s);
      if (!cur || cur.lastIdx < idx - 2) {
        cur = { id: `hb:${s}@${snap.t}`, lastIdx: idx, maxArea: 0, lastT: to };
        open.set(s, cur);
        const kind = kindFromName(f.name);
        insEntity.run(cur.id, f.name, 'basemaps', kind ?? 'polity', kind ? 'name' : null, snap.t, to, 0);
      }
      cur.lastIdx = idx;
      cur.lastT = to;
      const area = areaKm2(f.geom);
      cur.maxArea = Math.max(cur.maxArea, area);
      const bb = bboxOf(f.geom);
      const lp = labelPoint(f.geom);
      const dependent = f.subjecto && f.subjecto !== f.name;
      const r = insTerr.run(cur.id, setId, f.name, snap.t, to, to, area, f.precision, dependent ? f.subjecto : null, dependent ? `As mapped by Historical Basemaps (${snap.file})` : null, f.partOf, lp[0], lp[1], bb[0], bb[1], bb[2], bb[3], gzipSync(JSON.stringify(f.geom)), snap.file);
      insR.run(r.lastInsertRowid, bb[0], bb[2], bb[1], bb[3]);
      db.prepare(`UPDATE entity SET last_t=?, max_area=? WHERE id=?`).run(to, cur.maxArea, cur.id);
      count++;
    }
  });
  return count;
}

export function ingestCshapes(db: DatabaseSync, snaps: HbSnap[], file = resolve(RAW, 'cshapes/CShapes-2.0.geojson')) {
  const buf = readFileSync(file);
  const fc = JSON.parse(buf.toString('utf8')) as FeatureCollection;
  const insEntity = db.prepare(`INSERT OR IGNORE INTO entity(id,name,dataset,kind,kind_source,first_t,last_t) VALUES(?,?,'cshapes','polity',NULL,?,?)`);
  const upEntity = db.prepare(`UPDATE entity SET first_t=min(first_t,?), last_t=max(last_t,?), max_area=max(max_area,?) WHERE id=?`);
  const insName = db.prepare(`INSERT OR IGNORE INTO entity_name VALUES(?,?,?,?)`);
  const insTerr = db.prepare(`INSERT INTO territory(entity_id,set_id,name,valid_from,valid_to,raw_valid_to,snapshot_held,area_km2,border_precision,capital_name,capital_lon,capital_lat,sovereign,sovereign_note,label_lon,label_lat,min_lon,min_lat,max_lon,max_lat,geojson,source_file,source_row) VALUES(?,'cs',?,?,?,?,0,?,3,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insR = db.prepare(`INSERT INTO territory_rtree VALUES(?,?,?,?,?)`);
  const modern = snaps.filter((s) => s.year >= 1880);
  let maxTo = 0;
  for (const f of fc.features) {
    const p = f.properties!;
    if (!isPolygonal(f.geometry)) continue;
    const { name, aliases } = splitCshapesName(p.cntry_name);
    const id = `cs:${p.gwcode}`;
    // The file's gwsdate strings are shifted by a time zone; the numeric fields are the coded dates.
    const from = dateToT(p.gwsyear, p.gwsmonth, p.gwsday);
    // End dates are inclusive in the source; intervals here are half-open.
    const end = new Date(Date.UTC(p.gweyear, p.gwemonth - 1, p.gweday + 1));
    const to = dateToT(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
    maxTo = Math.max(maxTo, to);
    insEntity.run(id, name, from, to);
    for (const a of [p.cntry_name, name, ...aliases]) insName.run(id, a, 'en', 'cshapes');
    const bb = bboxOf(f.geometry);
    const lp = labelPoint(f.geometry);
    // The public CShapes files omit the codebook's status/ruledby columns. Dependency is
    // derived by locating this territory in the Basemaps snapshot in force at its start.
    const dep = deriveDependency(lp, from, to, modern, p.cntry_name);
    const area = Number(p.area) || areaKm2(f.geometry);
    const capLon = Number.isFinite(p.caplong) ? p.caplong : null;
    const capLat = Number.isFinite(p.caplat) ? p.caplat : null;
    const r = insTerr.run(id, p.cntry_name, from, to, to, area, p.capname || null, capLon, capLat, dep?.sovereign ?? null, dep?.note ?? null, lp[0], lp[1], bb[0], bb[1], bb[2], bb[3], gzipSync(JSON.stringify(f.geometry)), 'CShapes-2.0.geojson', `gwcode=${p.gwcode};start=${p.gwsyear}-${p.gwsmonth}-${p.gwsday}`);
    insR.run(r.lastInsertRowid, bb[0], bb[2], bb[1], bb[3]);
    upEntity.run(from, to, area, id);
  }
  db.prepare(`INSERT INTO tile_set(id,dataset,from_t,to_t,year) VALUES('cs','cshapes',?,?,NULL)`).run(CSHAPES_START_T, maxTo);
  db.prepare(`INSERT OR REPLACE INTO source_run VALUES('CShapes 2.0','https://icr.ethz.ch/data/cshapes/','CC BY-NC-SA 4.0',?,?,?,?)`).run(today(), sha(buf), fc.features.length, 'Gleditsch-Ward coding; borders and capitals of states and dependencies, 1886-2019');
  return fc.features.length;
}

export function deriveDependency(lp: [number, number], from: number, to: number, snaps: Pick<HbSnap, 'year' | 't' | 'features'>[], selfName?: string) {
  // Snapshots inside the period outvote the one before it, which may predate the change that opened it.
  const inside = snaps.filter((s) => s.t >= from && s.t < to);
  const before = [...snaps].reverse().find((s) => s.t < from);
  // With under two inside, the one before votes too: a lone late map can show the period's end, not its nature.
  const pool = inside.length >= 2 || !before ? inside : [before, ...inside];
  const votes = new Map<string, { n: number; name: string; year: number }>();
  for (const snap of pool) {
    const hit = snap.features.find((f) => pointInGeometry(lp[0], lp[1], f.geom));
    if (hit?.subjecto && hit.subjecto !== hit.name) {
      const v = votes.get(hit.subjecto) ?? { n: 0, name: hit.name, year: snap.year };
      v.n++;
      votes.set(hit.subjecto, v);
    }
  }
  const [top] = [...votes.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!top || top[1].n * 2 <= pool.length) return null;
  const [sovereign, v] = top;
  // "Russia (Soviet Union)" subject to "Russia" says nothing.
  if (selfName && normalizeName(selfName).includes(normalizeName(sovereign))) return null;
  return { sovereign, note: `Derived: this territory lies inside "${v.name}", which Historical Basemaps ${v.year} maps as subject to ${sovereign}. CShapes' public file does not publish its status field.` };
}

export function ingestPlaces(db: DatabaseSync, file = resolve(RAW, 'basemaps/places.geojson')) {
  const fc = JSON.parse(readFileSync(file, 'utf8')) as FeatureCollection;
  const ins = db.prepare(`INSERT INTO place(name,lon,lat,from_t,to_t,qid,kind,origin) VALUES(?,?,?,?,?,?,'city','basemaps')`);
  let n = 0;
  for (const f of fc.features) {
    if (f.geometry?.type !== 'Point') continue;
    const p = f.properties!;
    const name = (p['name.en'] ?? p.name ?? '').toString().trim();
    if (!name) continue;
    const since = typeof p.inhabitedSince === 'number' && p.inhabitedSince !== 0 ? yearToAstro(Math.trunc(p.inhabitedSince)) : null;
    const until = typeof p.inhabitedUntil === 'number' && p.inhabitedUntil !== 0 ? yearToAstro(Math.trunc(p.inhabitedUntil)) : null;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    ins.run(name, lon, lat, since, until, p.wikidata || null);
    n++;
  }
  return n;
}

export function ingestGeo(db: DatabaseSync) {
  db.exec(`DELETE FROM territory; DELETE FROM territory_rtree; DELETE FROM entity_name; DELETE FROM entity; DELETE FROM tile_set; DELETE FROM place; DELETE FROM source_run;`);
  const snaps = loadBasemaps();
  const res = tx(db, () => {
    const hb = ingestBasemaps(db, snaps);
    const cs = ingestCshapes(db, snaps);
    const pl = ingestPlaces(db);
    return { hb, cs, pl };
  });
  const hbHash = createHash('sha256');
  for (const s of snaps) hbHash.update(readFileSync(resolve(RAW, 'basemaps', s.file)));
  db.prepare(`INSERT OR REPLACE INTO source_run VALUES('Historical Basemaps','https://github.com/aourednik/historical-basemaps','GPL-3.0',?,?,?,?)`).run(today(), hbHash.digest('hex'), res.hb, `${snaps.length} world snapshots, ${snaps[0]!.year} to ${snaps.at(-1)!.year}; ${res.pl} places`);
  return res;
}
