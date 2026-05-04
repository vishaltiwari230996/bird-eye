import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';

interface PoolProduct {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  is_own: boolean;
  last_seen_at: string | null;
  snapshot: { payload_json: any; fetched_at: string } | null;
}

interface Pool {
  id: number;
  name: string;
  notify_emails: string[] | null;
  created_at: string;
  products: PoolProduct[] | null;
}

function formatINR(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface CohortStat {
  pool: Pool;
  ownCount: number;
  fieldCount: number;
  total: number;
  avgPrice: number | null;
  avgRating: number | null;
  totalReviews: number;
  pwAvgPrice: number | null;
  fieldAvgPrice: number | null;
  latest: string | null;
}

function computeStat(pool: Pool): CohortStat {
  const products = pool.products ?? [];
  const own = products.filter((p) => p.is_own);
  const field = products.filter((p) => !p.is_own);
  const prices: number[] = [];
  const ratings: number[] = [];
  const ownPrices: number[] = [];
  const fieldPrices: number[] = [];
  let totalReviews = 0;
  let latest: string | null = null;

  for (const p of products) {
    const payload = p.snapshot?.payload_json ?? {};
    const price = payload.price != null ? Number(payload.price) : null;
    const rating = payload.rating != null ? Number(payload.rating) : null;
    const reviews = payload.reviewCount != null ? Number(payload.reviewCount) : 0;
    if (price != null && !Number.isNaN(price)) {
      prices.push(price);
      if (p.is_own) ownPrices.push(price);
      else fieldPrices.push(price);
    }
    if (rating != null && !Number.isNaN(rating)) ratings.push(rating);
    if (!Number.isNaN(reviews)) totalReviews += reviews;
    if (p.last_seen_at && (!latest || p.last_seen_at > latest)) latest = p.last_seen_at;
  }

  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  return {
    pool,
    ownCount: own.length,
    fieldCount: field.length,
    total: products.length,
    avgPrice: avg(prices),
    avgRating: avg(ratings),
    totalReviews,
    pwAvgPrice: avg(ownPrices),
    fieldAvgPrice: avg(fieldPrices),
    latest,
  };
}

export default function Cohorts() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/api/pools');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Pool[] = await res.json();
        setPools(data);
        if (data.length) setActive(data[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const stats = useMemo(() => pools.map(computeStat), [pools]);
  const activeStat = useMemo(() => stats.find((s) => s.pool.id === active) ?? null, [stats, active]);

  return (
    <div className="space-y-12">
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">Competitive Sets</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            Cohorts
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Each cohort gathers a PW SKU and the field it competes with — read the gap at a glance.
          </p>
        </div>
      </section>

      {loading && <div className="panel p-10 text-center" style={{ color: 'var(--muted)' }}>Loading cohorts…</div>}
      {error && !loading && <div className="panel p-6" style={{ color: 'var(--accent-red)' }}>{error}</div>}

      {!loading && !pools.length && !error && (
        <div className="panel p-10 text-center space-y-2">
          <div className="kicker">Empty</div>
          <p className="serif text-[28px]" style={{ color: 'var(--ink)' }}>No cohorts defined.</p>
        </div>
      )}

      {!loading && pools.length > 0 && (
        <>
          <section className="card-grid">
            {stats.map((s) => {
              const gap =
                s.pwAvgPrice != null && s.fieldAvgPrice != null && s.fieldAvgPrice > 0
                  ? ((s.pwAvgPrice - s.fieldAvgPrice) / s.fieldAvgPrice) * 100
                  : null;
              const isActive = active === s.pool.id;
              return (
                <button
                  key={s.pool.id}
                  className={`cohort-card ${isActive ? 'active' : ''}`}
                  onClick={() => setActive(s.pool.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="kicker">Cohort</div>
                    <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>#{s.pool.id}</span>
                  </div>
                  <div className="serif text-[26px] leading-tight" style={{ color: 'var(--ink)' }}>
                    {s.pool.name}
                  </div>

                  <div className="cohort-card__split">
                    <div>
                      <div className="kicker">PW</div>
                      <div className="metric-val">{s.ownCount}</div>
                    </div>
                    <div>
                      <div className="kicker">Field</div>
                      <div className="metric-val">{s.fieldCount}</div>
                    </div>
                    <div>
                      <div className="kicker">Avg Price</div>
                      <div className="metric-val">{formatINR(s.avgPrice)}</div>
                    </div>
                    <div>
                      <div className="kicker">Avg ★</div>
                      <div className="metric-val">{s.avgRating ? s.avgRating.toFixed(2) : '—'}</div>
                    </div>
                  </div>

                  {gap != null && (
                    <div className="text-[12px]" style={{ color: gap > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      PW priced {gap > 0 ? '+' : ''}{gap.toFixed(1)}% vs. field
                    </div>
                  )}
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    Last seen {timeAgo(s.latest)}
                  </div>
                </button>
              );
            })}
          </section>

          {activeStat && (
            <section className="space-y-4">
              <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                  <div className="kicker">Cohort detail</div>
                  <h2 className="serif text-[40px]" style={{ color: 'var(--ink)' }}>{activeStat.pool.name}</h2>
                </div>
                <div className="metric-strip">
                  <div><div className="kicker">PW SKUs</div><div className="metric-val">{activeStat.ownCount}</div></div>
                  <div><div className="kicker">Field</div><div className="metric-val">{activeStat.fieldCount}</div></div>
                  <div><div className="kicker">Reviews</div><div className="metric-val">{activeStat.totalReviews.toLocaleString('en-IN')}</div></div>
                </div>
              </div>

              <div className="space-y-3">
                <div
                  className="grid items-center gap-6 px-6 py-2"
                  style={{ gridTemplateColumns: '90px 80px minmax(0,2.5fr) 130px 110px 110px 130px' }}
                >
                  <div className="col-head">Side</div>
                  <div className="col-head">Platform</div>
                  <div className="col-head">Product</div>
                  <div className="col-head">Price</div>
                  <div className="col-head">Rating</div>
                  <div className="col-head">Reviews</div>
                  <div className="col-head">Last Seen</div>
                </div>

                {(activeStat.pool.products ?? []).map((p) => {
                  const payload = p.snapshot?.payload_json ?? {};
                  const title = payload.title || p.title_known || p.asin_or_sku;
                  const price = payload.price != null ? Number(payload.price) : null;
                  const rating = payload.rating != null ? Number(payload.rating) : null;
                  const reviews = payload.reviewCount != null ? Number(payload.reviewCount) : null;
                  return (
                    <article key={p.id} className="row-card">
                      <div
                        className="grid items-center gap-6 px-6 py-4"
                        style={{ gridTemplateColumns: '90px 80px minmax(0,2.5fr) 130px 110px 110px 130px' }}
                      >
                        <div>
                          <span className={p.is_own ? 'chip chip-blue' : 'chip'}>{p.is_own ? 'PW' : 'Field'}</span>
                        </div>
                        <div><span className="chip-platform">{p.platform}</span></div>
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="serif text-[18px] truncate no-underline"
                          style={{ color: 'var(--ink)' }}
                          title={title}
                        >
                          {title}
                        </a>
                        <div className="mono text-[14px]">{formatINR(price)}</div>
                        <div className="text-[14px]">{rating != null ? `★ ${rating.toFixed(1)}` : '—'}</div>
                        <div className="mono text-[13px]" style={{ color: 'var(--ink-soft)' }}>
                          {reviews != null ? reviews.toLocaleString('en-IN') : '—'}
                        </div>
                        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{timeAgo(p.last_seen_at)}</div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
