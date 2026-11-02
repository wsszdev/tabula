import { normalizeName } from './geo.ts';

export interface Candidate {
  qid: string;
  label: string;
  aliases: string[];
  inception: number | null;
  dissolved: number | null;
  sitelinks: number;
}
export interface Assignment { qid: string; from: number; to: number; method: string; confidence: number }

const TEMPLATES = [
  (n: string) => `kingdom of ${n}`, (n: string) => `${n} empire`, (n: string) => `empire of ${n}`, (n: string) => `republic of ${n}`,
  (n: string) => `sultanate of ${n}`, (n: string) => `${n} sultanate`, (n: string) => `duchy of ${n}`, (n: string) => `grand duchy of ${n}`,
  (n: string) => `principality of ${n}`, (n: string) => `${n} kingdom`, (n: string) => `${n} khanate`, (n: string) => `khanate of ${n}`,
  (n: string) => `${n} caliphate`, (n: string) => `${n} dynasty`, (n: string) => `county of ${n}`, (n: string) => `${n} culture`, (n: string) => `${n} civilization`,
];

/** Strips annotations map makers add, so "Madagascar (France)" looks up "Madagascar". */
export function baseName(name: string): string {
  return normalizeName(name.replace(/\(.*?\)/g, ' '));
}

export class CandidateIndex {
  private byName = new Map<string, { c: Candidate; how: 'label' | 'alias' }[]>();
  constructor(cands: Candidate[]) {
    for (const c of cands) {
      this.add(c.label, c, 'label');
      for (const a of c.aliases) this.add(a, c, 'alias');
    }
  }
  private add(name: string, c: Candidate, how: 'label' | 'alias') {
    const k = normalizeName(name);
    if (!k) return;
    const list = this.byName.get(k) ?? [];
    if (!list.some((x) => x.c.qid === c.qid && x.how === how)) list.push({ c, how });
    this.byName.set(k, list);
  }
  lookup(name: string) {
    const n = baseName(name);
    const out = (this.byName.get(n) ?? []).map((x) => ({ ...x, tier: x.how }));
    for (const t of TEMPLATES) for (const x of this.byName.get(t(n)) ?? []) out.push({ ...x, tier: 'template' as never });
    return out as { c: Candidate; how: string; tier: 'label' | 'alias' | 'template' }[];
  }
}

const TIER_BASE = { label: 0.85, template: 0.75, alias: 0.68 } as const;

/** Scores a candidate for one instant: specific, well-documented polities beat long-lived catch-alls. */
export function scoreAt(c: Candidate, tier: 'label' | 'alias' | 'template', t: number): number | null {
  const dated = c.inception != null || c.dissolved != null;
  if (c.inception != null && t < c.inception - 1) return null;
  if (c.dissolved != null && t >= c.dissolved + 1) return null;
  if (!dated) return null;
  let span = (c.dissolved ?? 2030) - (c.inception ?? c.dissolved! - 1000);
  span = Math.max(span, 1);
  const specificity = 0.1 * (1 - Math.min(Math.log10(span) / 4, 1));
  const fame = 0.1 * Math.min(Math.log10(c.sitelinks + 1) / 2, 1);
  // An item with no end date usually describes the present-day state; in the past it is a weak fallback.
  const presentDayPenalty = c.dissolved == null && t < 1945 ? 0.25 : 0;
  return TIER_BASE[tier] + specificity + fame - presentDayPenalty;
}

/**
 * Assigns time-bounded Wikidata identities to a map entity over [from, to).
 * The range is sampled at every candidate boundary; each resulting span takes the
 * best candidate alive during it. Undated candidates are accepted only as a low-confidence
 * fallback for an exact label, so a date mismatch can never be hidden by them.
 */
export function assignIdentities(name: string, from: number, to: number, index: CandidateIndex): Assignment[] {
  const hits = index.lookup(name).filter((h) => h.c.sitelinks >= (h.tier === 'label' ? 1 : 3));
  if (!hits.length) return [];
  const cuts = new Set([from, to]);
  for (const { c } of hits) {
    for (const v of [c.inception, c.dissolved]) if (v != null && v > from && v < to) cuts.add(v);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const spans: Assignment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    const mid = (a + b) / 2;
    let best: { qid: string; tier: string; score: number } | null = null;
    for (const h of hits) {
      const s = scoreAt(h.c, h.tier, mid);
      if (s != null && (!best || s > best.score)) best = { qid: h.c.qid, tier: h.tier, score: s };
    }
    if (!best) continue;
    const last = spans.at(-1);
    if (last && last.qid === best.qid && last.to === a) last.to = b;
    else spans.push({ qid: best.qid, from: a, to: b, method: `name-${best.tier}+date`, confidence: Math.min(best.score, 0.95) });
  }
  if (!spans.length) {
    const undated = hits.filter((h) => h.tier === 'label' && h.c.inception == null && h.c.dissolved == null).sort((x, y) => y.c.sitelinks - x.c.sitelinks)[0];
    if (undated) spans.push({ qid: undated.c.qid, from, to, method: 'name-label, undated', confidence: 0.5 });
  }
  return spans;
}

const CLASS_ORDER: [RegExp, string][] = [
  [/colon|protectorate|dependen|mandate|viceroyalty|occupied|overseas/i, 'dependency'],
  [/empire|caliphate/i, 'empire'],
  [/archaeological|ethnic|culture|civili[sz]ation|people|tribe/i, 'culture'],
  [/kingdom|monarchy|duchy|principality|sultanate|khanate|emirate|realm|dynasty/i, 'kingdom'],
  [/republic|federation|confedera|sovereign state/i, 'republic'],
];

export function classFromInstances(labels: string[]): string | null {
  for (const [re, k] of CLASS_ORDER) if (labels.some((l) => re.test(l))) return k;
  return null;
}
