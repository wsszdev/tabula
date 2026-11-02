import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.ts';

const path = process.env.TABULA_DB ?? resolve(import.meta.dirname, '../../../data/tabula.db');
if (!existsSync(path)) {
  console.error(`No database at ${path}. Run "npm run data" first.`);
  process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
db.exec('PRAGMA query_only=1; PRAGMA mmap_size=1073741824; PRAGMA cache_size=-65536;');
const app = buildApp(db, { logger: true });
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
