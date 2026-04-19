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
  OfferInfo,
  SeoInfo,
} from './types';

// ─── Amazon PAAPI5 (optional) ───────────────────────────────────────

async function tryPaapi(product: Product): Promise<NormalizedPayload | null> {
  const accessKey = process.env.AMAZON_ACCESS_KEY;
  const secretKey = process.env.AMAZON_SECRET_KEY;
  const partnerTag = process.env.AMAZON_PARTNER_TAG;
  if (!accessKey || !secretKey || !partnerTag) return null;

  try {
    // PAAPI5 GetItems request
    const host = process.env.AMAZON_MARKETPLACE || 'www.amazon.in';
    const region = host.includes('.in') ? 'eu-west-1' : 'us-east-1';
    const endpoint = `https://webservices.${host}/paapi5/getitems`;

    const body = JSON.stringify({
      ItemIds: [product.asin_or_sku],
      PartnerTag: partnerTag,
      PartnerType: 'Associates',
      Resources: [
        'ItemInfo.Title',
        'ItemInfo.Features',
        'Offers.Listings.Price',
        'CustomerReviews.Count',
        'CustomerReviews.StarRating',
      ],
    });

    // AWS Sig v4 signing — simplified (production should use a proper signer)
    const { createHmac, createHash } = await import('crypto');
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const credentialScope = `${dateStamp}/${region}/ProductAdvertisingAPI/aws4_request`;

    const headers: Record<string, string> = {
      'host': new URL(endpoint).host,
      'content-type': 'application/json; charset=UTF-8',
      'x-amz-date': amzDate,
      'x-amz-target': 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems',
      'content-encoding': 'amz-1.0',
    };

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join('');

    const payloadHash = createHash('sha256').update(body).digest('hex');
    const canonicalRequest = [
      'POST',
      '/paapi5/getitems',
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const sign = (key: Buffer | string, msg: string) =>
      createHmac('sha256', key).update(msg).digest();
    let signingKey = sign(`AWS4${secretKey}`, dateStamp);
    signingKey = sign(signingKey, region);
    signingKey = sign(signingKey, 'ProductAdvertisingAPI');
    signingKey = sign(signingKey, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers[
      'authorization'
    ] = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const resp = await fetch(endpoint, { method: 'POST', headers, body });
    if (!resp.ok) {
      log.warn('PAAPI5 returned non-OK', { platform: 'amazon', status: resp.status });
      return null;
    }

    const data = await resp.json();
    const item = data?.ItemsResult?.Items?.[0];
    if (!item) return null;

    return {
      title: item.ItemInfo?.Title?.DisplayValue ?? '',
      description: (item.ItemInfo?.Features?.DisplayValues ?? []).join(' '),
      price: item.Offers?.Listings?.[0]?.Price?.Amount ?? 0,
      currency: item.Offers?.Listings?.[0]?.Price?.Currency ?? 'INR',
      rating: item.CustomerReviews?.StarRating?.Value ?? null,
      reviewCount: item.CustomerReviews?.Count ?? null,
      lastReviewAt: null,
      reviews: [],
    };
  } catch (err) {
    log.warn('PAAPI5 fetch failed', { platform: 'amazon', error: String(err) });
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
    title: '#productTitle',
    price: '.a-price .a-offscreen',
    rating: '#acrPopover .a-icon-alt',
    reviewCount: '#acrCustomerReviewText',
    description: '#feature-bullets ul',
    jsonLd: true,
  },
  {
    title: 'h1#title span',
    price: '#priceblock_ourprice, #priceblock_dealprice, .a-price-whole',
    rating: '.a-icon-star-small .a-icon-alt',
    reviewCount: '#acrCustomerReviewLink #acrCustomerReviewText',
    description: '#productDescription',
    jsonLd: false,
  },
  {
    title: 'h1 span.a-text-normal',
    price: '.a-price .a-offscreen, .a-color-price',
    rating: 'i.a-icon-star span.a-icon-alt',
    reviewCount: 'span[data-hook="total-review-count"]',
    description: '#feature-bullets',
    jsonLd: false,
  },
];

function parseCountText(raw: string): number | null {
  const text = (raw || '').trim();
  if (!text) return null;

  const ratingsMatch = text.match(/([\d,]+)\s*(?:global\s+)?ratings?/i);
  if (ratingsMatch?.[1]) {
    const n = parseInt(ratingsMatch[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  const reviewsMatch = text.match(/([\d,]+)\s*reviews?/i);
  if (reviewsMatch?.[1]) {
    const n = parseInt(reviewsMatch[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  // Last-resort fallback for formats like "(25)"
  const generic = text.match(/([\d,]+)/);
  if (generic?.[1] && /rating|review|\(\d/.test(text.toLowerCase())) {
    const n = parseInt(generic[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function extractPrimaryAmazonReviewCount($: cheerio.CheerioAPI): number | null {
  const strictSelectors = [
    '#acrCustomerReviewText',
    '#acrCustomerReviewLink #acrCustomerReviewText',
    '#averageCustomerReviews #acrCustomerReviewText',
    '#reviews-medley-footer .a-text-bold',
    '[data-hook="total-review-count"]',
  ];

  for (const selector of strictSelectors) {
    const txt = $(selector).first().text().trim();
    const count = parseCountText(txt);
    if (count != null) return count;
  }

  const blockedAncestors =
    '#desktop-dp-sims_session-similarities, #sims-consolidated-2_feature_div, #sp_detail, #bundleV2_feature_div, #p13n-desktop-sims-fbt, #similarities_feature_div, #purchase-sims-feature, #unifiedLocation1_feature_div';

  const candidates: number[] = [];
  $('#ppd #acrCustomerReviewText, #centerCol #acrCustomerReviewText, #ppd [data-hook="total-review-count"], #centerCol [data-hook="total-review-count"]').each((_i, el) => {
    const node = $(el);
    if (node.closest(blockedAncestors).length > 0) return;
    const c = parseCountText(node.text());
    if (c != null) candidates.push(c);
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b - a);
  return candidates[0];
}

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
            ? parseCountText(String(product.aggregateRating.reviewCount))
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
  let priceRaw = extractPrimaryAmazonPrice($) || $(selectors.price).first().text().trim();
  // Fallback: if .a-offscreen is empty, try .a-price-whole
  if (!priceRaw) {
    priceRaw =
      $('#corePriceDisplay_desktop_feature_div .a-price-whole, #corePrice_feature_div .a-price-whole, #ppd .a-price-whole')
        .first()
        .text()
        .trim() || $('.a-price-whole').first().text().trim();
  }
  const ratingRaw = $(selectors.rating).first().text().trim();
  const desc = $(selectors.description).first().text().trim();

  const price = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
  const rating = parseFloat(ratingRaw) || null;
  const selectorCount = parseCountText($(selectors.reviewCount).first().text().trim());
  const reviewCount = extractPrimaryAmazonReviewCount($) ?? selectorCount ?? null;

  // Extract review snippets from the page
  const reviews: ReviewSnippet[] = [];
  $('[data-hook="review"]').each((i, el) => {
    if (i >= 5) return false; // limit to 5
    const id = $(el).attr('id') || `review-${i}`;
    const date = $(el).find('[data-hook="review-date"]').text().trim();
    const text = $(el).find('[data-hook="review-body"] span').first().text().trim();
    if (text) reviews.push({ id, date, text });
  });

  // Extract offer / deal information
  const offers = extractOffers($);

  // Extract SEO information
  const seo = extractSeo($, html);

  const success = !!title && price > 0;
  return {
    payload: { title, description: desc, price, currency: 'INR', rating, reviewCount, reviews, offers, seo },
    success,
  };
}

function parsePriceValue(raw: string): number | null {
  if (!raw) return null;
  const value = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Extract the main PDP price and avoid unrelated sections like FBT/recommendations.
 */
function extractPrimaryAmazonPrice($: cheerio.CheerioAPI): string {
  const strictSelectors = [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePrice_desktop .a-price .a-offscreen',
    '#apex_desktop .a-price .a-offscreen',
    '#tp_price_block_total_price_ww .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '#price_inside_buybox',
  ];

  for (const selector of strictSelectors) {
    const text = $(selector).first().text().trim();
    if (parsePriceValue(text)) return text;
  }

  const blockedAncestors =
    '#desktop-dp-sims_session-similarities, #sims-consolidated-2_feature_div, #sp_detail, #bundleV2_feature_div, #p13n-desktop-sims-fbt, #similarities_feature_div, #purchase-sims-feature, #unifiedLocation1_feature_div';

  const candidates: Array<{ text: string; score: number }> = [];

  $('.a-price .a-offscreen, .a-color-price').each((_i, el) => {
    const node = $(el);
    if (node.closest(blockedAncestors).length > 0) return;

    const priceSpan = node.closest('span.a-price');
    if (priceSpan.attr('data-a-strike') === 'true') return;
    if (priceSpan.hasClass('a-text-price') || node.closest('.a-text-price').length > 0) return;

    const text = node.text().trim();
    const parsed = parsePriceValue(text);
    if (!parsed) return;

    let score = 10;
    if (node.closest('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #corePrice_desktop').length > 0) score = 100;
    else if (node.closest('#apex_desktop, #tp_price_block_total_price_ww').length > 0) score = 80;
    else if (node.closest('#ppd, #centerCol').length > 0) score = 50;

    candidates.push({ text, score });
  });

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }
  return '';
}

/** Extract offers, deals, coupons, bank offers, seller info from Amazon product page */
function extractOffers($: cheerio.CheerioAPI): OfferInfo {
  // MRP (struck-through price) — be careful to only grab the *strikethrough* price, never the sale price
  let mrp: number | null = null;
  // Try data-a-strike first (reliable indicator of MRP)
  const strikeEl = $('span.a-price[data-a-strike="true"] .a-offscreen').first().text().trim();
  if (strikeEl) {
    mrp = parseFloat(strikeEl.replace(/[^0-9.]/g, '')) || null;
  }
  // Fallback: .a-text-price (the grey crossed-out price next to the selling price)
  if (!mrp) {
    const altMrp = $('span.a-text-price:not(.a-size-base) .a-offscreen').first().text().trim();
    if (altMrp) mrp = parseFloat(altMrp.replace(/[^0-9.]/g, '')) || null;
  }
  // Fallback: classic selector
  if (!mrp) {
    const classic = $('.priceBlockStrikePriceString, .priceBlockSavingsString').first().text().trim();
    if (classic) mrp = parseFloat(classic.replace(/[^0-9.]/g, '')) || null;
  }

  // Discount percentage
  const discountPct = $('.savingsPercentage, .reinventPriceSavingsPercentageMargin').first().text().trim() || null;

  // Deal badge (Lightning Deal, Deal of the Day, etc.)
  const dealBadge = $('#dealBadge_feature_div .a-badge-text, #deal_feature_div .a-text-bold').first().text().trim() || null;

  // Coupon
  const coupon = $('#couponText, .couponBadge, #vpcButton .a-color-success, #couponTextpct498').first().text().trim() || null;

  // Bank offers
  const bankOffers: string[] = [];
  $('#sopp_feature_div .a-truncate-full, .offers-items .a-truncate-full').each((_i, el) => {
    const txt = $(el).text().trim();
    if (txt && bankOffers.length < 5) bankOffers.push(txt);
  });

  // Availability
  const availability = $('#availability span').first().text().trim() || null;

  // Seller
  const seller = $('#sellerProfileTriggerId, #merchant-info a, #tabular-buybox .tabular-buybox-text a').first().text().trim() || null;

  // Best Seller Rank
  const bsr = $('#SalesRank, #detailBulletsWrapper_feature_div li:contains("Best Sellers")').first().text().trim().replace(/\s+/g, ' ') || null;

  // Sanity check: MRP should be >= selling price (if we have both)
  // We don't have price here, but if MRP < 100 that's suspicious for books
  return { mrp, discountPct, dealBadge, coupon, bankOffers, availability, seller, bestSellerRank: bsr };
}

/** Extract SEO-relevant data from Amazon product page */
function extractSeo($: cheerio.CheerioAPI, html: string): SeoInfo {
  const normalizeBullet = (txt: string): string => txt.replace(/\s+/g, ' ').trim();

  const isUsefulBullet = (txt: string): boolean => {
    const t = txt.toLowerCase();
    if (!t) return false;
    if (t.includes('make sure this fits')) return false;
    if (t.includes('report an issue with this product')) return false;
    if (t.includes('would you like to tell us about a lower price')) return false;
    if (t.length < 12) return false;
    return true;
  };

  const deriveBulletsFromText = (text: string): string[] => {
    if (!text) return [];
    const chunks = text
      .split(/[\n\r•]+/)
      .map(normalizeBullet)
      .filter((x) => x.length >= 14 && x.length <= 260);

    if (chunks.length >= 2) {
      return chunks.filter(isUsefulBullet).slice(0, 10);
    }

    // Last fallback: split long paragraph by sentence boundaries.
    return text
      .split(/\.(?:\s+|$)/)
      .map(normalizeBullet)
      .filter((x) => x.length >= 20 && x.length <= 220)
      .filter(isUsefulBullet)
      .slice(0, 8);
  };

  // Meta title
  const metaTitle = $('title').first().text().trim() || null;

  // Meta description
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;

  // Bullet points (feature list)
  const bullets: string[] = [];

  const bulletSelectors = [
    '#feature-bullets ul li span.a-list-item',
    '#feature-bullets ul li',
    '#featurebullets_feature_div ul li span.a-list-item',
    '#featurebullets_feature_div ul li',
    '#bookDescription_feature_div li',
    '#bookDescription_feature_div .a-expander-content',
    '#productDescription li',
    '#productDescription_feature_div li',
    '#detailBullets_feature_div li span.a-list-item',
    '#detailBulletsWrapper_feature_div li span.a-list-item',
  ];

  for (const selector of bulletSelectors) {
    $(selector).each((_i, el) => {
      if (bullets.length >= 12) return false;
      const txt = normalizeBullet($(el).text());
      if (isUsefulBullet(txt)) bullets.push(txt);
    });
    if (bullets.length >= 5) break;
  }

  if (bullets.length === 0) {
    const descriptionBlob = normalizeBullet(
      $('#bookDescription_feature_div, #productDescription_feature_div, #productDescription').text(),
    );
    bullets.push(...deriveBulletsFromText(descriptionBlob));
  }

  // Deduplicate (nested spans can duplicate text)
  const uniqueBullets = [...new Set(bullets)];

  // Image count — product image thumbnails
  let imageCount = 0;
  const imgThumbs = $('#altImages .a-spacing-small.item, #altImages li.a-spacing-small');
  if (imgThumbs.length > 0) {
    imageCount = imgThumbs.length;
  } else {
    // Fallback: count from imageBlock data
    const imgBlock = html.match(/"colorImages"\s*:\s*\{[^}]*"initial"\s*:\s*\[([^\]]*)\]/);
    if (imgBlock) {
      imageCount = (imgBlock[1].match(/"hiRes"/g) || []).length;
    }
  }

  // A+ Content detection
  const hasAPlus = $('#aplus_feature_div, #aplus, #aplusProductDescription, .aplus-module').length > 0;

  // Category breadcrumb
  const categoryParts: string[] = [];
  $('#wayfinding-breadcrumbs_feature_div ul li a, .a-breadcrumb li a').each((_i, el) => {
    const txt = $(el).text().trim();
    if (txt) categoryParts.push(txt);
  });
  const categoryPath = categoryParts.length > 0 ? categoryParts.join(' > ') : null;

  // Answered questions count
  let questionCount: number | null = null;
  const qaText = $('#askATFLink span').first().text().trim();
  if (qaText) {
    const match = qaText.match(/(\d+)/);
    if (match) questionCount = parseInt(match[1], 10);
  }

  return {
    metaTitle,
    metaDescription,
    bulletCount: uniqueBullets.length,
    bullets: uniqueBullets,
    imageCount,
    hasAPlus,
    categoryPath,
    questionCount,
  };
}

// ─── Scrape with Playwright ──────────────────────────────────────────

async function scrapePlaywright(product: Product): Promise<{ html: string; durationMs: number } | null> {
  const browser = await getBrowser();
  if (!browser) return null;
  const ua = randomUA();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent: ua,
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
  });

  // Remove webdriver flag to avoid detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Fake plugins array
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-IN', 'en-GB', 'en-US', 'en'],
    });
    // Override chrome property
    (window as any).chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const start = Date.now();

  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // Try waiting for the main content selector with fallback
    try {
      await page.waitForSelector('#productTitle', { timeout: 6_000 });
    } catch {
      try {
        await page.waitForSelector('h1', { timeout: 3_000 });
      } catch {
        // proceed with what we have
      }
    }

    const html = await page.content();

    // Check if we got a CAPTCHA page
    if (
      html.includes('api-services-support@amazon.com') ||
      html.includes('Type the characters you see in this image')
    ) {
      log.warn('Amazon CAPTCHA detected in Playwright', { productId: product.id });
      return null;
    }

    return { html, durationMs: Date.now() - start };
  } finally {
    await context.close();
  }
}

// ─── Scrape with Cheerio (static, anti-bot headers) ──────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function scrapeStatic(product: Product): Promise<{ html: string; durationMs: number }> {
  const start = Date.now();
  const ua = randomUA();

  const resp = await fetch(product.url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://www.google.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });

  if (!resp.ok) {
    log.warn('Amazon static fetch non-OK', { status: resp.status, productId: product.id });
  }

  const html = await resp.text();

  // Detect CAPTCHA / robot check pages
  if (
    html.includes('api-services-support@amazon.com') ||
    html.includes('Type the characters you see in this image') ||
    html.includes('Sorry, we just need to make sure you') ||
    (html.length < 5000 && !html.includes('productTitle'))
  ) {
    log.warn('Amazon CAPTCHA/robot page detected, static scrape blocked', {
      productId: product.id,
      htmlLength: html.length,
    });
    throw new Error('CAPTCHA detected — static scrape blocked');
  }

  return { html, durationMs: Date.now() - start };
}

// ─── Adapter ─────────────────────────────────────────────────────────

function ensureProductUrl(product: Product): Product {
  // If the URL is a search page or doesn't contain /dp/, build a canonical URL
  const url = product.url;
  const asin = product.asin_or_sku;
  if (asin && (url.includes('/s?') || url.includes('/s/') || !url.includes('/dp/'))) {
    const host = url.includes('amazon.com') ? 'www.amazon.com' : 'www.amazon.in';
    return { ...product, url: `https://${host}/dp/${asin}` };
  }
  return product;
}

export const amazonAdapter: PlatformAdapter = {
  platform: 'amazon',

  async fetch(product: Product): Promise<FetchResult> {
    const start = Date.now();
    product = ensureProductUrl(product);

    // 1) Try official API
    const apiResult = await tryPaapi(product);
    if (apiResult) {
      return {
        payload: apiResult,
        strategy: 'api',
        fallbackLevel: 0,
        durationMs: Date.now() - start,
      };
    }

    // 2) Try static Cheerio fetch first (lighter)
    try {
      await politeDelay();
      const { html, durationMs } = await scrapeStatic(product);

      // Also extract offers and SEO from the HTML regardless of which price strategy works
      const cheerioForExtra = cheerio.load(html);
      const staticOffers = extractOffers(cheerioForExtra);
      const staticSeo = extractSeo(cheerioForExtra, html);

      // Try JSON-LD first
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
            offers: staticOffers,
            seo: staticSeo,
          },
          strategy: 'cheerio',
          fallbackLevel: 0,
          durationMs,
        };
      }

      // Try selector strategies
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
              offers: payload.offers ?? staticOffers,
              seo: payload.seo ?? staticSeo,
            },
            strategy: 'cheerio',
            fallbackLevel: i,
            durationMs,
          };
        }
      }
    } catch (err) {
      log.warn('Static scrape failed for Amazon, trying Playwright', {
        productId: product.id,
        error: String(err),
      });
    }

    // 3) Playwright fallback
    await politeDelay();
    const pwResult = await scrapePlaywright(product);

    if (pwResult) {
      const { html, durationMs } = pwResult;
      const pwCheerio = cheerio.load(html);
      const pwOffers = extractOffers(pwCheerio);
      const pwSeo = extractSeo(pwCheerio, html);

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
            offers: pwOffers,
            seo: pwSeo,
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
              offers: payload.offers ?? pwOffers,
              seo: payload.seo ?? pwSeo,
            },
            strategy: 'playwright',
            fallbackLevel: i,
            durationMs,
          };
        }
      }
    }

    // If nothing worked, return empty
    log.error('All strategies failed for Amazon product', { productId: product.id });
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
