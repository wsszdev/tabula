import { create } from 'zustand';
import type { MetaPayload, SearchHit, TerritoryPanel } from '@tabula/shared';
import { TIME_MAX_YEAR, TIME_MIN_YEAR } from '@tabula/shared';

export type LayerId = 'borders' | 'empire' | 'kingdom' | 'republic' | 'dependency' | 'culture' | 'polity' | 'labels' | 'capitals' | 'cities';
export type SourceMode = 'auto' | 'basemaps';
export type Sheet = null | 'layers' | 'moments' | 'settings' | 'about';

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  borders: true, empire: true, kingdom: true, republic: true, dependency: true, culture: true, polity: true, labels: true, capitals: true, cities: false,
};

interface State {
  year: number;
  playing: boolean;
  speed: number;
  meta: MetaPayload | null;
  layers: Record<LayerId, boolean>;
  sourceMode: SourceMode;
  sheet: Sheet;
  selection: { territoryId: number; entityId?: string; lon?: number; lat?: number; atYear?: number } | null;
  panel: TerritoryPanel | null;
  panelState: 'idle' | 'loading' | 'error' | 'absent';
  absent: { name: string; lastMapped: number | null; nextMapped: number | null; lon?: number; lat?: number } | null;
  flyTo: { bbox?: [number, number, number, number] | null; lon?: number | null; lat?: number | null; zoom?: number; seq: number } | null;
  dim: number;
  fuzzy: boolean;
  spin: boolean;
  setYear: (y: number) => void;
  stepYear: (d: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setMeta: (m: MetaPayload) => void;
  toggleLayer: (l: LayerId) => void;
  setSourceMode: (m: SourceMode) => void;
  setSheet: (s: Sheet) => void;
  select: (s: State['selection']) => void;
  applyHit: (h: SearchHit) => void;
  requestFly: (f: Omit<NonNullable<State['flyTo']>, 'seq'>) => void;
  setDim: (n: number) => void;
  setFuzzy: (b: boolean) => void;
  setSpin: (b: boolean) => void;
  setPanel: (p: Partial<Pick<State, 'panel' | 'panelState' | 'absent'>>) => void;
}

const clampYear = (y: number) => {
  const c = Math.min(Math.max(Math.round(y), TIME_MIN_YEAR), TIME_MAX_YEAR);
  return c === 0 ? 1 : c;
};

const readHash = () => new URLSearchParams(location.hash.slice(1));
const initialYear = () => {
  const y = Number(readHash().get('y'));
  return Number.isInteger(y) && y !== 0 && y >= TIME_MIN_YEAR && y <= TIME_MAX_YEAR ? y : 1453;
};

export const useStore = create<State>((set, get) => ({
  year: initialYear(),
  playing: false,
  speed: 10,
  meta: null,
  layers: DEFAULT_LAYERS,
  sourceMode: 'auto',
  sheet: null,
  selection: null,
  panel: null,
  panelState: 'idle',
  absent: null,
  flyTo: null,
  dim: 0.62,
  fuzzy: true,
  spin: false,
  setYear: (y) => set({ year: clampYear(y) }),
  stepYear: (d) => {
    const y = get().year;
    // Year zero does not exist: stepping across it goes from 1 BC to AD 1.
    let n = y + d;
    if (y < 0 && n >= 0) n += 1;
    else if (y > 0 && n <= 0) n -= 1;
    set({ year: clampYear(n) });
  },
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setMeta: (meta) => set({ meta }),
  toggleLayer: (l) => set((s) => ({ layers: { ...s.layers, [l]: !s.layers[l] } })),
  setSourceMode: (sourceMode) => set({ sourceMode }),
  setSheet: (sheet) => set((s) => ({ sheet: s.sheet === sheet ? null : sheet })),
  select: (selection) => set({ selection, ...(selection ? { sheet: null } : { panel: null, panelState: 'idle', absent: null }) }),
  applyHit: (h) => {
    const patch: Partial<State> = {};
    if (h.year != null) patch.year = clampYear(h.year);
    set(patch);
    if (h.territoryId) get().select({ territoryId: h.territoryId, lon: h.lon ?? undefined, lat: h.lat ?? undefined });
    if (h.bbox || h.lon != null) get().requestFly({ bbox: h.bbox, lon: h.lon, lat: h.lat, zoom: h.type === 'place' || h.type === 'event' ? 4.5 : undefined });
  },
  requestFly: (f) => set((s) => ({ flyTo: { ...f, seq: (s.flyTo?.seq ?? 0) + 1 } })),
  setDim: (dim) => set({ dim }),
  setFuzzy: (fuzzy) => set({ fuzzy }),
  setSpin: (spin) => set({ spin }),
  setPanel: (p) => set(p),
}));

export const PALETTE = ['#c8596a', '#dfa63a', '#4fa58e', '#4c6fc1', '#b96b42', '#8c6bb1', '#8a9a45', '#3e9cbf', '#a97f5a', '#d4778f'];

export function useIsMobile() {
  return window.matchMedia('(max-width: 760px)').matches;
}
