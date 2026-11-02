import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

const upstream = (z: number, y: number, x: number) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`;

export function validTile(z: number, y: number, x: number, maxZ = 8): boolean {
  return [z, y, x].every(Number.isInteger) && z >= 0 && z <= maxZ && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

/** Read-through disk cache: each NASA tile is fetched once, then served locally to everyone. */
export function imageryStore(dir: string, fetcher: typeof fetch = fetch) {
  const inFlight = new Map<string, Promise<Buffer>>();
  return async (z: number, y: number, x: number): Promise<Buffer> => {
    const key = `${z}/${y}/${x}`;
    const file = resolve(dir, `${key}.jpg`);
    if (existsSync(file)) return fs.readFile(file);
    let job = inFlight.get(key);
    if (!job) {
      job = (async () => {
        const res = await fetcher(upstream(z, y, x), { headers: { 'User-Agent': 'TABULA-historical-atlas/0.1' }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`imagery upstream HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
        return buf;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return job;
  };
}
