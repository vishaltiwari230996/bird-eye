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
  const r = await p.query(
    `UPDATE products SET is_own = true
     WHERE pool_id IN (SELECT id FROM pools WHERE name ILIKE 'PW - %')
     RETURNING id`,
  );
  console.log(`Flagged ${r.rowCount} PW products as is_own.`);
  await p.end();
})();
