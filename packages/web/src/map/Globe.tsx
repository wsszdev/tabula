import { useEffect, useRef } from 'react';
import maplibregl, { type ExpressionSpecification, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { setForT, yearToT, formatYear } from '@tabula/shared';
import { PMTiles, Protocol } from 'pmtiles';
import { PALETTE, useStore, type LayerId } from '../lib/store.ts';
import { canPreload, loadPanel, preload } from '../lib/loader.ts';
import { getJson, glyphsUrl, labelsPath, placesAt, tilesUrl } from '../lib/data.ts';

// Each tile set is one PMTiles archive, read with HTTP range requests.
const pmtiles = new Protocol();
maplibregl.addProtocol('pmtiles', pmtiles.tile);
const archive = (set: string) => {
  const key = tilesUrl(set).slice('pmtiles://'.length);
  let p = pmtiles.get(key);
  if (!p) { p = new PMTiles(key); pmtiles.add(p); }
  return p;
};

// NASA GIBS serves the imagery directly, with CORS; it is public domain.
const IMAGERY = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8';

/** What territory is drawn at this point now. Set once the globe exists. */
export let probeAt: (lon: number, lat: number) => Promise<{ id: number; entityId: string } | null> = async () => null;

const colorExpr: ExpressionSpecification = ['match', ['get', 'c'], ...PALETTE.flatMap((c, i) => [i, c]), '#888'] as unknown as ExpressionSpecification;

const STYLE: StyleSpecification = {
  version: 8,
  projection: { type: 'globe' },
  glyphs: glyphsUrl(),
  sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 7, 0] },
  sources: {
    earth: {
      type: 'raster', tileSize: 256, maxzoom: 8,
      tiles: [`${IMAGERY}/{z}/{y}/{x}.jpeg`],
      attribution: 'Imagery: NASA Blue Marble via GIBS',
    },
  },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': '#0c2638' } },
    { id: 'earth', type: 'raster', source: 'earth', paint: { 'raster-saturation': -0.35, 'raster-brightness-max': 0.72, 'raster-contrast': 0.08, 'raster-fade-duration': 200 } },
  ],
};

const SLOTS = ['a', 'b'] as const;
type Slot = (typeof SLOTS)[number];

const classKinds: LayerId[] = ['empire', 'kingdom', 'republic', 'dependency', 'culture', 'polity'];

function baseFilter(t: number, kinds: string[]): ExpressionSpecification {
  return ['all', ['<=', ['get', 's'], t], ['>', ['get', 'e'], t], ['in', ['get', 'k'], ['literal', kinds]]] as ExpressionSpecification;
}

const LABEL_FONT = (bold: boolean, italic: boolean) => [`Spectral ${bold ? 'SemiBold' : ''}${italic ? 'Italic' : bold ? '' : 'Regular'}`];

/** All globe drawing and interaction. React state flows in; only clicks and hovers flow out. */
export function Globe() {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const active = useRef<{ slot: Slot; set: string | null }>({ slot: 'a', set: null });
  const labelCache = useRef(new Map<string, Promise<any>>());
  const labelNow = useRef<any[] | null>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current!, style: STYLE, center: initialCenter(), zoom: initialZoom(), maxZoom: 10, minZoom: 0.6,
      attributionControl: false, fadeDuration: 150, localIdeographFontFamily: '"Noto Serif CJK SC","Songti SC",serif',
      maxPitch: 60, canvasContextAttributes: { antialias: true },
      maxTileCacheSize: 600, pixelRatio: Math.min(devicePixelRatio, 2), cancelPendingTileRequestsWhileZooming: false,
    });
    (window as any).__map = map;
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.touchZoomRotate.enable();
    map.on('error', (e) => { if (!String((e as any).tile?.tileID ? '' : e.error?.message).includes('imagery')) console.warn('map error', e.error?.message); });

    map.on('load', () => {
      for (const s of SLOTS) {
        map.addSource(`terr-${s}`, { type: 'vector', tiles: [`${tilesUrl('hb_1400')}/{z}/{x}/{y}`], maxzoom: 6 });
        const src = { source: `terr-${s}`, 'source-layer': 'territories' };
        map.addLayer({ id: `wash-${s}`, type: 'fill', ...src, layout: { visibility: 'none' }, paint: { 'fill-color': colorExpr, 'fill-opacity': 0, 'fill-opacity-transition': { duration: 320 }, 'fill-antialias': false } });
        // Edge wash: the darker rim hand-tinted atlases have along each border.
        map.addLayer({ id: `rim-${s}`, type: 'line', ...src, layout: { 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': colorExpr, 'line-opacity': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 11], 'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 10], 'line-opacity-transition': { duration: 320 } } });
        // Border sharpness states certainty: blurred where the source calls the border approximate.
        map.addLayer({ id: `border-${s}`, type: 'line', ...src, layout: { 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': '#f2efe4', 'line-opacity': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.4], 'line-blur': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['>=', ['get', 'p'], 3], 0, 1.2], 6, ['case', ['>=', ['get', 'p'], 3], 0, 3.5]], 'line-opacity-transition': { duration: 320 } } });
      }
      map.addLayer({ id: 'hover-a', type: 'line', source: 'terr-a', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'line-color': '#fffdf2', 'line-width': 1.6, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'hover-b', type: 'line', source: 'terr-b', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'line-color': '#fffdf2', 'line-width': 1.6, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'sel-fill-a', type: 'fill', source: 'terr-a', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'fill-color': '#fff7d6', 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'sel-a', type: 'line', source: 'terr-a', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'line-color': '#fff7d6', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 3] } });
      map.addLayer({ id: 'sel-fill-b', type: 'fill', source: 'terr-b', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'fill-color': '#fff7d6', 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'sel-b', type: 'line', source: 'terr-b', 'source-layer': 'territories', layout: { visibility: 'none' }, filter: ['==', ['get', 't'], -1], paint: { 'line-color': '#fff7d6', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 3] } });

      map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'cities', type: 'circle', source: 'places', minzoom: 2.5, filter: ['==', ['get', 'k'], 'city'], paint: { 'circle-radius': 2.4, 'circle-color': '#f2efe4', 'circle-stroke-color': '#0c2638', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'capitals', type: 'circle', source: 'places', minzoom: 1.8, filter: ['==', ['get', 'k'], 'capital'], paint: { 'circle-radius': 3.2, 'circle-color': '#0c2638', 'circle-stroke-color': '#f2efe4', 'circle-stroke-width': 1.4 } });
      map.addLayer({ id: 'capital-labels', type: 'symbol', source: 'places', minzoom: 3.2, filter: ['==', ['get', 'k'], 'capital'], layout: { 'text-field': ['get', 'n'], 'text-font': LABEL_FONT(false, false), 'text-size': 12, 'text-offset': [0, 0.7], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#f7f4e8', 'text-halo-color': 'rgba(12,38,56,.85)', 'text-halo-width': 1.2 } });
      map.addLayer({ id: 'city-labels', type: 'symbol', source: 'places', minzoom: 4, filter: ['==', ['get', 'k'], 'city'], layout: { 'text-field': ['get', 'n'], 'text-font': LABEL_FONT(false, true), 'text-size': 11, 'text-offset': [0, 0.6], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#e7e6d8', 'text-halo-color': 'rgba(12,38,56,.85)', 'text-halo-width': 1.1 } });

      map.addSource('labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const areaSize: ExpressionSpecification = ['interpolate', ['linear'], ['sqrt', ['get', 'a']], 30, 10.5, 300, 12, 1000, 15, 3000, 21];
      map.addLayer({
        id: 'labels', type: 'symbol', source: 'labels',
        layout: {
          'text-field': ['get', 'n'],
          'text-font': LABEL_FONT(false, false),
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, ['*', areaSize, 0.82], 5, ['*', areaSize, 1.25]] as ExpressionSpecification,
          'text-letter-spacing': ['interpolate', ['linear'], ['sqrt', ['get', 'a']], 300, 0.02, 2500, 0.16],
          'text-max-width': 7, 'text-line-height': 1.05, 'text-padding': 5,
          'symbol-sort-key': ['-', 0, ['get', 'a']],
          'text-variable-anchor': ['center', 'top', 'bottom'], 'text-radial-offset': 0.3,
        },
        paint: { 'text-color': '#fbf8ec', 'text-halo-color': 'rgba(10,30,44,.82)', 'text-halo-width': 1.3, 'text-halo-blur': 0.5, 'text-opacity': 1 },
      });
      useStore.setState({}); // nudge subscribers
      sync(true);
    });

    const pick = (pt: maplibregl.PointLike) => {
      const slot = active.current.slot;
      const feats = map.queryRenderedFeatures(pt, { layers: [`wash-${slot}`] });
      return feats.sort((x, y) => Number(x.properties.a) - Number(y.properties.a))[0] ?? null;
    };

    probeAt = async (lon, lat) => {
      const c = map.getCanvas();
      const onScreen = (p: maplibregl.Point) => p.x >= 0 && p.y >= 0 && p.x <= c.clientWidth && p.y <= c.clientHeight;
      if (!onScreen(map.project([lon, lat]))) map.jumpTo({ center: [lon, lat] });
      if (!map.areTilesLoaded()) await new Promise((r) => map.once('idle', r));
      const f = pick(map.project([lon, lat]));
      return f ? { id: Number(f.properties.t), entityId: String(f.properties.eid) } : null;
    };

    map.on('click', (e) => {
      const f = pick(e.point);
      if (!f) return useStore.getState().select(null);
      useStore.getState().select({ territoryId: Number(f.properties.t), entityId: String(f.properties.eid), lon: e.lngLat.lng, lat: e.lngLat.lat, atYear: useStore.getState().year });
    });
    let lastHover = -1;
    let hoverTimer: number | undefined;
    map.on('mousemove', (e) => {
      const f = pick(e.point);
      const id = f ? Number(f.properties.t) : -1;
      map.getCanvas().style.cursor = f ? 'pointer' : 'grab';
      if (tooltip.current) {
        tooltip.current.style.opacity = f ? '1' : '0';
        if (f) {
          const t = yearToT(useStore.getState().year);
          const label = labelNow.current?.find((l: any) => l.properties.t === id && l.properties.s <= t && l.properties.e > t);
          tooltip.current.textContent = label?.properties.n ?? String(f.properties.n).replace(/\s*\(.*\)$/, '');
          tooltip.current.style.transform = `translate(${e.point.x + 14}px, ${e.point.y + 14}px)`;
        }
      }
      if (id === lastHover) return;
      lastHover = id;
      for (const l of ['hover-a', 'hover-b']) map.setFilter(l, ['==', ['get', 't'], id]);
      // Whoever pauses on a territory is likely to open it: have its panel and flag ready.
      window.clearTimeout(hoverTimer);
      if (id >= 0 && canPreload()) hoverTimer = window.setTimeout(() => void loadPanel(id, useStore.getState().year).catch(() => {}), 140);
    });
    map.on('mouseout', () => { if (tooltip.current) tooltip.current.style.opacity = '0'; });

    let lastUser = Date.now();
    const bump = () => { lastUser = Date.now(); };
    map.on('dragstart', bump); map.on('zoomstart', bump);
    let raf = 0, prev = performance.now();
    const spinLoop = (now: number) => {
      raf = requestAnimationFrame(spinLoop);
      const st = useStore.getState();
      const dt = now - prev; prev = now;
      if (!st.spin || st.playing === undefined || Date.now() - lastUser < 2500 || map.isMoving() || map.getZoom() > 3) return;
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + dt * 0.002, c.lat] });
    };
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(spinLoop);

    const persistCam = () => {
      const c = map.getCenter();
      const h = new URLSearchParams(location.hash.slice(1));
      h.set('c', `${c.lng.toFixed(2)},${c.lat.toFixed(2)},${map.getZoom().toFixed(2)}`);
      history.replaceState(null, '', '#' + h.toString());
    };
    map.on('moveend', persistCam);
    map.on('moveend', () => { if (active.current.set) prefetchNeighbours(active.current.set); });
    return () => { cancelAnimationFrame(raf); map.remove(); mapRef.current = null; };
  }, []);

  // Reconciles the map with the store. `force` applies paint state with no fade.
  const pending = useRef(0);
  const sync = (force = false) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() && !force) return;
    if (!map.getSource('labels')) return;
    const st = useStore.getState();
    if (!st.meta) return;
    const t = yearToT(st.year);
    const dataset = st.sourceMode === 'basemaps' ? 'basemaps' : undefined;
    const set = setForT(st.meta.sets as any, t, dataset) as any;
    if (!set) return;
    const kinds = classKinds.filter((k) => st.layers[k]);
    const filter = baseFilter(t, kinds);
    const cur = active.current;
    const visible = (slot: Slot, on: boolean, duration: number) => {
      const border = st.layers.borders;
      const op = on ? 1 : 0;
      const tr = { duration, delay: 0 };
      map.setPaintProperty(`wash-${slot}`, 'fill-opacity-transition', tr);
      map.setPaintProperty(`rim-${slot}`, 'line-opacity-transition', tr);
      map.setPaintProperty(`border-${slot}`, 'line-opacity-transition', tr);
      map.setPaintProperty(`wash-${slot}`, 'fill-opacity', op * 0.42);
      map.setPaintProperty(`rim-${slot}`, 'line-opacity', op * 0.5);
      map.setPaintProperty(`border-${slot}`, 'line-opacity', op * (border ? 0.72 : 0));
    };
    const setFilter = (slot: Slot, f: ExpressionSpecification) => {
      for (const l of ['wash', 'rim', 'border']) map.setFilter(`${l}-${slot}`, f);
    };
    const setSource = (slot: Slot, id: string) => {
      (map.getSource(`terr-${slot}`) as maplibregl.VectorTileSource).setTiles([`${tilesUrl(id)}/{z}/{x}/{y}`]);
    };
    // A hidden slot requests no tiles and costs no drawing.
    const showSlot = (slot: Slot, on: boolean) => {
      const v = on ? 'visible' : 'none';
      for (const l of [`wash-${slot}`, `rim-${slot}`, `border-${slot}`, `hover-${slot}`, `sel-${slot}`, `sel-fill-${slot}`]) map.setLayoutProperty(l, 'visibility', v);
    };

    if (cur.set === set.id) {
      setFilter(cur.slot, filter);
    } else {
      const next: Slot = cur.slot === 'a' ? 'b' : 'a';
      const myJob = ++pending.current;
      const prevSlot = cur.slot;
      setSource(next, set.id);
      setFilter(next, filter);
      showSlot(next, true);
      cur.slot = next; cur.set = set.id;
      const started = performance.now();
      const reveal = () => {
        if (pending.current !== myJob) return;
        (window as any).__eraShownMs = Math.round(performance.now() - started);
        visible(next, true, 320);
        const fadeOut = st.playing ? 200 : 420;
        visible(prevSlot, false, fadeOut);
        window.setTimeout(() => { if (pending.current === myJob) showSlot(prevSlot, false); }, fadeOut + 60);
      };
      // Wait for tiles so a new era cross-fades instead of flashing the bare globe.
      const wait = () => {
        if (pending.current !== myJob) return;
        if (map.isSourceLoaded(`terr-${next}`) || performance.now() - started > 900) reveal();
        else requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
      prefetchNeighbours(set.id);
    }
    if (force && cur.set === set.id) visible(cur.slot, true, 0);

    for (const l of ['labels']) map.setLayoutProperty(l, 'visibility', st.layers.labels ? 'visible' : 'none');
    map.setLayoutProperty('capitals', 'visibility', st.layers.capitals ? 'visible' : 'none');
    map.setLayoutProperty('capital-labels', 'visibility', st.layers.capitals ? 'visible' : 'none');
    map.setLayoutProperty('cities', 'visibility', st.layers.cities ? 'visible' : 'none');
    map.setLayoutProperty('city-labels', 'visibility', st.layers.cities ? 'visible' : 'none');
    loadLabels(set.id).then((data) => {
      if (active.current.set !== set.id) return;
      const src = map.getSource('labels') as maplibregl.GeoJSONSource;
      if ((src as any)._tabulaSet !== set.id) {
        src.setData(data);
        (src as any)._tabulaSet = set.id;
      }
      labelNow.current = data.features;
      map.setFilter('labels', filter);
    });
    const selected = st.selection?.territoryId ?? -1;
    for (const s of SLOTS) {
      map.setFilter(`sel-${s}`, ['==', ['get', 't'], selected]);
      map.setFilter(`sel-fill-${s}`, ['==', ['get', 't'], selected]);
    }
    map.setPaintProperty('earth', 'raster-brightness-max', st.dim + 0.1);
  };

  const loadLabels = (id: string) => {
    let p = labelCache.current.get(id);
    if (!p) {
      p = getJson(labelsPath(id));
      labelCache.current.set(id, p);
    }
    return p;
  };

  /** The eras next door, for exactly what is on screen, so moving through time finds them ready. */
  const prefetchNeighbours = (id: string) => {
    const map = mapRef.current;
    const st = useStore.getState();
    if (!map || !st.meta || !canPreload()) return;
    const modern = st.sourceMode === 'auto';
    const order = (st.meta.sets as { id: string; dataset: string; from: number }[])
      .filter((s) => (modern ? (s.dataset === 'cshapes' || s.from < 1886) : s.dataset === 'basemaps'))
      .sort((a, b) => a.from - b.from);
    const i = order.findIndex((s) => s.id === id);
    if (i < 0) return;
    const near = st.playing ? [order[i + 1], order[i + 2]] : [order[i + 1], order[i - 1]];
    for (const n of near) {
      if (!n) continue;
      void loadLabels(n.id);
      // The archive's header and root directory: its tiles then cost one request each.
      void archive(n.id).getHeader().catch(() => {});
    }
  };

  /** Once the first view is drawn, quietly fetch the world at low zoom so turning the globe never shows gaps. */
  const warmWorld = () => {
    const urls: string[] = [];
    for (let z = 0; z <= 3; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) urls.push(`${IMAGERY}/${z}/${y}/${x}.jpeg`);
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(() => {
      preload(urls);
      if (!canPreload()) return;
      const cs = archive('cs');
      for (let z = 0; z <= 2; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) void cs.getZxy(z, x, y).catch(() => {});
    });
  };

  useEffect(() => useStore.subscribe((s, p) => {
    if (s.year !== p.year || s.layers !== p.layers || s.sourceMode !== p.sourceMode || s.selection !== p.selection || s.dim !== p.dim || s.meta !== p.meta) {
      sync(p.meta == null);
    }
    if (s.year !== p.year) void loadPlaces(s.year);
    if (s.flyTo && s.flyTo.seq !== p.flyTo?.seq) fly(s.flyTo);
  }), []);

  useEffect(() => {
    const map = mapRef.current!;
    const start = () => { void loadPlaces(useStore.getState().year); sync(true); };
    map.once('idle', () => {
      const go = () => { if (useStore.getState().meta) warmWorld(); else setTimeout(go, 200); };
      go();
    });
    if (map.loaded()) start(); else map.once('load', start);
  }, []);

  let placeTimer = useRef<number | undefined>(undefined);
  const loadPlaces = (year: number) => {
    window.clearTimeout(placeTimer.current);
    placeTimer.current = window.setTimeout(async () => {
      const data = await placesAt(year).catch(() => null);
      if (data && useStore.getState().year === year) (mapRef.current?.getSource('places') as maplibregl.GeoJSONSource | undefined)?.setData(data);
    }, useStore.getState().playing ? 350 : 80);
  };

  const fly = (f: NonNullable<ReturnType<typeof useStore.getState>['flyTo']>) => {
    const map = mapRef.current;
    if (!map) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mobile = innerWidth <= 760;
    const pad = mobile ? { top: 70, bottom: innerHeight * 0.5, left: 24, right: 24 } : { top: 60, bottom: 190, left: 100, right: 440 };
    if (f.bbox) {
      const [a, b, c, d] = f.bbox;
      const wide = c - a > 300; // a polygon straddling the antimeridian fits badly as a box
      if (!wide) return map.fitBounds([[a, b], [c, d]], { padding: pad, maxZoom: 5.5, duration: reduced ? 0 : 2200, essential: true });
    }
    if (f.lon != null && f.lat != null) map.flyTo({ center: [f.lon, f.lat], zoom: f.zoom ?? 3, padding: pad, duration: reduced ? 0 : 2200, essential: true });
  };

  return (
    <>
      <div ref={box} className="globe" role="application" aria-label={`Globe showing the world in ${formatYear(useStore.getState().year)}`} />
      <div ref={tooltip} className="map-tip" aria-hidden />
    </>
  );
}

function hashCam() {
  const c = new URLSearchParams(location.hash.slice(1)).get('c')?.split(',').map(Number);
  return c && c.length === 3 && c.every(Number.isFinite) ? c : null;
}
const initialCenter = (): [number, number] => { const c = hashCam(); return c ? [c[0]!, c[1]!] : [28, 30]; };
const initialZoom = () => hashCam()?.[2] ?? (innerWidth <= 760 ? 0.9 : 1.75);
