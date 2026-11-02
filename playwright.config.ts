import { defineConfig, devices } from '@playwright/test';

// PW_GL=metal measures on the real GPU (macOS); the default software GL runs anywhere.
const webgl = [`--use-angle=${process.env.PW_GL ?? 'swiftshader'}`, '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

export default defineConfig({
  testDir: 'tests/e2e', timeout: 90_000, expect: { timeout: 20_000 }, fullyParallel: false, workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { baseURL: 'http://127.0.0.1:4173', screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: { args: webgl } },
  // The static build, as GitHub Pages serves it. Run `npm run build` first.
  webServer: { command: 'npm run preview', url: 'http://127.0.0.1:4173/data/meta.json', reuseExistingServer: !process.env.CI, timeout: 60_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'laptop', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 720 } }, testMatch: /layout/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
