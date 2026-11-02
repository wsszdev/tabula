# TABULA technical documentation

Measurements and counts here come from the build and test runs of 30 October 2026.

## 1. Architecture

```
 CShapes 2.0 ──┐                                    ┌─► export ─► packages/web/public/data   (static, committed)
 Basemaps ─────┤   pipeline        SQLite file      │     tiles/<set>.pmtiles, entities/<n>.json,
 Wikidata ─────┼─► ingest ► enrich ► data/tabula.db ┤     search.json, labels/, places, events, meta
 Wikipedia ────┤   finalize ► validate  (read-only) │              │
 Commons ──────┘                                    │              ▼
                                                    │   React + MapLibre GL globe (GitHub Pages)
                                                    │   + NASA imagery straight from GIBS
                                                    └─► optional Fastify API (/api/territories?year=…)
```

- `packages/shared`: time model, API types, and the panel and search logic used by both the API and the browser
- `packages/pipeline`: ingestion, matching, tiles, validation
- `packages/server`: optional read-only API, and the static export (`src/export.ts`, `src/pmtiles.ts`)
- `packages/web`: interface, reading only static files

**Static hosting.** The site needs no server. `npm run export` writes the database out as files: one [PMTiles](https://github.com/protomaps/PMTiles) archive per tile set (read with HTTP range requests), one JSON bundle per map entity holding everything its panels need for any year, a search index, and small JSON files for labels, places, events and metadata. The browser runs the same `panelFromBundle` and search ranking code the API runs; `tests/integration/export.test.ts` checks the two give identical answers. The build uses relative URLs, so it works under any path, such as `https://<user>.github.io/<repo>/`.

Wikipedia, Wikidata and Commons are read **at build time**, through a disk cache and a per-host rate limiter. Visitors' requests never reach those APIs, except that images load directly from Commons.

## 2. Technical choices

| Need | Choice | Why |
|---|---|---|
| Globe | **MapLibre GL JS 5** (globe projection) | Compared below |
| Frontend | React 19, Zustand, Vite | The panels are ordinary UI. The map stays outside React's render cycle, so scrubbing years doesn't re-render components |
| Database | **SQLite** via `node:sqlite`, with R*Tree and FTS5 | The data is read-only after each build and suits one file. Point, time and bounding-box queries take milliseconds. No server to run |
| Geodata delivery | Precomputed vector tiles (geojson-vt, vt-pbf) stored in SQLite, exported as PMTiles | Loading follows viewport and zoom automatically. 82,307 tiles in 55 archives, 38 MB |
| Backend | None for the site; optional Fastify 5 API | The site is static files. The API answers ad hoc queries such as "everything in 1453" |
| Testing | Vitest, Playwright | |
| Deployment | GitHub Pages, via GitHub Actions | Free static hosting with a CDN, gzip and range requests |

**Why MapLibre over the alternatives**

- **CesiumJS** has the best geodesy and terrain, but it is a much heavier download, and large, frequently changing polygon sets are its weak spot. Changing borders by year is TABULA's core operation.
- **Three.js and Globe.gl** would need tiling, polygon triangulation on a sphere, label placement and picking to be written from scratch. Globe.gl also redraws polygons as whole-world meshes.
- **MapLibre** has tiled vector rendering, collision-managed labels, touch gestures, expression filters and a true globe projection built in. It runs at 60 fps here. Its limits: no terrain relief in this build, and less realism than Google Earth when zoomed in close.

**Why SQLite over PostGIS:** Docker and Postgres weren't available here, and nothing needs them. Exact point queries run through R*Tree and then polygon tests in JavaScript. If user-contributed data or live edits are ever added, move to PostGIS; the schema carries over almost directly.

**Instant year changes:** the CShapes tile set holds all 710 border periods, each tagged with start and end. Moving through 1886 to 2019 only changes a client-side filter, with no network request. Earlier years use one tile set per snapshot and cross-fade between them once the new tiles have loaded.

## 3. The sources as analysed

| | CShapes 2.0 | Historical Basemaps |
|---|---|---|
| Coverage | 1886 to 2019 (CShapes-Europe from 1816 exists but is **not used**) | 53 snapshots, 123000 BC to 2010 |
| Shape | 710 country-periods, 252 states, exact dates | About 10,090 named territories after merging; one file per year |
| Identifiers | Gleditsch-Ward codes | None: names only, so identity had to be built |
| Precision | Legally coded borders; changes under 10,000 km² are excluded | `BORDERPRECISION` 1 to 3; before 1650 almost all 1 (approximate) |
| Quality notes | Public files **omit the `status` and `ruledby` columns** in the codebook; GeoJSON date strings are time-zone shifted (numeric fields used instead); occupied Germany starts in 1945 | Self-described as work in progress; many unnamed polygons (dropped); names vary across files ("Ming Chinese Empire"); some wrong dates or labels |
| Licence | CC BY-NC-SA 4.0 | GPL-3.0 |

## 4. Time model

Stored times are decimal astronomical years (`t`), in half-open intervals `[from, to)`. There is no year zero: stepping from 1 BC goes to AD 1. A selected whole year is read at mid-year, so the USSR (ended 26 December 1991) is on the map in 1991 and gone in 1992. Wikibase JSON and SPARQL number BC years differently, and both are handled.

## 5. Database schema

The full definition is in `packages/pipeline/src/schema.sql`.

| Table | Holds |
|---|---|
| `entity` | A political or cultural identity as a map names it (`cs:255`, `hb:france@1279`), with kind, colour, first and last time |
| `territory` | One geometry for one interval: gzip GeoJSON, area, precision, capital, sovereign, class, modern equivalent, source file and row. Indexed on `(valid_from, valid_to)`, entity and set |
| `territory_rtree` | R*Tree spatial index |
| `entity_name` | Alternative names by language and origin |
| `entity_identity` | **Time-bounded link to Wikidata**, with method and confidence. `cs:255` is German Empire, then Weimar Republic, then Nazi Germany |
| `wd_item` | Wikidata items: label, dates, article, summary, image, birth, death |
| `fact` | One row per statement (ruler, flag, emblem, capital, languages, religions, government, predecessor, successor, instance), each with its own validity, property and retrieval date |
| `media` | Commons files with URL, page, author, licence |
| `event`, `place` | Dated events and places |
| `tile_set`, `tile` | Vector tiles and label sets |
| `search_fts`, `search_tri` | Word/prefix search and trigram search |
| `source_run`, `validation_issue` | Provenance of each source (URL, licence, date, SHA-256, count) and validation output |

The required query, "all political entities and boundaries in 1453", is `GET /api/territories?year=1453&geometry=1`. It took 15 ms (796 KB).

## 6. Ingestion

`npm run data` runs four stages. Each can run alone: `tsx packages/pipeline/src/cli.ts geo|enrich|finalize|validate`.

1. **geo:** normalises both datasets. Basemaps parts sharing a name are merged, and the same name across consecutive snapshots becomes one entity (a gap of more than one snapshot starts a new one). Computes area, label point and bounding box.
2. **enrich:**
   - Fetches about 19,000 candidate items across 28 Wikidata classes, then assigns identities by name **and** date. Specific dated states beat long-lived catch-alls. `data/curation/identities.json` holds 130 period mappings by Wikipedia article title.
   - Collects facts, keeping only offices classed as head of state or government, real people, and non-fictional flags.
   - Downloads events, cities, Commons licences and Wikipedia introductions.
3. **finalize:**
   - Clips a snapshot's interval at a documented dissolution (68 cases).
   - Classifies territories, colours them with graph colouring so neighbours differ, and gives colonies their ruler's colour.
   - Splits labels by regime, builds tiles and the search index.
4. **validate:** interval, geometry and reference checks. Errors fail the build. The current result is 0 errors and 141 warnings, all Wikidata ruler terms that start before the person's birth; those terms are not shown.

To update: replace files in `data/raw`, or delete from `data/cache`, then rerun. To add a dataset: add an ingest function that writes `entity`, `territory` and `tile_set` rows.

**Derived colonial status:** because CShapes' status field isn't published, a territory is marked dependent when most Basemaps snapshots covering that period place it under another power. The panel shows this as derived and gives the reasoning.

## 7. How accuracy is enforced

- **Flags:**
  - A stated period is used when there is one.
  - A flag with no stated period is shown only for a state that has ended, within its lifetime, and labelled as such.
  - A flag recorded with no end date on a state that still exists counts only from 2000 onward. The cost is that the USA has no flag before 2000, rather than a 50-star flag in 1863.
- **Rulers:** need a stated term, must be real people, must be alive at the date, and must hold a national office.
- **Other facts** with no period are labelled "stated for the state as a whole, not for this year".
- **Uncertainty is visible:** blurred borders where the source says approximate, "Map of 1783, shown until 1800" under the year, a match score on automatic links, and "not documented for this date" instead of a guess.

Reading real panels found errors that the tests had missed: a fictional president, the head of a film archive listed as a French ruler, a 50-star flag in 1863, and a fictitious Ottoman flag. These are fixed and are now regression tests in `tests/integration/real-data.test.ts`.

## 8. Actual coverage

The map spans **123000 BC to 2019**, but density is very uneven:

- **123000 BC to about 3000 BC:** few entries, mostly hominin ranges and archaeological cultures, not states.
- **3000 BC to 1885:** 39 snapshots, 8 to 1,000 years apart. Changes appear at the next snapshot, not when they happened.
- **1886 to 2019:** dated borders (CShapes).

Number of territories in sample years with each kind of information. "States" excludes cultures and peoples.

| Year | On map | States | Linked to Wikidata | Ruler | Flag | Capital | Language |
|---|---|---|---|---|---|---|---|
| 1000 BC | 69 | 26 | 3 | 0 | 0 | 3 | 2 |
| 200 BC | 86 | 47 | 10 | 2 | 0 | 8 | 5 |
| 100 | 83 | 45 | 12 | 1 | 1 | 9 | 7 |
| 800 | 117 | 84 | 26 | 7 | 5 | 20 | 17 |
| 1200 | 129 | 101 | 34 | 11 | 15 | 26 | 24 |
| 1453 | 114 | 91 | 35 | 12 | 15 | 28 | 29 |
| 1600 | 638 | 555 | 48 | 17 | 28 | 44 | 38 |
| 1789 | 549 | 491 | 76 | 17 | 42 | 55 | 44 |
| 1850 | 312 | 282 | 79 | 22 | 52 | 59 | 48 |
| 1900 | 151 | 151 | 87 | 40 | 50 | 151 | 42 |
| 1945 | 170 | 170 | 100 | 52 | 58 | 170 | 40 |
| 2000 | 177 | 174 | 164 | 158 | 152 | 174 | 164 |

Totals: 10,800 territories, 3,417 entities (1,139 linked), 26,001 facts including 9,859 ruler terms, 729 events, 1,432 dated places, 5,550 Commons files.

## 9. Features

- **Globe:** 3D with free rotation, zoom, inertia and pinch; animated camera; NASA imagery with atmosphere.
- **Map:** tinted political colours with edge wash, certainty-coded borders, hover and selection highlighting, collision-managed labels that follow regimes ("Soviet Union" in 1980, "Russia" in 2000).
- **Timeline:** drag, type a year, step by keyboard, play and pause at four speeds, jump between map changes, ticks at every real snapshot, a band marking dated coverage.
- **Panel, tied to the selected date:** name, kind, overview, capital, government, founding and end, area, today's state, ruler with portrait and bio, flags and emblems with period and source, languages and religions split official versus other, predecessors and successors, sources. If a territory isn't on the map that year, it says so and offers its nearest mapped years or what was there instead.
- **Search:** states, empires, cultures, rulers, cities, events, dates such as "44 BC". 17 languages of names (`Römisches Reich`, `Empire romain`), tolerant of spelling. Choosing a result flies there, picks a period and opens the panel.
- **Layers:** borders, names, empires, kingdoms, republics, colonies, other states, cultures, capitals, cities.
- **Settings:** data source from 1886, globe brightness, slow rotation.
- **Also:** an events browser, an about-the-data view, shareable links (year and camera in the URL), keyboard control, reduced-motion support.
- **Mobile:** its own layout with a full-screen globe, draggable three-stop bottom sheet and touch-sized controls.

## 10. Limitations

**Data**
- Most states before 1900 have no linked record, so no ruler or flag; see the table in section 8. Those panels say so rather than fill the gap.
- 92 map entities are hand-mapped by period; the other links are automatic and can name a related entity. Panels mark these with a match score. Accuracy of automatic links hasn't been measured beyond spot checks.
- Wikidata has gaps and errors. Ming China and Spain in 1600 show no ruler, because those monarchs hang on differently modelled items.
- Religion and language facts are state-level statements, not population distributions or estimates. No demographic data is included.
- Derived colonial status is an inference and will be wrong in places. For example, areas under colonial rule but not marked as such in Basemaps stay unmarked.
- Historical Basemaps has its own errors, such as a "Kingdom of Brazil" lasting to 1914. They are shown as mapped.
- Before 1886, a border change appears only at the next snapshot. Borders are not interpolated, so shapes jump instead of morphing.
- The base imagery is the modern Earth, including today's coastlines and rivers.
- Dates are resolved to the year in the interface; a state that exists only between two mid-year points will not appear.

**Not built**
- Trade route, linguistic region and religious region layers: no suitable dated source was among the sources you named, so they are left out rather than faked. Language and religion are in the panels.
- CShapes-Europe (1816 to 1886) is not integrated, though it would improve 19th-century Europe.
- The interface is English only. Search matches other languages.
- No deployment was carried out and no CDN or external monitoring is set up. HTTP caching headers are in place.
- Wikipedia text is the English article introduction, describing the state as a whole, not the selected year. Choice of article is what varies with the date.

**Experience**
- "Comparable to Google Earth" holds for fluidity at world and regional scale. There's no 3D terrain, and imagery stops sharpening at zoom level 8.
- After one visit the app reopens offline, showing what was cached. Map tiles are read in byte ranges, which the service worker cannot store, so offline they come only from the browser's HTTP cache.

## 11. Tests actually run

| Suite | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | No errors |
| Vitest: time model, matching, panel rules, geometry, ingestion, API against a fixture database, checks against the real database | **71 of 71 passed** |
| Playwright, software WebGL, 1440×900 and 1180×720 Chrome, Pixel 7 emulation | **36 passed, 17 skipped, 0 failed** after the caching work. Skips are tests that don't apply to that device |

Playwright covers: borders changing with the year, BC to AD, playback, ribbon drag, click to panel, panel following the date, France 1789, vanished states, search flows, layers, events, source switching, responsive bounds, touch target size, bottom-sheet drag, pinch zoom, and drag and wheel on the globe.

**Not tested:** real phones and tablets (touch was emulated in Chromium), Safari, Firefox, long sessions for memory leaks, and live-API failure handling in the pipeline beyond the retries that happened naturally. Wikipedia and Wikidata integration was exercised by the real build and the real-data tests, not by a separate automated test of the fetch code.

## 12. Performance

Local server, on an 8-core Mac with 16 GB of memory, Chromium via Metal.

| Measure | Desktop 1440×900 | Phone-sized viewport |
|---|---|---|
| Map ready, first load | 1.8 s | 1.9 s |
| Data transferred at load, excluding cached assets | 654 KB | 631 KB |
| Frame rate idle / rotating / during playback | 60 / 60 / 60 fps | 60 / 60 / 60 fps |
| Year change within CShapes | 90 ms | 105 ms |
| Year change to another snapshot | about 130 ms | 92 to 128 ms |
| JS heap | 31 MB | 47 MB |

These timings measure time until tiles are loaded. The cross-fade adds about 320 ms of visible animation. Load times are localhost, so a real network will be slower, and imagery came over the live network.

**The phone column is a phone-sized window on this Mac's GPU, not a phone.** Real-device frame rates are unmeasured. Under software rendering (no GPU), rotation drops to 2 to 3 fps, which shows the app needs real GPU access.

**Caching and preloading**, added after the figures above. The figures in this section were measured against the local Node server, before the move to static hosting; they have not been re-measured on GitHub Pages:

| Layer | What it does |
|---|---|
| Imagery | Loaded straight from NASA GIBS, which allows cross-origin use. (Before static hosting, zooms 0 to 6 were served locally.) |
| Service worker (`public/sw.js`, production only) | Serves app files, glyphs, imagery and Wikimedia images from disk. Data files answer from cache and refresh behind the scenes. Each cache has a size limit |
| Hashed bundles | App code and fonts carry a content hash and are cached for good |
| Preloading | Labels and archive directories of neighbouring eras, the low-zoom world when idle, and the panel and images of a hovered territory. Skipped under Save-Data or on 2G |
| Hidden map slot | The inactive slot requests no tiles and draws nothing |

| Measured, desktop, this Mac's GPU | Before | After |
|---|---|---|
| First visit, Fast 4G (9 Mbps, 60 ms), no caches | 2.6 s | 2.0 s (interface at 0.6 s) |
| First visit, slow 4G (1.6 Mbps, 150 ms), no caches | not measured | 6.2 s (interface at 2.0 s) |
| Repeat visit | not measured | 0.7 s |
| Change of era, until the new map starts fading in | about 600 ms | 37 to 60 ms |
| Zoom into a new region (zoom 5) | 2.2 s | 0.5 s |

The server was on localhost, so the throttling simulates the network but not a distant server. The repeat-visit, era and zoom figures ran with the service worker active, which bypasses the simulated throttling; they reflect cached and preloaded data, and an era or region not yet preloaded takes longer on a real network. "Before" era and zoom figures were measured differently (until all tiles were ready), so treat those two comparisons as approximate. The first-visit test blocks the service worker so its throttling applies.

Server, measured with `curl`: territories for one year 6 ms, one tile 1 ms, search 3 ms, panel 2 ms. Download size: 1.05 MB MapLibre plus 264 KB app before compression (285 KB plus 83 KB compressed). Database: 144 MB.
