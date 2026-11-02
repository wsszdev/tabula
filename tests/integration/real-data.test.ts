import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { DB_PATH } from '../../packages/pipeline/src/db.ts';
import { buildApp } from '../../packages/server/src/app.ts';

// Checks against the built database and well-established history. Skipped until `npm run data` has run.
const has = existsSync(DB_PATH) && (() => { const d = new DatabaseSync(DB_PATH, { readOnly: true }); const n = (d.prepare(`SELECT count(*) n FROM tile`).get() as any).n; d.close(); return n > 0; })();

describe.skipIf(!has)('built atlas', () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const app = buildApp(db, { webDist: '/nonexistent' });
  afterAll(() => app.close());
  const get = async (u: string) => (await app.inject({ url: u })).json();
  const names = async (y: number) => (await get(`/api/territories?year=${y}`)).territories.map((t: any) => t.name as string);
  const panel = async (name: string, y: number) => {
    const t = (await get(`/api/territories?year=${y}`)).territories.find((x: any) => x.name === name || x.name.startsWith(name));
    if (!t) throw new Error(`${name} not on the map in ${y}`);
    return get(`/api/territories/${t.id}/panel?year=${y}`);
  };

  it('answers the 1453 query from the 1400 snapshot', async () => {
    const r = await get('/api/territories?year=1453');
    expect(r.count).toBeGreaterThan(50);
    expect(r.territories.every((t: any) => t.set_id === 'hb_1400')).toBe(true);
  });
  it('keeps states to their dates (CShapes)', async () => {
    expect(await names(1950)).toContain('German Federal Republic');
    expect(await names(1944)).not.toContain('German Federal Republic');
    expect(await names(1995)).not.toContain('German Democratic Republic');
    const ussr = (n: string) => n.startsWith('Russia');
    expect((await names(1991)).some(ussr)).toBe(true);
    expect(await names(1993)).toContain('Ukraine');
    expect(await names(1985)).not.toContain('Ukraine');
    expect(await names(1910)).toContain('Austria-Hungary');
    expect(await names(1925)).not.toContain('Austria-Hungary');
  });
  it('identifies the state by period', async () => {
    expect((await panel('Germany', 1900)).identity.label).toBe('German Empire');
    expect((await panel('Germany', 1925)).identity.label).toBe('Weimar Republic');
    expect((await panel('Germany', 1940)).identity.label).toBe('Nazi Germany');
    expect((await panel('Russia', 1960)).identity.label).toBe('Soviet Union');
  });
  it('France in 1789 is the Kingdom, with no tricolour', async () => {
    const p = await panel('France', 1789);
    expect(p.identity.label).toBe('Kingdom of France');
    for (const f of p.flags) expect(f.image.file).not.toMatch(/^Flag of France( \(\d+.*\))?\.svg$/);
    expect(p.mapSource.dataset).toBe('Historical Basemaps');
  });
  it('shows no ruler from another period', async () => {
    for (const [name, y] of [['Germany', 1900], ['France', 1950], ['Russia', 1960], ['United States of America', 1863 + 40]] as const) {
      const p = await panel(name, y);
      const t = y + 0.5;
      for (const r of p.rulers) {
        if (r.from != null) expect(r.from).toBeLessThanOrEqual(t);
        if (r.to != null) expect(r.to).toBeGreaterThan(t);
      }
    }
    const names_ = (await panel('Germany', 1900)).rulers.map((r: any) => r.label);
    expect(names_.some((n: string) => /Wilhelm|William/.test(n))).toBe(true);
  });
  it('regressions found by reading real panels', async () => {
    const us = await panel('United States', 1863);
    const rulers = us.rulers.map((r: any) => r.label);
    expect(rulers).toContain('Abraham Lincoln');
    expect(rulers).not.toContain('Quentin Trembley');
    expect(rulers).not.toContain('Zalmon Richards');
    for (const f of us.flags) expect(f.image.file).not.toMatch(/DDD-F-416E/);
    const fr = await panel('France', 2010);
    expect(fr.rulers.map((r: any) => r.label)).toContain('Nicolas Sarkozy');
    expect(fr.rulers.map((r: any) => r.label)).not.toContain('Costa-Gavras');
    expect((await panel('Germany', 1900)).rulers.map((r: any) => r.label).join()).not.toMatch(/Anhalt/);
    expect((await panel('Germany', 1940)).kind).not.toBe('dependency');
    expect((await panel('Germany', 1940)).sovereign).toBeNull();
    for (const f of (await panel('Ottoman', 1600)).flags) expect(f.image.file).not.toMatch(/fictitious/i);
    expect((await panel('Ming', 1500)).identity.label).toBe('Ming dynasty');
    expect((await panel('Brazil', 1900)).sovereign).toBeNull();
  });
  it('search stays relevant and honest', async () => {
    const top = async (q: string) => (await get('/api/search?q=' + encodeURIComponent(q))).hits.map((h: any) => h.title);
    expect((await top('Napoleon'))[0]).toBe('Napoleon');
    expect(await top('Battle of Waterloo')).toEqual(['Battle of Waterloo']);
    expect((await top('Cleopatra')).join()).not.toMatch(/China|United States/);
    expect(await top('Aztec')).not.toContain('Tunisia');
    expect((await top('Constantinople')).filter((t: string) => t === 'Constantinople').length).toBe(1);
  });
  it('Byzantine Empire leaves the map at its documented end', async () => {
    const before = await names(1452);
    const after = await names(1460);
    if (before.includes('Byzantine Empire')) expect(after).not.toContain('Byzantine Empire');
  });
  it('search finds the Roman Empire and positions it', async () => {
    const h = (await get('/api/search?q=Roman%20Empire')).hits[0];
    expect(h.title).toMatch(/Roman Empire/);
    expect(h.year).toBeGreaterThan(-30);
    expect(h.year).toBeLessThan(500);
    expect(h.bbox).toBeTruthy();
    expect(h.territoryId).toBeTruthy();
  });
  it('search works in other languages and for rulers', async () => {
    expect((await get('/api/search?q=' + encodeURIComponent('Römisches Reich'))).hits.some((x: any) => /Roman/.test(x.title))).toBe(true);
    expect((await get('/api/search?q=Napoleon')).hits.length).toBeGreaterThan(0);
  });
});
