import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { log } from '@/lib/logger';

const VALID_PLATFORMS = ['amazon', 'flipkart'];

// GET /api/products — list all products
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: 'DATABASE_URL not configured. Add it to .env.local — get a free Postgres at https://neon.tech' },
      { status: 503 },
    );
  }
  try {
    const products = await query(
      `SELECT p.*,
         (SELECT row_to_json(s.*) FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS last_snapshot,
         (SELECT json_agg(c.*) FROM (
           SELECT * FROM changes
           WHERE product_id = p.id
             AND (old_value IS NOT NULL AND old_value <> '' AND old_value <> '—')
           ORDER BY detected_at DESC LIMIT 10
         ) c) AS recent_changes
       FROM products p ORDER BY p.id`,
    );
    return NextResponse.json(products);
  } catch (err) {
    log.error('Failed to load products', { error: String(err) });
    return NextResponse.json({ error: 'Database connection failed. Check DATABASE_URL.' }, { status: 503 });
  }
}

// POST /api/products — create a new product
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { platform, asin_or_sku, url, title_known } = body;

    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return NextResponse.json(
        { error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` },
        { status: 400 },
      );
    }
    if (!asin_or_sku || typeof asin_or_sku !== 'string') {
      return NextResponse.json({ error: 'asin_or_sku is required' }, { status: 400 });
    }
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    const existing = await queryOne(
      'SELECT id FROM products WHERE platform = $1 AND asin_or_sku = $2',
      [platform, asin_or_sku],
    );
    if (existing) {
      return NextResponse.json({ error: 'Product already exists', id: (existing as any).id }, { status: 409 });
    }

    const result = await queryOne<{ id: number }>(
      'INSERT INTO products (platform, asin_or_sku, url, title_known) VALUES ($1, $2, $3, $4) RETURNING id',
      [platform, asin_or_sku, url, title_known || null],
    );

    log.info('Product created', { productId: result!.id, platform });
    return NextResponse.json({ id: result!.id }, { status: 201 });
  } catch (err) {
    log.error('Create product error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT /api/products — update a product (by id in body)
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, url, title_known } = body;

    if (!id || typeof id !== 'number') {
      return NextResponse.json({ error: 'id (number) is required' }, { status: 400 });
    }

    if (url) {
      try {
        new URL(url);
      } catch {
        return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
      }
    }

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (url) {
      sets.push(`url = $${idx++}`);
      params.push(url);
    }
    if (title_known !== undefined) {
      sets.push(`title_known = $${idx++}`);
      params.push(title_known);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    params.push(id);
    const result = await query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    if (result.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    log.info('Product updated', { productId: id });
    return NextResponse.json(result[0]);
  } catch (err) {
    log.error('Update product error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/products — delete a product (by id in query or body)
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get('id'));

    if (!id) {
      return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 });
    }

    const result = await query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    if (result.length === 0) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    log.info('Product deleted', { productId: id });
    return NextResponse.json({ deleted: id });
  } catch (err) {
    log.error('Delete product error', { error: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
