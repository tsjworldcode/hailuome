<#
.SYNOPSIS
  hailuo-node: npm ci -> (缺 B 时 stub 部署 B) -> Worker A (migrate + deploy) -> seed owner -> Worker B 全量.
  DEPLOY-SB-10143：A↔B 互指 Service Binding；空账号先 A 会报 10143，故先 bootstrap-worker-b-peer。

.PARAMETER TokenFile
  Optional token file for post-deploy /health checks.

.PARAMETER SkipMigrations
  Skip Worker A D1 migrations (not recommended).

.PARAMETER SkipSmoke
  Skip post-deploy /health checks.

.PARAMETER DryRun
  npm ci + typecheck only, no deploy.

.PARAMETER ForceResetOwnerCredentials
  显式允许把 token 里的站主凭证**强制写回** D1（`seed-default-owner --force`）。
  默认关闭：部署**永不**因为卡片凭证登录失败而重置站主密码。
  警告：`--force` 会换全新 salt 覆盖 owner_credentials，旧保险箱外层随之失效（需在设置页重建）。

.EXAMPLE
  .\scripts\deploy-hailuo-workers.ps1 -TokenFile scripts\cloudflare-api-token.json

.EXAMPLE
  # 忘记站主密码、确认要重置成 token 里的凭证（会换 salt，旧保险箱需重建）
  .\scripts\deploy-hailuo-workers.ps1 -TokenFile scripts\cloudflare-api-token.json -ForceResetOwnerCredentials
#>
param(
  [string]$TokenFile = "",
  [switch]$SkipMigrations,
  [switch]$SkipSmoke,
  [switch]$DryRun,
  [switch]$ForceResetOwnerCredentials
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot
. (Join-Path $ScriptsDir "deploy-network.ps1")
$RepoRoot = (Resolve-Path (Join-Path $ScriptsDir "..")).Path
if ($TokenFile -eq "") { $TokenFile = Join-Path $ScriptsDir "cloudflare-api-token.json" }

function Step([string]$t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Magenta }
function Ok([string]$m) { Write-Host "  OK $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  WARN $m" -ForegroundColor Yellow }

function Get-ConfigValue($config, [string[]]$names) {
  foreach ($name in $names) {
    if ($null -ne $config.PSObject.Properties[$name]) {
      $v = [string]$config.$name
      if (-not [string]::IsNullOrWhiteSpace($v)) { return $v.TrimEnd("/") }
    }
  }
  return ""
}

function Invoke-OwnerLoginVerify([string]$VerifyScript, [string]$TokenPath, [string]$ConfigProxy = '') {
  Sync-NodeProxyFromWindows -ConfigProxy $ConfigProxy | Out-Null
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $verifyOut = & node $VerifyScript --token-file $TokenPath 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and ($verifyOut -match 'fetch failed|network|网络|ECONNREFUSED|ETIMEDOUT|ENOTFOUND')) {
      Start-Sleep -Seconds 5
      $verifyOut = & node $VerifyScript --token-file $TokenPath 2>&1 | Out-String
      $exitCode = $LASTEXITCODE
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($verifyOut.Trim()) { Write-Host (Strip-Ansi $verifyOut.TrimEnd()) }
  if ($exitCode -eq 0) { return $true }
  if ($exitCode -eq 2 -or ($verifyOut -match 'fetch failed|network|网络|ECONNREFUSED|ETIMEDOUT|ENOTFOUND')) {
    Warn "verify-owner-login skipped (Node cannot reach Worker A; D1 seed OK — use browser login or npm run smoke:remote)"
    return $true
  }
  return $false
}

$config = $null
if (Test-Path $TokenFile) {
  $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.CLOUDFLARE_ACCOUNT_ID) { $env:CLOUDFLARE_ACCOUNT_ID = [string]$config.CLOUDFLARE_ACCOUNT_ID }
  if ($config.CLOUDFLARE_API_TOKEN) { $env:CLOUDFLARE_API_TOKEN = [string]$config.CLOUDFLARE_API_TOKEN }
}

Step "Install dependencies (monorepo root)"
Push-Location $RepoRoot
try {
  Invoke-InstallDependencies $RepoRoot

  Step "typecheck"
  $typecheckCode = Invoke-NpmCapture { & npm run typecheck }
  if ($typecheckCode -ne 0) { throw "typecheck failed" }
  Ok "typecheck"

  if ($DryRun) {
    Warn "DryRun: skip deploy"
    return
  }

  $env:CI = "true"

  # 密钥门禁：token 私钥必须与公钥成对，且与 D1 users.pubkey 一致；
  # 不一致时中止，避免部署出“公钥正常但私钥签名验不过”的节点。
  Step "Worker A: verify Ed25519 key pair (token / D1)"
  $keyCheck = Join-Path $ScriptsDir "check-local-ed25519-pair.mjs"
  if (Test-Path $keyCheck) {
    $keyCode = Invoke-NpmCapture { & node $keyCheck --token-file $TokenFile }
    if ($keyCode -ne 0) {
      throw "Ed25519 key pair mismatch (token vs D1 users.pubkey). Fix the key pair before deploying."
    }
    Ok "Ed25519 key pair verified"
  } else {
    Warn "check-local-ed25519-pair.mjs missing; skip Ed25519 key gate"
  }

  # DEPLOY-SB-10143：账号上若还没有 Worker B，先 stub 部署（临时去掉 B→A 绑定），
  # 否则下一步 deploy A 会因 Service Binding 指向不存在的 B 报 10143。
  Step "Worker B: peer bootstrap (skip if exists; else stub without WORKER_A binding)"
  $peerScript = Join-Path $ScriptsDir "bootstrap-worker-b-peer.mjs"
  $peerCode = Invoke-NpmCapture { & node $peerScript --token-file $TokenFile }
  if ($peerCode -ne 0) { throw "bootstrap-worker-b-peer.mjs failed" }
  Ok "Worker B peer ready"

  if (-not $SkipMigrations) {
    # A7-DB-RETIRE：不再 apply 遗留 binding=DB；先 DB_IMPORT（全表 staging）再三库。
    Step "Worker A: migrate DB_IMPORT (staging full schema)"
    $importExit = Invoke-WranglerWithRetry -WranglerArgs @(
      'd1', 'migrations', 'apply', 'DB_IMPORT',
      '--remote',
      '--env', 'production',
      '--config', 'apps/worker-a/wrangler.toml'
    ) -Label "worker-a DB_IMPORT migrations apply" -MaxAttempts 3
    if ($importExit -ne 0) {
      Warn "Worker A DB_IMPORT migration 失败；确认 bootstrap/手工已创建 import 库且 wrangler 含 migrations_dir=db/migrations。"
      throw "Worker A DB_IMPORT migration failed"
    }
    Ok "Worker A DB_IMPORT migrations applied"

    # ── 三库拆分（M-OPT-SPLIT · IDENTITY / GOVERNANCE / CONTENT）────────────────
    foreach ($d1Binding in @('IDENTITY_DB', 'GOVERNANCE_DB', 'CONTENT_DB')) {
      Step "Worker A: migrate $d1Binding (M-OPT-SPLIT)"
      $bindingExit = Invoke-WranglerWithRetry -WranglerArgs @(
        'd1', 'migrations', 'apply', $d1Binding,
        '--remote',
        '--env', 'production',
        '--config', 'apps/worker-a/wrangler.toml'
      ) -Label "worker-a $d1Binding migrations apply" -MaxAttempts 3
      if ($bindingExit -ne 0) {
        Warn "Worker A $d1Binding migration 失败；确认 bootstrap 已创建对应 D1 且 wrangler.toml 含 migrations_dir。"
        throw "Worker A $d1Binding migration failed"
      }
      Ok "Worker A $d1Binding migrations applied"
    }

    foreach ($d1Binding in @('MESSAGING_DB', 'MESSAGING_SHARD_1')) {
      Step "Worker A: migrate $d1Binding"
      $bindingExit = Invoke-WranglerWithRetry -WranglerArgs @(
        'd1', 'migrations', 'apply', $d1Binding,
        '--remote',
        '--env', 'production',
        '--config', 'apps/worker-a/wrangler.toml'
      ) -Label "worker-a $d1Binding migrations apply" -MaxAttempts 3
      if ($bindingExit -ne 0) {
        Warn "Worker A $d1Binding migration 失败；确认 binding 已在 wrangler.toml 配置且 bootstrap 已创建对应 D1。"
        throw "Worker A $d1Binding migration failed"
      }
      Ok "Worker A $d1Binding migrations applied"
    }

    Ok "Worker A migrations applied"

    Step "Worker A: deploy"
    $deployAExit = Invoke-WranglerWithRetry -WranglerArgs @(
      'deploy',
      '--env', 'production',
      '--config', 'apps/worker-a/wrangler.toml'
    ) -Label "worker-a deploy" -MaxAttempts 3
    if ($deployAExit -ne 0) { throw "Worker A deploy failed" }
    Ok "Worker A deployed"
  } else {
    Step "Worker A: deploy only (SkipMigrations)"
    $deployAExit = Invoke-WranglerWithRetry -WranglerArgs @(
      'deploy',
      '--env', 'production',
      '--config', 'apps/worker-a/wrangler.toml'
    ) -Label "worker-a deploy" -MaxAttempts 3
    if ($deployAExit -ne 0) { throw "Worker A deploy failed" }
    Ok "Worker A deployed (migrations skipped)"
  }

  Step "Worker A: seed owner_credentials (--if-empty, then verify)"
  $seedScript = Join-Path $RepoRoot "apps\worker-a\scripts\seed-default-owner.mjs"
  $loginUser = ""
  $loginPass = ""
  if ($null -ne $config) {
    if ($config.PSObject.Properties["OWNER_LOGIN_USERNAME"]) { $loginUser = [string]$config.OWNER_LOGIN_USERNAME }
    if ($config.PSObject.Properties["OWNER_LOGIN_PASSWORD"]) { $loginPass = [string]$config.OWNER_LOGIN_PASSWORD }
  }
  if ([string]::IsNullOrWhiteSpace($loginUser)) { $loginUser = "admin"; $loginPass = "admin" }
  $env:OWNER_SEED_USERNAME = $loginUser
  $env:OWNER_SEED_PASSWORD = $loginPass
  try {
    # seed 内部调 wrangler；stderr WARNING 在 PS Stop 下会冒成终止错误（与 npm/wrangler 同类）
    $seedCode = Invoke-NpmCapture { & node $seedScript --production --if-empty --yes --from-env }
    if ($seedCode -ne 0) { throw "seed-default-owner.mjs failed" }

    # 资源名升级后 token URL 可能为空；finalize 在 Phase 3 才写回，此处先按项目名解析
    $resolveScript = Join-Path $ScriptsDir "resolve-deploy-worker-urls.mjs"
    if (Test-Path $resolveScript) {
      $resolveCode = Invoke-NpmCapture { & node $resolveScript --token-file $TokenFile }
      if ($resolveCode -ne 0) { throw "resolve-deploy-worker-urls.mjs failed" }
      $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    $verifyScript = Join-Path $RepoRoot "scripts\verify-owner-login.mjs"
    if (Test-Path $verifyScript) {
      $httpProxy = if ($null -ne $config) { Get-ConfigValue $config @("HTTP_PROXY") } else { "" }
      $verified = Invoke-OwnerLoginVerify $verifyScript $TokenFile $httpProxy
      if (-not $verified) {
        # OWNER-RESET-GUARD：卡片凭证登录失败**不得**自动重置 D1 密码。
        # 旧实现会无提示执行 seed --force（DELETE + 新 salt），把站主自己改过的密码打回 admin/admin，
        # 并让 owner_wrapped_vault 因 salt 变化永久解不开（表现为「保险箱外层更新失败」）。
        if ($ForceResetOwnerCredentials) {
          Warn "已指定 -ForceResetOwnerCredentials：重置站主凭证为 token 值（会换 salt；旧保险箱需在设置页重建）"
          $forceCode = Invoke-NpmCapture { & node $seedScript --production --force --yes --from-env }
          if ($forceCode -ne 0) { throw "seed-default-owner.mjs --force failed" }
          $verified = Invoke-OwnerLoginVerify $verifyScript $TokenFile $httpProxy
          if (-not $verified) {
            throw "owner login verify still failed; check token WORKER_A_URL and D1 binding"
          }
          Ok "owner credentials force-reset and verified"
        } else {
          # 不重置、不中断部署：只提示如何显式恢复
          Warn "token 里的站主凭证无法登录现有 D1（很可能你已改过密码）。已跳过自动重置。"
          Warn "确需重置：.\scripts\reset-owner-login.ps1（会换 salt，旧保险箱需在设置页重建）"
          Warn "或用 .\scripts\deploy-all.ps1 -ForceResetOwnerCredentials 显式授权本次部署重置"
        }
      } else {
        Ok "owner credentials seeded (see deploy-login-card.txt)"
      }
    } else {
      Ok "owner credentials seeded (no verify script)"
    }
  } finally {
    Remove-Item Env:OWNER_SEED_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:OWNER_SEED_PASSWORD -ErrorAction SilentlyContinue
  }

  Step "Worker B: deploy"
  $deployBExit = Invoke-WranglerWithRetry -WranglerArgs @(
    'deploy',
    '--env', 'production',
    '--config', 'apps/worker-b/wrangler.toml'
  ) -Label "worker-b deploy" -MaxAttempts 3
  if ($deployBExit -ne 0) { throw "Worker B deploy failed" }
  Ok "Worker B deployed"

  # DEPLOY-SECRET-WIPED：Secret 挂在 Worker 脚本上；清空/重建 Worker 后本地
  # .deploy-secrets-manifest.json 仍会「指纹未变跳过」，导致 JWT_SECRET 缺失 → 登录 500。
  # 对齐 CI ci-put-secrets：Worker 已存在后再强制 put（put-worker-secrets 不读 manifest）。
  Step "Worker secrets: put after deploy (align CI; survive Worker recreate)"
  $putSecrets = Join-Path $ScriptsDir "put-worker-secrets.mjs"
  $putCode = Invoke-NpmCapture { & node $putSecrets }
  # DEPLOY-SECRET-RETRY：脚本内部已对 `fetch failed` 重试并用 `secret list` 校验；
  # 只有核心密钥（JWT_SECRET / INTERNAL_FORWARD_SECRET / ED25519_PRIVATE_KEY / REGISTRY_URL）
  # 真缺才 exit 1，非核心缺键只告警。此处文案不得再写死 JWT_SECRET。
  if ($putCode -ne 0) { throw "put-worker-secrets.mjs failed（见上方 [fail] 行；核心密钥缺失会导致登录 500）" }
  Ok "Worker secrets put"
}
finally {
  Pop-Location
}

if (-not $SkipSmoke -and $null -ne $config) {
  $bHost = Get-ConfigValue $config @("WORKER_B_HOST", "WORKER_B_URL")
  if ($bHost) {
    Step "post-deploy /health"
    try {
      $hb = Invoke-RestMethod -Uri "$bHost/health" -Method Get -TimeoutSec 30
      if ($hb.ok -and $hb.service -eq "worker-b") { Ok "Worker B /health" } else { throw "unexpected B health" }
    } catch {
      Warn "Worker B /health failed: $($_.Exception.Message)"
    }
    Ok "Worker A is verified through Worker B Service Binding / full smoke (public workers.dev may be disabled)"
    Write-Host "  full smoke: npm run smoke:remote"
  }
}

Ok "Workers deploy finished"
