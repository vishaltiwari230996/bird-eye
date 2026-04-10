import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { log } from '@/lib/logger';
import { consumeToken, politeDelay } from '@/lib/rate-limit';
import { processSnapshot } from '@/lib/differ';
import { notifyChanges } from '@/lib/notify';
import { getAdapter } from '@/adapters';
import type { Product } from '@/adapters/types';

const CONCURRENCY = 4;
const MAX_RETRIES = 2;

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      const delay = Math.min(1000 * 2 ** i, 8000) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/**
 * Hourly cron endpoint — scrapes ALL products and records changes.
 * Vercel Cron triggers this at the top of every hour via vercel.json.
 * Locally, call: POST /api/cron/monitor
 */
export async function GET(req: NextRequest) {
  // Vercel cron sends GET requests. Verify the cron secret if configured.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  return runMonitor();
}

// Also support POST for manual triggers
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  return runMonitor();
}

async function runMonitor() {
  const start = Date.now();

  try {
    const products = await query<Product>(
      'SELECT id, platform, asin_or_sku, url, title_known, last_seen_at FROM products ORDER BY id',
    );

    if (!products.length) {
      return NextResponse.json({ message: 'No products to monitor', durationMs: Date.now() - start });
    }

    log.info('Hourly monitor starting', { totalProducts: products.length });

    const results: Array<{
      productId: number;
      status: string;
      changes: number;
      strategy?: string;
      error?: string;
    }> = [];

    // Process in batches to respect concurrency limit
    for (let i = 0; i < products.length; i += CONCURRENCY) {
      const batch = products.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (product) => {
          const adapter = getAdapter(product.platform);
          if (!adapter) {
            return { productId: product.id, status: 'skipped', changes: 0, error: `No adapter for ${product.platform}` };
          }

          // Rate limit
          const allowed = await consumeToken(`monitor:${product.platform}:${product.asin_or_sku}`);
          if (!allowed) {
            return { productId: product.id, status: 'rate-limited', changes: 0 };
          }

          await politeDelay();

          const fetchResult = await withRetry(() => adapter.fetch(product));

          // Skip empty results
          if (!fetchResult.payload.title && fetchResult.payload.price === 0) {
            return { productId: product.id, status: 'empty', changes: 0, strategy: fetchResult.strategy };
          }

          // Process snapshot — records diffs in DB
          const diffs = await processSnapshot(product, fetchResult.payload);

          // Notify if changes found
          if (diffs.length > 0) {
            await notifyChanges({ product, changes: diffs }).catch((err) =>
              log.warn('Notification failed', { productId: product.id, error: String(err) }),
            );
          }

          return {
            productId: product.id,
            status: 'success',
            changes: diffs.length,
            strategy: fetchResult.strategy,
          };
        }),
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          results.push({ productId: 0, status: 'error', changes: 0, error: String(r.reason) });
        }
      }
    }

    const totalChanges = results.reduce((sum, r) => sum + r.changes, 0);
    const successCount = results.filter((r) => r.status === 'success').length;
    const errorCount = results.filter((r) => r.status === 'error').length;

    log.info('Hourly monitor complete', {
      totalProducts: products.length,
      success: successCount,
      errors: errorCount,
      totalChanges,
      durationMs: Date.now() - start,
    });

    return NextResponse.json({
      monitored: products.length,
      success: successCount,
      errors: errorCount,
      totalChanges,
      durationMs: Date.now() - start,
      results,
    });
  } catch (err) {
    log.error('Monitor cron failed', { error: String(err) });
    return NextResponse.json({ error: 'Monitor failed', detail: String(err) }, { status: 500 });
  }
}
