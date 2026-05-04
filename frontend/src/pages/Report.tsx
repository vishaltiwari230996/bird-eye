import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';
import { summarizeChange } from '@/lib/change-intel';

interface PoolStat {
  pool_id: number;
  pool_name: string;
  product_count: number;
  avg_price: number | null;
  avg_rating: number | null;
  total_reviews: number | null;
  in_stock_count: number;
  aplus_count: number;
  avg_bullet_count: number | null;
  avg_image_count: number | null;
  latest_fetched_at: string | null;
  is_own_pool: boolean;
  change_count: number;
  price_drops: number;
  price_hikes: number;
  rating_improved: number;
  rating_dropped: number;
}

interface RecentChange {
  field: string;
  old_value: string;
  new_value: string;
  detected_at: string;
}

interface Product {
  id: number;
  platform: string;
  asin_or_sku: string;
  title_known: string | null;
  url: string;
  last_snapshot: { payload_json: any } | null;
  recent_changes: RecentChange[] | null;
}

type SinceKey = '24h' | '7d' | '30d';

function formatINR(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
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

export default function Report() {
  const [since, setSince] = useState<SinceKey>('7d');
  const [stats, setStats] = useState<PoolStat[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [bRes, pRes] = await Promise.all([
          api.get(`/api/battleground?since=${since}`),
          api.get('/api/products'),
        ]);
        if (!bRes.ok) throw new Error(`HTTP ${bRes.status}`);
        if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
        setStats(await bRes.json());
        setProducts(await pRes.json());
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [since]);

  const totals = useMemo(() => {
    const own = stats.filter((s) => s.is_own_pool);
    const field = stats.filter((s) => !s.is_own_pool);
    const sum = (arr: PoolStat[], k: keyof PoolStat) => arr.reduce((a, b) => a + (Number(b[k]) || 0), 0);
    return {
      ownProducts: sum(own, 'product_count'),
      fieldProducts: sum(field, 'product_count'),
      ownChanges: sum(own, 'change_count'),
      fieldChanges: sum(field, 'change_count'),
      ownPriceDrops: sum(own, 'price_drops'),
      ownPriceHikes: sum(own, 'price_hikes'),
      fieldPriceDrops: sum(field, 'price_drops'),
      fieldPriceHikes: sum(field, 'price_hikes'),
      ownRatingUp: sum(own, 'rating_improved'),
      ownRatingDown: sum(own, 'rating_dropped'),
    };
  }, [stats]);

  const cutoffMs = useMemo(() => {
    const ms: Record<SinceKey, number> = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
    return Date.now() - ms[since];
  }, [since]);

  const timeline = useMemo(() => {
    const events: { product: Product; change: RecentChange }[] = [];
    for (const p of products) {
      for (const c of p.recent_changes ?? []) {
        if (new Date(c.detected_at).getTime() >= cutoffMs) events.push({ product: p, change: c });
      }
    }
    events.sort((a, b) => new Date(b.change.detected_at).getTime() - new Date(a.change.detected_at).getTime());
    return events.slice(0, 40);
  }, [products, cutoffMs]);

  return (
    <div className="space-y-12">
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">Period Brief</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            Report
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            What moved, where it moved, and how PW stands against the field.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {(['24h', '7d', '30d'] as SinceKey[]).map((k) => (
            <button key={k} className={`pill ${since === k ? 'active' : ''}`} onClick={() => setSince(k)}>
              {k}
            </button>
          ))}
        </div>
      </section>

      {loading && <div className="panel p-10 text-center" style={{ color: 'var(--muted)' }}>Loading report…</div>}
      {error && !loading && <div className="panel p-6" style={{ color: 'var(--accent-red)' }}>{error}</div>}

      {!loading && !error && (
        <>
          {/* HEADLINE METRICS */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="stat-card">
              <div className="kicker">PW SKUs</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{totals.ownProducts}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>tracked</div>
            </div>
            <div className="stat-card">
              <div className="kicker">Field SKUs</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{totals.fieldProducts}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>tracked</div>
            </div>
            <div className="stat-card">
              <div className="kicker">PW Changes</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{totals.ownChanges}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>last {since}</div>
            </div>
            <div className="stat-card">
              <div className="kicker">Field Changes</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{totals.fieldChanges}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>last {since}</div>
            </div>
          </section>

          {/* PRICE / RATING MOVEMENTS */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="panel p-6 space-y-4">
              <div className="kicker">Price Movement</div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="kicker">PW</div>
                  <div className="text-[14px] mt-2 space-y-1">
                    <div><span style={{ color: 'var(--accent-green)' }}>↓ {totals.ownPriceDrops}</span> drops</div>
                    <div><span style={{ color: 'var(--accent-red)' }}>↑ {totals.ownPriceHikes}</span> hikes</div>
                  </div>
                </div>
                <div>
                  <div className="kicker">Field</div>
                  <div className="text-[14px] mt-2 space-y-1">
                    <div><span style={{ color: 'var(--accent-green)' }}>↓ {totals.fieldPriceDrops}</span> drops</div>
                    <div><span style={{ color: 'var(--accent-red)' }}>↑ {totals.fieldPriceHikes}</span> hikes</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="panel p-6 space-y-4">
              <div className="kicker">PW Rating Movement</div>
              <div className="text-[14px] mt-2 space-y-1">
                <div><span style={{ color: 'var(--accent-green)' }}>↑ {totals.ownRatingUp}</span> improved</div>
                <div><span style={{ color: 'var(--accent-red)' }}>↓ {totals.ownRatingDown}</span> declined</div>
              </div>
            </div>
          </section>

          {/* COHORT TABLE */}
          <section className="space-y-3">
            <div className="kicker">By cohort</div>
            <div
              className="grid items-center gap-6 px-6 py-2"
              style={{ gridTemplateColumns: 'minmax(0,2fr) 80px 90px 110px 110px 130px 130px' }}
            >
              <div className="col-head">Cohort</div>
              <div className="col-head">Side</div>
              <div className="col-head">SKUs</div>
              <div className="col-head">Avg Price</div>
              <div className="col-head">Avg ★</div>
              <div className="col-head">Changes</div>
              <div className="col-head">Last Seen</div>
            </div>
            {stats.map((s) => (
              <article key={s.pool_id} className="row-card">
                <div
                  className="grid items-center gap-6 px-6 py-4"
                  style={{ gridTemplateColumns: 'minmax(0,2fr) 80px 90px 110px 110px 130px 130px' }}
                >
                  <div className="serif text-[18px] truncate" style={{ color: 'var(--ink)' }}>{s.pool_name}</div>
                  <div><span className={s.is_own_pool ? 'chip chip-blue' : 'chip'}>{s.is_own_pool ? 'PW' : 'Field'}</span></div>
                  <div className="mono text-[14px]">{s.product_count}</div>
                  <div className="mono text-[14px]">{formatINR(s.avg_price)}</div>
                  <div className="text-[14px]">{s.avg_rating != null ? `★ ${Number(s.avg_rating).toFixed(2)}` : '—'}</div>
                  <div className="mono text-[14px]" style={{ color: 'var(--ink-soft)' }}>{s.change_count}</div>
                  <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{timeAgo(s.latest_fetched_at)}</div>
                </div>
              </article>
            ))}
          </section>

          {/* TIMELINE */}
          <section className="space-y-3">
            <div className="kicker">Activity timeline</div>
            {!timeline.length ? (
              <div className="panel p-6 text-center" style={{ color: 'var(--muted)' }}>No changes detected in this window.</div>
            ) : (
              <div className="timeline">
                {timeline.map((e, i) => {
                  const ins = summarizeChange(e.change);
                  const title = e.product.last_snapshot?.payload_json?.title || e.product.title_known || e.product.asin_or_sku;
                  return (
                    <div key={i} className="timeline__row">
                      <div className="timeline__time mono">{timeAgo(e.change.detected_at)}</div>
                      <div className="timeline__dot" />
                      <div className="timeline__body">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`chip ${ins.tone === 'green' ? 'chip-green' : ins.tone === 'red' ? 'chip-red' : ins.tone === 'amber' ? 'chip-amber' : 'chip-blue'}`}>{ins.label}</span>
                          <span className="serif text-[16px]" style={{ color: 'var(--ink)' }}>{title}</span>
                        </div>
                        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{ins.summary}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
