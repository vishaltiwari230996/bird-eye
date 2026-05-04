"""main.py — Bird Eye FastAPI backend."""
import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from typing import Any, Optional

# Windows + Python 3.14 + Playwright requires the Proactor event loop for subprocesses.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()

from database import query, query_one, transaction
from scraper import scrape_offer_listings, scrape_product

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


def hash_payload(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


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


@app.post("/api/products/{product_id}/sellers")
async def refresh_sellers(product_id: int):
    product = query_one("SELECT * FROM products WHERE id=$1", [product_id])
    if not product:
        raise HTTPException(404, "Product not found")
    if product["platform"] != "amazon":
        raise HTTPException(400, "Seller scraping is only supported for Amazon")

    listings = await scrape_offer_listings(product["asin_or_sku"])

    if listings:
        query("DELETE FROM seller_offers WHERE product_id=$1", [product_id])
        for s in listings:
            query(
                "INSERT INTO seller_offers (product_id,seller_name,price,condition,is_fba,prime_eligible,fetched_at)"
                " VALUES ($1,$2,$3,$4,$5,$6,NOW())",
                [product_id, s["seller_name"], s["price"], s["condition"], s["is_fba"], s["prime_eligible"]],
            )

    return {"count": len(listings), "sellers": listings}


@app.post("/api/sellers/refresh-all")
async def refresh_all_sellers():
    """SSE-streaming bulk seller refresh — PW own products only."""
    rows = query(
        "SELECT id, asin_or_sku FROM products WHERE platform='amazon' AND is_own=true ORDER BY id"
    )

    async def generate():
        total = len(rows)
        yield f"data: {json.dumps({'total': total, 'done': 0, 'started': True})}\n\n"

        for i, row in enumerate(rows):
            product_id, asin = row["id"], row["asin_or_sku"]
            try:
                listings = await scrape_offer_listings(asin)
                if listings:
                    query("DELETE FROM seller_offers WHERE product_id=$1", [product_id])
                    for s in listings:
                        query(
                            "INSERT INTO seller_offers (product_id,seller_name,price,condition,is_fba,prime_eligible,fetched_at)"
                            " VALUES ($1,$2,$3,$4,$5,$6,NOW())",
                            [product_id, s["seller_name"], s["price"], s["condition"], s["is_fba"], s["prime_eligible"]],
                        )
                yield f"data: {json.dumps({'done': i+1, 'total': total, 'productId': product_id, 'asin': asin, 'count': len(listings)})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'done': i+1, 'total': total, 'productId': product_id, 'asin': asin, 'count': 0, 'error': str(e)})}\n\n"

            if i < len(rows) - 1:
                await asyncio.sleep(1.5)

        yield f"data: {json.dumps({'done': total, 'total': total, 'finished': True})}\n\n"

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


@app.post("/api/run-check")
async def run_check(body: RunCheckBody, request: Request):
    # Auth check
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
            "SELECT id, platform, asin_or_sku, url, title_known FROM products WHERE id=$1",
            [body.productId],
        )
    else:
        offset = body.batch * BATCH_SIZE
        products = query(
            "SELECT id, platform, asin_or_sku, url, title_known FROM products ORDER BY id LIMIT $1 OFFSET $2",
            [BATCH_SIZE, offset],
        )

    if not products:
        return {"message": "No products found", "batch": body.batch}

    results = []
    for product in products:
        pid = product["id"]
        asin = product["asin_or_sku"]
        url = product["url"]
        try:
            payload = await scrape_product(asin, url)
            if not payload:
                results.append({"productId": pid, "status": "blocked", "changes": 0})
                continue

            # Save snapshot
            payload_json = json.dumps(payload)
            h = hash_payload(payload)
            last_snap = query_one(
                "SELECT hash, payload_json FROM snapshots WHERE product_id=$1 ORDER BY fetched_at DESC LIMIT 1",
                [pid],
            )
            query(
                "INSERT INTO snapshots (product_id, payload_json, hash, fetched_at) VALUES ($1,$2::jsonb,$3,NOW())",
                [pid, payload_json, h],
            )
            query("UPDATE products SET last_seen_at=NOW() WHERE id=$1", [pid])

            # Diff
            change_count = 0
            if last_snap and last_snap["hash"] != h:
                prev = last_snap["payload_json"]
                if isinstance(prev, str):
                    prev = json.loads(prev)
                field_changes = diff_payloads(prev, payload)
                for fc in field_changes:
                    query(
                        "INSERT INTO changes (product_id, field, old_value, new_value, detected_at) VALUES ($1,$2,$3,$4,NOW())",
                        [pid, fc["field"], fc["old_value"], fc["new_value"]],
                    )
                change_count = len(field_changes)

            results.append({"productId": pid, "status": "success", "changes": change_count})
        except Exception as e:
            results.append({"productId": pid, "status": "error", "changes": 0, "error": str(e)})

    return {
        "batch": body.batch,
        "processed": len(results),
        "success": sum(1 for r in results if r["status"] == "success"),
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


# ─── Cron ─────────────────────────────────────────────────────────────────────

@app.post("/api/cron/monitor")
@app.get("/api/cron/monitor")
async def cron_monitor(request: Request):
    cron_secret = os.getenv("CRON_SECRET", "")
    auth = request.headers.get("authorization", "").replace("Bearer ", "")
    if cron_secret and auth != cron_secret:
        raise HTTPException(401, "Unauthorized")
    products = query("SELECT id, platform, asin_or_sku, url FROM products ORDER BY id")
    results = []
    for product in products:
        pid = product["id"]
        try:
            payload = await scrape_product(product["asin_or_sku"], product["url"])
            if not payload:
                results.append({"productId": pid, "status": "blocked"})
                continue
            h = hash_payload(payload)
            last_snap = query_one("SELECT hash, payload_json FROM snapshots WHERE product_id=$1 ORDER BY fetched_at DESC LIMIT 1", [pid])
            query("INSERT INTO snapshots (product_id, payload_json, hash, fetched_at) VALUES ($1,$2::jsonb,$3,NOW())", [pid, json.dumps(payload), h])
            query("UPDATE products SET last_seen_at=NOW() WHERE id=$1", [pid])
            change_count = 0
            if last_snap and last_snap["hash"] != h:
                prev = last_snap["payload_json"]
                if isinstance(prev, str):
                    prev = json.loads(prev)
                for fc in diff_payloads(prev, payload):
                    query("INSERT INTO changes (product_id, field, old_value, new_value, detected_at) VALUES ($1,$2,$3,$4,NOW())", [pid, fc["field"], fc["old_value"], fc["new_value"]])
                    change_count += 1
            results.append({"productId": pid, "status": "success", "changes": change_count})
        except Exception as e:
            results.append({"productId": pid, "status": "error", "error": str(e)})
        await asyncio.sleep(0.5)
    return {"processed": len(results), "results": results}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
