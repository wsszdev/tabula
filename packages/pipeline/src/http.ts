import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE } from './db.ts';

const UA = 'TABULA-historical-atlas/0.1 (data pipeline; https://icr.ethz.ch/data/cshapes/ user) node';
const gaps: Record<string, number> = { 'query.wikidata.org': 1200, 'www.wikidata.org': 150, 'en.wikipedia.org': 150, 'commons.wikimedia.org': 150 };
const nextAt = new Map<string, number>();

async function throttle(host: string) {
  const gap = gaps[host] ?? 500;
  const now = Date.now();
  const at = Math.max(now, nextAt.get(host) ?? 0);
  nextAt.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Disk-cached, host-rate-limited JSON fetch with retries that honour Retry-After. */
export async function cachedJson<T = any>(url: string, body?: string, opts: { maxAgeDays?: number; accept?: string } = {}): Promise<T> {
  const key = createHash('sha1').update(url + '\n' + (body ?? '')).digest('hex');
  const dir = resolve(CACHE, 'http', key.slice(0, 2));
  const path = resolve(dir, key + '.json');
  const maxAge = (opts.maxAgeDays ?? 60) * 864e5;
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < maxAge) return JSON.parse(readFileSync(path, 'utf8'));
  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { 'User-Agent': UA, Accept: opts.accept ?? 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 3;
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (json?.error) throw new Error(`API error ${json.error.code}: ${json.error.info}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, text);
      return json;
    } catch (e) {
      lastErr = e;
      if (String(e).includes('HTTP 4')) break;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
    }
  }
  throw new Error(`fetch failed: ${url.slice(0, 160)}: ${lastErr}`);
}

export async function sparql<T = Record<string, string>>(query: string): Promise<T[]> {
  const j = await cachedJson('https://query.wikidata.org/sparql', 'query=' + encodeURIComponent(query), { accept: 'application/sparql-results+json' });
  return j.results.bindings.map((b: any) => Object.fromEntries(Object.entries(b).map(([k, v]: any) => [k, v.value]))) as T[];
}

export const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

export function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
