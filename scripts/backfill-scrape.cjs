/**
 * Iterate through every run-check batch until the server says it's empty.
 * Useful for backfilling a large import (CSV) after the first run.
 */
const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let batch = 0;
  let totalSuccess = 0;
  let totalChanges = 0;
  let totalLowConf = 0;
  while (batch < 20) {
    process.stdout.write(`Batch ${batch}… `);
    const started = Date.now();
    let r;
    try {
      r = await post('/api/run-check', { batch });
    } catch (err) {
      console.log(`request failed: ${err.message}`);
      break;
    }
    const durationSec = ((Date.now() - started) / 1000).toFixed(1);
    if (!r.body || !Array.isArray(r.body.results)) {
      console.log(`done (${r.body?.message || 'no results'})`);
      break;
    }
    const results = r.body.results;
    const success = results.filter((x) => x.status === 'success').length;
    const lowConf = results.filter((x) => x.status === 'low_confidence').length;
    const errored = results.filter((x) => x.status === 'error').length;
    const empty = results.filter((x) => x.status === 'empty').length;
    const changes = results.reduce((s, x) => s + (x.changes || 0), 0);
    totalSuccess += success;
    totalChanges += changes;
    totalLowConf += lowConf;
    console.log(
      `processed=${results.length} ok=${success} low_conf=${lowConf} empty=${empty} err=${errored} changes=${changes} (${durationSec}s)`,
    );
    if (results.length === 0) break;
    batch++;
  }
  console.log(`\nTotals: ok=${totalSuccess} low_conf=${totalLowConf} changes=${totalChanges}`);
})();
