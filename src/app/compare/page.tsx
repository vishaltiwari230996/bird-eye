'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { summarizeChange, toneClass } from '@/lib/change-intel';

interface OfferInfo {
  mrp: number | null;
  discountPct: string | null;
  dealBadge: string | null;
  coupon: string | null;
  bankOffers: string[];
  availability: string | null;
  seller: string | null;
  bestSellerRank: string | null;
}

interface PoolProduct {
  id: number;
  platform: string;
  asin_or_sku: string;
  url: string;
  title_known: string | null;
  is_own: boolean;
  last_seen_at: string | null;
  snapshot: {
    payload_json: {
      title: string;
      price: number;
      rating: number | null;
      reviewCount: number | null;
      description: string;
      reviews: { id: string; date: string; text: string }[];
      offers?: OfferInfo;
    };
    fetched_at: string;
  } | null;
}

interface Pool {
  id: number;
  name: string;
  created_at: string;
  products: PoolProduct[] | null;
}

interface Product {
  id: number;
  platform: string;
  asin_or_sku: string;
  title_known: string | null;
  pool_id: number | null;
  is_own: boolean;
}

interface ChangeRecord {
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

export default function ComparePage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [changes, setChanges] = useState<Record<number, ChangeRecord[]>>({}); // poolId → changes
  const [changeSince, setChangeSince] = useState<string>('24h');
  const [expandedPool, setExpandedPool] = useState<number | null>(null); // which pool's changelog is open

  // Create pool form
  const [newPoolName, setNewPoolName] = useState('');

  // Assign modal
  const [showAssign, setShowAssign] = useState<number | null>(null); // pool id
  const [assignProductId, setAssignProductId] = useState<number | null>(null);
  const [assignIsOwn, setAssignIsOwn] = useState(false);

  // Manual check
  const [checking, setChecking] = useState<number | null>(null); // pool id being checked

  const fetchData = useCallback(async () => {
    try {
      const [poolsRes, productsRes] = await Promise.all([
        fetch('/api/pools'),
        fetch('/api/products'),
      ]);
      const poolsData = await poolsRes.json();
      const productsData = await productsRes.json();
      if (Array.isArray(poolsData)) setPools(poolsData);
      if (Array.isArray(productsData)) setAllProducts(productsData);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchChanges = useCallback(async (poolId: number, since: string) => {
    try {
      const res = await fetch(`/api/pools/changes?pool_id=${poolId}&since=${since}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setChanges((prev) => ({ ...prev, [poolId]: data }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-fetch changes when a pool changelog is expanded
  useEffect(() => {
    if (expandedPool != null) {
      fetchChanges(expandedPool, changeSince);
    }
  }, [expandedPool, changeSince, fetchChanges]);

  async function createPool(e: React.FormEvent) {
    e.preventDefault();
    if (!newPoolName.trim()) return;
    const res = await fetch('/api/pools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newPoolName.trim() }),
    });
    if (res.ok) {
      setNewPoolName('');
      await fetchData();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to create pool');
    }
  }

  async function deletePool(id: number) {
    if (!confirm('Delete this pool? Products won\'t be deleted.')) return;
    await fetch(`/api/pools?id=${id}`, { method: 'DELETE' });
    await fetchData();
  }

  async function assignProduct(poolId: number) {
    if (!assignProductId) return;
    const res = await fetch('/api/pools/assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: assignProductId, pool_id: poolId, is_own: assignIsOwn }),
    });
    if (res.ok) {
      setShowAssign(null);
      setAssignProductId(null);
      setAssignIsOwn(false);
      await fetchData();
    }
  }

  async function removeFromPool(productId: number) {
    await fetch('/api/pools/assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, pool_id: null, is_own: false }),
    });
    await fetchData();
  }

  async function runPoolCheck(pool: Pool) {
    const products = pool.products ?? [];
    if (products.length === 0) return;
    setChecking(pool.id);
    try {
      await Promise.all(
        products.map((p) =>
          fetch('/api/run-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: p.id }),
          })
        )
      );
      await fetchData();
    } catch {
      // ignore
    } finally {
      setChecking(null);
    }
  }

  function priceDiff(ownPrice: number, compPrice: number): { label: string; color: string } {
    if (!ownPrice || !compPrice) return { label: '—', color: 'text-gray-500' };
    const diff = compPrice - ownPrice;
    const pct = ((diff / ownPrice) * 100).toFixed(1);
    if (diff > 0) return { label: `+₹${diff.toFixed(0)} (+${pct}%)`, color: 'text-green-400' };
    if (diff < 0) return { label: `₹${diff.toFixed(0)} (${pct}%)`, color: 'text-red-400' };
    return { label: 'Same', color: 'text-gray-400' };
  }

  function ratingDiff(ownR: number | null, compR: number | null): { label: string; color: string } {
    if (ownR == null || compR == null) return { label: '—', color: 'text-gray-500' };
    const diff = ownR - compR;
    if (diff > 0) return { label: `+${diff.toFixed(1)} ahead`, color: 'text-green-400' };
    if (diff < 0) return { label: `${diff.toFixed(1)} behind`, color: 'text-red-400' };
    return { label: 'Equal', color: 'text-gray-400' };
  }

  if (loading) {
    return (
      <main className="min-h-screen p-6 md:p-8">
        <p className="text-slate-400">Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 md:p-8">
      <div className="max-w-310 mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="kicker mb-2">Side by Side</p>
            <h1 className="text-4xl md:text-5xl font-normal tracking-tight text-slate-100">Competitor Pools</h1>
            <p className="text-slate-400 mt-1 text-sm md:text-base">Quietly observe price, rating, and offer movement across rival listings.</p>
          </div>
          <Link
            href="/"
            className="px-4 py-2 rounded-xl text-sm font-medium transition border border-slate-600/70 bg-slate-800/70 hover:bg-slate-700/80 text-slate-100"
          >
            ← Dashboard
          </Link>
        </div>

        {/* Create pool */}
        <form onSubmit={createPool} className="mb-8 flex gap-3">
          <input
            value={newPoolName}
            onChange={(e) => setNewPoolName(e.target.value)}
            placeholder="New pool name (e.g. Class 9 Math Books)"
            className="flex-1 bg-slate-900/70 border border-slate-700 rounded-xl px-4 py-2 text-sm"
          />
          <button
            type="submit"
            className="px-5 py-2 bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 rounded-xl text-sm font-semibold transition"
          >
            Create Pool
          </button>
        </form>

        {pools.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <p className="text-lg">No comparison pools yet</p>
            <p className="text-sm mt-1">Create a pool, then assign your product and competitors to compare</p>
          </div>
        )}

        {/* Pools */}
        {pools.map((pool) => {
          const products = pool.products ?? [];
          const ownProduct = products.find((p) => p.is_own);
          const competitors = products.filter((p) => !p.is_own);
          const ownSnap = ownProduct?.snapshot?.payload_json;

          return (
            <div key={pool.id} className="mb-10 bg-slate-900/65 rounded-2xl border border-slate-700/60 overflow-hidden backdrop-blur-sm shadow-xl shadow-black/10">
              {/* Pool header */}
              <div className="flex items-center justify-between p-4 border-b border-slate-700/60">
                <h2 className="text-lg font-semibold">{pool.name}</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => runPoolCheck(pool)}
                    disabled={checking === pool.id}
                    className={`px-3 py-1 rounded text-xs font-medium transition ${
                      checking === pool.id
                        ? 'bg-emerald-500/25 text-emerald-100 border border-emerald-500/35 animate-pulse'
                        : 'bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200'
                    }`}
                  >
                    {checking === pool.id ? 'Checking...' : 'Check Now'}
                  </button>
                  <button
                    onClick={() => {
                      setExpandedPool(expandedPool === pool.id ? null : pool.id);
                    }}
                    className={`px-3 py-1 rounded text-xs font-medium transition ${
                      expandedPool === pool.id
                        ? 'bg-amber-500/25 text-amber-100 border border-amber-500/35'
                        : 'bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-200'
                    }`}
                  >
                    Change Log
                  </button>
                  <button
                    onClick={() => {
                      setShowAssign(pool.id);
                      setAssignProductId(null);
                      setAssignIsOwn(false);
                    }}
                    className="px-3 py-1 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-100 border border-cyan-500/30 rounded-lg text-xs font-medium transition"
                  >
                    + Add Product
                  </button>
                  <button
                    onClick={() => deletePool(pool.id)}
                    className="px-3 py-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded text-xs transition"
                  >
                    Delete Pool
                  </button>
                </div>
              </div>

              {/* Assign modal */}
              {showAssign === pool.id && (
                <div className="p-4 bg-gray-800/50 border-b border-gray-700">
                  <div className="flex gap-3 items-end">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-400 mb-1">Select Product</label>
                      <select
                        value={assignProductId ?? ''}
                        onChange={(e) => setAssignProductId(Number(e.target.value) || null)}
                        className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm"
                      >
                        <option value="">Choose…</option>
                        {allProducts
                          .filter((p: any) => !p.pool_id || p.pool_id === pool.id)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              [{p.platform}] {p.title_known || p.asin_or_sku}
                            </option>
                          ))}
                      </select>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={assignIsOwn}
                        onChange={(e) => setAssignIsOwn(e.target.checked)}
                        className="rounded"
                      />
                      This is MY product
                    </label>
                    <button
                      onClick={() => assignProduct(pool.id)}
                      disabled={!assignProductId}
                      className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-sm font-medium transition"
                    >
                      Assign
                    </button>
                    <button
                      onClick={() => setShowAssign(null)}
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {products.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm">
                  No products in this pool. Add your product and competitors to start comparing.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-400 text-left">
                        <th className="p-3">Role</th>
                        <th className="p-3">Product</th>
                        <th className="p-3">Platform</th>
                        <th className="p-3 text-right">Price</th>
                        <th className="p-3 text-right">vs You</th>
                        <th className="p-3 text-center">Rating</th>
                        <th className="p-3 text-center">vs You</th>
                        <th className="p-3 text-right">Reviews</th>
                        <th className="p-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Own product first */}
                      {ownProduct && (
                        <tr className="border-b border-gray-800/50 bg-blue-950/20">
                          <td className="p-3">
                            <span className="px-2 py-0.5 bg-blue-600/30 text-blue-300 rounded text-xs font-medium">
                              YOUR
                            </span>
                          </td>
                          <td className="p-3">
                            <a
                              href={ownProduct.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 font-medium"
                            >
                              {ownSnap?.title || ownProduct.title_known || ownProduct.asin_or_sku}
                            </a>
                          </td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              ownProduct.platform === 'amazon'
                                ? 'bg-orange-900/50 text-orange-300'
                                : 'bg-yellow-900/50 text-yellow-300'
                            }`}>
                              {ownProduct.platform}
                            </span>
                          </td>
                          <td className="p-3 text-right font-mono font-semibold text-green-300">
                            {ownSnap?.price ? `₹${ownSnap.price.toLocaleString()}` : '—'}
                          </td>
                          <td className="p-3 text-right text-gray-500">—</td>
                          <td className="p-3 text-center font-semibold">
                            {ownSnap?.rating != null ? `★ ${ownSnap.rating}` : '—'}
                          </td>
                          <td className="p-3 text-center text-gray-500">—</td>
                          <td className="p-3 text-right">{ownSnap?.reviewCount?.toLocaleString() ?? '—'}</td>
                          <td className="p-3">
                            <button
                              onClick={() => removeFromPool(ownProduct.id)}
                              className="text-red-400 hover:text-red-300 text-xs"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      )}
                      {/* Competitors */}
                      {competitors.map((comp) => {
                        const snap = comp.snapshot?.payload_json;
                        const pd = ownSnap ? priceDiff(ownSnap.price, snap?.price ?? 0) : { label: '—', color: 'text-gray-500' };
                        const rd = ownSnap ? ratingDiff(ownSnap.rating, snap?.rating ?? null) : { label: '—', color: 'text-gray-500' };

                        return (
                          <tr key={comp.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="p-3">
                              <span className="px-2 py-0.5 bg-red-600/20 text-red-300 rounded text-xs font-medium">
                                COMP
                              </span>
                            </td>
                            <td className="p-3">
                              <a
                                href={comp.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300"
                              >
                                {snap?.title || comp.title_known || comp.asin_or_sku}
                              </a>
                            </td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                comp.platform === 'amazon'
                                  ? 'bg-orange-900/50 text-orange-300'
                                  : 'bg-yellow-900/50 text-yellow-300'
                              }`}>
                                {comp.platform}
                              </span>
                            </td>
                            <td className="p-3 text-right font-mono">
                              {snap?.price ? `₹${snap.price.toLocaleString()}` : '—'}
                            </td>
                            <td className={`p-3 text-right text-xs font-medium ${pd.color}`}>{pd.label}</td>
                            <td className="p-3 text-center">
                              {snap?.rating != null ? `★ ${snap.rating}` : '—'}
                            </td>
                            <td className={`p-3 text-center text-xs font-medium ${rd.color}`}>{rd.label}</td>
                            <td className="p-3 text-right">{snap?.reviewCount?.toLocaleString() ?? '—'}</td>
                            <td className="p-3">
                              <button
                                onClick={() => removeFromPool(comp.id)}
                                className="text-red-400 hover:text-red-300 text-xs"
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {/* Summary bar */}
                  {ownProduct && competitors.length > 0 && ownSnap && (
                    <div className="p-4 bg-gray-800/30 border-t border-gray-800 grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="text-gray-400 text-xs mb-1">Price Position</p>
                        {(() => {
                          const allPrices = products
                            .map((p) => p.snapshot?.payload_json?.price ?? 0)
                            .filter((p) => p > 0)
                            .sort((a, b) => a - b);
                          const rank = allPrices.indexOf(ownSnap.price) + 1;
                          const isLowest = rank === 1;
                          return (
                            <p className={`font-semibold ${isLowest ? 'text-green-400' : 'text-yellow-400'}`}>
                              #{rank} of {allPrices.length} {isLowest ? '✓ Lowest' : ''}
                            </p>
                          );
                        })()}
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs mb-1">Rating Position</p>
                        {(() => {
                          const allRatings = products
                            .map((p) => p.snapshot?.payload_json?.rating ?? 0)
                            .filter((r) => r > 0)
                            .sort((a, b) => b - a);
                          const rank = allRatings.indexOf(ownSnap.rating ?? 0) + 1;
                          const isTop = rank === 1;
                          return (
                            <p className={`font-semibold ${isTop ? 'text-green-400' : 'text-yellow-400'}`}>
                              #{rank} of {allRatings.length} {isTop ? '✓ Highest' : ''}
                            </p>
                          );
                        })()}
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs mb-1">Review Count</p>
                        {(() => {
                          const allRC = products
                            .map((p) => p.snapshot?.payload_json?.reviewCount ?? 0)
                            .filter((r) => r > 0)
                            .sort((a, b) => b - a);
                          const rank = allRC.indexOf(ownSnap.reviewCount ?? 0) + 1;
                          const isTop = rank === 1;
                          return (
                            <p className={`font-semibold ${isTop ? 'text-green-400' : 'text-yellow-400'}`}>
                              #{rank} of {allRC.length} {isTop ? '✓ Most reviewed' : ''}
                            </p>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Offers comparison */}
                  {products.some((p) => p.snapshot?.payload_json?.offers) && (
                    <div className="border-t border-gray-800">
                      <div className="p-3 bg-gray-800/20">
                        <h3 className="text-sm font-semibold text-gray-300 mb-3 tracking-wide">Offers &amp; Deals</h3>
                        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${products.length}, 1fr)` }}>
                          {products.map((prod) => {
                            const snap = prod.snapshot?.payload_json;
                            const o = snap?.offers;
                            return (
                              <div key={prod.id} className={`rounded-lg p-3 text-xs ${prod.is_own ? 'bg-blue-950/30 border border-blue-800/30' : 'bg-gray-800/40 border border-gray-700/30'}`}>
                                <p className="font-semibold text-gray-200 mb-2 truncate">
                                  {prod.is_own && <span className="text-blue-400 mr-1">YOUR</span>}
                                  {snap?.title || prod.asin_or_sku}
                                </p>
                                {o ? (
                                  <div className="space-y-1.5">
                                    {o.mrp && <div><span className="text-gray-500">MRP:</span> <span className="line-through text-gray-400">₹{o.mrp}</span></div>}
                                    {o.discountPct && <div><span className="text-gray-500">Discount:</span> <span className="text-green-400 font-semibold">{o.discountPct}</span></div>}
                                    {o.dealBadge && <div><span className="px-1.5 py-0.5 bg-red-600/30 text-red-300 rounded text-[10px] uppercase tracking-wider">{o.dealBadge}</span></div>}
                                    {o.coupon && <div><span className="px-1.5 py-0.5 bg-green-600/30 text-green-300 rounded text-[10px] uppercase tracking-wider">{o.coupon}</span></div>}
                                    {o.bankOffers?.length > 0 && <div><span className="text-gray-500">Bank:</span> <span className="text-gray-300">{o.bankOffers.length} offer{o.bankOffers.length > 1 ? 's' : ''}</span></div>}
                                    {o.availability && <div><span className="text-gray-500">Stock:</span> <span className={o.availability.toLowerCase().includes('in stock') ? 'text-green-400' : 'text-yellow-400'}>{o.availability}</span></div>}
                                    {o.seller && <div><span className="text-gray-500">Seller:</span> <span className="text-gray-300">{o.seller}</span></div>}
                                    {o.bestSellerRank && <div><span className="text-gray-500">BSR:</span> <span className="text-gray-300">{o.bestSellerRank.substring(0, 120)}</span></div>}
                                  </div>
                                ) : (
                                  <p className="text-gray-500 italic">No offer data yet</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ─── Change Log Panel ─── */}
              {expandedPool === pool.id && (
                <div className="border-t border-gray-800 bg-gray-900/50">
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-300 tracking-wide">Change Log</h3>
                      <div className="flex gap-1">
                        {(['1h', '6h', '24h', '7d', '30d', 'all'] as const).map((period) => (
                          <button
                            key={period}
                            onClick={() => setChangeSince(period)}
                            className={`px-2.5 py-1 rounded text-xs transition ${
                              changeSince === period
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                            }`}
                          >
                            {period}
                          </button>
                        ))}
                      </div>
                    </div>

                    {(() => {
                      const poolChanges = changes[pool.id] ?? [];
                      if (poolChanges.length === 0) {
                        return (
                          <div className="text-center py-8 text-gray-500 text-sm">
                            <p>No changes detected in this period.</p>
                            <p className="text-xs mt-1">Changes are recorded every time a scrape detects differences in title, price, description, reviews, or offers.</p>
                          </div>
                        );
                      }

                      // Group by date
                      const grouped: Record<string, ChangeRecord[]> = {};
                      for (const c of poolChanges) {
                        const day = new Date(c.detected_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                        (grouped[day] ??= []).push(c);
                      }

                      return (
                        <div className="space-y-4 max-h-125 overflow-y-auto pr-2">
                          {Object.entries(grouped).map(([day, dayChanges]) => (
                            <div key={day}>
                              <p className="text-xs text-gray-500 font-medium mb-2 sticky top-0 bg-gray-900/90 py-1">{day}</p>
                              <div className="space-y-1.5">
                                {dayChanges.map((c) => (
                                  (() => {
                                    const insight = summarizeChange(c);
                                    return (
                                  <div
                                    key={c.id}
                                    className={`flex items-start gap-3 p-2.5 rounded-lg text-xs ${
                                      c.is_own ? 'bg-blue-950/20 border-l-2 border-blue-500' : 'bg-gray-800/30 border-l-2 border-red-500/50'
                                    }`}
                                  >
                                    <div className="shrink-0 w-16 text-gray-500">
                                      {new Date(c.detected_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                    <div className="shrink-0">
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.is_own ? 'bg-blue-600/30 text-blue-300' : 'bg-red-600/20 text-red-300'}`}>
                                        {c.is_own ? 'YOUR' : 'COMP'}
                                      </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-gray-300 font-medium truncate">
                                        {c.product_title || c.title_known || c.asin_or_sku}
                                      </p>
                                      <p className="mt-0.5 flex items-center gap-2 flex-wrap">
                                        <span className={`font-semibold ${toneClass(insight.tone)}`}>{insight.label}</span>
                                        <span className="text-gray-500 uppercase text-[10px] tracking-wide">{insight.category}</span>
                                      </p>
                                      <p className="text-gray-300 mt-0.5">{insight.summary}</p>
                                      <p className="text-gray-500 mt-0.5 text-[10px]">
                                        field: {c.field}
                                      </p>
                                    </div>
                                  </div>
                                    );
                                  })()
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
