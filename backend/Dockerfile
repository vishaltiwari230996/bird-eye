# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# System packages needed to build psycopg2-binary and httpx[http2]
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Playwright Chromium system dependencies (from playwright install-deps output)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium core
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
    libcairo2 libatspi2.0-0 libwayland-client0 \
    # Font rendering (avoids missing-font bot signals)
    fonts-liberation fonts-noto-color-emoji \
    # Misc
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Install Playwright browsers (Chromium only — ~170 MB)
RUN playwright install chromium

# Copy application code
COPY . .

# Cloud Run injects PORT env var; default to 8000 locally
ENV PORT=8000
ENV APP_ENV=production

# Chromium path inside the Playwright cache (set so scraper can find it)
# Playwright manages the path itself; we only override CHROME_PATH if needed.

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
