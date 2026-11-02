import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../..');
export const RAW = resolve(ROOT, 'data/raw');
export const CACHE = resolve(ROOT, 'data/cache');
export const DB_PATH = process.env.TABULA_DB ?? resolve(ROOT, 'data/tabula.db');

export function openDb(path = DB_PATH): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
