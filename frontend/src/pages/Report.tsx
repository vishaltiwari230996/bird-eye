import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';

type SinceKey = '24h' | '7d' | '30d';

interface Headline {
  pwCount: number;
  competitorCount: number;
  movements: number;
  hijacksActive: number;
  since: string;
}

interface Movement {
  productId: number;
  asin: string;
  url: string;
  title: string;
  brand: string;
  isOwn: boolean;
  cohort: string;
  field: string;
  category: string;
  label: string;
  summary: string;
  tone: 'green' | 'red' | 'amber' | 'blue' | 'gray';
  score: number;
  detectedAt: string | null;
}

interface BrandEntry {
  brand: string;
  skuCount: number;
  avgPrice: number | null;
  minPrice: number | null;
  avgBsr: number | null;
}

interface BattlegroundCohort {
  cohort: string;
  brands: BrandEntry[];
  verdict: string;
}

interface Hijack {
  productId: number;
  asin: string;
  url: string;
  title: string;
  buyboxSeller: string | null;
  buyboxPrice: number | null;
  isPwBuybox: boolean;
  sellerCount: number;
  lowestCompetitor: string | null;
  lowestCompetitorPrice: number | null;
  pwPrice: number | null;
  undercutBy: number | null;
  severity: 'high' | 'ok';
}

interface SeriesPoint {
  date: string;
  value: number | null;
}

interface ReportPayload {
  headline: Headline;
  movements: Movement[];
  battleground: BattlegroundCohort[];
  hijacks: Hijack[];
  trends: {
    pwPrice: SeriesPoint[];
    competitorPrice: SeriesPoint[];
    activity: SeriesPoint[];
  };
  aiSummary: string;
  generatedAt: number;
  cached: boolean;
  cacheAge: number;
}

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

function toneClass(tone: Movement['tone']): string {
  switch (tone) {
    case 'green': return 'chip chip-green';
    case 'red': return 'chip chip-red';
    case 'amber': return 'chip chip-amber';
    case 'blue': return 'chip chip-blue';
    default: return 'chip';
  }
}

function Sparkline({ data, color = 'var(--ink)', height = 44 }: { data: SeriesPoint[]; color?: string; height?: number }) {
  const points = data.filter((d): d is { date: string; value: number } => d.value != null);
  if (points.length < 2) {
    return <div className="text-[12px]" style={{ color: 'var(--faint)' }}>— insufficient data —</div>;
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 280;
  const h = height;
  const stepX = w / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - ((p.value - min) / range) * (h - 6) - 3;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const delta = last.value - first.value;
  const pct = first.value !== 0 ? (delta / first.value) * 100 : 0;
  const trendColor = delta < 0 ? 'var(--accent-green)' : delta > 0 ? 'var(--accent-red)' : 'var(--ink-soft)';
  return (
    <div className="flex items-end gap-3">
      <svg width={w} height={h} style={{ overflow: 'visible' }}>
        <path d={path} fill="none" stroke={color} strokeWidth="1.6" />
        <circle cx={(points.length - 1) * stepX} cy={h - ((last.value - min) / range) * (h - 6) - 3} r="2.6" fill={color} />
      </svg>
      <div className="text-[12px] mono" style={{ color: trendColor }}>
        {delta > 0 ? '▲' : delta < 0 ? '▼' : '▬'} {pct.toFixed(1)}%
      </div>
    </div>
  );
}

export default function Report() {
  const [since, setSince] = useState<SinceKey>('24h');
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movementFilter, setMovementFilter] = useState<'all' | 'price' | 'bsr' | 'content'>('all');

  const load = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await api.get(`/api/report?since=${since}${force ? '&refresh=true' : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [since]);

  const filteredMovements = useMemo(() => {
    if (!data) return [];
    if (movementFilter === 'all') return data.movements;
    return data.movements.filter((m) => {
      if (movementFilter === 'price') return m.category === 'price';
      if (movementFilter === 'bsr') return m.category === 'bsr';
      if (movementFilter === 'content') return m.category === 'content';
      return true;
    });
  }, [data, movementFilter]);

  return (
    <div className="space-y-12">
      {/* HERO */}
      <section className="flex items-end justify-between gap-10 flex-wrap">
        <div className="max-w-2xl space-y-4">
          <div className="kicker">Executive Briefing</div>
          <h1 className="serif text-[68px] leading-[0.95] tracking-tight" style={{ color: 'var(--ink)' }}>
            Report
          </h1>
          <p className="text-[16px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            What moved overnight. Where PW stands. What leadership should know first.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {(['24h', '7d', '30d'] as SinceKey[]).map((k) => (
            <button key={k} className={`pill ${since === k ? 'active' : ''}`} onClick={() => setSince(k)}>{k}</button>
          ))}
          <button
            className="btn"
            onClick={() => load(true)}
            disabled={refreshing}
            title="Force refresh (skip cache)"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </section>

      {loading && <div className="panel p-10 text-center" style={{ color: 'var(--muted)' }}>Compiling briefing…</div>}
      {error && !loading && <div className="panel p-6" style={{ color: 'var(--accent-red)' }}>{error}</div>}

      {data && !loading && (
        <>
          {/* HEADLINE STRIP */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="stat-card">
              <div className="kicker">PW SKUs</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{data.headline.pwCount}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>tracked</div>
            </div>
            <div className="stat-card">
              <div className="kicker">Competitor SKUs</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{data.headline.competitorCount}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>tracked</div>
            </div>
            <div className="stat-card">
              <div className="kicker">Movements</div>
              <div className="serif text-[42px]" style={{ color: 'var(--ink)' }}>{data.headline.movements}</div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>last {since}</div>
            </div>
            <div className="stat-card">
              <div className="kicker">Hijacks open</div>
              <div className="serif text-[42px]" style={{ color: data.headline.hijacksActive > 0 ? 'var(--accent-red)' : 'var(--ink)' }}>
                {data.headline.hijacksActive}
              </div>
              <div className="text-[12px]" style={{ color: 'var(--muted)' }}>need action</div>
            </div>
          </section>

          {/* AI SUMMARY */}
          {data.aiSummary && (
            <section className="panel p-7 space-y-4" style={{ borderColor: 'var(--line-strong)' }}>
              <div className="flex items-center justify-between">
                <div className="kicker">AI Briefing</div>
                <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
                  {data.cached ? `cached ${Math.floor(data.cacheAge / 60)}m ago` : 'fresh'}
                </span>
              </div>
              <ul className="space-y-3">
                {data.aiSummary.split('\n').filter((s) => s.trim()).map((line, i) => (
                  <li key={i} className="flex gap-3 items-start">
                    <span className="serif text-[20px]" style={{ color: 'var(--accent-amber, #d4a857)' }}>›</span>
                    <span className="text-[15px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
                      {line.replace(/^[-•›\d.\s]+/, '').trim()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* MOVEMENTS FEED */}
          <section className="space-y-4">
            <div className="flex items-end justify-between flex-wrap gap-3">
              <div>
                <div className="kicker">What changed</div>
                <h2 className="serif text-[32px] leading-tight" style={{ color: 'var(--ink)' }}>
                  Movements <span style={{ color: 'var(--faint)' }}>· {filteredMovements.length}</span>
                </h2>
              </div>
              <div className="flex gap-2 flex-wrap">
                {(['all', 'price', 'bsr', 'content'] as const).map((k) => (
                  <button
                    key={k}
                    className={`pill ${movementFilter === k ? 'active' : ''}`}
                    onClick={() => setMovementFilter(k)}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {filteredMovements.length === 0 ? (
              <div className="panel p-6 text-center" style={{ color: 'var(--muted)' }}>
                No movements in this window.
              </div>
            ) : (
              <div className="timeline">
                {filteredMovements.slice(0, 30).map((m, i) => (
                  <div key={i} className="timeline__row">
                    <div className="timeline__time mono">{timeAgo(m.detectedAt)}</div>
                    <div className="timeline__dot" />
                    <div className="timeline__body">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={toneClass(m.tone)}>{m.label}</span>
                        <span className={m.isOwn ? 'chip chip-blue' : 'chip'}>{m.brand}</span>
                        {m.cohort && <span className="chip-platform">{m.cohort}</span>}
                        <a href={m.url} target="_blank" rel="noreferrer" className="serif text-[16px] link-quiet" style={{ color: 'var(--ink)' }}>
                          {m.title.length > 70 ? `${m.title.slice(0, 70)}…` : m.title}
                        </a>
                      </div>
                      <div className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>{m.summary}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* COHORT BATTLEGROUND */}
          <section className="space-y-4">
            <div>
              <div className="kicker">Cohort battleground</div>
              <h2 className="serif text-[32px] leading-tight" style={{ color: 'var(--ink)' }}>
                PW vs the field
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {data.battleground.map((c) => (
                <article key={c.cohort} className="panel p-6 space-y-4">
                  <div className="flex items-baseline justify-between">
                    <h3 className="serif text-[22px]" style={{ color: 'var(--ink)' }}>{c.cohort}</h3>
                    <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>
                      {c.brands.reduce((a, b) => a + b.skuCount, 0)} SKUs
                    </span>
                  </div>
                  <div className="space-y-2">
                    {c.brands.map((b) => {
                      const pwBenchmark = c.brands.find((x) => x.brand === 'PW')?.avgPrice;
                      const isPw = b.brand === 'PW';
                      const cheaper = !isPw && pwBenchmark != null && b.avgPrice != null && b.avgPrice < pwBenchmark;
                      return (
                        <div key={b.brand} className="flex items-center justify-between gap-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
                          <div className="flex items-center gap-2">
                            <span className={isPw ? 'chip chip-blue' : 'chip'}>{b.brand}</span>
                            <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>{b.skuCount}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <div className="kicker">avg ₹</div>
                              <div className="mono text-[14px]" style={{ color: cheaper ? 'var(--accent-red)' : 'var(--ink)' }}>
                                {formatINR(b.avgPrice)}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="kicker">avg BSR</div>
                              <div className="mono text-[13px]" style={{ color: 'var(--ink-soft)' }}>
                                {b.avgBsr != null ? `#${b.avgBsr.toLocaleString()}` : '—'}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {c.verdict && (
                    <div className="text-[13px] italic" style={{ color: 'var(--muted)' }}>
                      {c.verdict}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          {/* HIJACK / BUYBOX */}
          <section className="space-y-4">
            <div>
              <div className="kicker">Hijack & buybox health</div>
              <h2 className="serif text-[32px] leading-tight" style={{ color: 'var(--ink)' }}>
                PW listings under pressure
              </h2>
            </div>
            {data.hijacks.length === 0 ? (
              <div className="panel p-6 text-center" style={{ color: 'var(--muted)' }}>
                No PW seller data yet — run "Fetch all PW sellers" on the Products page.
              </div>
            ) : (
              <div className="space-y-2">
                <div
                  className="grid items-center gap-4 px-5 py-2"
                  style={{ gridTemplateColumns: 'minmax(0,2fr) 1.4fr 100px 110px 110px 110px' }}
                >
                  <div className="col-head">Listing</div>
                  <div className="col-head">Buybox</div>
                  <div className="col-head">Sellers</div>
                  <div className="col-head">PW ₹</div>
                  <div className="col-head">Lowest comp</div>
                  <div className="col-head">Status</div>
                </div>
                {data.hijacks.slice(0, 30).map((h) => (
                  <article
                    key={h.productId}
                    className="row-card"
                    style={{
                      borderColor: h.severity === 'high' ? 'var(--accent-red)' : undefined,
                      background: h.severity === 'high' ? 'rgba(232,148,132,0.05)' : undefined,
                    }}
                  >
                    <div
                      className="grid items-center gap-4 px-5 py-3"
                      style={{ gridTemplateColumns: 'minmax(0,2fr) 1.4fr 100px 110px 110px 110px' }}
                    >
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        className="serif text-[15px] truncate link-quiet"
                        style={{ color: 'var(--ink)' }}
                        title={h.title}
                      >
                        {h.title}
                      </a>
                      <div className="text-[13px] truncate" style={{ color: h.isPwBuybox ? 'var(--ink-soft)' : 'var(--accent-red)' }}>
                        {h.buyboxSeller || '—'}
                      </div>
                      <div className="mono text-[13px]">{h.sellerCount}</div>
                      <div className="mono text-[13px]">{formatINR(h.pwPrice)}</div>
                      <div className="mono text-[13px]">{formatINR(h.lowestCompetitorPrice)}</div>
                      <div>
                        {h.severity === 'high' ? (
                          <span className="chip chip-red">
                            {!h.isPwBuybox ? 'Hijacked' : 'Undercut'}
                          </span>
                        ) : (
                          <span className="chip chip-green">OK</span>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* TRENDS */}
          <section className="space-y-4">
            <div>
              <div className="kicker">30-day trends</div>
              <h2 className="serif text-[32px] leading-tight" style={{ color: 'var(--ink)' }}>
                The long view
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="panel p-6 space-y-3">
                <div className="kicker">PW avg price</div>
                <Sparkline data={data.trends.pwPrice} color="var(--ink)" />
              </div>
              <div className="panel p-6 space-y-3">
                <div className="kicker">Competitor avg price</div>
                <Sparkline data={data.trends.competitorPrice} color="var(--ink-soft)" />
              </div>
              <div className="panel p-6 space-y-3">
                <div className="kicker">Daily change activity</div>
                <Sparkline data={data.trends.activity} color="var(--accent-amber, #d4a857)" />
              </div>
            </div>
          </section>

          <div className="text-[11px] text-right" style={{ color: 'var(--faint)' }}>
            Generated {timeAgo(new Date(data.generatedAt * 1000).toISOString())}
            {data.cached ? ` · cache age ${Math.floor(data.cacheAge / 60)}m` : ''}
          </div>
        </>
      )}
    </div>
  );
}
