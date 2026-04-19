import type { FetchResult, NormalizedPayload, Product } from '@/adapters/types';

export interface QualityAssessment {
  accepted: boolean;
  confidence: number;
  reasons: string[];
}

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: string, b: string): number {
  const s1 = tokenize(a);
  const s2 = tokenize(b);
  if (!s1.size || !s2.size) return 0;
  let inter = 0;
  for (const t of s1) if (s2.has(t)) inter++;
  const union = s1.size + s2.size - inter;
  return union > 0 ? inter / union : 0;
}

function isCaptchaLike(title: string): boolean {
  const t = (title || '').toLowerCase();
  return (
    t.includes('sorry, we just need to make sure') ||
    t.includes('type the characters') ||
    t.includes('robot check')
  );
}

export function assessPayloadQuality(params: {
  product: Product;
  fetchResult: FetchResult;
  prevPayload: NormalizedPayload | null;
}): QualityAssessment {
  const { product, fetchResult, prevPayload } = params;
  const next = fetchResult.payload;
  const reasons: string[] = [];
  let confidence = 100;

  // Hard validity checks
  if (!next.title || next.title.trim().length < 8) {
    reasons.push('missing_or_short_title');
    confidence -= 50;
  }
  if (!next.price || next.price <= 0) {
    reasons.push('missing_or_zero_price');
    confidence -= 50;
  }
  if (isCaptchaLike(next.title)) {
    reasons.push('captcha_like_title');
    confidence -= 60;
  }

  // Strategy/fallback confidence
  if (fetchResult.strategy !== 'api' && fetchResult.fallbackLevel >= 2) {
    reasons.push('deep_fallback_strategy');
    confidence -= 15;
  }
  if (fetchResult.durationMs > 20_000) {
    reasons.push('slow_fetch');
    confidence -= 5;
  }

  // Partial page signal: all core SEO blocks missing at once
  const seo = next.seo;
  if (seo && seo.bulletCount === 0 && seo.imageCount === 0 && !seo.metaTitle && !next.description) {
    reasons.push('partial_page_content');
    confidence -= 25;
  }

  // Compare with previous trusted payload if available
  if (prevPayload) {
    const oldPrice = Number(prevPayload.price || 0);
    const newPrice = Number(next.price || 0);
    if (oldPrice > 0 && newPrice > 0) {
      const ratio = Math.abs(newPrice - oldPrice) / oldPrice;
      if (ratio > 0.65 && fetchResult.strategy !== 'api') {
        reasons.push('extreme_price_shift');
        confidence -= 35;
      } else if (ratio > 0.35) {
        reasons.push('large_price_shift');
        confidence -= 15;
      }
    }

    const oldReviews = Number(prevPayload.reviewCount || 0);
    const newReviews = Number(next.reviewCount || 0);
    if (oldReviews >= 20 && newReviews >= 0) {
      const drop = oldReviews > 0 ? (oldReviews - newReviews) / oldReviews : 0;
      if (drop > 0.8) {
        reasons.push('extreme_review_drop');
        confidence -= 30;
      }
    }

    const oldRating = Number(prevPayload.rating || 0);
    const newRating = Number(next.rating || 0);
    if (oldRating > 0 && newRating > 0 && Math.abs(oldRating - newRating) > 1.0) {
      reasons.push('rating_jump');
      confidence -= 20;
    }

    const sim = jaccard(prevPayload.title || '', next.title || '');
    if (sim < 0.22) {
      reasons.push('title_mismatch');
      confidence -= 25;
    }
  }

  // Product hint check (ASIN/SKU should often appear in URL; if missing and title mismatch, lower confidence)
  const sku = (product.asin_or_sku || '').toLowerCase();
  if (sku && product.platform === 'amazon' && !product.url.toLowerCase().includes(`/dp/${sku}`)) {
    confidence -= 3;
  }

  if (confidence < 0) confidence = 0;

  // Reject only when confidence is truly low or hard failures exist.
  const hardFail = reasons.includes('missing_or_zero_price') || reasons.includes('missing_or_short_title') || reasons.includes('captcha_like_title');
  const accepted = !hardFail && confidence >= 55;

  return { accepted, confidence, reasons };
}
