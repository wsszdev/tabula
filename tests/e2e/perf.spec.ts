import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { openAt, settle } from './helpers.ts';

const results: Record<string, unknown> = {};

// Measures under Playwright's software GL. Frame rates are a floor, not what a GPU achieves.
test('performance measurements', async ({ page, isMobile }, info) => {
  test.setTimeout(180_000);
  const t0 = Date.now();
  await page.goto('/#y=1914&c=10,30,1.8');
  await page.waitForFunction(() => (window as any).__map?.loaded());
  const firstReady = Date.now() - t0;
  await settle(page);
  const loaded = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), transferKB: Math.round(res.reduce((a, r) => a + r.transferSize, 0) / 1024), tileRequests: res.filter((r) => r.name.includes('.pmtiles')).length };
  });

  const fps = (ms: number) => page.evaluate((d) => new Promise<number>((res) => {
    let n = 0; const s = performance.now();
    const f = () => { n++; performance.now() - s < d ? requestAnimationFrame(f) : res(Math.round((n * 1000) / (performance.now() - s))); };
    requestAnimationFrame(f);
  }), ms);
  const idleFps = await fps(1500);
  const rotate = page.evaluate(() => { const m = (window as any).__map; m.easeTo({ center: [90, 30], duration: 2500, easing: (x: number) => x }); });
  const rotateFps = await fps(2400);
  await rotate; await settle(page);

  const transitions: Record<string, number> = {};
  for (const [label, y] of [['same set: 1914 to 1945', 1945], ['set change: 1945 to 1600', 1600], ['set change: 1600 to 1200', 1200]] as const) {
    const s = Date.now();
    await page.getByTestId('year').click();
    await page.getByLabel('Go to year').fill(String(y));
    await page.getByLabel('Go to year').press('Enter');
    await settle(page);
    transitions[label] = Date.now() - s - 700; // settle's fixed wait is not the transition
  }
  const playFps = await (async () => {
    await page.getByTestId('play').click();
    const v = await fps(3000);
    await page.getByTestId('play').click();
    return v;
  })();
  const mem = await page.evaluate(() => { const m = (performance as any).memory; return m ? Math.round(m.usedJSHeapSize / 1e6) : null; });
  results[info.project.name] = { firstReadyMs: firstReady, tilesLoadedMs: loaded, ...nav, idleFps, rotateFps, playFps, transitionsMs: transitions, jsHeapMB: mem, isMobile: !!isMobile };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/perf-${info.project.name}.json`, JSON.stringify(results[info.project.name], null, 2));
});
