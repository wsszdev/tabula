import type { TerritoryPanel } from '@tabula/shared';
import { territoryPanel } from './data.ts';

/** Low-priority fetches that never compete with what the visitor is looking at. */
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;
const MAX_RUNNING = 4;

export const canPreload = () => !(navigator as any).connection?.saveData && !/(^|-)2g$/.test((navigator as any).connection?.effectiveType ?? '');

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const url = queue.shift()!;
    running++;
    fetch(url, { priority: 'low' } as RequestInit)
      .then((r) => r.arrayBuffer())
      .catch(() => {})
      .finally(() => { running--; pump(); });
  }
}

export function preload(urls: string[], front = false) {
  if (!canPreload()) return;
  const fresh = urls.filter((u) => !queued.has(u));
  fresh.forEach((u) => queued.add(u));
  if (front) queue.unshift(...fresh);
  else queue.push(...fresh);
  pump();
}

/** Panels answered once stay instant, including their flag and portrait images. */
const panels = new Map<string, Promise<TerritoryPanel>>();
export function loadPanel(id: number, year: number, signal?: AbortSignal): Promise<TerritoryPanel> {
  const key = `${id}:${year}`;
  let p = panels.get(key);
  if (!p) {
    p = territoryPanel(id, year);
    p.then(preloadPanelImages).catch(() => panels.delete(key));
    panels.set(key, p);
    if (panels.size > 300) panels.delete(panels.keys().next().value!);
  }
  if (!signal) return p;
  return new Promise((res, rej) => {
    signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    p!.then(res, rej);
  });
}

function preloadPanelImages(p: TerritoryPanel) {
  if (!canPreload()) return;
  for (const url of [...p.flags, ...p.coats.slice(0, 2)].map((f) => f.image.url).concat(p.rulers.slice(0, 3).flatMap((r) => (r.portrait ? [r.portrait.url] : [])))) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
  }
}
