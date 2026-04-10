import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { log } from '@/lib/logger';

// GET /api/pools — list all pools with their products and latest data
export async function GET() {
  try {
    const pools = await query(`
      SELECT p.*,
        (
          SELECT json_agg(
            json_build_object(
              'id', pr.id,
              'platform', pr.platform,
              'asin_or_sku', pr.asin_or_sku,
              'url', pr.url,
              'title_known', pr.title_known,
              'is_own', pr.is_own,
              'last_seen_at', pr.last_seen_at,
              'snapshot', (
                SELECT row_to_json(s.*)
                FROM snapshots s
                WHERE s.product_id = pr.id
                ORDER BY s.fetched_at DESC LIMIT 1
              )
            ) ORDER BY pr.is_own DESC, pr.id
          )
          FROM products pr WHERE pr.pool_id = p.id
        ) AS products
      FROM pools p ORDER BY p.created_at DESC
    `);
    return NextResponse.json(pools);
  } catch (err) {
    log.error('Failed to load pools', { error: String(err) });
    return NextResponse.json({ error: 'Failed to load pools' }, { status: 500 });
  }
}

// POST /api/pools — create a pool
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Pool name is required' }, { status: 400 });
    }

    const existing = await queryOne('SELECT id FROM pools WHERE name = $1', [name.trim()]);
    if (existing) {
      return NextResponse.json({ error: 'Pool already exists', id: (existing as any).id }, { status: 409 });
    }

    const result = await queryOne<{ id: number }>(
      'INSERT INTO pools (name) VALUES ($1) RETURNING id',
      [name.trim()],
    );

    log.info('Pool created', { poolId: result!.id, name: name.trim() });
    return NextResponse.json({ id: result!.id }, { status: 201 });
  } catch (err) {
    log.error('Create pool error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/pools?id=1
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get('id'));
    if (!id) {
      return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
    }

    // Unassign products from this pool
    await query('UPDATE products SET pool_id = NULL WHERE pool_id = $1', [id]);
    const result = await query('DELETE FROM pools WHERE id = $1 RETURNING id', [id]);
    if (result.length === 0) {
      return NextResponse.json({ error: 'Pool not found' }, { status: 404 });
    }

    log.info('Pool deleted', { poolId: id });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    log.error('Delete pool error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
