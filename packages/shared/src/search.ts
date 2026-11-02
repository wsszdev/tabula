/**
 * Search over the exported index, in the browser. Mirrors the server's SQLite search:
 * word-prefix matching first, then substring matching, then trigram similarity for typos.
 */
import { formatYear, parseYear, type SearchHit } from './index.ts';

export const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const words = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];

export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / (a.size + b.size - n || 1);
}

/** As exported: `rows` are [names joined by " | ", weight, index into `hits`]. */
export interface SearchIndexData { hits: SearchHit[]; rows: [string, number, number][] }

interface Row { text: string; lower: string; names: string[]; words: string[]; weight: number; hit: number }
export interface SearchIndex { hits: SearchHit[]; rows: Row[] }

export function prepareSearch(data: SearchIndexData): SearchIndex {
  return {
    hits: data.hits,
    rows: data.rows.map(([text, weight, hit]) => ({ text, lower: text.toLowerCase(), names: fold(text).split(' | '), words: words(text), weight, hit })),
  };
}

export function searchIndex(index: SearchIndex, q: string, limit = 12): SearchHit[] {
  const text = q.trim();
  if (text.length < 2) return [];
  const hits: SearchHit[] = [];
  const y = parseYear(text);
  if (y != null) hits.push({ type: 'date', id: String(y), title: formatYear(y), subtitle: 'Go to this year', year: y });

  const toks = words(text);
  let rows = toks.length ? index.rows.filter((r) => toks.every((t) => r.words.some((w) => w.startsWith(t)))) : [];
  if (!rows.length && text.length >= 3) {
    // Catches word-internal text ("byzant").
    const needle = text.toLowerCase();
    rows = index.rows.filter((r) => r.lower.includes(needle));
    if (!rows.length && text.length >= 5) {
      // Spelling variants ("Ottomane").
      const grams = trigrams(fold(text));
      rows = index.rows.filter((r) => r.names.some((n) => similarity(grams, trigrams(n)) >= 0.45));
    }
  }
  const needle = fold(text);
  const scored = rows.map((r) => ({ r, score: r.weight + (r.names.includes(needle) ? 20 : r.names.some((n) => n.startsWith(needle)) ? 8 : 0) }))
    .sort((a, b) => b.score - a.score);

  const seen = new Set<number>();
  const seenTitle = new Set<string>();
  for (const { r } of scored) {
    if (hits.length >= limit) break;
    if (seen.has(r.hit)) continue;
    seen.add(r.hit);
    const hit = index.hits[r.hit]!;
    // One city can have many dated records; the search list needs it once.
    const tk = hit.type === 'place' ? `place|${hit.title}` : `${hit.type}|${hit.title}|${hit.subtitle}`;
    if (seenTitle.has(tk)) continue;
    seenTitle.add(tk);
    hits.push(hit);
  }
  return hits;
}
