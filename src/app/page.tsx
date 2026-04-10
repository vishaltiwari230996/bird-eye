'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

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

export default function Dashboard() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Add product form
  const [showForm, setShowForm] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [form, setForm] = useState({
    platform: 'amazon',
    asin_or_sku: '',
    url: '',
    title_known: '',
  });

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

  useEffect(() => {
    fetchProducts();
    const interval = setInterval(fetchProducts, 30_000);
    return () => clearInterval(interval);
  }, [fetchProducts]);

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
    try {
      await fetch('/api/run-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: 0 }),
      });
      await fetchProducts();
    } catch {
      // ignore
    } finally {
      setCheckingAll(false);
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

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">🦅 Bird Eye</h1>
            <p className="text-gray-400 mt-1">Competitor listing monitor</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={runCheckAll}
              disabled={checkingAll || products.length === 0}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                checkingAll
                  ? 'bg-emerald-600/40 text-emerald-200 animate-pulse'
                  : 'bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40'
              }`}
            >
              {checkingAll ? '⏳ Checking…' : '🔄 Check Now'}
            </button>
            <Link
              href="/compare"
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-sm font-medium transition"
            >
              ⚔️ Compare
            </Link>
            <button
              onClick={() => setShowForm(!showForm)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition"
            >
              {showForm ? 'Cancel' : '+ Add Product'}
            </button>
          </div>
        </div>

        {/* Add product form */}
        {showForm && (
          <form onSubmit={addProduct} className="mb-8 p-4 bg-gray-900 rounded-lg border border-gray-800">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Platform</label>
                <select
                  value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
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
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
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
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Title (optional)</label>
                <input
                  value={form.title_known}
                  onChange={(e) => setForm({ ...form, title_known: e.target.value })}
                  placeholder="Product name"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="mt-4 px-6 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-medium transition"
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
              return (
                <div key={p.id} className="bg-gray-900/50 rounded-lg border border-gray-800 overflow-hidden">
                  {/* Main row */}
                  <div
                    className="grid grid-cols-8 gap-4 px-4 py-3 items-center cursor-pointer hover:bg-gray-800/50 transition"
                    onClick={() => setExpandedId(isExpanded ? null : p.id)}
                  >
                    <div>
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          p.platform === 'amazon'
                            ? 'bg-orange-900/50 text-orange-300'
                            : 'bg-yellow-900/50 text-yellow-300'
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
                        className="text-blue-400 hover:text-blue-300 font-medium truncate block text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {snap?.title || p.title_known || p.asin_or_sku}
                      </a>
                      <span className="text-xs text-gray-500">{p.asin_or_sku}</span>
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
                      {snap?.rating != null ? <span>⭐ {snap.rating}</span> : <span className="text-gray-600">—</span>}
                    </div>
                    <div className="text-sm">
                      {snap?.reviewCount != null ? snap.reviewCount.toLocaleString() : <span className="text-gray-600">—</span>}
                    </div>
                    <div className="text-sm text-gray-400">{timeAgo(p.last_seen_at)}</div>
                    <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-3">
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
                    <div className="border-t border-gray-800 px-4 py-4">
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
                                <span>{snap.rating != null ? `⭐ ${snap.rating}` : '—'}</span>
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
                        </div>
                      ) : (
                        <div className="text-center py-4 text-sm text-gray-500">
                          No snapshot data yet. Click <strong>&quot;Check Now&quot;</strong> to scrape this product.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
