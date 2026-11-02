import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture } from './fixture.ts';
import { buildApp } from '../../packages/server/src/app.ts';
import { validate } from '../../packages/pipeline/src/validate.ts';

const db = buildFixture();
const app = buildApp(db, { webDist: '/nonexistent' });
const get = async (url: string) => {
  const r = await app.inject({ url });
  return { status: r.statusCode, json: r.statusCode === 204 ? null : r.json() };
};
beforeAll(() => app.ready());
afterAll(() => app.close());

describe('temporal queries', () => {
  it('returns what existed in 1453, from the snapshot in force', async () => {
    const { json } = await get('/api/territories?year=1453');
    expect(json.territories.map((t: any) => t.name).sort()).toEqual(['Byzantine Empire', 'France']);
    expect(json.territories[0].set_id).toBe('hb_1400');
  });
  it('drops an empire absent from the next snapshot', async () => {
    const a = await get('/api/territories?year=1499');
    const b = await get('/api/territories?year=1501');
    expect(a.json.territories.some((t: any) => t.name === 'Byzantine Empire')).toBe(true);
    expect(b.json.territories.some((t: any) => t.name === 'Byzantine Empire')).toBe(false);
  });
  it('switches to dated data in 1886 and to the right border period', async () => {
    const y1900 = (await get('/api/territories?year=1900')).json.territories;
    expect(y1900.map((t: any) => t.set_id)).toContain('cs');
    const de = (y: any) => y.territories.find((t: any) => t.entity_id === 'cs:255');
    expect(de((await get('/api/territories?year=1918')).json).area_km2).toBe(500000);
    expect(de((await get('/api/territories?year=1920')).json).area_km2).toBe(450000);
    expect(de((await get('/api/territories?year=1946')).json)).toBeUndefined();
  });
  it('returns boundaries on request, and filters by bbox with the spatial index', async () => {
    const geo = (await get('/api/territories?year=1900&geometry=1')).json;
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.features[0].geometry.type).toBe('Polygon');
    expect((await get('/api/territories?year=1900&bbox=-1,19,11,31')).json.territories.map((t: any) => t.name)).toEqual(['Algeria']);
    expect((await get('/api/territories?year=1900&bbox=100,0,110,10')).json.count).toBe(0);
  });
  it('rejects impossible years', async () => {
    for (const y of ['0', 'abc', '3000', '-200000']) expect((await get(`/api/territories?year=${y}`)).status).toBe(400);
  });
  it('finds a territory at a point', async () => {
    expect((await get('/api/territories/at?lon=5&lat=25&year=1900')).json.name).toBe('Algeria');
    expect((await get('/api/territories/at?lon=120&lat=-30&year=1900')).json.id).toBeNull();
  });
  it('reports when an entity is not on the map', async () => {
    const r = (await get('/api/entities/cs:255/at?year=1960')).json;
    expect(r.territoryId).toBeNull();
    expect(r.lastMapped).toBeGreaterThan(1945);
    expect((await get('/api/entities/cs:255/at?year=1900')).json.territoryId).toBeTruthy();
  });
});

describe('panels change with the date', () => {
  const panelFor = async (year: number) => {
    const at = (await get(`/api/entities/cs:255/at?year=${year}`)).json;
    return (await get(`/api/territories/${at.territoryId}/panel?year=${year}`)).json;
  };
  it('names the state of that moment', async () => {
    expect((await panelFor(1900)).identity.label).toBe('German Empire');
    expect((await panelFor(1925)).identity.label).toBe('Weimar Republic');
  });
  it('shows the ruler in office only', async () => {
    expect((await panelFor(1900)).rulers.map((r: any) => r.label)).toEqual(['Wilhelm II']);
    expect((await panelFor(1887)).rulers).toEqual([]);
    expect((await panelFor(1922)).rulers.map((r: any) => r.label)).toEqual(['Friedrich Ebert']);
    expect((await panelFor(1932)).rulers).toEqual([]);
  });
  it('shows the flag of the period with its source', async () => {
    const a = await panelFor(1900);
    expect(a.flags[0].image.file).toBe('Flag of the German Empire.svg');
    expect(a.flags[0].match).toBe('period-stated');
    expect(a.flags[0].image.page).toContain('commons.wikimedia.org');
    expect((await panelFor(1925)).flags[0].image.file).toBe('Flag of Germany (3-2).svg');
  });
  it('labels a lifetime-only flag as such', async () => {
    const fr = db.prepare(`SELECT id FROM territory WHERE name='France' AND set_id='hb_1400'`).get() as any;
    const p = (await get(`/api/territories/${fr.id}/panel?year=1453`)).json;
    expect(p.flags[0].match).toBe('state-lifetime');
    expect(p.mapSource.dataset).toBe('Historical Basemaps');
    expect(p.snapshotHeld).toBe(true);
  });
  it('records derived colonial status with its reasoning', async () => {
    const t = db.prepare(`SELECT id FROM territory WHERE entity_id='cs:615'`).get() as any;
    const p = (await get(`/api/territories/${t.id}/panel?year=1900`)).json;
    expect(p.kind === 'dependency' || p.sovereign?.name === 'France').toBe(true);
    expect(p.sovereign.note).toMatch(/Derived/);
    expect(p.capital.label).toBe('Algiers');
  });
  it('404s unknown territories', async () => {
    expect((await get('/api/territories/999999/panel?year=1900')).status).toBe(404);
  });
});

describe('search', () => {
  const titles = async (q: string) => (await get(`/api/search?q=${encodeURIComponent(q)}`)).json.hits.map((h: any) => h.title);
  it('finds by alternative name and language', async () => {
    expect(await titles('Royaume de France')).toContain('France');
    expect(await titles('deutsches reich')).toContain('Germany');
  });
  it('finds prefix, typo-tolerant and internal text', async () => {
    expect(await titles('Constant')).toContain('Fall of Constantinople');
    expect(await titles('Constantinopel')).toContain('Fall of Constantinople');
  });
  it('resolves persons, events and dates to a year', async () => {
    const hits = (await get('/api/search?q=wilhelm')).json.hits;
    expect(hits[0].year).toBeGreaterThan(1888);
    expect(hits[0].year).toBeLessThan(1919);
    expect((await get('/api/search?q=1453')).json.hits[0]).toMatchObject({ type: 'date', year: 1453 });
    expect((await get('/api/search?q=44%20BC')).json.hits[0]).toMatchObject({ type: 'date', year: -44 });
  });
  it('survives FTS syntax in user input', async () => {
    for (const q of ['"', 'a AND', 'NEAR(', '*', "o'brien", '(((']) expect((await get(`/api/search?q=${encodeURIComponent(q)}`)).status).toBe(200);
  });
});

describe('other endpoints', () => {
  it('filters places by date', async () => {
    expect((await get('/api/places?year=-1000')).json.features).toEqual([]);
    expect((await get('/api/places?year=100')).json.features[0].properties.n).toBe('Rome');
  });
  it('lists events in order', async () => {
    expect((await get('/api/events')).json.events[0].year).toBe(1453);
  });
  it('answers an empty tile with 204', async () => {
    expect((await get('/tiles/cs/9/0/0.pbf')).status).toBe(204);
  });
  it('validation finds no errors on good data and catches a broken interval', () => {
    expect(validate(db).errors).toBe(0);
    db.exec(`UPDATE territory SET valid_to=valid_from WHERE id=(SELECT min(id) FROM territory)`);
    expect(validate(db).errors).toBeGreaterThan(0);
  });
});

describe('caching and imagery', () => {
  it('marks versioned tiles immutable and unversioned ones not', async () => {
    const v = (await app.inject({ url: '/api/meta' })).json().version;
    expect(v).toMatch(/^[0-9a-f]{10}$/);
    expect((await app.inject({ url: `/tiles/cs/9/0/0.pbf?v=${v}` })).headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/tiles/cs/9/0/0.pbf?v=old' })).headers['cache-control']).not.toContain('immutable');
  });
  it('rejects imagery tiles out of range', async () => {
    for (const u of ['/imagery/9/0/0.jpg', '/imagery/2/4/0.jpg', '/imagery/a/0/0.jpg', '/imagery/-1/0/0.jpg']) expect((await app.inject({ url: u })).statusCode).toBe(400);
  });
  it('fetches an imagery tile once, then serves it from disk, and shares concurrent requests', async () => {
    const { imageryStore } = await import('../../packages/server/src/imagery.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    let calls = 0;
    const store = imageryStore(mkdtempSync(join(tmpdir(), 'img-')), (async () => { calls++; return new Response(new Uint8Array([1, 2, 3])); }) as typeof fetch);
    const [a, b] = await Promise.all([store(1, 0, 0), store(1, 0, 0)]);
    expect([...a]).toEqual([1, 2, 3]);
    expect([...b]).toEqual([1, 2, 3]);
    expect([...(await store(1, 0, 0))]).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });
  it('reports an upstream failure instead of caching it', async () => {
    const { imageryStore } = await import('../../packages/server/src/imagery.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const store = imageryStore(mkdtempSync(join(tmpdir(), 'img-')), (async () => new Response('', { status: 503 })) as typeof fetch);
    await expect(store(1, 0, 0)).rejects.toThrow(/503/);
    await expect(store(1, 0, 0)).rejects.toThrow(/503/);
  });
});
