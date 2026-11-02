import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@tabula/shared';
import { useStore } from '../lib/store.ts';
import { search, warmSearch } from '../lib/data.ts';
import { IconSearch } from './icons.tsx';

const TYPE_NAME: Record<SearchHit['type'], string> = { entity: 'Place on the map', person: 'Ruler', place: 'City', event: 'Event', date: 'Date' };

export function Search() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [failed, setFailed] = useState(false);
  const applyHit = useStore((s) => s.applyHit);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setHits([]); setFailed(false); return; }
    let live = true;
    const t = setTimeout(() => {
      search(text)
        .then((r) => { if (live) { setHits(r); setCursor(0); setFailed(false); } })
        .catch(() => { if (live) setFailed(true); });
    }, 60);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, []);

  const choose = (h: SearchHit) => {
    applyHit(h);
    setOpen(false);
    setQ(h.title);
    (document.activeElement as HTMLElement)?.blur();
  };

  return (
    <div ref={box} className={`search ${open && q.length > 1 ? 'open' : ''}`} role="search">
      <div className="search-field">
        <IconSearch />
        <input
          id="search-input" value={q} placeholder="Search places, rulers, events, years" aria-label="Search history"
          autoComplete="off" spellCheck={false} enterKeyHint="search"
          onFocus={() => { setOpen(true); warmSearch(); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { setCursor((c) => Math.min(c + 1, hits.length - 1)); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { setCursor((c) => Math.max(c - 1, 0)); e.preventDefault(); }
            else if (e.key === 'Enter' && hits[cursor]) choose(hits[cursor]);
            else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLElement).blur(); }
          }}
        />
      </div>
      {open && q.trim().length > 1 && (
        <ul className="search-results" role="listbox" data-testid="search-results">
          {hits.map((h, i) => (
            <li key={`${h.type}:${h.id}`} role="option" aria-selected={i === cursor} className={i === cursor ? 'cur' : ''}
              onPointerEnter={() => setCursor(i)} onClick={() => choose(h)}>
              <span className="r-title">{h.title}</span>
              <span className="r-sub">{TYPE_NAME[h.type]}. {h.subtitle}</span>
            </li>
          ))}
          {!hits.length && !failed && <li className="r-empty">No match in the atlas. Try another spelling or a year such as 1453 or 44 BC.</li>}
          {failed && <li className="r-empty">The search index could not be loaded. Try again in a moment.</li>}
        </ul>
      )}
    </div>
  );
}
