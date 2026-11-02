import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Service workers escape page-level throttling, so a truthful first visit blocks them.
test.use({ serviceWorkers: 'block' });

test('first visit on Fast 4G and on slow 4G, no caches', async ({ browser, baseURL }, info) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {};
  for (const [name, down, latency] of [['fast4g', 9, 60], ['slow4g', 1.6, 150]] as const) {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: (down * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8 });
    const t = Date.now();
    await page.goto('/#y=1914&c=10,30,1.8');
    await page.getByTestId('year').waitFor();
    const uiMs = Date.now() - t;
    await page.waitForFunction(() => { const m = (window as any).__map; return m?.loaded() && m.areTilesLoaded() && !m.isMoving(); }, null, { timeout: 120000, polling: 50 });
    out[name] = { uiMs, globeReadyMs: Date.now() - t, transferKB: await page.evaluate(() => Math.round((performance.getEntriesByType('resource') as PerformanceResourceTiming[]).reduce((a, r) => a + r.transferSize, 0) / 1024)) };
    await context.close();
  }
  console.log(JSON.stringify(out));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/first-visit-${info.project.name}.json`, JSON.stringify(out, null, 2));
});
