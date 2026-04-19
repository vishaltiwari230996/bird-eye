import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

interface PoolRow {
  pool_id: number;
  pool_name: string;
  publisher: string;
  cohort: string;
  is_own_pool: boolean;
  product_count: number;
  avg_price: number | null;
  avg_rating: number | null;
  avg_reviews: number | null;
  total_reviews: number | null;
  in_stock_count: number;
  aplus_count: number;
  avg_bullet_count: number | null;
  avg_image_count: number | null;
  latest_fetched_at: string | null;
  change_count: number;
  price_drops: number;
  price_hikes: number;
  rating_improved: number;
  rating_dropped: number;
  bsr_improved: number;
  bsr_dropped: number;
}

interface CohortGroup {
  cohort: string;
  pw: PoolRow | null;
  competitors: PoolRow[];
  verdict: {
    dimension: string;
    leader: string;
    leaderValue: string;
    pwValue: string;
    tone: 'good' | 'bad' | 'neutral';
  }[];
}

function mapInterval(since: string): string {
  if (since === '24h') return '24 hours';
  if (since === '7d') return '7 days';
  if (since === '30d') return '30 days';
  if (since === 'all') return '365 days';
  return '7 days';
}

// "PW - Class 10" → { publisher: "PW", cohort: "Class 10" }
function splitPoolName(name: string): { publisher: string; cohort: string } {
  const idx = name.indexOf(' - ');
  if (idx < 0) return { publisher: name, cohort: name };
  return { publisher: name.slice(0, idx).trim(), cohort: name.slice(idx + 3).trim() };
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function fmtRating(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
}

function buildVerdicts(pw: PoolRow | null, competitors: PoolRow[]): CohortGroup['verdict'] {
  if (!pw || competitors.length === 0) return [];
  const verdicts: CohortGroup['verdict'] = [];

  // Rating: higher is better
  const rated = [pw, ...competitors].filter((x) => x.avg_rating != null);
  if (rated.length >= 2) {
    const leader = rated.reduce((a, b) => ((b.avg_rating ?? 0) > (a.avg_rating ?? 0) ? b : a));
    verdicts.push({
      dimension: 'Avg rating',
      leader: leader.publisher,
      leaderValue: fmtRating(leader.avg_rating),
      pwValue: fmtRating(pw.avg_rating),
      tone: leader.is_own_pool ? 'good' : 'bad',
    });
  }

  // Review volume: higher is better
  const reviewed = [pw, ...competitors].filter((x) => x.total_reviews != null && x.total_reviews > 0);
  if (reviewed.length >= 2) {
    const leader = reviewed.reduce((a, b) => ((b.total_reviews ?? 0) > (a.total_reviews ?? 0) ? b : a));
    verdicts.push({
      dimension: 'Total reviews',
      leader: leader.publisher,
      leaderValue: fmtInt(leader.total_reviews),
      pwValue: fmtInt(pw.total_reviews),
      tone: leader.is_own_pool ? 'good' : 'bad',
    });
  }

  // Price: for books, lower avg is usually more competitive; flag as neutral
  const priced = [pw, ...competitors].filter((x) => x.avg_price != null && x.avg_price > 0);
  if (priced.length >= 2) {
    const cheapest = priced.reduce((a, b) => ((b.avg_price ?? 0) < (a.avg_price ?? 0) ? b : a));
    verdicts.push({
      dimension: 'Avg price',
      leader: cheapest.publisher,
      leaderValue: fmtPrice(cheapest.avg_price),
      pwValue: fmtPrice(pw.avg_price),
      tone: 'neutral',
    });
  }

  // Listing quality: A+ coverage
  const withProducts = [pw, ...competitors].filter((x) => x.product_count > 0);
  if (withProducts.length >= 2) {
    const rate = (x: PoolRow) => x.aplus_count / x.product_count;
    const leader = withProducts.reduce((a, b) => (rate(b) > rate(a) ? b : a));
    verdicts.push({
      dimension: 'A+ coverage',
      leader: leader.publisher,
      leaderValue: `${leader.aplus_count}/${leader.product_count}`,
      pwValue: `${pw.aplus_count}/${pw.product_count}`,
      tone: leader.is_own_pool ? 'good' : 'bad',
    });
  }

  return verdicts;
}

export async function GET(req: NextRequest) {
  const since = req.nextUrl.searchParams.get('since') || '7d';
  const interval = mapInterval(since);

  try {
    const rows = await query<PoolRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (s.product_id)
                s.product_id,
                s.payload_json,
                s.fetched_at
         FROM snapshots s
         ORDER BY s.product_id, s.fetched_at DESC
       ),
       prod AS (
         SELECT p.id,
                p.pool_id,
                p.is_own,
                NULLIF(l.payload_json->>'price','')::numeric AS price,
                NULLIF(l.payload_json->>'rating','')::numeric AS rating,
                NULLIF(l.payload_json->>'reviewCount','')::int AS review_count,
                l.payload_json->'offers'->>'availability' AS availability,
                COALESCE((l.payload_json->'seo'->>'hasAPlus')::boolean, false) AS has_aplus,
                NULLIF(l.payload_json->'seo'->>'bulletCount','')::int AS bullet_count,
                NULLIF(l.payload_json->'seo'->>'imageCount','')::int AS image_count,
                l.fetched_at
         FROM products p
         LEFT JOIN latest l ON l.product_id = p.id
         WHERE p.pool_id IS NOT NULL
       ),
       pool_agg AS (
         SELECT pr.pool_id,
                COUNT(*)::int AS product_count,
                AVG(pr.price)::numeric AS avg_price,
                AVG(pr.rating)::numeric AS avg_rating,
                AVG(pr.review_count)::numeric AS avg_reviews,
                SUM(pr.review_count)::bigint AS total_reviews,
                SUM(CASE WHEN LOWER(COALESCE(pr.availability,'')) LIKE '%in stock%' THEN 1 ELSE 0 END)::int AS in_stock_count,
                SUM(CASE WHEN pr.has_aplus THEN 1 ELSE 0 END)::int AS aplus_count,
                AVG(pr.bullet_count)::numeric AS avg_bullet_count,
                AVG(pr.image_count)::numeric AS avg_image_count,
                MAX(pr.fetched_at) AS latest_fetched_at,
                BOOL_OR(pr.is_own) AS is_own_pool
         FROM prod pr
         GROUP BY pr.pool_id
       ),
       change_agg AS (
         SELECT p.pool_id,
                COUNT(*)::int AS change_count,
                SUM(CASE WHEN c.field = 'price'
                         AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
                           < NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS price_drops,
                SUM(CASE WHEN c.field = 'price'
                         AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
                           > NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS price_hikes,
                SUM(CASE WHEN c.field = 'rating'
                         AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
                           > NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS rating_improved,
                SUM(CASE WHEN c.field = 'rating'
                         AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
                           < NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS rating_dropped,
                SUM(CASE WHEN c.field = 'offers.bsr'
                         AND NULLIF(regexp_replace(substring(c.new_value from '#\\s*([0-9,]+)'),'[^0-9]','','g'),'')::numeric
                           < NULLIF(regexp_replace(substring(c.old_value from '#\\s*([0-9,]+)'),'[^0-9]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS bsr_improved,
                SUM(CASE WHEN c.field = 'offers.bsr'
                         AND NULLIF(regexp_replace(substring(c.new_value from '#\\s*([0-9,]+)'),'[^0-9]','','g'),'')::numeric
                           > NULLIF(regexp_replace(substring(c.old_value from '#\\s*([0-9,]+)'),'[^0-9]','','g'),'')::numeric
                         THEN 1 ELSE 0 END)::int AS bsr_dropped
         FROM changes c
         JOIN products p ON p.id = c.product_id
         WHERE p.pool_id IS NOT NULL
           AND c.detected_at >= now() - $1::interval
         GROUP BY p.pool_id
       )
       SELECT pl.id AS pool_id,
              pl.name AS pool_name,
              COALESCE(pa.is_own_pool, false) AS is_own_pool,
              COALESCE(pa.product_count, 0) AS product_count,
              pa.avg_price,
              pa.avg_rating,
              pa.avg_reviews,
              pa.total_reviews,
              COALESCE(pa.in_stock_count, 0) AS in_stock_count,
              COALESCE(pa.aplus_count, 0) AS aplus_count,
              pa.avg_bullet_count,
              pa.avg_image_count,
              pa.latest_fetched_at,
              COALESCE(ca.change_count, 0) AS change_count,
              COALESCE(ca.price_drops, 0) AS price_drops,
              COALESCE(ca.price_hikes, 0) AS price_hikes,
              COALESCE(ca.rating_improved, 0) AS rating_improved,
              COALESCE(ca.rating_dropped, 0) AS rating_dropped,
              COALESCE(ca.bsr_improved, 0) AS bsr_improved,
              COALESCE(ca.bsr_dropped, 0) AS bsr_dropped
       FROM pools pl
       LEFT JOIN pool_agg pa ON pa.pool_id = pl.id
       LEFT JOIN change_agg ca ON ca.pool_id = pl.id
       ORDER BY pl.name`,
      [interval],
    );

    // Split pool_name → publisher + cohort
    const enriched: PoolRow[] = rows.map((r: any) => {
      const { publisher, cohort } = splitPoolName(r.pool_name);
      return {
        ...r,
        avg_price: r.avg_price != null ? Number(r.avg_price) : null,
        avg_rating: r.avg_rating != null ? Number(r.avg_rating) : null,
        avg_reviews: r.avg_reviews != null ? Number(r.avg_reviews) : null,
        total_reviews: r.total_reviews != null ? Number(r.total_reviews) : null,
        avg_bullet_count: r.avg_bullet_count != null ? Number(r.avg_bullet_count) : null,
        avg_image_count: r.avg_image_count != null ? Number(r.avg_image_count) : null,
        publisher,
        cohort,
      };
    });

    // Group by cohort; only cohorts with at least one PW pool show up as battlegrounds.
    const byCohort = new Map<string, PoolRow[]>();
    for (const row of enriched) {
      if (!byCohort.has(row.cohort)) byCohort.set(row.cohort, []);
      byCohort.get(row.cohort)!.push(row);
    }

    const cohorts: CohortGroup[] = [];
    const stragglers: PoolRow[] = [];
    for (const [cohort, pools] of byCohort) {
      const pw = pools.find((p) => p.publisher.toUpperCase() === 'PW') || null;
      const competitors = pools.filter((p) => p !== pw).sort((a, b) => a.publisher.localeCompare(b.publisher));
      if (!pw) {
        stragglers.push(...pools);
        continue;
      }
      cohorts.push({
        cohort,
        pw,
        competitors,
        verdict: buildVerdicts(pw, competitors),
      });
    }

    // Sort cohorts with a stable, human-friendly order.
    cohorts.sort((a, b) => a.cohort.localeCompare(b.cohort));

    return NextResponse.json({
      since,
      cohorts,
      stragglers,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to build battleground', detail: String(err) }, { status: 500 });
  }
}
