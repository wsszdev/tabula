// Builds the signed-distance-field glyph ranges MapLibre needs for globe labels (Spectral, SIL OFL).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { ROOT } from './db.ts';

const fontnik = createRequire(import.meta.url)('fontnik');
const range = promisify(fontnik.range) as (o: { font: Buffer; start: number; end: number }) => Promise<Buffer>;

for (const w of ['Regular', 'Italic', 'SemiBold', 'SemiBoldItalic']) {
  const font = readFileSync(resolve(ROOT, `data/fonts/Spectral-${w}.ttf`));
  const dir = resolve(ROOT, `packages/web/public/glyphs/Spectral ${w}`);
  mkdirSync(dir, { recursive: true });
  for (let s = 0; s < 8960; s += 256) writeFileSync(resolve(dir, `${s}-${s + 255}.pbf`), await range({ font, start: s, end: s + 255 }));
  console.log('glyphs', w);
}
