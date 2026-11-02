import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityAt, panelFromBundle, prepareSearch, searchIndex, type EntityBundle } from '@tabula/shared';
import { buildApp } from '../../packages/server/src/app.ts';
import { exportStatic } from '../../packages/server/src/export.ts';
import { buildFixture } from './fixture.ts';

// The static site must answer exactly what the API answers.
const db = buildFixture();
const app = buildApp(db, { webDist: '/nonexistent' });
const out = mkdtempSync(join(tmpdir(), 'tabula-static-'));
const read = (p: string) => JSON.parse(readFileSync(join(out, p), 'utf8'));
const api = async (url: string) => (await app.inject({ url })).json();

beforeAll(async () => { await app.ready(); await exportStatic(db, out); });
afterAll(() => app.close());

describe('static export', () => {
  it('writes every file the web app reads', () => {
    expect(read('meta.json').sets.length).toBeGreaterThan(0);
    expect(read('events.json').events[0].label).toBe('Fall of Constantinople');
    expect(read('places.json')[0][0]).toBe('Rome');
    expect(readdirSync(join(out, 'tiles')).every((f) => f.endsWith('.pmtiles'))).toBe(true);
    expect(readdirSync(join(out, 'labels'))).toContain('hb_1400.json');
  });

  it('gives the same panels as the API, for every territory and many years', async () => {
    const index = read('index.json');
    const terrs = db.prepare(`SELECT id, entity_id FROM territory`).all() as any[];
    expect(Object.keys(index.territories).length).toBe(terrs.length);
    for (const t of terrs) {
      const bundle: EntityBundle = read(`entities/${index.territories[t.id]}.json`);
      expect(bundle.entity.id).toBe(t.entity_id);
      for (const y of [1401, 1453, 1650, 1887, 1900, 1925, 1940]) {
        expect(panelFromBundle(bundle, t.id, y)).toEqual(await api(`/api/territories/${t.id}/panel?year=${y}`));
        expect(entityAt(bundle, y)).toEqual(await api(`/api/entities/${encodeURIComponent(t.entity_id)}/at?year=${y}`));
      }
    }
  });

  it('searches like the API', async () => {
    const idx = prepareSearch(read('search.json'));
    for (const q of ['France', 'germ', 'Wilhelm', 'constantinople', 'Rome', '1453', 'prussi'])
      expect(searchIndex(idx, q)).toEqual((await api(`/api/search?q=${encodeURIComponent(q)}`)).hits);
  });
});
