import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { PMTiles, type Source } from 'pmtiles';
import { writePmtiles } from '../../packages/server/src/pmtiles.ts';

const source = (buf: Buffer): Source => ({
  getKey: () => 'mem',
  getBytes: async (offset, length) => ({ data: buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length) as ArrayBuffer }),
});

function tiles(maxZ: number, every = 1) {
  const out: { z: number; x: number; y: number; raw: string; data: Buffer }[] = [];
  let i = 0;
  for (let z = 0; z <= maxZ; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
    if (i++ % every) continue;
    // Repeated contents exercise deduplication and run lengths.
    const raw = (x + y) % 5 === 0 ? 'ocean' : `tile ${z}/${x}/${y}`;
    out.push({ z, x, y, raw, data: gzipSync(raw) });
  }
  return out;
}

describe('PMTiles writer', () => {
  it('round-trips through the reference reader', async () => {
    const ts = tiles(4);
    const p = new PMTiles(source(writePmtiles(ts, { name: 't' })));
    const h = await p.getHeader();
    expect([h.minZoom, h.maxZoom, h.tileCompression, h.tileType]).toEqual([0, 4, 2, 1]);
    expect(h.numAddressedTiles).toBe(ts.length);
    expect(h.numTileContents).toBeLessThan(ts.length);
    for (const t of ts) expect(Buffer.from((await p.getZxy(t.z, t.x, t.y))!.data).toString()).toBe(t.raw);
    expect(await p.getMetadata()).toEqual({ name: 't' });
  });
  it('splits a large directory into leaves and still finds every tile', async () => {
    const ts = tiles(8, 3);
    const buf = writePmtiles(ts, {});
    const p = new PMTiles(source(buf));
    expect((await p.getHeader()).leafDirectoryLength).toBeGreaterThan(0);
    for (const t of ts.filter((_, i) => i % 97 === 0)) expect(Buffer.from((await p.getZxy(t.z, t.x, t.y))!.data).toString()).toBe(t.raw);
    const have = new Set(ts.map((t) => `${t.z}/${t.x}/${t.y}`));
    const missing = [...Array(2 ** 8).keys()].map((x) => [8, x, 7] as const).find(([z, x, y]) => !have.has(`${z}/${x}/${y}`))!;
    expect((await p.getZxy(...missing))?.data.byteLength ?? 0).toBe(0);
  });
});
