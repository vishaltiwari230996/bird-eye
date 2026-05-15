"""main.py — Bird Eye FastAPI backend.

Single scraping path: BrightData via `pw_scraper`. The legacy Playwright /
httpx / AI-extraction scraper has been retired — see `pw_scraper.py` for the
new BrightData-only implementation and the discount % / MRP validation logic.
"""
import json
import os
import re
import time
from datetime import datetime
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

load_dotenv()

from database import query, query_one  # noqa: E402
from pw_scraper import (  # noqa: E402
    ScrapedSku,
    is_configured as brightdata_configured,
    persist as persist_sku,
    scrape_skus,
)
import snapshot_scraper  # noqa: E402

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Bird Eye API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", os.getenv("FRONTEND_URL", "")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_PLATFORMS = {"amazon", "flipkart"}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def map_interval(since: str) -> str:
    return {
        "1h": "1 hour", "6h": "6 hours", "24h": "24 hours",
        "7d": "7 days", "30d": "30 days", "all": "365 days",
    }.get(since, "24 hours")


def parse_json_from_text(content: str) -> Any:
    content = content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content, re.IGNORECASE)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    first, last = content.find("{"), content.rfind("}")
    if first >= 0 and last > first:
        try:
            return json.loads(content[first : last + 1])
        except json.JSONDecodeError:
            pass
    return {"summary": content, "highlights": [], "risks": [], "actions": []}


async def call_openrouter(messages: list[dict], model: Optional[str] = None) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    model = model or os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "messages": messages},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


# ─── Differ ───────────────────────────────────────────────────────────────────

def _num(v) -> float:
    if v is None:
        return 0.0
    try:
        return float(str(v).replace(",", "").replace("₹", "").strip())
    except (ValueError, TypeError):
        return 0.0


def _norm(s) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def diff_payloads(prev: dict, next_: dict) -> list[dict]:
    changes = []

    def add(field, old, new):
        changes.append({"field": field, "old_value": str(old), "new_value": str(new)})

    # Title
    a, b = _norm(prev.get("title")), _norm(next_.get("title"))
    if b and a != b:
        add("title", prev.get("title", ""), next_.get("title", ""))

    # Price
    p_old, p_new = _num(prev.get("price")), _num(next_.get("price"))
    if p_new > 0 and abs(p_old - p_new) > 1:
        add("price", f"₹{p_old}", f"₹{p_new}")

    # Rating
    r_old, r_new = _num(prev.get("rating")), _num(next_.get("rating"))
    if r_new > 0 and abs(r_old - r_new) >= 0.05:
        add("rating", str(r_old) if r_old else "—", str(r_new) if r_new else "—")

    # Review count
    rc_old, rc_new = _num(prev.get("reviewCount")), _num(next_.get("reviewCount"))
    if rc_new > 0 and rc_old != rc_new:
        add("reviewCount", str(int(rc_old)), str(int(rc_new)))

    # MRP
    m_old, m_new = _num(prev.get("mrp")), _num(next_.get("mrp"))
    if m_new > 0 and abs(m_old - m_new) > 1:
        add("mrp", f"₹{m_old}", f"₹{m_new}")

    # BSR
    bsr_old, bsr_new = (prev.get("bsr") or ""), (next_.get("bsr") or "")
    if bsr_new and _norm(bsr_old) != _norm(bsr_new):
        add("offers.bsr", bsr_old or "—", bsr_new)

    # Description (feature bullets + product description)
    d_old, d_new = _norm(prev.get("description")), _norm(next_.get("description"))
    if d_new and d_old != d_new:
        add("description", prev.get("description", "") or "", next_.get("description", "") or "")

    return changes


# ─── Products ─────────────────────────────────────────────────────────────────

@app.get("/api/products")
async def list_products():
    rows = query(
        """SELECT p.*,
             (SELECT row_to_json(s.*) FROM snapshots s WHERE s.product_id = p.id ORDER BY s.fetched_at DESC LIMIT 1) AS last_snapshot,
             (SELECT json_agg(c.*) FROM (
               SELECT * FROM changes
               WHERE product_id = p.id
                 AND (old_value IS NOT NULL AND old_value <> '' AND old_value <> '—')
               ORDER BY detected_at DESC LIMIT 10
             ) c) AS recent_changes,
             (SELECT json_agg(so.* ORDER BY so.price ASC NULLS LAST) FROM (
               SELECT seller_name, price, condition, is_fba, prime_eligible, fetched_at
               FROM seller_offers
               WHERE product_id = p.id
               ORDER BY fetched_at DESC
               LIMIT 20
             ) so) AS seller_offers
           FROM products p ORDER BY p.id"""
    )
    return rows


class ProductCreate(BaseModel):
    platform: str
    asin_or_sku: str
    url: str
    title_known: Optional[str] = None


@app.post("/api/products", status_code=201)
async def create_product(body: ProductCreate):
    if body.platform not in VALID_PLATFORMS:
        raise HTTPException(400, f"platform must be one of: {', '.join(VALID_PLATFORMS)}")
    existing = query_one(
        "SELECT id FROM products WHERE platform=$1 AND asin_or_sku=$2",
        [body.platform, body.asin_or_sku],
    )
    if existing:
        raise HTTPException(409, f"Product already exists with id {existing['id']}")
    row = query_one(
        "INSERT INTO products (platform, asin_or_sku, url, title_known) VALUES ($1,$2,$3,$4) RETURNING id",
        [body.platform, body.asin_or_sku, body.url, body.title_known],
    )
    return {"id": row["id"]}


class ProductUpdate(BaseModel):
    id: int
    url: Optional[str] = None
    title_known: Optional[str] = None


@app.put("/api/products")
async def update_product(body: ProductUpdate):
    sets, params = [], []
    if body.url:
        sets.append(f"url=${len(params)+1}")
        params.append(body.url)
    if body.title_known is not None:
        sets.append(f"title_known=${len(params)+1}")
        params.append(body.title_known)
    if not sets:
        raise HTTPException(400, "No fields to update")
    params.append(body.id)
    row = query_one(
        f"UPDATE products SET {', '.join(sets)} WHERE id=${len(params)} RETURNING *",
        params,
    )
    if not row:
        raise HTTPException(404, "Product not found")
    return row


@app.delete("/api/products")
async def delete_product(id: int = Query(...)):
    query("DELETE FROM seller_offers WHERE product_id=$1", [id])
    query("DELETE FROM changes WHERE product_id=$1", [id])
    query("DELETE FROM snapshots WHERE product_id=$1", [id])
    result = query("DELETE FROM products WHERE id=$1 RETURNING id", [id])
    if not result:
        raise HTTPException(404, "Product not found")
    return {"deleted": id}


# ─── Sellers ──────────────────────────────────────────────────────────────────

@app.get("/api/products/{product_id}/sellers")
async def get_sellers(product_id: int):
    rows = query(
        "SELECT * FROM seller_offers WHERE product_id=$1 ORDER BY price ASC NULLS LAST LIMIT 30",
        [product_id],
    )
    return rows


@app.get("/api/sellers/diagnose")
async def diagnose_seller_sources():
    """Report which BrightData datasets are configured.

    Never leaks secrets; only reports yes/no flags and the suffix of any ID.
    """
    def tail(v: str, n: int = 6) -> str:
        v = (v or "").strip()
        return f"…{v[-n:]}" if len(v) > n else ("(empty)" if not v else v)

    bd_token = os.environ.get("BRIGHTDATA_TOKEN", "").strip()
    bd_product = os.environ.get("BRIGHTDATA_DATASET_ID", "").strip()
    bd_sellers = os.environ.get("BRIGHTDATA_SELLERS_DATASET_ID", "").strip()

    return {
        "brightdata_token": bool(bd_token),
        "brightdata_product_dataset": {
            "configured": bool(bd_token and bd_product),
            "dataset_id_suffix": tail(bd_product),
            "captures": "title, price, MRP, buy-box seller (mirrored per SKU)",
        },
        "brightdata_sellers_dataset": {
            "configured": bool(bd_token and bd_sellers),
            "dataset_id_suffix": tail(bd_sellers),
            "captures": "every seller offer per ASIN (full seller landscape)",
        },
        "summary": (
            "Without BRIGHTDATA_SELLERS_DATASET_ID the only seller data we record "
            "is the buy-box winner. Set BRIGHTDATA_SELLERS_DATASET_ID to the "
            "BrightData 'Amazon sellers info' dataset id to capture the full "
            "seller landscape per ASIN."
        ),
    }


@app.post("/api/products/{product_id}/sellers")
async def refresh_sellers(product_id: int):
    """Refresh a single PW SKU via BrightData (product + sellers + discount)."""
    product = query_one(
        "SELECT id, platform, asin_or_sku, url FROM products WHERE id=$1",
        [product_id],
    )
    if not product:
        raise HTTPException(404, "Product not found")
    if product["platform"] != "amazon":
        raise HTTPException(400, "Seller scraping is only supported for Amazon")

    results = await scrape_skus([product])
    if not results:
        return {"status": "error", "message": "scraper returned no result"}
    return persist_sku(results[0])


@app.post("/api/sellers/refresh-all")
async def refresh_all_sellers():
    """SSE-streamed bulk refresh for PW-owned SKUs via BrightData.

    Each result row is emitted as it lands. The browser progress bar in the
    PW Table reads these events.
    """
    rows = query(
        "SELECT id, asin_or_sku, url FROM products"
        " WHERE platform='amazon' AND is_own=true ORDER BY id"
    )

    async def generate():
        total = len(rows)
        yield f"data: {json.dumps({'total': total, 'done': 0, 'started': True, 'configured': brightdata_configured()})}\n\n"

        if not rows:
            yield f"data: {json.dumps({'done': 0, 'total': 0, 'finished': True})}\n\n"
            return

        results = await scrape_skus(list(rows))
        done = 0
        ok = 0
        review = 0
        for sku in results:
            out = persist_sku(sku)
            done += 1
            if out.get("status") == "success":
                ok += 1
                if out.get("needsReview"):
                    review += 1
            yield f"data: {json.dumps({'done': done, 'total': total, **out})}\n\n"

        yield f"data: {json.dumps({'done': total, 'total': total, 'finished': True, 'ok': ok, 'needs_review': review})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Pools ────────────────────────────────────────────────────────────────────

@app.get("/api/pools")
async def list_pools():
    return query(
        """SELECT p.*,
             (SELECT json_agg(
               json_build_object(
                 'id', pr.id, 'platform', pr.platform, 'asin_or_sku', pr.asin_or_sku,
                 'url', pr.url, 'title_known', pr.title_known, 'is_own', pr.is_own,
                 'last_seen_at', pr.last_seen_at,
                 'snapshot', (SELECT row_to_json(s.*) FROM snapshots s WHERE s.product_id=pr.id ORDER BY s.fetched_at DESC LIMIT 1)
               ) ORDER BY pr.is_own DESC, pr.id
             ) FROM products pr WHERE pr.pool_id=p.id) AS products
           FROM pools p ORDER BY p.created_at DESC"""
    )


class PoolCreate(BaseModel):
    name: str
    notify_emails: Optional[Any] = None


@app.post("/api/pools", status_code=201)
async def create_pool(body: PoolCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Pool name is required")
    existing = query_one("SELECT id FROM pools WHERE name=$1", [name])
    if existing:
        raise HTTPException(409, f"Pool already exists with id {existing['id']}")
    emails: list[str] = []
    if isinstance(body.notify_emails, list):
        emails = [e.strip() for e in body.notify_emails if e.strip()]
    elif isinstance(body.notify_emails, str):
        emails = [e.strip() for e in body.notify_emails.split(",") if e.strip()]
    row = query_one(
        "INSERT INTO pools (name, notify_emails) VALUES ($1,$2) RETURNING id",
        [name, emails],
    )
    return {"id": row["id"]}


class PoolUpdate(BaseModel):
    id: int
    notify_emails: Any


@app.patch("/api/pools")
async def update_pool(body: PoolUpdate):
    emails: list[str] = []
    if isinstance(body.notify_emails, list):
        emails = [e.strip() for e in body.notify_emails if e.strip()]
    elif isinstance(body.notify_emails, str):
        emails = [e.strip() for e in body.notify_emails.split(",") if e.strip()]
    row = query_one(
        "UPDATE pools SET notify_emails=$1 WHERE id=$2 RETURNING id, notify_emails",
        [emails, body.id],
    )
    if not row:
        raise HTTPException(404, "Pool not found")
    return row


@app.delete("/api/pools")
async def delete_pool(id: int = Query(...)):
    query("UPDATE products SET pool_id=NULL WHERE pool_id=$1", [id])
    result = query("DELETE FROM pools WHERE id=$1 RETURNING id", [id])
    if not result:
        raise HTTPException(404, "Pool not found")
    return {"deleted": id}


class AssignBody(BaseModel):
    product_id: int
    pool_id: Optional[int] = None
    is_own: Optional[bool] = None


@app.put("/api/pools/assign")
async def assign_pool(body: AssignBody):
    sets = ["pool_id=$1"]
    params: list[Any] = [body.pool_id]
    if body.is_own is not None:
        sets.append(f"is_own=${len(params)+1}")
        params.append(body.is_own)
    params.append(body.product_id)
    row = query_one(
        f"UPDATE products SET {', '.join(sets)} WHERE id=${len(params)} RETURNING *",
        params,
    )
    if not row:
        raise HTTPException(404, "Product not found")
    return row


@app.get("/api/pools/changes")
async def pool_changes(
    pool_id: Optional[int] = Query(None),
    since: str = Query("24h"),
):
    interval = map_interval(since)
    base = """SELECT c.id, c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
              p.asin_or_sku, p.platform, p.is_own, p.title_known, p.pool_id,
              pl.name AS pool_name,
              (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id=p.id ORDER BY s.fetched_at DESC LIMIT 1) AS product_title
       FROM changes c
       JOIN products p ON p.id=c.product_id
       LEFT JOIN pools pl ON pl.id=p.pool_id"""

    if pool_id:
        return query(
            f"{base} WHERE p.pool_id=$1 AND c.detected_at>=now()-$2::interval ORDER BY c.detected_at DESC LIMIT 500",
            [pool_id, interval],
        )
    return query(
        f"{base} WHERE c.detected_at>=now()-$1::interval ORDER BY c.detected_at DESC LIMIT 500",
        [interval],
    )


# ─── Run Check ────────────────────────────────────────────────────────────────

class RunCheckBody(BaseModel):
    batch: int = 0
    productId: Optional[int] = None


BATCH_SIZE = 10


def _save_with_diff(sku: ScrapedSku) -> dict:
    """Persist a scraped SKU and emit a `changes` row per detected diff.

    Wraps `pw_scraper.persist` with the diff-engine logic that previously
    lived inline in /api/run-check + /api/cron/monitor. Returns the persist
    result plus the `changes` count so callers can report it.
    """
    last_snap = query_one(
        "SELECT hash, payload_json FROM snapshots WHERE product_id=$1"
        " ORDER BY fetched_at DESC LIMIT 1",
        [sku.product_id],
    )
    prev_payload: Optional[dict] = None
    prev_hash: Optional[str] = None
    if last_snap:
        prev_hash = last_snap.get("hash")
        prev_payload = last_snap.get("payload_json")
        if isinstance(prev_payload, str):
            try:
                prev_payload = json.loads(prev_payload)
            except Exception:
                prev_payload = None

    if prev_payload and _num(prev_payload.get("price")) > 0 and (sku.price is None or sku.price <= 0):
        print(f"[run-check] {sku.asin} SKIPPED — empty payload, prior good snapshot kept")
        return {
            "productId": sku.product_id,
            "asin": sku.asin,
            "status": "skipped_empty",
            "changes": 0,
            "needs_review": True,
            "review_reasons": sku.review_reasons,
        }

    out = persist_sku(sku)
    if out.get("status") != "success":
        out["changes"] = 0
        return out

    # Diff against previous snapshot once the new one is saved.
    change_count = 0
    if prev_payload is not None:
        new_payload = sku.to_snapshot_payload()
        for fc in diff_payloads(prev_payload, new_payload):
            query(
                "INSERT INTO changes (product_id, field, old_value, new_value, detected_at)"
                " VALUES ($1,$2,$3,$4,NOW())",
                [sku.product_id, fc["field"], fc["old_value"], fc["new_value"]],
            )
            change_count += 1
    out["changes"] = change_count
    return out


@app.post("/api/run-check")
async def run_check(body: RunCheckBody, request: Request):
    cron_secret = os.getenv("CRON_SECRET", "")
    auth = request.headers.get("authorization", "").replace("Bearer ", "")
    host = request.headers.get("host", "localhost")
    origin = request.headers.get("origin", "")
    referer = request.headers.get("referer", "")
    is_same_origin = (origin and host in origin) or (referer and host in referer)
    is_local_dev = os.getenv("APP_ENV", "development") != "production" and not origin and not referer
    if cron_secret and auth != cron_secret and not is_same_origin and not is_local_dev:
        raise HTTPException(401, "Unauthorized")

    if body.productId:
        products = query(
            "SELECT id, platform, asin_or_sku, url FROM products WHERE id=$1",
            [body.productId],
        )
    else:
        offset = body.batch * BATCH_SIZE
        products = query(
            "SELECT id, platform, asin_or_sku, url FROM products ORDER BY id LIMIT $1 OFFSET $2",
            [BATCH_SIZE, offset],
        )

    if not products:
        return {"message": "No products found", "batch": body.batch}

    scraped = await scrape_skus(list(products))
    results = [_save_with_diff(sku) for sku in scraped]

    return {
        "batch": body.batch,
        "processed": len(results),
        "success": sum(1 for r in results if r.get("status") == "success"),
        "needs_review": sum(1 for r in results if r.get("needs_review")),
        "results": results,
    }


# ─── Hijack Alerts ────────────────────────────────────────────────────────────

@app.get("/api/hijack-alerts")
async def list_hijack_alerts(
    resolved: bool = Query(False),
    product_id: Optional[int] = Query(None),
    limit: int = Query(50, le=200),
):
    base = """SELECT ha.*, p.asin_or_sku, p.platform, p.title_known
              FROM hijack_alerts ha
              JOIN products p ON p.id=ha.product_id"""
    if product_id:
        rows = query(
            f"{base} WHERE ha.product_id=$1 AND ha.resolved=$2 ORDER BY ha.detected_at DESC LIMIT $3",
            [product_id, resolved, limit],
        )
    else:
        rows = query(
            f"{base} WHERE ha.resolved=$1 ORDER BY ha.detected_at DESC LIMIT $2",
            [resolved, limit],
        )
    return rows


class HijackResolve(BaseModel):
    id: int


@app.patch("/api/hijack-alerts")
async def resolve_hijack(body: HijackResolve):
    row = query_one(
        "UPDATE hijack_alerts SET resolved=true, resolved_at=NOW() WHERE id=$1 RETURNING *",
        [body.id],
    )
    if not row:
        raise HTTPException(404, "Alert not found")
    return row


# ─── Battleground ─────────────────────────────────────────────────────────────

@app.get("/api/battleground")
async def battleground(since: str = Query("7d")):
    interval = map_interval(since)
    rows = query(
        f"""WITH latest AS (
          SELECT DISTINCT ON (s.product_id) s.product_id, s.payload_json, s.fetched_at
          FROM snapshots s ORDER BY s.product_id, s.fetched_at DESC
        ),
        prod AS (
          SELECT p.id, p.pool_id, p.is_own,
            NULLIF(l.payload_json->>'price','')::numeric AS price,
            NULLIF(l.payload_json->>'rating','')::numeric AS rating,
            NULLIF(l.payload_json->>'reviewCount','')::int AS review_count,
            l.payload_json->'offers'->>'availability' AS availability,
            COALESCE((l.payload_json->'seo'->>'hasAPlus')::boolean, false) AS has_aplus,
            NULLIF(l.payload_json->'seo'->>'bulletCount','')::int AS bullet_count,
            NULLIF(l.payload_json->'seo'->>'imageCount','')::int AS image_count,
            l.fetched_at
          FROM products p LEFT JOIN latest l ON l.product_id=p.id WHERE p.pool_id IS NOT NULL
        ),
        pool_agg AS (
          SELECT pr.pool_id,
            COUNT(*)::int AS product_count, AVG(pr.price)::numeric AS avg_price,
            AVG(pr.rating)::numeric AS avg_rating, SUM(pr.review_count)::bigint AS total_reviews,
            SUM(CASE WHEN LOWER(COALESCE(pr.availability,'')) LIKE '%in stock%' THEN 1 ELSE 0 END)::int AS in_stock_count,
            SUM(CASE WHEN pr.has_aplus THEN 1 ELSE 0 END)::int AS aplus_count,
            AVG(pr.bullet_count)::numeric AS avg_bullet_count,
            AVG(pr.image_count)::numeric AS avg_image_count,
            MAX(pr.fetched_at) AS latest_fetched_at, BOOL_OR(pr.is_own) AS is_own_pool
          FROM prod pr GROUP BY pr.pool_id
        ),
        change_agg AS (
          SELECT p.pool_id, COUNT(*)::int AS change_count,
            SUM(CASE WHEN c.field='price' AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
              < NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric THEN 1 ELSE 0 END)::int AS price_drops,
            SUM(CASE WHEN c.field='price' AND NULLIF(regexp_replace(c.new_value,'[^0-9.]','','g'),'')::numeric
              > NULLIF(regexp_replace(c.old_value,'[^0-9.]','','g'),'')::numeric THEN 1 ELSE 0 END)::int AS price_hikes,
            SUM(CASE WHEN c.field='rating' AND NULLIF(c.new_value,'')::numeric > NULLIF(c.old_value,'')::numeric THEN 1 ELSE 0 END)::int AS rating_improved,
            SUM(CASE WHEN c.field='rating' AND NULLIF(c.new_value,'')::numeric < NULLIF(c.old_value,'')::numeric THEN 1 ELSE 0 END)::int AS rating_dropped,
            SUM(CASE WHEN c.field='bsr' THEN 1 ELSE 0 END)::int AS bsr_improved,
            0::int AS bsr_dropped
          FROM changes c JOIN products p ON p.id=c.product_id
          WHERE c.detected_at>=now()-'{interval}'::interval AND p.pool_id IS NOT NULL
          GROUP BY p.pool_id
        )
        SELECT pl.id AS pool_id, pl.name AS pool_name,
          pa.product_count, pa.avg_price, pa.avg_rating, pa.total_reviews,
          pa.in_stock_count, pa.aplus_count, pa.avg_bullet_count, pa.avg_image_count,
          pa.latest_fetched_at, pa.is_own_pool,
          COALESCE(ca.change_count,0) AS change_count,
          COALESCE(ca.price_drops,0) AS price_drops, COALESCE(ca.price_hikes,0) AS price_hikes,
          COALESCE(ca.rating_improved,0) AS rating_improved, COALESCE(ca.rating_dropped,0) AS rating_dropped,
          COALESCE(ca.bsr_improved,0) AS bsr_improved, COALESCE(ca.bsr_dropped,0) AS bsr_dropped
        FROM pools pl
        JOIN pool_agg pa ON pa.pool_id=pl.id
        LEFT JOIN change_agg ca ON ca.pool_id=pl.id
        ORDER BY pl.name""",
        [],
    )
    return rows


# ─── AI Endpoints ─────────────────────────────────────────────────────────────

@app.post("/api/ai/cohorts")
async def ai_cohorts(request: Request):
    body = await request.json()
    products = body.get("products") or []
    if not products:
        products = query(
            """SELECT p.id, p.platform, p.asin_or_sku, p.title_known, p.url, p.pool_id, p.is_own,
                 s.payload_json->>'title' AS title,
                 (s.payload_json->>'price')::numeric AS price,
                 (s.payload_json->>'rating')::numeric AS rating
               FROM products p
               LEFT JOIN LATERAL (
                 SELECT payload_json FROM snapshots WHERE product_id=p.id ORDER BY fetched_at DESC LIMIT 1
               ) s ON true ORDER BY p.id"""
        )

    if not products:
        return {"cohorts": [], "message": "No products"}

    api_key = os.getenv("OPENROUTER_API_KEY", "")
    model = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

    if not api_key or api_key == "sk-or-v1-xxxx":
        # Mock grouping
        own = [p for p in products if p.get("is_own")]
        comp = [p for p in products if not p.get("is_own")]
        return {
            "cohorts": [{"name": "All Books", "rationale": "Default grouping", "own_ids": [p["id"] for p in own[:5]], "competitor_ids": [p["id"] for p in comp[:5]]}],
            "mock": True,
        }

    lines = "\n".join(
        f"ID={p['id']} | {'[OWN]' if p.get('is_own') else '[COMP]'} | {p.get('title') or p.get('title_known') or p.get('asin_or_sku')} | ₹{p.get('price') or '?'}"
        for p in products
    )

    content = await call_openrouter(
        [
            {"role": "system", "content": "You are a book market intelligence expert. Group books into Price Watch cohorts pairing OWN books with competing books in the same genre/subject/audience. Return ONLY valid JSON: {\"cohorts\":[{\"name\":\"...\",\"rationale\":\"...\",\"own_ids\":[],\"competitor_ids\":[]}]}"},
            {"role": "user", "content": f"Books:\n{lines}"},
        ],
        model,
    )
    parsed = parse_json_from_text(content)
    return {"cohorts": parsed.get("cohorts", []), "model": model}


@app.post("/api/ai/summary")
async def ai_summary(request: Request):
    body = await request.json()
    since = body.get("since", "24h")
    pool_id = body.get("poolId")
    interval = map_interval(since)
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    model = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

    base = """SELECT c.id, c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
              p.asin_or_sku, p.is_own, p.title_known, p.pool_id,
              pl.name AS pool_name,
              (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id=p.id ORDER BY s.fetched_at DESC LIMIT 1) AS product_title
       FROM changes c JOIN products p ON p.id=c.product_id LEFT JOIN pools pl ON pl.id=p.pool_id"""

    if pool_id:
        changes = query(f"{base} WHERE p.pool_id=$1 AND c.detected_at>=now()-$2::interval ORDER BY c.detected_at DESC LIMIT 200", [pool_id, interval])
    else:
        changes = query(f"{base} WHERE c.detected_at>=now()-$1::interval ORDER BY c.detected_at DESC LIMIT 200", [interval])

    if not changes:
        return {"summary": "No changes detected.", "highlights": [], "risks": [], "actions": [], "model": model, "generatedAt": datetime.utcnow().isoformat()}

    lines = "\n".join(
        f"{'YOUR' if c.get('is_own') else 'COMP'} | {c.get('product_title') or c.get('title_known') or c.get('asin_or_sku')} | {c['field']}: {c['old_value']} → {c['new_value']}"
        for c in changes[:100]
    )

    if not api_key or api_key == "sk-or-v1-xxxx":
        return {"summary": f"{len(changes)} changes detected.", "highlights": [], "risks": [], "actions": [], "model": "mock", "generatedAt": datetime.utcnow().isoformat()}

    content = await call_openrouter(
        [
            {"role": "system", "content": "You are a market intelligence assistant. Analyse these Amazon listing changes and return JSON: {\"summary\":\"...\",\"highlights\":[],\"risks\":[],\"actions\":[],\"watchlist\":[]}"},
            {"role": "user", "content": lines},
        ],
        model,
    )
    parsed = parse_json_from_text(content)
    parsed["model"] = model
    parsed["generatedAt"] = datetime.utcnow().isoformat()
    parsed["changesAnalyzed"] = len(changes)
    return parsed


@app.post("/api/ai/battleground")
async def ai_battleground(request: Request):
    body = await request.json()
    since = body.get("since", "7d")
    cohorts = body.get("cohorts", [])
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    model = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

    if not cohorts:
        return {"headline": "No cohort data provided.", "wins": [], "gaps": [], "moves": [], "watch": [], "model": model}

    summary_lines = []
    for cg in cohorts:
        pw = cg.get("pw")
        if pw:
            summary_lines.append(f"[OWN:{pw.get('pool_name')}] avg_price={pw.get('avg_price')} avg_rating={pw.get('avg_rating')} total_reviews={pw.get('total_reviews')}")
        for comp in cg.get("competitors", []):
            summary_lines.append(f"[COMP:{comp.get('pool_name')}] avg_price={comp.get('avg_price')} avg_rating={comp.get('avg_rating')} total_reviews={comp.get('total_reviews')}")

    if not api_key or api_key == "sk-or-v1-xxxx":
        return {"headline": "AI not configured.", "wins": [], "gaps": [], "moves": [], "watch": [], "model": "mock"}

    content = await call_openrouter(
        [
            {"role": "system", "content": "You are a competitive intelligence analyst. Return JSON: {\"headline\":\"...(≤28 words)\",\"wins\":[\"3-5 wins\"],\"gaps\":[\"3-5 gaps\"],\"moves\":[\"3-5 tactical moves\"],\"watch\":[\"2-4 signals\"]}"},
            {"role": "user", "content": "\n".join(summary_lines)},
        ],
        model,
    )
    parsed = parse_json_from_text(content)
    parsed["model"] = model
    return parsed


# ─── Snapshots panel ──────────────────────────────────────────────────────────
#
# The Snapshots panel shows hourly page-screenshots for ~20-40 PW SKUs. The
# heavy lifting (Playwright + residential proxy + retries) lives in
# ``snapshot_scraper.py`` — these endpoints are thin glue.

def _snapshot_targets(limit: int) -> list[dict]:
    """Resolve the SKUs the Snapshots panel should track.

    Defaults to PW-owned Amazon SKUs (`is_own=true`), ordered by id, capped at
    `limit`. This matches the curated card grid the team asked for and keeps
    the hourly browser load to a predictable ceiling.
    """
    return list(query(
        "SELECT id, asin_or_sku, url, title_known FROM products"
        " WHERE platform='amazon' AND is_own=true"
        " ORDER BY id LIMIT $1",
        [limit],
    ))


@app.get("/api/snapshots")
async def list_snapshots(limit: int = Query(40, ge=1, le=200)):
    """Latest snapshot per tracked SKU (metadata only — images are served separately).

    The image bytes column is intentionally excluded from the JSON payload so
    the page load stays light. Use ``GET /api/snapshots/{product_id}/image``
    to stream the JPEG with proper caching headers.
    """
    snapshot_scraper.ensure_table()
    rows = query(
        """SELECT p.id AS product_id, p.asin_or_sku, p.url, p.title_known,
                  p.is_own, p.pool_id,
                  ps.id AS snapshot_id, ps.title, ps.price, ps.mrp,
                  ps.stock_status, ps.stock_message, ps.status, ps.error,
                  ps.width, ps.height, ps.fetched_at,
                  (octet_length(ps.image_bytes)) AS image_size
             FROM products p
             LEFT JOIN LATERAL (
               SELECT * FROM page_snapshots
                WHERE product_id=p.id AND status='ok'
                ORDER BY fetched_at DESC LIMIT 1
             ) ps ON TRUE
            WHERE p.platform='amazon' AND p.is_own=true
            ORDER BY p.id LIMIT $1""",
        [limit],
    )
    return {"items": rows, "count": len(rows)}


@app.get("/api/snapshots/{product_id}/image")
async def get_snapshot_image(product_id: int):
    """Serve the latest successful JPEG for a product."""
    snapshot_scraper.ensure_table()
    row = query_one(
        "SELECT image_bytes, image_mime, fetched_at FROM page_snapshots"
        " WHERE product_id=$1 AND status='ok'"
        " ORDER BY fetched_at DESC LIMIT 1",
        [product_id],
    )
    if not row or not row.get("image_bytes"):
        raise HTTPException(404, "No snapshot yet for this product")
    payload = bytes(row["image_bytes"])
    return Response(
        content=payload,
        media_type=row.get("image_mime") or "image/jpeg",
        headers={
            # Short cache — UI polls latest; we don't want stale screenshots
            # to outlive the hourly cron.
            "Cache-Control": "public, max-age=60",
            "X-Snapshot-Captured-At": (row.get("fetched_at") or datetime.utcnow()).isoformat()
                if row.get("fetched_at") else "",
        },
    )


@app.post("/api/snapshots/refresh/{product_id}")
async def refresh_single_snapshot(product_id: int):
    """Refresh one product's screenshot on demand (UI 'Refresh' button)."""
    snapshot_scraper.ensure_table()
    product = query_one(
        "SELECT id, asin_or_sku, url, title_known FROM products"
        " WHERE id=$1 AND platform='amazon'",
        [product_id],
    )
    if not product:
        raise HTTPException(404, "Product not found (or not Amazon)")
    return await snapshot_scraper.refresh_one(product)


@app.post("/api/snapshots/refresh-all")
async def refresh_all_snapshots(limit: int = Query(40, ge=1, le=200)):
    """SSE-streamed bulk refresh for the Snapshots panel."""
    snapshot_scraper.ensure_table()
    rows = _snapshot_targets(limit)

    async def generate():
        total = len(rows)
        yield f"data: {json.dumps({'total': total, 'done': 0, 'started': True})}\n\n"
        if not rows:
            yield f"data: {json.dumps({'done': 0, 'total': 0, 'finished': True})}\n\n"
            return

        done = ok = err = 0
        for product in rows:
            try:
                result = await snapshot_scraper.refresh_one(product)
            except Exception as exc:  # noqa: BLE001
                result = {"productId": product["id"], "asin": product.get("asin_or_sku"),
                          "status": "error", "error": str(exc)}
            done += 1
            if result.get("status") == "ok":
                ok += 1
            else:
                err += 1
            yield f"data: {json.dumps({'done': done, 'total': total, **result})}\n\n"

        yield f"data: {json.dumps({'done': total, 'total': total, 'finished': True, 'ok': ok, 'errors': err})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Cron ─────────────────────────────────────────────────────────────────────

@app.post("/api/cron/daily")
@app.get("/api/cron/daily")
async def cron_daily(request: Request):
    """Consolidated daily refresh.

    Replaces the old `/api/cron/monitor` + `/api/cron/sellers-refresh` pair.
    One BrightData batch per dataset captures the product + seller landscape
    for every Amazon SKU in the catalogue, with MRP/price/discount validated
    by `pw_scraper.validate` before anything hits the database.

    Auth: Bearer $CRON_SECRET.
    """
    cron_secret = os.getenv("CRON_SECRET", "")
    auth = request.headers.get("authorization", "").replace("Bearer ", "")
    if cron_secret and auth != cron_secret:
        raise HTTPException(401, "Unauthorized")

    products = query(
        "SELECT id, platform, asin_or_sku, url FROM products"
        " WHERE platform = 'amazon' ORDER BY id"
    )
    if not products:
        return {"processed": 0, "results": [], "message": "no products to scrape"}

    scraped = await scrape_skus(list(products))
    results = [_save_with_diff(sku) for sku in scraped]

    success = [r for r in results if r.get("status") == "success"]
    needs_review = [r for r in results if r.get("needs_review")]
    skipped = [r for r in results if r.get("status") == "skipped_empty"]

    return {
        "processed": len(results),
        "success": len(success),
        "skipped_empty": len(skipped),
        "needs_review": [r["productId"] for r in needs_review],
        "total_changes": sum(int(r.get("changes") or 0) for r in results),
        "brightdata_configured": brightdata_configured(),
        "results": results,
    }


# Legacy alias — older cron jobs that still point at /api/cron/monitor keep working.
@app.post("/api/cron/monitor")
@app.get("/api/cron/monitor")
async def cron_monitor_legacy(request: Request):
    return await cron_daily(request)


@app.post("/api/cron/snapshots")
@app.get("/api/cron/snapshots")
async def cron_snapshots(request: Request, limit: int = Query(40, ge=1, le=200)):
    """Hourly page-screenshot refresh for the Snapshots panel.

    Auth: Bearer $CRON_SECRET. Drives Playwright via the BrightData
    residential proxy (PROXY_URL) so Amazon's bot wall stays friendly.
    """
    cron_secret = os.getenv("CRON_SECRET", "")
    auth = request.headers.get("authorization", "").replace("Bearer ", "")
    if cron_secret and auth != cron_secret:
        raise HTTPException(401, "Unauthorized")

    snapshot_scraper.ensure_table()
    targets = _snapshot_targets(limit)
    if not targets:
        return {"processed": 0, "results": [], "message": "no snapshot targets configured"}

    results = await snapshot_scraper.refresh_many(targets)
    ok = [r for r in results if r.get("status") == "ok"]
    errors = [r for r in results if r.get("status") != "ok"]
    return {
        "processed": len(results),
        "ok": len(ok),
        "errors": [{"asin": r.get("asin"), "error": r.get("error")} for r in errors],
        "results": results,
    }


# ─── Executive Report ─────────────────────────────────────────────────────────

# In-memory cache: { (since, brief): (timestamp, payload) }
_REPORT_CACHE: dict[tuple, tuple[float, dict]] = {}
_REPORT_TTL_SECONDS = 1800  # 30 min

PW_SELLER_HINTS = ("pw", "physics wallah", "physicswallah", "pearson schoolhouse", "pearson school")


def _is_pw_seller(name: Optional[str]) -> bool:
    if not name:
        return False
    n = name.lower()
    return any(h in n for h in PW_SELLER_HINTS)


def _brand_from_pool(pool_name: Optional[str]) -> str:
    if not pool_name:
        return "Other"
    return pool_name.split(" - ")[0].strip()


def _cohort_from_pool(pool_name: Optional[str]) -> str:
    if not pool_name or " - " not in pool_name:
        return pool_name or "Other"
    return pool_name.split(" - ", 1)[1].strip()


def _safe_num(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("₹", "").strip())
    except (ValueError, TypeError):
        return None


def _bsr_to_int(raw) -> Optional[int]:
    if not raw:
        return None
    m = re.search(r"#?\s*([\d,]+)", str(raw))
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


async def _build_ai_summary(headline: dict, movements: list[dict], battleground: list[dict]) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key or api_key == "sk-or-v1-xxxx":
        return ""
    try:
        # Compact context — at most ~25 lines so token cost is bounded
        top_moves = movements[:12]
        move_lines = [
            f"- {m['brand']} · {m['title'][:60]} · {m['label']}: {m['summary']}"
            for m in top_moves
        ]
        bg_lines = []
        for b in battleground:
            cohort = b["cohort"]
            for entry in b.get("brands", []):
                bg_lines.append(
                    f"- [{cohort}] {entry['brand']} · price ₹{entry.get('avgPrice') or '?'} · BSR avg {entry.get('avgBsr') or '?'}"
                )
        prompt = (
            "You are PW's market-intelligence analyst. Write a 3-bullet executive briefing for leadership "
            "based on the data below. Each bullet ≤ 22 words, action-oriented, name the brand and the SKU/cohort. "
            "Return JSON: {\"bullets\":[\"...\",\"...\",\"...\"]}\n\n"
            f"Headline: {json.dumps(headline)}\n\n"
            f"Top movements:\n" + "\n".join(move_lines) + "\n\n"
            f"Cohort battleground:\n" + "\n".join(bg_lines[:30])
        )
        content = await call_openrouter([
            {"role": "system", "content": "You are a precise market-intelligence analyst. Return only valid JSON."},
            {"role": "user", "content": prompt},
        ])
        parsed = parse_json_from_text(content)
        bullets = parsed.get("bullets") if isinstance(parsed, dict) else None
        if isinstance(bullets, list):
            return "\n".join(str(b) for b in bullets[:3])
        return str(content)[:600]
    except Exception:
        return ""


def _change_label(field: str) -> tuple[str, str]:
    """Return (category, ui_label) for a change field."""
    if field == "price":
        return ("price", "Price")
    if field in ("offers.bsr", "offers.bestSellerRank", "bsr"):
        return ("bsr", "BSR")
    if field == "title":
        return ("content", "Title")
    if field == "description":
        return ("content", "Description")
    if field == "rating":
        return ("rating", "Rating")
    if field == "reviewCount":
        return ("reviews", "Reviews")
    return ("other", field)


def _movement_score(field: str, old_value: str, new_value: str) -> tuple[float, str, str]:
    """Score impact 0..100 + tone + summary."""
    if field == "price":
        op, np_ = _safe_num(old_value), _safe_num(new_value)
        if op and np_ and op > 0:
            pct = (np_ - op) / op * 100
            tone = "green" if pct < 0 else "red"
            return (min(100, abs(pct) * 4), tone, f"₹{int(op)} → ₹{int(np_)} ({pct:+.1f}%)")
    if field in ("offers.bsr", "offers.bestSellerRank", "bsr"):
        ob, nb = _bsr_to_int(old_value), _bsr_to_int(new_value)
        if ob and nb:
            tone = "green" if nb < ob else "red"
            delta = ob - nb
            pct = abs(delta) / max(ob, 1) * 100
            return (min(100, pct * 1.5), tone, f"#{ob:,} → #{nb:,}")
    if field == "title":
        return (40, "amber", f"{(old_value or '')[:40]} → {(new_value or '')[:40]}")
    if field == "description":
        return (25, "blue", f"description rewritten ({len(new_value or '') - len(old_value or '')} chars)")
    if field == "rating":
        return (15, "blue", f"{old_value} → {new_value}")
    if field == "reviewCount":
        return (10, "blue", f"{old_value} → {new_value}")
    return (5, "gray", f"{(old_value or '')[:30]} → {(new_value or '')[:30]}")


@app.get("/api/report")
async def report(
    since: str = Query("24h"),
    refresh: bool = Query(False),
    brief: bool = Query(False),
):
    """Executive briefing payload — headline, movements, battleground, hijacks, trends, AI summary."""
    cache_key = (since, brief)
    now = time.time()
    if not refresh and cache_key in _REPORT_CACHE:
        ts, cached = _REPORT_CACHE[cache_key]
        if now - ts < _REPORT_TTL_SECONDS:
            return {**cached, "cached": True, "cacheAge": int(now - ts)}

    interval = map_interval(since)

    # ── HEADLINE ──────────────────────────────────────────────────────────────
    pw_count = query_one("SELECT COUNT(*) AS n FROM products WHERE is_own=true")
    comp_count = query_one("SELECT COUNT(*) AS n FROM products WHERE is_own=false OR is_own IS NULL")
    movements_n = query_one(
        f"SELECT COUNT(DISTINCT product_id) AS n FROM changes WHERE detected_at > NOW() - INTERVAL '{interval}'"
    )
    hijacks_n = query_one(
        "SELECT COUNT(*) AS n FROM hijack_alerts WHERE resolved=false"
    )

    headline = {
        "pwCount": int(pw_count["n"] if pw_count else 0),
        "competitorCount": int(comp_count["n"] if comp_count else 0),
        "movements": int(movements_n["n"] if movements_n else 0),
        "hijacksActive": int(hijacks_n["n"] if hijacks_n else 0),
        "since": since,
    }

    # ── MOVEMENTS (last N) ────────────────────────────────────────────────────
    raw_changes = query(
        f"""SELECT c.product_id, c.field, c.old_value, c.new_value, c.detected_at,
                   p.asin_or_sku, p.is_own, p.url, p.title_known, p.pool_id,
                   pl.name AS pool_name,
                   (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id=p.id ORDER BY s.fetched_at DESC LIMIT 1) AS title
            FROM changes c
            JOIN products p ON p.id=c.product_id
            LEFT JOIN pools pl ON pl.id=p.pool_id
            WHERE c.detected_at > NOW() - INTERVAL '{interval}'
              AND (c.old_value IS NOT NULL AND c.old_value <> '' AND c.old_value <> '—')
            ORDER BY c.detected_at DESC
            LIMIT 200""",
        [],
    )

    movements = []
    for r in raw_changes:
        cat, label = _change_label(r["field"])
        score, tone, summary = _movement_score(r["field"], r["old_value"] or "", r["new_value"] or "")
        movements.append({
            "productId": r["product_id"],
            "asin": r["asin_or_sku"],
            "url": r["url"],
            "title": r["title"] or r["title_known"] or r["asin_or_sku"],
            "brand": "PW" if r["is_own"] else _brand_from_pool(r["pool_name"]),
            "isOwn": bool(r["is_own"]),
            "cohort": _cohort_from_pool(r["pool_name"]),
            "field": r["field"],
            "category": cat,
            "label": label,
            "summary": summary,
            "tone": tone,
            "score": round(score, 1),
            "detectedAt": r["detected_at"].isoformat() if r["detected_at"] else None,
        })
    movements.sort(key=lambda m: (-m["score"], m["detectedAt"] or ""))
    movements = movements[:60]

    # ── COHORT BATTLEGROUND ───────────────────────────────────────────────────
    snapshots_now = query(
        """SELECT p.id, p.is_own, p.pool_id, pl.name AS pool_name,
                  s.payload_json AS payload
           FROM products p
           LEFT JOIN pools pl ON pl.id=p.pool_id
           LEFT JOIN LATERAL (
             SELECT payload_json FROM snapshots WHERE product_id=p.id ORDER BY fetched_at DESC LIMIT 1
           ) s ON true
           WHERE pl.id IS NOT NULL"""
    )

    # group by cohort -> brand
    bg_map: dict[str, dict[str, list]] = {}
    for r in snapshots_now:
        if not r["pool_name"]:
            continue
        cohort = _cohort_from_pool(r["pool_name"])
        brand = "PW" if r["is_own"] else _brand_from_pool(r["pool_name"])
        bg_map.setdefault(cohort, {}).setdefault(brand, []).append(r)

    battleground_out = []
    for cohort, brand_map in bg_map.items():
        entries = []
        for brand, prods in brand_map.items():
            prices, bsrs = [], []
            for p in prods:
                pl = p["payload"] or {}
                if isinstance(pl, str):
                    try:
                        pl = json.loads(pl)
                    except Exception:
                        pl = {}
                pr = _safe_num(pl.get("price"))
                if pr:
                    prices.append(pr)
                br = _bsr_to_int(pl.get("bsr"))
                if br:
                    bsrs.append(br)
            entries.append({
                "brand": brand,
                "skuCount": len(prods),
                "avgPrice": round(sum(prices) / len(prices)) if prices else None,
                "minPrice": round(min(prices)) if prices else None,
                "avgBsr": round(sum(bsrs) / len(bsrs)) if bsrs else None,
            })
        # Sort PW first, then by avg price asc
        entries.sort(key=lambda e: (0 if e["brand"] == "PW" else 1, e["avgPrice"] or 9999999))
        # Verdict: simple PW vs cheapest competitor
        pw = next((e for e in entries if e["brand"] == "PW"), None)
        comps = [e for e in entries if e["brand"] != "PW" and e["avgPrice"] is not None]
        verdict = ""
        if pw and pw.get("avgPrice") and comps:
            cheapest = min(comps, key=lambda e: e["avgPrice"])
            diff = pw["avgPrice"] - cheapest["avgPrice"]
            if diff > 0:
                verdict = f"PW priced ₹{diff:.0f} above {cheapest['brand']} (avg)."
            elif diff < 0:
                verdict = f"PW priced ₹{abs(diff):.0f} below {cheapest['brand']} (avg)."
            else:
                verdict = f"PW matched with {cheapest['brand']}."
        battleground_out.append({
            "cohort": cohort,
            "brands": entries,
            "verdict": verdict,
        })
    battleground_out.sort(key=lambda b: b["cohort"])

    # ── HIJACK & BUYBOX HEALTH (PW only) ──────────────────────────────────────
    hijack_rows = query(
        """SELECT p.id, p.asin_or_sku, p.url,
                  (SELECT s.payload_json->>'title' FROM snapshots s WHERE s.product_id=p.id ORDER BY s.fetched_at DESC LIMIT 1) AS title,
                  (SELECT (s.payload_json->>'price')::numeric FROM snapshots s WHERE s.product_id=p.id ORDER BY s.fetched_at DESC LIMIT 1) AS pw_price,
                  (SELECT json_agg(so.* ORDER BY so.price ASC NULLS LAST)
                   FROM (SELECT seller_name, price, is_fba FROM seller_offers WHERE product_id=p.id ORDER BY fetched_at DESC LIMIT 30) so
                  ) AS sellers
           FROM products p
           WHERE p.is_own=true AND p.platform='amazon'
           ORDER BY p.id"""
    )

    hijacks = []
    for r in hijack_rows:
        sellers = r["sellers"] or []
        if isinstance(sellers, str):
            try:
                sellers = json.loads(sellers)
            except Exception:
                sellers = []
        if not sellers:
            continue
        # Buybox = first seller (sorted by price ASC). Hijack = buybox not PW.
        buybox = sellers[0] if sellers else None
        buybox_name = buybox.get("seller_name") if buybox else None
        is_pw_buybox = _is_pw_seller(buybox_name)
        # Lowest competitor (non-PW)
        non_pw = [s for s in sellers if not _is_pw_seller(s.get("seller_name"))]
        lowest_comp = min(non_pw, key=lambda s: s.get("price") or 1e9) if non_pw else None
        pw_price = float(r["pw_price"]) if r["pw_price"] is not None else None
        comp_price = float(lowest_comp["price"]) if lowest_comp and lowest_comp.get("price") is not None else None
        undercut = (pw_price - comp_price) if (pw_price is not None and comp_price is not None) else None
        hijacks.append({
            "productId": r["id"],
            "asin": r["asin_or_sku"],
            "url": r["url"],
            "title": r["title"] or r["asin_or_sku"],
            "buyboxSeller": buybox_name,
            "buyboxPrice": float(buybox["price"]) if buybox and buybox.get("price") is not None else None,
            "isPwBuybox": is_pw_buybox,
            "sellerCount": len(sellers),
            "lowestCompetitor": lowest_comp.get("seller_name") if lowest_comp else None,
            "lowestCompetitorPrice": comp_price,
            "pwPrice": pw_price,
            "undercutBy": undercut,
            "severity": (
                "high" if (not is_pw_buybox) or (undercut is not None and undercut > 0)
                else "ok"
            ),
        })
    # High severity first
    hijacks.sort(key=lambda h: (0 if h["severity"] == "high" else 1, -(h.get("undercutBy") or 0)))

    # ── TRENDS (30-day) ───────────────────────────────────────────────────────
    trend_rows = query(
        """SELECT date_trunc('day', s.fetched_at) AS d,
                  p.is_own,
                  AVG((s.payload_json->>'price')::numeric) FILTER (WHERE (s.payload_json->>'price') ~ '^[0-9.]+$') AS avg_price
           FROM snapshots s
           JOIN products p ON p.id=s.product_id
           WHERE s.fetched_at > NOW() - INTERVAL '30 days'
           GROUP BY d, p.is_own
           ORDER BY d ASC"""
    )
    pw_price_series, comp_price_series = [], []
    for r in trend_rows:
        d = r["d"].date().isoformat() if r["d"] else None
        if d is None:
            continue
        if r["is_own"]:
            pw_price_series.append({"date": d, "value": float(r["avg_price"]) if r["avg_price"] is not None else None})
        else:
            comp_price_series.append({"date": d, "value": float(r["avg_price"]) if r["avg_price"] is not None else None})

    changes_per_day = query(
        """SELECT date_trunc('day', detected_at) AS d, COUNT(*) AS n
           FROM changes
           WHERE detected_at > NOW() - INTERVAL '30 days'
           GROUP BY d ORDER BY d ASC"""
    )
    activity_series = [
        {"date": r["d"].date().isoformat(), "value": int(r["n"])}
        for r in changes_per_day if r["d"]
    ]

    trends = {
        "pwPrice": pw_price_series,
        "competitorPrice": comp_price_series,
        "activity": activity_series,
    }

    # ── AI SUMMARY ───────────────────────────────────────────────────────────
    ai_bullets = ""
    if not brief:
        ai_bullets = await _build_ai_summary(headline, movements, battleground_out)

    payload = {
        "headline": headline,
        "movements": movements,
        "battleground": battleground_out,
        "hijacks": hijacks,
        "trends": trends,
        "aiSummary": ai_bullets,
        "generatedAt": time.time(),
        "cached": False,
        "cacheAge": 0,
    }
    _REPORT_CACHE[cache_key] = (now, payload)
    return payload


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
