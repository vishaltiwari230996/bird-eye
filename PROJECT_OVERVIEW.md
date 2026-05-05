# Bird Eye — PW Listing Observatory

> A continuous, AI-augmented Amazon & Flipkart listing observatory built for an executive audience.
> Tracks PW's own SKUs and the surrounding competitive set, detects every meaningful change as it happens, and renders the situation as a quiet, briefing-grade web app.

---

## 1. What the product does (in one paragraph)

Bird Eye watches a curated set of **product listings** on Amazon and Flipkart — both PW's own SKUs and competitor SKUs grouped into **cohorts**. On a schedule (and on demand), it scrapes each listing through a stealth browser pipeline, snapshots the full product state (title, price, rating, review count, BSR, description, sellers), **diffs** the new snapshot against the last one, and writes every detected change to a timeline. A React front-end then turns that timeline into three executive views: a **Products** catalogue, a **Cohorts** competitive board, and a **Report** briefing with AI-written narrative, hijack alerts, and price battlegrounds.

---

## 2. High-level architecture

```
┌───────────────────────┐       ┌───────────────────────────────────────┐       ┌──────────────────┐
│  React + Vite SPA     │  ───▶ │  FastAPI service (Python 3.14)        │ ───▶  │  PostgreSQL      │
│  (frontend/)          │       │  - Stealth scraper (Playwright+httpx) │       │  (snapshots,     │
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
                          └────────────────────────────────────┘
```

Two deployable units:

| Unit | Path | Runtime | Hosts |
|------|------|---------|-------|
| Backend API | `backend/` | FastAPI + Playwright on Python 3.14 | Cloud Run (`cloudbuild.yaml`), Fly.io (`fly.toml`), Railway (`railway.json`) |
| Frontend SPA | `frontend/` | Vite + React 18 + TypeScript | Vercel (`vercel.json`) |

---

## 3. Backend — how the data flows

### 3.1 Scraping pipeline (`backend/scraper.py`)

This is the heart of the system. It is a multi-tier scraper that always tries the cheapest path first and only escalates when blocked.

**Tier 1 — Static HTTP (httpx)**
- Reuses a single `httpx.AsyncClient` so cookies persist across requests (a real browser does this; a one-shot fetcher does not).
- Sends the **complete header surface** Chrome sends: `sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-dest/mode/site/user`, `accept`, `accept-language`, `accept-encoding`, `upgrade-insecure-requests` and a plausible `referer`. Most Amazon block heuristics fire on missing `sec-fetch-*` headers — Bird Eye sends them all.
- User-agent is sampled from a 20-entry pool of **real Chrome 130–132 / Firefox 132–133 / Edge / Safari** UAs collected from public analytics.

**Tier 2 — Playwright stealth browser**
- Single, **shared browser instance** (`get_browser()`) that survives across requests for speed; auto-reconnects on disconnect.
- Uses local Chrome on Windows dev (`CHROME_EXECUTABLE_PATH`) and Playwright's bundled Chromium in containers.
- Each page is patched with a `STEALTH_SCRIPT` that overrides the signals Amazon's bot detection reads:
  - `navigator.webdriver` → `undefined`
  - Realistic `navigator.plugins` (PDF, NaCl) — headless Chrome has 0 by default
  - `navigator.languages` → `['en-IN', 'en-US', 'en']`
  - `window.chrome.runtime` / `loadTimes` / `csi` shims
  - `permissions.query` patch for notifications
  - WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` → real Intel UHD strings
  - `screen.colorDepth` / `pixelDepth` → 24
- **Resource blocking** (`image`, `media`, `font`, `websocket`) and ad/tracker URL patterns (`amazon-adsystem`, `doubleclick`, `googletagmanager`, ...) are intercepted before they hit the wire — 4–5× page load speed-up and a smaller fingerprint.
- Randomised viewport from a Statcounter 2024 distribution.
- Gaussian-distributed **human delays** between actions.
- Exponential backoff retry on detected blocks.

**Tier 3 — AI extraction fallback**
- When the HTML structure of a page looks unusual or selectors fail, the scraper isolates the relevant DOM zone (`_extract_product_zone` / `_extract_offer_zone` strip head, scripts, ads) and ships it to OpenRouter (DeepSeek V3.2 by default) via `ai_extract_product` / `ai_extract_offers`.
- The LLM returns structured JSON which is validated, parsed, and merged into the normal snapshot path. Schema-less HTML changes therefore self-heal.

**Block detection (`is_blocked`)** — combined title + body checks for Amazon's known patterns: "Robot Check", "Type the characters you see", `validateCaptcha`, length/redirect anomalies. False negatives are caught downstream because the diff result will be empty / noisy.

**Proxy** — optional BrightData / generic HTTP proxy via `PROXY_URL` (or component `PROXY_HOST/PORT/USER/PASS`). Both httpx and Playwright pick it up. Password is masked in logs.

**Seller / Buy Box scraping** uses Amazon's AOD (`Amazon Offer Display`) endpoint and parses each seller offer with `parse_aod_html`, falling back to the legacy offer page parser. A `fetch_sellers_paapi` path is wired in for Amazon Product Advertising API SigV4-signed requests when keys are present.

### 3.2 Diff engine (`diff_payloads` in `main.py`)

Given the previous snapshot and the new snapshot, it emits a list of `{field, old_value, new_value}` changes:

- **title** — normalised whitespace + lower-case comparison
- **price** — numeric, ignores rupee symbols / commas, only flags > ₹1 deltas
- **rating** — numeric, only flags ≥ 0.05 deltas
- **reviewCount** — exact integer change
- **BSR** — best-seller rank string change
- **description** — normalised feature-bullet/description text change

Each change is persisted to the `changes` table with an `old_value`, `new_value`, `field`, `detected_at`. Every snapshot also gets a SHA-256 `hash_payload` so identical re-scrapes don't create noise.

### 3.3 Database (`backend/database.py`)

PostgreSQL via `psycopg2` with a **`ThreadedConnectionPool`** (1–10). A small clever bit: the codebase was written with asyncpg-style `$1, $2` placeholders, so `_to_psycopg_sql` rewrites them into psycopg2 `%s` placeholders **without touching parameters inside quoted string literals**. That keeps SQL readable and portable.

Core tables:

| Table | Purpose |
|-------|---------|
| `products` | the watchlist (platform, asin/sku, url, `is_own`) |
| `snapshots` | one row per scrape, full JSON payload + hash |
| `changes` | one row per diff field |
| `seller_offers` | current Buy Box / AOD seller list |
| `pools` (`cohorts`) | named groupings of products for competitive comparison |

### 3.4 API surface (FastAPI, `backend/main.py`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/products` | Catalogue with last snapshot + recent changes + sellers (single round-trip) |
| POST / PUT / DELETE | `/api/products` | CRUD |
| GET | `/api/products/{id}/sellers` | Current seller list |
| POST | `/api/products/{id}/sellers` | Refresh sellers for one product |
| POST | `/api/sellers/refresh-all` | **SSE-streamed** bulk seller refresh for own SKUs |
| GET / POST / DELETE | `/api/pools` | Cohort management |
| PUT | `/api/pools/assign` | Add / remove products from a cohort |
| GET | `/api/pools/changes` | Cohort-scoped change feed |
| POST | `/api/run-check` | On-demand single product re-scrape + diff |
| GET | `/api/hijack-alerts` | Buy-box-stolen / unauthorized-seller alerts |
| GET | `/api/battleground` | Per-cohort price comparison vs PW |
| POST | `/api/ai/cohorts` | LLM-suggested cohort grouping |
| POST | `/api/ai/summary` | LLM-written executive narrative |
| POST | `/api/ai/battleground` | LLM-written competitive commentary |
| GET / POST | `/api/cron/monitor` | Scheduler-friendly endpoint that re-scrapes the whole watchlist |
| GET | `/api/report` | Single payload for the Report page |

Two endpoints stream **Server-Sent Events** so the UI can show a smooth, per-item progress bar while a long bulk operation runs.

---

## 4. Frontend — what an executive sees

Stack: **Vite + React 18 + TypeScript + React Router + Tailwind**, no UI kit. All visual language is hand-built in `frontend/src/index.css` for editorial precision.

### 4.1 Visual identity

- **Theme**: warm "washi paper" cream stock (`#f1ead9`) with sumi-ink type (`#1a1714`).
- **Texture**: subtle SVG fractal-noise overlay (fixed-attached) gives the page a paper grain without performance cost.
- **Earthy accents**: matcha green, vermillion seal, ochre, aizome indigo — all desaturated to read calmly on cream.
- **Typography**:
  - **Headlines** — `Space Grotesk` 600, tracking-tight (Railway-style geometric bold).
  - **Body / UI** — `Inter` 450–600.
  - **Numbers / IDs** — `JetBrains Mono`.
- **Accents**: 14–16 px rounded panels, hairline `rgba(28,24,18,0.10)` borders, `backdrop-filter` blur for the sticky header.

### 4.2 Pages

**`/` Products** (`frontend/src/pages/Products.tsx`)
- Grid of SKU cards grouped by brand, with image, platform pill, OOS flag, current price, rating, BSR, ASIN/SKU, and a chip strip of recent detected changes.
- Click expands a card into a full-width detail strip with a sellers list, a change timeline (`change-intel.ts` formats raw diff rows into human one-liners), and per-field history.
- Search + filters (platform, own/competitor, has-changes-since).

**`/cohorts` Cohorts** (`frontend/src/pages/Cohorts.tsx`)
- One card per cohort, showing aggregate stats: PW vs competitor count, average price gap, last movement.
- Selecting a cohort drills into a board where every member SKU is plotted with its current price and delta vs the cohort median. Negative deltas (we're cheaper) render in matcha; positive deltas (we're pricier) in vermillion.

**`/report` Report** (`frontend/src/pages/Report.tsx`)
- KPI strip: PWs tracked, competitors tracked, movements in the selected window, active hijacks.
- AI-written executive narrative section.
- **Movements** feed — chronological diff stream with sparkline-friendly summaries.
- **Battleground** — per-cohort, per-brand price snapshot with inline mini-deltas.
- **Hijack alerts** — flagged third-party sellers winning the Buy Box on PW SKUs, severity-graded.

### 4.3 API client (`frontend/src/api.ts`)

Typed wrapper over `fetch` with one `API_BASE` switch. SSE endpoints are consumed via `EventSource` so the header progress bar updates smoothly without polling.

### 4.4 Layout (`frontend/src/components/Layout.tsx`)

A sticky, blurred site header with the Bird Eye mark, three nav tabs, and a "Live" status dot. Footer carries the kicker tagline. Layout, header, and main column are width-capped at 1400 px for readability.

---

## 5. Key technical features (cheat sheet for the meeting)

1. **Three-tier scraping** — static httpx → Playwright stealth browser → LLM HTML extraction; cheapest path first, automatic escalation.
2. **Header parity with real Chrome** — full `sec-fetch-*` / `sec-ch-ua-*` / accept-* surface, real-UA pool, randomised viewport — passes Amazon's standard heuristics without paid anti-bot SaaS.
3. **JS stealth patches** — `navigator.webdriver`, plugins, languages, `window.chrome.*`, WebGL vendor/renderer, screen depth — closes every fingerprint vector headless Chrome leaks.
4. **Resource & ad blocking inside Playwright** — drops images/fonts/media + tracker domains; 4–5× page load, smaller network fingerprint.
5. **Singleton browser, hot-reused** — keeps process memory predictable on Cloud Run / Fly.
6. **Optional BrightData proxy** — set one env var, both httpx and Playwright pick it up.
7. **Field-level diff engine** with normalisation rules (whitespace, currency symbols, numeric tolerances) so cosmetic re-renders don't flood the change feed.
8. **Snapshot hashing** (`hash_payload`) — idempotent re-scrapes; identical payloads never emit changes.
9. **PostgreSQL with auto-translated dollar placeholders** — readable SQL, one canonical query helper, threaded pool sized for Cloud Run concurrency.
10. **AI augmentation via OpenRouter** — pluggable model (`OPENROUTER_MODEL`), JSON-coerced parsing that survives markdown fences, used both for resilience (HTML extraction) and narrative (executive summaries, battleground commentary, cohort suggestions).
11. **Server-Sent Events** for long jobs — bulk seller refresh streams progress per-product so the UI bar is smooth and cancellable.
12. **Cron-ready monitor endpoint** — `/api/cron/monitor` is idempotent; point any scheduler (Cloud Scheduler, Fly cron, GitHub Actions) at it.
13. **Deployment portability** — same image runs on Cloud Run, Fly.io, and Railway; the only variable that needs to flip is `CHROME_EXECUTABLE_PATH` (omitted on Linux to fall back to bundled Chromium).
14. **React + Vite SPA, hand-rolled design system** — no UI kit, no jitter, ~100 KB gzip; entire visual language lives in one `index.css`.
15. **Editorial UX** — washi-paper palette, Space Grotesk display + Inter body, paper-grain texture, sumi-ink hierarchy. Built to read like a quiet briefing, not a dashboard.

---

## 6. Where things live

```
backend/
  main.py             FastAPI app, all routes, diff engine, AI bridges
  scraper.py          3-tier stealth scraper (httpx + Playwright + LLM)
  database.py         psycopg2 pool + $1/$2 → %s rewriter
  local_seller_scraper.py   AOD/seller scraper utilities
  Dockerfile          Python 3.14 + Playwright base
  cloudbuild.yaml     Cloud Run deploy
  fly.toml            Fly.io deploy
  railway.json        Railway deploy

frontend/
  src/
    App.tsx           Router
    api.ts            Typed API client
    index.css         Washi-paper design system (single source of truth)
    components/Layout.tsx
    pages/
      Products.tsx    Catalogue + SKU detail
      Cohorts.tsx     Competitive board
      Report.tsx      Executive briefing
    lib/change-intel.ts  Humanises raw diff rows into one-liners
  vite.config.ts
  vercel.json         Vercel deploy
```

---

## 7. Talking-points for the conversation

- "It's a continuous observatory, not a dashboard. Every change is timestamped and narrated."
- "We don't pay an anti-bot vendor. The scraper passes for a real Chrome user using header parity, JS stealth patches, resource blocking, and a real-UA pool."
- "When the HTML changes, an LLM picks up the slack — the system self-heals on schema drift."
- "Every long operation streams progress to the UI over SSE, so leadership never sees a spinner."
- "The visual language is intentionally quiet — washi paper, sumi ink, Railway-style bold type — so the data does the talking."
