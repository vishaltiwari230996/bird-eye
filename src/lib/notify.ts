import { log } from '@/lib/logger';
import { getRedis } from '@/lib/redis';
import type { Product } from '@/adapters/types';

interface ChangeNotification {
  product: Product;
  changes: { field: string; oldValue: string; newValue: string }[];
}

const DEBOUNCE_TTL = 1800; // 30 minutes

/** Check if this notification was recently sent (debounce) */
async function isDuplicate(product: Product, fields: string[]): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const key = `notif:dedup:${product.id}:${fields.sort().join(',')}`;
  const exists = await redis.get(key);
  if (exists) return true;
  await redis.set(key, '1', { ex: DEBOUNCE_TTL });
  return false;
}

/** Build a human-readable message */
function formatMessage(n: ChangeNotification): string {
  const lines = [
    `🔔 *Change detected* — ${n.product.platform.toUpperCase()}`,
    `*${n.product.title_known || n.product.asin_or_sku}*`,
    `<${n.product.url}|View listing>`,
    '',
  ];
  for (const c of n.changes) {
    if (c.field === 'newReviews') {
      const reviews = JSON.parse(c.newValue || '[]');
      lines.push(`📝 *New reviews* (${reviews.length}):`);
      for (const r of reviews) {
        lines.push(`  > "${r.text.slice(0, 120)}…" — ${r.date}`);
      }
    } else {
      lines.push(`• *${c.field}*: \`${c.oldValue || '(empty)'}\` → \`${c.newValue || '(empty)'}\``);
    }
  }
  return lines.join('\n');
}

function formatEmailHtml(n: ChangeNotification): string {
  let html = `<h2>Change detected — ${n.product.platform.toUpperCase()}</h2>`;
  html += `<p><strong>${n.product.title_known || n.product.asin_or_sku}</strong></p>`;
  html += `<p><a href="${n.product.url}">View listing</a></p><ul>`;
  for (const c of n.changes) {
    if (c.field === 'newReviews') {
      const reviews = JSON.parse(c.newValue || '[]');
      html += `<li><strong>New reviews (${reviews.length}):</strong><ul>`;
      for (const r of reviews) {
        html += `<li>"${r.text.slice(0, 120)}…" — ${r.date}</li>`;
      }
      html += '</ul></li>';
    } else {
      html += `<li><strong>${c.field}:</strong> ${c.oldValue || '(empty)'} → ${c.newValue || '(empty)'}</li>`;
    }
  }
  html += '</ul>';
  return html;
}

/** Send Slack webhook notification */
async function sendSlack(message: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    if (!resp.ok) {
      log.warn('Slack webhook failed', { status: resp.status });
    }
  } catch (err) {
    log.error('Slack notification error', { error: String(err) });
  }
}

/** Send email via Resend */
async function sendEmail(subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  const to = process.env.NOTIFY_EMAIL_TO;
  if (!apiKey || !from || !to) return;

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    await resend.emails.send({ from, to, subject, html });
  } catch (err) {
    log.error('Email notification error', { error: String(err) });
  }
}

/** Notify about changes — debounced, to Slack and email */
export async function notifyChanges(notification: ChangeNotification): Promise<void> {
  if (!notification.changes.length) return;

  const fields = notification.changes.map((c) => c.field);
  if (await isDuplicate(notification.product, fields)) {
    log.debug('Notification debounced', { productId: notification.product.id });
    return;
  }

  const message = formatMessage(notification);
  const html = formatEmailHtml(notification);
  const subject = `[Bird Eye] ${notification.product.platform} — ${notification.product.title_known || notification.product.asin_or_sku} changed`;

  await Promise.allSettled([sendSlack(message), sendEmail(subject, html)]);

  log.info('Notification sent', {
    productId: notification.product.id,
    platform: notification.product.platform,
    fields: fields.join(',') as any,
  });
}
