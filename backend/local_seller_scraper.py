"""local_seller_scraper.py — Run scraping from your Windows machine.

Usage:
    python local_seller_scraper.py              # scrapes ALL is_own products
    python local_seller_scraper.py --asin 1234  # scrape one ASIN
    python local_seller_scraper.py --limit 5    # scrape first 5 only

Reads/writes the same Neon DB the deployed backend uses.
Uses your home IP — bypasses datacenter blocks completely.
"""
import argparse
import asyncio
import sys
from dotenv import load_dotenv

load_dotenv()

from database import query
from scraper import scrape_offer_listings, scrape_product


async def refresh_one(product: dict) -> int:
    pid, asin, url = product["id"], product["asin_or_sku"], product["url"]
    print(f"  [scrape] product {pid}  {asin} ...", end=" ", flush=True)
    try:
        listings = await scrape_offer_listings(asin)
    except Exception as e:
        print(f"ERROR: {e}")
        return 0

    if not listings:
        print("0 sellers")
        return 0

    query("DELETE FROM seller_offers WHERE product_id=$1", [pid])
    for s in listings:
        query(
            "INSERT INTO seller_offers (product_id,seller_name,price,condition,is_fba,prime_eligible,fetched_at)"
            " VALUES ($1,$2,$3,$4,$5,$6,NOW())",
            [pid, s["seller_name"], s["price"], s["condition"], s["is_fba"], s["prime_eligible"]],
        )
    print(f"{len(listings)} sellers OK")
    return len(listings)


async def refresh_product_data(product: dict) -> bool:
    """Also refresh title/price/rating snapshot."""
    pid, asin, url = product["id"], product["asin_or_sku"], product["url"]
    print(f"  [snap]   product {pid}  {asin} ...", end=" ", flush=True)
    try:
        payload = await scrape_product(asin, url)
    except Exception as e:
        print(f"ERROR: {e}")
        return False
    if not payload:
        print("blocked / no data")
        return False
    import json
    query(
        "INSERT INTO snapshots (product_id, payload_json, fetched_at) VALUES ($1, $2, NOW())",
        [pid, json.dumps(payload)],
    )
    query(
        "UPDATE products SET title_known=COALESCE(title_known,$1), last_seen_at=NOW() WHERE id=$2",
        [payload.get("title"), pid],
    )
    print(f"OK ({payload.get('title','?')[:40]})")
    return True


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asin", help="Scrape only this ASIN")
    ap.add_argument("--limit", type=int, help="Limit number of products")
    ap.add_argument("--sellers-only", action="store_true", help="Skip product snapshot, only refresh sellers")
    ap.add_argument("--snapshot-only", action="store_true", help="Skip sellers, only refresh product data")
    ap.add_argument("--all", action="store_true", help="Include products where is_own=false")
    args = ap.parse_args()

    if args.asin:
        products = query(
            "SELECT id, asin_or_sku, url FROM products WHERE asin_or_sku=$1 AND platform='amazon'",
            [args.asin],
        )
    else:
        sql = "SELECT id, asin_or_sku, url FROM products WHERE platform='amazon'"
        if not args.all:
            sql += " AND is_own=true"
        sql += " ORDER BY id"
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"
        products = query(sql)

    if not products:
        print("No products to scrape.")
        return

    print(f"\n=== Local Scraper ===")
    print(f"Target: {len(products)} product(s)")
    print(f"Mode: ", end="")
    if args.snapshot_only:
        print("snapshots only")
    elif args.sellers_only:
        print("sellers only")
    else:
        print("snapshots + sellers")
    print()

    snap_ok = sellers_total = 0
    for i, p in enumerate(products, 1):
        print(f"[{i}/{len(products)}]")
        if not args.sellers_only:
            if await refresh_product_data(p):
                snap_ok += 1
            await asyncio.sleep(2)
        if not args.snapshot_only:
            sellers_total += await refresh_one(p)
            await asyncio.sleep(2)

    print(f"\n=== Done ===")
    print(f"Snapshots OK: {snap_ok}")
    print(f"Total sellers fetched: {sellers_total}")


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
