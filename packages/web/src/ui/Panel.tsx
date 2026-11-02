import { useRef, useState, type ReactNode } from 'react';
import type { FlagFact, RulerFact, TimedFact } from '@tabula/shared';
import { astroToYear, formatRange, formatT, formatYear } from '@tabula/shared';
import { useStore } from '../lib/store.ts';
import { probeAt } from '../map/Globe.tsx';
import { IconClose } from './icons.tsx';

const KIND: Record<string, string> = { empire: 'Empire', kingdom: 'Kingdom or principality', republic: 'Republic or federation', dependency: 'Dependency', culture: 'Culture or people', polity: 'Polity' };

const cleanName = (n: string) => n.replace(/\s*\((.*)\)\s*$/, '');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="p-section"><h3>{title}</h3>{children}</section>;
}

const Undocumented = ({ what }: { what: string }) => <p className="undoc">{what} not documented for this date.</p>;

function FactList({ facts }: { facts: TimedFact[] }) {
  return (
    <ul className="facts">
      {facts.map((f) => (
        <li key={f.qid ?? f.label}>
          {f.qid ? <a href={`https://www.wikidata.org/wiki/${f.qid}`} target="_blank" rel="noreferrer">{f.label}</a> : f.label}
          <small>{f.temporal === 'dated' ? formatRange(f.from, f.to) : 'Stated for the state as a whole, not for this year'}</small>
        </li>
      ))}
    </ul>
  );
}

function Flag({ f }: { f: FlagFact }) {
  return (
    <figure className="flag" data-testid="flag">
      <a href={f.image.page} target="_blank" rel="noreferrer"><img src={f.image.url} alt={`Flag: ${f.label}`} crossOrigin="anonymous" /></a>
      <figcaption>
        <span>{f.label}</span>
        <small>
          {f.match === 'state-lifetime' ? 'Recorded for the state as a whole; the exact years of use are not stated.' : `In use ${formatRange(f.from, f.to)}.`}
          {f.image.license && ` ${f.image.license}.`} <a href={f.image.page} target="_blank" rel="noreferrer">Commons</a>
        </small>
      </figcaption>
    </figure>
  );
}

function Ruler({ r }: { r: RulerFact }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="ruler" data-testid="ruler">
      {r.portrait ? <img src={r.portrait.url} alt="" crossOrigin="anonymous" /> : <span className="no-portrait" aria-hidden>{r.label[0]}</span>}
      <div>
        <div className="r-name">{r.wikipedia ? <a href={r.wikipedia} target="_blank" rel="noreferrer">{r.label}</a> : r.label}</div>
        <div className="r-meta">{r.title ?? 'Head of state'}, {formatRange(r.from, r.to)}</div>
        {r.bio && (<>
          <p className={open ? 'bio open' : 'bio'}>{r.bio}</p>
          {r.bio.length > 110 && <button className="link" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}
        </>)}
        <a className="src" href={r.source.url} target="_blank" rel="noreferrer">Source: Wikidata</a>
      </div>
    </li>
  );
}

export function Panel() {
  const panel = useStore((s) => s.panel);
  const state = useStore((s) => s.panelState);
  const absent = useStore((s) => s.absent);
  const selection = useStore((s) => s.selection);
  const year = useStore((s) => s.year);
  const select = useStore((s) => s.select);
  const setYear = useStore((s) => s.setYear);
  const [snap, setSnap] = useState<'peek' | 'half' | 'full'>('half');
  const drag = useRef<{ y: number; h: number } | null>(null);
  const sheet = useRef<HTMLElement>(null);

  if (!selection) return null;

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: sheet.current!.getBoundingClientRect().height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    sheet.current!.style.transition = 'none';
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) sheet.current!.style.height = `${drag.current.h + (drag.current.y - e.clientY)}px`;
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const h = drag.current.h + (drag.current.y - e.clientY);
    drag.current = null;
    sheet.current!.style.transition = '';
    sheet.current!.style.height = '';
    const r = h / innerHeight;
    setSnap(r > 0.68 ? 'full' : r > 0.3 ? 'half' : 'peek');
  };

  const whatWasHere = async () => {
    if (absent?.lon == null) return;
    const r = await probeAt(absent.lon, absent.lat!);
    if (r) select({ territoryId: r.id, entityId: r.entityId, lon: absent.lon, lat: absent.lat });
    else useStore.getState().setPanel({ absent: { ...absent, name: 'Nothing here', lastMapped: null, nextMapped: null, lon: undefined } });
  };

  return (
    <aside ref={sheet} className={`panel snap-${snap}`} aria-label="Territory details" data-testid="panel">
      <div className="grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onClick={() => setSnap(snap === 'peek' ? 'half' : snap)} aria-hidden><span /></div>
      <button className="ico close" onClick={() => select(null)} aria-label="Close details"><IconClose /></button>

      {state === 'error' && <div className="p-msg" role="alert">This territory could not be loaded. Select it again to retry.</div>}
      {state === 'absent' && absent && (
        <div className="p-msg" data-testid="panel-absent">
          <h2>{cleanName(absent.name)}</h2>
          <p>Not on the map in {formatYear(year)}.</p>
          {absent.lastMapped != null && <button className="pill" onClick={() => setYear(astroToYear(Math.floor(absent.lastMapped! - 0.5)) || 1)}>Last mapped {formatT(absent.lastMapped - 0.5)}</button>}
          {absent.nextMapped != null && <button className="pill" onClick={() => setYear(astroToYear(Math.ceil(absent.nextMapped!)) || 1)}>Next mapped {formatT(absent.nextMapped)}</button>}
          {absent.lon != null && <button className="pill" onClick={whatWasHere}>Show what was here in {formatYear(year)}</button>}
        </div>
      )}
      {!panel && state === 'loading' && <div className="p-msg">Loading</div>}
      {panel && state !== 'absent' && (
        <div className="p-scroll">
          <header className="p-head">
            {panel.flags[0] && <img className="head-flag" src={panel.flags[0].image.url} alt="" crossOrigin="anonymous" />}
            <div>
              <h2 data-testid="panel-name">{panel.identity?.label && panel.identity.confidence >= 0.8 ? panel.identity.label : cleanName(panel.name)}</h2>
              <p className="p-sub">{KIND[panel.kind] ?? 'Polity'} in {formatYear(panel.year)}</p>
            </div>
          </header>

          {panel.identity?.summary
            ? <p className="overview">{panel.identity.summary}{' '}{panel.identity.wikipedia && <a href={panel.identity.wikipedia} target="_blank" rel="noreferrer">Wikipedia</a>}</p>
            : <p className="undoc">No linked encyclopedia article for this map entry.</p>}

          <dl className="p-facts">
            {panel.identity?.label && cleanName(panel.name) !== panel.identity.label && <><dt>Map name</dt><dd>{cleanName(panel.name)}</dd></>}
            {panel.sovereign && <><dt>Ruled by</dt><dd>{panel.sovereign.name}<small>{panel.sovereign.note}</small></dd></>}
            <dt>Capital</dt><dd>{panel.capital ? <>{panel.capital.label}<small>{panel.capital.temporal === 'dated' ? `${panel.capital.source.source}` : 'Stated for the state as a whole'}</small></> : <span className="undoc inline">Not documented</span>}</dd>
            {panel.government.length > 0 && <><dt>Government</dt><dd>{panel.government.map((g) => g.label).join(', ')}{panel.government.some((g) => g.temporal === 'undated') && <small>Stated for the state as a whole, not for this year</small>}</dd></>}
            {panel.identity?.from != null && <><dt>Founded</dt><dd>{formatT(panel.identity.from)}</dd></>}
            {panel.identity?.to != null && <><dt>Ended</dt><dd>{formatT(panel.identity.to)}</dd></>}
            <dt>Mapped area</dt><dd>About {Math.round(panel.areaKm2 / 1000).toLocaleString('en')},000 km²</dd>
            {panel.modernEquivalent && <><dt>Today</dt><dd>{cleanName(panel.modernEquivalent)}<small>The state now at its centre</small></dd></>}
          </dl>

          <Section title="Flag and emblem">
            {panel.flags.length + panel.coats.length === 0
              ? <Undocumented what="Flag" />
              : <div className="flags">{panel.flags.map((f) => <Flag key={f.image.file} f={f} />)}{panel.coats.slice(0, 2).map((f) => <Flag key={f.image.file} f={f} />)}</div>}
          </Section>

          <Section title={panel.rulers.length > 1 ? 'Rulers' : 'Ruler'}>
            {panel.rulers.length ? <ul className="rulers">{panel.rulers.slice(0, 6).map((r) => <Ruler key={r.qid} r={r} />)}</ul> : <Undocumented what="Ruler" />}
          </Section>

          <Section title="Languages">
            {panel.languages.official.length > 0 && <><h4>Official or administrative</h4><FactList facts={panel.languages.official} /></>}
            {panel.languages.spoken.length > 0 && <><h4>Used or spoken</h4><FactList facts={panel.languages.spoken} /></>}
            {!panel.languages.official.length && !panel.languages.spoken.length && <Undocumented what="Languages" />}
          </Section>

          <Section title="Religion">
            {panel.religions.official.length > 0 && <><h4>State religion</h4><FactList facts={panel.religions.official} /></>}
            {panel.religions.major.length > 0 && <><h4>Religion recorded for this state</h4><FactList facts={panel.religions.major} /></>}
            {!panel.religions.official.length && !panel.religions.major.length && <Undocumented what="Religion" />}
          </Section>

          {(panel.predecessors.length > 0 || panel.successors.length > 0) && (
            <Section title="Before and after">
              {panel.predecessors.length > 0 && <><h4>Came from</h4><ul className="links">{panel.predecessors.slice(0, 6).map((f) => <li key={f.qid!}><a href={`https://www.wikidata.org/wiki/${f.qid}`} target="_blank" rel="noreferrer">{f.label}</a></li>)}</ul></>}
              {panel.successors.length > 0 && <><h4>Became</h4><ul className="links">{panel.successors.slice(0, 6).map((f) => <li key={f.qid!}><a href={`https://www.wikidata.org/wiki/${f.qid}`} target="_blank" rel="noreferrer">{f.label}</a></li>)}</ul></>}
            </Section>
          )}

          <Section title="Sources">
            <p className="certainty" data-testid="certainty">
              <b>Borders:</b> {panel.mapSource.dataset}. {panel.mapSource.note}{panel.borderPrecision != null && panel.borderPrecision < 3 ? ' The source marks this border as approximate.' : ''}
            </p>
            {panel.identity && <p className="certainty"><b>History:</b> {panel.identity.method === 'curated' ? 'This map entry was linked by hand to the encyclopedia record for this period.' : `Linked automatically by name and date (${Math.round(panel.identity.confidence * 100)}% match score). It may name a related entity.`}</p>}
            {!panel.identity && <p className="certainty"><b>History:</b> No encyclopedia record matched this map entry, so none is shown.</p>}
            <ul className="links refs">{panel.references.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noreferrer">{r.label}</a>{r.license && <small> {r.license}</small>}</li>)}</ul>
          </Section>
        </div>
      )}
    </aside>
  );
}
