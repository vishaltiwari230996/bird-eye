import * as cheerio from 'cheerio';
import { getBrowser } from '@/lib/browser';
import { log } from '@/lib/logger';
import { politeDelay } from '@/lib/rate-limit';
import type {
  PlatformAdapter,
  Product,
  FetchResult,
  NormalizedPayload,
  ReviewSnippet,
} from './types';

// ─── Flipkart Affiliate API (optional) ──────────────────────────────

async function tryAffiliateApi(product: Product): Promise<NormalizedPayload | null> {
  const affiliateId = process.env.FLIPKART_AFFILIATE_ID;
  const affiliateToken = process.env.FLIPKART_AFFILIATE_TOKEN;
  if (!affiliateId || !affiliateToken) return null;

  try {
    const endpoint = `https://affiliate-api.flipkart.net/affiliate/1.0/product.json?id=${product.asin_or_sku}`;
    const resp = await fetch(endpoint, {
      headers: {
        'Fk-Affiliate-Id': affiliateId,
        'Fk-Affiliate-Token': affiliateToken,
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      log.warn('Flipkart affiliate API non-OK', { status: resp.status, platform: 'flipkart' });
      return null;
    }

    const data = await resp.json();
    const info = data?.productBaseInfoV1;
    if (!info) return null;

    const price =
      info.flipkartSellingPrice?.amount ??
      info.flipkartSpecialPrice?.amount ??
      info.maximumRetailPrice?.amount ??
      0;

    return {
      title: info.title ?? '',
      description: info.productDescription ?? '',
      price,
      currency: info.flipkartSellingPrice?.currency ?? 'INR',
      rating: info.attributes?.rating ? parseFloat(info.attributes.rating) : null,
      reviewCount: info.attributes?.reviewCount ? parseInt(info.attributes.reviewCount, 10) : null,
      lastReviewAt: null,
      reviews: [],
    };
  } catch (err) {
    log.warn('Flipkart affiliate API failed', { platform: 'flipkart', error: String(err) });
    return null;
  }
}

// ─── Selector strategies for scraping ────────────────────────────────

interface SelectorSet {
  title: string;
  price: string;
  rating: string;
  reviewCount: string;
  description: string;
  jsonLd: boolean;
}

const SELECTOR_STRATEGIES: SelectorSet[] = [
  {
    title: 'span.VU-ZEz',
    price: 'div.Nx9bqj.CxhGGd',
    rating: 'div.XQDdHH',
    reviewCount: 'span.Wphh3N span',
    description: 'div.yN\\+eNk',
    jsonLd: true,
  },
  {
    title: 'h1.yhB1nd span',
    price: 'div._30jeq3',
    rating: 'div._3LWZlK',
    reviewCount: 'span._2_R_DZ span',
    description: 'div._1mXcCf',
    jsonLd: false,
  },
  {
    title: 'h1 span, .B_NuCI',
    price: '._30jeq3, .Nx9bqj',
    rating: '._3LWZlK, .XQDdHH',
    reviewCount: '._2_R_DZ span, .Wphh3N span',
    description: '._1mXcCf, .yN\\+eNk',
    jsonLd: false,
  },
];

function extractJsonLd(html: string): Partial<NormalizedPayload> | null {
  try {
    const $ = cheerio.load(html);
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const raw = $(scripts[i]).html();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const product = Array.isArray(data) ? data.find((d: any) => d['@type'] === 'Product') : data;
      if (product?.['@type'] === 'Product') {
        return {
          title: product.name ?? '',
          description: product.description ?? '',
          price: product.offers?.price ? parseFloat(product.offers.price) : 0,
          currency: product.offers?.priceCurrency ?? 'INR',
          rating: product.aggregateRating?.ratingValue
            ? parseFloat(product.aggregateRating.ratingValue)
            : null,
          reviewCount: product.aggregateRating?.reviewCount
            ? parseInt(product.aggregateRating.reviewCount, 10)
            : null,
        };
      }
    }
  } catch {}
  return null;
}

function parseWithCheerio(
  html: string,
  selectors: SelectorSet,
): { payload: Partial<NormalizedPayload>; success: boolean } {
  const $ = cheerio.load(html);
  const title = $(selectors.title).first().text().trim();
  const priceRaw = $(selectors.price).first().text().trim();
  const ratingRaw = $(selectors.rating).first().text().trim();
  const rcRaw = $(selectors.reviewCount).first().text().trim();
  const desc = $(selectors.description).first().text().trim();

  const price = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
  const rating = parseFloat(ratingRaw) || null;

  // Flipkart review count format: "X Ratings & Y Reviews"
  const rcMatch = rcRaw.match(/([\d,]+)\s*Review/i);
  const reviewCount = rcMatch ? parseInt(rcMatch[1].replace(/,/g, ''), 10) : null;

  // Extract review snippets
  const reviews: ReviewSnippet[] = [];
  $('div.t-ZTKy div, div._6K-7Co div, [data-hook="review-body"]').each((i, el) => {
    if (i >= 5) return false;
    const text = $(el).text().trim();
    if (text.length > 20) {
      reviews.push({ id: `fk-review-${i}`, date: '', text: text.slice(0, 500) });
    }
  });

  const success = !!title && price > 0;
  return {
    payload: { title, description: desc, price, currency: 'INR', rating, reviewCount, reviews },
    success,
  };
}

// ─── Scrape with Playwright ──────────────────────────────────────────

async function scrapePlaywright(product: Product): Promise<{ html: string; durationMs: number } | null> {
  const browser = await getBrowser();
  if (!browser) return null;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'en-IN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const start = Date.now();

  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 10_000 });

    try {
      await page.waitForSelector('span.VU-ZEz, h1.yhB1nd', { timeout: 5_000 });
    } catch {
      try {
        await page.waitForSelector('h1', { timeout: 3_000 });
      } catch {
        // proceed
      }
    }

    const html = await page.content();
    return { html, durationMs: Date.now() - start };
  } finally {
    await context.close();
  }
}

// ─── Scrape with Cheerio (static) ────────────────────────────────────

async function scrapeStatic(product: Product): Promise<{ html: string; durationMs: number }> {
  const start = Date.now();
  const resp = await fetch(product.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    signal: AbortSignal.timeout(8_000),
  });
  const html = await resp.text();
  return { html, durationMs: Date.now() - start };
}

// ─── Adapter ─────────────────────────────────────────────────────────

export const flipkartAdapter: PlatformAdapter = {
  platform: 'flipkart',

  async fetch(product: Product): Promise<FetchResult> {
    const start = Date.now();

    // 1) Try affiliate API
    const apiResult = await tryAffiliateApi(product);
    if (apiResult) {
      return {
        payload: apiResult,
        strategy: 'api',
        fallbackLevel: 0,
        durationMs: Date.now() - start,
      };
    }

    // 2) Try static Cheerio
    try {
      await politeDelay();
      const { html, durationMs } = await scrapeStatic(product);

      const jsonLd = extractJsonLd(html);
      if (jsonLd?.title && (jsonLd.price ?? 0) > 0) {
        return {
          payload: {
            title: jsonLd.title ?? '',
            description: jsonLd.description ?? '',
            price: jsonLd.price ?? 0,
            currency: jsonLd.currency ?? 'INR',
            rating: jsonLd.rating ?? null,
            reviewCount: jsonLd.reviewCount ?? null,
            lastReviewAt: null,
            reviews: [],
          },
          strategy: 'cheerio',
          fallbackLevel: 0,
          durationMs,
        };
      }

      for (let i = 0; i < SELECTOR_STRATEGIES.length; i++) {
        const { payload, success } = parseWithCheerio(html, SELECTOR_STRATEGIES[i]);
        if (success) {
          return {
            payload: {
              title: payload.title ?? '',
              description: payload.description ?? '',
              price: payload.price ?? 0,
              currency: payload.currency ?? 'INR',
              rating: payload.rating ?? null,
              reviewCount: payload.reviewCount ?? null,
              lastReviewAt: null,
              reviews: payload.reviews ?? [],
            },
            strategy: 'cheerio',
            fallbackLevel: i,
            durationMs,
          };
        }
      }
    } catch (err) {
      log.warn('Static scrape failed for Flipkart, trying Playwright', {
        productId: product.id,
        error: String(err),
      });
    }

    // 3) Playwright fallback
    await politeDelay();
    const pwResult = await scrapePlaywright(product);

    if (pwResult) {
      const { html, durationMs } = pwResult;

      const jsonLd = extractJsonLd(html);
      if (jsonLd?.title && (jsonLd.price ?? 0) > 0) {
        return {
          payload: {
            title: jsonLd.title ?? '',
            description: jsonLd.description ?? '',
            price: jsonLd.price ?? 0,
            currency: jsonLd.currency ?? 'INR',
            rating: jsonLd.rating ?? null,
            reviewCount: jsonLd.reviewCount ?? null,
            lastReviewAt: null,
            reviews: [],
          },
          strategy: 'playwright',
          fallbackLevel: 0,
          durationMs,
        };
      }

      for (let i = 0; i < SELECTOR_STRATEGIES.length; i++) {
        const { payload, success } = parseWithCheerio(html, SELECTOR_STRATEGIES[i]);
        if (success) {
          return {
            payload: {
              title: payload.title ?? '',
              description: payload.description ?? '',
              price: payload.price ?? 0,
              currency: payload.currency ?? 'INR',
              rating: payload.rating ?? null,
              reviewCount: payload.reviewCount ?? null,
              lastReviewAt: null,
              reviews: payload.reviews ?? [],
            },
            strategy: 'playwright',
            fallbackLevel: i,
            durationMs,
          };
        }
      }
    }

    log.error('All strategies failed for Flipkart product', { productId: product.id });
    return {
      payload: {
        title: '',
        description: '',
        price: 0,
        currency: 'INR',
        rating: null,
        reviewCount: null,
        lastReviewAt: null,
        reviews: [],
      },
      strategy: 'playwright',
      fallbackLevel: SELECTOR_STRATEGIES.length,
      durationMs: Date.now() - start,
    };
  },
};
