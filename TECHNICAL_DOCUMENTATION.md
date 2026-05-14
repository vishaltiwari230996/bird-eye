# Bird Eye — Technical Documentation

> **Version:** 1.0.0  
> **Last Updated:** 2026-05-11  
> **Authors:** Kumar Sanskar (Project Head), Vishal Tiwari (Project Author)  
> **Product:** PW · E-Com Automation Dept

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture](#3-architecture)
4. [Backend — FastAPI Service](#4-backend--fastapi-service)
   - 4.1 [Scraping Pipeline](#41-scraping-pipeline)
   - 4.2 [Diff Engine](#42-diff-engine)
   - 4.3 [Database Layer](#43-database-layer)
   - 4.4 [API Surface](#44-api-surface)
   - 4.5 [AI Augmentation](#45-ai-augmentation)
   - 4.6 [Cron & Scheduling](#46-cron--scheduling)
   - 4.7 [Utility Scripts](#47-utility-scripts)
5. [Frontend — React SPA](#5-frontend--react-spa)
   - 5.1 [Stack & Build](#51-stack--build)
   - 5.2 [Routing & Pages](#52-routing--pages)
   - 5.3 [Design System](#53-design-system)
   - 5.4 [API Client](#54-api-client)
   - 5.5 [Change Intel Library](#55-change-intel-library)
6. [Data Model](#6-data-model)
7. [Infrastructure & Deployment](#7-infrastructure--deployment)
8. [Environment Configuration](#8-environment-configuration)
9. [Security Considerations](#9-security-considerations)
10. [Operational Runbook](#10-operational-runbook)
11. [Key Technical Features](#11-key-technical-features)
12. [File Map](#12-file-map)

---

## 1. Executive Summary

**Bird Eye** is a continuous, AI-augmented Amazon & Flipkart listing observatory built for **Physics Wallah (PW)**, one of India's largest ed-tech companies. It monitors a curated set of product listings — both PW's own SKUs and competitor SKUs grouped into **cohorts** — by scraping each listing through a stealth browser pipeline, snapshotting the full product state (title, price, rating, review count, BSR, description, sellers), **diffing** the new snapshot against the last one, and writing every detected change to a timeline. A React front-end then renders that timeline as three executive views: a **Products** catalogue, a **Cohorts** competitive board, and a **Report** briefing with AI-written narrative, hijack alerts, and price battlegrounds.

The system is designed to operate as a **quiet, briefing-grade observatory** — not a noisy dashboard. Every change is timestamped and narrated. The visual language is intentionally editorial (washi paper, sumi ink, Railway-style bold type) so the data does the talking.

---

## 2. System Overview

| Aspect | Detail |
|--------|--------|
| **Purpose** | Track PW and competitor Amazon/Flipkart listings; detect and narrate every meaningful change |
| **Target Platforms** | Amazon.in (primary), Flipkart (secondary) |
| **Users** | PW leadership, e-commerce operations team |
| **Data Flow** | Scrape → Snapshot → Diff → Store → Render |
| **AI Integration** | OpenRouter (DeepSeek V3.2) for HTML extraction fallback, executive summaries, battleground commentary, cohort suggestions |
| **Notifications** | Slack webhooks, email via Resend |
| **Scheduling** | QStash (Upstash), Cloud Scheduler, or any HTTP cron |

---

## 3. Architecture

```
┌───────────────────────┐       ┌───────────────────────────────────────┐       ┌──────────────────┐
│  React + Vite SPA     │  ───▶ │  FastAPI service (Python 3.12)        │ ───▶  │  PostgreSQL      │
│  (frontend/)          │       │  - Stealth scraper (Playwright+httpx)│       │  (snapshots,     │
│  Tailwind + custom    │       │  - Diff engine                        │       │   changes,       │
│  washi-paper theme    │  ◀─── │  - OpenRouter LLM bridge              │       │   sellers,       │
│  SSE for live progress│       │  - SSE streaming endpoints            │       │   pools, ...)    │
└───────────────────────┘       │  - Cron-friendly /api/cron/monitor    │       └──────────────────┘
                                └───────────────────────────────────────┘
                                          │
                                          ▼
                          ┌────────────────────────────────────┐
                          │  External services                 │
                          │  • Amazon / Flipkart (scraped)     │
                          │  • OpenRouter (DeepSeek LLM)       │
                          │  • BrightData / generic HTTP proxy │
                          │  • Upstash QStash (scheduler)      │
                          │  • Slack / Resend (notifications)   │
                          └────────────────────────────────────┘
```

### Deployable Units

| Unit | Path | Runtime | Host |
|------|------|---------|------|
| Backend API | `backend/` | FastAPI + Playwright on Python 3.12 | Cloud Run (`cloudbuild.yaml`), Fly.io (`fly.toml`), Railway (`railway.json`) |
| Frontend SPA | `frontend/` | Vite + React 18 + TypeScript | Vercel (`vercel.json`) |

---

## 4. Backend — FastAPI Service

### 4.1 Scraping Pipeline

**File:** [`backend/scraper.py`](backend/scraper.py) (~1,948 lines)

The scraper is the heart of the system — a multi-tier pipeline that always tries the cheapest path first and only escalates when blocked.

#### Tier 1 — Static HTTP (`httpx`)

- Reuses a single `httpx.AsyncClient` so cookies persist across requests (mimicking a real browser session).
- Sends the **complete header surface** that Chrome sends: `sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-dest/mode/site/user`, `accept`, `accept-language`, `accept-encoding`, `upgrade-insecure-requests`, and a plausible `referer`.
- User-Agent is sampled from a **20-entry pool** of real Chrome 130–132 / Firefox 132–133 / Edge / Safari UAs collected from public analytics.

#### Tier 2 — Playwright Stealth Browser

- **Singleton browser instance** (`get_browser()`) that survives across requests; auto-reconnects on disconnect.
- Uses local Chrome on Windows dev (`CHROME_EXECUTABLE_PATH`) and Playwright's bundled Chromium in containers.
- Each page is patched with a `STEALTH_SCRIPT` that overrides the signals Amazon's bot detection reads:
  - `navigator.webdriver` → `undefined`
  - Realistic `navigator.plugins` (PDF, NaCl) — headless Chrome has 0 by default
  - `navigator.languages` → `['en-IN', 'en-US', 'en']`
  - `window.chrome.runtime` / `loadTimes` / `csi` shims
  - `permissions.query` patch for notifications
  - WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` → real Intel UHD strings
  - `screen.colorDepth` / `pixelDepth` → 24
- **Resource blocking** (`image`, `media`, `font`, `websocket`) and ad/tracker URL patterns (`amazon-adsystem`, `doubleclick`, `googletagmanager`, etc.) are intercepted before they hit the wire — 4–5× page load speed-up and a smaller fingerprint.
- Randomised viewport from a Statcounter 2024 distribution.
- Gaussian-distributed **human delays** between actions.
- Exponential backoff retry on detected blocks.

#### Tier 3 — AI Extraction Fallback

- When the HTML structure looks unusual or selectors fail, the scraper isolates the relevant DOM zone (`_extract_product_zone` / `_extract_offer_zone` — strips head, scripts, ads) and ships it to OpenRouter (DeepSeek V3.2 by default) via `ai_extract_product` / `ai_extract_offers`.
- The LLM returns structured JSON which is validated, parsed, and merged into the normal snapshot path. Schema-less HTML changes therefore **self-heal**.

#### Block Detection (`is_blocked`)

Combined title + body checks for Amazon's known patterns: "Robot Check", "Type the characters you see", `validateCaptcha`, length/redirect anomalies. False negatives are caught downstream because the diff result will be empty / noisy.

#### Proxy Support

Optional BrightData / generic HTTP proxy via `PROXY_URL` (or component `PROXY_HOST/PORT/USER/PASS`). Both httpx and Playwright pick it up. Password is masked in logs.

#### Seller / Buy Box Scraping

Uses Amazon's AOD (`Amazon Offer Display`) endpoint and parses each seller offer with `parse_aod_html`, falling back to the legacy offer page parser. A `fetch_sellers_paapi` path is wired in for Amazon Product Advertising API SigV4-signed requests when keys are present.

---

### 4.2 Diff Engine

**File:** [`backend/main.py`](backend/main.py:107) — `diff_payloads()`

Given the previous snapshot and the new snapshot, emits a list of `{field, old_value, new_value}` changes:

| Field | Comparison Rule |
|-------|----------------|
| **title** | Normalised whitespace + lower-case comparison |
| **price** | Numeric, ignores `₹` symbols / commas, only flags > ₹1 deltas |
| **mrp** | Numeric, same tolerance as price |
| **rating** | Numeric, only flags ≥ 0.05 deltas |
| **reviewCount** | Exact integer change |
| **BSR** | Best-seller rank string change |
| **description** | Normalised feature-bullet/description text change |

Each change is persisted to the `changes` table with `old_value`, `new_value`, `field`, `detected_at`. Every snapshot also gets a SHA-256 `hash_payload` so identical re-scrapes don't create noise.

---

### 4.3 Database Layer

**File:** [`backend/database.py`](backend/database.py) (~81 lines)

PostgreSQL via `psycopg2` with a **`ThreadedConnectionPool`** (1–10 connections). A clever bit: the codebase was written with asyncpg-style `$1, $2` placeholders, so `_to_psycopg_sql` rewrites them into psycopg2 `%s` placeholders **without touching parameters inside quoted string literals**. That keeps SQL readable and portable.

### Helper Functions

| Function | Purpose |
|----------|---------|
| `query(sql, params)` | Execute a query, return list of dicts |
| `query_one(sql, params)` | Execute a query, return first row or `None` |
| `transaction()` | Context manager for atomic transactions |
| `get_pool()` | Lazy-initialize the connection pool |
| `_to_psycopg_sql(sql, params)` | Rewrite `$1,$2` → `%s` + reorder params |

---

### 4.4 API Surface

**File:** [`backend/main.py`](backend/main.py) (~1,296 lines)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/products` | Catalogue with last snapshot + recent changes + sellers (single round-trip) |
| POST | `/api/products` | Create a product |
| PUT | `/api/products` | Update a product |
| DELETE | `/api/products` | Delete a product (cascades) |
| GET | `/api/products/{id}/sellers` | Current seller list |
| POST | `/api/products/{id}/sellers` | Refresh sellers for one product |
| POST | `/api/sellers/refresh-all` | **SSE-streamed** bulk seller refresh for own SKUs |
| GET / POST / DELETE | `/api/pools` | Cohort (pool) CRUD |
| PATCH | `/api/pools` | Update pool notification emails |
| PUT | `/api/pools/assign` | Add/remove products from a cohort |
| GET | `/api/pools/changes` | Cohort-scoped change feed |
| POST | `/api/run-check` | On-demand single product or batch re-scrape + diff |
| GET | `/api/hijack-alerts` | Buy-box-stolen / unauthorized-seller alerts |
| PATCH | `/api/hijack-alerts` | Resolve a hijack alert |
| GET | `/api/battleground` | Per-cohort price comparison vs PW |
| POST | `/api/ai/cohorts` | LLM-suggested cohort grouping |
| POST | `/api/ai/summary` | LLM-written executive narrative |
| POST | `/api/ai/battleground` | LLM-written competitive commentary |
| GET / POST | `/api/cron/monitor` | Scheduler-friendly endpoint that re-scrapes the whole watchlist |
| GET | `/api/report` | Single payload for the Report page (headline, movements, battleground, hijacks, trends, AI summary) |

Two endpoints stream **Server-Sent Events** (`/api/sellers/refresh-all` and `/api/cron/monitor`) so the UI can show a smooth, per-item progress bar while a long bulk operation runs.

---

### 4.5 AI Augmentation

All AI calls go through [`call_openrouter()`](backend/main.py:77) which posts to the OpenRouter chat completions API.

| Endpoint | Model | Purpose |
|----------|-------|---------|
| `ai_extract_product` / `ai_extract_offers` (in scraper.py) | DeepSeek V3.2 | Tier-3 fallback: extract structured product/seller data from raw HTML when CSS selectors fail |
| `/api/ai/cohorts` | Configurable (`OPENROUTER_MODEL`) | Suggest cohort groupings based on product titles, prices, and ownership |
| `/api/ai/summary` | Configurable | Generate executive narrative: summary, highlights, risks, actions from recent changes |
| `/api/ai/battleground` | Configurable | Generate competitive commentary: headline, wins, gaps, tactical moves, watch signals |
| `_build_ai_summary()` (in report builder) | Configurable | 3-bullet executive briefing for the Report page |

**JSON Resilience:** [`parse_json_from_text()`](backend/main.py:56) handles LLM output that may be wrapped in markdown fences, have leading/trailing text, or be plain text — it extracts valid JSON gracefully.

---

### 4.6 Cron & Scheduling

The [`/api/cron/monitor`](backend/main.py:788) endpoint is designed to be called by any HTTP-based scheduler:

- **Idempotent**: safe to call multiple times
- **Authenticated**: requires `CRON_SECRET` Bearer token (or same-origin/referer check)
- **Multi-pass execution**:
  1. **Pass 1**: BrightData batch (all ASINs in one API call — fast, no IP blocks)
  2. **Pass 2**: Playwright fallback for any ASIN BrightData missed or returned empty
  3. **Pass 3**: Retry up to 2 times for SKUs still blocked/errored, with exponential backoff (30s × attempt)

Compatible schedulers: Cloud Scheduler, Fly cron, GitHub Actions, Upstash QStash.

---

### 4.7 Utility Scripts

| Script | Purpose |
|--------|---------|
| [`seed_pw_catalogue.py`](backend/seed_pw_catalogue.py) | Bulk-import the full PW Amazon catalogue from the master `.xlsx` workbook into the `products` table. Creates/reuses a "PW Catalogue" pool. Supports `--dry-run` and `--reset` flags. |
| [`scrape_pw_sellers.py`](backend/scrape_pw_sellers.py) | Refresh PW catalogue with seller offers + MRP. Filters to "eligible" categories (excludes Notebooks & Stationery, Other). Runs from home IP with proxy disabled. |
| [`local_seller_scraper.py`](backend/local_seller_scraper.py) | Run seller scraping from a local Windows machine using home IP (bypasses datacenter blocks). Supports `--asin` and `--limit` flags. |
| [`_pick_asin.py`](backend/_pick_asin.py) | Helper for picking specific ASINs for debugging. |
| [`_inspect_recent.py`](backend/_inspect_recent.py) | Inspect recent scraping results for debugging. |

---

## 5. Frontend — React SPA

### 5.1 Stack & Build

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.3.x | UI framework |
| TypeScript | 5.5.x | Type safety |
| Vite | 5.4.x | Build tool & dev server |
| React Router | 6.26.x | Client-side routing |
| Tailwind CSS | 3.4.x | Utility-first styling |
| PostCSS | 8.4.x | CSS processing |

**Build output:** Static SPA in `dist/`, deployed to Vercel.

---

### 5.2 Routing & Pages

**File:** [`frontend/src/App.tsx`](frontend/src/App.tsx)

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | [`Products.tsx`](frontend/src/pages/Products.tsx) | Catalogue grid of SKU cards grouped by brand, with image, platform pill, OOS flag, price, rating, BSR, ASIN, and change chips. Click expands into detail strip with sellers, change timeline, and per-field history. Search + filters (platform, own/competitor, has-changes-since). |
| `/pw-table` | [`PwTable.tsx`](frontend/src/pages/PwTable.tsx) | PW-specific table view showing all PW-owned SKUs with seller breakdown (Cocoblu, Repo, PW pricing), category classification, and competitive positioning. |
| `/cohorts` | [`Cohorts.tsx`](frontend/src/pages/Cohorts.tsx) | One card per cohort showing aggregate stats: PW vs competitor count, average price gap, last movement. Selecting a cohort drills into a board where every member SKU is plotted with current price and delta vs cohort median. |
| `/report` | [`Report.tsx`](frontend/src/pages/Report.tsx) | Executive briefing: KPI strip, AI-written narrative, chronological movements feed, per-cohort battleground with mini-deltas, hijack alerts (severity-graded), and 30-day price/activity trends. |
| `*` | `Navigate` | Redirects to `/` |

---

### 5.3 Design System

**File:** [`frontend/src/index.css`](frontend/src/index.css) (~1,120 lines — single source of truth)

#### Visual Identity

- **Theme**: Warm "washi paper" cream stock (`#f1ead9`) with sumi-ink type (`#1a1714`)
- **Texture**: Subtle SVG fractal-noise overlay (fixed-attached) gives the page a paper grain without performance cost
- **Earthy accents**: matcha green (`#4f6b4a`), vermillion seal (`#a8442e`), ochre (`#a87a2a`), aizome indigo (`#355c7d`) — all desaturated to read calmly on cream

#### Typography

| Role | Font | Weight | Tracking |
|------|------|--------|----------|
| Headlines | `Space Grotesk` | 600 | Tight (`-0.018em`) |
| Body / UI | `Inter` | 450–600 | Normal |
| Numbers / IDs | `JetBrains Mono` | 400–500 | Normal |

#### Component Classes

- `.serif` — Space Grotesk display (class name preserved for backward compatibility)
- `.kicker` — Small-caps label (11px, 600 weight, 0.22em tracking)
- `.chip` / `.chip-green` / `.chip-red` / `.chip-amber` / `.chip-blue` — Colored change indicators
- `.btn` / `.btn-primary` — Action buttons with washi styling
- `.nav-tab` / `.nav-tab.active` — Header navigation tabs
- `.brand-mark` — SVG eye logo
- `.ring-dot` — Animated "Live" status indicator
- `.marquee-band` / `.marquee-track` — Scrolling project credits ticker

#### Accents

- 14–16 px rounded panels, hairline `rgba(28,24,18,0.10)` borders, `backdrop-filter` blur for the sticky header
- Layout, header, and main column width-capped at 1400px for readability

---

### 5.4 API Client

**File:** [`frontend/src/api.ts`](frontend/src/api.ts)

A minimal typed wrapper over `fetch`:

```typescript
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

export const api = {
  get, post, put, patch, delete, postStream
};
```

- `API_URL` is configurable via the `VITE_API_URL` environment variable
- `postStream()` returns a native `Response` for SSE consumption via `EventSource`
- All methods auto-set `Content-Type: application/json` when a body is provided

---

### 5.5 Change Intel Library

**File:** [`frontend/src/lib/change-intel.ts`](frontend/src/lib/change-intel.ts) (~121 lines)

Transforms raw diff rows into human-readable one-liners:

| Field | Category | Example Output |
|-------|----------|----------------|
| `price` | pricing | "Rs 52 down (9.1%)" — tone: green |
| `offers.bsr` | rank | "#1,234 → #987" — tone: green/red |
| `rating` | rank | "+0.2 (4.1 → 4.3)" — tone: green/red |
| `reviewCount` | reviews | "+1,200 reviews" — tone: green/red |
| `title` | content | Truncated before/after — tone: amber |
| `description` | content | "description rewritten (42 chars)" — tone: blue |

Each insight has: `category`, `label`, `summary`, `tone` (green/red/amber/blue/gray).

---

## 6. Data Model

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `products` | The watchlist | `id`, `platform` (amazon/flipkart), `asin_or_sku`, `url`, `title_known`, `is_own`, `pool_id`, `last_seen_at` |
| `snapshots` | One row per scrape | `id`, `product_id`, `payload_json` (JSONB), `hash` (SHA-256), `fetched_at` |
| `changes` | One row per diff field | `id`, `product_id`, `field`, `old_value`, `new_value`, `detected_at` |
| `seller_offers` | Current Buy Box / AOD seller list | `id`, `product_id`, `seller_name`, `price`, `condition`, `is_fba`, `prime_eligible`, `fetched_at` |
| `pools` (cohorts) | Named groupings of products | `id`, `name`, `notify_emails` (array), `created_at` |
| `hijack_alerts` | Buy-box hijack detections | `id`, `product_id`, `resolved`, `resolved_at`, `detected_at` |

### Relationships

```
pools (1) ──── (N) products
products (1) ── (N) snapshots
products (1) ── (N) changes
products (1) ── (N) seller_offers
products (1) ── (N) hijack_alerts
```

### Snapshot Payload Schema (JSONB)

```json
{
  "title": "PW NEET Biology...",
  "price": "527",
  "mrp": "599",
  "rating": "4.3",
  "reviewCount": "12450",
  "bsr": "#1,234 in Books",
  "description": "Feature bullets...",
  "offers": {
    "availability": "In Stock",
    "discount": "12%",
    "dealBadge": "Best Seller",
    "bestSellerRank": "#1,234"
  },
  "seo": {
    "hasAPlus": true,
    "bulletCount": 5,
    "imageCount": 12
  }
}
```

---

## 7. Infrastructure & Deployment

### Backend Deployment

The backend is containerized using a **multi-stage Docker build**:

1. **Stage 1 (builder):** Python 3.12-slim, installs `gcc` and `libpq-dev`, pip-installs requirements
2. **Stage 2 (runtime):** Python 3.12-slim, installs Playwright Chromium system dependencies + fonts, copies installed packages, runs `playwright install chromium`

**Runtime command:**
```bash
uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1
```

Single worker is used because the Playwright browser singleton is not safe across processes.

### Deployment Targets

| Platform | Config | Region | Notes |
|----------|--------|--------|-------|
| **Google Cloud Run** | [`cloudbuild.yaml`](cloudbuild.yaml) | `asia-south1` (Mumbai) | Closest to amazon.in; min 1 instance to keep browser warm; 2Gi memory; max 3 instances |
| **Fly.io** | [`backend/fly.toml`](backend/fly.toml) | `sin` (Singapore) | 2GB VM; auto_stop_machines=false to keep browser alive; concurrency hard_limit=10 |
| **Railway** | [`backend/railway.json`](backend/railway.json) | — | Alternative deployment |

### Frontend Deployment

| Platform | Config | Notes |
|----------|--------|-------|
| **Vercel** | [`frontend/vercel.json`](frontend/vercel.json) | SPA rewrite `/* → /index.html`; build via `tsc && vite build` |

### CI/CD

- **Cloud Build** triggers on push: builds Docker image → pushes to GCR → deploys to Cloud Run
- Image tagged with both `$SHORT_SHA` and `latest`

---

## 8. Environment Configuration

**File:** [`.env.example`](.env.example)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Neon/Supabase) with `sslmode=require` |
| `UPSTASH_REDIS_REST_URL` | ⚪ | Upstash Redis for caching/rate-limiting |
| `UPSTASH_REDIS_REST_TOKEN` | ⚪ | Redis auth token |
| `QSTASH_TOKEN` | ⚪ | Upstash QStash for scheduled triggers |
| `QSTASH_CURRENT_SIGNING_KEY` | ⚪ | QStash webhook verification |
| `QSTASH_NEXT_SIGNING_KEY` | ⚪ | QStash key rotation |
| `AMAZON_ACCESS_KEY` | ⚪ | Amazon PAAPI5 access key (enables API-first path) |
| `AMAZON_SECRET_KEY` | ⚪ | Amazon PAAPI5 secret key |
| `AMAZON_PARTNER_TAG` | ⚪ | Amazon affiliate tag |
| `AMAZON_MARKETPLACE` | ⚪ | Default: `www.amazon.in` |
| `FLIPKART_AFFILIATE_ID` | ⚪ | Flipkart Affiliate API |
| `FLIPKART_AFFILIATE_TOKEN` | ⚪ | Flipkart API token |
| `SLACK_WEBHOOK_URL` | ⚪ | Slack notifications for alerts |
| `RESEND_API_KEY` | ⚪ | Resend email API key |
| `NOTIFY_EMAIL_FROM` | ⚪ | Sender email address |
| `NOTIFY_EMAIL_TO` | ⚪ | Recipient email address |
| `CRON_SECRET` | ✅ | Bearer token for cron endpoint authentication |
| `NEXT_PUBLIC_APP_URL` | ⚪ | Frontend URL for CORS |
| `OPENROUTER_API_KEY` | ⚪ | OpenRouter LLM API key |
| `OPENROUTER_MODEL` | ⚪ | Default: `deepseek/deepseek-v3.2` |
| `BRIGHTDATA_TOKEN` | ⚪ | BrightData managed scraper bearer token |
| `BRIGHTDATA_DATASET_ID` | ⚪ | BrightData product dataset |
| `BRIGHTDATA_SELLERS_DATASET_ID` | ⚪ | BrightData sellers dataset |
| `PROXY_URL` | ⚪ | Generic HTTP proxy (overrides component vars) |
| `PROXY_HOST` / `PROXY_PORT` / `PROXY_USER` / `PROXY_PASS` | ⚪ | Proxy component parts (alternative to `PROXY_URL`) |
| `CHROME_EXECUTABLE_PATH` | ⚪ | Override Chrome path (default: Windows local path; omitted on Linux) |
| `APP_ENV` | ⚪ | `development` / `production` — controls auth bypass |
| `PORT` | ⚪ | Server port (default: `8080`) |

---

## 9. Security Considerations

1. **Cron Authentication**: The `/api/cron/monitor` endpoint requires a `CRON_SECRET` Bearer token. In development mode (`APP_ENV != production`), same-origin requests are allowed without the token.
2. **CORS**: Configured to allow `localhost:5173`, `localhost:3000`, and the `FRONTEND_URL` environment variable.
3. **Proxy Password Masking**: Proxy URLs are logged with passwords masked (`****`).
4. **SQL Injection**: Uses parameterized queries throughout via the `$1, $2` → `%s` translation layer.
5. **No Anti-bot SaaS Dependency**: The system passes Amazon's bot detection through header parity, JS stealth patches, and resource blocking — no paid anti-bot service required.
6. **SSL Verification**: Proxy SSL verification is off by default (`PROXY_VERIFY_SSL=false`) for BrightData compatibility but can be enabled.

---

## 10. Operational Runbook

### Seeding the Catalogue

```bash
# From the backend directory (first time or after reset)
python seed_pw_catalogue.py --reset    # Wipe + reimport from Excel
python seed_pw_catalogue.py --dry-run  # Preview changes
python seed_pw_catalogue.py            # Commit import
```

### Running a Full Scrape

```bash
# Trigger via cron endpoint
curl -X POST https://<backend-url>/api/cron/monitor \
  -H "Authorization: Bearer <CRON_SECRET>"

# Or run locally from Windows
python local_seller_scraper.py --limit 10
python scrape_pw_sellers.py --limit 50
```

### Monitoring

- **Health check**: `GET /docs` (FastAPI auto-docs) — Fly.io uses this with a 30s grace period for Playwright initialization
- **Logs**: Scraping logs are written to `logs/` directory with timestamps
- **Report caching**: The `/api/report` endpoint caches results for 30 minutes (`_REPORT_TTL_SECONDS = 1800`)

### Debugging

- `_inspect_recent.py` — Inspect recent scraping results
- `_pick_asin.py` — Pick specific ASINs for targeted debugging
- `dbg_*.html` — Saved HTML pages from blocked/failed scrapes

---

## 11. Key Technical Features

| # | Feature | Detail |
|---|---------|--------|
| 1 | **Three-tier scraping** | Static httpx → Playwright stealth browser → LLM HTML extraction; cheapest path first, automatic escalation |
| 2 | **Header parity with real Chrome** | Full `sec-fetch-*` / `sec-ch-ua-*` / `accept-*` surface, real-UA pool, randomised viewport — passes Amazon's standard heuristics without paid anti-bot SaaS |
| 3 | **JS stealth patches** | `navigator.webdriver`, plugins, languages, `window.chrome.*`, WebGL vendor/renderer, screen depth — closes every fingerprint vector headless Chrome leaks |
| 4 | **Resource & ad blocking** | Drops images/fonts/media + tracker domains inside Playwright; 4–5× page load, smaller network fingerprint |
| 5 | **Singleton browser, hot-reused** | Keeps process memory predictable on Cloud Run / Fly |
| 6 | **Optional BrightData proxy** | Set one env var, both httpx and Playwright pick it up |
| 7 | **Field-level diff engine** | Normalisation rules (whitespace, currency symbols, numeric tolerances) so cosmetic re-renders don't flood the change feed |
| 8 | **Snapshot hashing** | `hash_payload` — idempotent re-scrapes; identical payloads never emit changes |
| 9 | **PostgreSQL with auto-translated placeholders** | Readable SQL with `$1, $2`, one canonical query helper, threaded pool sized for Cloud Run concurrency |
| 10 | **AI augmentation via OpenRouter** | Pluggable model, JSON-coerced parsing that survives markdown fences, used for resilience (HTML extraction) and narrative (executive summaries, battleground commentary, cohort suggestions) |
| 11 | **Server-Sent Events** | Bulk seller refresh streams progress per-product so the UI bar is smooth and cancellable |
| 12 | **Cron-ready monitor endpoint** | `/api/cron/monitor` is idempotent; point any scheduler at it |
| 13 | **Deployment portability** | Same image runs on Cloud Run, Fly.io, and Railway; only `CHROME_EXECUTABLE_PATH` needs to flip |
| 14 | **Hand-rolled design system** | No UI kit, no jitter, ~100 KB gzip; entire visual language lives in one `index.css` |
| 15 | **Editorial UX** | Washi-paper palette, Space Grotesk display + Inter body, paper-grain texture, sumi-ink hierarchy — built to read like a quiet briefing, not a dashboard |

---

## 12. File Map

```
birdeye/
├── .env.example                          # Environment variable template
├── .gitignore
├── Bird_Eyes_06052026.xlsx               # Master PW catalogue workbook
├── Amazon links - Sheet1.csv             # ASIN reference CSV
├── Dockerfile                            # Root-level multi-stage Docker build
├── cloudbuild.yaml                       # Cloud Run deploy pipeline
├── PROJECT_OVERVIEW.md                   # Existing project overview
├── README.md                             # Brief project description
├── bulk_scrape.log                       # Bulk scrape log
├── scrape_pw_run*.log                   # Scraping run logs (8 runs)
│
├── .github/                              # GitHub Actions / CI
│
├── backend/
│   ├── main.py                           # FastAPI app — all routes, diff engine, AI bridges, report builder (~1,296 lines)
│   ├── scraper.py                        # 3-tier stealth scraper — httpx + Playwright + LLM (~1,948 lines)
│   ├── database.py                       # psycopg2 pool + $1/$2 → %s rewriter (~81 lines)
│   ├── local_seller_scraper.py           # Local Windows seller scraper CLI
│   ├── scrape_pw_sellers.py              # PW catalogue seller refresh script
│   ├── seed_pw_catalogue.py              # Bulk import from Excel workbook
│   ├── _pick_asin.py                     # Debug: pick specific ASINs
│   ├── _inspect_recent.py                # Debug: inspect recent results
│   ├── dbg_9374679930.html               # Debug: saved HTML from blocked scrape
│   ├── daily_scrape.ps1                  # PowerShell daily scrape script
│   ├── Dockerfile                        # Backend-specific Docker build
│   ├── fly.toml                          # Fly.io deployment config
│   ├── railway.json                      # Railway deployment config
│   ├── requirements.txt                  # Python dependencies
│   ├── README.md                         # Backend README
│   ├── .dockerignore
│   ├── bulk_scrape.log
│   └── .env                              # Local environment (gitignored)
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                       # React Router setup
│   │   ├── main.tsx                      # Entry point
│   │   ├── api.ts                        # Typed API client
│   │   ├── index.css                     # Washi-paper design system (~1,120 lines)
│   │   ├── vite-env.d.ts                 # Vite type declarations
│   │   ├── components/
│   │   │   └── Layout.tsx                # Sticky header, nav tabs, marquee, footer
│   │   ├── lib/
│   │   │   └── change-intel.ts           # Humanizes raw diff rows into one-liners
│   │   └── pages/
│   │       ├── Products.tsx              # Catalogue + SKU detail (~765 lines)
│   │       ├── PwTable.tsx               # PW-specific seller table (~646 lines)
│   │       ├── Cohorts.tsx               # Competitive board (~270 lines)
│   │       └── Report.tsx               # Executive briefing (~472 lines)
│   ├── index.html                        # HTML shell
│   ├── package.json                      # NPM dependencies
│   ├── package-lock.json                 # Lockfile
│   ├── vite.config.ts                    # Vite config (path aliases)
│   ├── tsconfig.json                     # TypeScript config
│   ├── tsconfig.node.json                # Node-specific TS config
│   ├── tailwind.config.cjs               # Tailwind configuration
│   ├── postcss.config.cjs                # PostCSS configuration
│   ├── vercel.json                       # Vercel SPA deploy config
│   ├── .gitignore
│   └── .env                              # Local environment (gitignored)
│
└── logs/
    ├── last_run.json                     # Last run metadata
    └── scrape_pw_20260507_1609.log       # Dated scrape log
```

---

## Appendix A: Dependency Inventory

### Backend (Python)

| Package | Version | Purpose |
|---------|---------|---------|
| `fastapi` | 0.115.0 | Web framework |
| `uvicorn[standard]` | 0.30.6 | ASGI server |
| `psycopg2-binary` | 2.9.9 | PostgreSQL driver |
| `python-dotenv` | 1.0.1 | `.env` file loading |
| `httpx[http2]` | 0.27.0 | Async HTTP client (Tier-1 scraping) |
| `beautifulsoup4` | 4.12.3 | HTML parsing |
| `playwright` | 1.47.0 | Browser automation (Tier-2 scraping) |
| `sse-starlette` | 2.1.3 | Server-Sent Events support |
| `openpyxl` | (implicit) | Excel workbook reading (seed script) |

### Frontend (Node.js)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | 18.3.x | UI framework |
| `react-dom` | 18.3.x | DOM rendering |
| `react-router-dom` | 6.26.x | Client-side routing |
| `tailwindcss` | 3.4.x | Utility-first CSS |
| `typescript` | 5.5.x | Type safety |
| `vite` | 5.4.x | Build tool |
| `@vitejs/plugin-react` | 4.3.x | React Fast Refresh |
| `autoprefixer` | 10.4.x | CSS vendor prefixes |
| `postcss` | 8.4.x | CSS processing |

---

## Appendix B: PW Seller Identification

The system identifies PW-associated sellers by checking seller names against these hints (case-insensitive):

- `pw`
- `physics wallah`
- `physicswallah`
- `pearson schoolhouse`
- `pearson school`

This is used in hijack detection (Buy Box not held by a PW seller) and the PW Table view (separating Cocoblu, Repo, and PW pricing columns).

---

## Appendix C: Category Classification (PW Table)

The [`PwTable.tsx`](frontend/src/pages/PwTable.tsx) page classifies PW SKUs into categories using regex rules:

| Category | Pattern |
|----------|---------|
| Notebooks & Stationery | `notebook`, `spiral`, `ruled`, `pages`, `stationery`, `diary` |
| Handwritten Notes | `handwritten`, `med easy`, `pankaj sir`, `sir...notes` |
| Mind Maps & Quick Revision | `mind map`, `quick revision`, `formula book/sheet`, `flash card` |
| PYQs & Practice | `pyq`, `previous year`, `year question`, `practice book`, `sample paper`, `mock test` |
| NCERT | `ncert` |
| NEET | `neet` |
| JEE (Main / Advanced) | `jee`, `advanced` |
| CUET | `cuet` |
| UPSC & Govt. Exams | `upsc`, `civil services`, `ssc`, `banking exam`, `cds`, `nda` |
| Classes 11–12 / Boards | `class 11/12`, `board exam`, `cbse 11/12` |
| Classes 6–10 / Foundation | `class 6-10`, `foundation` |
| Workbooks & Modules | `workbook`, `module`, `chapter wise`, `topic wise` |
| Question Banks | `question bank`, `objective book` |

Categories "Notebooks & Stationery" and "Other" are excluded from the PW Table view.

---

*End of Technical Documentation*
