<#
.SYNOPSIS
  海螺节点本地一键部署：Bootstrap → Worker A/B → finalize → 构建 Web → 部署 Pages（Owner Gateway）。

.DESCRIPTION
  **本地唯一推荐入口**：`.\scripts\deploy-all.ps1`（覆盖 Worker + Pages/Web，不可跳过 Pages）。
  与 GitHub Actions / `npm run deploy:ci` 同序同脚本族；本脚本供 Windows 本机。
  读取 scripts/cloudflare-api-token.json（勿提交 git）。
  M9-23/M9-24 生产路径要求必须部署 Pages（含 Owner Gateway）；不支持跳过 Pages 或 PAGES_DEPLOY=false。
  DEPLOY-SB-10143：Phase 2 内经 deploy-hailuo-workers 先 bootstrap-worker-b-peer，再 A→seed→B。

.PARAMETER TokenFile
  API Token JSON 路径。

.PARAMETER SkipSecrets
  Bootstrap 跳过 secret put。

.PARAMETER SkipMigrations
  Worker A 跳过 migration apply。

.PARAMETER DryRun
  仅 typecheck，不创建资源、不 deploy。

.PARAMETER New
  基于当前 TokenFile 重新生成一个全新的海螺节点；保留 Cloudflare/注册中心等公共配置，
  清空节点身份、Worker/Pages/D1/KV 名称与 ID、URL、节点密钥后重新创建资源。

.PARAMETER ForceResetOwnerCredentials
  显式允许把 token 里的站主凭证写回 D1（覆盖你已改过的密码）。
  默认关闭；部署不会因为卡片凭证登录失败而重置站主。重置会换 salt，旧保险箱需在设置页重建。

.EXAMPLE
  Copy-Item scripts\cloudflare-api-token.example.json scripts\cloudflare-api-token.json
  # 编辑 json 后：
  .\scripts\deploy-all.ps1

.EXAMPLE
  # 不删除旧 Cloudflare 资源，使用同一个 token 文件重新创建一个新节点
  .\scripts\deploy-all.ps1 -New
#>
param(
  [string]$TokenFile = "",
  [switch]$SkipSecrets,
  [switch]$SkipMigrations,
  [switch]$DryRun,
  [switch]$New,
  [switch]$ForceResetOwnerCredentials,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot
. (Join-Path $ScriptsDir "deploy-network.ps1")
$RepoRoot = (Resolve-Path (Join-Path $ScriptsDir "..")).Path
$ForceNewNode = [bool]$New
if (([string]$TokenFile).Trim().ToLowerInvariant() -eq "new") {
  $ForceNewNode = $true
  $TokenFile = ""
}
foreach ($arg in $RemainingArgs) {
  if (([string]$arg).Trim().ToLowerInvariant() -eq "new") {
    $ForceNewNode = $true
  } elseif (-not [string]::IsNullOrWhiteSpace($arg)) {
    throw "未知参数: $arg；如需新建节点请使用 -New"
  }
}
if ($TokenFile -eq "") { $TokenFile = Join-Path $ScriptsDir "cloudflare-api-token.json" }

function Step([string]$t) { Write-Host "`n══════ $t ══════" -ForegroundColor Magenta }
function Ok([string]$m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  ⚠ $m" -ForegroundColor Yellow }

function Get-ConfigValue($config, [string[]]$names, [string]$default = "") {
  foreach ($name in $names) {
    if ($null -ne $config.PSObject.Properties[$name]) {
      $v = [string]$config.$name
      if (-not [string]::IsNullOrWhiteSpace($v)) { return $v }
    }
  }
  return $default
}

function To-BoolConfig($value, [bool]$default = $false) {
  if ($null -eq $value) { return $default }
  $t = ([string]$value).Trim().ToLowerInvariant()
  if ($t -in @("1", "true", "yes", "y", "on")) { return $true }
  return $default
}

function Write-JsonUtf8NoBom($Value, [string]$Path, [int]$Depth = 5) {
  $jsonText = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $jsonText + "`n", [System.Text.UTF8Encoding]::new($false))
}

function Reset-NodeSpecificDeployConfig($config, [string]$Path) {
  $backupPath = "$Path.before-new"
  Copy-Item -LiteralPath $Path -Destination $backupPath -Force

  $keys = @(
    "BOOTSTRAP_HANDLE",
    "DEPLOY_GROUP_CODE",
    "WORKER_A_RESOURCE_ID",
    "WORKER_B_RESOURCE_ID",
    "PAGES_RESOURCE_ID",
    "DEPLOY_RESOURCE_ID",
    "WORKER_A_NAME",
    "WORKER_B_NAME",
    "PAGES_PROJECT_NAME",
    "OWNER_LOGIN_USERNAME",
    "OWNER_LOGIN_PASSWORD",
    "JWT_SECRET",
    "INTERNAL_FORWARD_SECRET",
    "ED25519_PUBLIC_KEY",
    "ED25519_PRIVATE_KEY",
    "WORKER_A_HOST",
    "WORKER_A_URL",
    "WORKER_B_HOST",
    "WORKER_B_URL",
    "PAGES_URL",
    "WORKER_A_ORIGIN",
    # M7-40-b（2026-10-21）：legacy 库已删，D1_DATABASE_NAME/ID 不再保留（勿再当权威库查）
    "MESSAGING_D1_DATABASE_NAME",
    "MESSAGING_D1_DATABASE_ID",
    "MESSAGING_SHARD_D1_DATABASE_NAME",
    "MESSAGING_SHARD_D1_DATABASE_ID",
    "IDENTITY_DATABASE_NAME",
    "IDENTITY_DATABASE_ID",
    "GOVERNANCE_DATABASE_NAME",
    "GOVERNANCE_DATABASE_ID",
    "CONTENT_DATABASE_NAME",
    "CONTENT_DATABASE_ID",
    "POSTS_CACHE_KV_NAME",
    "POSTS_CACHE_KV_ID",
    "IMAGE_KV_NAME",
    "IMAGE_KV_ID",
    "STATE_KV_NAME",
    "STATE_KV_ID",
    "HAILUO_R2_STATUS",
    "HAILUO_R2_BUCKET",
    "HAILUO_R2_REASON"
  )

  foreach ($key in $keys) {
    $config | Add-Member -NotePropertyName $key -NotePropertyValue "" -Force
  }

  # HMAC_SECRET / REGISTRY_URL（secret put）/ Turnstile / Cloudflare Token 属于公共部署配置，保留不动。
  Write-JsonUtf8NoBom $config $Path
  Warn "New 模式：已清空节点专属配置并备份原 token 到 $(Split-Path $backupPath -Leaf)；旧 Cloudflare 资源不会被删除"
  return $config
}

function Ensure-PagesProject([string]$TokenPath, [string]$Branch) {
  $ensureScript = Join-Path $ScriptsDir "ensure-pages-project.mjs"
  if (-not (Test-Path $ensureScript)) {
    throw "未找到 ensure-pages-project.mjs"
  }
  $code = Invoke-NpmCapture { & node $ensureScript --token-file $TokenPath --branch $Branch }
  if ($code -ne 0) {
    throw "Pages 项目准备失败（Cloudflare API）；可在控制台手动创建后重跑 deploy-all.ps1"
  }
}

function Assert-M9PagesProductionRequired($config) {
  # M9-23：站主写层经 Pages Owner Gateway；旧 token 若仍写 PAGES_DEPLOY=false 则直接失败。
  $pagesDeployRaw = Get-ConfigValue $config @("PAGES_DEPLOY")
  if (-not [string]::IsNullOrWhiteSpace($pagesDeployRaw) -and -not (To-BoolConfig $pagesDeployRaw $true)) {
    throw "PAGES_DEPLOY=false 已废止（M9-23 要求必须部署 Pages Owner Gateway）。请从 token 文件删除 PAGES_DEPLOY 字段后重试"
  }
  $project = Get-ConfigValue $config @("PAGES_PROJECT_NAME")
  if ([string]::IsNullOrWhiteSpace($project)) {
    throw "未配置 PAGES_PROJECT_NAME：M9-23 生产路径要求部署 Pages（含 Owner Gateway）"
  }
}

function Assert-DeployConfigConsistency([string]$Root) {
  # SDH-3 / M-WORKFLOW-SDH-1：Bootstrap/finalize 写回真 id 后用 post-patch（禁洁净仓绝对占位断言）
  Push-Location $Root
  try {
    $code = Invoke-NpmCapture { & npm run test:deploy-config-consistency:post-patch }
    if ($code -ne 0) {
      throw "部署配置一致性检查失败（npm run test:deploy-config-consistency:post-patch）：Worker A/B wrangler 组码、KV id、Service Binding、LOGIN_DIAG 等未对齐；请查看上方 fail 并核对 token/bootstrap 配置"
    }
    Ok "deploy config consistency（post-patch）：Worker A/B wrangler 静态校验通过"
  } finally {
    Pop-Location
  }
}

function Deploy-Pages($config) {
  Assert-M9PagesProductionRequired $config
  $project = Get-ConfigValue $config @("PAGES_PROJECT_NAME")
  $branch = Get-ConfigValue $config @("PAGES_BRANCH") "main"
  $workerB = (Get-ConfigValue $config @("WORKER_B_HOST", "WORKER_B_URL")).TrimEnd("/")

  Push-Location $RepoRoot
  try {
    Step "Pages：构建 web"
    Invoke-InstallDependencies $RepoRoot
    if ($workerB) { $env:PUBLIC_WORKER_B_URL = $workerB }
    $registry = (Get-ConfigValue $config @("REGISTRY_URL")).TrimEnd("/")
    if ($registry) { $env:PUBLIC_REGISTRY_URL = $registry }
    $buildCode = Invoke-NpmCapture { & npm run build --workspace=web }
    if ($buildCode -ne 0) { throw "web build failed" }
    Ok "web/dist built"

    $dist = Join-Path $RepoRoot "web\dist"
    if (-not (Test-Path $dist)) { throw "web/dist not found" }

    if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
      $env:CLOUDFLARE_API_TOKEN = Get-ConfigValue $config @("CLOUDFLARE_API_TOKEN")
    }
    if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) {
      $env:CLOUDFLARE_ACCOUNT_ID = Get-ConfigValue $config @("CLOUDFLARE_ACCOUNT_ID")
    }
    Sync-NodeProxyFromWindows -ConfigProxy (Get-ConfigValue $config @("HTTP_PROXY")) | Out-Null
    $env:CI = "true"

    Ensure-PagesProject $TokenFile $branch
    Ok "Pages project ready: $project"

    $deployExit = Invoke-WranglerWithRetry -WranglerArgs @(
      'pages', 'deploy', $dist,
      '--project-name', $project,
      '--branch', $branch,
      '--commit-dirty=true',
      '--commit-message', 'deploy-all.ps1'
    ) -WorkingDirectory (Join-Path $RepoRoot "web") -Label "pages deploy $project" -MaxAttempts 3
    if ($deployExit -ne 0) { throw "wrangler pages deploy failed" }
    Ok "Pages deployed: $project"
    if ($workerB) {
      Ok "injected PUBLIC_WORKER_B_URL=$workerB (build env + deploy-env.json)"
    }
    if ($registry) {
      Ok "injected PUBLIC_REGISTRY_URL=$registry (register page Turnstile iframe)"
    }
    return $true
  } finally {
    Pop-Location
    Remove-Item Env:PUBLIC_WORKER_B_URL -ErrorAction SilentlyContinue
    Remove-Item Env:PUBLIC_REGISTRY_URL -ErrorAction SilentlyContinue
  }
}

$start = Get-Date
try {
  Step "前置检查"
  if (-not (Test-Path $TokenFile)) {
    throw "未找到 $TokenFile`n请: Copy-Item scripts\cloudflare-api-token.example.json scripts\cloudflare-api-token.json"
  }
  $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ForceNewNode) {
    $config = Reset-NodeSpecificDeployConfig $config $TokenFile
  }
  $env:CLOUDFLARE_API_TOKEN = Get-ConfigValue $config @("CLOUDFLARE_API_TOKEN")
  $env:CLOUDFLARE_ACCOUNT_ID = Get-ConfigValue $config @("CLOUDFLARE_ACCOUNT_ID")
  # 缺 Account ID 时留给 Phase 1 bootstrap（同源 ci-ensure GET /accounts）探测并写回 token；此处仅提醒
  if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
    throw "cloudflare-api-token.json 缺少 CLOUDFLARE_API_TOKEN"
  }
  if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_ACCOUNT_ID)) {
    Warn "CLOUDFLARE_ACCOUNT_ID 为空 — Bootstrap 将用 API Token 自动探测并写回 token 文件（与 GitHub CI 同源）"
  }
  Sync-NodeProxyFromWindows -ConfigProxy (Get-ConfigValue $config @("HTTP_PROXY")) | Out-Null
  Ok "Token file loaded"

  if ($DryRun) {
    & (Join-Path $ScriptsDir "deploy-hailuo-workers.ps1") -TokenFile $TokenFile -DryRun
    Warn "DryRun 完成（未 Bootstrap / 未 Pages）"
    exit 0
  }

  Step "Phase 1：Bootstrap（D1/KV/Secret/TOML + migrations inline）"
  $bootArgs = @{ TokenFile = $TokenFile }
  if ($SkipSecrets) { $bootArgs.SkipSecrets = $true }
  if ($SkipMigrations) { $bootArgs.SkipMigrations = $true }
  # Migrations 在 bootstrap 内 patch TOML 后立即执行；wrangler deploy 的 git checkout 不影响已完成步骤。
  Invoke-SubScriptCapture -Command { & (Join-Path $ScriptsDir "bootstrap-hailuo-cloudflare.ps1") @bootArgs } -Label "Bootstrap"
  $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
  # bootstrap 可能刚写回探测到的 Account ID — 刷新本进程 env，供后续 Pages / wrangler
  $env:CLOUDFLARE_ACCOUNT_ID = Get-ConfigValue $config @("CLOUDFLARE_ACCOUNT_ID")
  $env:CLOUDFLARE_API_TOKEN = Get-ConfigValue $config @("CLOUDFLARE_API_TOKEN")
  $deployGroupCode = Get-ConfigValue $config @("DEPLOY_GROUP_CODE")
  if (-not [string]::IsNullOrWhiteSpace($deployGroupCode)) {
    # 同一海螺节点的 Web / Worker A / Worker B / D1 / KV 资源名都带同一个 6 位码。
    Ok "节点同组码: $deployGroupCode（Web / Worker A / Worker B / D1 / KV 名称中的 UUID 前缀一致）"
  }
  $r2Status = Get-ConfigValue $config @("HAILUO_R2_STATUS")
  if ($r2Status -eq "bound") {
    Ok "图片对象库: $(Get-ConfigValue $config @('HAILUO_R2_BUCKET'))"
  } elseif (-not [string]::IsNullOrWhiteSpace($r2Status)) {
    Warn "图片对象库未绑定，继续用 KV（$(Get-ConfigValue $config @('HAILUO_R2_REASON'))）"
  }

  # P1-4 门禁：在 Phase 2 真部署之前，用 wrangler deploy --dry-run 检测 production 配置中是否仍含
  # prod-placeholder 字面（bootstrap patch 失败时会出现）；检测到则报错退出，不再到达 Phase 2。
  Step "Phase 1.5：wrangler deploy --dry-run 门禁（检测 prod-placeholder）"
  $dryRunFailed = $false
  foreach ($workerSpec in @(
      @{ Config = "apps/worker-a/wrangler.toml"; Name = "Worker A"; PlaceholderNames = @("hailuo-worker-a-prod-placeholder", "hailuo-worker-b-prod-placeholder") },
      @{ Config = "apps/worker-b/wrangler.toml"; Name = "Worker B"; PlaceholderNames = @("hailuo-worker-a-prod-placeholder", "hailuo-worker-b-prod-placeholder") }
    )) {
    $workerDir = Split-Path $workerSpec.Config -Parent
    $wranglerOutDir = Join-Path $env:TEMP "wrangler-dryrun-$(Split-Path $workerSpec.Config -Leaf)"
    if (Test-Path $wranglerOutDir) { Remove-Item $wranglerOutDir -Recurse -Force }
    $r = Invoke-WranglerCapture {
      Push-Location $workerDir
      try {
        & npm exec -- wrangler deploy --env production --dry-run --outdir $wranglerOutDir 2>&1 | Out-String
      } finally {
        Pop-Location
      }
    }
    $output = $r.Output
    # wrangler 输出含 ANSI 颜色码（如 `^[[32m`），在 Write-Host / regex 匹配前先脱色
    $output = Strip-Ansi $output
    if ($r.ExitCode -ne 0) {
      # wrangler 本身报错（如缺少 binding）也应阻止部署
      Warn "$($workerSpec.Name) dry-run 失败（exit=$($r.ExitCode)）：$output"
      $dryRunFailed = $true
    } else {
      # wrangler 成功但要额外扫描产物中是否有未 patch 的 placeholders
      $placeholderFound = $null
      foreach ($ph in $workerSpec.PlaceholderNames) {
        if ($output -match [regex]::Escape($ph)) {
          $placeholderFound = $ph
          break
        }
      }
      # 也扫 output JSON 文件（wrangler 会把配置摘要写进去）
      $summaryJson = Join-Path $wranglerOutDir "deploy-order.json"
      if ($placeholderFound -and (Test-Path $summaryJson)) {
        $summary = Get-Content $summaryJson -Raw -Encoding UTF8
        if ($summary -match [regex]::Escape($placeholderFound)) { $placeholderFound = $placeholderFound }
        else { $placeholderFound = $null }
      }
      if ($placeholderFound) {
        Write-Host "  FAIL $($workerSpec.Name) production 配置中含未 patch 的 placeholder: $placeholderFound" -ForegroundColor Red
        Write-Host "     这通常意味着 bootstrap Apply-DeployResourceNames patch 失败后被静默跳过。" -ForegroundColor Red
        Write-Host "     请检查 bootstrap 是否有报错，或手动运行 bootstrap-hailuo-cloudflare.ps1 确认 patch 写入成功。" -ForegroundColor Red
        $dryRunFailed = $true
      } else {
        Ok "$($workerSpec.Name) dry-run 通过（无 prod-placeholder）"
      }
    }
  }
  if ($dryRunFailed) {
    throw "wrangler deploy --dry-run 门禁失败：production 配置含未 patch 的 placeholder。请先运行 bootstrap-hailuo-cloudflare.ps1 修复后再重试 deploy-all.ps1"
  }
  Ok "Phase 1.5 门禁通过：所有 production 配置已 patch 真值"

  Step "Phase 2：Deploy Workers（migrations 已由 bootstrap 在 patch TOML 后立即执行，跳过本步骤的 migration）"
  # bootstrap 现在在 patch TOML 后立即跑 migration；wrangler deploy 的 git checkout 不会影响已完成步骤。
  # OWNER-RESET-GUARD：只有显式 -ForceResetOwnerCredentials 才允许重置站主密码。
  $workersArgs = @{ TokenFile = $TokenFile; SkipMigrations = $true }
  if ($ForceResetOwnerCredentials) { $workersArgs.ForceResetOwnerCredentials = $true }
  Invoke-SubScriptCapture -Command { & (Join-Path $ScriptsDir "deploy-hailuo-workers.ps1") @workersArgs } -Label "Workers deploy"

  Step "Phase 3：M8-8 收尾（自动 URL + Pages Production 绑定）"
  Assert-M9PagesProductionRequired $config
  $branch = Get-ConfigValue $config @("PAGES_BRANCH") "main"
  # finalize 会写 Pages Production 环境变量；首次部署需先保证项目已存在。
  Ensure-PagesProject $TokenFile $branch
  Ok "Pages project ready before finalize"
  Invoke-SubScriptCapture -Command { & (Join-Path $ScriptsDir "finalize-hailuo-deploy.ps1") -TokenFile $TokenFile -SkipLoginCard } -Label "finalize-hailuo-deploy"
  $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json

  Step "Phase 3.5：部署配置一致性门禁（SDH-3）"
  Assert-DeployConfigConsistency $RepoRoot

  Step "Phase 4：Deploy Pages（Owner Gateway，M9-23 必选）"
  Deploy-Pages $config | Out-Null

  Step "Phase 5：首次拉取官方公告（best-effort）"
  $pullCode = Invoke-NpmCapture { & node (Join-Path $ScriptsDir "pull-official-feed-once.mjs") --token-file $TokenFile }
  if ($pullCode -ne 0) {
    Warn "首次拉取官方公告脚本异常，部署继续；登录后可在设置页手动拉取"
  }

  Step "Phase 6：登录卡片"
  & (Join-Path $ScriptsDir "print-deploy-login-card.ps1") -Config $config

  # P1-4 / TOML-BAK：部署成功后自动把 A/B wrangler.toml 真值备份到 *.bak 并还原 git 占位，防误 commit 泄漏指纹
  Step "Phase 7：还原 wrangler.toml 占位（真值 → *.bak）"
  $restoreCode = Invoke-NpmCapture { & npm run restore:wrangler-placeholders }
  if ($restoreCode -ne 0) {
    Warn "自动还原占位失败（exit=$restoreCode）。Cloudflare 侧已部署成功；请立刻手动：npm run restore:wrangler-placeholders"
  } else {
    Ok "wrangler.toml 已还原占位；真值在 apps/worker-a|b/wrangler.toml.bak（gitignore）"
  }

  $dur = (Get-Date) - $start
  Step "部署完成"
  Write-Host "  耗时: $($dur.ToString('mm\:ss'))"
  Write-Host "  打开 Web 站点 → 登录页直接输入卡片上的「登录用户名/密码」（写层地址已由部署自动注入）"
  Write-Host "  完整验证: npm run smoke:remote（见 docs/升级验证.md）；部署门禁已通过 test:deploy-config-consistency"
  Write-Host "  文档: docs/部署指南.md §2.1 / §8"
  Ok "deploy-all.ps1 完成"
}
catch {
  Write-Host "`nFAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
finally {
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
}
