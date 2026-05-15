"""pw_scraper.py — Clean, cloud-first PW SKU scraper.

Single responsibility
─────────────────────
For a list of PW Amazon SKUs, fetch:

  * Product details   — title, current selling price, MRP
  * Seller landscape  — every offer with seller name + price + condition + FBA flag
  * Discount %        — computed against the validated MRP (never against price)
  * Total sellers     — counted from the verified offer list

Why a new module exists
───────────────────────
The legacy `scraper.py` chains four different paths (PA-API → Playwright AOD →
static AOD → AI-extracted offers). On a datacenter IP (Hugging Face Space) the
Playwright + static paths get captcha-walled and PA-API requires keys that
aren't configured. The result was wrong MRP, wrong seller count, and wrong
discount percentages making it into the PW Table.

This module uses **BrightData's managed Amazon scrapers** as the single source
of truth and validates every numeric field before persisting it:

  1. `BRIGHTDATA_DATASET_ID`         — Amazon Product (title, price, MRP, buy-box)
  2. `BRIGHTDATA_SELLERS_DATASET_ID` — Amazon Sellers Info (all offers per ASIN)

Both datasets accept a batch of URLs and return structured JSON. We poll the
async snapshot endpoint, normalise the response, run sanity checks, persist.

Used by
───────
* `backend/main.py`  POST /api/cron/daily        (scheduled refresh)
* `backend/main.py`  POST /api/sellers/refresh-all (UI-triggered SSE refresh)
* CLI:  `python -m backend.pw_scraper [--limit N] [--asin X]`
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

import httpx
from dotenv import load_dotenv

# Load env from both the backend/ folder (DATABASE_URL et al) and the repo
# root (BRIGHTDATA_* etc) so the CLI works regardless of where it's invoked.
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"))
load_dotenv(os.path.join(os.path.dirname(_HERE), ".env"), override=False)
sys.path.insert(0, _HERE)

from database import query, query_one  # noqa: E402


# ─── Constants ────────────────────────────────────────────────────────────────

BRIGHTDATA_BASE = "https://api.brightdata.com/datasets/v3"
DEFAULT_ZIPCODE = os.getenv("BRIGHTDATA_ZIPCODE", "400001").strip() or "400001"

# Sanity bounds — keep in sync with `validate_payload` in main.py.
PRICE_FLOOR_INR = 20.0
MRP_RATIO_CAP = 5.0       # MRP > 5× price is almost certainly a strike-through bleed
MRP_MIN_OVER_PRICE = 1.0  # MRP must be strictly greater than the selling price

# Polling cadence for async BrightData snapshots.
POLL_SECONDS = 10
POLL_MAX_ATTEMPTS = 36  # ~ 6 minutes total


# ─── Data shapes ──────────────────────────────────────────────────────────────

@dataclass
class SellerOffer:
    seller_name: str
    price: Optional[float] = None
    condition: str = "New"
    is_fba: bool = False
    prime_eligible: bool = False

    def to_dict(self) -> dict:
        return {
            "seller_name": self.seller_name,
            "price": self.price,
            "condition": self.condition,
            "is_fba": self.is_fba,
            "prime_eligible": self.prime_eligible,
        }


@dataclass
class ScrapedSku:
    """Everything we persist for one PW SKU after a successful scrape."""
    product_id: int
    asin: str
    url: str
    title: Optional[str] = None
    price: Optional[float] = None
    mrp: Optional[float] = None
    discount_pct: Optional[float] = None
    buy_box_seller: Optional[str] = None
    rating: Optional[float] = None
    review_count: Optional[int] = None
    bsr: Optional[str] = None
    availability: Optional[str] = None
    image: Optional[str] = None
    description: Optional[str] = None
    sellers: list[SellerOffer] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def total_sellers(self) -> int:
        return len(self.sellers)

    @property
    def needs_review(self) -> bool:
        return bool(self.review_reasons)

    def to_snapshot_payload(self) -> dict:
        """Mirror the legacy snapshot shape so existing readers keep working."""
        return {
            "title": self.title,
            "price": self.price,
            "mrp": self.mrp,
            "discountPct": self.discount_pct,
            "currency": "INR",
            "rating": self.rating,
            "reviewCount": self.review_count,
            "bsr": self.bsr,
            "availability": self.availability,
            "image": self.image,
            "description": self.description,
            "totalSellers": self.total_sellers,
            "offers": {
                "availability": self.availability,
                "seller": self.buy_box_seller,
            },
            "needs_review": self.needs_review,
            "review_reasons": self.review_reasons,
            "scrape_sources": self.sources,
        }


# ─── Number / text normalisation ──────────────────────────────────────────────

def _to_float(raw: Any) -> Optional[float]:
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    s = str(raw).replace(",", "").replace("\u20b9", "").replace("Rs.", "").replace("Rs", "")
    s = s.replace("INR", "").strip()
    m = re.search(r"\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group())
    except (TypeError, ValueError):
        return None


def _to_int(raw: Any) -> Optional[int]:
    v = _to_float(raw)
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _truthy(raw: Any) -> bool:
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("true", "yes", "1", "amazon")


def _first_present(d: dict, keys: Iterable[str]) -> Any:
    for k in keys:
        v = d.get(k)
        if v not in (None, "", []):
            return v
    return None


# ─── Validation ───────────────────────────────────────────────────────────────

def validate(sku: ScrapedSku) -> list[str]:
    """Return a list of human-readable issues. Empty list ⇒ payload looks fine."""
    issues: list[str] = []

    if sku.price is None or sku.price <= 0:
        issues.append("price missing or zero (scrape likely blocked)")
    elif sku.price < PRICE_FLOOR_INR:
        issues.append(f"price ₹{sku.price:.0f} below floor ₹{PRICE_FLOOR_INR:.0f}")

    if sku.mrp is not None and sku.price is not None and sku.price > 0:
        if sku.mrp <= sku.price + MRP_MIN_OVER_PRICE:
            issues.append(f"mrp ₹{sku.mrp:.0f} <= price ₹{sku.price:.0f}")
            sku.mrp = None
        elif sku.mrp > sku.price * MRP_RATIO_CAP:
            issues.append(f"mrp ₹{sku.mrp:.0f} > {MRP_RATIO_CAP:.0f}× price ₹{sku.price:.0f}")
            sku.mrp = None

    if not sku.title:
        issues.append("title missing")

    return issues


def compute_discount(price: Optional[float], mrp: Optional[float]) -> Optional[float]:
    """Discount % off MRP, rounded to 1 decimal. None if the inputs don't allow it."""
    if not price or not mrp or mrp <= 0 or price >= mrp:
        return None
    return round((mrp - price) / mrp * 100.0, 1)


# ─── BrightData mappers ───────────────────────────────────────────────────────

_PRICE_FIELDS = ("final_price", "price", "selling_price", "current_price")
_MRP_FIELDS = (
    "list_price", "original_price", "max_retail_price", "mrp", "was_price",
    "strike_price", "crossed_out_price", "regular_price", "compare_at_price",
    "initial_price", "list_price_amount",
)
_RATING_FIELDS = ("rating", "stars", "review_rating", "average_rating")
_REVIEW_COUNT_FIELDS = ("reviews_count", "review_count", "rating_count", "number_of_reviews")
_SELLER_LIST_FIELDS = (
    "product_offers", "offers", "other_sellers", "sellers", "seller_offers",
    "buyback_offers", "all_sellers", "sellers_list", "offers_list",
)


def _normalise_seller_list(raw: Any) -> list[SellerOffer]:
    """Extract SellerOffer rows from whatever shape BrightData embedded them in."""
    if not raw:
        return []
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return []

    out: list[SellerOffer] = []
    seen: set[tuple[str, Optional[float]]] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = (
            _first_present(item, ("seller_name", "seller", "merchant_name", "sold_by", "name"))
            or ""
        )
        name = str(name).strip()
        if not name:
            continue
        price = _to_float(_first_present(item, _PRICE_FIELDS))
        condition = str(_first_present(item, ("condition", "item_condition")) or "New").strip()
        fulfillment = str(_first_present(item, ("fulfillment_type", "fulfillment", "shipped_by")) or "").lower()
        is_fba = _truthy(item.get("is_fba")) or "amazon" in fulfillment or name.strip().lower() == "amazon"
        prime = _truthy(_first_present(item, ("prime_eligible", "is_prime", "prime")))

        key = (name.lower(), price)
        if key in seen:
            continue
        seen.add(key)
        out.append(SellerOffer(
            seller_name=name,
            price=price,
            condition=condition or "New",
            is_fba=is_fba,
            prime_eligible=prime,
        ))
    out.sort(key=lambda s: (s.price is None, s.price or 0.0))
    return out


def map_product_item(item: dict, target_url: str, target_asin: str) -> ScrapedSku:
    """Map one BrightData product-dataset row to a ScrapedSku."""
    price = _to_float(_first_present(item, _PRICE_FIELDS))
    mrp = _to_float(_first_present(item, _MRP_FIELDS))
    rating = _to_float(_first_present(item, _RATING_FIELDS))
    reviews = _to_int(_first_present(item, _REVIEW_COUNT_FIELDS))

    images = item.get("images") or item.get("image_urls") or []
    image = None
    if isinstance(images, list) and images:
        image = images[0]
    elif isinstance(images, str):
        image = images
    if not image:
        image = item.get("image") or item.get("main_image") or item.get("primary_image")

    bsr_raw = _first_present(item, ("best_sellers_rank", "best_seller_rank", "bsr"))
    bsr: Optional[str] = None
    if isinstance(bsr_raw, list) and bsr_raw:
        first = bsr_raw[0] if isinstance(bsr_raw[0], dict) else {"rank": bsr_raw[0]}
        bsr = f"#{first.get('rank', '')} in {first.get('category', '')}".strip(" #in")
        if not bsr or bsr == "":
            bsr = None
    elif isinstance(bsr_raw, (str, int)):
        bsr = str(bsr_raw)

    description = item.get("description")
    if isinstance(description, list):
        description = " • ".join(str(x) for x in description if x)
    if isinstance(description, str):
        description = description[:4000]

    buy_box = _first_present(item, ("seller_name", "seller", "buy_box_seller", "merchant_name", "sold_by"))
    if isinstance(buy_box, str):
        buy_box = buy_box.strip() or None

    sellers_inline = _normalise_seller_list(_first_present(item, _SELLER_LIST_FIELDS))

    sku = ScrapedSku(
        product_id=-1,  # filled in by caller
        asin=target_asin,
        url=target_url,
        title=item.get("title") or item.get("name"),
        price=price,
        mrp=mrp,
        rating=rating,
        review_count=reviews,
        bsr=bsr,
        availability=item.get("availability"),
        image=image if isinstance(image, str) else None,
        description=description if isinstance(description, str) else None,
        buy_box_seller=buy_box,
        sellers=sellers_inline,
    )
    return sku


# ─── BrightData transport ─────────────────────────────────────────────────────

class BrightDataError(Exception):
    pass


def _credentials() -> tuple[str, str, str]:
    token = os.getenv("BRIGHTDATA_TOKEN", "").strip()
    product_ds = os.getenv("BRIGHTDATA_DATASET_ID", "").strip()
    sellers_ds = os.getenv("BRIGHTDATA_SELLERS_DATASET_ID", "").strip()
    return token, product_ds, sellers_ds


def is_configured() -> bool:
    token, product_ds, _ = _credentials()
    return bool(token and product_ds)


async def _trigger_snapshot(client: httpx.AsyncClient, *, token: str, dataset_id: str,
                            urls: list[str]) -> list[dict]:
    """Submit a batch of URLs to a BrightData dataset and return the result rows.

    Handles both response shapes BrightData uses:
      * synchronous: list of result rows returned directly
      * asynchronous: {"snapshot_id": "..."} that we poll until ready
    """
    payload = [{"url": u, "zipcode": DEFAULT_ZIPCODE, "language": ""} for u in urls]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    r = await client.post(
        f"{BRIGHTDATA_BASE}/scrape",
        params={"dataset_id": dataset_id, "notify": "false", "include_errors": "true"},
        headers=headers,
        json={"input": payload},
        timeout=30,
    )
    if r.status_code >= 400:
        raise BrightDataError(f"trigger HTTP {r.status_code}: {r.text[:300]}")
    resp = r.json()

    if isinstance(resp, list):
        return resp

    snapshot_id = resp.get("snapshot_id") if isinstance(resp, dict) else None
    if not snapshot_id:
        raise BrightDataError(f"unexpected trigger response: {str(resp)[:300]}")

    print(f"[pw_scraper] Polling snapshot {snapshot_id} for {len(urls)} URL(s)…")
    for attempt in range(POLL_MAX_ATTEMPTS):
        await asyncio.sleep(POLL_SECONDS)
        r = await client.get(
            f"{BRIGHTDATA_BASE}/snapshot/{snapshot_id}",
            params={"format": "json"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if r.status_code == 202:
            continue
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list):
                print(f"[pw_scraper] Snapshot ready ({len(data)} row(s)) on attempt {attempt + 1}")
                return data
        raise BrightDataError(f"poll HTTP {r.status_code}: {r.text[:300]}")

    raise BrightDataError(f"polling timed out after {POLL_MAX_ATTEMPTS * POLL_SECONDS}s")


async def fetch_product_rows(urls: list[str]) -> dict[str, dict]:
    """Map url → raw BrightData product row. Empty dict if unconfigured / failed."""
    token, product_ds, _ = _credentials()
    if not token or not product_ds or not urls:
        return {}
    try:
        async with httpx.AsyncClient() as client:
            rows = await _trigger_snapshot(client, token=token, dataset_id=product_ds, urls=urls)
    except BrightDataError as e:
        print(f"[pw_scraper] product fetch failed: {e}")
        return {}

    out: dict[str, dict] = {}
    for item in rows:
        if not isinstance(item, dict):
            continue
        if item.get("error") or item.get("type") == "error":
            continue
        u = item.get("url") or (item.get("input") or {}).get("url", "")
        if u:
            out[u] = item
    return out


async def fetch_sellers_rows(urls: list[str]) -> dict[str, list[SellerOffer]]:
    """Map url → list of SellerOffer from the sellers dataset.

    Empty dict if BRIGHTDATA_SELLERS_DATASET_ID is unset or the fetch failed.
    The sellers dataset typically returns ONE ROW PER OFFER, so multiple rows
    can share the same URL.
    """
    token, _, sellers_ds = _credentials()
    if not token or not sellers_ds or not urls:
        return {}
    try:
        async with httpx.AsyncClient() as client:
            rows = await _trigger_snapshot(client, token=token, dataset_id=sellers_ds, urls=urls)
    except BrightDataError as e:
        print(f"[pw_scraper] sellers fetch failed: {e}")
        return {}

    grouped: dict[str, list[dict]] = {}
    for item in rows:
        if not isinstance(item, dict):
            continue
        if item.get("error") or item.get("type") == "error":
            continue
        u = item.get("url") or (item.get("input") or {}).get("url", "")
        if not u:
            continue
        grouped.setdefault(u, []).append(item)

    out: dict[str, list[SellerOffer]] = {}
    for u, items in grouped.items():
        offers = _normalise_seller_list(items)
        if offers:
            out[u] = offers
    return out


# ─── Top-level orchestration ──────────────────────────────────────────────────

async def scrape_skus(products: list[dict]) -> list[ScrapedSku]:
    """Scrape every SKU in `products` (each row must have id/asin_or_sku/url).

    Returns a ScrapedSku per input row in the same order. Rows BrightData
    failed for come back with `title=None` and `review_reasons` populated.
    """
    if not products:
        return []
    if not is_configured():
        print("[pw_scraper] BRIGHTDATA_TOKEN / BRIGHTDATA_DATASET_ID not set — nothing to do.")
        return [_unconfigured_sku(p) for p in products]

    urls = [p["url"] for p in products]
    # Fire product + sellers fetches in parallel — they share a quota but
    # neither blocks the other, so the round-trip is one snapshot worth.
    product_task = asyncio.create_task(fetch_product_rows(urls))
    sellers_task = asyncio.create_task(fetch_sellers_rows(urls))
    product_rows, sellers_rows = await asyncio.gather(product_task, sellers_task)

    results: list[ScrapedSku] = []
    for p in products:
        url, pid, asin = p["url"], p["id"], p["asin_or_sku"]
        product_item = product_rows.get(url)
        if not product_item:
            sku = ScrapedSku(product_id=pid, asin=asin, url=url)
            sku.review_reasons.append("brightdata returned no product row")
            results.append(sku)
            continue

        sku = map_product_item(product_item, target_url=url, target_asin=asin)
        sku.product_id = pid
        sku.sources.append("brightdata-product")

        # If the dedicated sellers dataset is configured and returned anything,
        # it's authoritative for the total seller count + offer list. The
        # product dataset's buy-box seller is preserved as `buy_box_seller`.
        dedicated_offers = sellers_rows.get(url)
        if dedicated_offers:
            sku.sellers = dedicated_offers
            sku.sources.append("brightdata-sellers")
            if not sku.buy_box_seller and dedicated_offers[0].price is not None:
                sku.buy_box_seller = dedicated_offers[0].seller_name
        elif not sku.sellers and sku.buy_box_seller and sku.price:
            # No dedicated dataset — still record at least the buy-box seller
            # so the seller_offers table isn't empty for this SKU.
            sku.sellers = [SellerOffer(
                seller_name=sku.buy_box_seller,
                price=sku.price,
                condition="New",
                is_fba="amazon" in sku.buy_box_seller.lower(),
            )]
            sku.sources.append("buybox-mirror")

        sku.review_reasons = validate(sku)
        sku.discount_pct = compute_discount(sku.price, sku.mrp)
        results.append(sku)
    return results


def _unconfigured_sku(p: dict) -> ScrapedSku:
    sku = ScrapedSku(product_id=p["id"], asin=p["asin_or_sku"], url=p["url"])
    sku.review_reasons.append("BRIGHTDATA_TOKEN / BRIGHTDATA_DATASET_ID not configured")
    return sku


# ─── Persistence ──────────────────────────────────────────────────────────────

def _payload_hash(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


def persist(sku: ScrapedSku) -> dict:
    """Write the scraped SKU into snapshots + seller_offers + products.

    Returns a small status dict useful for logging and SSE streaming.
    """
    if not sku.title or sku.price is None or sku.price <= 0:
        return {
            "productId": sku.product_id,
            "asin": sku.asin,
            "status": "skipped_empty",
            "review_reasons": sku.review_reasons,
        }

    payload = sku.to_snapshot_payload()
    h = _payload_hash(payload)

    query(
        "INSERT INTO snapshots (product_id, payload_json, hash, fetched_at)"
        " VALUES ($1, $2::jsonb, $3, NOW())",
        [sku.product_id, json.dumps(payload), h],
    )
    query("UPDATE products SET last_seen_at = NOW() WHERE id = $1", [sku.product_id])

    if sku.sellers:
        query("DELETE FROM seller_offers WHERE product_id = $1", [sku.product_id])
        for offer in sku.sellers:
            query(
                "INSERT INTO seller_offers"
                " (product_id, seller_name, price, condition, is_fba, prime_eligible, fetched_at)"
                " VALUES ($1, $2, $3, $4, $5, $6, NOW())",
                [sku.product_id, offer.seller_name, offer.price, offer.condition,
                 offer.is_fba, offer.prime_eligible],
            )

    return {
        "productId": sku.product_id,
        "asin": sku.asin,
        "status": "success",
        "title": sku.title,
        "price": sku.price,
        "mrp": sku.mrp,
        "discountPct": sku.discount_pct,
        "totalSellers": sku.total_sellers,
        "buyBoxSeller": sku.buy_box_seller,
        "needsReview": sku.needs_review,
        "reviewReasons": sku.review_reasons,
        "sources": sku.sources,
    }


# ─── Public helpers (called by main.py) ───────────────────────────────────────

async def refresh_one(product: dict) -> dict:
    """Convenience wrapper: scrape + persist a single product row."""
    results = await scrape_skus([product])
    if not results:
        return {"productId": product["id"], "asin": product["asin_or_sku"], "status": "error"}
    return persist(results[0])


async def refresh_batch(products: list[dict]) -> list[dict]:
    """Scrape + persist a batch of product rows."""
    results = await scrape_skus(products)
    return [persist(r) for r in results]


def fetch_pw_targets(only_own: bool = True, asin: Optional[str] = None,
                     limit: Optional[int] = None) -> list[dict]:
    """Return the rows in `products` the cron / CLI should refresh."""
    sql = "SELECT id, asin_or_sku, url FROM products WHERE platform = 'amazon'"
    params: list[Any] = []
    if only_own:
        sql += " AND is_own = TRUE"
    if asin:
        sql += f" AND asin_or_sku = ${len(params) + 1}"
        params.append(asin)
    sql += " ORDER BY id"
    if limit and limit > 0:
        sql += f" LIMIT {int(limit)}"
    return query(sql, params if params else None)


# ─── CLI ──────────────────────────────────────────────────────────────────────

async def _cli(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="pw_scraper",
        description="Refresh PW Amazon SKUs (product + sellers + discount) via BrightData.",
    )
    ap.add_argument("--asin", help="Refresh a single ASIN only.")
    ap.add_argument("--limit", type=int, help="Refresh at most this many SKUs.")
    ap.add_argument("--all", action="store_true",
                    help="Include products where is_own=false (default is PW-owned only).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Scrape but don't persist — print the result rows instead.")
    args = ap.parse_args(argv)

    targets = fetch_pw_targets(only_own=not args.all, asin=args.asin, limit=args.limit)
    if not targets:
        print("[pw_scraper] No matching products.")
        return 1

    print(f"[pw_scraper] Targets: {len(targets)} | configured: {is_configured()}")
    started = time.time()
    results = await scrape_skus(targets)

    ok = 0
    review = 0
    failed = 0
    for sku in results:
        if args.dry_run:
            print(json.dumps({
                "asin": sku.asin,
                "title": (sku.title or "")[:60],
                "price": sku.price,
                "mrp": sku.mrp,
                "discountPct": sku.discount_pct,
                "totalSellers": sku.total_sellers,
                "buyBox": sku.buy_box_seller,
                "review": sku.review_reasons,
            }, ensure_ascii=False))
            if sku.title and sku.price:
                ok += 1
            if sku.needs_review:
                review += 1
            if not sku.title or not sku.price:
                failed += 1
            continue

        out = persist(sku)
        if out["status"] == "success":
            ok += 1
            if out.get("needsReview"):
                review += 1
        else:
            failed += 1
        print(f"  {sku.asin:<12} {(sku.title or '?')[:50]:<50} "
              f"₹{sku.price or 0:.0f} mrp₹{sku.mrp or 0:.0f} "
              f"{sku.total_sellers}sellers "
              f"{'' if not sku.discount_pct else f'-{sku.discount_pct:.0f}%'} "
              f"{'⚠' if sku.needs_review else ''}")

    elapsed = time.time() - started
    print(f"[pw_scraper] Done in {elapsed:.1f}s — ok={ok} review={review} failed={failed}")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    return asyncio.run(_cli(argv))


if __name__ == "__main__":
    raise SystemExit(main())
