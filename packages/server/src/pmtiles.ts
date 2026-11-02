/**
 * Minimal PMTiles v3 writer (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 * One file per tile set lets a static host serve every tile through HTTP range requests.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

interface Entry { tileId: number; offset: number; length: number; runLength: number }

const HEADER = 127;
const ROOT_BUDGET = 16384 - HEADER;

function varint(out: number[], n: number) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function serializeDirectory(entries: Entry[]): Buffer {
  const out: number[] = [];
  varint(out, entries.length);
  let last = 0;
  for (const e of entries) { varint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(out, e.runLength);
  for (const e of entries) varint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    varint(out, i > 0 && prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return gzipSync(Buffer.from(out), { level: 9 });
}

/** Root directory, and leaf directories when the root alone would not fit in the first 16 KiB. */
function directories(entries: Entry[]): { root: Buffer; leaves: Buffer } {
  const root = serializeDirectory(entries);
  if (root.length <= ROOT_BUDGET) return { root, leaves: Buffer.alloc(0) };
  for (let size = 4096; ; size *= 2) {
    const leafBufs: Buffer[] = [];
    const rootEntries: Entry[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = serializeDirectory(entries.slice(i, i + size));
      rootEntries.push({ tileId: entries[i]!.tileId, offset, length: leaf.length, runLength: 0 });
      leafBufs.push(leaf);
      offset += leaf.length;
    }
    const r = serializeDirectory(rootEntries);
    if (r.length <= ROOT_BUDGET) return { root: r, leaves: Buffer.concat(leafBufs) };
  }
}

/** `tiles` hold gzip-compressed Mapbox Vector Tiles. */
export function writePmtiles(tiles: { z: number; x: number; y: number; data: Uint8Array }[], metadata: Record<string, unknown>): Buffer {
  const sorted = tiles.map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id);
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  const byHash = new Map<string, { offset: number; length: number }>();
  let dataLength = 0;
  for (const t of sorted) {
    const hash = createHash('sha1').update(t.data).digest('hex');
    let at = byHash.get(hash);
    if (!at) {
      at = { offset: dataLength, length: t.data.length };
      byHash.set(hash, at);
      chunks.push(Buffer.from(t.data));
      dataLength += t.data.length;
    }
    const prev = entries[entries.length - 1];
    // Identical neighbours (open ocean, one state's interior) share one run.
    if (prev && prev.offset === at.offset && prev.tileId + prev.runLength === t.id) prev.runLength++;
    else entries.push({ tileId: t.id, offset: at.offset, length: at.length, runLength: 1 });
  }
  const { root, leaves } = directories(entries);
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 9 });
  const zooms = sorted.map((t) => t.z);

  const h = Buffer.alloc(HEADER);
  h.write('PMTiles', 0, 'ascii');
  h.writeUInt8(3, 7);
  const u64 = (pos: number, n: number) => h.writeBigUInt64LE(BigInt(n), pos);
  const rootOffset = HEADER, metaOffset = rootOffset + root.length, leafOffset = metaOffset + meta.length, dataOffset = leafOffset + leaves.length;
  u64(8, rootOffset); u64(16, root.length);
  u64(24, metaOffset); u64(32, meta.length);
  u64(40, leafOffset); u64(48, leaves.length);
  u64(56, dataOffset); u64(64, dataLength);
  u64(72, sorted.length); u64(80, entries.length); u64(88, byHash.size);
  h.writeUInt8(1, 96); // clustered
  h.writeUInt8(2, 97); // internal compression: gzip
  h.writeUInt8(2, 98); // tile compression: gzip
  h.writeUInt8(1, 99); // tile type: MVT
  h.writeUInt8(zooms.length ? Math.min(...zooms) : 0, 100);
  h.writeUInt8(zooms.length ? Math.max(...zooms) : 0, 101);
  h.writeInt32LE(-180e7, 102); h.writeInt32LE(-85e7, 106); h.writeInt32LE(180e7, 110); h.writeInt32LE(85e7, 114);
  h.writeUInt8(0, 118); h.writeInt32LE(0, 119); h.writeInt32LE(0, 123);
  return Buffer.concat([h, root, meta, leaves, ...chunks]);
}
