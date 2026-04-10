import crypto from 'crypto';

/** Normalize a string: trim, collapse whitespace, lowercase */
export function normalizeStr(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Normalize a price to a number (removes ₹, $, commas) */
export function normalizePrice(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
  return parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
}

/** Deep-sort an object's keys for deterministic hashing */
function sortObject(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);
  return Object.keys(obj)
    .sort()
    .reduce((acc: any, key) => {
      acc[key] = sortObject(obj[key]);
      return acc;
    }, {});
}

/**
 * Normalize a payload for hashing.
 * Strips volatile fields (review text, lastReviewAt) so the hash stays
 * stable and only changes on real product data changes.
 */
export function normalizePayload(payload: Record<string, any>): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.title) clone.title = normalizeStr(clone.title);
  if (clone.description) clone.description = normalizeStr(clone.description);
  if (clone.price != null) clone.price = normalizePrice(clone.price);

  // For hashing, only keep review IDs (text formatting changes are not meaningful)
  if (Array.isArray(clone.reviews)) {
    clone.reviews = clone.reviews.map((r: any) => r.id || '').filter(Boolean).sort();
  }

  // Remove volatile fields
  delete clone.lastReviewAt;

  // Normalize offer sub-fields
  if (clone.offers) {
    if (clone.offers.bestSellerRank) {
      clone.offers.bestSellerRank = normalizeStr(clone.offers.bestSellerRank);
    }
    if (clone.offers.availability) {
      clone.offers.availability = normalizeStr(clone.offers.availability);
    }
    if (Array.isArray(clone.offers.bankOffers)) {
      clone.offers.bankOffers = clone.offers.bankOffers.map(normalizeStr).sort();
    }
  }

  return sortObject(clone);
}

/** Create a stable SHA-256 hash of a normalized payload */
export function hashPayload(payload: Record<string, any>): string {
  const normalized = normalizePayload(payload);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
