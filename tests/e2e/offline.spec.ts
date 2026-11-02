import { expect, test } from '@playwright/test';
import { openAt } from './helpers.ts';

test('after one visit the atlas reopens with the network off', async ({ page, context, isMobile }) => {
  test.skip(!!isMobile);
  await openAt(page, 1914, '10,30,1.8');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => page.reload());
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForFunction(() => (window as any).__map?.loaded() && (window as any).__map.areTilesLoaded());
  await page.waitForTimeout(4000); // writes to the cache happen just after each response
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => { const m = (window as any).__map; return m?.loaded() && m.areTilesLoaded(); }, null, { timeout: 30000 });
  await expect(page.getByTestId('year')).toHaveText('1914');
  await expect(page.getByTestId('map-status')).toHaveText(/CShapes/);
  await context.setOffline(false);
});

test('flags and portraits really load from Wikimedia', async ({ page, isMobile }) => {
  test.skip(!!isMobile);
  await openAt(page, 1900, '10,51,4');
  const p = await page.evaluate(() => (window as any).__map.project([10, 51]));
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('panel-name')).toHaveText('German Empire');
  const flag = page.getByTestId('flag').first().locator('img');
  await expect(flag).toBeVisible();
  await expect.poll(() => flag.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);
  const portrait = page.getByTestId('ruler').first().locator('img');
  await expect.poll(() => portrait.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);
});
