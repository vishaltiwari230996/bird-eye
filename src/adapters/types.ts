/** Normalized payload every adapter must return */
export interface NormalizedPayload {
  title: string;
  description: string;
  price: number;
  currency: string;
  rating: number | null;
  reviewCount: number | null;
  lastReviewAt: string | null;
  reviews: ReviewSnippet[];
  /** Extended offer fields — tracked for competitor monitoring */
  offers?: OfferInfo;
  /** SEO-relevant fields */
  seo?: SeoInfo;
}

export interface OfferInfo {
  mrp: number | null;
  discountPct: string | null;       // e.g. "-37%"
  dealBadge: string | null;         // "Lightning Deal", "Deal of the Day", etc.
  coupon: string | null;            // coupon text if any
  bankOffers: string[];             // bank-specific discount texts
  availability: string | null;      // "In stock", "Only 3 left" etc.
  seller: string | null;            // seller/merchant name
  bestSellerRank: string | null;    // BSR text
}

export interface SeoInfo {
  metaTitle: string | null;          // <title> tag
  metaDescription: string | null;    // <meta name="description">
  bulletCount: number;               // number of feature bullet points
  bullets: string[];                 // the bullet texts themselves
  imageCount: number;                // product images
  hasAPlus: boolean;                 // A+ / Enhanced Brand Content
  categoryPath: string | null;       // breadcrumb category path
  questionCount: number | null;      // answered questions
}

export interface ReviewSnippet {
  id: string;
  date: string;
  text: string;
}

export interface FetchResult {
  payload: NormalizedPayload;
  /** Which strategy was used: 'api' | 'playwright' | 'cheerio' */
  strategy: 'api' | 'playwright' | 'cheerio';
  /** 0 = primary selectors, 1+ = fallback count (parse drift metric) */
  fallbackLevel: number;
  durationMs: number;
}

export interface Product {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  last_seen_at: string | null;
}

/**
 * Every platform adapter must implement this interface.
 */
export interface PlatformAdapter {
  platform: string;
  /** Fetch normalized product data. Tries API first, then scraping fallback. */
  fetch(product: Product): Promise<FetchResult>;
}
