import { useEffect, useMemo, useRef, useState } from 'react';
import { CSHAPES_START_T, TIME_BANDS, astroToYear, formatT, formatYear, parseYear, posToYear, setForT, yearToPos, yearToT } from '@tabula/shared';
import { useStore } from '../lib/store.ts';
import { IconNext, IconPause, IconPlay, IconPrev } from './icons.tsx';

const SPEEDS = [1, 10, 50, 250];

/** Rate matches the time scale: deep prehistory moves in thousands, the modern era in years. */
function playRate(year: number, speed: number): number {
  if (year < -3000) return speed * 40;
  if (year < 1500) return speed * 4;
  return speed;
}

export function Timeline() {
  const year = useStore((s) => s.year);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const meta = useStore((s) => s.meta);
  const sourceMode = useStore((s) => s.sourceMode);
  const setYear = useStore((s) => s.setYear);
  const setPlaying = useStore((s) => s.setPlaying);
  const setSpeed = useStore((s) => s.setSpeed);
  const ribbon = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), acc = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = useStore.getState();
      acc += ((now - last) / 1000) * playRate(s.year, s.speed);
      last = now;
      const whole = Math.floor(acc);
      if (whole >= 1) {
        acc -= whole;
        s.stepYear(whole);
        if (useStore.getState().year >= 2019) s.setPlaying(false);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const dragging = useRef(false);
  const fromEvent = (e: React.PointerEvent) => {
    const r = ribbon.current!.getBoundingClientRect();
    return posToYear((e.clientX - r.left) / r.width);
  };

  const snapshots = useMemo(() => (meta?.sets ?? []).filter((s) => s.dataset === 'basemaps' && s.year != null).map((s) => s.year as number), [meta]);
  const set = meta ? setForT(meta.sets as any, yearToT(year), sourceMode === 'basemaps' ? 'basemaps' : undefined) as any : null;

  const status = !set ? 'Loading the map' : set.dataset === 'cshapes'
    ? 'Dated borders from CShapes'
    : `Map of ${formatYear(set.year)}, shown until ${formatT(set.to)}`;

  const stops = useMemo(() => [...new Set([...snapshots, ...(meta ? [1886] : [])])].sort((a, b) => a - b), [snapshots, meta]);
  const jump = (dir: 1 | -1) => {
    const next = dir > 0 ? stops.find((s) => s > year) : [...stops].reverse().find((s) => s < year);
    if (next != null) setYear(next);
  };

  const pos = yearToPos(year) * 100;
  const dated = yearToPos(astroToYear(CSHAPES_START_T)) * 100;

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-year">
        {editing ? (
          <input
            className="year-input" autoFocus aria-label="Go to year" defaultValue={formatYear(year)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter') {
                const y = parseYear((e.target as HTMLInputElement).value);
                if (y != null) setYear(y);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button className="year-num" data-testid="year" onClick={() => setEditing(true)} title="Type a year" aria-label={`Year ${formatYear(year)}. Select to type a year.`}>
            {Math.abs(year)}{year < 0 && <span className="bc">BC</span>}
          </button>
        )}
        <p className="tl-status" data-testid="map-status">{status}</p>
      </div>

      <div className="tl-main">
        <div className="tl-controls">
          <button className="ico" onClick={() => jump(-1)} aria-label="Previous map change"><IconPrev /></button>
          <button className="ico play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play history'} data-testid="play">
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="ico" onClick={() => jump(1)} aria-label="Next map change"><IconNext /></button>
          <div className="speeds" role="radiogroup" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} role="radio" aria-checked={speed === s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s === 1 ? 'Slow' : s === 10 ? 'Steady' : s === 50 ? 'Fast' : 'Faster'}
              </button>
            ))}
          </div>
        </div>
        <div
          ref={ribbon} className="ribbon" data-testid="ribbon"
          role="slider" tabIndex={0} aria-label="Year" aria-valuemin={-123000} aria-valuemax={2019} aria-valuenow={year} aria-valuetext={formatYear(year)}
          onPointerDown={(e) => { dragging.current = true; ribbon.current!.setPointerCapture(e.pointerId); setPlaying(false); setYear(fromEvent(e)); }}
          onPointerMove={(e) => { if (dragging.current) setYear(fromEvent(e)); }}
          onPointerUp={() => { dragging.current = false; }}
          onPointerCancel={() => { dragging.current = false; }}
        >
          <div className="rail" />
          <div className="dated-band" style={{ left: `${dated}%`, right: 0 }} title="Dated borders: CShapes, 1886 to 2019" />
          {snapshots.map((s) => <i key={s} className="snap" style={{ left: `${yearToPos(s) * 100}%` }} />)}
          {TIME_BANDS.slice(1).map((b) => (
            <span key={b.from} className="band-label" style={{ left: `${yearToPos(b.from) * 100}%` }}>{formatYear(b.from)}</span>
          ))}
          <div className="handle" style={{ left: `${pos}%` }} />
        </div>
      </div>
    </section>
  );
}
