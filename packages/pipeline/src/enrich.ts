import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sparqlTimeToT, wikidataTimeToT } from '@tabula/shared';
import { CACHE, ROOT, tx } from './db.ts';
import { cachedJson, chunk, qidOf, sparql } from './http.ts';
import { CandidateIndex, assignIdentities, type Candidate } from './match.ts';

const today = () => new Date().toISOString().slice(0, 10);

/** Classes of things a historical map polygon can denote. */
const CANDIDATE_CLASSES = [
  'Q3024240', 'Q6256', 'Q3624078', 'Q48349', 'Q417175', 'Q7270', 'Q133156', 'Q1790360', 'Q28171280', 'Q8432', 'Q465299', 'Q41710', 'Q164950', 'Q170156',
  'Q12759805', 'Q2577883', 'Q1763527', 'Q1371288', 'Q208500', 'Q1307214', 'Q1620908', 'Q164142', 'Q41614', 'Q1639378', 'Q2288368', 'Q15642541', 'Q179164', 'Q7275',
];

async function loadCandidates(log: (m: string) => void): Promise<Candidate[]> {
  const merged = new Map<string, Candidate>();
  for (const cls of CANDIDATE_CLASSES) {
    let rows: any[] = [];
    try {
      rows = await sparql(`SELECT ?i ?l ?n (GROUP_CONCAT(DISTINCT ?a;separator="|") AS ?al) (MIN(?s) AS ?inc) (MAX(?e) AS ?dis) WHERE {
        ?i wdt:P31 wd:${cls}; wikibase:sitelinks ?n; rdfs:label ?l. FILTER(LANG(?l)="en")
        OPTIONAL { ?i skos:altLabel ?a. FILTER(LANG(?a)="en") }
        OPTIONAL { ?i wdt:P571 ?s } OPTIONAL { ?i wdt:P576 ?e }
      } GROUP BY ?i ?l ?n`);
    } catch (e) {
      log(`candidates ${cls} failed, continuing: ${e}`);
    }
    for (const r of rows) {
      const qid = qidOf(r.i);
      if (merged.has(qid)) continue;
      merged.set(qid, {
        qid, label: r.l, aliases: r.al ? r.al.split('|') : [], sitelinks: Number(r.n),
        inception: r.inc ? sparqlTimeToT(r.inc) : null, dissolved: r.dis ? sparqlTimeToT(r.dis) : null,
      });
    }
    log(`candidates ${cls}: ${rows.length} rows, ${merged.size} unique`);
  }
  return [...merged.values()];
}

async function resolveCuration(log: (m: string) => void) {
  const { rows } = JSON.parse(readFileSync(resolve(ROOT, 'data/curation/identities.json'), 'utf8')) as { rows: [string, number, number, string][] };
  const titles = [...new Set(rows.map((r) => r[3]))];
  const map = new Map<string, string>();
  // The API refuses `normalize` with several titles, so each title is resolved alone (and cached).
  for (const t of titles) {
    const j = await cachedJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&redirects=yes&normalize=yes&props=info&format=json&titles=${encodeURIComponent(t)}`);
    const e = Object.values<any>(j.entities)[0];
    if (e?.id && !('missing' in e)) map.set(t, e.id);
    else log(`curation: no article "${t}"`);
  }
  return { rows, map };
}

type Claim = any;
const best = (claims: Claim[] = []) => {
  const live = claims.filter((c) => c.rank !== 'deprecated');
  const pref = live.filter((c) => c.rank === 'preferred');
  return pref.length ? pref : live;
};
const claimTime = (c: Claim) => (c?.mainsnak?.datavalue ? wikidataTimeToT(c.mainsnak.datavalue.value.time) : null);
const qualT = (c: Claim, ...props: string[]) => {
  for (const p of props) {
    const v = c.qualifiers?.[p]?.[0]?.datavalue?.value?.time;
    if (v) return wikidataTimeToT(v);
  }
  return null;
};
const claimQid = (c: Claim): string | null => c?.mainsnak?.datavalue?.value?.id ?? null;
const claimStr = (c: Claim): string | null => {
  const v = c?.mainsnak?.datavalue?.value;
  return typeof v === 'string' ? v : null;
};

/** Per-item cache, so changing what gets matched never refetches what is already known. */
async function fetchEntities(qids: string[], log: (m: string) => void, props = 'labels|descriptions|aliases|claims|sitelinks') {
  const out = new Map<string, any>();
  const tag = createHash('sha1').update(props).digest('hex').slice(0, 6);
  const dir = resolve(CACHE, 'entities', tag);
  mkdirSync(dir, { recursive: true });
  const missing: string[] = [];
  for (const q of qids) {
    const file = resolve(dir, `${q}.json`);
    if (existsSync(file)) out.set(q, JSON.parse(readFileSync(file, 'utf8')));
    else missing.push(q);
  }
  const batches = chunk(missing, 50);
  let done = 0;
  for (const part of batches) {
    const j = await cachedJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=${props}&ids=${part.join('|')}`);
    for (const e of Object.values<any>(j.entities)) if (!('missing' in e)) {
      out.set(e.id, e);
      writeFileSync(resolve(dir, `${e.id}.json`), JSON.stringify(e));
    }
    if (++done % 40 === 0) log(`  entities ${done}/${batches.length}`);
  }
  return out;
}

const SEARCH_LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ar', 'zh', 'tr', 'el', 'la', 'fa', 'hi', 'ja', 'nl', 'pl'];
const enLabel = (e: any) => e?.labels?.en?.value ?? (Object.values<any>(e?.labels ?? {})[0]?.value ?? null);
const enDesc = (e: any) => e?.descriptions?.en?.value ?? null;

export async function enrich(db: DatabaseSync, log: (m: string) => void) {
  const retrieved = today();
  const cands = await loadCandidates(log);
  const index = new CandidateIndex(cands);
  const { rows: curated, map: curatedMap } = await resolveCuration(log);

  db.exec(`DELETE FROM entity_identity; DELETE FROM wd_item; DELETE FROM fact; DELETE FROM media; DELETE FROM event; DELETE FROM place WHERE origin != 'basemaps';`);
  const insId = db.prepare(`INSERT OR REPLACE INTO entity_identity VALUES(?,?,?,?,?,?)`);
  const entities = db.prepare(`SELECT id,name,first_t,last_t,dataset FROM entity`).all() as any[];
  let matched = 0;
  tx(db, () => {
    for (const e of entities) {
      const manual = curated.filter((r) => (r[0] === e.id || r[0] === `name:${e.name}`) && curatedMap.has(r[3]) && r[1] < e.last_t && r[2] > e.first_t);
      const spans: { from: number; to: number; qid: string; method: string; confidence: number }[] = manual.map((r) => ({
        qid: curatedMap.get(r[3])!, from: Math.max(r[1], e.first_t), to: Math.min(r[2], e.last_t), method: 'curated', confidence: 0.98,
      }));
      // Automatic matching fills whatever curation leaves uncovered.
      const covered = [...spans].sort((a, b) => a.from - b.from);
      const gaps: [number, number][] = [];
      let cur = e.first_t as number;
      for (const s of covered) {
        if (s.from > cur + 0.01) gaps.push([cur, s.from]);
        cur = Math.max(cur, s.to);
      }
      if (cur < e.last_t - 0.01) gaps.push([cur, e.last_t]);
      for (const [a, b] of gaps) spans.push(...assignIdentities(e.name, a, b, index));
      for (const s of spans) insId.run(e.id, s.qid, s.from, s.to, s.method, s.confidence);
      if (spans.length) matched++;
    }
  });
  log(`identities: ${matched}/${entities.length} entities matched`);

  const qids = (db.prepare(`SELECT DISTINCT qid FROM entity_identity`).all() as any[]).map((r) => r.qid);
  const items = await fetchEntities(qids, log);
  log(`fetched ${items.size} polity items`);

  // Offices: stated head-of-state offices (P1906) plus offices whose jurisdiction is the item.
  const offices = new Map<string, Set<string>>();
  for (const [q, e] of items) for (const c of best(e.claims?.P1906)) {
    const o = claimQid(c);
    if (o) (offices.get(q) ?? offices.set(q, new Set()).get(q)!).add(o);
  }
  // A class-path filter times out on WDQS, so offices are fetched by jurisdiction and filtered by title.
  const RULING_OFFICE = /\b(king|queen|monarch|emperor|empress|sultan|caliph|president|prince|princess|duke|duchess|tsar|czar|shah|khagan|khan|pharaoh|doge|pope|head of state|emir|governor[- ]general|viceroy|chancellor|prime minister|regent|shogun|dictator|consul|tetrarch|autocrat|imperator|negus|maharaja)\b/i;
  const NOT_RULING = /\bact\b|\blaw\b|regulation|order|\brules\b|list of|flag|vice|deputy|assistant|mayor|ambassador|senate|court|parliament|bank|universit|committee|assembly|council|secretary|commission|minister of|ministry|congress|national .* (party|front)|party|academy|board|society|chamber|of the (house|general|republic of [a-z]+ (province|state))|lord chancellor|provincial|regional|state of |county|district|city|wife|consort/i;
  for (const part of chunk(qids, 150)) {
    const rows = await sparql<any>(`SELECT ?j ?o ?l WHERE { VALUES ?j { ${part.map((q) => 'wd:' + q).join(' ')} } ?o wdt:P1001 ?j; rdfs:label ?l. FILTER(LANG(?l)="en") }`).catch((e) => { log(`offices batch failed: ${e}`); return []; });
    for (const r of rows) {
      if (!RULING_OFFICE.test(r.l) || NOT_RULING.test(r.l)) continue;
      const q = qidOf(r.j);
      (offices.get(q) ?? offices.set(q, new Set()).get(q)!).add(qidOf(r.o));
    }
  }
  // Keep an office only if it is stated as head of state (P1906) or Wikidata classes it as head of state or government.
  // The title regex alone lets through "President of the Cinémathèque".
  const candidateOffices = [...new Set([...offices.values()].flatMap((s) => [...s]))];
  const ruling = new Set<string>();
  for (const part of chunk(candidateOffices, 60)) {
    const rows = await sparql<any>(`SELECT DISTINCT ?o WHERE { VALUES ?o { ${part.map((q) => 'wd:' + q).join(' ')} } VALUES ?top { wd:Q48352 wd:Q2285706 wd:Q116 } ?o wdt:P279*|wdt:P31/wdt:P279* ?top. }`).catch((e) => { log(`office class batch failed: ${e}`); return []; });
    for (const r of rows) ruling.add(qidOf(r.o));
  }
  for (const [q, set] of offices) {
    const stated = new Set(best(items.get(q)?.claims?.P1906).map(claimQid));
    for (const o of set) if (!ruling.has(o) && !stated.has(o)) set.delete(o);
  }
  const allOffices = [...new Set([...offices.values()].flatMap((s) => [...s]))];
  log(`offices: ${allOffices.length}`);
  const officeItems = await fetchEntities(allOffices, log, 'labels');
  const holders = new Map<string, { p: string; from: number | null; to: number | null }[]>();
  for (const part of chunk(allOffices, 40)) {
    const rows = await sparql<any>(`SELECT ?o ?p ?a ?b WHERE { VALUES ?o { ${part.map((q) => 'wd:' + q).join(' ')} } ?p p:P39 ?s. ?s ps:P39 ?o; pq:P580 ?a. OPTIONAL { ?s pq:P582 ?b } }`).catch((e) => { log(`holders batch failed: ${e}`); return []; });
    for (const r of rows) {
      const o = qidOf(r.o);
      (holders.get(o) ?? holders.set(o, []).get(o)!).push({ p: qidOf(r.p), from: sparqlTimeToT(r.a), to: r.b ? sparqlTimeToT(r.b) : null });
    }
  }
  log(`office holders: ${[...holders.values()].reduce((n, l) => n + l.length, 0)}`);

  const facts: any[] = [];
  const push = (qid: string, kind: string, property: string, value_qid: string | null, value_label: string | null, from: number | null, to: number | null, title: string | null = null) =>
    facts.push({ qid, kind, property, value_qid, value_label, from, to, title });

  const CLAIM_KINDS: [string, string, string | null][] = [
    ['P35', 'ruler', 'head of state'], ['P6', 'ruler', 'head of government'],
    ['P36', 'capital', null], ['P37', 'official_language', null], ['P2936', 'language', null],
    ['P3075', 'official_religion', null], ['P140', 'religion', null], ['P122', 'government', null],
    ['P155', 'predecessor', null], ['P1365', 'predecessor', null], ['P156', 'successor', null], ['P1366', 'successor', null], ['P31', 'instance', null],
  ];
  const flagItemIds = new Set<string>();
  for (const [q, e] of items) {
    for (const [prop, kind, title] of CLAIM_KINDS) for (const c of best(e.claims?.[prop])) {
      const v = claimQid(c);
      if (v) push(q, kind, prop, v, null, qualT(c, 'P580', 'P1319'), qualT(c, 'P582', 'P1326'), title);
    }
    for (const [prop, kind] of [['P41', 'flag'], ['P94', 'coat']] as const) for (const c of best(e.claims?.[prop])) {
      const f = claimStr(c);
      if (f) push(q, kind, prop, null, f, qualT(c, 'P580', 'P1319'), qualT(c, 'P582', 'P1326'));
    }
    for (const c of best(e.claims?.P163)) { const v = claimQid(c); if (v) flagItemIds.add(v); }
    for (const o of offices.get(q) ?? []) {
      const lbl = enLabel(officeItems.get(o));
      if (lbl && /consort|wife|spouse|mother|haseki|valide|heir/i.test(lbl)) continue;
      // Offices of a member state ("Duke of Anhalt" under the German Empire) do not rule the whole.
      const statedOffice = best(e.claims?.P1906).some((c: Claim) => claimQid(c) === o);
      if (lbl && !statedOffice && /\b(duke|duchess|prince-elector|elector|governor|landgrave|margrave|count)\b/i.test(lbl)) continue;
      for (const h of holders.get(o) ?? []) push(q, 'ruler', 'P39', h.p, null, h.from, h.to, lbl);
    }
  }

  // Flag items (P163) carry their own inception, which dates flags on still-existing states.
  const flagItems = await fetchEntities([...flagItemIds], log, 'labels|claims');
  for (const [q, e] of items) for (const c of best(e.claims?.P163)) {
    const fi = flagItems.get(claimQid(c) ?? '');
    if (!fi) continue;
    const file = claimStr(best(fi.claims?.P18)[0]) ?? claimStr(best(fi.claims?.P41)[0]);
    const from = qualT(c, 'P580') ?? claimTime(best(fi.claims?.P571)[0]);
    const to = qualT(c, 'P582') ?? claimTime(best(fi.claims?.P576)[0]);
    if (file && (from != null || to != null)) push(q, 'flag', 'P163', fi.id, file, from, to, enLabel(fi));
  }

  // Everything a fact points to needs a name; persons need dates, portrait and article.
  const refs = [...new Set(facts.map((f) => f.value_qid).filter(Boolean))] as string[];
  const refItems = await fetchEntities(refs.filter((r) => !items.has(r)), log);
  const lookup = (q: string) => items.get(q) ?? refItems.get(q);
  const insItem = db.prepare(`INSERT OR REPLACE INTO wd_item(qid,label,description,sitelinks,inception,dissolved,enwiki,retrieved,image,birth,death) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const insFact = db.prepare(`INSERT INTO fact(qid,kind,value_qid,value_label,from_t,to_t,title,property,retrieved) VALUES(?,?,?,?,?,?,?,?,?)`);
  const insName = db.prepare(`INSERT OR IGNORE INTO entity_name VALUES(?,?,?,?)`);
  const insPlace = db.prepare(`INSERT INTO place(name,lon,lat,from_t,to_t,qid,kind,origin) VALUES(?,?,?,?,?,?,?,'wikidata')`);
  const seenFact = new Set<string>();
  tx(db, () => {
    for (const [q, e] of [...items, ...refItems]) {
      const inc = claimTime(best(e.claims?.P571)[0]);
      const dis = claimTime(best(e.claims?.P576)[0]);
      insItem.run(q, enLabel(e), enDesc(e), Object.keys(e.sitelinks ?? {}).length, inc, dis, e.sitelinks?.enwiki?.title ?? null, retrieved,
        claimStr(best(e.claims?.P18)[0]), claimTime(best(e.claims?.P569)[0]), claimTime(best(e.claims?.P570)[0]));
    }
    for (const f of facts) {
      const key = [f.qid, f.kind, f.value_qid ?? f.value_label, f.from, f.to].join('|');
      if (seenFact.has(key)) continue;
      seenFact.add(key);
      const label = f.value_label ?? enLabel(lookup(f.value_qid));
      if (!label) continue;
      // Wikidata records fictional officeholders too; a ruler must be a real person.
      if (f.kind === 'ruler' && !best(lookup(f.value_qid)?.claims?.P31).some((c: Claim) => claimQid(c) === 'Q5')) continue;
      if ((f.kind === 'flag' || f.kind === 'coat') && /fictitious|fictional|fantasy|proposed|proposal/i.test(label)) continue;
      insFact.run(f.qid, f.kind, f.value_qid, label, f.from, f.to, f.title, f.property, retrieved);
    }
    // Names in many languages make "Rome antique" or "Römisches Reich" findable.
    const ids = db.prepare(`SELECT DISTINCT entity_id, qid FROM entity_identity`).all() as any[];
    for (const { entity_id, qid } of ids) {
      const e = items.get(qid);
      if (!e) continue;
      for (const l of SEARCH_LANGS) {
        const v = e.labels?.[l]?.value;
        if (v) insName.run(entity_id, v, l, 'wikidata-label');
        for (const a of (e.aliases?.[l] ?? []).slice(0, 8)) insName.run(entity_id, a.value, l, 'wikidata-alias');
      }
    }
    // Capitals with a stated period and location become a dated map layer.
    for (const f of facts) {
      if (f.kind !== 'capital' || f.from == null) continue;
      const e = refItems.get(f.value_qid);
      const c = best(e?.claims?.P625)[0]?.mainsnak?.datavalue?.value;
      if (c) insPlace.run(enLabel(e), c.longitude, c.latitude, f.from, f.to ?? claimTime(best(items.get(f.qid)?.claims?.P576)[0]) ?? null, f.value_qid, 'capital');
    }
  });
  log(`facts stored: ${seenFact.size}`);

  // Commons licensing and thumbnails for every image the panels can show.
  const files = [...new Set([
    ...(db.prepare(`SELECT DISTINCT value_label v FROM fact WHERE kind IN ('flag','coat')`).all() as any[]).map((r) => r.v),
    ...(db.prepare(`SELECT DISTINCT w.image v FROM wd_item w JOIN fact f ON f.value_qid=w.qid WHERE f.kind='ruler' AND w.image IS NOT NULL`).all() as any[]).map((r) => r.v),
  ])] as string[];
  const insMedia = db.prepare(`INSERT OR REPLACE INTO media VALUES(?,?,?,?,?,?)`);
  const strip = (s?: string) => s?.replace(/<[^>]+>/g, '').trim().slice(0, 200) ?? null;
  const mediaCachePath = resolve(CACHE, 'media.json');
  const mediaCache: Record<string, any[]> = existsSync(mediaCachePath) ? JSON.parse(readFileSync(mediaCachePath, 'utf8')) : {};
  tx(db, () => { for (const f of files) if (mediaCache[f]) insMedia.run(...(mediaCache[f] as [any])); });
  const parts = chunk(files.filter((f) => !mediaCache[f]), 45);
  let doneMedia = 0;
  for (const part of parts) {
    const j = await cachedJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=320&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent(part.map((f) => 'File:' + f).join('|'))}`).catch((e) => { log(`media failed: ${e}`); return { query: { pages: {} } }; });
    const norm = new Map((j.query.normalized ?? []).map((n: any) => [n.to, n.from]));
    tx(db, () => {
      for (const p of Object.values<any>(j.query.pages)) {
        const ii = p.imageinfo?.[0];
        if (!ii) continue;
        const asked = String(norm.get(p.title) ?? p.title).replace(/^File:/, '');
        const row = [asked, ii.thumburl ?? ii.url, ii.descriptionurl, strip(ii.extmetadata?.Artist?.value), strip(ii.extmetadata?.LicenseShortName?.value), retrieved];
        insMedia.run(...(row as [any]));
        mediaCache[asked] = row;
      }
    });
    if (++doneMedia % 40 === 0) log(`  media ${doneMedia}/${parts.length}`);
  }
  writeFileSync(mediaCachePath, JSON.stringify(mediaCache));
  log(`media: ${(db.prepare('SELECT count(*) n FROM media').get() as any).n}/${files.length}`);

  // Wikipedia introductions, for polities and for persons who ruled.
  const titled = db.prepare(`SELECT DISTINCT w.qid, w.enwiki FROM wd_item w WHERE w.enwiki IS NOT NULL AND (w.qid IN (SELECT qid FROM entity_identity) OR w.qid IN (SELECT value_qid FROM fact WHERE kind='ruler'))`).all() as any[];
  const upSummary = db.prepare(`UPDATE wd_item SET summary=? WHERE enwiki=?`);
  const summaryCachePath = resolve(CACHE, 'summaries.json');
  const summaryCache: Record<string, string | null> = existsSync(summaryCachePath) ? JSON.parse(readFileSync(summaryCachePath, 'utf8')) : {};
  tx(db, () => { for (const t of titled) if (summaryCache[t.enwiki]) upSummary.run(summaryCache[t.enwiki]!, t.enwiki); });
  const titleParts = chunk(titled.map((t) => t.enwiki as string).filter((t) => !(t in summaryCache)), 20);
  let doneSum = 0;
  for (const part of titleParts) {
    const j = await cachedJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=extracts&exintro=1&explaintext=1&exsentences=4&exlimit=20&titles=${encodeURIComponent(part.join('|'))}`).catch((e) => { log(`extracts failed: ${e}`); return { query: { pages: {} } }; });
    const back = new Map<string, string>();
    for (const n of j.query.normalized ?? []) back.set(n.to, n.from);
    for (const n of j.query.redirects ?? []) back.set(n.to, back.get(n.from) ?? n.from);
    tx(db, () => {
      for (const p of Object.values<any>(j.query.pages)) if (p.extract) { const k = back.get(p.title) ?? p.title; upSummary.run(p.extract.trim(), k); summaryCache[k] = p.extract.trim(); }
      for (const k of part) summaryCache[k] ??= null;
    });
    if (++doneSum % 50 === 0) log(`  extracts ${doneSum}/${titleParts.length}`);
  }
  writeFileSync(summaryCachePath, JSON.stringify(summaryCache));
  log(`summaries: ${(db.prepare('SELECT count(*) n FROM wd_item WHERE summary IS NOT NULL').get() as any).n}/${titled.length}`);

  await loadEvents(db, log);
  await loadCities(db, log);
  await datePlaces(db, log);

  const up = db.prepare(`INSERT OR REPLACE INTO source_run VALUES(?,?,?,?,?,?,?)`);
  up.run('Wikidata', 'https://www.wikidata.org/', 'CC0 1.0', retrieved, '', items.size, 'Identities, rulers, flags, languages, religions, events, cities');
  up.run('Wikipedia (English)', 'https://en.wikipedia.org/', 'CC BY-SA 4.0', retrieved, '', titled.length, 'Article introductions, linked per panel');
  up.run('Wikimedia Commons', 'https://commons.wikimedia.org/', 'Per file; shown with each image', retrieved, '', files.length, 'Flags, emblems, portraits');
}

const EVENT_CLASSES: [string, string, number][] = [
  ['Q198', 'war', 25], ['Q103495', 'war', 10], ['Q8465', 'war', 25], ['Q10931', 'revolution', 20], ['Q131569', 'treaty', 20],
  ['Q178561', 'battle', 45], ['Q188055', 'siege', 35], ['Q45382', 'coup', 40], ['Q625994', 'conference', 40],
];

async function loadEvents(db: DatabaseSync, log: (m: string) => void) {
  const ins = db.prepare(`INSERT OR REPLACE INTO event VALUES(?,?,?,?,?,?,?,?,?)`);
  let total = 0;
  for (const [cls, kind, minLinks] of EVENT_CLASSES) {
    const rows = await sparql<any>(`SELECT ?i ?iLabel ?iDescription ?n (MIN(?d) AS ?from) (MAX(?e) AS ?to) (SAMPLE(?c) AS ?coord) WHERE {
      ?i wdt:P31 wd:${cls}; wikibase:sitelinks ?n. FILTER(?n >= ${minLinks})
      OPTIONAL { ?i wdt:P585 ?p } OPTIONAL { ?i wdt:P580 ?s } OPTIONAL { ?i wdt:P582 ?e }
      BIND(COALESCE(?p, ?s) AS ?d) FILTER(BOUND(?d))
      OPTIONAL { ?i wdt:P625 ?c }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } GROUP BY ?i ?iLabel ?iDescription ?n`).catch((e) => { log(`events ${cls} failed: ${e}`); return []; });
    tx(db, () => {
      for (const r of rows) {
        const from = sparqlTimeToT(r.from);
        if (from == null || /^Q\d+$/.test(r.iLabel)) continue;
        const m = r.coord ? /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord) : null;
        ins.run(qidOf(r.i), r.iLabel, r.iDescription ?? null, from, r.to ? sparqlTimeToT(r.to) : null, kind, m ? Number(m[1]) : null, m ? Number(m[2]) : null, Number(r.n));
        total++;
      }
    });
  }
  log(`events: ${total}`);
}

async function loadCities(db: DatabaseSync, log: (m: string) => void) {
  const rows = await sparql<any>(`SELECT ?i ?iLabel (SAMPLE(?c) AS ?coord) (MIN(?s) AS ?inc) (MAX(?e) AS ?dis) WHERE {
    VALUES ?cls { wd:Q515 wd:Q1549591 wd:Q5119 wd:Q15661340 }
    ?i wdt:P31 ?cls; wikibase:sitelinks ?n; wdt:P625 ?c; wdt:P571 ?s. FILTER(?n >= 80)
    OPTIONAL { ?i wdt:P576 ?e }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } GROUP BY ?i ?iLabel`).catch((e) => { log(`cities failed: ${e}`); return []; });
  const ins = db.prepare(`INSERT INTO place(name,lon,lat,from_t,to_t,qid,kind,origin) VALUES(?,?,?,?,?,?,'city','wikidata')`);
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(r.coord);
      const from = sparqlTimeToT(r.inc);
      if (!m || from == null || /^Q\d+$/.test(r.iLabel)) continue;
      ins.run(r.iLabel, Number(m[1]), Number(m[2]), from, r.dis ? sparqlTimeToT(r.dis) : null, qidOf(r.i));
      n++;
    }
  });
  log(`cities with documented founding: ${n}`);
}

/** Basemaps' place list is mostly undated; its Wikidata links can date some. */
async function datePlaces(db: DatabaseSync, log: (m: string) => void) {
  const rows = db.prepare(`SELECT id,qid FROM place WHERE origin='basemaps' AND qid IS NOT NULL AND from_t IS NULL`).all() as any[];
  const items = await fetchEntities([...new Set(rows.map((r) => r.qid as string))].filter((q) => /^Q\d+$/.test(q)), log, 'claims');
  const up = db.prepare(`UPDATE place SET from_t=?, to_t=COALESCE(to_t,?) WHERE id=?`);
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const e = items.get(r.qid);
      const from = claimTime(best(e?.claims?.P571)[0]);
      if (from != null) {
        up.run(from, claimTime(best(e?.claims?.P576)[0]), r.id);
        n++;
      }
    }
  });
  log(`basemaps places dated through Wikidata: ${n}/${rows.length}`);
}
