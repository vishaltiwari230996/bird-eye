import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// GET /api/pools/changes?pool_id=1&since=24h
// Returns change history for all products in a pool
export async function GET(req: NextRequest) {
  const poolId = req.nextUrl.searchParams.get('pool_id');
  const since = req.nextUrl.searchParams.get('since') || '24h';

  if (!poolId) {
    return NextResponse.json({ error: 'pool_id is required' }, { status: 400 });
  }

  // Parse the "since" param into an interval
  let interval = '24 hours';
  if (since === '1h') interval = '1 hour';
  else if (since === '6h') interval = '6 hours';
  else if (since === '24h') interval = '24 hours';
  else if (since === '7d') interval = '7 days';
  else if (since === '30d') interval = '30 days';
  else if (since === 'all') interval = '365 days';

  try {
    const changes = await query(
      `SELECT c.id, c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
              p.asin_or_sku, p.platform, p.is_own, p.title_known,
              (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS product_title
       FROM changes c
       JOIN products p ON p.id = c.product_id
       WHERE p.pool_id = $1
         AND c.detected_at >= now() - $2::interval
       ORDER BY c.detected_at DESC
       LIMIT 500`,
      [poolId, interval],
    );

    return NextResponse.json(changes);
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load changes', detail: String(err) }, { status: 500 });
  }
}
