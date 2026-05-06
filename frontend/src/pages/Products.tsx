import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';
import { summarizeChange, type ChangeInsight } from '@/lib/change-intel';

interface RecentChange {
  field: string;
  old_value: string;
  new_value: string;
  detected_at: string;
}

interface SellerOffer {
  seller_name: string;
  price: number | null;
  condition: string | null;
  is_fba: boolean | null;
  prime_eligible: boolean | null;
  fetched_at: string;
}

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
  recent_changes: RecentChange[] | null;
  seller_offers: SellerOffer[] | null;
}

type ChangeKind = 'title' | 'description' | 'bsr' | 'price';

interface Card {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title: string;
  description: string | null;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  bsr: string | null;
  in_stock: boolean | null;
  last_seen_at: string | null;
  is_own: boolean;
  brand: string;
  pools: string[];
  changes: RecentChange[];
  insights: ChangeInsight[];
  changeFlags: Record<ChangeKind, RecentChange | null>;
  sellers: SellerOffer[];
}

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

function chipToneClass(tone: ChangeInsight['tone']): string {
  switch (tone) {
    case 'green': return 'chip chip-green';
    case 'red': return 'chip chip-red';
    case 'amber': return 'chip chip-amber';
    case 'blue': return 'chip chip-blue';
    default: return 'chip';
  }
}

const BRAND_ORDER = ['PW', 'Educart', 'Oswaal', 'MTG'];
const PAGE_SIZE = 50;

function brandFromPoolName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.includes(' - ')) return cleaned.split(' - ')[0].trim();
  for (const b of BRAND_ORDER) {
    if (cleaned.toLowerCase().startsWith(b.toLowerCase())) return b;
  }
  return 'Other';
}

const CHANGE_FIELDS: Record<ChangeKind, (field: string) => boolean> = {
  title: (f) => f === 'title',
  description: (f) => f === 'description',
  bsr: (f) => f === 'offers.bsr' || f === 'offers.bestSellerRank' || f === 'bsr',
  price: (f) => f === 'price',
};

const CHANGE_LABEL: Record<ChangeKind, string> = {
  title: 'Title',
  description: 'Desc',
  bsr: 'BSR',
  price: 'Price',
};

function buildChangeFlags(changes: RecentChange[]): Record<ChangeKind, RecentChange | null> {
  const out: Record<ChangeKind, RecentChange | null> = { title: null, description: null, bsr: null, price: null };
  for (const c of changes) {
    for (const k of Object.keys(CHANGE_FIELDS) as ChangeKind[]) {
      if (out[k] == null && CHANGE_FIELDS[k](c.field)) out[k] = c;
    }
  }
  return out;
}

export default function Products() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<'all' | 'amazon' | 'flipkart'>('all');
  const [ownership, setOwnership] = useState<'all' | 'own' | 'competitor'>('all');
  const [busyAll, setBusyAll] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [sellerBusyIds, setSellerBusyIds] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pageByBrand, setPageByBrand] = useState<Record<string, number>>({});

  const buildCards = (pools: Pool[], products: ProductFull[]): Card[] => {
    const ownIds = new Set<number>();
    const poolNamesById = new Map<number, string[]>();
    for (const pool of pools) {
      for (const pp of pool.products ?? []) {
        const arr = poolNamesById.get(pp.id) ?? [];
        arr.push(pool.name);
        poolNamesById.set(pp.id, arr);
        if (pp.is_own) ownIds.add(pp.id);
      }
    }
    return products.map((p) => {
      const payload = p.last_snapshot?.payload_json ?? {};
      const title = payload.title || p.title_known || p.asin_or_sku;
      const price = payload.price != null ? Number(payload.price) : null;
      const rating = payload.rating != null ? Number(payload.rating) : null;
      const reviews = payload.reviewCount != null ? Number(payload.reviewCount) : null;
      const bsr = typeof payload.bsr === 'string' && payload.bsr ? payload.bsr : null;
      const description = typeof payload.description === 'string' && payload.description ? payload.description : null;
      const inStock =
        typeof payload.inStock === 'boolean' ? payload.inStock
        : typeof payload.in_stock === 'boolean' ? payload.in_stock
        : null;
      const changes = p.recent_changes ?? [];
      const insights = changes.slice(0, 3).map(summarizeChange);
      const cardPools = poolNamesById.get(p.id) ?? [];
      const brand = cardPools.length ? brandFromPoolName(cardPools[0]) : 'Other';
      return {
        id: p.id,
        platform: p.platform,
        asin_or_sku: p.asin_or_sku,
        url: p.url,
        title,
        description,
        price,
        rating,
        reviews,
        bsr,
        in_stock: inStock,
        last_seen_at: p.last_seen_at,
        is_own: ownIds.has(p.id),
        brand,
        pools: cardPools,
        changes,
        insights,
        changeFlags: buildChangeFlags(changes),
        sellers: p.seller_offers ?? [],
      };
    });
  };

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
      setCards(buildCards(pools, products));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const checkOne = async (id: number) => {
    setBusyIds((s) => new Set(s).add(id));
    try {
      await api.post('/api/run-check', { productId: id });
      await load();
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const refreshSellers = async (id: number) => {
    setSellerBusyIds((s) => new Set(s).add(id));
    try {
      await api.post(`/api/products/${id}/sellers`);
      await load();
    } finally {
      setSellerBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const fetchAllPwSellers = async () => {
    setBusyAll(true);
    setBulkProgress({ done: 0, total: 0 });
    try {
      const res = await api.post('/api/sellers/refresh-all');
      if (!res.body) {
        await load();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (typeof evt.done === 'number' && typeof evt.total === 'number') {
              setBulkProgress({ done: evt.done, total: evt.total });
            }
          } catch { /* ignore */ }
        }
      }
      await load();
    } finally {
      setBusyAll(false);
      setBulkProgress(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter((c) => {
      if (platform !== 'all' && c.platform !== platform) return false;
      if (ownership === 'own' && !c.is_own) return false;
      if (ownership === 'competitor' && c.is_own) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.asin_or_sku.toLowerCase().includes(q) ||
        c.brand.toLowerCase().includes(q) ||
        c.pools.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [cards, search, platform, ownership]);

  const grouped = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const c of filtered) {
      const arr = map.get(c.brand) ?? [];
      arr.push(c);
      map.set(c.brand, arr);
    }
    return [...map.entries()].sort((a, b) => {
      const ai = BRAND_ORDER.indexOf(a[0]);
      const bi = BRAND_ORDER.indexOf(b[0]);
      const av = ai === -1 ? 999 : ai;
      const bv = bi === -1 ? 999 : bi;
      if (av !== bv) return av - bv;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  const stats = useMemo(() => {
    const prices = cards.map((c) => c.price).filter((v): v is number => v != null);
    const ratings = cards.map((c) => c.rating).filter((v): v is number => v != null);
    return {
      total: cards.length,
      pw: cards.filter((c) => c.is_own).length,
      avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      withChange: cards.filter((c) => c.insights.length).length,
    };
  }, [cards]);

  // Reset pagination whenever filters change so we don't paginate past the
  // newly-truncated brand lists.
  useEffect(() => { setPageByBrand({}); }, [search, platform, ownership]);

  return (
    <div className="space-y-12">
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">Catalogue Intelligence</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            Products
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Every PW SKU and competitor SKU under our watch — captured as they shift, priced as they stand.
          </p>
        </div>

        <div className="metric-strip">
          <div><div className="kicker">Total</div><div className="metric-val">{stats.total}</div></div>
          <div><div className="kicker">PW SKUs</div><div className="metric-val">{stats.pw}</div></div>
          <div><div className="kicker">Avg Price</div><div className="metric-val">{formatINR(stats.avgPrice)}</div></div>
          <div><div className="kicker">Moving</div><div className="metric-val">{stats.withChange}</div></div>
        </div>
      </section>

      <section className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {(['all', 'amazon', 'flipkart'] as const).map((k) => (
            <button
              key={k}
              className={`pill ${platform === k ? 'active' : ''}`}
              onClick={() => setPlatform(k)}
            >
              {k}
            </button>
          ))}
          <span className="mx-2 text-[12px]" style={{ color: 'var(--faint)' }}>·</span>
          {(['all', 'own', 'competitor'] as const).map((k) => (
            <button
              key={k}
              className={`pill ${ownership === k ? 'active' : ''}`}
              onClick={() => setOwnership(k)}
            >
              {k === 'all' ? 'all SKUs' : k === 'own' ? 'PW only' : 'competitors'}
            </button>
          ))}
        </div>
        <div className="search-wrap">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, title, brand…"
          />
        </div>
      </section>

      {loading && (
        <div className="panel p-10 text-center" style={{ color: 'var(--muted)' }}>Loading catalogue…</div>
      )}
      {error && !loading && (
        <div className="panel p-6" style={{ color: 'var(--accent-red)' }}>{error}</div>
      )}
      {!loading && !filtered.length && !error && (
        <div className="panel p-10 text-center space-y-2">
          <div className="kicker">Empty</div>
          <p className="serif text-[28px]" style={{ color: 'var(--ink)' }}>No SKUs match.</p>
          <p style={{ color: 'var(--muted)' }}>Adjust filters or add products in a pool.</p>
        </div>
      )}

      {!loading && grouped.map(([brand, list]) => {
        const isPw = brand === 'PW';
        const page = pageByBrand[brand] ?? 1;
        const visibleCount = Math.min(list.length, page * PAGE_SIZE);
        const visible = list.slice(0, visibleCount);
        return (
          <section key={brand} className="space-y-5">
            <div className="flex items-end justify-between flex-wrap gap-4">
              <div>
                <div className="kicker">{isPw ? 'Our catalogue' : 'Competitor catalogue'}</div>
                <h2 className="serif text-[32px] leading-tight" style={{ color: 'var(--ink)' }}>
                  {brand} <span style={{ color: 'var(--faint)' }}>· {list.length}</span>
                </h2>
              </div>
              {isPw && (
                <button
                  className="btn btn-primary"
                  onClick={fetchAllPwSellers}
                  disabled={busyAll}
                >
                  {busyAll
                    ? bulkProgress
                      ? `Fetching ${bulkProgress.done}/${bulkProgress.total}…`
                      : 'Fetching…'
                    : 'Fetch all PW sellers'}
                </button>
              )}
            </div>

            <div className="sku-table">
              <div className="sku-table__head">
                <div />
                <div className="col-head">Product</div>
                <div className="col-head">Type</div>
                <div className="col-head">Platform</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Price</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Rating</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Reviews</div>
                <div className="col-head">BSR</div>
                <div className="col-head">Stock</div>
                <div className="col-head">Changes</div>
                <div className="col-head">Last Seen</div>
                <div className="col-head" style={{ textAlign: 'right' }}>Actions</div>
              </div>

              {visible.map((c) => {
                const expanded = expandedId === c.id;
                return (
                  <ProductRow
                    key={c.id}
                    card={c}
                    expanded={expanded}
                    busy={busyIds.has(c.id)}
                    sellerBusy={sellerBusyIds.has(c.id)}
                    onToggle={() => setExpandedId(expanded ? null : c.id)}
                    onCheck={() => checkOne(c.id)}
                    onRefreshSellers={() => refreshSellers(c.id)}
                  />
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
                        onClick={() => setPageByBrand((s) => ({ ...s, [brand]: page + 1 }))}
                      >
                        Load {Math.min(PAGE_SIZE, list.length - visibleCount)} more
                      </button>
                    )}
                    {visibleCount < list.length && (
                      <button
                        className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                        onClick={() => setPageByBrand((s) => ({
                          ...s,
                          [brand]: Math.ceil(list.length / PAGE_SIZE),
                        }))}
                      >
                        Show all
                      </button>
                    )}
                    {visibleCount > PAGE_SIZE && (
                      <button
                        className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                        onClick={() => setPageByBrand((s) => ({ ...s, [brand]: 1 }))}
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

function ProductRow({
  card,
  expanded,
  busy,
  sellerBusy,
  onToggle,
  onCheck,
  onRefreshSellers,
}: {
  card: Card;
  expanded: boolean;
  busy: boolean;
  sellerBusy: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onRefreshSellers: () => void;
}) {
  const stockClass =
    card.in_stock === false ? 'chip chip-red'
    : card.in_stock === true ? 'chip chip-green'
    : 'chip';
  const stockLabel =
    card.in_stock === false ? 'Out'
    : card.in_stock === true ? 'In'
    : '—';

  const flagged = (Object.keys(card.changeFlags) as ChangeKind[]).filter((k) => card.changeFlags[k]);

  return (
    <>
      <button
        type="button"
        className={`sku-table__row ${expanded ? 'is-expanded' : ''}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="sku-table__caret" aria-hidden>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div className="sku-table__title">
          <div className="sku-table__title-text" title={card.title}>{card.title}</div>
          <div className="sku-table__sub">
            <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>{card.asin_or_sku}</span>
            {card.pools[0] && (
              <span className="text-[11px]" style={{ color: 'var(--faint)' }}>· {card.pools[0]}</span>
            )}
          </div>
        </div>

        <div>
          <span className={`chip ${card.is_own ? 'chip-blue' : ''}`}>
            {card.is_own ? 'PW' : card.brand}
          </span>
        </div>

        <div>
          <span className="chip-platform">{card.platform}</span>
        </div>

        <div className="sku-table__cell-num">{formatINR(card.price)}</div>

        <div className="sku-table__cell-num">
          {card.rating != null ? `★ ${card.rating.toFixed(1)}` : '—'}
        </div>

        <div className="sku-table__cell-num">
          {card.reviews != null ? card.reviews.toLocaleString('en-IN') : '—'}
        </div>

        <div className="sku-table__cell-mono" title={card.bsr ?? undefined}>
          {card.bsr ? card.bsr.replace(/^#?\s*/, '#') : '—'}
        </div>

        <div>
          <span className={stockClass}>{stockLabel}</span>
        </div>

        <div className="sku-table__changes">
          {flagged.length === 0 ? (
            <span className="text-[11px]" style={{ color: 'var(--faint)' }}>—</span>
          ) : (
            flagged.slice(0, 3).map((k) => {
              const ch = card.changeFlags[k]!;
              const ins = summarizeChange(ch);
              return (
                <span
                  key={k}
                  className={chipToneClass(ins.tone)}
                  title={`${ins.label}: ${ins.summary}`}
                >
                  {CHANGE_LABEL[k]}
                </span>
              );
            })
          )}
          {flagged.length > 3 && (
            <span className="text-[11px]" style={{ color: 'var(--faint)' }}>+{flagged.length - 3}</span>
          )}
        </div>

        <div className="sku-table__cell-text">{timeAgo(card.last_seen_at)}</div>

        <div className="sku-table__actions">
          <button
            className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onCheck(); }}
            title="Re-scan this SKU"
          >
            {busy ? '…' : 'Re-scan'}
          </button>
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            className="link-quiet text-[12px]"
            onClick={(e) => e.stopPropagation()}
            title="Open listing"
          >
            ↗
          </a>
        </div>
      </button>

      {expanded && (
        <div className="sku-table__expand">
          <Expanded card={card} sellerBusy={sellerBusy} onRefreshSellers={onRefreshSellers} />
        </div>
      )}
    </>
  );
}

function Expanded({
  card,
  sellerBusy,
  onRefreshSellers,
}: {
  card: Card;
  sellerBusy: boolean;
  onRefreshSellers: () => void;
}) {
  const sellers = [...card.sellers].sort((a, b) => {
    const pa = a.price ?? Number.POSITIVE_INFINITY;
    const pb = b.price ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  const lowestPrice = sellers.length && sellers[0].price != null ? sellers[0].price : null;

  return (
    <>
      {card.description && (
        <section className="space-y-2">
          <div className="kicker">Description</div>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {card.description.length > 480 ? `${card.description.slice(0, 480)}…` : card.description}
          </p>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="kicker">Recent changes</div>
          <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>{card.changes.length}</span>
        </div>
        {card.changes.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--muted)' }}>No detected changes since last scrape.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {card.changes.map((ch, i) => {
              const ins = summarizeChange(ch);
              return (
                <span
                  key={i}
                  className={`change-pill ${chipToneClass(ins.tone)}`}
                  title={`${ins.summary} · ${new Date(ch.detected_at).toLocaleString()}`}
                >
                  <span className="change-pill__label">{ins.label}</span>
                  <span className="change-pill__sep" aria-hidden>·</span>
                  <span className="change-pill__summary">{ins.summary}</span>
                  <span className="change-pill__time mono">{timeAgo(ch.detected_at)}</span>
                </span>
              );
            })}
          </div>
        )}
      </section>

      {card.is_own && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="kicker">Other sellers</div>
            <div className="flex items-center gap-3">
              <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>
                {sellers.length ? `${sellers.length} offer${sellers.length === 1 ? '' : 's'}` : 'none cached'}
              </span>
              {card.platform === 'amazon' && (
                <button
                  className="btn-ghost btn !py-[5px] !px-3 !text-[11px]"
                  onClick={(e) => { e.stopPropagation(); onRefreshSellers(); }}
                  disabled={sellerBusy}
                >
                  {sellerBusy ? 'Fetching…' : 'Refresh'}
                </button>
              )}
            </div>
          </div>

          {sellers.length === 0 ? (
            <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
              {card.platform === 'amazon'
                ? 'No seller offers cached. Click Refresh to scrape.'
                : 'Seller scraping is currently only supported for Amazon.'}
            </div>
          ) : (
            <div className="seller-list">
              {sellers.map((s, i) => {
                const isBest = lowestPrice != null && s.price === lowestPrice;
                return (
                  <div key={i} className={`seller-row ${isBest ? 'seller-row--best' : ''}`}>
                    <div className="seller-row__name">
                      <span className="serif text-[16px]" style={{ color: 'var(--ink)' }}>
                        {s.seller_name}
                      </span>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {s.is_fba && <span className="chip chip-blue">Fulfilled by Amazon</span>}
                        {s.prime_eligible && !s.is_fba && <span className="chip chip-blue">Prime</span>}
                        {s.condition && <span className="chip">{s.condition}</span>}
                        {isBest && <span className="chip chip-green">Lowest</span>}
                      </div>
                    </div>
                    <div className="seller-row__price mono">{formatINR(s.price)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </>
  );
}
