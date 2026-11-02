import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { astroToYear, yearToT, type MetaPayload, type EventItem } from '@tabula/shared';
import { imageryStore, validTile } from './imagery.ts';
import { buildPanel } from './panel.ts';
import { search } from './search.ts';

function req_log(q: { log: { warn: (o: unknown, m: string) => void } }, e: unknown) {
  q.log.warn({ err: String(e) }, 'imagery fetch failed');
}

function pointInRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeom(x: number, y: number, g: any) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((p: number[][][]) => pointInRing(x, y, p[0]!) && !p.slice(1).some((h) => pointInRing(x, y, h)));
}

export function parseYearParam(v: unknown): number {
  const y = Number(v);
  if (!Number.isInteger(y) || y === 0 || y < -123000 || y > 2019) {
    const err: any = new Error('year must be a non-zero integer between -123000 and 2019 (negative means BC)');
    err.statusCode = 400;
    throw err;
  }
  return y;
}

export function buildApp(db: DatabaseSync, opts: { logger?: boolean; webDist?: string; imageryDir?: string; imageryFetch?: typeof fetch } = {}) {
  const app = Fastify({ logger: opts.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false });
  app.register(compress, { threshold: 1024, encodings: ['gzip', 'deflate'] });

  // Immutable build output: identical year keys always yield identical bytes.
  const LONG = 'public, max-age=86400, stale-while-revalidate=604800';
  // Versioned URLs can be kept forever: a new build yields a new version.
  const FOREVER = 'public, max-age=31536000, immutable';
  const dataVersion = createHash('sha1').update(JSON.stringify(db.prepare(`SELECT id, tile_count, bytes FROM tile_set ORDER BY id`).all())).digest('hex').slice(0, 10);
  const dataCache = (q: { query: unknown }) => ((q.query as { v?: string }).v === dataVersion ? FOREVER : LONG);
  const imagery = imageryStore(opts.imageryDir ?? resolve(import.meta.dirname, '../../../data/imagery'), opts.imageryFetch);

  const stmts = {
    tile: db.prepare(`SELECT data FROM tile WHERE set_id=? AND z=? AND x=? AND y=?`),
    terrAt: db.prepare(`SELECT id, entity_id, name, set_id, class, area_km2, valid_from, valid_to, sovereign, capital_name FROM territory WHERE set_id=? AND valid_from <= ? AND valid_to > ?`),
    terrGeo: db.prepare(`SELECT id, geojson FROM territory WHERE id=?`),
  };
  const sets = db.prepare(`SELECT id,dataset,from_t,to_t,year FROM tile_set ORDER BY from_t`).all() as any[];
  const hbSet = (t: number) => sets.find((s) => s.dataset === 'basemaps' && t >= s.from_t && t < s.to_t);
  const csSet = sets.find((s) => s.dataset === 'cshapes');
  const activeSets = (t: number, dataset?: string) => {
    if (dataset === 'basemaps') return [hbSet(t)].filter(Boolean);
    if (dataset === 'cshapes') return csSet && t >= csSet.from_t && t < csSet.to_t ? [csSet] : [];
    return csSet && t >= csSet.from_t && t < csSet.to_t ? [csSet] : [hbSet(t)].filter(Boolean);
  };

  app.get('/api/health', async () => ({ ok: true, territories: (db.prepare('SELECT count(*) n FROM territory').get() as any).n }));

  app.get('/api/meta', async (_q, reply): Promise<MetaPayload> => {
    reply.header('Cache-Control', 'public, max-age=3600');
    const count = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n;
    return {
      version: dataVersion,
      sets: sets.map((s) => ({ id: s.id, dataset: s.dataset, from: s.from_t, to: s.to_t, year: s.year })),
      timeMin: -123000, timeMax: 2019,
      counts: { territories: count('territory'), entities: count('entity'), events: count('event'), rulers: (db.prepare(`SELECT count(*) n FROM fact WHERE kind='ruler'`).get() as any).n },
      sources: (db.prepare(`SELECT name,url,license,retrieved,records,COALESCE(sha256,'') sha256 FROM source_run`).all() as any[]),
    };
  });

  app.get<{ Params: { set: string; z: string; x: string; y: string } }>('/tiles/:set/:z/:x/:y.pbf', async (q, reply) => {
    const row = stmts.tile.get(q.params.set, Number(q.params.z), Number(q.params.x), Number(q.params.y)) as any;
    if (!row) return reply.code(204).header('Cache-Control', dataCache(q)).send();
    return reply.header('Content-Type', 'application/x-protobuf').header('Content-Encoding', 'gzip').header('Cache-Control', dataCache(q)).send(Buffer.from(row.data));
  });

  app.get<{ Params: { set: string } }>('/api/labels/:set', async (q, reply) => {
    const row = db.prepare(`SELECT labels FROM tile_set WHERE id=?`).get(q.params.set) as any;
    if (!row?.labels) return reply.code(404).send({ error: 'unknown set' });
    return reply.header('Content-Type', 'application/json').header('Content-Encoding', 'gzip').header('Cache-Control', dataCache(q)).send(Buffer.from(row.labels));
  });

  app.get<{ Params: { z: string; y: string; x: string } }>('/imagery/:z/:y/:x.jpg', async (q, reply) => {
    const [z, y, x] = [Number(q.params.z), Number(q.params.y), Number(q.params.x)];
    if (!validTile(z, y, x)) return reply.code(400).send({ error: 'tile out of range' });
    try {
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=2592000').send(await imagery(z, y, x));
    } catch (e) {
      req_log(q, e);
      return reply.code(502).send({ error: 'imagery source unavailable' });
    }
  });

  /** "All political entities and their boundaries that existed in the year 1453." */
  app.get<{ Querystring: { year: string; dataset?: string; bbox?: string; geometry?: string } }>('/api/territories', async (q, reply) => {
    const year = parseYearParam(q.query.year);
    const t = yearToT(year);
    let rows: any[] = [];
    for (const s of activeSets(t, q.query.dataset)) rows.push(...(stmts.terrAt.all(s.id, t, t) as any[]));
    if (q.query.bbox) {
      const b = q.query.bbox.split(',').map(Number);
      if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) return reply.code(400).send({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
      const inBox = new Set((db.prepare(`SELECT id FROM territory_rtree WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?`).all(b[0]!, b[2]!, b[1]!, b[3]!) as any[]).map((r) => r.id));
      rows = rows.filter((r) => inBox.has(r.id));
    }
    const year_ = { year, t, count: rows.length };
    if (q.query.geometry !== '1') return { ...year_, territories: rows };
    return {
      type: 'FeatureCollection', ...year_,
      features: rows.map((r) => ({ type: 'Feature', id: r.id, properties: r, geometry: JSON.parse(gunzipSync((stmts.terrGeo.get(r.id) as any).geojson).toString()) })),
    };
  });

  /** What was at this point in this year? Uses the R*Tree, then exact geometry. */
  app.get<{ Querystring: { lon: string; lat: string; year: string; dataset?: string } }>('/api/territories/at', async (q, reply) => {
    const year = parseYearParam(q.query.year);
    const t = yearToT(year);
    const lon = Number(q.query.lon), lat = Number(q.query.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return reply.code(400).send({ error: 'lon and lat are required' });
    const ids = new Set(activeSets(t, q.query.dataset).map((s) => s.id));
    const rows = db.prepare(`SELECT t.id, t.name, t.set_id, t.entity_id, t.area_km2, t.geojson FROM territory_rtree r JOIN territory t ON t.id=r.id WHERE r.min_lon<=? AND r.max_lon>=? AND r.min_lat<=? AND r.max_lat>=? AND t.valid_from<=? AND t.valid_to>? ORDER BY t.area_km2`).all(lon, lon, lat, lat, t, t) as any[];
    for (const r of rows) {
      if (!ids.has(r.set_id)) continue;
      if (pointInGeom(lon, lat, JSON.parse(gunzipSync(r.geojson).toString()))) return { id: r.id, name: r.name, entityId: r.entity_id };
    }
    return { id: null };
  });

  /** The territory an entity held in a year, or the nearest years it is mapped. */
  app.get<{ Params: { id: string }; Querystring: { year: string } }>('/api/entities/:id/at', async (q) => {
    const year = parseYearParam(q.query.year);
    const t = yearToT(year);
    const row = db.prepare(`SELECT id FROM territory WHERE entity_id=? AND valid_from<=? AND valid_to>? LIMIT 1`).get(q.params.id, t, t) as any;
    if (row) return { territoryId: row.id };
    const prev = db.prepare(`SELECT valid_to v, id FROM territory WHERE entity_id=? AND valid_to<=? ORDER BY valid_to DESC LIMIT 1`).get(q.params.id, t) as any;
    const next = db.prepare(`SELECT valid_from v, id FROM territory WHERE entity_id=? AND valid_from>? ORDER BY valid_from LIMIT 1`).get(q.params.id, t) as any;
    return { territoryId: null, lastMapped: prev?.v ?? null, nextMapped: next?.v ?? null };
  });

  app.get<{ Params: { id: string }; Querystring: { year: string } }>('/api/territories/:id/panel', async (q, reply) => {
    const panel = buildPanel(db, Number(q.params.id), parseYearParam(q.query.year));
    if (!panel) return reply.code(404).send({ error: 'territory not found' });
    return panel;
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (q) => {
    return { hits: search(db, q.query.q ?? '', Math.min(Number(q.query.limit) || 12, 30)) };
  });

  app.get<{ Querystring: { year: string; kinds?: string } }>('/api/places', async (q, reply) => {
    const t = yearToT(parseYearParam(q.query.year));
    reply.header('Cache-Control', LONG);
    const rows = db.prepare(`SELECT id,name,lon,lat,kind,from_t,to_t,origin FROM place WHERE from_t IS NOT NULL AND from_t<=? AND (to_t IS NULL OR to_t>?)`).all(t, t) as any[];
    // The same capital can be listed by both CShapes and Wikidata; one point is enough.
    const seen = new Set<string>();
    const features = rows.filter((r) => {
      const k = `${r.name}|${r.lon.toFixed(1)}|${r.lat.toFixed(1)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { n: r.name, k: r.kind, o: r.origin } }));
    return { type: 'FeatureCollection', features };
  });

  app.get<{ Querystring: { from?: string; to?: string; limit?: string } }>('/api/events', async (q, reply): Promise<{ events: EventItem[] }> => {
    reply.header('Cache-Control', LONG);
    const from = q.query.from ? yearToT(Number(q.query.from)) : -1e6;
    const to = q.query.to ? yearToT(Number(q.query.to)) : 1e6;
    const rows = db.prepare(`SELECT * FROM event WHERE from_t>=? AND from_t<=? ORDER BY sitelinks DESC LIMIT ?`).all(from, to, Math.min(Number(q.query.limit) || 120, 500)) as any[];
    return {
      events: rows.map((e) => ({ qid: e.qid, label: e.label, description: e.description, from: e.from_t, to: e.to_t, year: astroToYear(Math.floor(e.from_t)) || 1, kind: e.kind, lon: e.lon, lat: e.lat })).sort((a, b) => a.from - b.from),
    };
  });

  const dist = opts.webDist ?? resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(dist)) {
    app.register(fastifyStatic, {
      root: dist, wildcard: false, cacheControl: false,
      setHeaders: (res, path) => {
        // Hashed bundles never change; the page and the worker must always be checked.
        if (path.includes('/assets/')) res.setHeader('Cache-Control', FOREVER);
        else if (path.includes('/glyphs/')) res.setHeader('Cache-Control', 'public, max-age=2592000');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') || req.url.startsWith('/tiles') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  app.setErrorHandler((err: any, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: err.message });
  });
  return app;
}
