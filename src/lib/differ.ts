import { hashPayload } from '@/lib/hash';
import { query, queryOne, withTransaction } from '@/lib/db';
import { log } from '@/lib/logger';
import type { NormalizedPayload, OfferInfo, Product, SeoInfo } from '@/adapters/types';

// ─── Types ───────────────────────────────────────────────────────────

export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
}

// ─── Normalization helpers ───────────────────────────────────────────

function norm(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function numVal(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ─── Individual field comparators ────────────────────────────────────
// Each returns null (no change) or a FieldChange.

type Comparator = (
  prev: NormalizedPayload,
  next: NormalizedPayload,
) => FieldChange | null;

function compareTitle(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  const a = norm(prev.title);
  const b = norm(next.title);
  if (!b) return null; // skip if new value is empty (scrape failed)
  if (a === b) return null;
  return { field: 'title', oldValue: prev.title || '', newValue: next.title || '' };
}

function compareDescription(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  const a = norm(prev.description);
  const b = norm(next.description);
  if (!b) return null;
  if (a === b) return null;
  if (a.replace(/\s/g, '') === b.replace(/\s/g, '')) return null;
  return { field: 'description', oldValue: (prev.description || '').slice(0, 200), newValue: (next.description || '').slice(0, 200) };
}

function comparePrice(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  const pOld = numVal(prev.price);
  const pNew = numVal(next.price);
  if (pNew === 0) return null; // skip if scrape returned 0
  if (pOld === pNew) return null;
  const absDiff = Math.abs(pNew - pOld);
  const pctDiff = pOld > 0 ? absDiff / pOld : 1;
  if (absDiff <= 1 && pctDiff <= 0.005) return null;
  const sym = (next.currency || prev.currency || 'INR') === 'INR' ? '₹' : (next.currency || prev.currency || '₹');
  return { field: 'price', oldValue: `${sym}${pOld}`, newValue: `${sym}${pNew}` };
}

function compareRating(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  const a = numVal(prev.rating);
  const b = numVal(next.rating);
  if (b === 0 && a > 0) return null; // scrape lost the rating
  if (a === b) return null;
  if (Math.abs(a - b) < 0.05) return null;
  return { field: 'rating', oldValue: a ? String(a) : '—', newValue: b ? String(b) : '—' };
}

function compareReviewCount(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  const a = numVal(prev.reviewCount);
  const b = numVal(next.reviewCount);
  if (b === 0 && a > 0) return null;
  if (a === b) return null;
  return { field: 'reviewCount', oldValue: a ? String(a) : '0', newValue: b ? String(b) : '0' };
}

function compareNewReviews(prev: NormalizedPayload, next: NormalizedPayload): FieldChange | null {
  if (!next.reviews?.length) return null;
  const prevIds = new Set((prev.reviews ?? []).map((r) => r.id));
  const newRevs = next.reviews.filter((r) => r.id && !prevIds.has(r.id));
  if (newRevs.length === 0) return null;
  return {
    field: 'newReviews',
    oldValue: `${prevIds.size} reviews`,
    newValue: `+${newRevs.length} new`,
  };
}

// ─── Offer field comparators ─────────────────────────────────────────

type OfferComparator = (
  prev: Partial<OfferInfo>,
  next: Partial<OfferInfo>,
) => FieldChange | null;

function compareMrp(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = numVal(prev.mrp);
  const b = numVal(next.mrp);
  if (b === 0) return null;
  if (a === b) return null;
  if (Math.abs(a - b) <= 1) return null;
  return { field: 'offers.mrp', oldValue: a ? `₹${a}` : '—', newValue: `₹${b}` };
}

function compareDiscount(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.discountPct);
  const b = norm(next.discountPct);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'offers.discount', oldValue: prev.discountPct || '—', newValue: next.discountPct || '—' };
}

function compareDeal(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.dealBadge);
  const b = norm(next.dealBadge);
  if (a === b) return null;
  return { field: 'offers.deal', oldValue: prev.dealBadge || '—', newValue: next.dealBadge || '—' };
}

function compareCoupon(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.coupon);
  const b = norm(next.coupon);
  if (a === b) return null;
  return { field: 'offers.coupon', oldValue: prev.coupon || '—', newValue: next.coupon || '—' };
}

function compareBankOffers(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = (prev.bankOffers ?? []).map(norm).sort().join('|');
  const b = (next.bankOffers ?? []).map(norm).sort().join('|');
  if (a === b) return null;
  return {
    field: 'offers.bankOffers',
    oldValue: `${(prev.bankOffers ?? []).length} offers`,
    newValue: `${(next.bankOffers ?? []).length} offers`,
  };
}

function compareAvailability(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.availability);
  const b = norm(next.availability);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'offers.availability', oldValue: prev.availability || '—', newValue: next.availability || '' };
}

function compareSeller(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.seller);
  const b = norm(next.seller);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'offers.seller', oldValue: prev.seller || '—', newValue: next.seller || '' };
}

function compareBsr(prev: Partial<OfferInfo>, next: Partial<OfferInfo>): FieldChange | null {
  const a = norm(prev.bestSellerRank);
  const b = norm(next.bestSellerRank);
  if (!b) return null;
  if (a === b) return null;
  const extractRank = (s: string) => {
    const m = s.match(/#[\d,]+/);
    return m ? m[0] : s.slice(0, 60);
  };
  return {
    field: 'offers.bsr',
    oldValue: prev.bestSellerRank ? extractRank(prev.bestSellerRank) : '—',
    newValue: next.bestSellerRank ? extractRank(next.bestSellerRank) : '—',
  };
}

// ─── Comparator lists ────────────────────────────────────────────────

const FIELD_COMPARATORS: Comparator[] = [
  compareTitle,
  comparePrice,
  compareRating,
  compareReviewCount,
  compareDescription,
  compareNewReviews,
];

const OFFER_COMPARATORS: OfferComparator[] = [
  compareMrp,
  compareDiscount,
  compareDeal,
  compareCoupon,
  compareBankOffers,
  compareAvailability,
  compareSeller,
  compareBsr,
];

// ─── SEO field comparators ───────────────────────────────────────────

type SeoComparator = (
  prev: Partial<SeoInfo>,
  next: Partial<SeoInfo>,
) => FieldChange | null;

function compareMetaTitle(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = norm(prev.metaTitle);
  const b = norm(next.metaTitle);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'seo.metaTitle', oldValue: prev.metaTitle || '—', newValue: next.metaTitle || '' };
}

function compareMetaDescription(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = norm(prev.metaDescription);
  const b = norm(next.metaDescription);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'seo.metaDescription', oldValue: (prev.metaDescription || '—').slice(0, 120), newValue: (next.metaDescription || '').slice(0, 120) };
}

function compareBulletCount(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = prev.bulletCount ?? 0;
  const b = next.bulletCount ?? 0;
  if (b === 0) return null;
  if (a === b) return null;
  return { field: 'seo.bulletCount', oldValue: String(a), newValue: String(b) };
}

function compareImageCount(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = prev.imageCount ?? 0;
  const b = next.imageCount ?? 0;
  if (b === 0) return null;
  if (a === b) return null;
  return { field: 'seo.imageCount', oldValue: String(a), newValue: String(b) };
}

function compareAPlus(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = !!prev.hasAPlus;
  const b = !!next.hasAPlus;
  if (a === b) return null;
  return { field: 'seo.aPlus', oldValue: a ? 'Yes' : 'No', newValue: b ? 'Yes' : 'No' };
}

function compareCategoryPath(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = norm(prev.categoryPath);
  const b = norm(next.categoryPath);
  if (!b) return null;
  if (a === b) return null;
  return { field: 'seo.categoryPath', oldValue: prev.categoryPath || '—', newValue: next.categoryPath || '' };
}

function compareQuestionCount(prev: Partial<SeoInfo>, next: Partial<SeoInfo>): FieldChange | null {
  const a = prev.questionCount ?? 0;
  const b = next.questionCount ?? 0;
  if (b === 0 && a > 0) return null;
  if (a === b) return null;
  return { field: 'seo.questionCount', oldValue: String(a), newValue: String(b) };
}

const SEO_COMPARATORS: SeoComparator[] = [
  compareMetaTitle,
  compareMetaDescription,
  compareBulletCount,
  compareImageCount,
  compareAPlus,
  compareCategoryPath,
  compareQuestionCount,
];

// ─── Public diff function ────────────────────────────────────────────

/**
 * Compare two payloads and return field-level diffs.
 * Each comparator is isolated — a single failure won't break others.
 * Skips "empty→value" transitions (initialization noise).
 */
export function diffPayloads(
  prev: NormalizedPayload,
  next: NormalizedPayload,
  isFirstRealComparison = false,
): FieldChange[] {
  const changes: FieldChange[] = [];

  // If next payload looks empty/broken, skip diff entirely
  if (!next.title && numVal(next.price) === 0) {
    log.warn('Skipping diff — next payload appears empty (scrape may have failed)');
    return [];
  }

  for (const cmp of FIELD_COMPARATORS) {
    try {
      const change = cmp(prev, next);
      if (change) {
        // Skip "empty → value" on first real comparison (initialization noise)
        if (isFirstRealComparison && !change.oldValue) continue;
        changes.push(change);
      }
    } catch (err) {
      log.warn('Field comparator failed', { error: String(err) });
    }
  }

  const prevOffers: Partial<OfferInfo> = prev.offers ?? {};
  const nextOffers: Partial<OfferInfo> = next.offers ?? {};

  for (const cmp of OFFER_COMPARATORS) {
    try {
      const change = cmp(prevOffers, nextOffers);
      if (change) {
        if (isFirstRealComparison && (!change.oldValue || change.oldValue === '—')) continue;
        changes.push(change);
      }
    } catch (err) {
      log.warn('Offer comparator failed', { error: String(err) });
    }
  }

  // SEO comparators
  const prevSeo: Partial<SeoInfo> = prev.seo ?? {};
  const nextSeo: Partial<SeoInfo> = next.seo ?? {};

  for (const cmp of SEO_COMPARATORS) {
    try {
      const change = cmp(prevSeo, nextSeo);
      if (change) {
        if (isFirstRealComparison && (!change.oldValue || change.oldValue === '—')) continue;
        changes.push(change);
      }
    } catch (err) {
      log.warn('SEO comparator failed', { error: String(err) });
    }
  }

  return changes;
}

// ─── Snapshot processor ──────────────────────────────────────────────

/**
 * Process a fetched payload: hash → store snapshot if changed → record diffs.
 * Returns the list of changes (empty if nothing changed).
 * Never throws — all errors are caught and logged.
 */
export async function processSnapshot(
  product: Product,
  payload: NormalizedPayload,
): Promise<FieldChange[]> {
  try {
    // Validate payload
    if (!payload || (!payload.title && numVal(payload.price) === 0)) {
      log.warn('Skipping snapshot — payload is empty or invalid', {
        productId: product.id,
        hasTitle: !!payload?.title,
        price: payload?.price,
      });
      await query('UPDATE products SET last_seen_at = now() WHERE id = $1', [product.id]).catch(() => {});
      return [];
    }

    const hash = hashPayload(payload as Record<string, any>);

    // Get previous snapshot
    const prevSnap = await queryOne<{ payload_json: NormalizedPayload; hash: string }>(
      'SELECT payload_json, hash FROM snapshots WHERE product_id = $1 ORDER BY fetched_at DESC LIMIT 1',
      [product.id],
    );

    // Count snapshots to detect "first real comparison"
    const snapCount = prevSnap
      ? ((await queryOne<{ cnt: string }>('SELECT count(*)::text AS cnt FROM snapshots WHERE product_id = $1', [product.id]))?.cnt ?? '0')
      : '0';
    const isFirstRealComparison = parseInt(snapCount, 10) <= 1;

    // If hash unchanged, just update last_seen_at
    if (prevSnap && prevSnap.hash === hash) {
      log.debug('No change detected (hash match)', { productId: product.id });
      await query('UPDATE products SET last_seen_at = now() WHERE id = $1', [product.id]);
      return [];
    }

    // Compute diffs
    let diffs: FieldChange[] = [];
    if (prevSnap) {
      try {
        diffs = diffPayloads(prevSnap.payload_json, payload, isFirstRealComparison);
      } catch (err) {
        log.error('diffPayloads threw unexpectedly', { productId: product.id, error: String(err) });
        diffs = [];
      }
    }

    // Write snapshot + changes atomically
    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO snapshots (product_id, payload_json, hash) VALUES ($1, $2, $3)',
        [product.id, JSON.stringify(payload), hash],
      );

      for (const diff of diffs) {
        await client.query(
          'INSERT INTO changes (product_id, field, old_value, new_value) VALUES ($1, $2, $3, $4)',
          [product.id, diff.field, diff.oldValue ?? '', diff.newValue ?? ''],
        );
      }

      // Update last_seen_at and auto-set title_known if empty
      if (payload.title) {
        await client.query(
          'UPDATE products SET last_seen_at = now(), title_known = COALESCE(title_known, $2) WHERE id = $1',
          [product.id, payload.title.slice(0, 500)],
        );
      } else {
        await client.query('UPDATE products SET last_seen_at = now() WHERE id = $1', [product.id]);
      }
    });

    if (diffs.length > 0) {
      log.info('Changes detected', {
        productId: product.id,
        platform: product.platform,
        fields: diffs.map((d) => d.field).join(', ') as any,
        count: diffs.length,
      });
    } else if (!prevSnap) {
      log.info('First snapshot stored', { productId: product.id });
    } else {
      log.info('Snapshot updated (hash changed, no meaningful diffs)', { productId: product.id });
    }

    return diffs;
  } catch (err) {
    log.error('processSnapshot failed', { productId: product.id, error: String(err) });
    await query('UPDATE products SET last_seen_at = now() WHERE id = $1', [product.id]).catch(() => {});
    return [];
  }
}
