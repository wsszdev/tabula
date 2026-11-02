import { useEffect, useState, type ReactNode } from 'react';
import type { EventItem } from '@tabula/shared';
import { formatYear } from '@tabula/shared';
import { useStore, type LayerId, type Sheet } from '../lib/store.ts';
import { loadEvents } from '../lib/data.ts';
import { IconAbout, IconClose, IconLayers, IconMoments, IconSettings } from './icons.tsx';

const ITEMS: { id: NonNullable<Sheet>; label: string; icon: ReactNode }[] = [
  { id: 'layers', label: 'Layers', icon: <IconLayers /> },
  { id: 'moments', label: 'Events', icon: <IconMoments /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
  { id: 'about', label: 'About the data', icon: <IconAbout /> },
];

export function Rail() {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  return (
    <nav className="rail-nav" aria-label="Main">
      <div className="wordmark" aria-label="TABULA">Tabula</div>
      {ITEMS.map((i) => (
        <button key={i.id} className={`ico ${sheet === i.id ? 'on' : ''}`} aria-label={i.label} aria-pressed={sheet === i.id} title={i.label} onClick={() => setSheet(i.id)} data-testid={`rail-${i.id}`}>
          {i.icon}
        </button>
      ))}
    </nav>
  );
}

export function SheetHost() {
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  if (!sheet) return null;
  const title = ITEMS.find((i) => i.id === sheet)!.label;
  return (
    <aside className="side-sheet" aria-label={title} data-testid={`sheet-${sheet}`}>
      <header>
        <h2>{title}</h2>
        <button className="ico" onClick={() => setSheet(sheet)} aria-label={`Close ${title}`}><IconClose /></button>
      </header>
      <div className="sheet-body">
        {sheet === 'layers' && <Layers />}
        {sheet === 'moments' && <Moments />}
        {sheet === 'settings' && <Settings />}
        {sheet === 'about' && <About />}
      </div>
    </aside>
  );
}

const LAYER_ROWS: { id: LayerId; name: string; note?: string; group: string }[] = [
  { id: 'borders', name: 'Borders', group: 'Map' },
  { id: 'labels', name: 'Names', group: 'Map' },
  { id: 'empire', name: 'Empires', group: 'Political' },
  { id: 'kingdom', name: 'Kingdoms and principalities', group: 'Political' },
  { id: 'republic', name: 'Republics and federations', group: 'Political' },
  { id: 'dependency', name: 'Colonies and dependencies', group: 'Political' },
  { id: 'polity', name: 'Other states', note: 'The sources do not state a form of government', group: 'Political' },
  { id: 'culture', name: 'Cultures and peoples', note: 'Regions of cultures, not states', group: 'Political' },
  { id: 'capitals', name: 'Capitals', note: 'Where the period is documented', group: 'Places' },
  { id: 'cities', name: 'Cities', note: 'With a documented founding date', group: 'Places' },
];

function Layers() {
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  const groups = ['Map', 'Political', 'Places'];
  return (
    <>
      {groups.map((g) => (
        <fieldset key={g}>
          <legend>{g}</legend>
          {LAYER_ROWS.filter((r) => r.group === g).map((r) => (
            <label key={r.id} className="switch-row">
              <span><span className="sw-name">{r.name}</span>{r.note && <small>{r.note}</small>}</span>
              <input type="checkbox" role="switch" checked={layers[r.id]} onChange={() => toggle(r.id)} data-testid={`layer-${r.id}`} />
            </label>
          ))}
        </fieldset>
      ))}
      <p className="fine">Trade routes and language or religion regions stay off the list until a source with mapped, dated geometry is added. Languages and religions are shown for each state in its panel.</p>
    </>
  );
}

function Moments() {
  const year = useStore((s) => s.year);
  const setYear = useStore((s) => s.setYear);
  const requestFly = useStore((s) => s.requestFly);
  const [all, setAll] = useState<EventItem[] | null>(null);
  const [kind, setKind] = useState('all');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    loadEvents().then((r) => setAll(r.events)).catch(() => setFailed(true));
  }, []);
  if (failed) return <p className="fine">Events could not be loaded. Reopen this panel to try again.</p>;
  if (!all) return <p className="fine">Loading events</p>;
  const kinds = ['all', ...new Set(all.map((e) => e.kind))];
  const list = all.filter((e) => kind === 'all' || e.kind === kind);
  const nextIdx = list.findIndex((e) => e.year >= year);
  const near = list.slice(Math.max(0, nextIdx - 3), (nextIdx < 0 ? list.length : nextIdx) + 25);
  const go = (e: EventItem) => {
    setYear(e.year);
    if (e.lon != null) requestFly({ lon: e.lon, lat: e.lat, zoom: 4.2 });
  };
  return (
    <>
      <div className="chips" role="radiogroup" aria-label="Event type">
        {kinds.map((k) => <button key={k} role="radio" aria-checked={k === kind} className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k[0]!.toUpperCase() + k.slice(1)}</button>)}
      </div>
      <ol className="moments" data-testid="moments">
        {near.map((e) => (
          <li key={e.qid}>
            <button onClick={() => go(e)}>
              <span className="m-year">{formatYear(e.year)}</span>
              <span className="m-label">{e.label}{e.description && <small>{e.description}</small>}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="fine">The most widely documented events from Wikidata, ranked by how many Wikipedia editions cover them.</p>
    </>
  );
}

function Settings() {
  const sourceMode = useStore((s) => s.sourceMode);
  const setSourceMode = useStore((s) => s.setSourceMode);
  const dim = useStore((s) => s.dim);
  const setDim = useStore((s) => s.setDim);
  const spin = useStore((s) => s.spin);
  const setSpin = useStore((s) => s.setSpin);
  return (
    <>
      <fieldset>
        <legend>Map data from 1886</legend>
        <label className="radio-row"><input type="radio" name="src" checked={sourceMode === 'auto'} onChange={() => setSourceMode('auto')} /><span><span className="sw-name">CShapes</span><small>Borders dated to the day, states and territories only</small></span></label>
        <label className="radio-row"><input type="radio" name="src" checked={sourceMode === 'basemaps'} onChange={() => setSourceMode('basemaps')} data-testid="source-basemaps" /><span><span className="sw-name">Historical Basemaps</span><small>Fewer dates, more named colonies and regions</small></span></label>
      </fieldset>
      <fieldset>
        <legend>Globe</legend>
        <label className="range-row"><span className="sw-name">Earth brightness</span><input type="range" min={0.3} max={0.9} step={0.02} value={dim} onChange={(e) => setDim(Number(e.target.value))} /></label>
        <label className="switch-row"><span><span className="sw-name">Slow rotation</span></span><input type="checkbox" role="switch" checked={spin} onChange={(e) => setSpin(e.target.checked)} /></label>
      </fieldset>
      <fieldset>
        <legend>Keyboard</legend>
        <dl className="keys"><dt>Left, Right</dt><dd>Change year</dd><dt>Shift + Left, Right</dt><dd>Change by ten years</dd><dt>Space</dt><dd>Play or pause</dd><dt>/</dt><dd>Search</dd><dt>Esc</dt><dd>Close panel</dd></dl>
      </fieldset>
    </>
  );
}

function About() {
  const meta = useStore((s) => s.meta);
  return (
    <div className="about">
      <p>TABULA shows only what its sources document. Blank land means no source maps a polity there for that year.</p>
      <h3>How to read the map</h3>
      <p>Sharp borders are precise in the source. Soft, blurred borders are approximate. Before 1886 each map is a snapshot held until the next one, so a change can appear later than it happened.</p>
      <h3>Sources</h3>
      <ul className="sources">
        {meta?.sources.map((s) => (
          <li key={s.name}>
            <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
            <small>{s.license}. {s.records.toLocaleString('en')} records, retrieved {s.retrieved}.</small>
          </li>
        ))}
        <li><a href="https://gibs.earthdata.nasa.gov/" target="_blank" rel="noreferrer">NASA GIBS Blue Marble</a><small>Public domain imagery of the modern Earth. Coastlines and rivers are today's.</small></li>
      </ul>
      <p className="fine">CShapes: Schvitz, Rüegger, Girardin, Cederman, Weidmann, Gleditsch (2022), Journal of Conflict Resolution 66(1). Historical Basemaps: A. Ourednik and contributors.</p>
    </div>
  );
}
