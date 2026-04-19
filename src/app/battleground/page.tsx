'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface PoolRow {
  pool_id: number;
  pool_name: string;
  publisher: string;
  cohort: string;
  is_own_pool: boolean;
  product_count: number;
  avg_price: number | null;
  avg_rating: number | null;
  total_reviews: number | null;
  in_stock_count: number;
  aplus_count: number;
  avg_bullet_count: number | null;
  avg_image_count: number | null;
  latest_fetched_at: string | null;
  change_count: number;
  price_drops: number;
  price_hikes: number;
  rating_improved: number;
  rating_dropped: number;
  bsr_improved: number;
  bsr_dropped: number;
}

interface Verdict {
  dimension: string;
  leader: string;
  leaderValue: string;
  pwValue: string;
  tone: 'good' | 'bad' | 'neutral';
}

interface CohortGroup {
  cohort: string;
  pw: PoolRow | null;
  competitors: PoolRow[];
  verdict: Verdict[];
}

interface Battleground {
  since: string;
  cohorts: CohortGroup[];
  stragglers: PoolRow[];
  generatedAt: string;
}

interface Brief {
  headline: string;
  wins: string[];
  gaps: string[];
  moves: string[];
  watch: string[];
  model: string;
  generatedAt: string;
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function fmtRating(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
}
function pct(num: number, den: number): string {
  if (!den) return '0%';
  return `${Math.round((num / den) * 100)}%`;
}
function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function BattlegroundPage() {
  const [data, setData] = useState<Battleground | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/battleground?since=${since}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load battleground');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [since]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function generateBrief() {
    if (!data) return;
    setBriefLoading(true);
    setBriefError(null);
    try {
      const res = await fetch('/api/ai/battleground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: data.since, cohorts: data.cohorts }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to generate brief');
      setBrief(json);
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBriefLoading(false);
    }
  }

  const verdictClass = (tone: Verdict['tone']) => {
    if (tone === 'good') return 'text-emerald-300';
    if (tone === 'bad') return 'text-red-300';
    return 'text-slate-300';
  };

  return (
    <main className="min-h-screen p-6 md:p-8">
      <div className="max-w-300 mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <p className="kicker mb-2">Competitive Battleground</p>
            <h1 className="text-4xl md:text-5xl font-normal tracking-tight text-slate-100">PW vs. the Field</h1>
            <p className="text-slate-400 mt-1 text-sm md:text-base">
              Cohort-by-cohort comparison of Physics Wallah against every publisher we monitor.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-1">
              {(['24h', '7d', '30d', 'all'] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => setSince(w)}
                  className={`px-2.5 py-1 rounded-md text-[11px] border transition ${
                    since === w
                      ? 'bg-slate-800/70 border-slate-600 text-slate-100'
                      : 'bg-transparent border-slate-700/60 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
            <Link
              href="/"
              className="px-4 py-2 rounded-xl text-sm font-medium transition border border-slate-600/70 bg-slate-800/70 hover:bg-slate-700/80 text-slate-100"
            >
              Dashboard
            </Link>
            <Link
              href="/compare"
              className="px-4 py-2 rounded-xl text-sm font-medium transition border border-slate-600/70 bg-slate-800/70 hover:bg-slate-700/80 text-slate-100"
            >
              Pool Detail
            </Link>
          </div>
        </div>

        {/* Notice board */}
        <section className="mb-8 rounded-2xl border border-indigo-800/35 bg-linear-to-br from-indigo-950/45 via-slate-900/85 to-emerald-950/25 overflow-hidden">
          <header className="flex items-center justify-between px-5 py-3 border-b border-indigo-900/40">
            <div>
              <p className="kicker">Notice Board</p>
              <h2 className="text-lg font-semibold text-slate-100">How PW is performing against the field</h2>
            </div>
            <button
              onClick={generateBrief}
              disabled={briefLoading || !data || data.cohorts.length === 0}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                briefLoading
                  ? 'bg-indigo-600/40 text-indigo-100 animate-pulse'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40'
              }`}
            >
              {briefLoading ? 'Thinking…' : brief ? 'Regenerate' : 'Generate Brief'}
            </button>
          </header>

          {briefError && (
            <div className="px-5 py-3 text-sm text-red-300 bg-red-950/30 border-b border-red-900/40">{briefError}</div>
          )}

          {!brief && !briefError && (
            <div className="px-5 py-5 text-sm text-slate-400">
              Generate a brief to get an AI readout of PW's wins, gaps, and recommended moves across cohorts.
            </div>
          )}

          {brief && (
            <div className="p-5 grid grid-cols-1 xl:grid-cols-4 gap-4 text-sm">
              <div className="xl:col-span-4">
                <p className="text-xs uppercase tracking-[0.18em] text-indigo-300 mb-1.5">Headline</p>
                <p className="text-slate-100 leading-7 text-base">{brief.headline}</p>
                <p className="text-[11px] text-slate-500 mt-2">
                  {brief.model} · generated {new Date(brief.generatedAt).toLocaleString('en-IN')}
                </p>
              </div>
              <div className="rounded-xl border border-emerald-800/30 bg-slate-900/55 p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300 mb-2">Wins</p>
                <ul className="space-y-1.5">
                  {brief.wins.length > 0 ? brief.wins.map((x, i) => <li key={i} className="text-slate-200">• {x}</li>) : <li className="text-slate-500">—</li>}
                </ul>
              </div>
              <div className="rounded-xl border border-red-800/30 bg-slate-900/55 p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-red-300 mb-2">Gaps vs. competitors</p>
                <ul className="space-y-1.5">
                  {brief.gaps.length > 0 ? brief.gaps.map((x, i) => <li key={i} className="text-slate-200">• {x}</li>) : <li className="text-slate-500">—</li>}
                </ul>
              </div>
              <div className="rounded-xl border border-cyan-800/30 bg-slate-900/55 p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-cyan-300 mb-2">Moves this week</p>
                <ul className="space-y-1.5">
                  {brief.moves.length > 0 ? brief.moves.map((x, i) => <li key={i} className="text-slate-200">• {x}</li>) : <li className="text-slate-500">—</li>}
                </ul>
              </div>
              <div className="rounded-xl border border-amber-800/30 bg-slate-900/55 p-3">
                <p className="text-xs uppercase tracking-[0.18em] text-amber-300 mb-2">Watchlist</p>
                <ul className="space-y-1.5">
                  {brief.watch.length > 0 ? brief.watch.map((x, i) => <li key={i} className="text-slate-200">• {x}</li>) : <li className="text-slate-500">—</li>}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* Loading / error */}
        {loading && <p className="text-slate-400">Loading battleground…</p>}
        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-sm text-red-200">{error}</div>
        )}

        {/* Cohorts */}
        {!loading && data && data.cohorts.length === 0 && (
          <div className="text-center py-16 text-slate-500">
            <p className="text-lg">No PW pools found yet.</p>
            <p className="text-sm mt-1">Create pools named "PW - &lt;Cohort&gt;" to enable this view.</p>
          </div>
        )}

        <div className="space-y-10">
          {!loading && data && data.cohorts.map((cg) => {
            const pools = [cg.pw, ...cg.competitors].filter(Boolean) as PoolRow[];
            return (
              <section key={cg.cohort}>
                <div className="flex items-baseline justify-between mb-3">
                  <div>
                    <p className="kicker">Cohort</p>
                    <h2 className="text-2xl font-normal tracking-tight text-slate-100">{cg.cohort}</h2>
                  </div>
                  <p className="text-xs text-slate-500">
                    {pools.length} pool{pools.length !== 1 ? 's' : ''} · {pools.reduce((s, p) => s + p.product_count, 0)} products
                  </p>
                </div>

                {/* Verdict strip */}
                {cg.verdict.length > 0 && (
                  <div className="mb-3 rounded-xl border border-slate-700/60 bg-slate-900/55 px-4 py-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 mb-2">Leaderboard</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                      {cg.verdict.map((v) => (
                        <div key={v.dimension} className="text-sm">
                          <p className="text-slate-400 text-[11px] uppercase tracking-wide">{v.dimension}</p>
                          <p className={`font-medium ${verdictClass(v.tone)}`}>
                            {v.leader} · {v.leaderValue}
                          </p>
                          <p className="text-[11px] text-slate-500">PW: {v.pwValue}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pool cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {pools.map((p) => {
                    const isPW = p.is_own_pool || p.publisher.toUpperCase() === 'PW';
                    return (
                      <article
                        key={p.pool_id}
                        className={`rounded-2xl border p-4 backdrop-blur-sm shadow-lg shadow-black/10 ${
                          isPW
                            ? 'border-emerald-600/40 bg-emerald-900/20'
                            : 'border-slate-700/60 bg-slate-900/55'
                        }`}
                      >
                        <header className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                              {isPW ? 'Physics Wallah' : 'Competitor'}
                            </p>
                            <h3 className="text-lg font-medium text-slate-100">{p.publisher}</h3>
                          </div>
                          <span className="text-[11px] text-slate-500">
                            {p.product_count} SKU{p.product_count !== 1 ? 's' : ''}
                          </span>
                        </header>

                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">Avg price</dt>
                            <dd className="font-mono text-slate-100">{fmtPrice(p.avg_price)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">Avg rating</dt>
                            <dd className="text-slate-100">★ {fmtRating(p.avg_rating)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">Total reviews</dt>
                            <dd className="text-slate-100">{fmtInt(p.total_reviews)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">In stock</dt>
                            <dd className="text-slate-100">
                              {p.in_stock_count}/{p.product_count}{' '}
                              <span className="text-[11px] text-slate-500">({pct(p.in_stock_count, p.product_count)})</span>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">A+ coverage</dt>
                            <dd className="text-slate-100">
                              {p.aplus_count}/{p.product_count}{' '}
                              <span className="text-[11px] text-slate-500">({pct(p.aplus_count, p.product_count)})</span>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-slate-500 uppercase tracking-wide">Bullets / Images</dt>
                            <dd className="text-slate-100">
                              {p.avg_bullet_count != null ? p.avg_bullet_count.toFixed(1) : '—'} ·{' '}
                              {p.avg_image_count != null ? p.avg_image_count.toFixed(1) : '—'}
                            </dd>
                          </div>
                        </dl>

                        <div className="mt-3 pt-3 border-t border-slate-700/50">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 mb-1.5">
                            Momentum ({data.since})
                          </p>
                          <div className="flex flex-wrap gap-1.5 text-[11px]">
                            {p.price_drops > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-200">
                                ↓ {p.price_drops} price drop{p.price_drops !== 1 ? 's' : ''}
                              </span>
                            )}
                            {p.price_hikes > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 text-red-200">
                                ↑ {p.price_hikes} price hike{p.price_hikes !== 1 ? 's' : ''}
                              </span>
                            )}
                            {p.rating_improved > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-200">
                                ★ +{p.rating_improved}
                              </span>
                            )}
                            {p.rating_dropped > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 text-red-200">
                                ★ −{p.rating_dropped}
                              </span>
                            )}
                            {p.bsr_improved > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-200">
                                BSR ↑ {p.bsr_improved}
                              </span>
                            )}
                            {p.bsr_dropped > 0 && (
                              <span className="px-1.5 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 text-red-200">
                                BSR ↓ {p.bsr_dropped}
                              </span>
                            )}
                            {p.change_count === 0 && (
                              <span className="text-slate-500">· quiet</span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 mt-2">
                            Last scrape: {timeAgo(p.latest_fetched_at)} · total changes {p.change_count}
                          </p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        {/* Stragglers */}
        {!loading && data && data.stragglers.length > 0 && (
          <section className="mt-10 rounded-2xl border border-slate-700/60 bg-slate-900/55 p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500 mb-2">Pools without a PW peer</p>
            <ul className="text-sm text-slate-300 space-y-1">
              {data.stragglers.map((s) => (
                <li key={s.pool_id}>· {s.pool_name} — {s.product_count} SKUs</li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-12 text-center text-xs text-slate-600">
          Battleground regenerates on every load · {data?.cohorts.length ?? 0} cohorts
        </div>
      </div>
    </main>
  );
}
