"""scrape_pw_sellers.py — Refresh PW catalogue with seller offers + MRP.

Filters the PW (is_own=true) catalogue down to "eligible" categories, then
for each SKU runs:

    1. scrape_product   -> writes a fresh `snapshots` row with title/price/MRP/...
    2. scrape_offer_listings -> rewrites `seller_offers` for that product

Categories are computed in Python with the same regex rules as
`frontend/src/pages/PwTable.tsx`. Skips:
    - Notebooks & Stationery
    - Other

Usage (from D:\\birdeye\\backend with venv activated):

    python scrape_pw_sellers.py --limit 50          # first 50 eligible SKUs
    python scrape_pw_sellers.py --limit 50 --offset 50
    python scrape_pw_sellers.py                     # all eligible SKUs
    python scrape_pw_sellers.py --asin 9356932107   # single SKU

Reads/writes the same Neon DB the deployed backend uses.
Runs through your home IP — no proxy needed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from typing import Optional

from dotenv import load_dotenv

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

load_dotenv()

# Force-disable any configured proxy. This script is meant to run from your
# home IP — Bright Data residential proxy account currently suspended.
import os as _os
for _k in ("PROXY_URL", "PROXY_HOST", "PROXY_PORT", "PROXY_USER", "PROXY_PASS"):
    _os.environ.pop(_k, None)

from database import query  # noqa: E402
from scraper import scrape_offer_listings, scrape_product  # noqa: E402


# Mirror of frontend CATEGORY_RULES order. First match wins.
CATEGORY_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("Handwritten Notes",         re.compile(r"\bhandwritten\b|\bhand[- ]written\b", re.I)),
    ("Mind Maps & Quick Revision",re.compile(r"\bmind\s*map|quick\s*revision|formula\s*book|formula\s*sheet|cheat\s*sheet|revision\s*notes?", re.I)),
    ("PYQs & Practice",           re.compile(r"\bpyq|previous\s*year|past\s*year|practice\s*paper|sample\s*paper|mock\s*test", re.I)),
    ("NEET",                      re.compile(r"\bneet\b|\baiims\b|medical\s*entrance", re.I)),
    ("JEE",                       re.compile(r"\bjee\b|iit[- ]?jee|advanced|mains?", re.I)),
    ("CUET",                      re.compile(r"\bcuet\b", re.I)),
    ("UPSC & Govt. Exams",        re.compile(r"\bupsc\b|\bias\b|civil\s*services|ssc\b|bank\s*po|rrb\b|nda\b", re.I)),
    ("NCERT",                     re.compile(r"\bncert\b", re.I)),
    ("Classes 11\u201312 / Boards", re.compile(r"class\s*1[12]|cbse\s*1[12]|board\s*exam|\bxi\b|\bxii\b", re.I)),
    ("Classes 6\u201310 / Foundation", re.compile(r"class\s*[6-9]|class\s*10|foundation|\bvi\b|\bvii\b|\bviii\b|\bix\b|\bx\b", re.I)),
    ("Question Banks",            re.compile(r"question\s*bank|\bqb\b\s|chapterwise|chapter[- ]?wise", re.I)),
    ("Workbooks & Modules",       re.compile(r"workbook|module|study\s*material|complete\s*kit|combo", re.I)),
    ("Notebooks & Stationery",    re.compile(r"notebook|register|diary|highlighter|pen\s|pencil|stationery", re.I)),
]
EXCLUDED_CATEGORIES = {"Notebooks & Stationery", "Other"}


def categorize(title: Optional[str]) -> str:
    t = (title or "").strip()
    if not t:
        return "Other"
    for name, rx in CATEGORY_RULES:
        if rx.search(t):
            return name
    return "Other"


def fetch_eligible_pw_products() -> list[dict]:
    rows = query(
        """
        SELECT p.id, p.asin_or_sku, p.url,
               COALESCE(NULLIF(s.payload_json->>'title', ''), p.title_known) AS title
          FROM products p
          LEFT JOIN LATERAL (
                SELECT payload_json
                  FROM snapshots
                 WHERE product_id = p.id
                 ORDER BY fetched_at DESC
                 LIMIT 1
          ) s ON TRUE
         WHERE p.platform = 'amazon' AND p.is_own = TRUE
         ORDER BY p.id
        """
    )
    eligible: list[dict] = []
    for r in rows:
        cat = categorize(r["title"])
        if cat in EXCLUDED_CATEGORIES:
            continue
        eligible.append({**r, "category": cat})
    return eligible


async def refresh_one(p: dict) -> tuple[int, bool, Optional[float], Optional[float]]:
    """Returns (seller_count, snapshot_ok, price, mrp).

    Each phase (snapshot fetch, sellers fetch) is wrapped in its own asyncio
    timeout so one hung Amazon page can't freeze the whole run. Observed
    failure mode: Playwright `click('See All Buying Options')` waits forever
    on certain SKUs.
    """
    SNAPSHOT_TIMEOUT = 90    # seconds — enough for one /dp/ load + retries
    SELLERS_TIMEOUT  = 120   # seconds — Playwright + AOD click + parse

    pid, asin, url = p["id"], p["asin_or_sku"], p["url"]
    print(f"  [{p['category'][:18]:<18}] {asin} ", end="", flush=True)

    snapshot_ok = False
    price: Optional[float] = None
    mrp: Optional[float] = None
    try:
        payload = await asyncio.wait_for(scrape_product(asin, url), timeout=SNAPSHOT_TIMEOUT)
        if payload and payload.get("title"):
            import hashlib
            h = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            query(
                "INSERT INTO snapshots (product_id, payload_json, hash, fetched_at)"
                " VALUES ($1, $2::jsonb, $3, NOW())",
                [pid, json.dumps(payload), h],
            )
            snapshot_ok = True
            price = payload.get("price")
            mrp = payload.get("mrp")
    except asyncio.TimeoutError:
        print(f"[snap TIMEOUT >{SNAPSHOT_TIMEOUT}s] ", end="")
    except Exception as e:
        print(f"[snap ERR: {e}] ", end="")

    seller_count = 0
    try:
        listings = await asyncio.wait_for(scrape_offer_listings(asin), timeout=SELLERS_TIMEOUT)
        if listings:
            query("DELETE FROM seller_offers WHERE product_id=$1", [pid])
            for s in listings:
                query(
                    "INSERT INTO seller_offers"
                    " (product_id, seller_name, price, condition, is_fba, prime_eligible, fetched_at)"
                    " VALUES ($1,$2,$3,$4,$5,$6,NOW())",
                    [pid, s["seller_name"], s["price"], s["condition"],
                     s["is_fba"], s["prime_eligible"]],
                )
            seller_count = len(listings)
    except asyncio.TimeoutError:
        print(f"[sellers TIMEOUT >{SELLERS_TIMEOUT}s] ", end="")
    except Exception as e:
        print(f"[sellers ERR: {e}] ", end="")

    bits = []
    if price:
        bits.append(f"₹{int(price)}")
    if mrp:
        bits.append(f"MRP ₹{int(mrp)}")
    bits.append(f"{seller_count} sellers")
    print(" · ".join(bits))
    return seller_count, snapshot_ok, price, mrp


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="Max number of eligible SKUs to scrape")
    ap.add_argument("--offset", type=int, default=0,
                    help="Skip this many eligible SKUs from the top")
    ap.add_argument("--asin", type=str, default=None,
                    help="Scrape only this single ASIN (ignores filters)")
    ap.add_argument("--resume", action="store_true",
                    help="Skip SKUs that already have a snapshot from the last 24h")
    args = ap.parse_args()

    if args.asin:
        rows = query(
            "SELECT id, asin_or_sku, url, title_known AS title"
            " FROM products WHERE platform='amazon' AND asin_or_sku=$1",
            [args.asin],
        )
        if not rows:
            print(f"ASIN {args.asin} not found in products")
            return 1
        targets = [{**rows[0], "category": categorize(rows[0]["title"])}]
    else:
        eligible = fetch_eligible_pw_products()
        print(f"Eligible PW SKUs (excluding {sorted(EXCLUDED_CATEGORIES)}): {len(eligible)}")
        if args.resume:
            fresh = {
                r["product_id"] for r in query(
                    "SELECT DISTINCT product_id FROM snapshots WHERE fetched_at > NOW() - INTERVAL '24 hours'"
                )
            }
            before = len(eligible)
            eligible = [e for e in eligible if e["id"] not in fresh]
            print(f"--resume: skipped {before - len(eligible)} SKUs already scraped in the last 24h")
        targets = eligible[args.offset: args.offset + args.limit if args.limit else None]
        # Print category histogram
        from collections import Counter
        hist = Counter(t["category"] for t in targets)
        print("Batch composition:")
        for cat, n in hist.most_common():
            print(f"  {cat:<28} {n}")
        print()

    print(f"Scraping {len(targets)} SKU(s)\n")
    totals = {"sellers": 0, "snap_ok": 0, "with_mrp": 0}
    for i, p in enumerate(targets, 1):
        print(f"{i:>3}/{len(targets)}", end=" ")
        sc, ok, _price, mrp = await refresh_one(p)
        totals["sellers"] += sc
        totals["snap_ok"] += int(ok)
        totals["with_mrp"] += int(mrp is not None)

    print()
    print(f"Done. Snapshots OK: {totals['snap_ok']}/{len(targets)}"
          f"  ·  with MRP: {totals['with_mrp']}"
          f"  ·  seller rows: {totals['sellers']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
