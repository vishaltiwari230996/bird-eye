const fs = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await p.query(`
    SELECT pl.id, pl.name, COUNT(pr.id) AS products,
           SUM(CASE WHEN pr.is_own THEN 1 ELSE 0 END) AS own_count
    FROM pools pl LEFT JOIN products pr ON pr.pool_id = pl.id
    GROUP BY pl.id, pl.name ORDER BY pl.id`);
  console.table(r.rows);
  await p.end();
})();
