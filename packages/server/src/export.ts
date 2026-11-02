/**
 * Writes the database out as static files the web app reads directly, so the atlas can be
 * hosted anywhere that serves files (GitHub Pages). Output: packages/web/public/data.
 *
 *   meta.json, events.json, places.json, search.json, index.json
 *   labels/<set>.json        label points per tile set
 *   tiles/<set>.pmtiles      vector tiles per tile set, read with HTTP range requests
 *   entities/<n>.json        everything the panels of one entity need
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { SearchHit } from '@tabula/shared';
import { buildApp } from './app.ts';
import { entityBundle } from './panel.ts';
import { writePmtiles } from './pmtiles.ts';
import { resolveHit } from './search.ts';

export const DEFAULT_OUT = resolve(import.meta.dirname, '../../web/public/data');

export async function exportStatic(db: DatabaseSync, out: string, log: (m: string) => void = () => {}) {
  rmSync(out, { recursive: true, force: true });
  for (const d of ['labels', 'tiles', 'entities']) mkdirSync(resolve(out, d), { recursive: true });
  const write = (path: string, data: unknown) => writeFileSync(resolve(out, path), JSON.stringify(data));

  const app = buildApp(db, { webDist: '/nonexistent' });
  await app.ready();
  const inject = async (url: string) => {
    const r = await app.inject({ url, headers: { 'accept-encoding': 'identity' } });
    if (r.statusCode !== 200) throw new Error(`${url}: HTTP ${r.statusCode}`);
    return r.json();
  };
  write('meta.json', await inject('/api/meta'));
  write('events.json', await inject('/api/events?limit=500'));
  await app.close();

  // Every dated place, filtered by year in the browser: [name, lon, lat, kind, from, to, origin].
  const places = (db.prepare(`SELECT name, lon, lat, kind, from_t, to_t, origin FROM place WHERE from_t IS NOT NULL ORDER BY id`).all() as any[])
    .map((r) => [r.name, r.lon, r.lat, r.kind, r.from_t, r.to_t, r.origin]);
  write('places.json', places);
  log(`places ${places.length}`);

  const sets = db.prepare(`SELECT id, labels FROM tile_set ORDER BY from_t`).all() as any[];
  const tileStmt = db.prepare(`SELECT z, x, y, data FROM tile WHERE set_id=?`);
  let tileBytes = 0;
  for (const s of sets) {
    if (s.labels) writeFileSync(resolve(out, `labels/${s.id}.json`), gunzipSync(s.labels));
    const buf = writePmtiles(tileStmt.all(s.id) as any[], { name: `TABULA ${s.id}`, vector_layers: [{ id: 'territories', fields: {} }] });
    writeFileSync(resolve(out, `tiles/${s.id}.pmtiles`), buf);
    tileBytes += buf.length;
  }
  log(`tile sets ${sets.length}, ${(tileBytes / 1e6).toFixed(1)} MB`);

  const entities = (db.prepare(`SELECT id FROM entity ORDER BY id`).all() as any[]).map((r) => r.id as string);
  const territories: Record<number, number> = {};
  entities.forEach((id, n) => {
    const b = entityBundle(db, id)!;
    for (const t of b.territories) territories[t.id] = n;
    write(`entities/${n}.json`, b);
  });
  write('index.json', { entities, territories });
  log(`entities ${entities.length}`);

  // Search runs in the browser over the same rows SQLite indexes; hits are resolved once here.
  const hits: SearchHit[] = [];
  const hitIndex = new Map<string, number>();
  const rows: [string, number, number][] = [];
  for (const r of db.prepare(`SELECT text, ref_type, ref_id, weight FROM search_fts`).all() as any[]) {
    const key = `${r.ref_type}:${r.ref_id}`;
    let i = hitIndex.get(key);
    if (i == null) {
      const hit = resolveHit(db, r.ref_type, String(r.ref_id));
      i = hit ? hits.push(hit) - 1 : -1;
      hitIndex.set(key, i);
    }
    if (i >= 0) rows.push([String(r.text), Number(r.weight), i]);
  }
  write('search.json', { hits, rows });
  log(`search ${rows.length} rows, ${hits.length} hits`);
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const { DB_PATH } = await import('../../pipeline/src/db.ts');
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const t0 = Date.now();
  await exportStatic(db, out, (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`));
  console.log(`static data written to ${out}`);
}
