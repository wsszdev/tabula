import { gzipSync } from 'node:zlib';
import { openDb, tx } from '../../packages/pipeline/src/db.ts';
import { ingestBasemaps, ingestCshapes } from '../../packages/pipeline/src/ingest-geo.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sq = (x: number, y: number, s = 10) => ({ type: 'Polygon' as const, coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

/** Small real-schema database, built through the real ingestion code. */
export function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tabula-'));
  const db = openDb(join(dir, 't.db'));
  const snaps = [
    { year: 1400, t: 1400, file: 'world_1400.geojson', features: [{ name: 'France', subjecto: 'France', partOf: null, precision: 1, geom: sq(0, 40) }, { name: 'Byzantine Empire', subjecto: 'Byzantine Empire', partOf: null, precision: 1, geom: sq(20, 30) }] },
    { year: 1500, t: 1500, file: 'world_1500.geojson', features: [{ name: 'France', subjecto: 'France', partOf: null, precision: 1, geom: sq(0, 40, 12) }] },
    { year: 1880, t: 1880, file: 'world_1880.geojson', features: [{ name: 'Algeria', subjecto: 'France', partOf: null, precision: 3, geom: sq(0, 20) }] },
  ];
  const csv = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: sq(0, 20), properties: { cntry_name: 'Algeria', area: 2000000, capname: 'Algiers', caplong: 3, caplat: 36, gwcode: 615, gwsyear: 1886, gwsmonth: 1, gwsday: 1, gweyear: 1962, gwemonth: 7, gweday: 4 } },
      { type: 'Feature', geometry: sq(0, 40), properties: { cntry_name: 'Germany (Prussia)', area: 500000, capname: 'Berlin', caplong: 13, caplat: 52, gwcode: 255, gwsyear: 1886, gwsmonth: 1, gwsday: 1, gweyear: 1919, gwemonth: 6, gweday: 27 } },
      { type: 'Feature', geometry: sq(0, 40, 9), properties: { cntry_name: 'Germany (Prussia)', area: 450000, capname: 'Berlin', caplong: 13, caplat: 52, gwcode: 255, gwsyear: 1919, gwsmonth: 6, gwsday: 28, gweyear: 1945, gwemonth: 5, gweday: 7 } },
    ],
  };
  const file = join(dir, 'cs.geojson');
  writeFileSync(file, JSON.stringify(csv));
  tx(db, () => {
    ingestBasemaps(db, snaps as any);
    ingestCshapes(db, snaps as any, file);
    const item = db.prepare(`INSERT INTO wd_item(qid,label,description,sitelinks,inception,dissolved,enwiki,summary,image,birth,death) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    item.run('Q70972', 'Kingdom of France', 'state', 80, 987, 1792.7, 'Kingdom of France', 'A medieval and early modern monarchy.', null, null, null);
    item.run('Q43287', 'German Empire', 'state', 90, 1871, 1918.86, 'German Empire', 'Empire summary.', null, null, null);
    item.run('Q41304', 'Weimar Republic', 'state', 90, 1918.86, 1933.08, 'Weimar Republic', 'Republic summary.', null, null, null);
    item.run('Q12', 'Wilhelm II', 'emperor', 90, null, null, 'Wilhelm II', 'Last German Emperor.', 'Wilhelm.jpg', 1859, 1941.4);
    item.run('Q13', 'Friedrich Ebert', 'president', 50, null, null, 'Friedrich Ebert', 'First president.', null, 1871, 1925.15);
    const id = db.prepare(`INSERT INTO entity_identity VALUES(?,?,?,?,?,?)`);
    const fr = db.prepare(`SELECT id FROM entity WHERE name='France'`).get() as any;
    id.run(fr.id, 'Q70972', 1400, 1880, 'curated', 0.98);
    id.run('cs:255', 'Q43287', 1886, 1918.86, 'curated', 0.98);
    id.run('cs:255', 'Q41304', 1918.86, 1933.08, 'curated', 0.98);
    const f = db.prepare(`INSERT INTO fact(qid,kind,value_qid,value_label,from_t,to_t,title,property,retrieved) VALUES(?,?,?,?,?,?,?,?,'2026-10-30')`);
    f.run('Q43287', 'ruler', 'Q12', 'Wilhelm II', 1888.45, 1918.86, 'German Emperor', 'P39');
    f.run('Q41304', 'ruler', 'Q13', 'Friedrich Ebert', 1919.1, 1925.15, 'President', 'P39');
    f.run('Q43287', 'flag', null, 'Flag of the German Empire.svg', 1871, 1918.86, null, 'P41');
    f.run('Q41304', 'flag', null, 'Flag of Germany (3-2).svg', 1919, 1933, null, 'P41');
    f.run('Q70972', 'flag', null, 'Royal Standard.svg', null, null, null, 'P41');
    f.run('Q41304', 'official_language', 'Q188', 'German', null, null, null, 'P37');
    const m = db.prepare(`INSERT INTO media VALUES(?,?,?,?,?,?)`);
    for (const file of ['Flag of the German Empire.svg', 'Flag of Germany (3-2).svg', 'Royal Standard.svg', 'Wilhelm.jpg']) m.run(file, `https://upload.wikimedia.org/${file}`, `https://commons.wikimedia.org/wiki/File:${file}`, 'someone', 'PD', '2026-10-30');
    db.prepare(`INSERT INTO event VALUES('Q1','Fall of Constantinople','siege',1453.4,NULL,'siege',28.9,41,100)`).run();
    db.prepare(`INSERT INTO place(name,lon,lat,from_t,to_t,qid,kind,origin) VALUES('Rome',12,41,-752,NULL,'Q220','city','wikidata')`).run();
    db.prepare(`INSERT INTO source_run VALUES('t','u','l','r','s',1,'n')`).run();
    const fts = db.prepare(`INSERT INTO search_fts VALUES(?,?,?,?)`);
    const tri = db.prepare(`INSERT INTO search_tri VALUES(?,?,?,?)`);
    const add = (a: string, b: string, c: string, d: number) => { fts.run(a, b, c, d); tri.run(a, b, c, d); };
    add('France | Royaume de France', 'entity', fr.id, 5);
    add('Germany (Prussia) | Germany | Prussia | Deutsches Reich', 'entity', 'cs:255', 5);
    add('Wilhelm II', 'person', 'Q12', 3);
    add('Fall of Constantinople', 'event', 'Q1', 3);
    add('Rome', 'place', '1', 1);
  });
  db.prepare(`UPDATE tile_set SET labels=? WHERE id='hb_1400'`).run(gzipSync(JSON.stringify({ type: 'FeatureCollection', features: [] })));
  return db;
}
