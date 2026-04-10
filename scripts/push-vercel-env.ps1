param(
  [string[]]$Environments = @('production'),
  [switch]$Overwrite
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path '.env.local')) {
  throw '.env.local not found in project root.'
}

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  throw 'Vercel CLI not found. Install with: npm i -g vercel'
}

function Parse-DotEnvLine {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  $trimmed = $Line.Trim()
  if ($trimmed.StartsWith('#')) { return $null }

  $idx = $trimmed.IndexOf('=')
  if ($idx -lt 1) { return $null }

  $key = $trimmed.Substring(0, $idx).Trim()
  $value = $trimmed.Substring($idx + 1)

  # Strip optional wrapping quotes only.
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  if ([string]::IsNullOrWhiteSpace($key)) { return $null }
  return [pscustomobject]@{ Key = $key; Value = $value }
}

$entries = @()
Get-Content '.env.local' | ForEach-Object {
  $parsed = Parse-DotEnvLine -Line $_
  if ($null -ne $parsed) {
    $entries += $parsed
  }
}

if ($entries.Count -eq 0) {
  throw 'No env entries found in .env.local.'
}

Write-Host "Found $($entries.Count) env vars in .env.local"

foreach ($envName in $Environments) {
  Write-Host "\nPushing vars to environment: $envName"

  foreach ($entry in $entries) {
    if ($Overwrite) {
      # Remove existing var if present, ignore failures when missing.
      & vercel env rm $entry.Key $envName --yes 2>$null | Out-Null
    }

    $entry.Value | & vercel env add $entry.Key $envName | Out-Null
    Write-Host "Added $($entry.Key) -> $envName"
  }
}

Write-Host '\nDone. Env vars pushed to Vercel.'
