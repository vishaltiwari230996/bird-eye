# Bird Eye — Competitor Listing Monitor

Production-ready Next.js 14 app that monitors ~100 competitor listings on Amazon and Flipkart every ~30 seconds.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌───────────┐
│  QStash/Cron │────▶│ /api/run-check│────▶│ Adapters  │
│  (2x / min)  │     │  (batched)   │     │ AMZ / FK  │
└──────────────┘     └──────┬───────┘     └─────┬─────┘
                            │                   │
                   ┌────────▼────────┐   ┌──────▼──────┐
                   │  Postgres (Neon)│   │ Upstash Redis│
                   │  snapshots/diff │   │ rate limits  │
                   └────────┬────────┘   └─────────────┘
                            │
                   ┌────────▼────────┐
                   │  Notifications  │
                   │ Slack + Resend  │
                   └─────────────────┘
```

## Setup

1. **Clone & install**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env.local
   # Fill in Postgres, Upstash Redis, and notification credentials
   ```

3. **Run migration**
   ```bash
   DATABASE_URL=your_url npm run db:migrate
   ```

4. **Start dev server**
   ```bash
   npm run dev
   ```

## API Endpoints

### `POST /api/products` — Add a product to monitor
```json
{
  "platform": "amazon",
  "asin_or_sku": "B08N5WRWNW",
  "url": "https://www.amazon.in/dp/B08N5WRWNW",
  "title_known": "Optional product name"
}
```

### `GET /api/products` — List all products with latest snapshots and changes

### `PUT /api/products` — Update a product
```json
{ "id": 1, "url": "https://...", "title_known": "New name" }
```

### `DELETE /api/products?id=1` — Remove a product

### `POST /api/run-check` — Trigger a monitoring batch
```
Authorization: Bearer <CRON_SECRET>
Body: { "batch": 0 }
```

## Scheduling with QStash

Set up QStash to hit `/api/run-check` with different batch indices. For 100 products at 10/batch = 10 batches:

```
POST https://your-app.vercel.app/api/run-check
Authorization: Bearer <CRON_SECRET>
Body: {"batch": 0}  ... {"batch": 9}
```

Schedule each batch at staggered intervals (every 3 seconds) for ~30s total cycle.

## Key Design Decisions

- **Hash-based deduplication**: Only writes snapshots when content actually changes (SHA-256 over normalized payload)
- **Price thresholds**: Ignores price diffs < ₹1 or < 0.5% to filter noise
- **Multi-strategy scraping**: JSON-LD → Cheerio selectors → Playwright, with parse-drift metrics
- **Token bucket rate limiting**: Redis-backed per-platform limits
- **Notification debounce**: 30-minute dedup window per product+field combo
- **Vercel-friendly**: Sharded batches, no disk writes, `playwright-core` + `@sparticuz/chromium`

## Project Structure

```
src/
├── adapters/
│   ├── types.ts          # NormalizedPayload, PlatformAdapter interface
│   ├── amazon.ts         # Amazon PAAPI5 + scrape fallback
│   ├── flipkart.ts       # Flipkart affiliate API + scrape fallback
│   └── index.ts          # Adapter registry
├── app/
│   ├── api/
│   │   ├── run-check/route.ts   # Batched monitoring endpoint
│   │   └── products/route.ts    # CRUD for product targets
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx          # Dashboard UI
├── lib/
│   ├── db.ts             # Postgres connection pool
│   ├── redis.ts          # Upstash Redis client
│   ├── logger.ts         # Structured JSON logging
│   ├── hash.ts           # Normalization & hashing
│   ├── rate-limit.ts     # Token bucket rate limiter
│   ├── browser.ts        # Playwright + @sparticuz/chromium
│   ├── differ.ts         # Snapshot diffing & storage
│   ├── notify.ts         # Slack + Resend notifications
│   └── migrate.mjs       # Database migration script
└── types/
    └── global.d.ts
```
