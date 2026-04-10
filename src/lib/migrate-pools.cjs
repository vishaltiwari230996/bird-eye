const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
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
  console.log('Pools migration done.');
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
