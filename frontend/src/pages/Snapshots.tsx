import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, API_URL } from '@/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapshotItem {
  product_id: number;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  is_own: boolean | null;
  pool_id: number | null;
  snapshot_id: number | null;
  title: string | null;
  price: number | string | null;
  mrp: number | string | null;
  stock_status: 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown' | null;
  stock_message: string | null;
  status: 'ok' | 'error' | null;
  error: string | null;
  width: number | null;
  height: number | null;
  fetched_at: string | null;
  image_size: number | null;
}

interface SnapshotsResponse {
  items: SnapshotItem[];
  count: number;
}

interface RefreshEvent {
  total?: number;
  done?: number;
  started?: boolean;
  finished?: boolean;
  ok?: number;
  errors?: number;
  productId?: number;
  asin?: string;
  status?: string;
  error?: string;
  stockStatus?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STOCK_META: Record<
  NonNullable<SnapshotItem['stock_status']>,
  { label: string; cls: string }
> = {
  in_stock: { label: 'In stock', cls: 'chip chip-green' },
  low_stock: { label: 'Low stock', cls: 'chip chip-amber' },
  out_of_stock: { label: 'Out of stock', cls: 'chip chip-red' },
  unknown: { label: 'Unknown', cls: 'chip' },
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'never';
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 30) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function formatINR(v: number | string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function discountPct(price: number | string | null, mrp: number | string | null): number | null {
  const p = typeof price === 'string' ? Number(price) : price;
  const m = typeof mrp === 'string' ? Number(mrp) : mrp;
  if (!p || !m || !Number.isFinite(p) || !Number.isFinite(m) || m <= p) return null;
  return Math.round(((m - p) / m) * 100);
}

// Cache-bust URLs by appending the snapshot id so a refresh forces a reload.
function imageUrl(item: SnapshotItem): string {
  return `${API_URL}/api/snapshots/${item.product_id}/image?v=${item.snapshot_id ?? 0}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Snapshots() {
  const [items, setItems] = useState<SnapshotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshLog, setRefreshLog] = useState<RefreshEvent | null>(null);
  const [refreshingOne, setRefreshingOne] = useState<Set<number>>(new Set());
  const refreshAborted = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/snapshots?limit=60');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: SnapshotsResponse = await res.json();
      setItems(json.items || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load snapshots');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Soft refresh every 5 min so newly-arrived cron screenshots show up
    // without a hard reload.
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  // ── Refresh-all (SSE) ───────────────────────────────────────────────────────
  const handleRefreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshLog({ started: true, total: 0, done: 0 });
    refreshAborted.current = false;

    try {
      const res = await api.postStream('/api/snapshots/refresh-all?limit=60');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!refreshAborted.current) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() ?? '';
        for (const block of lines) {
          const line = block.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const evt: RefreshEvent = JSON.parse(line.slice(5).trim());
            setRefreshLog(evt);
            if (evt.productId && evt.status) {
              // Optimistically reload after each item so the user sees images
              // pop in instead of waiting until the end.
              load();
            }
          } catch {
            /* swallow malformed SSE chunk */
          }
        }
      }
    } catch (e) {
      setRefreshLog({ finished: true, errors: 1 });
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
      load();
    }
  };

  // ── Refresh-one ─────────────────────────────────────────────────────────────
  const handleRefreshOne = async (productId: number) => {
    if (refreshingOne.has(productId)) return;
    setRefreshingOne((prev) => new Set(prev).add(productId));
    try {
      await api.post(`/api/snapshots/refresh/${productId}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Single refresh failed');
    } finally {
      setRefreshingOne((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const haystack =
        `${it.title || ''} ${it.title_known || ''} ${it.asin_or_sku}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [items, search]);

  const stats = useMemo(() => {
    const total = items.length;
    let withImage = 0;
    let inStock = 0;
    let outOfStock = 0;
    let lowStock = 0;
    let stale = 0;
    const now = Date.now();
    for (const it of items) {
      if (it.snapshot_id) withImage++;
      if (it.stock_status === 'in_stock') inStock++;
      if (it.stock_status === 'out_of_stock') outOfStock++;
      if (it.stock_status === 'low_stock') lowStock++;
      if (it.fetched_at) {
        const age = now - new Date(it.fetched_at).getTime();
        if (age > 90 * 60 * 1000) stale++;
      } else {
        stale++;
      }
    }
    return { total, withImage, inStock, outOfStock, lowStock, stale };
  }, [items]);

  const lastRefreshAt = useMemo(() => {
    const ts = items
      .map((i) => i.fetched_at)
      .filter((t): t is string => !!t)
      .sort()
      .pop();
    return ts ? timeAgo(ts) : 'no captures yet';
  }, [items]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-7">
      {/* Header */}
      <header className="flex items-end justify-between gap-6 flex-wrap">
        <div>
          <div className="kicker mb-1">Snapshots</div>
          <h1 className="serif text-[34px] leading-tight" style={{ color: 'var(--ink)' }}>
            Hourly page screenshots
          </h1>
          <p className="mt-1 text-[13.5px]" style={{ color: 'var(--muted)' }}>
            Live captures of each PW SKU's Amazon product page — what a customer sees, refreshed every hour.
            Stock status is parsed straight from the buy-box.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Last capture · <strong style={{ color: 'var(--ink)' }}>{lastRefreshAt}</strong>
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRefreshAll}
            disabled={refreshing}
            style={{ padding: '10px 18px' }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh all now'}
          </button>
        </div>
      </header>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Tracked SKUs" value={stats.total} tone="ink" />
        <StatCard label="With snapshot" value={stats.withImage} tone="ink" />
        <StatCard label="In stock" value={stats.inStock} tone="green" />
        <StatCard label="Low / out" value={stats.lowStock + stats.outOfStock} tone="red" />
        <StatCard label="Stale (> 90 min)" value={stats.stale} tone="amber" />
      </div>

      {/* SSE progress */}
      {refreshing && refreshLog && (refreshLog.total ?? 0) > 0 && (
        <div className="rounded-2xl border px-5 py-4" style={{ borderColor: 'var(--line)', background: 'rgba(255, 252, 244, 0.7)' }}>
          <div className="flex items-center justify-between text-[12.5px] mb-2" style={{ color: 'var(--muted)' }}>
            <span>
              Capturing screenshot {refreshLog.done ?? 0} of {refreshLog.total} ·{' '}
              {refreshLog.asin ? <span style={{ color: 'var(--ink)' }}>{refreshLog.asin}</span> : '…'}
            </span>
            <span>{Math.round(((refreshLog.done ?? 0) / (refreshLog.total || 1)) * 100)}%</span>
          </div>
          <div style={{ height: 6, background: 'rgba(28, 24, 18, 0.08)', borderRadius: 999, overflow: 'hidden' }}>
            <div
              style={{
                width: `${((refreshLog.done ?? 0) / (refreshLog.total || 1)) * 100}%`,
                height: '100%',
                background: 'var(--ink)',
                transition: 'width 200ms ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="search-wrap flex-1">
          <input
            type="search"
            placeholder="Search by title or ASIN…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="kicker">
          {filtered.length} of {items.length}
        </span>
      </div>

      {/* Body */}
      {loading && <div className="text-center py-12 kicker">Loading snapshots…</div>}
      {error && !loading && (
        <div className="rounded-xl border px-4 py-3" style={{ borderColor: '#e3b2b2', background: '#fff5f5', color: '#7c2d2d' }}>
          {error}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="rounded-2xl border px-6 py-10 text-center" style={{ borderColor: 'var(--line)', background: 'rgba(255, 252, 244, 0.5)' }}>
          <div className="kicker mb-2">No snapshots yet</div>
          <p className="text-[13.5px]" style={{ color: 'var(--muted)' }}>
            Mark PW SKUs as <code>is_own=true</code> in the database, then hit <strong>Refresh all now</strong>{' '}
            to take the first round of page screenshots.
          </p>
        </div>
      )}

      <div className="card-grid">
        {filtered.map((item) => {
          const stock = item.stock_status ? STOCK_META[item.stock_status] : null;
          const isRefreshingThis = refreshingOne.has(item.product_id);
          const disc = discountPct(item.price, item.mrp);

          return (
            <article key={item.product_id} className="sku-card" style={{ overflow: 'hidden' }}>
              {/* Media */}
              <div
                className="sku-card__media"
                style={{ aspectRatio: 'auto', height: 280, background: '#ffffff' }}
              >
                {item.snapshot_id ? (
                  <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'block', height: '100%' }}>
                    <img
                      src={imageUrl(item)}
                      alt={item.title || item.asin_or_sku}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }}
                    />
                  </a>
                ) : (
                  <div className="sku-card__placeholder">
                    <span className="kicker">No snapshot yet</span>
                  </div>
                )}
                {stock && (
                  <span
                    className={stock.cls}
                    style={{ position: 'absolute', top: 10, left: 10, fontSize: 11.5 }}
                  >
                    {stock.label}
                  </span>
                )}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="chip"
                  style={{ position: 'absolute', top: 10, right: 10, fontSize: 11, textDecoration: 'none' }}
                >
                  Open ↗
                </a>
              </div>

              {/* Body */}
              <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--faint)' }}>
                  <span>{item.asin_or_sku}</span>
                  <span>·</span>
                  <span>{timeAgo(item.fetched_at)}</span>
                </div>
                <div
                  className="text-[13.5px] font-medium"
                  style={{
                    color: 'var(--ink)',
                    lineHeight: 1.35,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                  title={item.title || item.title_known || ''}
                >
                  {item.title || item.title_known || 'Untitled'}
                </div>

                {/* Price row */}
                <div className="flex items-baseline gap-2">
                  <span className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>
                    {formatINR(item.price)}
                  </span>
                  {item.mrp != null && Number(item.mrp) > 0 && (
                    <span className="text-[12px]" style={{ color: 'var(--faint)', textDecoration: 'line-through' }}>
                      {formatINR(item.mrp)}
                    </span>
                  )}
                  {disc != null && (
                    <span className="chip chip-green" style={{ fontSize: 10.5 }}>
                      −{disc}%
                    </span>
                  )}
                </div>

                {/* Stock message */}
                {item.stock_message && (
                  <div
                    className="text-[12px]"
                    style={{
                      color: item.stock_status === 'out_of_stock' ? '#7c2d2d' : 'var(--muted)',
                      lineHeight: 1.4,
                    }}
                    title={item.stock_message}
                  >
                    {item.stock_message.length > 90
                      ? item.stock_message.slice(0, 90) + '…'
                      : item.stock_message}
                  </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between mt-1 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                  <span className="kicker">
                    {item.status === 'error' ? `error: ${item.error || 'unknown'}` : 'live'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleRefreshOne(item.product_id)}
                    disabled={isRefreshingThis || refreshing}
                    style={{ padding: '6px 10px', fontSize: 11.5 }}
                  >
                    {isRefreshingThis ? 'Capturing…' : 'Refresh'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ─── Bits ─────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ink' | 'green' | 'red' | 'amber';
}) {
  const colorMap: Record<typeof tone, string> = {
    ink: 'var(--ink)',
    green: '#1f6a3b',
    red: '#9c2a2a',
    amber: '#8a5a08',
  };
  return (
    <div
      className="rounded-2xl border px-4 py-3"
      style={{ borderColor: 'var(--line)', background: 'rgba(255, 252, 244, 0.55)' }}
    >
      <div className="kicker">{label}</div>
      <div className="text-[26px] font-semibold mt-1" style={{ color: colorMap[tone] }}>
        {value}
      </div>
    </div>
  );
}
