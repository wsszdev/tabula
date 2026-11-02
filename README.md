# TABULA

A 3D atlas of the world's political history. Pick a year, turn the globe, select a territory, and see what the sources document for that moment: its name, borders, ruler, flag, languages and religion.

The site is fully static: it runs on GitHub Pages, with no server.

## Quick start

Needs Node 22.13 or newer (Node 24 is used in CI).

```bash
npm install
npm run dev        # http://localhost:5173, with live reload
```

The atlas data the site reads is already in the repository (`packages/web/public/data`), so this is all you need to work on the interface.

## Deploying to GitHub Pages

1. Push the repository to GitHub.
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Every push to `main` builds the site and publishes it at `https://<user>.github.io/<repo>/` (see `.github/workflows/pages.yml`).

The build uses relative URLs, so it works under any repository name or a custom domain.

## Rebuilding the data

Only needed to change or refresh the data. The pipeline downloads the map sources, queries Wikidata and Wikipedia, and writes `data/tabula.db`, which `npm run export` turns into the static files.

```bash
# Download the sources into data/raw (needed once)
mkdir -p data/raw/cshapes data/raw/basemaps
curl -o data/raw/cshapes/CShapes-2.0.geojson https://icr.ethz.ch/data/cshapes/CShapes-2.0.geojson
curl -s https://api.github.com/repos/aourednik/historical-basemaps/contents/geojson \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s).forEach(f=>console.log(f.name)))" \
  | xargs -P 8 -I{} curl -s -o data/raw/basemaps/{} https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/{}

npm run data       # builds data/tabula.db: about 30 min on an empty cache, about 1 min after that
npm run export     # writes packages/web/public/data (about 80 MB), then commit it
```

`npm run data:glyphs` regenerates the map label glyphs in `packages/web/public/glyphs` from `data/fonts`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Static site in `packages/web/dist` |
| `npm run preview` | Serves the build at http://127.0.0.1:4173 |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | Browser tests against the build, with software WebGL. Run `npm run build` first |
| `PW_GL=metal npm run test:e2e` | Browser tests on the Mac's GPU, for meaningful frame rates |
| `npm run typecheck` | TypeScript |
| `npm start` | Optional query API on the database, at http://127.0.0.1:8787/api (needs `data/tabula.db`) |

## Layout

```
packages/
  shared/     time model, types, panel and search logic (used by the API and the browser)
  pipeline/   ingestion, Wikidata matching, tiles, validation  ->  data/tabula.db
  server/     optional API, and the static export (export.ts, pmtiles.ts)
  web/        React + MapLibre interface; public/data holds the exported atlas
tests/        unit, integration and Playwright tests
docs/         technical documentation
```

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): technical choices, schema, ingestion, coverage, features, limits, test results and performance
- [NOTICE.md](NOTICE.md): data licences, including a non-commercial restriction to read before any release
