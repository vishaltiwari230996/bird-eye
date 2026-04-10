import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { log } from '@/lib/logger';

// PUT /api/pools/assign — assign a product to a pool
// Body: { product_id: number, pool_id: number | null, is_own?: boolean }
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { product_id, pool_id, is_own } = body;

    if (!product_id || typeof product_id !== 'number') {
      return NextResponse.json({ error: 'product_id (number) is required' }, { status: 400 });
    }

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    // pool_id can be null (unassign)
    sets.push(`pool_id = $${idx++}`);
    params.push(pool_id ?? null);

    if (is_own !== undefined) {
      sets.push(`is_own = $${idx++}`);
      params.push(!!is_own);
    }

    params.push(product_id);
    const result = await query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    if (result.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    log.info('Product assigned to pool', { productId: product_id, poolId: pool_id });
    return NextResponse.json(result[0]);
  } catch (err) {
    log.error('Assign pool error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
