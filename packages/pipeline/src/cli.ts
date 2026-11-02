import { openDb } from './db.ts';
import { ingestGeo } from './ingest-geo.ts';

const stage = process.argv[2] ?? 'all';
const db = openDb();
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

if (stage === 'all' || stage === 'geo') log(`geo ${JSON.stringify(ingestGeo(db))}`);
if (stage === 'all' || stage === 'enrich') {
  const { enrich } = await import('./enrich.ts');
  await enrich(db, log);
}
if (stage === 'all' || stage === 'finalize') {
  const { finalize } = await import('./finalize.ts');
  await finalize(db, log);
}
if (stage === 'all' || stage === 'validate') {
  const { validate } = await import('./validate.ts');
  const r = validate(db);
  log(`validate ${JSON.stringify(r)}`);
  if (r.errors) process.exitCode = 1;
}
