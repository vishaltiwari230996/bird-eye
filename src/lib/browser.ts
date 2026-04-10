import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium, type Browser } from 'playwright-core';
import { log } from './logger';
import { existsSync } from 'fs';

let browserPromise: Promise<Browser> | null = null;
let browserUnavailable = false;

/**
 * Get a shared headless Chromium browser instance (Vercel-compatible).
 * Uses @sparticuz/chromium for the binary path in serverless.
 * Returns null if no browser binary is found (local dev without Chromium).
 */
export async function getBrowser(): Promise<Browser | null> {
  if (browserUnavailable) return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        const executablePath = await chromium.executablePath();
        if (!executablePath || !existsSync(executablePath)) {
          log.warn('Chromium binary not found, Playwright scraping disabled', { executablePath });
          browserUnavailable = true;
          return null as unknown as Browser;
        }
        log.info('Launching browser', { executablePath });
        return playwrightChromium.launch({
          args: chromium.args,
          executablePath,
          headless: true,
        });
      } catch (err) {
        log.warn('Failed to launch browser, Playwright scraping disabled', { error: String(err) });
        browserUnavailable = true;
        browserPromise = null;
        return null as unknown as Browser;
      }
    })();
  }
  return browserPromise;
}

/** Close the shared browser (used in graceful shutdown) */
export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close();
  }
}
