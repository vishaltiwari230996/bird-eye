/**
 * Bulk-import monitored products from a CSV file.
 *
 * CSV columns (header row required):
 *   Publication, Cohort, Title, Link
 *
 * For every row we:
 *   1. Extract the Amazon ASIN from the URL (`/dp/<ASIN>/`).
 *   2. Build a clean canonical URL `https://www.amazon.in/dp/<ASIN>`.
 *   3. Upsert a pool named "<Publication> - <Cohort>".
 *   4. Insert the product (skipping if (platform, asin) already exists).
 *   5. Assign the product to its pool (is_own defaults to false).
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="postgres://..."; node scripts/import-products.cjs "Amazon links - Sheet1.csv"
 *
 * If DATABASE_URL is not already in the environment, the script will try to
 * read it from .env.local in the project root.
 */

const fs = require('fs');
const path = require('path');

// --- Load DATABASE_URL from .env.local if not already set ---------------------
if (!process.env.DATABASE_URL) {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or export it before running.');
  process.exit(1);
}

const { Pool } = require('pg');

const csvPath = process.argv[2] || path.join(__dirname, '..', 'Amazon links - Sheet1.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`CSV file not found: ${csvPath}`);
  process.exit(1);
}

// --- Minimal RFC 4180 CSV parser (handles quoted fields with commas) ---------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (ch === '\r') {
        // ignore, \n handles end-of-line
      } else {
        field += ch;
      }
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function extractAsin(url) {
  if (!url) return null;
  // Matches /dp/<ASIN>/, /gp/product/<ASIN>/, /dp/<ASIN>?...
  const m = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[\/?]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function canonicalUrl(asin) {
  return `https://www.amazon.in/dp/${asin}`;
}

function poolNameFor(publication, cohort) {
  const pub = (publication || '').trim();
  const coh = (cohort || '').trim().replace(/\s+/g, ' ');
  return `${pub} - ${coh}`;
}

async function ensureSchema(pool) {
  // Pools table + product columns may not exist on a fresh DB.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pools (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS pool_id INT REFERENCES pools(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_own BOOLEAN DEFAULT false;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_pool ON products(pool_id);`);
}

async function getOrCreatePool(pool, name) {
  const existing = await pool.query('SELECT id FROM pools WHERE name = $1', [name]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await pool.query('INSERT INTO pools (name) VALUES ($1) RETURNING id', [name]);
  return inserted.rows[0].id;
}

async function main() {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw).filter((r) => r.some((c) => String(c).trim().length > 0));
  if (rows.length === 0) {
    console.error('CSV is empty.');
    process.exit(1);
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    publication: header.indexOf('publication'),
    cohort: header.indexOf('cohort'),
    title: header.indexOf('title'),
    link: header.indexOf('link'),
  };
  if (idx.link === -1) {
    console.error('CSV must have a "Link" column.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });

  await ensureSchema(pool);

  let imported = 0;
  let skipped = 0;
  let assigned = 0;
  let failed = 0;
  const seenAsins = new Set();
  const poolCache = new Map(); // name -> id

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const publication = idx.publication >= 0 ? (row[idx.publication] || '').trim() : '';
    const cohort = idx.cohort >= 0 ? (row[idx.cohort] || '').trim() : '';
    const title = idx.title >= 0 ? (row[idx.title] || '').trim() : '';
    const link = (row[idx.link] || '').trim();

    if (!link) { skipped++; continue; }
    const asin = extractAsin(link);
    if (!asin) {
      console.warn(`[row ${i + 1}] skip — could not extract ASIN from URL: ${link.slice(0, 80)}…`);
      failed++;
      continue;
    }
    if (seenAsins.has(asin)) {
      // Same ASIN appearing twice in the CSV — only insert once.
      skipped++;
      continue;
    }
    seenAsins.add(asin);

    const url = canonicalUrl(asin);

    // Resolve / create pool
    let poolId = null;
    if (publication || cohort) {
      const name = poolNameFor(publication, cohort);
      if (poolCache.has(name)) {
        poolId = poolCache.get(name);
      } else {
        poolId = await getOrCreatePool(pool, name);
        poolCache.set(name, poolId);
      }
    }

    try {
      const existing = await pool.query(
        'SELECT id, pool_id FROM products WHERE platform = $1 AND asin_or_sku = $2',
        ['amazon', asin],
      );

      let productId;
      if (existing.rows.length > 0) {
        productId = existing.rows[0].id;
        skipped++;
      } else {
        const result = await pool.query(
          'INSERT INTO products (platform, asin_or_sku, url, title_known) VALUES ($1, $2, $3, $4) RETURNING id',
          ['amazon', asin, url, title || null],
        );
        productId = result.rows[0].id;
        imported++;
      }

      if (poolId != null) {
        await pool.query(
          'UPDATE products SET pool_id = $1 WHERE id = $2 AND (pool_id IS DISTINCT FROM $1)',
          [poolId, productId],
        );
        assigned++;
      }
    } catch (err) {
      console.error(`[row ${i + 1}] failed for ASIN ${asin}: ${err.message}`);
      failed++;
    }
  }

  const poolCount = await pool.query('SELECT COUNT(*)::int AS n FROM pools');
  const productCount = await pool.query('SELECT COUNT(*)::int AS n FROM products');

  console.log('');
  console.log('Import complete.');
  console.log(`  Inserted products: ${imported}`);
  console.log(`  Already existed:   ${skipped}`);
  console.log(`  Pool assignments:  ${assigned}`);
  console.log(`  Failed rows:       ${failed}`);
  console.log(`  Pools in DB:       ${poolCount.rows[0].n}`);
  console.log(`  Products in DB:    ${productCount.rows[0].n}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
