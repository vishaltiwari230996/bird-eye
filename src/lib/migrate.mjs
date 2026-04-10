// Database migration — run with `npm run db:migrate`
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const UP = `
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('amazon','flipkart')),
  asin_or_sku   TEXT NOT NULL,
  url           TEXT NOT NULL,
  title_known   TEXT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, asin_or_sku)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  payload_json JSONB NOT NULL,
  hash        TEXT NOT NULL,
  fetched_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_product ON snapshots(product_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS changes (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  detected_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_changes_product ON changes(product_id, detected_at DESC);
`;

async function migrate() {
  console.log('[migrate] Running database migration…');
  await pool.query(UP);
  console.log('[migrate] Done.');
  await pool.end();
}

migrate().catch((err) => { console.error(err); process.exit(1); });
