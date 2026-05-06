"""seed_pw_catalogue.py

Bulk-import the full PW Amazon catalogue from `Use_Eye_Tools.xlsx` into the
`products` table.

- Each row in the workbook (after the header) is treated as one PW-owned SKU.
- Columns expected: asin1 | item-name | URL.
- A pool named "PW Catalogue" is created (or reused) and every imported SKU is
  assigned to it with `is_own = TRUE`.
- Existing rows (matched by `(platform, asin_or_sku)`) are NOT duplicated; their
  `title_known`, `url`, `is_own` and `pool_id` are refreshed instead.

Usage:
    python backend/seed_pw_catalogue.py            # commit the import
    python backend/seed_pw_catalogue.py --dry-run  # report what would change

Run from the repo root or from `backend/`.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Ensure backend/ is on sys.path when invoked from the repo root.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

load_dotenv(HERE / ".env")

import openpyxl  # noqa: E402
from psycopg2.extras import execute_values  # noqa: E402

from database import get_pool, query, query_one  # noqa: E402

DEFAULT_XLSX = Path(r"D:/birdeye/Use_Eye_Tools.xlsx")
POOL_NAME = "PW Catalogue"
PLATFORM = "amazon"


def normalise_asin(value: object) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Strip Excel scientific-notation artefacts and trailing ".0" from int->float coercion.
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def normalise_url(value: object, asin: str) -> str:
    if value is None or not str(value).strip():
        return f"https://www.amazon.in/dp/{asin}"
    s = str(value).strip()
    if s.startswith("http"):
        return s
    return f"https://www.amazon.in/dp/{asin}"


def normalise_title(value: object) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def read_rows(xlsx_path: Path) -> list[tuple[str, str, str | None]]:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    ws = wb.active
    rows: list[tuple[str, str, str | None]] = []
    seen: set[str] = set()
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            # Header row.
            continue
        if not row or len(row) < 1:
            continue
        asin = normalise_asin(row[0])
        if not asin:
            continue
        if asin in seen:
            continue
        seen.add(asin)
        title = normalise_title(row[1] if len(row) > 1 else None)
        url = normalise_url(row[2] if len(row) > 2 else None, asin)
        rows.append((asin, url, title))
    return rows


def ensure_pool() -> int:
    existing = query_one("SELECT id FROM pools WHERE name=$1", [POOL_NAME])
    if existing:
        return existing["id"]
    row = query_one(
        "INSERT INTO pools (name, notify_emails) VALUES ($1, $2) RETURNING id",
        [POOL_NAME, []],
    )
    return row["id"]


def upsert(rows: list[tuple[str, str, str | None]], pool_id: int) -> dict:
    """Bulk upsert via a single INSERT ... ON CONFLICT statement.

    The unique constraint on (platform, asin_or_sku) is what makes the
    ON CONFLICT clause work. Existing rows have their url/title/pool_id/is_own
    refreshed; new rows are inserted in one round-trip.
    """
    if not rows:
        return {"inserted": 0, "updated": 0, "unchanged": 0}

    values = [(PLATFORM, asin, url, title, True, pool_id) for asin, url, title in rows]

    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            # `xmax = 0` is true on a freshly inserted row; non-zero on an updated row.
            sql = (
                "INSERT INTO products (platform, asin_or_sku, url, title_known, is_own, pool_id) "
                "VALUES %s "
                "ON CONFLICT (platform, asin_or_sku) DO UPDATE SET "
                "  url = EXCLUDED.url, "
                "  title_known = COALESCE(EXCLUDED.title_known, products.title_known), "
                "  is_own = TRUE, "
                "  pool_id = EXCLUDED.pool_id "
                "RETURNING (xmax = 0) AS inserted"
            )
            results = execute_values(cur, sql, values, page_size=500, fetch=True)
            inserted = sum(1 for r in results if r["inserted"])
            updated = len(results) - inserted
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)

    return {"inserted": inserted, "updated": updated, "unchanged": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed PW Amazon catalogue from Use_Eye_Tools.xlsx")
    parser.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    parser.add_argument("--dry-run", action="store_true", help="Report counts without touching the DB")
    args = parser.parse_args()

    if not args.xlsx.exists():
        print(f"ERROR: workbook not found: {args.xlsx}")
        return 2
    if not os.environ.get("DATABASE_URL"):
        print("ERROR: DATABASE_URL not set (load backend/.env first).")
        return 2

    rows = read_rows(args.xlsx)
    print(f"Parsed {len(rows)} unique SKU rows from {args.xlsx.name}.")

    if args.dry_run:
        existing = {
            r["asin_or_sku"]
            for r in query(
                "SELECT asin_or_sku FROM products WHERE platform=$1",
                [PLATFORM],
            )
        }
        new_count = sum(1 for asin, _, _ in rows if asin not in existing)
        print(f"  • would insert : {new_count}")
        print(f"  • would update : {len(rows) - new_count}")
        return 0

    pool_id = ensure_pool()
    print(f"Pool '{POOL_NAME}' id = {pool_id}")
    stats = upsert(rows, pool_id)
    print(
        f"Done. inserted={stats['inserted']}  updated={stats['updated']}  unchanged={stats['unchanged']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
