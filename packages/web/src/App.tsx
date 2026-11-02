import { useEffect } from 'react';
import { loadPanel } from './lib/loader.ts';
import { Globe } from './map/Globe.tsx';
import { useStore } from './lib/store.ts';
import { entityAtYear, loadMeta, warmIndex } from './lib/data.ts';
import { Timeline } from './ui/Timeline.tsx';
import { Search } from './ui/Search.tsx';
import { Rail, SheetHost } from './ui/Rail.tsx';
import { Panel } from './ui/Panel.tsx';

export function App() {
  const year = useStore((s) => s.year);
  const selection = useStore((s) => s.selection);
  const setMeta = useStore((s) => s.setMeta);
  const metaLoaded = useStore((s) => !!s.meta);
  const metaError = useStore((s) => s.panelState);

  useEffect(() => {
    loadMeta().then(setMeta).catch(() => useStore.setState({ panelState: 'error' }));
    warmIndex();
  }, [setMeta]);

  // Year is shareable; written without touching the camera part of the hash.
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    h.set('y', String(year));
    history.replaceState(null, '', '#' + h.toString());
    document.title = `${year < 0 ? `${-year} BC` : year} on TABULA`;
  }, [year]);

  // Panels always describe the selected date; a year change re-resolves the selection.
  useEffect(() => {
    if (!selection) return;
    const ctrl = new AbortController();
    const st = useStore.getState();
    const load = async () => {
      let territoryId: number | null = selection.territoryId;
      // Following an entity across years; a new selection (a search hit) is not the old panel's entity.
      const entityId = selection.entityId ?? (st.panel?.territoryId === selection.territoryId ? st.panel.entityId : undefined);
      st.setPanel({ panelState: 'loading' });
      // A fresh click already names the right territory for this year.
      if (entityId && selection.atYear !== year) {
        const at = await entityAtYear(entityId, year);
        if (ctrl.signal.aborted) return;
        if (at.territoryId == null) {
          st.setPanel({ panel: null, panelState: 'absent', absent: { name: st.panel?.name ?? 'This territory', lastMapped: at.lastMapped ?? null, nextMapped: at.nextMapped ?? null, lon: selection.lon, lat: selection.lat } });
          return;
        }
        territoryId = at.territoryId;
        if (territoryId !== selection.territoryId) useStore.setState({ selection: { ...selection, territoryId } });
      }
      const panel = await loadPanel(territoryId, year, ctrl.signal);
      st.setPanel({ panel, panelState: 'idle', absent: null });
    };
    const timer = setTimeout(() => load().catch((e) => { if (e.name !== 'AbortError') st.setPanel({ panelState: 'error' }); }), st.playing ? 250 : 40);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [selection?.territoryId, selection?.entityId, year]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.matches('input,textarea,select') || el.isContentEditable) return;
      const s = useStore.getState();
      if (e.key === 'ArrowRight') { s.stepYear(e.shiftKey ? 10 : 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { s.stepYear(e.shiftKey ? -10 : -1); e.preventDefault(); }
      else if (e.key === ' ' && el.tagName !== 'BUTTON') { s.setPlaying(!s.playing); e.preventDefault(); }
      else if (e.key === '/') { document.getElementById('search-input')?.focus(); e.preventDefault(); }
      else if (e.key === 'Escape') { s.select(null); useStore.setState({ sheet: null }); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <div className="stars" aria-hidden />
      <Globe />
      <Rail />
      <Search />
      <SheetHost />
      <Panel />
      <Timeline />
      {!metaLoaded && metaError === 'error' && (
        <div className="fatal" role="alert">The atlas data could not be loaded. Check your connection, then reload.</div>
      )}
    </div>
  );
}
