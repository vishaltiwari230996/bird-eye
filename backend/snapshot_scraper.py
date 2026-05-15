"""snapshot_scraper.py — Hourly Amazon page screenshots for the Snapshots panel.

Why this module exists
──────────────────────
`pw_scraper.py` (BrightData) gives us *structured* price/seller numbers, but the
Snapshots panel needs the *visual* product page — exactly what the customer
sees, especially the availability box. BrightData doesn't return images, so we
drive a real Chromium with Playwright through the BrightData residential proxy
that's already configured in ``backend/.env`` as ``PROXY_URL``.

Design goals
────────────
1. **Never fail** — three retries with exponential backoff, fresh browser
   context each time, captcha detection, and we keep the previous successful
   snapshot if the new run fails entirely.
2. **Open links like a human** — random Chrome user-agent + viewport, gentle
   incremental scroll to trigger lazy images, randomised delays, mouse jitter.
3. **Stock-first** — we extract the ``#availability`` box text into a normalised
   ``stock_status`` (``in_stock`` / ``low_stock`` / ``out_of_stock`` /
   ``unknown``) plus the raw message so the UI can colour-code each card.
4. **Storage you don't have to admin** — JPEG bytes live in Postgres
   (``page_snapshots.image_bytes``) so there is no extra storage bucket to
   provision. With 40 SKUs × hourly refresh × ~250 KB/image we churn at most
   ~10 MB per hour — comfortably inside Neon's free tier.

CLI:
    python -m backend.snapshot_scraper                  # refresh all targets
    python -m backend.snapshot_scraper --asin B0XXXXXXX # refresh one ASIN
    python -m backend.snapshot_scraper --limit 5        # refresh first 5
"""
from __future__ import annotations

import argparse
import asyncio
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

from dotenv import load_dotenv

_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"))
load_dotenv(os.path.join(os.path.dirname(_HERE), ".env"), override=False)
sys.path.insert(0, _HERE)

from database import query, query_one  # noqa: E402


# ─── Configuration ────────────────────────────────────────────────────────────

DEFAULT_LIMIT = int(os.getenv("SNAPSHOT_LIMIT", "40"))
PROXY_URL = os.getenv("PROXY_URL", "").strip()
PROXY_VERIFY_SSL = os.getenv("PROXY_VERIFY_SSL", "true").lower() not in ("false", "0", "no")

NAV_TIMEOUT_MS = int(os.getenv("SNAPSHOT_NAV_TIMEOUT_MS", "45000"))
WAIT_FOR_TITLE_MS = int(os.getenv("SNAPSHOT_TITLE_TIMEOUT_MS", "25000"))
MAX_RETRIES = int(os.getenv("SNAPSHOT_MAX_RETRIES", "3"))
PAGE_HEIGHT_PX = int(os.getenv("SNAPSHOT_PAGE_HEIGHT_PX", "2600"))
JPEG_QUALITY = int(os.getenv("SNAPSHOT_JPEG_QUALITY", "78"))

# Rotate UA + viewport per attempt so even Amazon's bot-fingerprint heuristic
# sees a different "browser" if a retry is needed.
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]
VIEWPORTS = [
    {"width": 1280, "height": 900},
    {"width": 1366, "height": 900},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 960},
]
LOCALES = ["en-IN", "en-US", "en-GB"]


# ─── Schema bootstrap ─────────────────────────────────────────────────────────

_TABLE_READY = False


def ensure_table() -> None:
    """Lazily create the page_snapshots table. Idempotent — safe to call often."""
    global _TABLE_READY
    if _TABLE_READY:
        return
    query(
        """CREATE TABLE IF NOT EXISTS page_snapshots (
              id SERIAL PRIMARY KEY,
              product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
              image_bytes BYTEA NOT NULL,
              image_mime TEXT NOT NULL DEFAULT 'image/jpeg',
              width INT,
              height INT,
              title TEXT,
              price NUMERIC,
              mrp NUMERIC,
              stock_status TEXT,
              stock_message TEXT,
              status TEXT NOT NULL DEFAULT 'ok',
              error TEXT,
              fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )"""
    )
    query(
        "CREATE INDEX IF NOT EXISTS page_snapshots_product_fetched_idx"
        " ON page_snapshots(product_id, fetched_at DESC)"
    )
    _TABLE_READY = True


# ─── Target selection ─────────────────────────────────────────────────────────

def fetch_targets(limit: int = DEFAULT_LIMIT, asin: Optional[str] = None,
                  product_id: Optional[int] = None) -> list[dict]:
    """Return Amazon products to snapshot.

    Priority order:
      1. Explicit `product_id` or `asin` — single SKU mode.
      2. PW-owned Amazon SKUs (`is_own=true`), oldest-id first, capped at
         `limit`. This gives the team a stable, predictable set of 20-40 cards.
    """
    if product_id:
        rows = query(
            "SELECT id, asin_or_sku, url, title_known FROM products"
            " WHERE id=$1 AND platform='amazon'",
            [product_id],
        )
        return list(rows)
    if asin:
        rows = query(
            "SELECT id, asin_or_sku, url, title_known FROM products"
            " WHERE asin_or_sku=$1 AND platform='amazon'",
            [asin],
        )
        return list(rows)
    rows = query(
        "SELECT id, asin_or_sku, url, title_known FROM products"
        " WHERE platform='amazon' AND is_own=true"
        " ORDER BY id LIMIT $1",
        [limit],
    )
    return list(rows)


# ─── Scrape result ────────────────────────────────────────────────────────────

@dataclass
class SnapshotResult:
    product_id: int
    asin: str
    status: str                     # 'ok' | 'error'
    error: Optional[str] = None
    image_bytes: Optional[bytes] = None
    width: Optional[int] = None
    height: Optional[int] = None
    title: Optional[str] = None
    price: Optional[float] = None
    mrp: Optional[float] = None
    stock_status: Optional[str] = None   # in_stock | low_stock | out_of_stock | unknown
    stock_message: Optional[str] = None


# ─── DOM helpers ──────────────────────────────────────────────────────────────

_NUM_RE = re.compile(r"[\d,]+\.?\d*")

def _to_num(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    m = _NUM_RE.search(text.replace("\u202f", " "))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def _classify_stock(text: Optional[str]) -> str:
    if not text:
        return "unknown"
    t = text.strip().lower()
    if not t:
        return "unknown"
    # Negatives first — Amazon sometimes shows "Currently unavailable" alongside
    # other availability hints, so we trust the strongest signal.
    if any(p in t for p in (
        "currently unavailable", "out of stock", "temporarily out of stock",
        "this item cannot be shipped", "not deliverable to this pincode",
    )):
        return "out_of_stock"
    if "only" in t and "left in stock" in t:
        return "low_stock"
    if "left in stock" in t and "more on the way" in t:
        return "low_stock"
    if "in stock" in t or "usually dispatched" in t or "available" in t:
        return "in_stock"
    return "unknown"


JS_EXTRACT = """
() => {
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.trim() : null;
  };
  const availabilityEl =
    document.querySelector('#availability') ||
    document.querySelector('#availability_feature_div') ||
    document.querySelector('#exports_desktop_outOfStock_buybox_message_feature_div');
  return {
    title: text('#productTitle'),
    price:
      text('.a-price .a-offscreen') ||
      text('#corePrice_feature_div .a-offscreen') ||
      text('#priceblock_ourprice') ||
      text('#priceblock_dealprice') ||
      text('#priceblock_saleprice') ||
      null,
    mrp:
      text('.a-text-price .a-offscreen') ||
      text('#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen') ||
      text('#listPrice') ||
      text('#priceblock_listprice') ||
      null,
    availability: availabilityEl ? availabilityEl.innerText.trim() : null,
  };
}
"""


def _is_blocked(html_text: str) -> bool:
    """Heuristic detector for Amazon's bot-wall / captcha page."""
    if not html_text:
        return False
    t = html_text.lower()
    return any(p in t for p in (
        "to discuss automated access to amazon data",
        "type the characters you see in this image",
        "enter the characters you see below",
        "/errors/validatecaptcha",
        "robot check",
    ))


# ─── Playwright capture (one attempt) ─────────────────────────────────────────

async def _capture_once(playwright, url: str, attempt: int) -> SnapshotResult:
    """Run a single Playwright capture attempt. Raises on hard failure."""
    ua = USER_AGENTS[attempt % len(USER_AGENTS)]
    viewport = VIEWPORTS[attempt % len(VIEWPORTS)]
    locale = LOCALES[attempt % len(LOCALES)]

    proxy_config: Optional[dict[str, Any]] = None
    if PROXY_URL:
        # Playwright wants the URL split into server / username / password.
        m = re.match(r"^(https?://)([^:]+):([^@]+)@(.+)$", PROXY_URL)
        if m:
            proxy_config = {
                "server": f"{m.group(1)}{m.group(4)}",
                "username": m.group(2),
                "password": m.group(3),
            }
        else:
            proxy_config = {"server": PROXY_URL}

    browser = await playwright.chromium.launch(
        headless=True,
        proxy=proxy_config,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
        ],
    )
    try:
        context = await browser.new_context(
            user_agent=ua,
            viewport=viewport,
            locale=locale,
            timezone_id="Asia/Kolkata",
            ignore_https_errors=not PROXY_VERIFY_SSL,
            java_script_enabled=True,
            extra_http_headers={
                "accept-language": "en-IN,en;q=0.9",
                "upgrade-insecure-requests": "1",
            },
        )
        # Tiny stealth: pretend webdriver is undefined.
        await context.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )
        page = await context.new_page()
        page.set_default_navigation_timeout(NAV_TIMEOUT_MS)

        await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)

        # If the bot-wall fired the response is short; sniff it before waiting
        # for selectors that will never appear.
        body = await page.content()
        if _is_blocked(body):
            raise RuntimeError("amazon bot wall / captcha intercepted")

        # Real customers wait for the page to settle, jiggle the mouse, and
        # then scroll a few times to peek at availability + features.
        try:
            await page.wait_for_selector("#productTitle, #dp", timeout=WAIT_FOR_TITLE_MS)
        except Exception:
            # No title element — most likely a soft-block or a layout we don't
            # know yet. Fall through; the screenshot still captures whatever
            # rendered so we can debug it from the UI.
            pass

        await page.mouse.move(
            random.randint(150, 600), random.randint(150, 400), steps=12,
        )
        for y in (450, 950, 1500, 2100):
            await page.evaluate(f"window.scrollTo({{top:{y},behavior:'smooth'}})")
            await asyncio.sleep(random.uniform(0.25, 0.55))
        await page.evaluate("window.scrollTo({top:0,behavior:'smooth'})")
        await asyncio.sleep(random.uniform(0.4, 0.8))

        info: dict[str, Any] = {}
        try:
            info = await page.evaluate(JS_EXTRACT)
        except Exception:
            info = {}

        # Final screenshot: a tall clip of the top of the page (product image,
        # title, price block, availability). Everything below that is reviews
        # and "frequently bought together" which we don't need.
        clip = {"x": 0, "y": 0, "width": viewport["width"], "height": PAGE_HEIGHT_PX}
        image = await page.screenshot(
            type="jpeg",
            quality=JPEG_QUALITY,
            full_page=False,
            clip=clip,
        )

        availability = info.get("availability") if isinstance(info, dict) else None
        return SnapshotResult(
            product_id=0,  # filled in by caller
            asin="",       # filled in by caller
            status="ok",
            image_bytes=image,
            width=clip["width"],
            height=clip["height"],
            title=info.get("title") if isinstance(info, dict) else None,
            price=_to_num(info.get("price")) if isinstance(info, dict) else None,
            mrp=_to_num(info.get("mrp")) if isinstance(info, dict) else None,
            stock_status=_classify_stock(availability),
            stock_message=(availability or "").strip()[:280] if availability else None,
        )
    finally:
        try:
            await browser.close()
        except Exception:
            pass


async def capture(url: str) -> SnapshotResult:
    """Capture with retries. Always returns a SnapshotResult — never raises.

    On total failure ``status='error'`` and ``error`` is populated, so callers
    can fall back to the last successful snapshot for that product.
    """
    # Import here so loading this module doesn't require Playwright at import
    # time — handy when only the read-path endpoints are touched.
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        return SnapshotResult(
            product_id=0, asin="", status="error",
            error=f"playwright not installed: {exc}",
        )

    last_error: Optional[str] = None
    async with async_playwright() as pw:
        for attempt in range(MAX_RETRIES):
            try:
                result = await _capture_once(pw, url, attempt)
                if result.image_bytes:
                    return result
                last_error = "empty screenshot returned"
            except Exception as exc:  # noqa: BLE001 — we want any failure
                last_error = f"{type(exc).__name__}: {exc}"
                print(f"[snapshot] attempt {attempt + 1}/{MAX_RETRIES} failed for {url}: {last_error}")
            # Exponential backoff with jitter — be polite, also dodge rate caps.
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(2 ** attempt + random.uniform(0.3, 1.2))
    return SnapshotResult(
        product_id=0, asin="", status="error",
        error=last_error or "unknown failure",
    )


# ─── Persistence ──────────────────────────────────────────────────────────────

def persist(result: SnapshotResult, *, prune_keep: int = 4) -> dict:
    """Write the snapshot result and keep the table tidy.

    We retain the most recent ``prune_keep`` snapshots per product so the UI
    can show a tiny history without the bytea column growing unbounded.
    """
    ensure_table()

    if result.status != "ok" or not result.image_bytes:
        # Persist a row marking the failure so the UI knows the cron tried —
        # but only if we have *some* prior good snapshot to fall back to.
        # Without that, a failure row would erase any preview entirely.
        query(
            """INSERT INTO page_snapshots
               (product_id, image_bytes, status, error, fetched_at)
               SELECT $1, image_bytes, 'error', $2, NOW()
                 FROM page_snapshots
                WHERE product_id=$1 AND status='ok'
                ORDER BY fetched_at DESC LIMIT 1""",
            [result.product_id, result.error or "unknown"],
        )
        return {
            "productId": result.product_id,
            "asin": result.asin,
            "status": "error",
            "error": result.error,
        }

    query(
        """INSERT INTO page_snapshots
           (product_id, image_bytes, image_mime, width, height,
            title, price, mrp, stock_status, stock_message, status, fetched_at)
           VALUES ($1, $2, 'image/jpeg', $3, $4, $5, $6, $7, $8, $9, 'ok', NOW())""",
        [
            result.product_id,
            psycopg2_binary(result.image_bytes),
            result.width, result.height,
            result.title, result.price, result.mrp,
            result.stock_status, result.stock_message,
        ],
    )

    # Prune older rows for this product beyond ``prune_keep``.
    query(
        """DELETE FROM page_snapshots
           WHERE product_id=$1 AND id NOT IN (
             SELECT id FROM page_snapshots
             WHERE product_id=$1 ORDER BY fetched_at DESC LIMIT $2
           )""",
        [result.product_id, prune_keep],
    )

    return {
        "productId": result.product_id,
        "asin": result.asin,
        "status": "ok",
        "title": result.title,
        "price": result.price,
        "mrp": result.mrp,
        "stockStatus": result.stock_status,
        "stockMessage": result.stock_message,
        "width": result.width,
        "height": result.height,
        "sizeBytes": len(result.image_bytes),
    }


def psycopg2_binary(b: bytes):
    """Wrap raw bytes so psycopg2 sends them as a Postgres BYTEA literal."""
    from psycopg2 import Binary
    return Binary(b)


# ─── Public orchestration ─────────────────────────────────────────────────────

async def refresh_one(product: dict) -> dict:
    """Capture + persist a single product. Returns the persist() dict."""
    result = await capture(product["url"])
    result.product_id = product["id"]
    result.asin = product.get("asin_or_sku") or ""
    return persist(result)


async def refresh_many(products: list[dict]) -> list[dict]:
    """Sequentially capture + persist a list of products.

    Sequential (not parallel) is deliberate — Amazon's bot heuristics punish
    parallel hits from the same residential IP much harder than spaced-out
    serial ones, and "never fail" matters more than throughput here.
    """
    out: list[dict] = []
    for prod in products:
        t0 = time.time()
        record = await refresh_one(prod)
        record["elapsedSec"] = round(time.time() - t0, 2)
        out.append(record)
        # Tiny human-like pause between SKUs.
        await asyncio.sleep(random.uniform(0.8, 1.8))
    return out


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _cli() -> int:
    parser = argparse.ArgumentParser(description="Snapshot scraper")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"Max SKUs to snapshot (default {DEFAULT_LIMIT})")
    parser.add_argument("--asin", help="Refresh a single ASIN")
    parser.add_argument("--product-id", type=int, help="Refresh a single product id")
    parser.add_argument("--dry-run", action="store_true",
                        help="List which targets would be refreshed without scraping")
    args = parser.parse_args()

    ensure_table()
    targets = fetch_targets(limit=args.limit, asin=args.asin, product_id=args.product_id)
    if not targets:
        print("No matching products to snapshot.")
        return 0

    print(f"Snapshotting {len(targets)} product(s):")
    for t in targets:
        print(f"  · #{t['id']} {t['asin_or_sku']} — {t.get('title_known') or t['url']}")
    if args.dry_run:
        return 0

    if not PROXY_URL:
        print("[warn] PROXY_URL is not set — Amazon will likely block datacenter IPs.")

    results = asyncio.run(refresh_many(targets))
    ok = sum(1 for r in results if r.get("status") == "ok")
    err = len(results) - ok
    print(f"\nDone: {ok} ok, {err} error")
    for r in results:
        marker = "OK " if r.get("status") == "ok" else "ERR"
        size = r.get("sizeBytes")
        stock = r.get("stockStatus") or "?"
        print(f"  [{marker}] {r['asin']:<12}  stock={stock:<12}  "
              f"size={size or '—'}  {r.get('error') or ''}")
    return 0 if err == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_cli())
