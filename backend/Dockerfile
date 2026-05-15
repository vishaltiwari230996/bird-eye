# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# System packages needed to build psycopg2-binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# libpq for psycopg2 + CA certs for HTTPS + Chromium runtime libs needed by
# Playwright (the Snapshots panel). The size hit lives only on this image, not
# on cron-only deployments that don't take screenshots.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

# Install Chromium for Playwright. Cached separately so app code changes
# don't invalidate this big layer.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python -m playwright install chromium

COPY . .

# HuggingFace / Cloud Run inject PORT; default to 8080.
ENV PORT=8080
ENV APP_ENV=production

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
