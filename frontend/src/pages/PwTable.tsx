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

interface SellerOffer {
  seller_name: string;
  price: number | null;
  condition?: string | null;
  is_fba?: boolean | null;
  prime_eligible?: boolean | null;
  fetched_at?: string | null;
}

interface ProductFull {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  last_seen_at: string | null;
  last_snapshot: { payload_json: any; fetched_at: string } | null;
  seller_offers: SellerOffer[] | null;
}

interface SellerCell {
  price: number | null;
  rawName: string | null;
}

interface Row {
  id: number;
  asin: string;
  url: string;
  title: string;
  price: number | null;
  mrp: number | null;
  cocoblu: SellerCell;
  repo: SellerCell;
  pw: SellerCell;
  totalSellers: number;
  category: string;
  lastSnapshotAt: string | null;
  offers: SellerOffer[];
}

// ─── Category rules ──────────────────────────────────────────────────────────
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

const EXCLUDED_CATEGORIES = new Set(['Notebooks & Stationery', 'Other']);

function categorize(title: string): string {
  for (const [name, re] of CATEGORY_RULES) {
    if (re.test(title)) return name;
  }
  return 'Other';
}

const CATEGORY_ORDER = [
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
];

// ─── Seller matching ─────────────────────────────────────────────────────────
const SELLER_PATTERNS = {
  cocoblu: /cocoblu|coco\s*blue/i,
  repo: /\brepro\b|repro[-\s]*books|reposellable|repo\s*sellable|\brepos?\b/i,
  pw: /\bpw\b|physics\s*wallah|physicswallah/i,
} as const;

function pickSeller(offers: SellerOffer[], rx: RegExp): SellerCell {
  let best: SellerOffer | null = null;
  for (const o of offers) {
    if (!o?.seller_name) continue;
    if (!rx.test(o.seller_name)) continue;
    if (o.price == null) continue;
    if (!best || (best.price ?? Infinity) > (o.price ?? Infinity)) best = o;
  }
  return { price: best?.price ?? null, rawName: best?.seller_name ?? null };
}

// ─── Formatting ──────────────────────────────────────────────────────────────
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

function formatPctOff(seller: number | null, base: number | null): string | null {
  if (seller == null || base == null || base <= 0 || seller >= base) return null;
  return `-${Math.round(((base - seller) / base) * 100)}%`;
}

function formatDelta(seller: number | null, ref: number | null): { label: string; tone: 'down' | 'up' | 'flat' } | null {
  if (seller == null || ref == null) return null;
  const diff = seller - ref;
  if (Math.abs(diff) < 1) return { label: '±0', tone: 'flat' };
  if (diff < 0) return { label: `−₹${Math.round(-diff).toLocaleString('en-IN')}`, tone: 'down' };
  return { label: `+₹${Math.round(diff).toLocaleString('en-IN')}`, tone: 'up' };
}

const PAGE_SIZE = 50;

// ─── CSV export helpers ──────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normaliseSellerName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Build a CSV with one row per SKU and ONE COLUMN PER SELLER carrying the
 *  discount % that seller offers vs. the SKU's MRP. Also emits price + raw
 *  seller-name columns so the data is auditable in Excel.
 */
function buildPwCsv(rows: Row[]): string {
  // Discover every unique seller in the current dataset (sorted by frequency
  // so the most-common sellers land in the leftmost seller columns).
  const sellerFreq = new Map<string, number>();
  for (const r of rows) {
    for (const o of r.offers) {
      if (!o.seller_name) continue;
      const name = normaliseSellerName(o.seller_name);
      sellerFreq.set(name, (sellerFreq.get(name) ?? 0) + 1);
    }
  }
  const sellers = [...sellerFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  const baseCols = [
    'ASIN',
    'Title',
    'Category',
    'URL',
    'Buy Box Price',
    'MRP',
    'Buy Box Discount %',
    'Total Sellers',
    'Last Snapshot',
  ];
  const sellerCols: string[] = [];
  for (const s of sellers) {
    sellerCols.push(
      `${s} — Price`,
      `${s} — Discount % off MRP`,
      `${s} — Discount vs Buy Box`,
    );
  }
  const header = [...baseCols, ...sellerCols];

  const lines: string[] = [header.map(csvEscape).join(',')];

  for (const r of rows) {
    // One offer per seller — pick the cheapest if the same seller appears
    // more than once on a SKU (rare but possible for Used + New listings).
    const offerBySeller = new Map<string, SellerOffer>();
    for (const o of r.offers) {
      if (!o.seller_name) continue;
      const name = normaliseSellerName(o.seller_name);
      const cur = offerBySeller.get(name);
      if (!cur) { offerBySeller.set(name, o); continue; }
      if ((o.price ?? Infinity) < (cur.price ?? Infinity)) offerBySeller.set(name, o);
    }

    const buyBoxDisc = r.price != null && r.mrp && r.mrp > 0
      ? ((r.mrp - r.price) / r.mrp) * 100
      : null;

    const row: (string | number)[] = [
      r.asin,
      r.title,
      r.category,
      r.url,
      r.price ?? '',
      r.mrp ?? '',
      buyBoxDisc != null ? buyBoxDisc.toFixed(1) : '',
      r.totalSellers,
      r.lastSnapshotAt ?? '',
    ];

    for (const s of sellers) {
      const o = offerBySeller.get(s);
      const sellerPrice = o?.price ?? null;
      const discMrp = sellerPrice != null && r.mrp && r.mrp > 0
        ? ((r.mrp - sellerPrice) / r.mrp) * 100
        : null;
      const discBb = sellerPrice != null && r.price != null && r.price > 0
        ? ((r.price - sellerPrice) / r.price) * 100
        : null;
      row.push(
        sellerPrice ?? '',
        discMrp != null ? discMrp.toFixed(1) : '',
        discBb != null ? discBb.toFixed(1) : '',
      );
    }

    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function downloadCsv(filename: string, csv: string) {
  // Prepend UTF-8 BOM so Excel renders ₹ and other glyphs correctly.
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Component ───────────────────────────────────────────────────────────────
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
          const mrp = payload.mrp != null ? Number(payload.mrp) : null;
          const offers = (p.seller_offers ?? []).filter((o): o is SellerOffer => !!o);
          return {
            id: p.id,
            asin: p.asin_or_sku,
            url: p.url,
            title,
            price,
            mrp,
            cocoblu: pickSeller(offers, SELLER_PATTERNS.cocoblu),
            repo: pickSeller(offers, SELLER_PATTERNS.repo),
            pw: pickSeller(offers, SELLER_PATTERNS.pw),
            totalSellers: offers.length,
            category: categorize(title),
            lastSnapshotAt: p.last_snapshot?.fetched_at ?? null,
            offers,
          };
        })
        .filter((r) => !EXCLUDED_CATEGORIES.has(r.category));
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
    let withCoco = 0, withRepo = 0, withPw = 0, withMrp = 0;
    for (const r of rows) {
      if (r.cocoblu.price != null) withCoco++;
      if (r.repo.price != null) withRepo++;
      if (r.pw.price != null) withPw++;
      if (r.mrp != null) withMrp++;
    }
    return { total: rows.length, withCoco, withRepo, withPw, withMrp };
  }, [rows]);

  const exportCsv = () => {
    const dataset = filtered.length ? filtered : rows;
    if (!dataset.length) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const scope =
      activeCategory === 'all'
        ? (search.trim() ? 'search' : 'all')
        : activeCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    downloadCsv(`pw-table_${scope}_${stamp}.csv`, buildPwCsv(dataset));
  };
  const exportCount = filtered.length || rows.length;

  return (
    <div className="space-y-12">
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">PW Catalogue · Seller Comparison</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            PW Table
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Every PW-owned listing — sliced into product families, price-mapped against MRP, and
            cross-checked with the three known sellers (Coco Blue · Repro · PW). Stationery and
            uncategorised items are intentionally excluded.
          </p>
          <div className="flex items-center gap-3 flex-wrap pt-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={exportCsv}
              disabled={loading || !rows.length}
              title="Download the visible PW table — one column per seller (price, discount % off MRP, discount vs Buy Box)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 1.5v8.5m0 0L4.5 6.5M8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 11.5v2A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Export CSV ({exportCount.toLocaleString('en-IN')})
            </button>
            <span className="text-[12px]" style={{ color: 'var(--faint)' }}>
              One row per SKU · per-seller columns: price, discount % off MRP, discount vs Buy Box
            </span>
          </div>
        </div>

        <div className="metric-strip">
          <div><div className="kicker">PW SKUs</div><div className="metric-val">{stats.total}</div></div>
          <div><div className="kicker">w/ MRP</div><div className="metric-val">{stats.withMrp}</div></div>
          <div><div className="kicker">Coco Blue</div><div className="metric-val">{stats.withCoco}</div></div>
          <div><div className="kicker">Repro</div><div className="metric-val">{stats.withRepo}</div></div>
          <div><div className="kicker">PW</div><div className="metric-val">{stats.withPw}</div></div>
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

        <div className="flex justify-end items-center gap-3 pt-2 flex-wrap">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={exportCsv}
            disabled={loading || !rows.length}
            title="Download the visible PW table"
          >
            Export CSV ({exportCount.toLocaleString('en-IN')})
          </button>
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
          <p style={{ color: 'var(--muted)' }}>Adjust filters or run the seller scrape.</p>
        </div>
      )}

      {!loading && grouped.map(([category, list]) => {
        const page = pageByCat[category] ?? 1;
        const visibleCount = Math.min(list.length, page * PAGE_SIZE);
        const visible = list.slice(0, visibleCount);
        const pwPrices = list.map((r) => r.pw.price).filter((v): v is number => v != null);
        const avgPw = pwPrices.length ? pwPrices.reduce((a, b) => a + b, 0) / pwPrices.length : null;
        const sellersWithData = list.filter(
          (r) => r.cocoblu.price != null || r.repo.price != null || r.pw.price != null,
        ).length;
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
                  <span className="kicker mr-1.5">avg PW</span>
                  <span className="mono" style={{ color: 'var(--ink)' }}>{formatINR(avgPw)}</span>
                </span>
                <span>
                  <span className="kicker mr-1.5">w/ sellers</span>
                  <span className="mono" style={{ color: 'var(--ink)' }}>{sellersWithData}/{list.length}</span>
                </span>
              </div>
            </div>

            <div className="pw-table">
              <div className="pw-table__head pw-table__head--sellers">
                <div className="col-head">ASIN</div>
                <div className="col-head">Title</div>
                <div className="col-head" style={{ textAlign: 'right' }}>MRP</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Coco Blue</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Repro</div>
                <div className="col-head" style={{ textAlign: 'right' }}>PW</div>
                <div className="col-head">Last Seen</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Open</div>
              </div>

              {visible.map((r) => {
                const pwRef = r.pw.price ?? r.price;
                return (
                  <div key={r.id} className="pw-table__row pw-table__row--sellers">
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
                      <div className="pw-table__title-meta">
                        {r.totalSellers > 0
                          ? <span>{r.totalSellers} seller{r.totalSellers === 1 ? '' : 's'}</span>
                          : <span style={{ color: 'var(--faint)' }}>no offers</span>}
                      </div>
                    </div>
                    <div className="sku-table__cell-num">{formatINR(r.mrp)}</div>
                    <SellerColumn cell={r.cocoblu} mrp={r.mrp} pwRef={pwRef} isAnchor={false} />
                    <SellerColumn cell={r.repo} mrp={r.mrp} pwRef={pwRef} isAnchor={false} />
                    <SellerColumn cell={r.pw} mrp={r.mrp} pwRef={pwRef} isAnchor={true} />
                    <div className="sku-table__cell-text">{timeAgo(r.lastSnapshotAt)}</div>
                    <div className="pw-table__open">
                      <a href={r.url} target="_blank" rel="noreferrer" className="link-quiet text-[12px]">↗</a>
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

// ─── Seller cell ─────────────────────────────────────────────────────────────
function SellerColumn({
  cell,
  mrp,
  pwRef,
  isAnchor,
}: {
  cell: SellerCell;
  mrp: number | null;
  pwRef: number | null;
  isAnchor: boolean;
}) {
  if (cell.price == null) {
    return (
      <div className="pw-seller pw-seller--missing">
        <span className="pw-seller__na">N/A</span>
      </div>
    );
  }
  const off = formatPctOff(cell.price, mrp);
  const delta = isAnchor ? null : formatDelta(cell.price, pwRef);
  return (
    <div className="pw-seller" title={cell.rawName ?? undefined}>
      <div className="pw-seller__price">{formatINR(cell.price)}</div>
      <div className="pw-seller__meta">
        {off && <span className="pw-seller__off">{off}</span>}
        {delta && (
          <span className={`pw-seller__delta pw-seller__delta--${delta.tone}`}>
            {delta.label}
          </span>
        )}
        {!off && !delta && <span className="pw-seller__hint">—</span>}
      </div>
    </div>
  );
}
