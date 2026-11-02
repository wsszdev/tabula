import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';

/** Structural and historical-consistency checks. Errors fail the build; warnings go in `validation_issue`. */
export function validate(db: DatabaseSync) {
  db.exec('DELETE FROM validation_issue');
  const ins = db.prepare(`INSERT INTO validation_issue VALUES(?,?,?,?)`);
  let errors = 0, warnings = 0;
  const issue = (sev: 'error' | 'warning', code: string, ref: string, msg: string) => { ins.run(sev, code, ref, msg); sev === 'error' ? errors++ : warnings++; };

  for (const r of db.prepare(`SELECT id,name,valid_from,valid_to FROM territory WHERE valid_to <= valid_from`).all() as any[]) issue('error', 'interval', String(r.id), `${r.name}: empty interval`);
  for (const r of db.prepare(`SELECT id,name FROM territory WHERE min_lon < -180.001 OR max_lon > 180.001 OR min_lat < -90.001 OR max_lat > 90.001`).all() as any[]) issue('warning', 'bbox', String(r.id), `${r.name}: coordinates outside WGS84`);
  for (const r of db.prepare(`SELECT id,name FROM territory WHERE area_km2 <= 0`).all() as any[]) issue('warning', 'area', String(r.id), `${r.name}: zero area`);
  const orphan = (db.prepare(`SELECT count(*) n FROM territory t LEFT JOIN entity e ON e.id=t.entity_id WHERE e.id IS NULL`).get() as any).n;
  if (orphan) issue('error', 'orphan', '', `${orphan} territories without entity`);

  // One CShapes state cannot hold two territories at once.
  for (const r of db.prepare(`SELECT a.id x, b.id y, a.name n FROM territory a JOIN territory b ON a.entity_id=b.entity_id AND a.id<b.id AND a.valid_from < b.valid_to AND b.valid_from < a.valid_to WHERE a.set_id='cs' AND b.set_id='cs'`).all() as any[])
    issue('warning', 'cs-overlap', `${r.x},${r.y}`, `${r.n}: overlapping CShapes periods`);

  // Anachronism guards: facts must not contradict the persons or items they cite.
  for (const r of db.prepare(`SELECT f.id,f.qid,w.label,f.from_t,w.birth FROM fact f JOIN wd_item w ON w.qid=f.value_qid WHERE f.kind='ruler' AND w.birth IS NOT NULL AND f.from_t IS NOT NULL AND f.from_t < w.birth`).all() as any[])
    issue('warning', 'ruler-before-birth', String(r.id), `${r.label} starts office before birth on ${r.qid}`);

  // Curated rows must have resolved.
  const curatedMissing = db.prepare(`SELECT count(*) n FROM entity_identity i LEFT JOIN wd_item w ON w.qid=i.qid WHERE w.qid IS NULL`).get() as any;
  if (curatedMissing.n) issue('warning', 'identity-without-item', '', `${curatedMissing.n} identities reference unfetched items`);

  // Every set in force must decode and have tiles; the timeline must be gap-free.
  const sets = db.prepare(`SELECT id,from_t,to_t,tile_count,labels FROM tile_set WHERE dataset='basemaps' ORDER BY from_t`).all() as any[];
  for (let i = 1; i < sets.length; i++) if (sets[i].from_t !== sets[i - 1].to_t) issue('error', 'gap', sets[i].id, 'snapshot intervals are not contiguous');
  for (const s of sets) {
    if (!s.tile_count) { issue('warning', 'no-tiles', s.id, 'no tiles yet'); continue; }
    JSON.parse(gunzipSync(s.labels).toString());
  }

  const count = (sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    errors, warnings,
    territories: count('SELECT count(*) n FROM territory'), entities: count('SELECT count(*) n FROM entity'),
    entitiesWithIdentity: count('SELECT count(DISTINCT entity_id) n FROM entity_identity'),
    facts: count('SELECT count(*) n FROM fact'), rulerFacts: count(`SELECT count(*) n FROM fact WHERE kind='ruler'`), flagFacts: count(`SELECT count(*) n FROM fact WHERE kind='flag'`),
    events: count('SELECT count(*) n FROM event'), places: count('SELECT count(*) n FROM place WHERE from_t IS NOT NULL'), media: count('SELECT count(*) n FROM media'),
    tiles: count('SELECT count(*) n FROM tile'),
  };
}
