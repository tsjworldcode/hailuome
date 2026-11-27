<#
.SYNOPSIS
  强制把 deploy-login-card / token 中的站主凭证写入 D1，并校验登录。

.EXAMPLE
  .\scripts\reset-owner-login.ps1
#>
param(
  [string]$TokenFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptsDir "..")).Path
if ($TokenFile -eq "") { $TokenFile = Join-Path $ScriptsDir "cloudflare-api-token.json" }

if (-not (Test-Path $TokenFile)) { throw "未找到 $TokenFile" }
$config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json

$user = [string]$config.OWNER_LOGIN_USERNAME
$pass = [string]$config.OWNER_LOGIN_PASSWORD
if ([string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($pass)) {
  throw "token 缺少 OWNER_LOGIN_USERNAME / OWNER_LOGIN_PASSWORD"
}

if ($config.CLOUDFLARE_ACCOUNT_ID) { $env:CLOUDFLARE_ACCOUNT_ID = [string]$config.CLOUDFLARE_ACCOUNT_ID }
if ($config.CLOUDFLARE_API_TOKEN) { $env:CLOUDFLARE_API_TOKEN = [string]$config.CLOUDFLARE_API_TOKEN }
$env:OWNER_SEED_USERNAME = $user
$env:OWNER_SEED_PASSWORD = $pass
$env:CI = "true"

Write-Host ""
Write-Host "==== Force reset owner login (D1 production) ====" -ForegroundColor Cyan
Write-Host "username: $user"
Write-Host "note: DELETE owner_credentials + owner_sessions then INSERT; wrangler remote ~1-3 min, do not Ctrl+C" -ForegroundColor Yellow
Write-Host "警告：重置会换全新 salt — 旧保险箱外层将无法解开，登录后需在设置页「重建保险箱」。" -ForegroundColor Yellow
Write-Host ""

$seed = Join-Path $RepoRoot "apps\worker-a\scripts\seed-default-owner.mjs"
& node $seed --production --force --yes --from-env
if ($LASTEXITCODE -ne 0) { throw "seed-default-owner.mjs failed" }

$verify = Join-Path $ScriptsDir "verify-owner-login.mjs"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $verifyOut = & node $verify --token-file $TokenFile 2>&1 | Out-String
  $verifyExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $prevEap
}
Write-Host $verifyOut.TrimEnd()
if ($verifyExit -ne 0) {
  if ($verifyExit -eq 2 -or ($verifyOut -match 'fetch failed|network|网络|ECONNREFUSED|ETIMEDOUT|ENOTFOUND')) {
    Write-Host ""
    Write-Host "WARN: D1 seed OK, but this PC cannot reach Worker A (workers.dev timeout/blocked)." -ForegroundColor Yellow
    Write-Host "      Try VPN/proxy, then: curl.exe -m 15 https://...workers.dev/health" -ForegroundColor Yellow
    Write-Host "      Or log in via browser (incognito) on Pages with deploy-login-card.txt credentials." -ForegroundColor Yellow
    exit 0
  }
  throw "verify-owner-login failed"
}

Write-Host ""
Write-Host "OK: owner credentials reset and login verified. Use incognito to open Pages." -ForegroundColor Green
