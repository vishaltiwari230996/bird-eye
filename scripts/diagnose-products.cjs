/**
 * Diagnose the state of each product in the DB:
 *   - how many snapshots it has
 *   - how many non-empty snapshots (title + price present)
 *   - its latest strategy/fallback indicator if recorded
 *
 * Usage: node scripts/diagnose-products.cjs
 */
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i === -1) continue;
      const k = trimmed.slice(0, i).trim();
      let v = trimmed.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const products = await pool.query(`
    SELECT p.id, p.platform, p.asin_or_sku, p.title_known, p.last_seen_at,
      (SELECT COUNT(*) FROM snapshots s WHERE s.product_id = p.id)::int AS snap_count,
      (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS latest_title,
      (SELECT (s.payload_json->>'price')::float FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS latest_price,
      (SELECT s.fetched_at FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS latest_fetched_at
    FROM products p
    ORDER BY p.id
  `);

  const empty = products.rows.filter((r) => r.snap_count === 0 || !r.latest_price);
  const good = products.rows.filter((r) => r.snap_count > 0 && r.latest_price);

  console.log(`Total products:    ${products.rows.length}`);
  console.log(`With good snapshot: ${good.length}`);
  console.log(`Missing/empty:     ${empty.length}`);
  console.log('');
  console.log('Missing products (id | asin | last_seen | snap_count | latest_title):');
  for (const r of empty.slice(0, 50)) {
    console.log(
      `  ${String(r.id).padStart(3)} | ${r.asin_or_sku} | ${r.last_seen_at ? new Date(r.last_seen_at).toISOString() : 'never'} | snaps=${r.snap_count} | ${r.latest_title ? r.latest_title.slice(0, 60) : '(no payload)'}`,
    );
  }

  await pool.end();
})();
