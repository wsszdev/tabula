import type { DatabaseSync } from 'node:sqlite';
import { panelFromBundle, type EntityBundle, type TerritoryPanel } from '@tabula/shared';

export { factApplies, flagItemTooLoose, rulerApplies, PRESENT_FROM_T } from '@tabula/shared';

const FACT_KINDS = ['ruler', 'flag', 'coat', 'capital', 'official_language', 'language', 'official_religion', 'religion', 'government', 'predecessor', 'successor'];

/** Reads every record the panels of one entity can need. The static export writes these as files. */
export function entityBundle(db: DatabaseSync, entityId: string): EntityBundle | null {
  const entity = db.prepare(`SELECT id, name, dataset, kind FROM entity WHERE id=?`).get(entityId) as any;
  if (!entity) return null;
  const territories = db.prepare(`SELECT id, name, set_id, class, valid_from, valid_to, snapshot_held, area_km2, border_precision, capital_name, sovereign, sovereign_note, modern_name, min_lon, min_lat, max_lon, max_lat, source_file, source_row FROM territory WHERE entity_id=? ORDER BY valid_from, id`).all(entityId) as any[];
  const identities = db.prepare(`SELECT i.qid, i.from_t, i.to_t, i.method, i.confidence, w.label, w.description, w.inception, w.dissolved, w.enwiki, w.summary FROM entity_identity i LEFT JOIN wd_item w ON w.qid=i.qid WHERE i.entity_id=? ORDER BY i.from_t`).all(entityId) as any[];
  const qids = [...new Set(identities.map((i) => i.qid as string))];
  const factStmt = db.prepare(`SELECT f.qid, f.kind, f.value_qid, f.value_label, f.from_t, f.to_t, f.title, f.property, f.retrieved, w.label AS vl FROM fact f LEFT JOIN wd_item w ON w.qid=f.value_qid WHERE f.qid=? AND f.kind IN (${FACT_KINDS.map(() => '?').join(',')}) ORDER BY f.id`);
  const facts = qids.flatMap((q) => factStmt.all(q, ...FACT_KINDS) as any[]);

  const people: EntityBundle['people'] = {};
  const personStmt = db.prepare(`SELECT label, description, enwiki, summary, image, birth, death FROM wd_item WHERE qid=?`);
  for (const f of facts) {
    if (f.kind !== 'ruler' || !f.value_qid || people[f.value_qid]) continue;
    const p = personStmt.get(f.value_qid) as any;
    if (p) people[f.value_qid] = { ...p };
  }

  const media: EntityBundle['media'] = {};
  const mediaStmt = db.prepare(`SELECT url, page, author, license FROM media WHERE file=?`);
  const files = [...facts.filter((f) => f.kind === 'flag' || f.kind === 'coat').map((f) => f.value_label as string), ...Object.values(people).map((p) => p.image)];
  for (const file of files) {
    if (!file || media[file]) continue;
    const m = mediaStmt.get(file) as any;
    if (m) media[file] = { ...m };
  }

  const names = (db.prepare(`SELECT DISTINCT name FROM entity_name WHERE entity_id=? ORDER BY name`).all(entityId) as any[]).map((r) => r.name as string);
  return { entity: { ...entity }, territories: territories.map((r) => ({ ...r })), identities: identities.map((r) => ({ ...r })), facts: facts.map((r) => ({ ...r })), people, media, names };
}

export function buildPanel(db: DatabaseSync, territoryId: number, year: number): TerritoryPanel | null {
  const row = db.prepare(`SELECT entity_id FROM territory WHERE id=?`).get(territoryId) as any;
  const bundle = row && entityBundle(db, row.entity_id);
  return bundle ? panelFromBundle(bundle, territoryId, year) : null;
}
