import type { Page } from '@playwright/test';

export async function openAt(page: Page, year: number, cam = '20,30,2.2') {
  await page.goto(`/#y=${year}&c=${cam}`);
  await page.waitForFunction(() => { const m = (window as any).__map; return m && m.loaded() && m.getSource('terr-a'); }, null, { timeout: 45000 });
  await settle(page);
}

export async function settle(page: Page) {
  await page.waitForFunction(() => { const m = (window as any).__map; return m.areTilesLoaded() && !m.isMoving(); }, null, { timeout: 30000 });
  await page.waitForTimeout(700);
}

/** Names drawn on the globe right now, sampled from the renderer on a grid (not from the DOM). */
export const renderedNames = (page: Page) => page.evaluate(() => {
  const m = (window as any).__map;
  const layers = ['wash-a', 'wash-b'].filter((l) => m.getPaintProperty(l, 'fill-opacity') > 0);
  const out = new Set<string>();
  if (!layers.length) return [];
  for (let x = 20; x < innerWidth; x += 20) for (let y = 20; y < innerHeight; y += 20) {
    for (const f of m.queryRenderedFeatures([x, y], { layers })) out.add(f.properties.n);
  }
  return [...out] as string[];
});

/** Screen position of a lon/lat, to click on a real polygon. */
export const screenOf = (page: Page, lon: number, lat: number) => page.evaluate(([x, y]) => (window as any).__map.project([x, y]), [lon, lat]);
