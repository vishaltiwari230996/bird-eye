import { NextRequest, NextResponse } from 'next/server';

interface PoolRow {
  pool_id: number;
  pool_name: string;
  publisher: string;
  cohort: string;
  is_own_pool: boolean;
  product_count: number;
  avg_price: number | null;
  avg_rating: number | null;
  total_reviews: number | null;
  in_stock_count: number;
  aplus_count: number;
  avg_bullet_count: number | null;
  avg_image_count: number | null;
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
}

function parseJsonFromText(content: string): any {
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch { /* fallthrough */ }
  const block = trimmed.match(/```json\s*([\s\S]*?)\s*```/i) || trimmed.match(/```\s*([\s\S]*?)\s*```/i);
  if (block?.[1]) { try { return JSON.parse(block[1]); } catch { /* fallthrough */ } }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fallthrough */ }
  }
  return { headline: trimmed, wins: [], gaps: [], moves: [], watch: [] };
}

function describePool(p: PoolRow): string {
  const rating = p.avg_rating != null ? p.avg_rating.toFixed(2) : 'na';
  const price = p.avg_price != null ? `₹${Math.round(p.avg_price)}` : 'na';
  const reviews = p.total_reviews ?? 0;
  return `${p.publisher} (n=${p.product_count}) | price=${price} | rating=${rating} | reviews=${reviews} | in_stock=${p.in_stock_count}/${p.product_count} | aplus=${p.aplus_count}/${p.product_count} | changes=${p.change_count} (price_drops=${p.price_drops}, price_hikes=${p.price_hikes}, rating_up=${p.rating_improved}, rating_down=${p.rating_dropped}, bsr_up=${p.bsr_improved}, bsr_down=${p.bsr_dropped})`;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const cohorts: CohortGroup[] = Array.isArray(body.cohorts) ? body.cohorts : [];
    const since: string = typeof body.since === 'string' ? body.since : '7d';

    if (cohorts.length === 0) {
      return NextResponse.json({ error: 'No cohorts supplied' }, { status: 400 });
    }

    const lines: string[] = [];
    for (const cg of cohorts) {
      lines.push(`## Cohort: ${cg.cohort}`);
      if (cg.pw) lines.push(`- PW  → ${describePool(cg.pw)}`);
      for (const comp of cg.competitors) {
        lines.push(`- CMP → ${describePool(comp)}`);
      }
      lines.push('');
    }

    const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v3.2';

    const system =
      'You are a senior brand strategist at Physics Wallah (PW). You are comparing PW book listings against competitors in the same cohort (Class 10, Class 11, JEE, NEET etc.) on Amazon India. Return strict JSON only. Write like you are briefing a leadership standup — crisp, specific, no fluff. Ground every point in the numbers supplied.';

    const user = [
      `Time window: ${since}`,
      'Data per cohort follows. PW rows are prefixed with "PW →", competitors with "CMP →".',
      '',
      lines.join('\n'),
      '',
      'Task:',
      '- Produce one overall "headline" (<= 28 words) summarising how PW is doing vs competitors across cohorts.',
      '- "wins": 3-5 concrete wins for PW with the cohort and metric cited.',
      '- "gaps": 3-5 places where a specific competitor is leading PW. Name the publisher and the metric.',
      '- "moves": 3-5 specific tactical moves PW should run this week (pricing, listing, offers, reviews).',
      '- "watch": 2-4 signals to monitor next.',
      '',
      'Output JSON schema exactly:',
      '{"headline":"...","wins":["..."],"gaps":["..."],"moves":["..."],"watch":["..."]}',
    ].join('\n');

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://bird-eye-two.vercel.app',
        'X-Title': 'Bird Eye Battleground',
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
      headline: typeof parsed.headline === 'string' ? parsed.headline : '',
      wins: Array.isArray(parsed.wins) ? parsed.wins : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      moves: Array.isArray(parsed.moves) ? parsed.moves : [],
      watch: Array.isArray(parsed.watch) ? parsed.watch : [],
      model,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to build brief', detail: String(err) }, { status: 500 });
  }
}
