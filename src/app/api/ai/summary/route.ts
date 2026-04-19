import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { summarizeChange } from '@/lib/change-intel';

interface ChangeRow {
  id: number;
  product_id: number;
  field: string;
  old_value: string;
  new_value: string;
  detected_at: string;
  asin_or_sku: string;
  platform: string;
  is_own: boolean;
  pool_id: number | null;
  pool_name: string | null;
  product_title: string | null;
  title_known: string | null;
}

interface SnapshotRow {
  product_id: number;
  title: string | null;
  price: number | null;
  rating: number | null;
  review_count: number | null;
  bsr: string | null;
  availability: string | null;
}

function mapInterval(since: string): string {
  if (since === '1h') return '1 hour';
  if (since === '6h') return '6 hours';
  if (since === '24h') return '24 hours';
  if (since === '7d') return '7 days';
  if (since === '30d') return '30 days';
  if (since === 'all') return '365 days';
  return '24 hours';
}

function compactChangeLine(c: ChangeRow): string {
  const insight = summarizeChange(c);
  const role = c.is_own ? 'YOUR' : 'COMP';
  const title = c.product_title || c.title_known || c.asin_or_sku;
  const pool = c.pool_name ? ` | pool=${c.pool_name}` : '';
  return `${role} | ${title} | ${insight.label} | ${insight.summary}${pool}`;
}

function parseJsonFromText(content: string): any {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const codeBlock = trimmed.match(/```json\s*([\s\S]*?)\s*```/i) || trimmed.match(/```\s*([\s\S]*?)\s*```/i);
  if (codeBlock?.[1]) {
    try {
      return JSON.parse(codeBlock[1]);
    } catch {
      // continue
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  return {
    summary: trimmed,
    highlights: [],
    risks: [],
    actions: [],
  };
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const since = typeof body.since === 'string' ? body.since : '24h';
    const poolId = body.poolId ? Number(body.poolId) : null;
    const interval = mapInterval(since);

    const changes: ChangeRow[] = poolId
      ? await query(
          `SELECT c.id, c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
                  p.asin_or_sku, p.platform, p.is_own, p.pool_id, p.title_known,
                  pl.name AS pool_name,
                  (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS product_title
           FROM changes c
           JOIN products p ON p.id = c.product_id
           LEFT JOIN pools pl ON pl.id = p.pool_id
           WHERE p.pool_id = $1
             AND c.detected_at >= now() - $2::interval
           ORDER BY c.detected_at DESC
           LIMIT 180`,
          [poolId, interval],
        )
      : await query(
          `SELECT c.id, c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
                  p.asin_or_sku, p.platform, p.is_own, p.pool_id, p.title_known,
                  pl.name AS pool_name,
                  (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS product_title
           FROM changes c
           JOIN products p ON p.id = c.product_id
           LEFT JOIN pools pl ON pl.id = p.pool_id
           WHERE c.detected_at >= now() - $1::interval
           ORDER BY c.detected_at DESC
           LIMIT 180`,
          [interval],
        );

    const snapshots: SnapshotRow[] = poolId
      ? await query(
          `SELECT p.id AS product_id,
                  s.payload_json->>'title' AS title,
                  NULLIF(s.payload_json->>'price', '')::numeric AS price,
                  NULLIF(s.payload_json->>'rating', '')::numeric AS rating,
                  NULLIF(s.payload_json->>'reviewCount', '')::int AS review_count,
                  s.payload_json->'offers'->>'bestSellerRank' AS bsr,
                  s.payload_json->'offers'->>'availability' AS availability
           FROM products p
           LEFT JOIN LATERAL (
             SELECT payload_json
             FROM snapshots
             WHERE product_id = p.id
             ORDER BY fetched_at DESC
             LIMIT 1
           ) s ON true
           WHERE p.pool_id = $1
           LIMIT 150`,
          [poolId],
        )
      : await query(
          `SELECT p.id AS product_id,
                  s.payload_json->>'title' AS title,
                  NULLIF(s.payload_json->>'price', '')::numeric AS price,
                  NULLIF(s.payload_json->>'rating', '')::numeric AS rating,
                  NULLIF(s.payload_json->>'reviewCount', '')::int AS review_count,
                  s.payload_json->'offers'->>'bestSellerRank' AS bsr,
                  s.payload_json->'offers'->>'availability' AS availability
           FROM products p
           LEFT JOIN LATERAL (
             SELECT payload_json
             FROM snapshots
             WHERE product_id = p.id
             ORDER BY fetched_at DESC
             LIMIT 1
           ) s ON true
           LIMIT 150`,
          [],
        );

    const changeLines = changes.slice(0, 120).map(compactChangeLine).join('\n');
    const snapshotLines = snapshots
      .slice(0, 60)
      .map((s) => `${s.title || `product:${s.product_id}`} | price=${s.price ?? 'na'} | rating=${s.rating ?? 'na'} | reviews=${s.review_count ?? 'na'} | bsr=${s.bsr || 'na'} | stock=${s.availability || 'na'}`)
      .join('\n');

    const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2';

    const system =
      'You are an elite ecommerce listing analyst for Indian marketplaces. Return only strict JSON with keys summary, highlights, risks, actions, watchlist. Keep each array 3-6 bullet strings. Use concise business language and mention rank/bsr/price/listing quality signals.';

    const user = [
      `Time window: ${since}`,
      poolId ? `Scope: pool ${poolId}` : 'Scope: all books',
      '',
      'Recent normalized changes:',
      changeLines || 'No changes',
      '',
      'Latest listing snapshot digest:',
      snapshotLines || 'No snapshot data',
      '',
      'Task:',
      '- Summarize what changed and why it matters.',
      '- Highlight top wins and top risks.',
      '- Recommend concrete next actions for listing optimization and competitor response.',
      '- Mention suspicious scrape drift if data appears noisy or contradictory.',
      '',
      'Output JSON schema exactly:',
      '{"summary":"...","highlights":["..."],"risks":["..."],"actions":["..."],"watchlist":["..."]}',
    ].join('\n');

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://bird-eye-two.vercel.app',
        'X-Title': 'Bird Eye Listing Monitor',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return NextResponse.json({ error: 'OpenRouter request failed', detail }, { status: 502 });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonFromText(content);

    return NextResponse.json({
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary generated',
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      model,
      changesAnalyzed: changes.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to generate AI summary', detail: String(err) }, { status: 500 });
  }
}
