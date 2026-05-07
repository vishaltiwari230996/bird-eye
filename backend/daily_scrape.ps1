# daily_scrape.ps1
# Runs the PW seller scrape end-to-end. Designed to be invoked by Windows
# Task Scheduler at 04:00 IST every day.
#
# Resilience model:
#   - --resume flag means every retry skips SKUs already snapshotted in the
#     last 24h, so we naturally pick up where the previous attempt stopped.
#   - If the python process exits non-zero, we retry up to MAX_ATTEMPTS times
#     (with a short cooldown between attempts).
#   - A watchdog kills the python process if its log has been idle for
#     HANG_IDLE_SECS, then the outer loop retries.
#   - Concurrency guard via lockfile prevents two simultaneous runs from
#     fighting over the local Chrome instance.
#
# Manual test:
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\birdeye\backend\daily_scrape.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path 'D:\birdeye'

# Tunables
$MAX_ATTEMPTS    = 5
$COOLDOWN_SECS   = 60
$HANG_IDLE_SECS  = 480  # 8 min

$logDir   = 'D:\birdeye\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$lockFile   = Join-Path $logDir 'scrape.lock'
$stamp      = Get-Date -Format 'yyyyMMdd_HHmm'
$logFile    = Join-Path $logDir "scrape_pw_$stamp.log"
$statusFile = Join-Path $logDir 'last_run.json'

function Write-Log([string]$msg) {
    $line = "[$(Get-Date -Format o)] $msg"
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

# Concurrency guard
if (Test-Path $lockFile) {
    $pidContent = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($pidContent) {
        $existing = Get-Process -Id $pidContent -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Log "previous scrape (pid=$pidContent) still running; skipping"
            exit 0
        }
    }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
$PID | Out-File -FilePath $lockFile -Encoding ascii -Force

$overallStart = Get-Date
$attempt = 0
$success = $false
$lastExit = -1

try {
    while ($attempt -lt $MAX_ATTEMPTS -and -not $success) {
        $attempt++
        Write-Log "attempt $attempt/$MAX_ATTEMPTS: launching scrape_pw_sellers.py --resume"

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName  = 'python'
        $psi.Arguments = '-u backend\scrape_pw_sellers.py --resume'
        $psi.WorkingDirectory = 'D:\birdeye'
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow  = $true

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi

        $handler = {
            if ($EventArgs.Data -ne $null) {
                Add-Content -Path $Event.MessageData -Value $EventArgs.Data
            }
        }
        $outSub = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $handler -MessageData $logFile
        $errSub = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action $handler -MessageData $logFile

        [void]$proc.Start()
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        $childPid = $proc.Id
        Write-Log "  child pid=$childPid"

        $killedByWatchdog = $false
        while (-not $proc.HasExited) {
            Start-Sleep -Seconds 30
            if ($proc.HasExited) { break }
            $lastWrite = (Get-Item $logFile).LastWriteTime
            $idleSecs  = [math]::Round(((Get-Date) - $lastWrite).TotalSeconds)
            if ($idleSecs -gt $HANG_IDLE_SECS) {
                Write-Log "  watchdog: log idle ${idleSecs}s > $HANG_IDLE_SECS, killing pid=$childPid"
                try { Stop-Process -Id $childPid -Force -ErrorAction Stop } catch {}
                try {
                    Get-Process chromium -ErrorAction SilentlyContinue |
                        Where-Object { $_.StartTime -gt $overallStart } |
                        Stop-Process -Force -ErrorAction SilentlyContinue
                } catch {}
                $killedByWatchdog = $true
                break
            }
        }

        if (-not $proc.HasExited) { $proc.WaitForExit() }
        Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue
        $lastExit = $proc.ExitCode

        if ($killedByWatchdog) {
            Write-Log "attempt $attempt killed by watchdog (hang); will retry"
        } elseif ($lastExit -eq 0) {
            Write-Log "attempt $attempt finished cleanly (exit=0)"
            $success = $true
        } else {
            Write-Log "attempt $attempt failed (exit=$lastExit); will retry"
        }

        if (-not $success -and $attempt -lt $MAX_ATTEMPTS) {
            Start-Sleep -Seconds $COOLDOWN_SECS
        }
    }
}
finally {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

    $durationMin = [math]::Round(((Get-Date) - $overallStart).TotalMinutes, 1)
    $status = [ordered]@{
        completed_at = (Get-Date).ToString('o')
        success      = $success
        attempts     = $attempt
        last_exit    = $lastExit
        duration_min = $durationMin
        log_file     = $logFile
    } | ConvertTo-Json
    Set-Content -Path $statusFile -Value $status -Encoding utf8

    Write-Log "DONE success=$success attempts=$attempt duration=${durationMin}min"
}

if ($success) { exit 0 } else { exit 1 }
