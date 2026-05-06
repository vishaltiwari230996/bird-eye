import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';

interface PoolProductLite {
  id: number;
  is_own: boolean;
}

interface Pool {
  id: number;
  name: string;
  products: PoolProductLite[] | null;
}

interface ProductFull {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  last_seen_at: string | null;
  last_snapshot: { payload_json: any; fetched_at: string } | null;
}

interface Row {
  id: number;
  asin: string;
  url: string;
  title: string;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  bsr: string | null;
  in_stock: boolean | null;
  last_seen_at: string | null;
  category: string;
  is_own: boolean;
}

// ─── Category rules ──────────────────────────────────────────────────────────
// Ordered: first match wins. Tuned for the PW Amazon catalogue.
const CATEGORY_RULES: Array<[string, RegExp]> = [
  ['Notebooks & Stationery', /\bnotebook|spiral|ruled|\bpages\b|stationery|diary/i],
  ['Handwritten Notes', /handwritten|med easy|pankaj sir|sir.{0,20}notes\b/i],
  ['Mind Maps & Quick Revision', /mind\s*map|quick\s*revision|formula\s*(book|sheet)|flash\s*card/i],
  ['PYQs & Practice', /\bpyq|previous\s*year|year\s*question|practice\s*book|sample\s*paper|mock\s*test/i],
  ['NCERT', /\bncert\b/i],
  ['NEET', /\bneet\b/i],
  ['JEE (Main / Advanced)', /\bjee\b|advanced/i],
  ['CUET', /\bcuet\b/i],
  ['UPSC & Govt. Exams', /\bupsc\b|civil\s*services|ssc\b|bank(ing)?\s*exam|cds\b|nda\b/i],
  ['Classes 11–12 / Boards', /class\s*1[12]\b|board\s*exam|cbse\s*1[12]/i],
  ['Classes 6–10 / Foundation', /class\s*([6-9]|10)\b|foundation/i],
  ['Workbooks & Modules', /workbook|module|chapter\s*wise|topic\s*wise/i],
  ['Question Banks', /question\s*bank|objective\s*book/i],
];

function categorize(title: string): string {
  for (const [name, re] of CATEGORY_RULES) {
    if (re.test(title)) return name;
  }
  return 'Other';
}

const CATEGORY_ORDER = [
  'Notebooks & Stationery',
  'Handwritten Notes',
  'Mind Maps & Quick Revision',
  'PYQs & Practice',
  'NCERT',
  'NEET',
  'JEE (Main / Advanced)',
  'CUET',
  'UPSC & Govt. Exams',
  'Classes 11–12 / Boards',
  'Classes 6–10 / Foundation',
  'Workbooks & Modules',
  'Question Banks',
  'Other',
];

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatINR(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const PAGE_SIZE = 50;

export default function PwTable() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [pageByCat, setPageByCat] = useState<Record<string, number>>({});

  const load = async () => {
    try {
      setError(null);
      const [poolsRes, productsRes] = await Promise.all([
        api.get('/api/pools'),
        api.get('/api/products'),
      ]);
      if (!poolsRes.ok) throw new Error(`pools HTTP ${poolsRes.status}`);
      if (!productsRes.ok) throw new Error(`products HTTP ${productsRes.status}`);
      const pools: Pool[] = await poolsRes.json();
      const products: ProductFull[] = await productsRes.json();

      const ownIds = new Set<number>();
      for (const pool of pools) {
        for (const pp of pool.products ?? []) {
          if (pp.is_own) ownIds.add(pp.id);
        }
      }

      const built: Row[] = products
        .filter((p) => ownIds.has(p.id))
        .map((p) => {
          const payload = p.last_snapshot?.payload_json ?? {};
          const title: string = payload.title || p.title_known || p.asin_or_sku;
          const price = payload.price != null ? Number(payload.price) : null;
          const rating = payload.rating != null ? Number(payload.rating) : null;
          const reviews = payload.reviewCount != null ? Number(payload.reviewCount) : null;
          const bsr = typeof payload.bsr === 'string' && payload.bsr ? payload.bsr : null;
          const inStock =
            typeof payload.inStock === 'boolean' ? payload.inStock
            : typeof payload.in_stock === 'boolean' ? payload.in_stock
            : null;
          return {
            id: p.id,
            asin: p.asin_or_sku,
            url: p.url,
            title,
            price,
            rating,
            reviews,
            bsr,
            in_stock: inStock,
            last_seen_at: p.last_seen_at,
            category: categorize(title),
            is_own: true,
          };
        });
      setRows(built);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPageByCat({}); }, [search, activeCategory]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeCategory !== 'all' && r.category !== activeCategory) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.asin.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
      );
    });
  }, [rows, search, activeCategory]);

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    // Sort categories using the canonical order, then unknowns alphabetically.
    return [...map.entries()].sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a[0]);
      const bi = CATEGORY_ORDER.indexOf(b[0]);
      const av = ai === -1 ? 999 : ai;
      const bv = bi === -1 ? 999 : bi;
      if (av !== bv) return av - bv;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.category, (map.get(r.category) ?? 0) + 1);
    }
    return map;
  }, [rows]);

  const stats = useMemo(() => {
    const prices = rows.map((r) => r.price).filter((v): v is number => v != null);
    const ratings = rows.map((r) => r.rating).filter((v): v is number => v != null);
    return {
      total: rows.length,
      categories: categoryCounts.size,
      avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    };
  }, [rows, categoryCounts]);

  return (
    <div className="space-y-12">
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">PW Catalogue · Categorized View</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            PW Table
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Every PW-owned listing, sorted into product families. A clean tabular slice of the
            catalogue — built for sweeping reviews and quick category-level drills.
          </p>
        </div>

        <div className="metric-strip">
          <div><div className="kicker">PW SKUs</div><div className="metric-val">{stats.total}</div></div>
          <div><div className="kicker">Categories</div><div className="metric-val">{stats.categories}</div></div>
          <div><div className="kicker">Avg Price</div><div className="metric-val">{formatINR(stats.avgPrice)}</div></div>
          <div>
            <div className="kicker">Avg Rating</div>
            <div className="metric-val">
              {stats.avgRating != null ? `★ ${stats.avgRating.toFixed(2)}` : '—'}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="kicker">Filter by category</div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className={`pill ${activeCategory === 'all' ? 'active' : ''}`}
            onClick={() => setActiveCategory('all')}
          >
            all <span className="mono ml-1.5" style={{ color: 'var(--faint)' }}>{rows.length}</span>
          </button>
          {CATEGORY_ORDER.filter((c) => categoryCounts.get(c)).map((c) => (
            <button
              key={c}
              className={`pill ${activeCategory === c ? 'active' : ''}`}
              onClick={() => setActiveCategory(c)}
            >
              {c} <span className="mono ml-1.5" style={{ color: 'var(--faint)' }}>{categoryCounts.get(c)}</span>
            </button>
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <div className="search-wrap">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ASIN, title, category…"
            />
          </div>
        </div>
      </section>

      {loading && (
        <div className="panel p-10 text-center" style={{ color: 'var(--muted)' }}>Loading PW table…</div>
      )}
      {error && !loading && (
        <div className="panel p-6" style={{ color: 'var(--accent-red)' }}>{error}</div>
      )}
      {!loading && !filtered.length && !error && (
        <div className="panel p-10 text-center space-y-2">
          <div className="kicker">Empty</div>
          <p className="serif text-[28px]" style={{ color: 'var(--ink)' }}>No PW SKUs match.</p>
          <p style={{ color: 'var(--muted)' }}>Adjust filters or seed the catalogue.</p>
        </div>
      )}

      {!loading && grouped.map(([category, list]) => {
        const page = pageByCat[category] ?? 1;
        const visibleCount = Math.min(list.length, page * PAGE_SIZE);
        const visible = list.slice(0, visibleCount);
        const prices = list.map((r) => r.price).filter((v): v is number => v != null);
        const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
        return (
          <section key={category} className="space-y-5">
            <div className="flex items-end justify-between flex-wrap gap-4">
              <div>
                <div className="kicker">Category</div>
                <h2 className="serif text-[28px] leading-tight" style={{ color: 'var(--ink)' }}>
                  {category} <span style={{ color: 'var(--faint)' }}>· {list.length}</span>
                </h2>
              </div>
              <div className="flex items-center gap-5 text-[12.5px]" style={{ color: 'var(--muted)' }}>
                <span>
                  <span className="kicker mr-1.5">avg</span>
                  <span className="mono" style={{ color: 'var(--ink)' }}>{formatINR(avgPrice)}</span>
                </span>
                <span>
                  <span className="kicker mr-1.5">priced</span>
                  <span className="mono" style={{ color: 'var(--ink)' }}>{prices.length}/{list.length}</span>
                </span>
              </div>
            </div>

            <div className="pw-table">
              <div className="pw-table__head">
                <div className="col-head">ASIN</div>
                <div className="col-head">Title</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Price</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Rating</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Reviews</div>
                <div className="col-head">BSR</div>
                <div className="col-head">Stock</div>
                <div className="col-head">Last Seen</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Open</div>
              </div>

              {visible.map((r) => {
                const stockClass =
                  r.in_stock === false ? 'chip chip-red'
                  : r.in_stock === true ? 'chip chip-green'
                  : 'chip';
                const stockLabel =
                  r.in_stock === false ? 'Out'
                  : r.in_stock === true ? 'In'
                  : '—';
                return (
                  <div key={r.id} className="pw-table__row">
                    <div className="sku-table__cell-mono" title={r.asin}>{r.asin}</div>
                    <div className="pw-table__title">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="pw-table__title-text"
                        title={r.title}
                      >
                        {r.title}
                      </a>
                    </div>
                    <div className="sku-table__cell-num">{formatINR(r.price)}</div>
                    <div className="sku-table__cell-num">
                      {r.rating != null ? `★ ${r.rating.toFixed(1)}` : '—'}
                    </div>
                    <div className="sku-table__cell-num">
                      {r.reviews != null ? r.reviews.toLocaleString('en-IN') : '—'}
                    </div>
                    <div className="sku-table__cell-mono" title={r.bsr ?? undefined}>
                      {r.bsr ? r.bsr.replace(/^#?\s*/, '#') : '—'}
                    </div>
                    <div>
                      <span className={stockClass}>{stockLabel}</span>
                    </div>
                    <div className="sku-table__cell-text">{timeAgo(r.last_seen_at)}</div>
                    <div className="pw-table__open">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="link-quiet text-[12px]"
                      >↗</a>
                    </div>
                  </div>
                );
              })}

              {list.length > PAGE_SIZE && (
                <div className="sku-table__pager">
                  <span>
                    Showing <span className="mono" style={{ color: 'var(--ink)' }}>{visibleCount}</span> of{' '}
                    <span className="mono" style={{ color: 'var(--ink)' }}>{list.length}</span>
                  </span>
                  <div className="sku-table__pager-actions">
                    {visibleCount < list.length && (
                      <button
                        className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                        onClick={() => setPageByCat((s) => ({ ...s, [category]: page + 1 }))}
                      >
                        Load {Math.min(PAGE_SIZE, list.length - visibleCount)} more
                      </button>
                    )}
                    {visibleCount < list.length && (
                      <button
                        className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                        onClick={() => setPageByCat((s) => ({
                          ...s,
                          [category]: Math.ceil(list.length / PAGE_SIZE),
                        }))}
                      >
                        Show all
                      </button>
                    )}
                    {visibleCount > PAGE_SIZE && (
                      <button
                        className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                        onClick={() => setPageByCat((s) => ({ ...s, [category]: 1 }))}
                      >
                        Collapse
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
