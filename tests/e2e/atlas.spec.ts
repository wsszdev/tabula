import { expect, test } from '@playwright/test';
import { openAt, renderedNames, screenOf, settle } from './helpers.ts';

const yearText = (page: any) => page.getByTestId('year');

test.describe('borders and time', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop flow');

  test('changing the year changes what is on the globe', async ({ page }) => {
    await openAt(page, 1980, '15,50,3');
    const y1980 = await renderedNames(page);
    expect(y1980).toContain('German Federal Republic');
    await page.getByTestId('year').click();
    await page.getByLabel('Go to year').fill('1910');
    await page.getByLabel('Go to year').press('Enter');
    await settle(page);
    await expect.poll(async () => (await renderedNames(page)).includes('Austria-Hungary')).toBe(true);
    const y1910 = await renderedNames(page);
    expect(y1910.some((n) => n.startsWith('Germany'))).toBe(true);
    expect(y1910).toContain('Austria-Hungary');
    expect(y1910).not.toContain('German Federal Republic');
  });

  test('before 1886 a Historical Basemaps snapshot takes over, and says so', async ({ page }) => {
    await openAt(page, 1500, '20,40,2.5');
    await expect(page.getByTestId('map-status')).toHaveText(/Map of 1500, shown until 1530/);
    await page.keyboard.press('ArrowRight');
    await expect(yearText(page)).toHaveText('1501');
    await page.getByLabel('Next map change').click();
    await expect(yearText(page)).toHaveText('1530');
    await settle(page);
    await expect.poll(async () => (await renderedNames(page)).length).toBeGreaterThan(5);
  });

  test('BC years cross into AD without a year zero', async ({ page }) => {
    await openAt(page, -1);
    await expect(yearText(page)).toHaveText(/1\s*BC/);
    await page.keyboard.press('ArrowRight');
    await expect(yearText(page)).toHaveText('1');
  });

  test('playback advances, pauses and stays smooth with panel open', async ({ page }) => {
    await openAt(page, 1900);
    await page.getByRole('radio', { name: 'Fast', exact: true }).click();
    await page.getByTestId('play').click();
    await page.waitForTimeout(1500);
    await page.getByTestId('play').click();
    const stopped = Number(await yearText(page).innerText());
    expect(stopped).toBeGreaterThan(1905);
    await page.waitForTimeout(500);
    expect(Number(await yearText(page).innerText())).toBe(stopped);
  });

  test('dragging the ribbon selects a year', async ({ page }) => {
    await openAt(page, 1000);
    const box = (await page.getByTestId('ribbon').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.9, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.95, box.y + 10, { steps: 4 });
    await page.mouse.up();
    expect(Number(await yearText(page).innerText())).toBeGreaterThan(1800);
  });
});

test.describe('territory panel', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop flow');

  test('clicking a territory opens it, and it follows the date', async ({ page }) => {
    await openAt(page, 1900, '10,51,4');
    const p = await screenOf(page, 10, 51);
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId('panel-name')).toHaveText('German Empire');
    await expect(page.getByTestId('panel')).toContainText('Wilhelm');
    await expect(page.getByTestId('panel')).toContainText('CShapes 2.0');
    await page.getByTestId('year').click();
    await page.getByLabel('Go to year').fill('1925');
    await page.getByLabel('Go to year').press('Enter');
    await expect(page.getByTestId('panel-name')).toHaveText('Weimar Republic');
    await expect(page.getByTestId('panel')).not.toContainText('Wilhelm II');
  });

  test('France in 1789 is the Kingdom of France, without the tricolour', async ({ page }) => {
    await openAt(page, 1789, '2.5,47,4');
    const p = await screenOf(page, 2.5, 47);
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId('panel-name')).toHaveText('Kingdom of France');
    const flags = await page.getByTestId('flag').locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    for (const src of flags) expect(decodeURIComponent(src)).not.toMatch(/Flag_of_France\.svg/);
  });

  test('a vanished state offers the way out', async ({ page }) => {
    await openAt(page, 1980, '13,52,4');
    const p = await screenOf(page, 13, 52);
    await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId('panel-name')).toBeVisible();
    await page.getByTestId('year').click();
    await page.getByLabel('Go to year').fill('2005');
    await page.getByLabel('Go to year').press('Enter');
    await expect(page.getByTestId('panel-absent')).toContainText('Not on the map in 2005');
    await page.getByRole('button', { name: /Show what was here/ }).click();
    await expect(page.getByTestId('panel-name')).toBeVisible();
    await expect(page.getByTestId('panel-name')).toHaveText(/Germany/);
  });
});

test.describe('search', () => {
  test('Roman Empire: finds it, flies there, picks a period and opens it', async ({ page }) => {
    await openAt(page, 1900);
    await page.locator('#search-input').fill('Roman Empire');
    await expect(page.getByTestId('search-results').locator('li').first()).toContainText('Roman Empire');
    await page.getByTestId('search-results').locator('li').first().click();
    await expect(page.getByTestId('panel-name')).toHaveText(/Roman Empire/);
    const year = Number((await yearText(page).innerText()).replace(/\D/g, ''));
    expect(year).toBeLessThan(500);
    await page.waitForFunction(() => { const c = (window as any).__map.getCenter(); return c.lng > -10 && c.lng < 50 && c.lat > -25 && c.lat < 60 && !(window as any).__map.isMoving(); }, null, { timeout: 15000 });
  });
  test('typing a year goes there', async ({ page }) => {
    await openAt(page, 1900);
    await page.locator('#search-input').fill('44 BC');
    await expect(page.getByTestId('search-results').locator('li').first()).toContainText('Go to this year');
    await page.getByTestId('search-results').locator('li').first().click();
    await expect(yearText(page)).toHaveText(/44\s*BC/);
  });
  test('an unknown term explains itself', async ({ page }) => {
    await openAt(page, 1900);
    await page.locator('#search-input').fill('zzqxqzz');
    await expect(page.getByTestId('search-results')).toContainText('No match in the atlas');
  });
});

test.describe('layers, events, settings', () => {
  test('layers filter the map', async ({ page }) => {
    await openAt(page, 1914, '10,10,1.6');
    await page.getByTestId('rail-layers').click();
    const before = (await renderedNames(page)).length;
    await page.getByTestId('layer-dependency').uncheck({ force: true });
    await page.getByTestId('layer-polity').uncheck({ force: true });
    await page.getByTestId('layer-republic').uncheck({ force: true });
    await settle(page);
    expect((await renderedNames(page)).length).toBeLessThan(before);
  });
  test('events jump the timeline', async ({ page }) => {
    await openAt(page, 1400);
    await page.getByTestId('rail-moments').click();
    const first = page.getByTestId('moments').locator('button').first();
    await expect(first).toBeVisible();
    const wanted = (await first.locator('.m-year').innerText()).replace(/\s/g, '');
    await first.click();
    expect((await yearText(page).innerText()).replace(/\s/g, '')).toBe(wanted);
  });
  test('source can be switched to Historical Basemaps for modern years', async ({ page }) => {
    await openAt(page, 1920);
    await expect(page.getByTestId('map-status')).toHaveText(/CShapes/);
    await page.getByTestId('rail-settings').click();
    await page.getByTestId('source-basemaps').check();
    await expect(page.getByTestId('map-status')).toHaveText(/Map of 1920/);
  });
});
