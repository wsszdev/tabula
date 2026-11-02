import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Repeat visits and era changes with the service worker active. Its requests escape throttling: see first-visit.spec.ts for network truth.
test('loading on a throttled connection', async ({ page, context }, info) => {
  test.setTimeout(240_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (2 * 1024 * 1024) / 8 });
  const ready = () => page.waitForFunction(() => { const m = (window as any).__map; return m?.loaded() && m.areTilesLoaded() && !m.isMoving(); }, null, { timeout: 120000, polling: 50 });
  const visit = async () => {
    await page.goto('about:blank');
    const t = Date.now();
    await page.goto('/#y=1914&c=10,30,1.8');
    await ready();
    return Date.now() - t;
  };
  const cold = await visit();
  const imagery = await page.evaluate(() => {
    const r = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((x) => /gibs|imagery/.test(x.name));
    return { n: r.length, avgMs: Math.round(r.reduce((a, x) => a + x.duration, 0) / (r.length || 1)), maxMs: Math.round(Math.max(0, ...r.map((x) => x.duration))) };
  });
  await page.waitForTimeout(3000); // lets background caching run, as it would for a visitor reading the map
  const warm = await visit();
  const era: Record<string, number> = {};
  await page.evaluate(() => { (window as any).__eraShownMs = null; });
  for (const y of [1600, 1650, 1200]) {
    await page.waitForTimeout(1500);
    const t = Date.now();
    await page.getByTestId('year').click();
    await page.getByLabel('Go to year').fill(String(y));
    await page.getByLabel('Go to year').press('Enter');
    await page.waitForFunction(() => (window as any).__eraShownMs != null);
    era[String(y)] = await page.evaluate(() => { const v = (window as any).__eraShownMs; (window as any).__eraShownMs = null; return v; });
    await ready();
  }
  // Zooming into a region for the first time is what visitors see most of imagery latency in.
  await page.waitForTimeout(1500);
  const zoomStart = Date.now();
  await page.evaluate(() => (window as any).__map.jumpTo({ center: [30, 40], zoom: 5 }));
  await ready();
  const zoomMs = Date.now() - zoomStart;
  const out = { zoomMs, coldMs: cold, warmMs: warm, imagery, eraChangeMs: era };
  console.log(JSON.stringify(out));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/load-${info.project.name}.json`, JSON.stringify(out, null, 2));
});
