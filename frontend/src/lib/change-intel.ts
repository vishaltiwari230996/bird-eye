export interface ChangeLike {
  field: string;
  old_value: string;
  new_value: string;
}

export interface ChangeInsight {
  category: 'rank' | 'pricing' | 'content' | 'offers' | 'reviews' | 'listing' | 'seo' | 'other';
  label: string;
  summary: string;
  tone: 'green' | 'red' | 'blue' | 'amber' | 'gray';
}

function parseNumber(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!cleaned) return null;
  const n = Number(cleaned[0]);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseBsr(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/#\s*([\d,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function safeText(raw: string, max = 90): string {
  if (!raw) return '(empty)';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}...`;
}

function normalizeField(field: string): string {
  if (field === 'offers.discountPct') return 'offers.discount';
  if (field === 'offers.dealBadge') return 'offers.deal';
  if (field === 'offers.bestSellerRank') return 'offers.bsr';
  return field;
}

export function summarizeChange(c: ChangeLike): ChangeInsight {
  const field = normalizeField(c.field);
  const oldValue = c.old_value ?? '';
  const newValue = c.new_value ?? '';

  if (field === 'price') {
    const oldP = parseMoney(oldValue);
    const newP = parseMoney(newValue);
    if (oldP != null && newP != null && oldP > 0) {
      const diff = newP - oldP;
      const pct = Math.abs((diff / oldP) * 100).toFixed(1);
      if (diff < 0) return { category: 'pricing', label: 'Price dropped', summary: `Rs ${Math.abs(diff).toFixed(0)} down (${pct}%)`, tone: 'green' };
      if (diff > 0) return { category: 'pricing', label: 'Price increased', summary: `Rs ${diff.toFixed(0)} up (+${pct}%)`, tone: 'red' };
    }
    return { category: 'pricing', label: 'Price changed', summary: `${safeText(oldValue, 30)} -> ${safeText(newValue, 30)}`, tone: 'amber' };
  }

  if (field === 'offers.bsr') {
    const oldRank = parseBsr(oldValue);
    const newRank = parseBsr(newValue);
    if (oldRank != null && newRank != null) {
      const delta = oldRank - newRank;
      if (delta > 0) return { category: 'rank', label: 'BSR improved', summary: `#${oldRank.toLocaleString()} -> #${newRank.toLocaleString()}`, tone: 'green' };
      if (delta < 0) return { category: 'rank', label: 'BSR dropped', summary: `#${oldRank.toLocaleString()} -> #${newRank.toLocaleString()}`, tone: 'red' };
    }
    return { category: 'rank', label: 'BSR updated', summary: `${safeText(oldValue, 50)} -> ${safeText(newValue, 50)}`, tone: 'blue' };
  }

  if (field === 'rating') {
    const oldN = parseNumber(oldValue);
    const newN = parseNumber(newValue);
    if (oldN != null && newN != null) {
      const diff = newN - oldN;
      if (diff > 0) return { category: 'rank', label: 'Rating improved', summary: `+${diff.toFixed(1)} (${oldN.toFixed(1)} -> ${newN.toFixed(1)})`, tone: 'green' };
      if (diff < 0) return { category: 'rank', label: 'Rating dropped', summary: `${diff.toFixed(1)} (${oldN.toFixed(1)} -> ${newN.toFixed(1)})`, tone: 'red' };
    }
    return { category: 'rank', label: 'Rating changed', summary: `${safeText(oldValue, 20)} -> ${safeText(newValue, 20)}`, tone: 'blue' };
  }

  if (field === 'reviewCount') {
    const oldN = parseNumber(oldValue);
    const newN = parseNumber(newValue);
    if (oldN != null && newN != null) {
      const diff = newN - oldN;
      if (diff > 0) return { category: 'reviews', label: 'Review count increased', summary: `+${diff.toLocaleString()} reviews`, tone: 'green' };
      if (diff < 0) return { category: 'reviews', label: 'Review count decreased', summary: `${diff.toLocaleString()} reviews`, tone: 'red' };
    }
    return { category: 'reviews', label: 'Review count changed', summary: `${safeText(oldValue, 20)} -> ${safeText(newValue, 20)}`, tone: 'blue' };
  }

  if (field === 'title') return { category: 'content', label: 'Title changed', summary: `${safeText(oldValue, 70)} -> ${safeText(newValue, 70)}`, tone: 'amber' };
  if (field === 'description') {
    const delta = (newValue?.length ?? 0) - (oldValue?.length ?? 0);
    return { category: 'content', label: 'Description updated', summary: delta === 0 ? 'text rewritten' : `${delta > 0 ? '+' : ''}${delta} chars`, tone: 'blue' };
  }
  if (field.startsWith('seo.')) return { category: 'seo', label: `SEO updated (${field.replace('seo.', '')})`, summary: `${safeText(oldValue, 45)} -> ${safeText(newValue, 45)}`, tone: 'blue' };
  if (field.startsWith('offers.')) return { category: 'offers', label: `Offer updated (${field.replace('offers.', '')})`, summary: `${safeText(oldValue, 45)} -> ${safeText(newValue, 45)}`, tone: 'amber' };

  return { category: 'other', label: field, summary: `${safeText(oldValue, 40)} -> ${safeText(newValue, 40)}`, tone: 'gray' };
}

export function toneClass(tone: ChangeInsight['tone']): string {
  switch (tone) {
    case 'green': return 'text-green-400';
    case 'red': return 'text-red-400';
    case 'blue': return 'text-blue-400';
    case 'amber': return 'text-amber-400';
    default: return 'text-gray-400';
  }
}
