---
title: BirdEye Backend
emoji: 🦅
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8080
pinned: false
---

# Bird Eye — PW Listing Observatory

Daily-refreshed snapshot of every PW Amazon SKU: title, price, MRP, buy-box
seller, full seller landscape, and the resulting discount % off MRP. **The
Snapshots panel** additionally captures hourly page screenshots so the team can
eyeball the live customer view — stock, hero image, badges, price block — at a
glance.

## Architecture

```
┌──────────────────┐     ┌─────────────────────────┐     ┌──────────────┐
│  React SPA       │ ──▶ │  FastAPI (backend/)     │ ──▶ │  PostgreSQL  │
│  (frontend/)     │     │   pw_scraper.py         │     │  (Neon)      │
│  Vite + Tailwind │ ◀── │   snapshot_scraper.py   │     │              │
└──────────────────┘     │   main.py               │     │  + page_     │
                         │      │                  │     │    snapshots │
                         │      ▼                  │     └──────────────┘
                         │  BrightData             │
                         │   datasets (product +   │
                         │   sellers — structured) │
                         │  BrightData residential │
                         │   proxy (Playwright —   │
                         │   page screenshots)     │
                         └─────────────────────────┘
```

* `backend/pw_scraper.py`       — structured product / seller data via BrightData.
* `backend/snapshot_scraper.py` — hourly Playwright page screenshots (Snapshots panel).
* `backend/main.py`             — FastAPI endpoints, diff engine, AI bridge, report.
* `frontend/` — React/Vite SPA. **PW Table** and **Snapshots** are the two nav
  entries; the Cohorts / Products / Report pages remain reachable by direct URL.

## Scraper

`pw_scraper` uses two BrightData managed datasets:

| Dataset env var                    | Captures                              |
|------------------------------------|---------------------------------------|
| `BRIGHTDATA_DATASET_ID`            | title, price, MRP, buy-box seller     |
| `BRIGHTDATA_SELLERS_DATASET_ID`    | every seller offer per ASIN (full landscape) |

The sellers dataset is **strongly recommended** — without it we can only
record the buy-box winner per SKU.

Every scraped row is validated before persistence:

* `price > 0` and `price >= 20 INR` (rejects EMI/coupon leaks)
* `mrp > price` (rejects strike-through bleed-throughs)
* `mrp <= 5 × price` (rejects unrelated banner ads)
* Discount % = `(mrp − price) / mrp × 100` only when MRP passes both checks.

Suspect rows are still saved but tagged `needs_review=true` so the UI can
flag them.

### Run locally

```bash
cd backend
python -m pw_scraper --limit 10           # smoke test 10 PW SKUs
python -m pw_scraper --asin 9356932107    # one SKU
python -m pw_scraper --dry-run            # don't persist, just print
python -m pw_scraper                      # all PW-owned SKUs
```

## Snapshots panel

`backend/snapshot_scraper.py` drives a real Chromium (Playwright) through the
BrightData residential proxy (`PROXY_URL`) once an hour for the top ~40 PW SKUs
(`is_own=true`). It:

1. Rotates UA / viewport / locale per attempt.
2. Waits for `#productTitle`, jiggles the mouse, scrolls in stages so lazy
   images load — i.e. behaves like a human.
3. Clips the top of the page (default 2,600 px) as JPEG @ q78 and stores the
   bytes in `page_snapshots.image_bytes`, alongside parsed price / MRP and a
   normalised `stock_status` (`in_stock` / `low_stock` / `out_of_stock` /
   `unknown`).
4. Retries up to 3× with exponential backoff on any failure, and on full
   exhaustion keeps the previous successful snapshot so the panel never goes
   blank.

Knobs (env): `SNAPSHOT_LIMIT`, `SNAPSHOT_NAV_TIMEOUT_MS`, `SNAPSHOT_MAX_RETRIES`,
`SNAPSHOT_PAGE_HEIGHT_PX`, `SNAPSHOT_JPEG_QUALITY`.

CLI:

```bash
cd backend
python -m snapshot_scraper --dry-run                # list targets
python -m snapshot_scraper --asin B0XXXXXXX         # one ASIN
python -m snapshot_scraper --limit 5                # smoke test 5
python -m snapshot_scraper                          # all (default 40)
```

## Crons

| Workflow                                      | Cadence    | Endpoint                  |
|-----------------------------------------------|------------|---------------------------|
| `.github/workflows/daily-refresh.yml`         | 02:00 UTC  | `POST /api/cron/daily`    |
| `.github/workflows/hourly-snapshots.yml`      | every hour | `POST /api/cron/snapshots`|

Both authenticate with `Bearer ${CRON_SECRET}`.

## Endpoints (excerpt)

| Method | Path                                       | Purpose                                 |
|--------|--------------------------------------------|-----------------------------------------|
| GET    | `/api/products`                            | Catalogue (snapshots + sellers joined)  |
| POST   | `/api/products/{id}/sellers`               | Refresh one SKU                         |
| POST   | `/api/sellers/refresh-all`                 | SSE-streamed bulk refresh (PW SKUs)     |
| GET    | `/api/sellers/diagnose`                    | Report which BrightData datasets are configured |
| GET    | `/api/snapshots`                           | Snapshots panel — latest metadata per SKU |
| GET    | `/api/snapshots/{id}/image`                | Serve the latest JPEG for one product   |
| POST   | `/api/snapshots/refresh/{id}`              | Re-capture one SKU (UI button)          |
| POST   | `/api/snapshots/refresh-all`               | SSE-streamed bulk re-capture            |
| GET/POST | `/api/cron/daily`                        | Consolidated daily refresh              |
| GET/POST | `/api/cron/snapshots`                    | Hourly page-screenshot refresh          |
| GET/POST | `/api/cron/monitor`                      | Legacy alias for `/api/cron/daily`      |
| POST   | `/api/run-check`                           | On-demand single SKU refresh + diff     |
| GET    | `/api/report`                              | Executive briefing payload              |

## Env vars

```
DATABASE_URL=postgres://…neon…
BRIGHTDATA_TOKEN=…
BRIGHTDATA_DATASET_ID=…             # Amazon Product dataset
BRIGHTDATA_SELLERS_DATASET_ID=…     # Amazon Sellers Info dataset (recommended)
BRIGHTDATA_ZIPCODE=400001           # anchor city so buy-box is consistent
PROXY_URL=http://user:pass@host:port # BrightData residential proxy (Snapshots)
PROXY_VERIFY_SSL=false              # BrightData uses an MITM cert by default
CRON_SECRET=…                        # bearer for /api/cron/*
OPENROUTER_API_KEY=…                 # AI narrative on Report page (optional)
OPENROUTER_MODEL=deepseek/deepseek-v3.2
SNAPSHOT_LIMIT=40                    # cap on the Snapshots panel grid (optional)
```
