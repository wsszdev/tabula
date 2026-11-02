-- TABULA historical database. All times are decimal astronomical years ("t"),
-- half-open [valid_from, valid_to); see packages/shared/src/index.ts.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS source_run (
  name TEXT PRIMARY KEY, url TEXT, license TEXT, retrieved TEXT, sha256 TEXT, records INTEGER, note TEXT
);

-- A political or cultural identity as named by a map dataset.
CREATE TABLE IF NOT EXISTS entity (
  id TEXT PRIMARY KEY,               -- cs:<gwcode> | hb:<slug>@<first-t>
  name TEXT NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset IN ('cshapes','basemaps')),
  kind TEXT NOT NULL DEFAULT 'polity',
  kind_source TEXT,
  first_t REAL NOT NULL,
  last_t REAL NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  max_area REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entity_time ON entity(first_t, last_t);

-- One geometry valid over one interval.
CREATE TABLE IF NOT EXISTS territory (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL,              -- tile set: 'cs' or 'hb_<year>'
  name TEXT NOT NULL,
  valid_from REAL NOT NULL,
  valid_to REAL NOT NULL,
  raw_valid_to REAL NOT NULL,        -- before clipping by documented dissolution
  snapshot_held INTEGER NOT NULL,    -- 1: interval is "held until next map", not a dated change
  area_km2 REAL NOT NULL,
  border_precision INTEGER,
  capital_name TEXT, capital_lon REAL, capital_lat REAL,
  sovereign TEXT,                    -- ruling power as stated by the source (hb) or derived (cs)
  sovereign_note TEXT,
  part_of TEXT,
  modern_name TEXT,                  -- 2019 CShapes state containing the label point (derived)
  class TEXT NOT NULL DEFAULT 'polity',
  label_lon REAL NOT NULL, label_lat REAL NOT NULL,
  min_lon REAL NOT NULL, min_lat REAL NOT NULL, max_lon REAL NOT NULL, max_lat REAL NOT NULL,
  geojson BLOB NOT NULL,             -- gzip GeoJSON geometry, source precision
  source_file TEXT NOT NULL,
  source_row TEXT
);
CREATE INDEX IF NOT EXISTS territory_time ON territory(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS territory_entity ON territory(entity_id, valid_from);
CREATE INDEX IF NOT EXISTS territory_set ON territory(set_id);
CREATE VIRTUAL TABLE IF NOT EXISTS territory_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);

CREATE TABLE IF NOT EXISTS entity_name (
  entity_id TEXT NOT NULL, name TEXT NOT NULL, lang TEXT, origin TEXT,
  PRIMARY KEY (entity_id, name, lang)
) WITHOUT ROWID;

-- Time-bounded link from a map entity to a Wikidata item. One entity can have many:
-- "Germany" in CShapes is the German Empire, then the Weimar Republic, then Nazi Germany.
CREATE TABLE IF NOT EXISTS entity_identity (
  entity_id TEXT NOT NULL, qid TEXT NOT NULL, from_t REAL, to_t REAL,
  method TEXT NOT NULL, confidence REAL NOT NULL,
  PRIMARY KEY (entity_id, qid, from_t)
);
CREATE INDEX IF NOT EXISTS identity_qid ON entity_identity(qid);

CREATE TABLE IF NOT EXISTS wd_item (
  qid TEXT PRIMARY KEY, label TEXT, description TEXT, sitelinks INTEGER DEFAULT 0,
  inception REAL, dissolved REAL, enwiki TEXT, summary TEXT, retrieved TEXT,
  image TEXT, birth REAL, death REAL
);

-- Every enrichment statement, keeps its own validity and provenance.
CREATE TABLE IF NOT EXISTS fact (
  id INTEGER PRIMARY KEY,
  qid TEXT NOT NULL,
  kind TEXT NOT NULL,                -- ruler|flag|coat|capital|official_language|language|official_religion|religion|government|predecessor|successor|country|instance
  value_qid TEXT, value_label TEXT,
  from_t REAL, to_t REAL,
  title TEXT,
  property TEXT NOT NULL,
  ranked INTEGER NOT NULL DEFAULT 1, -- 0 deprecated are dropped; 2 preferred
  retrieved TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_lookup ON fact(qid, kind);
CREATE INDEX IF NOT EXISTS fact_value ON fact(value_qid);

CREATE TABLE IF NOT EXISTS media (
  file TEXT PRIMARY KEY, url TEXT, page TEXT, author TEXT, license TEXT, retrieved TEXT
);

-- Succession across map entities, resolved from Wikidata P155/P156/P1365/P1366.
CREATE TABLE IF NOT EXISTS event (
  qid TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, from_t REAL NOT NULL, to_t REAL,
  kind TEXT, lon REAL, lat REAL, sitelinks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_time ON event(from_t);

CREATE TABLE IF NOT EXISTS place (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, lon REAL NOT NULL, lat REAL NOT NULL,
  from_t REAL, to_t REAL, qid TEXT, kind TEXT NOT NULL, origin TEXT NOT NULL, entity_id TEXT
);
CREATE INDEX IF NOT EXISTS place_time ON place(from_t, to_t);

CREATE TABLE IF NOT EXISTS tile_set (
  id TEXT PRIMARY KEY, dataset TEXT NOT NULL, from_t REAL NOT NULL, to_t REAL NOT NULL, year INTEGER,
  labels BLOB, tile_count INTEGER, bytes INTEGER
);
CREATE TABLE IF NOT EXISTS tile (
  set_id TEXT NOT NULL, z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (set_id, z, x, y)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text, ref_type UNINDEXED, ref_id UNINDEXED, weight UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2", prefix = '2 3'
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_tri USING fts5(
  text, ref_type UNINDEXED, ref_id UNINDEXED, weight UNINDEXED, tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS validation_issue (
  severity TEXT NOT NULL, code TEXT NOT NULL, ref TEXT, message TEXT NOT NULL
);
