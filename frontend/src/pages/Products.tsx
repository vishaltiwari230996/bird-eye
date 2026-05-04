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

interface Card {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title: string;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  in_stock: boolean | null;
  image: string | null;
  last_seen_at: string | null;
  changes: RecentChange[];
  insights: ChangeInsight[];
  pools: string[];
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

function pickImage(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload.image === 'string' && payload.image) return payload.image;
  if (typeof payload.imageUrl === 'string') return payload.imageUrl;
  if (Array.isArray(payload.images) && payload.images.length) return String(payload.images[0]);
  if (Array.isArray(payload.image_urls) && payload.image_urls.length) return String(payload.image_urls[0]);
  return null;
}

export default function Products() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<'all' | 'amazon' | 'flipkart'>('all');
  const [busyAll, setBusyAll] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [sellerBusyIds, setSellerBusyIds] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const buildCards = (pools: Pool[], products: ProductFull[]): Card[] => {
    const ownIds = new Set<number>();
    const poolNamesById = new Map<number, string[]>();
    for (const pool of pools) {
      for (const pp of pool.products ?? []) {
        if (pp.is_own) {
          ownIds.add(pp.id);
          const arr = poolNamesById.get(pp.id) ?? [];
          arr.push(pool.name);
          poolNamesById.set(pp.id, arr);
        }
      }
    }
    return products
      .filter((p) => ownIds.has(p.id))
      .map((p) => {
        const payload = p.last_snapshot?.payload_json ?? {};
        const title = payload.title || p.title_known || p.asin_or_sku;
        const price = payload.price != null ? Number(payload.price) : null;
        const rating = payload.rating != null ? Number(payload.rating) : null;
        const reviews = payload.reviewCount != null ? Number(payload.reviewCount) : null;
        const inStock =
          typeof payload.inStock === 'boolean'
            ? payload.inStock
            : typeof payload.in_stock === 'boolean'
            ? payload.in_stock
            : null;
        const changes = p.recent_changes ?? [];
        const insights = changes.slice(0, 3).map(summarizeChange);
        return {
          id: p.id,
          platform: p.platform,
          asin_or_sku: p.asin_or_sku,
          url: p.url,
          title,
          price,
          rating,
          reviews,
          in_stock: inStock,
          image: pickImage(payload),
          last_seen_at: p.last_seen_at,
          changes,
          insights,
          pools: poolNamesById.get(p.id) ?? [],
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

  const checkAll = async () => {
    if (!cards.length) return;
    setBusyAll(true);
    try {
      await api.post('/api/run-check', { batch: cards.map((c) => c.id) });
      await load();
    } finally {
      setBusyAll(false);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter((c) => {
      if (platform !== 'all' && c.platform !== platform) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.asin_or_sku.toLowerCase().includes(q) ||
        c.pools.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [cards, search, platform]);

  const stats = useMemo(() => {
    const prices = cards.map((c) => c.price).filter((v): v is number => v != null);
    const ratings = cards.map((c) => c.rating).filter((v): v is number => v != null);
    return {
      total: cards.length,
      avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      withChange: cards.filter((c) => c.insights.length).length,
    };
  }, [cards]);

  return (
    <div className="space-y-12">
      {/* HERO */}
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">PW Catalogue</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            Products
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Every SKU under our watch — captured as it shifts, priced as it stands.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="metric-strip">
            <div><div className="kicker">SKUs</div><div className="metric-val">{stats.total}</div></div>
            <div><div className="kicker">Avg Price</div><div className="metric-val">{formatINR(stats.avgPrice)}</div></div>
            <div><div className="kicker">Avg Rating</div><div className="metric-val">{stats.avgRating ? `★ ${stats.avgRating.toFixed(2)}` : '—'}</div></div>
            <div><div className="kicker">Moving</div><div className="metric-val">{stats.withChange}</div></div>
          </div>
          <button className="btn btn-primary" onClick={checkAll} disabled={busyAll}>
            {busyAll ? 'Checking…' : 'Check All'}
          </button>
        </div>
      </section>

      {/* FILTERS */}
      <section className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {(['all', 'amazon', 'flipkart'] as const).map((k) => (
            <button
              key={k}
              className={`pill ${platform === k ? 'active' : ''}`}
              onClick={() => setPlatform(k)}
            >
              {k}
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
            placeholder="Search SKU, title, or cohort…"
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
          <p className="serif text-[28px]" style={{ color: 'var(--ink)' }}>No PW SKUs match.</p>
          <p style={{ color: 'var(--muted)' }}>Adjust filters or add products in a pool marked as own.</p>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <section className="card-grid">
          {filtered.map((c) => {
            const busy = busyIds.has(c.id);
            const expanded = expandedId === c.id;
            const sellerBusy = sellerBusyIds.has(c.id);
            return (
              <article
                key={c.id}
                className={`sku-card ${expanded ? 'sku-card--expanded' : ''}`}
              >
                <button
                  type="button"
                  className="sku-card__head"
                  onClick={() => setExpandedId(expanded ? null : c.id)}
                  aria-expanded={expanded}
                >
                  <div className="sku-card__media">
                    {c.image ? (
                      <img src={c.image} alt={c.title} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="sku-card__placeholder">
                        <span className="serif text-[32px]" style={{ color: 'var(--faint)' }}>{c.platform[0]?.toUpperCase()}</span>
                      </div>
                    )}
                    <span className="sku-card__platform">{c.platform}</span>
                    {c.in_stock === false && <span className="sku-card__oos">Out of stock</span>}
                  </div>

                  <div className="sku-card__body">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>{c.asin_or_sku}</span>
                      <span className="text-[11px]" style={{ color: 'var(--faint)' }}>{timeAgo(c.last_seen_at)}</span>
                    </div>

                    <div
                      className="serif text-[20px] leading-tight sku-card__title"
                      style={{ color: 'var(--ink)' }}
                      title={c.title}
                    >
                      {c.title}
                    </div>

                    <div className="flex items-baseline justify-between gap-3">
                      <div className="mono text-[20px]" style={{ color: 'var(--ink)' }}>{formatINR(c.price)}</div>
                      <div className="text-[13px]" style={{ color: 'var(--ink-soft)' }}>
                        {c.rating != null ? <>★ {c.rating.toFixed(1)}</> : '—'}
                        <span className="mono ml-2 text-[12px]" style={{ color: 'var(--faint)' }}>
                          {c.reviews != null ? c.reviews.toLocaleString('en-IN') : '—'}
                        </span>
                      </div>
                    </div>

                    {c.insights.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.insights.map((ins, i) => (
                          <span key={i} className={chipToneClass(ins.tone)} title={ins.summary}>
                            {ins.label}
                          </span>
                        ))}
                      </div>
                    )}

                    {c.pools.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.pools.slice(0, 3).map((p) => (
                          <span key={p} className="chip-platform">{p}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>

                <div className="sku-card__foot">
                  <button
                    className="btn-ghost btn !py-[6px] !px-3 !text-[12px]"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); checkOne(c.id); }}
                  >
                    {busy ? '…' : 'Check'}
                  </button>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="link-quiet text-[12px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open ↗
                  </a>
                  <span className="ml-auto text-[11px]" style={{ color: 'var(--faint)' }}>
                    {expanded ? 'Click to collapse' : 'Click to expand'}
                  </span>
                </div>

                {expanded && (
                  <Expanded
                    card={c}
                    sellerBusy={sellerBusy}
                    onRefreshSellers={() => refreshSellers(c.id)}
                  />
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
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
    <div className="sku-card__expand">
      {/* Changes */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="kicker">Recent changes</div>
          <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>{card.changes.length}</span>
        </div>
        {card.changes.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--muted)' }}>No detected changes yet.</div>
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

      {/* Sellers */}
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
              ? 'No seller offers cached. Click Refresh to scrape the offer-listing page.'
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
    </div>
  );
}
