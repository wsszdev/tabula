import { expect, test } from '@playwright/test';
import { openAt, screenOf } from './helpers.ts';

const SHOT = process.env.SHOTS;

test('layout holds: nothing overlaps the primary controls or leaves the screen', async ({ page }, info) => {
  await openAt(page, 1789, '10,45,3');
  const vp = page.viewportSize()!;
  for (const sel of ['.timeline .ribbon', '.search', '.rail-nav', '[data-testid=year]']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.x, sel).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, sel).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height, sel).toBeLessThanOrEqual(vp.height);
  }
  const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  expect(scroll[0]).toBeLessThanOrEqual(scroll[1]!);
  if (SHOT) await page.screenshot({ path: `${SHOT}/${info.project.name}-globe.png` });
  const p = await screenOf(page, 2.5, 47);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('panel-name')).toBeVisible();
  const panel = (await page.getByTestId('panel').boundingBox())!;
  expect(panel.x + panel.width).toBeLessThanOrEqual(vp.width + 1);
  await page.waitForTimeout(800);
  if (SHOT) await page.screenshot({ path: `${SHOT}/${info.project.name}-panel.png` });
});

test.describe('touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile only');

  test('targets are at least 40px', async ({ page }) => {
    await openAt(page, 1900);
    for (const name of ['Play history', 'Next map change', 'Previous map change']) {
      const b = (await page.getByRole('button', { name }).boundingBox())!;
      expect(Math.min(b.width, b.height), name).toBeGreaterThanOrEqual(40);
    }
  });

  test('tap opens a bottom sheet that snaps', async ({ page }) => {
    await openAt(page, 1900, '10,51,3');
    const p = await screenOf(page, 10, 51);
    await page.touchscreen.tap(p.x, p.y);
    const panel = page.getByTestId('panel');
    await expect(page.getByTestId('panel-name')).toBeVisible();
    const vp = page.viewportSize()!;
    const half = (await panel.boundingBox())!;
    expect(half.width).toBe(vp.width);
    expect(half.y + half.height).toBeCloseTo(vp.height, 0);
    const g = (await panel.locator('.grip').boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + 10);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, 80, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect((await panel.boundingBox())!.height).toBeGreaterThan(half.height + 100);
  });

  test('pinch zooms the globe', async ({ page, context }) => {
    await openAt(page, 1900, '10,40,2');
    const before = await page.evaluate(() => (window as any).__map.getZoom());
    const client = await context.newCDPSession(page);
    const c = page.viewportSize()!;
    const cx = c.width / 2, cy = c.height / 2;
    const pts = (d: number) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }];
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) });
    for (let d = 50; d <= 130; d += 10) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
      await page.waitForTimeout(30);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any).__map.getZoom())).toBeGreaterThan(before + 0.3);
  });
});

test('globe is 3D and accepts drag and wheel', async ({ page, isMobile }) => {
  test.skip(!!isMobile);
  await openAt(page, 1900, '10,30,2');
  expect(await page.evaluate(() => (window as any).__map.getProjection().type)).toBe('globe');
  const before = await page.evaluate(() => (window as any).__map.getCenter().lng);
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (window as any).__map.getCenter().lng)).not.toBeCloseTo(before, 0);
  const z = await page.evaluate(() => (window as any).__map.getZoom());
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (window as any).__map.getZoom())).toBeGreaterThan(z);
});
