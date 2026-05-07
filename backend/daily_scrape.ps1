# daily_scrape.ps1
# Runs the PW seller scrape end-to-end. Designed to be invoked by Windows
# Task Scheduler at 04:00 IST every day.
#
# Behaviour:
#   - cd's into D:\birdeye so relative imports / .env loading work
#   - Refuses to start a second copy if a previous run is still going
#     (prevents two scrapers fighting for the local Chrome process)
#   - Writes a date-stamped log under D:\birdeye\logs\
#   - Uses --resume so a partial run earlier in the day is picked up
#     instead of redone
#
# Manual test:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\birdeye\backend\daily_scrape.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path 'D:\birdeye'

$logDir = 'D:\birdeye\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$lockFile = Join-Path $logDir 'scrape.lock'
$stamp    = Get-Date -Format 'yyyyMMdd_HHmm'
$logFile  = Join-Path $logDir "scrape_pw_$stamp.log"

# ── Concurrency guard ──────────────────────────────────────────────────────
if (Test-Path $lockFile) {
    $pidContent = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($pidContent) {
        $existing = Get-Process -Id $pidContent -ErrorAction SilentlyContinue
        if ($existing) {
            "[$(Get-Date -Format o)] previous scrape (pid=$pidContent) still running; skipping" |
                Tee-Object -FilePath $logFile -Append | Out-Null
            exit 0
        }
    }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
$PID | Out-File -FilePath $lockFile -Encoding ascii -Force

# ── Run scraper ────────────────────────────────────────────────────────────
try {
    "[$(Get-Date -Format o)] starting scrape_pw_sellers.py --resume" |
        Tee-Object -FilePath $logFile -Append | Out-Null

    & python -u 'backend\scrape_pw_sellers.py' --resume *>&1 |
        Tee-Object -FilePath $logFile -Append

    "[$(Get-Date -Format o)] finished (exit=$LASTEXITCODE)" |
        Tee-Object -FilePath $logFile -Append | Out-Null
}
finally {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
