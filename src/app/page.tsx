'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { summarizeChange, toneClass } from '@/lib/change-intel';

interface Product {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  last_seen_at: string | null;
  last_snapshot: {
    payload_json: any;
    hash: string;
    fetched_at: string;
  } | null;
  recent_changes: {
    field: string;
    old_value: string;
    new_value: string;
    detected_at: string;
  }[] | null;
}

interface GlobalChange {
  id: number;
  product_id: number;
  field: string;
  old_value: string;
  new_value: string;
  detected_at: string;
  asin_or_sku: string;
  platform: string;
  is_own: boolean;
  pool_id: number | null;
  pool_name: string | null;
  product_title: string | null;
  title_known: string | null;
}

interface AiBrief {
  summary: string;
  highlights: string[];
  risks: string[];
  actions: string[];
  watchlist: string[];
  model: string;
  changesAnalyzed: number;
  generatedAt: string;
}

export default function Dashboard() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [globalChanges, setGlobalChanges] = useState<GlobalChange[]>([]);
  const [globalSince, setGlobalSince] = useState<'6h' | '24h' | '7d' | '30d' | 'all'>('24h');
  const [aiBrief, setAiBrief] = useState<AiBrief | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Add product form
  const [showForm, setShowForm] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number } | null>(null);
  const [checkingIds, setCheckingIds] = useState<Set<number>>(new Set());
  const [pillWindow, setPillWindow] = useState<'24h' | '7d' | 'all'>('7d');
  const [lastSeen, setLastSeen] = useState<Record<number, number>>({});
  const [form, setForm] = useState({
    platform: 'amazon',
    asin_or_sku: '',
    url: '',
    title_known: '',
  });

  // Hydrate "last seen" markers from localStorage so pill highlights mute once viewed.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('birdEye.lastSeen');
      if (raw) setLastSeen(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const markSeen = useCallback((productId: number) => {
    setLastSeen((prev) => {
      const next = { ...prev, [productId]: Date.now() };
      try { window.localStorage.setItem('birdEye.lastSeen', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load products');
      }
      if (Array.isArray(data)) {
        setProducts(data);
        setError(null);
      } else {
        setProducts([]);
        setError(data.error || 'Unexpected response');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchGlobalChanges = useCallback(async () => {
    try {
      const res = await fetch(`/api/pools/changes?since=${globalSince}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setGlobalChanges(data);
      }
    } catch {
      // ignore
    }
  }, [globalSince]);

  useEffect(() => {
    fetchProducts();
    fetchGlobalChanges();
    const interval = setInterval(() => {
      fetchProducts();
      fetchGlobalChanges();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchProducts, fetchGlobalChanges]);

  async function addProduct(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add product');
      }
      const { id: newProductId } = await res.json();
      setForm({ platform: 'amazon', asin_or_sku: '', url: '', title_known: '' });
      setShowForm(false);
      await fetchProducts();

      // Trigger immediate scrape for the new product
      fetch('/api/run-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: newProductId }),
      }).then(() => fetchProducts());
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error adding product');
    }
  }

  async function deleteProduct(id: number) {
    if (!confirm('Delete this product and all its data?')) return;
    await fetch(`/api/products?id=${id}`, { method: 'DELETE' });
    await fetchProducts();
  }

  async function runCheckAll() {
    setCheckingAll(true);
    const total = products.length;
    setCheckProgress({ done: 0, total });
    try {
      // Sweep through every batch until the backend reports "no products".
      // BATCH_SIZE on the server is 10, so we page through in steps of 10.
      for (let batch = 0; batch < 200; batch++) {
        const res = await fetch('/api/run-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch }),
        });
        if (!res.ok) break;
        const data = await res.json().catch(() => ({}));
        const processed = Array.isArray(data.results) ? data.results.length : 0;
        setCheckProgress((prev) => (prev ? { ...prev, done: Math.min(prev.done + processed, total) } : null));
        // Refresh after each batch so cards fill in progressively.
        await fetchProducts();
        if (processed === 0) break;
      }
    } catch {
      // ignore
    } finally {
      setCheckingAll(false);
      setCheckProgress(null);
    }
  }

  async function runCheckOne(productId: number) {
    setCheckingIds((prev) => {
      const next = new Set(prev);
      next.add(productId);
      return next;
    });
    try {
      await fetch('/api/run-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      await fetchProducts();
    } catch {
      // ignore
    } finally {
      setCheckingIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    }
  }

  async function generateAiBrief() {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: globalSince }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate AI brief');
      }
      setAiBrief(data);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Failed to generate AI brief');
    } finally {
      setAiLoading(false);
    }
  }

  function timeAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  const WINDOW_MS: Record<typeof pillWindow, number> = {
    '24h': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
    'all': Number.POSITIVE_INFINITY,
  };

  // Tone → washi palette chip classes. Kept inline so theme stays consistent.
  const PILL_TONE: Record<string, string> = {
    green: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-200 border-red-500/30',
    amber: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    blue: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/30',
    gray: 'bg-slate-500/15 text-slate-200 border-slate-500/30',
  };

  interface PillBucket {
    key: string;
    label: string;
    summary: string;
    tone: string;
    count: number;
    latestAt: number;
  }

  function digestChanges(
    changes: Product['recent_changes'],
    windowMs: number,
  ): PillBucket[] {
    if (!changes || changes.length === 0) return [];
    const cutoff = Date.now() - windowMs;
    const buckets = new Map<string, PillBucket>();
    for (const c of changes) {
      const ts = new Date(c.detected_at).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const insight = summarizeChange(c);
      // Key by the human label so "Price dropped" and "Price increased" stay distinct.
      const key = insight.label;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        if (ts > existing.latestAt) {
          existing.latestAt = ts;
          existing.summary = insight.summary;
        }
      } else {
        buckets.set(key, {
          key,
          label: insight.label,
          summary: insight.summary,
          tone: insight.tone,
          count: 1,
          latestAt: ts,
        });
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.latestAt - a.latestAt);
  }

  function visibilityTips(snap: any): string[] {
    if (!snap) return [];
    const tips: string[] = [];
    const seo = snap.seo || {};
    const offers = snap.offers || {};

    if ((seo.bulletCount ?? 0) < 5) tips.push('Add 5-8 crisp benefit-focused bullet points with top search keywords.');
    if ((seo.imageCount ?? 0) < 6) tips.push('Increase image depth: include 6-8 images (cover, inside pages, outcomes, comparison, trust badges).');
    if (!seo.hasAPlus) tips.push('Publish A+ content to improve dwell time and conversion confidence.');
    if (!seo.metaTitle || String(seo.metaTitle).length < 55) tips.push('Strengthen title/meta with primary keyword + exam year + format for better discoverability.');
    if ((snap.reviewCount ?? 0) < 50) tips.push('Run post-purchase review campaign to lift review count and social proof.');
    if ((snap.rating ?? 0) < 4.2) tips.push('Address low-rating themes in description and images; prioritize quality fixes to push rating above 4.2.');
    if (!offers.coupon && !offers.dealBadge) tips.push('Test a visible coupon or deal badge during high-traffic windows to improve CTR.');
    if (!offers.availability || !String(offers.availability).toLowerCase().includes('in stock')) tips.push('Fix stock health urgently; out-of-stock directly suppresses visibility and conversion.');

    return tips.slice(0, 5);
  }

  return (
    <main className="min-h-screen p-6 md:p-8">
      <div className="max-w-300 mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="kicker mb-2">Listing Observatory</p>
            <h1 className="text-4xl md:text-5xl font-normal tracking-tight text-slate-100">Bird Eye</h1>
            <p className="text-slate-400 mt-1 text-sm md:text-base">A quiet record of every shift in price, rank, and presentation.</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={runCheckAll}
              disabled={checkingAll || products.length === 0}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition border ${
                checkingAll
                  ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30 animate-pulse'
                  : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/35 text-emerald-100 disabled:opacity-40'
              }`}
            >
              {checkingAll
                ? checkProgress
                  ? `Checking ${checkProgress.done}/${checkProgress.total}…`
                  : 'Checking…'
                : 'Check Now'}
            </button>
            <Link
              href="/compare"
              className="px-4 py-2 rounded-xl text-sm font-medium transition border border-slate-600/70 bg-slate-800/70 hover:bg-slate-700/80 text-slate-100"
            >
              Compare
            </Link>
            <Link
              href="/battleground"
              className="px-4 py-2 rounded-xl text-sm font-medium transition border border-emerald-600/40 bg-emerald-900/30 hover:bg-emerald-800/40 text-emerald-100"
            >
              PW vs. Field
            </Link>
            <button
              onClick={() => setShowForm(!showForm)}
              className="px-4 py-2 rounded-xl text-sm font-medium transition border border-cyan-500/35 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-100"
            >
              {showForm ? 'Cancel' : '+ Add Product'}
            </button>
          </div>
        </div>

        {/* Add product form */}
        {showForm && (
          <form onSubmit={addProduct} className="mb-8 p-4 bg-slate-900/70 rounded-2xl border border-slate-700/60 backdrop-blur-sm shadow-xl shadow-black/15">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Platform</label>
                <select
                  value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value })}
                  className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="amazon">Amazon</option>
                  <option value="flipkart">Flipkart</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">ASIN / SKU</label>
                <input
                  value={form.asin_or_sku}
                  onChange={(e) => setForm({ ...form, asin_or_sku: e.target.value })}
                  required
                  placeholder="B08N5WRWNW"
                  className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">URL</label>
                <input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  required
                  type="url"
                  placeholder="https://www.amazon.in/dp/B08N5WRWNW"
                  className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Title (optional)</label>
                <input
                  value={form.title_known}
                  onChange={(e) => setForm({ ...form, title_known: e.target.value })}
                  placeholder="Product name"
                  className="w-full bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="mt-4 px-6 py-2 bg-emerald-500/90 hover:bg-emerald-400 text-slate-950 rounded-xl text-sm font-semibold transition"
            >
              Add Product
            </button>
          </form>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-sm text-red-200">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && <p className="text-gray-400">Loading products…</p>}

        {/* Products table */}
        {!loading && products.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <p className="text-lg">No products yet</p>
            <p className="text-sm mt-1">Add your first competitor listing to start monitoring</p>
          </div>
        )}

        {!loading && products.length > 0 && (
          <div className="space-y-3">
            {/* Pill window toggle */}
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] text-slate-500 uppercase tracking-[0.18em]">Change window</span>
              <div className="flex gap-1">
                {(['24h', '7d', 'all'] as const).map((w) => (
                  <button
                    key={w}
                    onClick={() => setPillWindow(w)}
                    className={`px-2.5 py-1 rounded-md text-[11px] border transition ${
                      pillWindow === w
                        ? 'bg-slate-800/70 border-slate-600 text-slate-100'
                        : 'bg-transparent border-slate-700/60 text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            {/* Header row */}
            <div className="grid grid-cols-8 gap-4 px-4 text-xs text-gray-500 uppercase tracking-wider font-semibold">
              <span>Platform</span>
              <span className="col-span-2">Product</span>
              <span>Price</span>
              <span>Rating</span>
              <span>Reviews</span>
              <span>Last Seen</span>
              <span>Actions</span>
            </div>

            {products.map((p) => {
              const snap = p.last_snapshot?.payload_json;
              const isExpanded = expandedId === p.id;
              const offers = snap?.offers;
              const pills = digestChanges(p.recent_changes, WINDOW_MS[pillWindow]);
              const seenAt = lastSeen[p.id] ?? 0;
              return (
                <div key={p.id} className="bg-slate-900/55 rounded-2xl border border-slate-700/60 overflow-hidden backdrop-blur-sm shadow-lg shadow-black/10">
                  {/* Main row */}
                  <div
                    className="grid grid-cols-8 gap-4 px-4 py-3.5 items-center cursor-pointer hover:bg-slate-800/45 transition"
                    onClick={() => {
                      const nextId = isExpanded ? null : p.id;
                      setExpandedId(nextId);
                      if (nextId !== null) markSeen(p.id);
                    }}
                  >
                    <div>
                      <span
                        className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${
                          p.platform === 'amazon'
                            ? 'bg-amber-500/15 text-amber-200 border border-amber-500/30'
                            : 'bg-yellow-500/15 text-yellow-200 border border-yellow-500/30'
                        }`}
                      >
                        {p.platform}
                      </span>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-300 hover:text-cyan-200 font-medium truncate block text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {snap?.title || p.title_known || p.asin_or_sku}
                      </a>
                      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-gray-500">{p.asin_or_sku}</span>
                        {pills.length === 0 ? (
                          <span className="text-[11px] text-slate-500">· quiet</span>
                        ) : (
                          pills.slice(0, 4).map((pill) => {
                            const fresh = pill.latestAt > seenAt;
                            const tone = PILL_TONE[pill.tone] ?? PILL_TONE.gray;
                            return (
                              <span
                                key={pill.key}
                                title={`${pill.label} · ${pill.summary}`}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] leading-none ${tone} ${fresh ? '' : 'opacity-55'}`}
                              >
                                <span className="truncate max-w-44">{pill.label}</span>
                                {pill.count > 1 && <span className="opacity-70">·{pill.count}</span>}
                              </span>
                            );
                          })
                        )}
                        {pills.length > 4 && (
                          <span className="text-[11px] text-slate-500">+{pills.length - 4} more</span>
                        )}
                      </div>
                    </div>
                    <div className="font-mono text-sm">
                      {snap?.price != null ? (
                        <div>
                          <span>{snap.currency === 'INR' ? '₹' : snap.currency || '₹'}{snap.price.toLocaleString()}</span>
                          {offers?.discountPct && (
                            <span className="text-xs text-green-400 ml-1">{offers.discountPct}</span>
                          )}
                        </div>
                      ) : <span className="text-gray-600">—</span>}
                    </div>
                    <div className="text-sm">
                      {snap?.rating != null ? <span>★ {snap.rating}</span> : <span className="text-gray-600">—</span>}
                    </div>
                    <div className="text-sm">
                      {snap?.reviewCount != null ? snap.reviewCount.toLocaleString() : <span className="text-gray-600">—</span>}
                    </div>
                    <div className="text-sm text-slate-400">{timeAgo(p.last_seen_at)}</div>
                    <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-3">
                      <button
                        onClick={() => runCheckOne(p.id)}
                        disabled={checkingIds.has(p.id)}
                        className="text-xs px-2 py-0.5 rounded border border-slate-600/70 bg-slate-800/60 hover:bg-slate-700/70 text-slate-100 disabled:opacity-40"
                      >
                        {checkingIds.has(p.id) ? 'Checking…' : 'Check'}
                      </button>
                      <button
                        onClick={() => deleteProduct(p.id)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        Delete
                      </button>
                      <span className={`text-gray-500 text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="border-t border-slate-700/60 px-4 py-4">
                      {snap ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 text-sm">
                          {/* Pricing & Offers */}
                          <div className="space-y-2">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Pricing &amp; Offers</h3>
                            <div className="space-y-1.5">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Price</span>
                                <span className="font-mono">{snap.currency === 'INR' ? '₹' : snap.currency || '₹'}{snap.price?.toLocaleString() ?? '—'}</span>
                              </div>
                              {offers?.mrp != null && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">MRP</span>
                                  <span className="font-mono text-gray-500 line-through">{snap.currency === 'INR' ? '₹' : snap.currency || '₹'}{offers.mrp.toLocaleString()}</span>
                                </div>
                              )}
                              {offers?.discountPct && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Discount</span>
                                  <span className="text-green-400 font-medium">{offers.discountPct}</span>
                                </div>
                              )}
                              {offers?.dealBadge && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Deal</span>
                                  <span className="text-amber-400 font-medium">{offers.dealBadge}</span>
                                </div>
                              )}
                              {offers?.coupon && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Coupon</span>
                                  <span className="text-cyan-400">{offers.coupon}</span>
                                </div>
                              )}
                              {offers?.bankOffers && offers.bankOffers.length > 0 && (
                                <div>
                                  <span className="text-gray-400 text-xs">Bank Offers</span>
                                  <ul className="mt-1 space-y-0.5">
                                    {offers.bankOffers.map((b: string, i: number) => (
                                      <li key={i} className="text-xs text-gray-300">• {b}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Product Info */}
                          <div className="space-y-2">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Product Info</h3>
                            <div className="space-y-1.5">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Rating</span>
                                <span>{snap.rating != null ? `★ ${snap.rating}` : '—'}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">Reviews</span>
                                <span>{snap.reviewCount != null ? snap.reviewCount.toLocaleString() : '—'}</span>
                              </div>
                              {offers?.availability && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Availability</span>
                                  <span className={offers.availability.toLowerCase().includes('in stock') ? 'text-green-400' : 'text-amber-400'}>
                                    {offers.availability}
                                  </span>
                                </div>
                              )}
                              {offers?.seller && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Seller</span>
                                  <span>{offers.seller}</span>
                                </div>
                              )}
                              {offers?.bestSellerRank && (
                                <div>
                                  <span className="text-gray-400 text-xs">Best Seller Rank</span>
                                  <p className="text-xs text-purple-400 mt-0.5">{offers.bestSellerRank}</p>
                                </div>
                              )}
                            </div>
                            {snap.description && (
                              <div className="mt-3">
                                <span className="text-gray-400 text-xs">Description</span>
                                <p className="text-xs text-gray-300 mt-1 line-clamp-4">{snap.description}</p>
                              </div>
                            )}
                          </div>

                          {/* SEO Health */}
                          <div className="space-y-2">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">SEO Health</h3>
                            {snap.seo ? (
                              <div className="space-y-1.5">
                                {snap.seo.metaTitle && (
                                  <div>
                                    <span className="text-gray-400 text-xs">Meta Title</span>
                                    <p className="text-xs text-gray-300 mt-0.5 line-clamp-2">{snap.seo.metaTitle}</p>
                                  </div>
                                )}
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Bullet Points</span>
                                  <span className={`font-medium ${(snap.seo.bulletCount ?? 0) >= 5 ? 'text-green-400' : 'text-amber-400'}`}>
                                    {snap.seo.bulletCount ?? 0}
                                  </span>
                                </div>
                                {snap.seo.bullets && snap.seo.bullets.length > 0 && (
                                  <div>
                                    <ul className="space-y-0.5">
                                      {snap.seo.bullets.slice(0, 5).map((b: string, i: number) => (
                                        <li key={i} className="text-xs text-gray-400 line-clamp-1">• {b}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Images</span>
                                  <span className={`font-medium ${(snap.seo.imageCount ?? 0) >= 5 ? 'text-green-400' : 'text-amber-400'}`}>
                                    {snap.seo.imageCount ?? 0}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-gray-400">A+ Content</span>
                                  <span className={snap.seo.hasAPlus ? 'text-green-400 font-medium' : 'text-red-400'}>
                                    {snap.seo.hasAPlus ? '✓ Yes' : '✗ No'}
                                  </span>
                                </div>
                                {snap.seo.categoryPath && (
                                  <div>
                                    <span className="text-gray-400 text-xs">Category</span>
                                    <p className="text-xs text-blue-400 mt-0.5 line-clamp-2">{snap.seo.categoryPath}</p>
                                  </div>
                                )}
                                <div className="flex justify-between">
                                  <span className="text-gray-400">Q&amp;A</span>
                                  <span>{snap.seo.questionCount ?? 0} questions</span>
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-gray-600">No SEO data yet — rescrape to populate</p>
                            )}
                          </div>

                          {/* Change History */}
                          <div className="space-y-2">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Change History</h3>
                            {p.recent_changes && p.recent_changes.length > 0 ? (
                              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                                {p.recent_changes.map((c, i) => (
                                  <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
                                    <span className={`font-medium ${c.field.startsWith('seo.') ? 'text-blue-400' : c.field.startsWith('offers.') ? 'text-cyan-400' : 'text-yellow-400'}`}>{c.field}</span>
                                    <span className="text-gray-500 ml-2">{timeAgo(c.detected_at)}</span>
                                    <div className="mt-1 flex gap-2 items-center flex-wrap">
                                      <span className="text-red-400/70 line-through">{c.old_value?.slice(0, 50) || '(empty)'}</span>
                                      <span className="text-gray-600">→</span>
                                      <span className="text-green-400">{c.new_value?.slice(0, 50)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-600">No changes detected yet</p>
                            )}
                            {p.last_snapshot && (
                              <div className="mt-3 text-xs text-gray-500">
                                Snapshot: <code className="text-gray-400">{p.last_snapshot.hash?.slice(0, 12)}…</code>
                                <br />
                                Fetched: {timeAgo(p.last_snapshot.fetched_at)}
                              </div>
                            )}
                          </div>

                          {/* Visibility Suggestions */}
                          <div className="space-y-2">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Visibility Suggestions</h3>
                            {visibilityTips(snap).length > 0 ? (
                              <ul className="space-y-1.5">
                                {visibilityTips(snap).map((tip, i) => (
                                  <li key={i} className="text-xs bg-gray-800/50 rounded p-2 text-gray-300">• {tip}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-xs text-green-300">Listing health looks strong. Keep monitoring price/rank momentum.</p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-4 text-sm text-gray-500">
                          No snapshot yet. <button onClick={() => runCheckOne(p.id)} disabled={checkingIds.has(p.id)} className="underline text-slate-100 disabled:opacity-40">{checkingIds.has(p.id) ? 'Checking…' : 'Check this product now'}</button>.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Smart Listing Change Feed (all books) */}
        {!loading && (
          <div className="mt-10 bg-gray-900/60 rounded-xl border border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div>
                <h2 className="text-lg font-semibold">Smart Listing Change Feed</h2>
                <p className="text-xs text-gray-400">All books, not just competitor pools</p>
              </div>
              <div className="flex gap-1">
                {(['6h', '24h', '7d', '30d', 'all'] as const).map((period) => (
                  <button
                    key={period}
                    onClick={() => setGlobalSince(period)}
                    className={`px-2.5 py-1 rounded text-xs transition ${
                      globalSince === period
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                  >
                    {period}
                  </button>
                ))}
              </div>
            </div>

            {globalChanges.length === 0 ? (
              <div className="p-6 text-sm text-gray-500">No listing changes detected for this period.</div>
            ) : (
              <div className="max-h-105 overflow-y-auto">
                {globalChanges.slice(0, 120).map((c) => {
                  const insight = summarizeChange(c);
                  return (
                    <div key={c.id} className="px-4 py-3 border-b border-gray-800/70 last:border-b-0 hover:bg-gray-800/30 transition">
                      <div className="flex items-start gap-3">
                        <div className="text-[11px] text-gray-500 w-16 shrink-0 mt-0.5">
                          {new Date(c.detected_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="shrink-0 mt-0.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.is_own ? 'bg-blue-600/30 text-blue-300' : 'bg-red-600/20 text-red-300'}`}>
                            {c.is_own ? 'YOUR' : 'COMP'}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-200 truncate">
                            {c.product_title || c.title_known || c.asin_or_sku}
                          </p>
                          <p className="mt-0.5 text-xs flex items-center gap-2 flex-wrap">
                            <span className={`font-semibold ${toneClass(insight.tone)}`}>{insight.label}</span>
                            <span className="text-gray-500 uppercase tracking-wide text-[10px]">{insight.category}</span>
                            {c.pool_name && <span className="text-gray-500 text-[10px]">pool: {c.pool_name}</span>}
                          </p>
                          <p className="text-xs text-gray-300 mt-0.5">{insight.summary}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* AI strategic brief */}
        {!loading && (
          <div className="mt-8 bg-linear-to-br from-indigo-950/45 via-gray-900/90 to-emerald-950/30 border border-indigo-800/30 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-indigo-900/40 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">AI Strategy Brief</h2>
                <p className="text-xs text-gray-400">Powered by OpenRouter for ranking, pricing, offers, and listing quality insights</p>
              </div>
              <button
                onClick={generateAiBrief}
                disabled={aiLoading}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${aiLoading ? 'bg-indigo-600/40 text-indigo-100 animate-pulse' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
              >
                {aiLoading ? 'Thinking...' : 'Generate Brief'}
              </button>
            </div>

            {aiError && (
              <div className="px-4 py-3 text-sm text-red-300 bg-red-950/30 border-b border-red-900/40">{aiError}</div>
            )}

            {!aiBrief && !aiError && (
              <div className="px-4 py-6 text-sm text-gray-400">
                Click Generate Brief to get an AI digest of rank movement, title and description shifts, offers, BSR, and action suggestions.
              </div>
            )}

            {aiBrief && (
              <div className="p-4 grid grid-cols-1 xl:grid-cols-4 gap-4 text-sm">
                <div className="xl:col-span-2 bg-gray-900/55 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs uppercase tracking-wide text-indigo-300 mb-2">Executive Summary</p>
                  <p className="text-gray-200 leading-6">{aiBrief.summary}</p>
                  <p className="text-[11px] text-gray-500 mt-3">
                    Model: {aiBrief.model} • Changes analyzed: {aiBrief.changesAnalyzed} • Generated: {new Date(aiBrief.generatedAt).toLocaleString('en-IN')}
                  </p>
                </div>

                <div className="bg-gray-900/55 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs uppercase tracking-wide text-green-300 mb-2">Highlights</p>
                  <ul className="space-y-2">
                    {aiBrief.highlights.length > 0 ? aiBrief.highlights.map((x, i) => <li key={i} className="text-gray-200">• {x}</li>) : <li className="text-gray-500">No highlights</li>}
                  </ul>
                </div>

                <div className="bg-gray-900/55 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs uppercase tracking-wide text-red-300 mb-2">Risks</p>
                  <ul className="space-y-2">
                    {aiBrief.risks.length > 0 ? aiBrief.risks.map((x, i) => <li key={i} className="text-gray-200">• {x}</li>) : <li className="text-gray-500">No risks</li>}
                  </ul>
                </div>

                <div className="bg-gray-900/55 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs uppercase tracking-wide text-cyan-300 mb-2">Action Plan</p>
                  <ul className="space-y-2">
                    {aiBrief.actions.length > 0 ? aiBrief.actions.map((x, i) => <li key={i} className="text-gray-200">• {x}</li>) : <li className="text-gray-500">No actions</li>}
                  </ul>
                </div>

                <div className="bg-gray-900/55 border border-gray-800 rounded-lg p-3 xl:col-span-3">
                  <p className="text-xs uppercase tracking-wide text-amber-300 mb-2">Watchlist</p>
                  <ul className="space-y-2">
                    {aiBrief.watchlist.length > 0 ? aiBrief.watchlist.map((x, i) => <li key={i} className="text-gray-200">• {x}</li>) : <li className="text-gray-500">No watchlist items</li>}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Latest reviews section */}
        {!loading && products.some((p) => p.last_snapshot?.payload_json?.reviews?.length > 0) && (
          <div className="mt-10">
            <h2 className="text-xl font-semibold mb-4">Latest Reviews</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {products
                .filter((p) => p.last_snapshot?.payload_json?.reviews?.length > 0)
                .flatMap((p) =>
                  (p.last_snapshot!.payload_json.reviews as any[]).slice(0, 2).map((r: any, i: number) => (
                    <div key={`${p.id}-${i}`} className="p-4 bg-gray-900 rounded-lg border border-gray-800">
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            p.platform === 'amazon'
                              ? 'bg-orange-900/50 text-orange-300'
                              : 'bg-yellow-900/50 text-yellow-300'
                          }`}
                        >
                          {p.platform}
                        </span>
                        <span className="text-xs text-gray-400 truncate">
                          {p.title_known || p.asin_or_sku}
                        </span>
                        {r.date && <span className="text-xs text-gray-500">{r.date}</span>}
                      </div>
                      <p className="text-sm text-gray-300 line-clamp-3">{r.text}</p>
                    </div>
                  )),
                )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 text-center text-xs text-gray-600">
          Auto-refreshes every 30s • {products.length} product{products.length !== 1 ? 's' : ''} monitored
        </div>
      </div>
    </main>
  );
}
