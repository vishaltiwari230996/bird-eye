import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { log } from '@/lib/logger';
import { consumeToken, politeDelay } from '@/lib/rate-limit';
import { processSnapshot } from '@/lib/differ';
import { notifyChanges } from '@/lib/notify';
import { getAdapter } from '@/adapters';
import type { Product } from '@/adapters/types';

const BATCH_SIZE = 10;
const CONCURRENCY = 4;
const MAX_RETRIES = 2;

/** Retry with exponential backoff + jitter */
async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      const baseDelay = 1000 * Math.pow(2, attempt);
      const jitter = Math.random() * 500;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
  }
}

/** Run tasks with limited concurrency */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = fn(item).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

export async function POST(req: NextRequest) {
  const start = Date.now();

  // Auth: require CRON_SECRET for external callers.
  // Allow same-origin requests (browser "Check Now" button) without auth.
  const secret = req.headers.get('authorization')?.replace('Bearer ', '');
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  const host = req.headers.get('host') || 'localhost';
  const isSameOrigin =
    origin.includes(host) ||
    referer.includes(host) ||
    (!origin && !referer); // e.g. local dev curl

  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET && !isSameOrigin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let batchIndex = 0;
  let singleProductId: number | null = null;
  try {
    const body = await req.json();
    batchIndex = Number(body.batch) || 0;
    if (body.productId) singleProductId = Number(body.productId);
  } catch {
    // default batch 0
  }

  let products: Product[];

  if (singleProductId) {
    products = await query<Product>(
      'SELECT id, platform, asin_or_sku, url, title_known, last_seen_at FROM products WHERE id = $1',
      [singleProductId],
    );
  } else {
    const offset = batchIndex * BATCH_SIZE;
    products = await query<Product>(
      'SELECT id, platform, asin_or_sku, url, title_known, last_seen_at FROM products ORDER BY id LIMIT $1 OFFSET $2',
      [BATCH_SIZE, offset],
    );
  }

  if (products.length === 0) {
    return NextResponse.json({ message: singleProductId ? 'Product not found' : 'No products in this batch', batch: batchIndex });
  }

  log.info('run-check started', { batch: batchIndex, count: products.length, singleProductId });

  const results: {
    productId: number;
    status: string;
    changes: number;
    strategy?: string;
    fallbackLevel?: number;
    durationMs?: number;
    error?: string;
  }[] = [];

  await runConcurrent(products, CONCURRENCY, async (product) => {
    const productStart = Date.now();
    try {
      // Rate limit check
      const allowed = await consumeToken(product.platform);
      if (!allowed) {
        results.push({ productId: product.id, status: 'rate_limited', changes: 0 });
        log.warn('Skipping product — rate limited', {
          productId: product.id,
          platform: product.platform,
        });
        return;
      }

      await politeDelay();

      const adapter = getAdapter(product.platform);
      const fetchResult = await withRetry(() => adapter.fetch(product));

      if (fetchResult.fallbackLevel > 0) {
        log.warn('Parse drift detected', {
          productId: product.id,
          platform: product.platform,
          fallbackLevel: fetchResult.fallbackLevel as any,
          strategy: fetchResult.strategy,
        });
      }

      // Diff & store
      const changes = await processSnapshot(product, fetchResult.payload);

      // Notify if changes
      if (changes.length > 0) {
        await notifyChanges({ product, changes });
      }

      results.push({
        productId: product.id,
        status: 'success',
        changes: changes.length,
        strategy: fetchResult.strategy,
        fallbackLevel: fetchResult.fallbackLevel,
        durationMs: fetchResult.durationMs,
      });

      log.info('Product checked', {
        productId: product.id,
        platform: product.platform,
        duration: Date.now() - productStart,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        productId: product.id,
        status: 'error',
        changes: 0,
        error: errMsg,
        durationMs: Date.now() - productStart,
      });
      log.error('Product check failed', {
        productId: product.id,
        platform: product.platform,
        error: errMsg as any,
      });
    }
  });

  const totalDuration = Date.now() - start;
  const successCount = results.filter((r) => r.status === 'success').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  log.info('run-check completed', {
    batch: batchIndex,
    total: products.length,
    success: successCount as any,
    errors: errorCount as any,
    duration: totalDuration,
  });

  return NextResponse.json({
    batch: batchIndex,
    processed: products.length,
    success: successCount,
    errors: errorCount,
    durationMs: totalDuration,
    results,
  });
}

// Also allow GET for easy testing
export async function GET(req: NextRequest) {
  return POST(req);
}
