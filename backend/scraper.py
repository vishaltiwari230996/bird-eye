"""scraper.py — Amazon product page + offer listing scraper.

Expert-grade anti-detection rewrite:
  * Large, weighted UA pool (Chrome 131/132 real UAs)
  * Full sec-fetch-* + accept-* header suite — no XHR giveaway
  * Playwright stealth: patches navigator.webdriver, plugins, languages, WebGL
  * Resource blocking in Playwright (images/fonts/media) for speed & lower fingerprint
  * Cookie persistence across static requests (httpx.AsyncClient reuse)
  * Randomised viewport, human-like micro-delays
  * Exponential backoff retry on blocks
  * Comprehensive block/CAPTCHA detection
"""
import asyncio
import hashlib
import hmac
import json
import os
import random
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from bs4 import BeautifulSoup, Tag

# ─── Constants ────────────────────────────────────────────────────────────────

# On Windows dev: use local Chrome. On Linux/Cloud Run: Playwright uses its own Chromium.
# Override with CHROME_EXECUTABLE_PATH env var if needed.
CHROME_PATH = os.environ.get(
    "CHROME_EXECUTABLE_PATH",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
)

# ─── Proxy configuration (BrightData / generic HTTP proxy) ───────────────────
# Set PROXY_URL like: http://user:pass@brd.superproxy.io:33335
# Or set PROXY_HOST / PROXY_PORT / PROXY_USER / PROXY_PASS individually.
def _build_proxy_url() -> Optional[str]:
    url = os.environ.get("PROXY_URL", "").strip()
    if url:
        return url
    host = os.environ.get("PROXY_HOST", "").strip()
    port = os.environ.get("PROXY_PORT", "").strip()
    if not (host and port):
        return None
    user = os.environ.get("PROXY_USER", "").strip()
    pwd = os.environ.get("PROXY_PASS", "").strip()
    scheme = os.environ.get("PROXY_SCHEME", "http").strip() or "http"
    if user and pwd:
        from urllib.parse import quote
        return f"{scheme}://{quote(user, safe='')}:{quote(pwd, safe='')}@{host}:{port}"
    return f"{scheme}://{host}:{port}"


PROXY_URL = _build_proxy_url()
PROXY_VERIFY_SSL = os.environ.get("PROXY_VERIFY_SSL", "false").lower() in ("1", "true", "yes")

if PROXY_URL:
    # Mask password for logging
    import re as _re
    _masked = _re.sub(r"://([^:]+):([^@]+)@", r"://\1:****@", PROXY_URL)
    print(f"[scraper] Proxy enabled: {_masked} (verify_ssl={PROXY_VERIFY_SSL})")
else:
    print("[scraper] No proxy configured (set PROXY_URL or PROXY_HOST/PORT/USER/PASS)")


def _playwright_proxy() -> Optional[dict]:
    """Convert PROXY_URL into Playwright's proxy dict format."""
    if not PROXY_URL:
        return None
    from urllib.parse import urlparse, unquote
    p = urlparse(PROXY_URL)
    if not p.hostname or not p.port:
        return None
    out = {"server": f"{p.scheme}://{p.hostname}:{p.port}"}
    if p.username:
        out["username"] = unquote(p.username)
    if p.password:
        out["password"] = unquote(p.password)
    return out

# Real Chrome 131/132 UAs sampled from public analytics (Windows + macOS + Linux)
UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.139 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.110 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.83 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.116 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.110 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.139 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.83 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.110 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.265 Safari/537.36 Edg/131.0.2903.112",
]

# Viewport sizes that real users actually have (Statcounter 2024)
VIEWPORT_POOL = [
    {"width": 1920, "height": 1080},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
    {"width": 1280, "height": 720},
    {"width": 1600, "height": 900},
    {"width": 1280, "height": 800},
    {"width": 2560, "height": 1440},
]

# JavaScript injected before each Playwright page load.
# Patches the signals Amazon bot-detection reads.
STEALTH_SCRIPT = """
// 1. Hide webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. Restore realistic plugins (headless Chrome has 0)
Object.defineProperty(navigator, 'plugins', {
    get: () => {
        const p = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        p.__proto__ = PluginArray.prototype;
        return p;
    },
});

// 3. Realistic language stack
Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });

// 4. Patch chrome runtime
window.chrome = {
    runtime: {
        id: undefined,
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    loadTimes: () => ({ firstPaintTime: performance.now() / 1000 }),
    csi: () => ({ startE: Date.now(), onloadT: Date.now() + 500, pageT: 1500, tran: 15 }),
    app: { isInstalled: false },
};

// 5. Permissions API
const _origQuery = window.navigator.permissions.query.bind(navigator.permissions);
window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
        ? Promise.resolve({ state: 'default', onchange: null })
        : _origQuery(p);

// 6. WebGL vendor/renderer
try {
    const _gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel(R) UHD Graphics 620';
        return _gp.call(this, p);
    };
    const _gp2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel(R) UHD Graphics 620';
        return _gp2.call(this, p);
    };
} catch (_) {}

// 7. Realistic screen
Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
"""

# Resource types to block in Playwright
BLOCKED_RESOURCE_TYPES = {"image", "media", "font", "websocket"}
BLOCKED_URL_PATTERNS = (
    "amazon-adsystem.com", "fls-na.amazon", "fls-fe.amazon",
    "unagi.amazon", "mads.amazon", "s.amazon-adsystem",
    "google-analytics.com", "googletagmanager.com",
    "doubleclick.net", "scorecardresearch.com",
)

# ─── Singleton browser ────────────────────────────────────────────────────────

_pw_instance = None
_browser_instance = None


async def get_browser():
    global _pw_instance, _browser_instance

    if _browser_instance:
        try:
            await asyncio.wait_for(_browser_instance.contexts(), timeout=3)
            return _browser_instance
        except Exception:
            _browser_instance = None
            _pw_instance = None

    use_local_chrome = os.path.exists(CHROME_PATH)
    if use_local_chrome:
        print(f"[scraper] Using local Chrome at {CHROME_PATH}")
    else:
        print("[scraper] Using Playwright bundled Chromium")

    try:
        from playwright.async_api import async_playwright
        _pw_instance = await async_playwright().start()

        args = [
            "--no-sandbox",
            "--disable-setuid-sandbox",       # required in Linux containers
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",        # avoids /dev/shm OOM in Docker
            "--disable-gpu",
            "--lang=en-IN",
            "--disable-infobars",
            "--disable-notifications",
            "--disable-extensions",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        if PROXY_URL:
            # BrightData proxy presents its own cert for HTTPS interception
            args.append("--ignore-certificate-errors")

        launch_kwargs: dict = dict(headless=True, args=args)
        if use_local_chrome:
            launch_kwargs["executable_path"] = CHROME_PATH

        proxy_cfg = _playwright_proxy()
        if proxy_cfg:
            launch_kwargs["proxy"] = proxy_cfg

        _browser_instance = await _pw_instance.chromium.launch(**launch_kwargs)
        _browser_instance.on("disconnected", _on_browser_disconnect)
        return _browser_instance
    except Exception as e:
        print(f"[scraper] Failed to launch browser: {e}")
        return None


def _on_browser_disconnect():
    global _browser_instance, _pw_instance
    _browser_instance = None
    _pw_instance = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def pick_ua() -> str:
    return random.choice(UA_POOL)


def pick_viewport() -> dict:
    return random.choice(VIEWPORT_POOL)


def human_delay(min_s: float = 0.8, max_s: float = 2.4) -> float:
    """Gaussian-distributed human-like delay in seconds."""
    mu = (min_s + max_s) / 2
    sigma = (max_s - min_s) / 6
    return max(min_s, min(max_s, random.gauss(mu, sigma)))


def parse_price(raw: str) -> Optional[float]:
    """Extract the first valid INR price from a string. Caps decimals at 2
    so concatenated prices like '527.002222527' don't get parsed as one number.
    """
    if not raw:
        return None
    # Match an Indian-format number (with optional comma grouping) and ≤2 decimals
    m = re.search(r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?", raw)
    if not m:
        return None
    try:
        return float(m.group().replace(",", ""))
    except Exception:
        return None


def is_blocked(html: str) -> bool:
    """Detect all known Amazon bot/CAPTCHA/redirect block patterns."""
    if not html or len(html) < 500:
        return True
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string or "").strip() if soup.title else ""
    low_title = title.lower()
    low_html = html.lower()

    if low_title in ("amazon.in", "amazon.com", "", "access denied", "service unavailable"):
        return True

    if any(kw in low_html for kw in (
        "type the characters you see",
        "enter the characters you see",
        "robot check",
        "/errors/validatecaptcha",
        "captcha",
        "ap_captcha",
        "recaptcha",
        "sorry, we just need to make sure",
        "to discuss automated access",
        "automated access",
    )):
        return True

    if "<title>amazon.in</title>" in low_html and len(html) < 5000:
        return True

    return False


# ─── Amazon PA API seller fetch ──────────────────────────────────────────────

def _paapi_sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


async def fetch_sellers_paapi(asin: str) -> list[dict]:
    """Fetch offer listings via Amazon Product Advertising API v5.

    Official API — no scraping, no IP blocks, works from any server.
    Requires AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG in env.
    """
    access_key = os.getenv("AMAZON_ACCESS_KEY", "")
    secret_key  = os.getenv("AMAZON_SECRET_KEY", "")
    partner_tag = os.getenv("AMAZON_PARTNER_TAG", "")
    if not all([access_key, secret_key, partner_tag]):
        print("[paapi] Missing credentials — skipping PA API")
        return []

    host   = "webservices.amazon.in"
    region = "eu-west-1"
    service = "ProductAdvertisingAPI"
    target  = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems"
    path    = "/paapi5/getitems"

    body = json.dumps({
        "ItemIds": [asin],
        "Resources": [
            "Offers.Listings.Condition",
            "Offers.Listings.DeliveryInfo.IsPrimeEligible",
            "Offers.Listings.IsBuyBoxWinner",
            "Offers.Listings.MerchantInfo",
            "Offers.Listings.Price",
        ],
        "PartnerTag": partner_tag,
        "PartnerType": "Associates",
        "Marketplace": "www.amazon.in",
    }, separators=(",", ":"))

    now        = datetime.now(timezone.utc)
    amz_date   = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()

    canonical_headers = (
        "content-encoding:amz-1.0\n"
        "content-type:application/json; charset=UTF-8\n"
        f"host:{host}\n"
        f"x-amz-date:{amz_date}\n"
        f"x-amz-target:{target}\n"
    )
    signed_headers = "content-encoding;content-type;host;x-amz-date;x-amz-target"

    canonical_request = "\n".join(["POST", path, "", canonical_headers, signed_headers, payload_hash])

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    signing_key = _paapi_sign(
        _paapi_sign(
            _paapi_sign(
                _paapi_sign(f"AWS4{secret_key}".encode("utf-8"), date_stamp),
                region,
            ),
            service,
        ),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    try:
        client_kwargs: dict = {"timeout": 15}
        if PROXY_URL:
            client_kwargs["proxy"] = PROXY_URL
            client_kwargs["verify"] = PROXY_VERIFY_SSL
        async with httpx.AsyncClient(**client_kwargs) as client:
            r = await client.post(
                f"https://{host}{path}",
                content=body.encode("utf-8"),
                headers={
                    "content-encoding": "amz-1.0",
                    "content-type": "application/json; charset=UTF-8",
                    "host": host,
                    "x-amz-date": amz_date,
                    "x-amz-target": target,
                    "Authorization": auth,
                },
            )

        if r.status_code != 200:
            print(f"[paapi] {asin} -> HTTP {r.status_code}: {r.text[:300]}")
            return []

        data = r.json()
        listings: list[dict] = []
        for item in data.get("ItemsResult", {}).get("Items", []):
            for offer in item.get("Offers", {}).get("Listings", []):
                price_obj   = offer.get("Price", {})
                price       = price_obj.get("Amount")
                merchant    = offer.get("MerchantInfo", {})
                seller_name = merchant.get("Name") or "Unknown"
                is_prime    = offer.get("DeliveryInfo", {}).get("IsPrimeEligible", False)
                cond        = offer.get("Condition", {}).get("Value", "New")
                is_fba      = "amazon" in seller_name.lower()
                listings.append({
                    "seller_name": seller_name,
                    "price": float(price) if price is not None else None,
                    "condition": cond,
                    "is_fba": is_fba,
                    "prime_eligible": is_prime,
                })

        print(f"[paapi] {asin} -> {len(listings)} offers via PA API")
        return listings

    except Exception as e:
        print(f"[paapi] Exception for {asin}: {e}")
        return []


# ─── AI-powered extraction helpers ───────────────────────────────────────────

def _extract_product_zone(html: str) -> str:
    """Strip nav/footer/ads; keep only the product content zone for LLM context."""
    soup = BeautifulSoup(html, "html.parser")
    # Remove noisy sections
    for tag in soup.find_all(["nav", "header", "footer", "script", "style", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(id=re.compile(r"nav|navbar|breadcrumb|sidebar|footer|ad|sponsored", re.I)):
        tag.decompose()

    # Prefer the product detail area
    zone = (
        soup.find(id="dp-container")
        or soup.find(id="ppd")
        or soup.find(id="centerCol")
        or soup.find(id="dp")
        or soup.body
    )
    if not zone:
        return soup.get_text(" ", strip=True)[:6000]

    # Return clean text, max 6000 chars (fits in ~2k tokens)
    text = zone.get_text(" ", strip=True)
    return re.sub(r"\s{2,}", " ", text)[:6000]


def _extract_offer_zone(html: str) -> str:
    """Extract AOD offer panel text for LLM parsing."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()
    zone = (
        soup.find(id="aod-offer-list")
        or soup.find(id="aod-container")
        or soup.find(id="aod-pinned-offer")
        or soup.body
    )
    text = zone.get_text(" ", strip=True) if zone else soup.get_text(" ", strip=True)
    return re.sub(r"\s{2,}", " ", text)[:5000]


async def ai_extract_product(html: str) -> Optional[dict]:
    """Use OpenRouter LLM to extract product data when CSS selectors fail."""
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        return None

    zone_text = _extract_product_zone(html)
    model = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

    prompt = (
        "You are an expert at reading Amazon India product pages. "
        "Extract the following fields from the text below and return ONLY a JSON object with no extra text:\n"
        '{"title": string|null, "price": number|null, "rating": number|null, '
        '"reviewCount": number|null, "availability": string|null, '
        '"seller": string|null, "bsr": string|null}\n\n'
        "Rules:\n"
        "- price is the current selling price in INR as a plain number (no ₹ symbol)\n"
        "- rating is out of 5 as a decimal (e.g. 4.3)\n"
        "- bsr is the Best Sellers Rank e.g. '#1,234'\n"
        "- Return null for any field you cannot find\n\n"
        f"PAGE TEXT:\n{zone_text}"
    )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"].strip()
            # Strip markdown code fences if present
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.DOTALL).strip()
            data = json.loads(content)
            print(f"[ai_extract] Product extraction succeeded: title={data.get('title', '')[:40]}")
            return data
    except Exception as e:
        print(f"[ai_extract] Product extraction failed: {e}")
        return None


async def ai_extract_offers(html: str, asin: str) -> list[dict]:
    """Use OpenRouter LLM to extract seller offer listings when AOD parsing fails."""
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        return []

    zone_text = _extract_offer_zone(html)
    model = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

    prompt = (
        "You are an expert at reading Amazon India seller offer listings. "
        "Extract ALL sellers offering this product and return ONLY a JSON array with no extra text:\n"
        '[{"seller_name": string, "price": number|null, "condition": string, '
        '"is_fba": boolean, "prime_eligible": boolean}]\n\n'
        "Rules:\n"
        "- price is in INR as a plain number\n"
        "- condition is usually 'New'\n"
        "- is_fba is true if sold/fulfilled by Amazon\n"
        "- Return [] if no sellers found\n\n"
        f"PAGE TEXT:\n{zone_text}"
    )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"].strip()
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.DOTALL).strip()
            listings = json.loads(content)
            if isinstance(listings, list):
                print(f"[ai_extract] Offer extraction succeeded: {len(listings)} sellers for {asin}")
                return listings
    except Exception as e:
        print(f"[ai_extract] Offer extraction failed for {asin}: {e}")
    return []


def build_static_headers(ua: str, referer: str = "") -> dict:
    """Full Chrome-realistic header set for HTTPX page navigation.

    Key fix: removed X-Requested-With (real browsers never send this on nav).
    Added sec-fetch-* headers Chrome always includes.
    """
    h = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "DNT": "1",
        "Cache-Control": "max-age=0",
    }
    m = re.search(r"Chrome/(\d+)", ua)
    if m:
        ver = m.group(1)
        h["Sec-Ch-Ua"] = f'"Chromium";v="{ver}", "Not_A Brand";v="24", "Google Chrome";v="{ver}"'
        h["Sec-Ch-Ua-Mobile"] = "?0"
        h["Sec-Ch-Ua-Platform"] = '"Windows"'
    if referer:
        h["Referer"] = referer
        h["Sec-Fetch-Site"] = "same-origin"
    return h


# ─── Static HTTP fetch ────────────────────────────────────────────────────────

_static_client: Optional[httpx.AsyncClient] = None


async def get_static_client() -> httpx.AsyncClient:
    global _static_client
    if _static_client is None or _static_client.is_closed:
        kwargs: dict = dict(
            timeout=30,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=5, max_keepalive_connections=3),
        )
        if PROXY_URL:
            # BrightData proxy doesn't support HTTP/2; use HTTP/1.1
            kwargs["proxy"] = PROXY_URL
            kwargs["verify"] = PROXY_VERIFY_SSL
        else:
            kwargs["http2"] = True
        _static_client = httpx.AsyncClient(**kwargs)
    return _static_client


async def fetch_html_static(url: str, referer: str = "", retries: int = 2) -> Optional[str]:
    ua = pick_ua()
    client = await get_static_client()
    for attempt in range(retries + 1):
        try:
            r = await client.get(url, headers=build_static_headers(ua, referer))
            if not r.is_success:
                return None
            html = r.text
            if is_blocked(html):
                if attempt < retries:
                    await asyncio.sleep(human_delay(2, 5) * (2 ** attempt))
                    ua = pick_ua()
                    continue
                return None
            return html
        except Exception as e:
            print(f"[scraper] Static fetch error (attempt {attempt + 1}): {e}")
            if attempt < retries:
                await asyncio.sleep(human_delay(1, 3))
    return None


# ─── Browser fetch ────────────────────────────────────────────────────────────

async def fetch_html_browser(
    url: str,
    click_selector: Optional[str] = None,
    wait_selector: Optional[str] = None,
    extra_wait_s: float = 1.5,
    retries: int = 1,
) -> Optional[str]:
    browser = await get_browser()
    if not browser:
        return None

    for attempt in range(retries + 1):
        ctx = None
        page = None
        try:
            ua = pick_ua()
            vp = pick_viewport()
            ctx = await browser.new_context(
                user_agent=ua,
                viewport=vp,
                locale="en-IN",
                timezone_id="Asia/Kolkata",
                extra_http_headers={"Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8", "DNT": "1"},
                color_scheme="light",
                ignore_https_errors=bool(PROXY_URL),
            )
            await ctx.add_init_script(STEALTH_SCRIPT)
            page = await ctx.new_page()

            async def _block_route(route):
                req = route.request
                if req.resource_type in BLOCKED_RESOURCE_TYPES:
                    await route.abort()
                    return
                if any(p in req.url for p in BLOCKED_URL_PATTERNS):
                    await route.abort()
                    return
                await route.continue_()

            await page.route("**/*", _block_route)
            await page.goto(url, wait_until="domcontentloaded", timeout=35_000)
            await asyncio.sleep(human_delay(0.8, extra_wait_s))

            title = await page.title()
            if is_blocked(f"<title>{title}</title>test content present"):
                full_html = await page.content()
                if is_blocked(full_html):
                    print(f"[scraper] Browser blocked (attempt {attempt + 1}) at {url}")
                    await ctx.close()
                    ctx = None
                    if attempt < retries:
                        await asyncio.sleep(human_delay(5, 12) * (2 ** attempt))
                        continue
                    return None

            if click_selector:
                try:
                    el = page.locator(click_selector).first
                    if await el.count() > 0:
                        await el.scroll_into_view_if_needed(timeout=4_000)
                        await asyncio.sleep(human_delay(0.3, 0.8))
                        await el.click(timeout=6_000)
                        await asyncio.sleep(human_delay(1.5, 3.0))
                except Exception:
                    pass

            if wait_selector:
                try:
                    await page.wait_for_selector(wait_selector, timeout=10_000)
                except Exception:
                    pass

            html = await page.content()
            await ctx.close()
            return html

        except Exception as e:
            print(f"[scraper] Browser fetch failed (attempt {attempt + 1}): {e}")
            if attempt < retries:
                await asyncio.sleep(human_delay(3, 8))
        finally:
            if page:
                try:
                    await page.close()
                except Exception:
                    pass
            if ctx:
                try:
                    await ctx.close()
                except Exception:
                    pass

    return None


# ─── AOD offer listing parser ─────────────────────────────────────────────────

def parse_aod_html(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    listings: list[dict] = []
    seen_keys: set[str] = set()

    # ── Strategy A: AOD popup / offer-listing markup (preferred) ──────────────
    # Each offer has #aod-offer-soldBy with seller link inside, sitting in
    # an ancestor #aod-pinned-offer or id starting with aod-offer-{n}.
    sold_by_blocks = soup.find_all(id="aod-offer-soldBy")
    if sold_by_blocks:
        for sb in sold_by_blocks:
            a = sb.find("a")
            if not a:
                continue
            seller_name = a.get_text(strip=True)
            if not seller_name:
                continue
            href = a.get("href", "") or ""
            sid_m = re.search(r"seller=([A-Z0-9]+)", href, re.I)
            seller_id = sid_m.group(1) if sid_m else ""

            container = sb
            for _ in range(15):
                if container.parent is None:
                    break
                container = container.parent
                cid = container.get("id", "") or ""
                classes = container.get("class") or []
                if (
                    cid == "aod-pinned-offer"
                    or (cid.startswith("aod-offer-") and cid != "aod-offer-soldBy")
                    or "aod-offer" in classes
                    or "aod-pinned-offer" in classes
                    or "aod-offer-list-item" in classes
                ):
                    break

            price = None
            for off in container.find_all("span", class_="a-offscreen"):
                ancestor_classes = " ".join(
                    " ".join(p.get("class") or []) for p in off.parents if p.name
                )
                if "a-text-strike" in ancestor_classes or "a-text-price" in ancestor_classes:
                    continue
                txt = off.get_text(strip=True)
                if "₹" in txt or "Rs" in txt or "INR" in txt or re.search(r"\d{2,}", txt):
                    p = parse_price(txt)
                    if p and p > 0:
                        price = p
                        break
            if price is None:
                for span in container.find_all("span"):
                    txt = span.get_text(strip=True)
                    if "₹" in txt and re.search(r"\d", txt):
                        p = parse_price(txt)
                        if p and p > 0:
                            price = p
                            break

            block_html = str(container).lower()
            is_fba = (
                "isamazonfulfilled=1" in href.lower()
                or "fulfilled by amazon" in block_html
                or "amazon fulfilled" in block_html
            )
            is_prime = container.find(class_=re.compile(r"a-icon-prime", re.I)) is not None

            key = f"{seller_id or seller_name}|{price}"
            if key in seen_keys:
                continue
            seen_keys.add(key)

            listings.append({
                "seller_name": seller_name,
                "price": price,
                "condition": "New",
                "is_fba": is_fba,
                "prime_eligible": is_prime,
            })

        if listings:
            return listings

    # ── Strategy B: Modern /gp/offer-listing/ markup (post-2023) ──────────────
    # Each offer card has a [offer-display-feature-name="desktop-merchant-info"]
    # The widest sensible offer-card ancestor is #desktop_qualifiedBuyBox or
    # #offer-display-features (one per offer; siblings hold price + shipping).
    merchant_blocks = soup.select('[offer-display-feature-name="desktop-merchant-info"]')
    if merchant_blocks:
        offer_cards: list[Tag] = []
        seen_card_ids: set[int] = set()
        for mi in merchant_blocks:
            card = mi
            best = None
            for _ in range(15):
                if card.parent is None:
                    break
                card = card.parent
                cid = card.get("id", "") or ""
                cls = " ".join(card.get("class") or [])
                # Prefer widest known offer container, but stop when we
                # hit something even wider (page-level) so we don't escape.
                if (
                    cid == "desktop_qualifiedBuyBox"
                    or cid == "offer-display-features"
                    or cid.startswith("offerDisplayFeatures")
                    or "olpOffer" in cls
                ):
                    best = card
                if cid in ("a-page", "dp", "centerCol", "ppd"):
                    break
            if best is not None and id(best) not in seen_card_ids:
                seen_card_ids.add(id(best))
                offer_cards.append(best)

        for card in offer_cards:
            # Seller name + id from any seller-profile link in the card
            seller_a = card.select_one('a#sellerProfileTriggerId')
            if not seller_a:
                seller_a = card.find("a", href=re.compile(r"seller=[A-Z0-9]+"))
            if not seller_a:
                continue
            seller_name = seller_a.get_text(strip=True)
            if not seller_name:
                continue
            href = seller_a.get("href", "") or ""
            sid_m = re.search(r"seller=([A-Z0-9]+)", href, re.I)
            seller_id = sid_m.group(1) if sid_m else ""

            # Price: pick the offer-display-price slot first; fall back to
            # any non-strikethrough .a-offscreen with a rupee symbol.
            price = None
            price_slot = card.select_one('[offer-display-feature-name="desktop-price"]')
            if not price_slot:
                price_slot = card.find(id=re.compile(r"price.*feature_div", re.I))
            search_root = price_slot if price_slot else card
            for off in search_root.select("span.a-offscreen"):
                # Skip if inside a struck-through/MRP container
                parent_cls = " ".join((off.parent.get("class") or []) if off.parent else [])
                ancestor_text_classes = " ".join(
                    " ".join(p.get("class") or []) for p in off.parents if p.name
                )
                if "a-text-strike" in ancestor_text_classes or "a-text-price" in parent_cls:
                    continue
                txt = off.get_text(strip=True)
                if "₹" in txt or "Rs" in txt or "INR" in txt:
                    p = parse_price(txt)
                    if p and p > 0:
                        price = p
                        break
            if price is None:
                # Fallback: take lowest non-strike price visible in the card
                candidates = []
                for off in card.select("span.a-offscreen"):
                    ancestor_classes = " ".join(
                        " ".join(p.get("class") or []) for p in off.parents if p.name
                    )
                    if "a-text-strike" in ancestor_classes:
                        continue
                    txt = off.get_text(strip=True)
                    if "₹" in txt or "Rs" in txt:
                        p = parse_price(txt)
                        if p and p > 0:
                            candidates.append(p)
                if candidates:
                    price = min(candidates)

            block_html = str(card).lower()
            is_fba = (
                "isamazonfulfilled=1" in href.lower()
                or "fulfilled by amazon" in block_html
                or "amazon fulfilled" in block_html
            )
            is_prime = card.find(class_=re.compile(r"a-icon-prime", re.I)) is not None

            key = f"{seller_id or seller_name}|{price}"
            if key in seen_keys:
                continue
            seen_keys.add(key)

            listings.append({
                "seller_name": seller_name,
                "price": price,
                "condition": "New",
                "is_fba": is_fba,
                "prime_eligible": is_prime,
            })

        if listings:
            return listings

    return listings


def parse_legacy_offer_html(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    listings: list[dict] = []
    for el in soup.find_all("div", class_="olpOffer"):
        seller_el = el.find(class_="olpSellerName")
        a = (seller_el.find("a") or seller_el.find(class_="a-profile-name")) if seller_el else None
        seller_name = a.get_text(strip=True) if a else ""
        if not seller_name:
            continue
        price_el = el.find(class_="olpOfferPrice")
        price_raw = price_el.find(class_="a-offscreen") or price_el if price_el else None
        price = parse_price(price_raw.get_text(strip=True)) if price_raw else None
        is_fba = bool(el.find(class_="olpFbaPopoverTrigger"))
        prime = bool(el.find(class_=re.compile(r"a-icon-prime", re.I)))
        listings.append({
            "seller_name": seller_name,
            "price": price,
            "condition": "New",
            "is_fba": is_fba,
            "prime_eligible": prime,
        })
    return listings


def parse_buybox_seller(html: str) -> Optional[dict]:
    """Extract the single buy-box seller from a product detail page."""
    soup = BeautifulSoup(html, "html.parser")
    seller_name = None

    for sel in ("#sellerProfileTriggerId", "#merchant-info a", "#tabular-buybox-container .tabular-buybox-text"):
        el = soup.select_one(sel)
        if el:
            candidate = el.get_text(strip=True)
            if candidate:
                seller_name = candidate
                break

    if not seller_name:
        mi = soup.find(id="merchant-info")
        if mi:
            txt = mi.get_text(" ", strip=True)
            m = re.search(r"sold by\s+([^.]+?)(?:\s+and|\s*\.|$)", txt, re.I)
            if m:
                seller_name = m.group(1).strip()

    if not seller_name:
        for row in soup.select("#tabular-buybox-container [tabular-attribute-name]"):
            label = row.get("tabular-attribute-name", "")
            if "sold by" in label.lower():
                seller_name = row.get_text(strip=True)
                break

    if not seller_name:
        return None

    price = None
    for sel in (
        "#corePrice_feature_div .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#apex_offerDisplay_desktop .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#price_inside_buybox",
        "#kindle-price",
        "#price",
    ):
        el = soup.select_one(sel)
        if el:
            txt = el.get_text(strip=True)
            if re.search(r"\d", txt):
                price = parse_price(txt)
                if price and price > 0:
                    break

    body = soup.get_text(" ", strip=True).lower()
    is_fba = "fulfilled by amazon" in body or "amazon fulfilled" in body
    is_prime = bool(soup.find(class_=re.compile(r"a-icon-prime", re.I)))

    return {
        "seller_name": seller_name,
        "price": price,
        "condition": "New",
        "is_fba": is_fba,
        "prime_eligible": is_prime,
    }


# ─── Offer listing scrape ─────────────────────────────────────────────────────

async def fetch_aod_via_browser(asin: str) -> Optional[str]:
    """Open product page, click 'See All Buying Options' to expand the AOD
    popup (which contains all sellers + prices), wait for it to render,
    return the full page HTML.

    No URL-based fallbacks: testing showed they all redirect back to /dp/
    and don't include the AOD list. Click is the only reliable path.
    """
    browser = await get_browser()
    if not browser:
        return None

    product_url = f"https://www.amazon.in/dp/{asin}"
    ctx = None
    page = None
    try:
        ctx = await browser.new_context(
            user_agent=pick_ua(),
            viewport=pick_viewport(),
            locale="en-IN",
            timezone_id="Asia/Kolkata",
            extra_http_headers={"Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8", "DNT": "1"},
            color_scheme="light",
            ignore_https_errors=bool(PROXY_URL),
        )
        await ctx.add_init_script(STEALTH_SCRIPT)
        page = await ctx.new_page()

        # NO route-blocking — Amazon's AOD popup is rendered by inline JS
        # that depends on its full asset bundle being available.

        # 1. Load product page (retry on transient proxy/Amazon errors)
        last_err = None
        for attempt in range(3):
            try:
                await page.goto(product_url, wait_until="domcontentloaded", timeout=90_000)
                last_err = None
                break
            except Exception as e:
                last_err = e
                msg = str(e)
                if "ERR_HTTP_RESPONSE_CODE_FAILURE" in msg or "ERR_TUNNEL" in msg or "Timeout" in msg:
                    print(f"[scraper] {asin} goto retry {attempt+1}: {msg.splitlines()[0][:120]}")
                    await asyncio.sleep(human_delay(2.0, 4.0))
                    continue
                raise
        if last_err:
            raise last_err
        await asyncio.sleep(human_delay(1.0, 2.0))

        product_html = await page.content()
        if is_blocked(product_html):
            print(f"[scraper] {asin} product page blocked")
            return None

        # 2. Find AOD ingress link
        ingress = page.locator(
            "#aod-ingress-link, a[href*='aod=1'], #buybox-see-all-buying-choices a"
        ).first
        if await ingress.count() == 0:
            # Genuinely only one seller available
            print(f"[scraper] {asin} no AOD ingress (single-seller product)")
            return product_html

        # 3. Click ingress (with JS fallback)
        try:
            await ingress.scroll_into_view_if_needed(timeout=5_000)
        except Exception:
            pass
        await asyncio.sleep(human_delay(0.3, 0.8))
        try:
            await ingress.click(timeout=8_000)
        except Exception:
            try:
                await page.evaluate(
                    "(() => { const el = document.querySelector('#aod-ingress-link, a[href*=\"aod=1\"]'); if (el) el.click(); })()"
                )
            except Exception as e:
                print(f"[scraper] {asin} ingress click failed: {e}")

        # 4. Wait for AOD list to render
        try:
            await page.wait_for_selector(
                "#aod-offer-soldBy, #aod-pinned-offer, #aod-offer-list",
                timeout=20_000,
                state="attached",
            )
        except Exception:
            print(f"[scraper] {asin} AOD list selector timeout")

        await asyncio.sleep(human_delay(1.5, 2.5))

        # 5. Scroll inside AOD container to trigger lazy-loading of more offers
        try:
            await page.evaluate(
                """() => {
                    const c = document.querySelector('#aod-offer-list, #all-offers-display-scroller, #aod-container');
                    if (c) c.scrollTop = c.scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                }"""
            )
            await asyncio.sleep(1.5)
        except Exception:
            pass

        return await page.content()

    except Exception as e:
        print(f"[scraper] fetch_aod_via_browser failed for {asin}: {e}")
        return None
    finally:
        if page:
            try:
                await page.close()
            except Exception:
                pass
        if ctx:
            try:
                await ctx.close()
            except Exception:
                pass


async def scrape_offer_listings(asin: str) -> list[dict]:
    """Full offer-listing scrape.

    Priority:
    1. Amazon PA API (official, no IP blocks — primary)
    2. Browser: warm session on /dp/, navigate to AOD AJAX URL
    3. Static warm-session AOD AJAX fallback
    4. AI extraction from whatever HTML we managed to get
    """
    product_url = f"https://www.amazon.in/dp/{asin}"

    # ── 1. PA API (official, always works from any server) ────────────────────
    pa_listings = await fetch_sellers_paapi(asin)
    if pa_listings:
        return pa_listings

    last_html: Optional[str] = None

    # ── 2. Browser -> product page + AOD URL navigation ────────────────────────
    aod_html = await fetch_aod_via_browser(asin)
    if aod_html:
        last_html = aod_html
        listings = parse_aod_html(aod_html)
        if listings:
            print(f"[scraper] {asin} -> {len(listings)} sellers via AOD")
            return listings
        single = parse_buybox_seller(aod_html)
        if single:
            print(f"[scraper] {asin} -> 1 buybox seller (AOD parse empty)")
            # don't early-return; try static fallback for more offers

    # ── 3. Static AOD AJAX fallback ───────────────────────────────────────────
    product_html = await fetch_html_static(product_url)
    if product_html:
        if not last_html:
            last_html = product_html
        if not is_blocked(product_html):
            ua = pick_ua()
            client = await get_static_client()
            for aod_url in (
                f"https://www.amazon.in/gp/aod/ajax/ref=dp_aod_ALL_mbc?asin={asin}&pc=dp&experienceId=aodAjaxMain",
                f"https://www.amazon.in/gp/aod/ajax/ref=dp_aod_NEW_mbc?asin={asin}&pc=dp",
                f"https://www.amazon.in/gp/aod/ajax?asin={asin}&pc=dp&isonlyrenderofferlist=false",
            ):
                try:
                    await asyncio.sleep(human_delay(1.0, 2.5))
                    r = await client.get(
                        aod_url,
                        headers={
                            **build_static_headers(ua, referer=product_url),
                            "Sec-Fetch-Dest": "empty",
                            "Sec-Fetch-Mode": "cors",
                            "Sec-Fetch-Site": "same-origin",
                        },
                    )
                    if r.is_success:
                        last_html = r.text
                        if not is_blocked(r.text):
                            listings = parse_aod_html(r.text)
                            if listings:
                                print(f"[scraper] {asin} -> {len(listings)} sellers via static AOD")
                                return listings
                except Exception as e:
                    print(f"[scraper] AOD AJAX fallback failed for {asin}: {e}")

    # AI fallback — extract sellers from whatever page we got
    if last_html:
        print(f"[scraper] CSS offer parsing failed for {asin}, trying AI extraction")
        ai_listings = await ai_extract_offers(last_html, asin)
        if ai_listings:
            return ai_listings

        # Last resort: buybox seller from the product page (single seller, but with price)
        single = parse_buybox_seller(last_html)
        if single:
            print(f"[scraper] {asin} -> 1 buybox seller (final fallback)")
            return [single]

    return []



# ─── Product page parser ─────────────────────────────────────────────────────

def parse_product_page(html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "html.parser")

    # Title
    title_el = (
        soup.find(id="productTitle")
        or soup.find("h1", class_=re.compile(r"a-size-(large|xlarge)", re.I))
        or soup.find("h1", id="title")
        or soup.find("span", id="ebooksProductTitle")
    )
    title = title_el.get_text(strip=True) if title_el else None
    if not title:
        return None

    # Price
    price: Optional[float] = None
    for sel in (
        "#corePrice_feature_div .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#apex_offerDisplay_desktop .a-offscreen",
        "#apex_offerDisplay_mobile .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#priceblock_saleprice",
        "#price_inside_buybox",
        "#kindle-price",
        "#price",
    ):
        el = soup.select_one(sel)
        if el:
            txt = el.get_text(strip=True)
            if re.search(r"\d", txt):
                price = parse_price(txt)
                if price and price > 0:
                    break

    if price is None:
        for span in soup.find_all("span", class_="a-price"):
            off = span.find("span", class_="a-offscreen")
            if off:
                txt = off.get_text(strip=True)
                if "₹" in txt or re.search(r"\d{2,}", txt):
                    price = parse_price(txt)
                    if price and price > 0:
                        break

    # Rating
    rating: Optional[float] = None
    for el in [
        soup.find(id="acrPopover"),
        soup.find("span", {"data-hook": "rating-out-of-text"}),
        soup.find("i", class_=re.compile(r"a-icon-star", re.I)),
        soup.select_one(".reviewCountTextLinkedHistogram"),
    ]:
        if not el:
            continue
        src = el.get("title", "") or el.get("aria-label", "") or el.get_text()
        rm = re.search(r"([\d.]+)\s*(?:out of|/)\s*5", src)
        if rm:
            rating = float(rm.group(1))
            break

    # Review count
    review_count: Optional[int] = None
    for el in [
        soup.find(id="acrCustomerReviewText"),
        soup.find("span", {"data-hook": "total-review-count"}),
        soup.select_one("#averageCustomerReviews #acrCustomerReviewText"),
    ]:
        if not el:
            continue
        rcm = re.search(r"([\d,]+)", el.get_text())
        if rcm:
            review_count = int(rcm.group(1).replace(",", ""))
            break

    # BSR
    bsr: Optional[str] = None
    for row in soup.find_all(["tr", "li", "span", "div"]):
        text = row.get_text(" ", strip=True)
        if "Best Sellers Rank" in text or "Amazon Best Sellers Rank" in text:
            bm = re.search(r"#([\d,]+)", text)
            if bm:
                bsr = f"#{bm.group(1)}"
                break

    # Availability
    avail_el = (
        soup.find(id="availability")
        or soup.select_one("#outOfStock")
        or soup.select_one("#buybox-see-all-buying-choices")
    )
    availability = avail_el.get_text(strip=True) if avail_el else None

    # SEO
    feature_bullets = soup.find(id="feature-bullets")
    bullet_count = len([li for li in feature_bullets.find_all("li") if li.get_text(strip=True)]) if feature_bullets else 0

    alt_images = (
        soup.find(id="altImages")
        or soup.find("div", class_="regularAltImageViewLayout")
        or soup.find("div", id="imageBlockThumbs")
    )
    image_count = len(alt_images.find_all("li")) if alt_images else 0

    has_aplus = bool(
        soup.find(id="aplus")
        or soup.find(id="aplus3p_feature_div")
        or soup.find(class_="aplus-v2")
        or soup.find(class_="celwidget aplus-brand-story-v2")
    )

    # Main image
    image: Optional[str] = None
    for img_id in ("landingImage", "imgBlkFront", "ebooksImgBlkFront", "main-image", "original-main-image"):
        img_el = soup.find("img", id=img_id)
        if img_el:
            dyn = img_el.get("data-a-dynamic-image", "")
            if dyn:
                try:
                    m = json.loads(dyn)
                    if isinstance(m, dict) and m:
                        image = max(m.items(), key=lambda kv: (kv[1][0] if isinstance(kv[1], list) and kv[1] else 0))[0]
                except Exception:
                    pass
            if not image:
                image = img_el.get("data-old-hires") or img_el.get("src")
            if image:
                break

    if not image:
        og = soup.find("meta", attrs={"property": "og:image"})
        if og and og.get("content"):
            image = og["content"]

    # Seller
    seller_el = soup.find(id="sellerProfileTriggerId") or soup.find(id="merchant-info")
    seller = seller_el.get_text(strip=True) if seller_el else None

    return {
        "title": title,
        "price": price,
        "rating": rating,
        "reviewCount": review_count,
        "bsr": bsr,
        "currency": "INR",
        "availability": availability,
        "image": image,
        "seo": {
            "bulletCount": bullet_count,
            "imageCount": image_count,
            "hasAPlus": has_aplus,
        },
        "offers": {
            "availability": availability,
            "seller": seller,
        },
    }


# ─── Product scrape ───────────────────────────────────────────────────────────

async def scrape_product(asin: str, url: str) -> Optional[dict]:
    """Scrape a product page.

    Priority:
    1. Static HTTP (fast, ~90% success)
    2. Playwright browser (stealth, fallback)
    3. AI extraction from raw HTML (resilient to DOM changes)
    """
    last_html: Optional[str] = None

    html = await fetch_html_static(url)
    if html:
        last_html = html
        if not is_blocked(html):
            payload = parse_product_page(html)
            if payload and payload.get("price"):
                return payload
            if payload:
                ai_data = await ai_extract_product(html)
                if ai_data:
                    payload["price"] = payload.get("price") or ai_data.get("price")
                    payload["rating"] = payload.get("rating") or ai_data.get("rating")
                    payload["reviewCount"] = payload.get("reviewCount") or ai_data.get("reviewCount")
                    payload["availability"] = payload.get("availability") or ai_data.get("availability")
                    payload["bsr"] = payload.get("bsr") or ai_data.get("bsr")
                    if payload.get("offers"):
                        payload["offers"]["seller"] = payload["offers"].get("seller") or ai_data.get("seller")
                return payload

    await asyncio.sleep(human_delay(1.0, 2.5))
    html = await fetch_html_browser(
        f"https://www.amazon.in/dp/{asin}",
        extra_wait_s=2.0,
        retries=1,
    )
    if html:
        last_html = html
        if not is_blocked(html):
            payload = parse_product_page(html)
            if payload and payload.get("price"):
                return payload
            if payload:
                ai_data = await ai_extract_product(html)
                if ai_data:
                    payload["price"] = payload.get("price") or ai_data.get("price")
                    payload["rating"] = payload.get("rating") or ai_data.get("rating")
                    payload["reviewCount"] = payload.get("reviewCount") or ai_data.get("reviewCount")
                    payload["availability"] = payload.get("availability") or ai_data.get("availability")
                    payload["bsr"] = payload.get("bsr") or ai_data.get("bsr")
                    if payload.get("offers"):
                        payload["offers"]["seller"] = payload["offers"].get("seller") or ai_data.get("seller")
                return payload

    # Both static + browser failed or returned no title — pure AI extraction
    if last_html:
        print(f"[scraper] CSS selectors failed for {asin}, falling back to full AI extraction")
        ai_data = await ai_extract_product(last_html)
        if ai_data and ai_data.get("title"):
            return {
                "title": ai_data.get("title"),
                "price": ai_data.get("price"),
                "rating": ai_data.get("rating"),
                "reviewCount": ai_data.get("reviewCount"),
                "bsr": ai_data.get("bsr"),
                "currency": "INR",
                "availability": ai_data.get("availability"),
                "image": None,
                "seo": {"bulletCount": 0, "imageCount": 0, "hasAPlus": False},
                "offers": {"availability": ai_data.get("availability"), "seller": ai_data.get("seller")},
            }

    return None


