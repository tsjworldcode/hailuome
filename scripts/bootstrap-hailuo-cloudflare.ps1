<#
.SYNOPSIS
  海螺节点：检查/创建 D1 + KV，回填 worker-a/b wrangler.toml production 占位符，写入 Secret。

.DESCRIPTION
  安全边界（与 M8-3 一致）：
  - 不执行 d1 delete / kv namespace delete
  - Secret 经管道写入 wrangler，不打印明文
  - 修改 wrangler.toml 前备份 .bak

.PARAMETER TokenFile
  默认 scripts/cloudflare-api-token.json

.PARAMETER SkipSecrets
  跳过 wrangler secret put
#>
param(
  [string]$TokenFile = "",
  [switch]$SkipSecrets,
  [switch]$SkipMigrations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot
. (Join-Path $ScriptsDir "deploy-network.ps1")
$RepoRoot = (Resolve-Path (Join-Path $ScriptsDir "..")).Path
$SecretsManifestPath = Join-Path $ScriptsDir ".deploy-secrets-manifest.json"
$WorkerADir = Join-Path $RepoRoot "apps\worker-a"
$WorkerBDir = Join-Path $RepoRoot "apps\worker-b"
$WranglerCli = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$TomlA = Join-Path $WorkerADir "wrangler.toml"
$TomlB = Join-Path $WorkerBDir "wrangler.toml"
if ($TokenFile -eq "") { $TokenFile = Join-Path $ScriptsDir "cloudflare-api-token.json" }

function Step([string]$title) { Write-Host "`n==== $title ====" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }

function Invoke-WranglerWorkerA {
  param([Parameter(Mandatory = $true)][scriptblock]$Command)
  Push-Location $WorkerADir
  try {
    return Invoke-WranglerCapture $Command
  } finally {
    Pop-Location
  }
}

function Test-PlaceholderId([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  $v = $Value.Trim()
  if ($v -match 'placeholder|changeme|00000000|local-dev') { return $true }
  # P1-4：prod-placeholder 是 commit 入 git 的安全占位符（不是真实值）
  if ($v -match '-prod-placeholder$') { return $true }
  return $false
}

function Get-TomlProductionD1Id([string]$TomlPath, [string]$ExpectedName = "") {
  return Get-TomlProductionD1IdByBinding $TomlPath "DB" $ExpectedName
}

function Get-TomlProductionD1IdByBinding([string]$TomlPath, [string]$Binding, [string]$ExpectedName = "") {
  if (-not (Test-Path $TomlPath)) { return $null }
  $content = Get-Content -Path $TomlPath -Raw -Encoding UTF8
  $blockPattern = '(?ms)\[\[env\.production\.d1_databases\]\]\s*\r?\nbinding\s*=\s*"' + [regex]::Escape($Binding) + '"(.*?)(?=\r?\n\[\[|\r?\n\[env\.|\z)'
  if ($content -match $blockPattern) {
    $block = $Matches[1]
    if (-not [string]::IsNullOrWhiteSpace($ExpectedName)) {
      if ($block -notmatch 'database_name\s*=\s*"([^"]+)"') { return $null }
      if ($Matches[1].Trim() -ne $ExpectedName) { return $null }
    }
    if ($block -notmatch 'database_id\s*=\s*"([^"]+)"') { return $null }
    $id = $Matches[1].Trim()
    if (-not (Test-PlaceholderId $id)) { return $id }
  }
  return $null
}

function Get-TomlProductionKvId([string]$TomlPath, [string]$Binding) {
  if (-not (Test-Path $TomlPath)) { return $null }
  $content = Get-Content -Path $TomlPath -Raw -Encoding UTF8
  $pattern = '(?ms)\[\[env\.production\.kv_namespaces\]\]\s*\r?\nbinding\s*=\s*"' + [regex]::Escape($Binding) + '"\s*\r?\nid\s*=\s*"([^"]+)"'
  if ($content -match $pattern) {
    $id = $Matches[1].Trim()
    if (-not (Test-PlaceholderId $id)) { return $id }
  }
  return $null
}

function Parse-KvIdFromWranglerOutput([string]$Out) {
  if ([string]::IsNullOrWhiteSpace($Out)) { return $null }
  if ($Out -match 'id\s*=\s*"([a-f0-9]{32})"') { return $Matches[1] }
  if ($Out -match '"id"\s*:\s*"([a-f0-9]{32})"') { return $Matches[1] }
  return $null
}

function Read-JsonArrayFromWranglerOutput([string]$Out) {
  if ([string]::IsNullOrWhiteSpace($Out)) { return @() }
  $str = $Out.Trim()
  $start = $str.IndexOf("[")
  $end = $str.LastIndexOf("]")
  if ($start -lt 0 -or $end -lt $start) { return @() }
  $str = $str.Substring($start, $end - $start + 1)
  try { return ($str | ConvertFrom-Json) } catch { return @() }
}

function Get-ObjectStringProperty($Obj, [string[]]$Names) {
  if ($null -eq $Obj) { return "" }
  foreach ($name in $Names) {
    if ($null -ne $Obj.PSObject.Properties[$name]) {
      $v = [string]$Obj.$name
      if (-not [string]::IsNullOrWhiteSpace($v)) { return $v }
    }
  }
  return ""
}

function Get-KvNamespaceId($Obj) {
  return Get-ObjectStringProperty $Obj @("id")
}

function Get-KvNamespaceTitle($Obj) {
  return Get-ObjectStringProperty $Obj @("title", "name", "binding")
}

function Find-KvNamespace([array]$List, [string]$CanonicalTitle, [string[]]$TitleAliases) {
  $titles = @($CanonicalTitle) + $TitleAliases | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
  foreach ($t in $titles) {
    $found = $List | Where-Object { (Get-KvNamespaceTitle $_) -eq $t }
    if ($found) { return $found | Select-Object -First 1 }
  }
  # wrangler 在 worker-a 目录执行 namespace create 时会拼接 wrangler.toml 的 name 前缀；
  # 复用场景下兼容旧长名，新建改走 Cloudflare API 直写短 title。
  $found = @($List | Where-Object {
    $nsTitle = Get-KvNamespaceTitle $_
    $nsTitle -eq ('worker-' + $CanonicalTitle) -or $nsTitle -like ('*-' + $CanonicalTitle)
  })
  if ($found.Count -gt 0) {
    $exactShort = $found | Where-Object { (Get-KvNamespaceTitle $_) -eq $CanonicalTitle }
    if ($exactShort) { return $exactShort | Select-Object -First 1 }
    return $found | Select-Object -First 1
  }
  return $null
}

function New-CloudflareKvNamespace([string]$Title) {
  $accountId = $env:CLOUDFLARE_ACCOUNT_ID
  $token = $env:CLOUDFLARE_API_TOKEN
  if ([string]::IsNullOrWhiteSpace($accountId) -or [string]::IsNullOrWhiteSpace($token)) {
    return $null
  }
  $uri = "https://api.cloudflare.com/client/v4/accounts/$accountId/storage/kv/namespaces"
  $body = (@{ title = $Title } | ConvertTo-Json -Compress)
  $headers = @{
    Authorization = "Bearer $token"
    "Content-Type" = "application/json"
  }
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -ErrorAction Stop
    if ($resp.success -and $resp.result.id) {
      return [string]$resp.result.id
    }
  } catch {
    Warn "Cloudflare API 创建 KV '$Title' 失败: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $old
  }
  return $null
}

function Get-KvNamespaceList {
  $r = Invoke-WranglerWorkerA { npm exec -- wrangler kv namespace list --json }
  if ($r.ExitCode -ne 0) {
    $r = Invoke-WranglerWorkerA { npm exec -- wrangler kv namespace list }
    if ($r.ExitCode -ne 0) { return @() }
  }
  return @(Read-JsonArrayFromWranglerOutput $r.Output)
}

function Get-ConfigValue($config, [string[]]$names, [string]$default = "") {
  foreach ($name in $names) {
    if ($null -ne $config.PSObject.Properties[$name]) {
      $v = [string]$config.$name
      if (-not [string]::IsNullOrWhiteSpace($v)) { return $v }
    }
  }
  return $default
}

function Write-JsonUtf8NoBom($Value, [string]$Path, [int]$Depth = 5) {
  $jsonText = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $jsonText + "`n", [System.Text.UTF8Encoding]::new($false))
}

# token 里未填 / 仍是示例占位 → 视为缺失，由 Ensure-DeploySecrets 自动生成
function Test-SecretMissing([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  $v = $Value.Trim()
  if ($v -match '[<>]' -or $v -match '填写|PLACEHOLDER|yourhandle|changeme|deploy-after') { return $true }
  if ($v -match '^<.*>$') { return $true }
  return $false
}

function Ensure-DeploySecrets([psobject]$Config, [string]$TokenPath) {
  $keys = @('JWT_SECRET', 'INTERNAL_FORWARD_SECRET', 'ED25519_PUBLIC_KEY', 'ED25519_PRIVATE_KEY')
  $need = $false
  foreach ($k in $keys) {
    if (Test-SecretMissing (Get-ConfigValue $Config @($k))) { $need = $true; break }
  }
  if (-not $need) { return $Config }

  Step "自动生成部署密钥（无需手抄随机串）"
  $genScript = Join-Path $ScriptsDir "generate-deploy-secrets.mjs"
  Invoke-SubScriptCapture { & node $genScript } -Label "generate-deploy-secrets.mjs"
  $gen = (Invoke-NpmCapture -ReturnArray { & node $genScript }).Output | ConvertFrom-Json

  foreach ($k in $keys) {
    if (Test-SecretMissing (Get-ConfigValue $Config @($k))) {
      $Config | Add-Member -NotePropertyName $k -NotePropertyValue ([string]$gen.$k) -Force
    }
  }
  if (Test-SecretMissing (Get-ConfigValue $Config @("HMAC_SECRET"))) {
    $Config | Add-Member -NotePropertyName HMAC_SECRET -NotePropertyValue "" -Force
  }

  Write-JsonUtf8NoBom $Config $TokenPath
  Ok "已生成 JWT_SECRET / INTERNAL_FORWARD_SECRET / Ed25519 密钥并写回 $(Split-Path $TokenPath -Leaf)（勿提交 git）"
  return $Config
}

# R-MSG-1d：包裹 D1 中的注册中心凭证。缺了它，读登记档案时 seal 会失败，设置页报「读取登记资料失败」。
function Ensure-NodeApiTokenWrapSecret([psobject]$Config, [string]$TokenPath) {
  if (-not (Test-SecretMissing (Get-ConfigValue $Config @("NODE_API_TOKEN_WRAP_SECRET")))) {
    return $Config
  }
  $hex = (& node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  if ([string]::IsNullOrWhiteSpace($hex) -or $hex.Trim().Length -lt 32) {
    throw "生成 NODE_API_TOKEN_WRAP_SECRET 失败"
  }
  $Config | Add-Member -NotePropertyName NODE_API_TOKEN_WRAP_SECRET -NotePropertyValue $hex.Trim() -Force
  Write-JsonUtf8NoBom $Config $TokenPath
  Ok "已生成 NODE_API_TOKEN_WRAP_SECRET 并写回 token 文件（勿提交 git）"
  return $Config
}

# M12-1：包裹站主 TOTP secret。缺了它，设置页开启二次验证会 INTERNAL_ERROR（前端显示「服务暂时不可用」）。
function Ensure-TotpWrapSecret([psobject]$Config, [string]$TokenPath) {
  if (-not (Test-SecretMissing (Get-ConfigValue $Config @("TOTP_WRAP_SECRET")))) {
    return $Config
  }
  $hex = (& node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  if ([string]::IsNullOrWhiteSpace($hex) -or $hex.Trim().Length -lt 32) {
    throw "生成 TOTP_WRAP_SECRET 失败"
  }
  $Config | Add-Member -NotePropertyName TOTP_WRAP_SECRET -NotePropertyValue $hex.Trim() -Force
  Write-JsonUtf8NoBom $Config $TokenPath
  Ok "已生成 TOTP_WRAP_SECRET 并写回 token 文件（勿提交 git）"
  return $Config
}

# OWNER-KEY-1：包裹群主持钥表 key_material。缺了它，OWNER-KEY-2+ 写持钥表应 fail-closed。
function Ensure-GroupOwnerKeyWrapSecret([psobject]$Config, [string]$TokenPath) {
  if (-not (Test-SecretMissing (Get-ConfigValue $Config @("GROUP_OWNER_KEY_WRAP_SECRET")))) {
    return $Config
  }
  $hex = (& node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  if ([string]::IsNullOrWhiteSpace($hex) -or $hex.Trim().Length -lt 32) {
    throw "生成 GROUP_OWNER_KEY_WRAP_SECRET 失败"
  }
  $Config | Add-Member -NotePropertyName GROUP_OWNER_KEY_WRAP_SECRET -NotePropertyValue $hex.Trim() -Force
  Write-JsonUtf8NoBom $Config $TokenPath
  Ok "已生成 GROUP_OWNER_KEY_WRAP_SECRET 并写回 token 文件（勿提交 git）"
  return $Config
}

# SEC-6-SECRET：Worker B 媒体票据 HMAC 密钥（仅 B；线上已有则跳过，不覆盖）
function Ensure-MediaTicketSecretLocal([psobject]$Config, [string]$TokenPath) {
  if (-not (Test-SecretMissing (Get-ConfigValue $Config @("MEDIA_TICKET_SECRET")))) {
    return $Config
  }
  $hex = (& node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  if ([string]::IsNullOrWhiteSpace($hex) -or $hex.Trim().Length -lt 32) {
    throw "生成 MEDIA_TICKET_SECRET 失败"
  }
  $Config | Add-Member -NotePropertyName MEDIA_TICKET_SECRET -NotePropertyValue $hex.Trim() -Force
  Write-JsonUtf8NoBom $Config $TokenPath
  Ok "已生成 MEDIA_TICKET_SECRET 并写回 token 文件（勿提交 git；仅 Worker B）"
  return $Config
}

# M8-8：节点 handle（对外）与 Worker A 登录名（设置页）分开生成；资源名用随机 ID
function Test-LegacyDeployResourceNames([psobject]$Config) {
  $groupCode = Get-ConfigValue $Config @('DEPLOY_GROUP_CODE')
  if (-not [string]::IsNullOrWhiteSpace($groupCode) -and $groupCode -notmatch '^[a-fA-F0-9]{6}$') { return $true }

  foreach ($key in @('WORKER_A_NAME', 'WORKER_B_NAME', 'PAGES_PROJECT_NAME')) {
    $v = Get-ConfigValue $Config @($key)
    if ([string]::IsNullOrWhiteSpace($v)) { continue }
    if ($v -match '^hailuo-node-worker-[ab]-' -or $v -match '^hailuo-node-web-') { return $true }
  }
  # 旧版单 DEPLOY_RESOURCE_ID：A/B/Pages 后缀相同 → 需拆成三独立 ID
  $legacyId = Get-ConfigValue $Config @('DEPLOY_RESOURCE_ID')
  if (-not [string]::IsNullOrWhiteSpace($legacyId)) {
    $a = Get-ConfigValue $Config @('WORKER_A_NAME')
    $b = Get-ConfigValue $Config @('WORKER_B_NAME')
    $p = Get-ConfigValue $Config @('PAGES_PROJECT_NAME')
    if ($a -match [regex]::Escape($legacyId) -and $b -match [regex]::Escape($legacyId) -and $p -match [regex]::Escape($legacyId)) {
      return $true
    }
  }
  return $false
}

function Repair-TooLongDeployResourceNames([psobject]$Config) {
  $groupCode = (Get-ConfigValue $Config @('DEPLOY_GROUP_CODE')).Trim().ToLowerInvariant()
  if ($groupCode -notmatch '^[a-f0-9]{6}$') { return $false }

  $changed = $false

  function Set-ShortName([string]$NameKey, [string]$IdKey, [string]$Prefix) {
    $id = (Get-ConfigValue $Config @($IdKey)).Trim().ToLowerInvariant()
    if ($id -notmatch '^[a-f0-9]{32}$') { return $false }
    $target = "$Prefix-$groupCode-$($id.Substring(0, 28))"
    $current = Get-ConfigValue $Config @($NameKey)
    if ($current -eq $target) { return $false }
    if ($current.Length -gt 54 -or $current -match "^$([regex]::Escape($Prefix))-$groupCode-[a-fA-F0-9]{32}$") {
      $Config | Add-Member -NotePropertyName $NameKey -NotePropertyValue $target -Force
      return $true
    }
    return $false
  }

  if (Set-ShortName "WORKER_A_NAME" "WORKER_A_RESOURCE_ID" "hailuo-worker-a") { $changed = $true }
  if (Set-ShortName "WORKER_B_NAME" "WORKER_B_RESOURCE_ID" "hailuo-worker-b") { $changed = $true }
  if (Set-ShortName "PAGES_PROJECT_NAME" "PAGES_RESOURCE_ID" "hailuo-web") { $changed = $true }

  if ($changed) { Clear-StaleDeployUrls $Config }
  return $changed
}

function Clear-StaleDeployUrls([psobject]$Config) {
  foreach ($k in @(
      'WORKER_A_HOST', 'WORKER_A_URL', 'WORKER_B_HOST', 'WORKER_B_URL',
      'PAGES_URL', 'WORKER_A_ORIGIN', 'DEPLOY_RESOURCE_ID'
    )) {
    $Config | Add-Member -NotePropertyName $k -NotePropertyValue '' -Force
  }
}

function Get-DeployGroupCode([psobject]$Config) {
  $code = (Get-ConfigValue $Config @("DEPLOY_GROUP_CODE")).Trim().ToLowerInvariant()
  if ($code -match '^[a-f0-9]{6}$') { return $code }
  return ""
}

# M7-40-b（2026-10-21）：legacy 库已删除，删除 Get-DefaultD1Name 死函数（无调用方；
# 它算的是 legacy 库名 "hailuo-node-db-$groupCode"，保留只会诱导后人再查已删库）。
# 业务库名由 New-SplitD1IfAbsent 按 suffix（identity/governance/content/import）生成。

function Get-DefaultMessagingD1Name([psobject]$Config) {
  $groupCode = Get-DeployGroupCode $Config
  if ($groupCode) { return "hailuo-node-messaging-db-$groupCode" }
  return "messaging-db"
}

function Get-DefaultMessagingShardD1Name([psobject]$Config) {
  $groupCode = Get-DeployGroupCode $Config
  if ($groupCode) { return "hailuo-node-messaging-shard-1-$groupCode" }
  return "messaging-shard-1"
}

function Get-DefaultKvName([psobject]$Config, [string]$Suffix) {
  $groupCode = Get-DeployGroupCode $Config
  if ($groupCode) { return "worker-hailuo-node-$groupCode-$Suffix" }
  return "hailuo-node-$Suffix"
}

function Get-LegacyKvTitleAliases([psobject]$Config, [string]$KvNameFromConfig, [string[]]$Aliases) {
  # 带同组码的新部署必须隔离 KV，避免误命中旧版固定命名空间。
  if (-not [string]::IsNullOrWhiteSpace($KvNameFromConfig)) { return @() }
  if (Get-DeployGroupCode $Config) { return @() }
  return $Aliases
}

function Get-BootstrapHandle($config) {
  return Get-ConfigValue $config @("BOOTSTRAP_HANDLE", "OWNER_HANDLE")
}

function Ensure-DeployIdentity([psobject]$Config, [string]$TokenPath) {
  $needHandle = Test-SecretMissing (Get-BootstrapHandle $Config)
  $needLogin = Test-SecretMissing (Get-ConfigValue $Config @("OWNER_LOGIN_USERNAME")) `
    -or Test-SecretMissing (Get-ConfigValue $Config @("OWNER_LOGIN_PASSWORD"))
  $repairedResource = Repair-TooLongDeployResourceNames $Config
  $needResource = Test-SecretMissing (Get-ConfigValue $Config @("WORKER_A_NAME")) `
    -or Test-SecretMissing (Get-ConfigValue $Config @("WORKER_B_NAME")) `
    -or Test-SecretMissing (Get-ConfigValue $Config @("PAGES_PROJECT_NAME"))
  $legacyResource = Test-LegacyDeployResourceNames $Config
  if ($legacyResource) { $needResource = $true }
  if (-not $needHandle -and -not $needLogin -and -not $needResource) {
    if ($repairedResource) {
      Write-JsonUtf8NoBom $Config $TokenPath
      Ok "已修复过长 Worker/Pages 资源名（保留同组码与资源 ID，勿提交 git）"
    }
    return $Config
  }

  if ($legacyResource -and -not $needHandle -and -not $needLogin) {
    Step "升级旧版 hailuo-node-* 资源名 → hailuo-worker-a|b|web（三独立 ID + 名称内 6 位同组码；将新建 CF 资源）"
    Clear-StaleDeployUrls $Config
  } else {
    Step "自动生成节点 handle + 默认站主登录 admin/admin + 随机资源名（M8-8）"
  }
  $idScript = Join-Path $ScriptsDir "generate-deploy-identity.mjs"
  Invoke-SubScriptCapture { & node $idScript } -Label "generate-deploy-identity.mjs"
  $id = (Invoke-NpmCapture -ReturnArray { & node $idScript }).Output | ConvertFrom-Json

  if ($needHandle) {
    $Config | Add-Member -NotePropertyName BOOTSTRAP_HANDLE -NotePropertyValue ([string]$id.BOOTSTRAP_HANDLE) -Force
  }
  if (Test-SecretMissing (Get-ConfigValue $Config @("OWNER_LOGIN_USERNAME"))) {
    $Config | Add-Member -NotePropertyName OWNER_LOGIN_USERNAME -NotePropertyValue ([string]$id.OWNER_LOGIN_USERNAME) -Force
  }
  if (Test-SecretMissing (Get-ConfigValue $Config @("OWNER_LOGIN_PASSWORD"))) {
    $Config | Add-Member -NotePropertyName OWNER_LOGIN_PASSWORD -NotePropertyValue ([string]$id.OWNER_LOGIN_PASSWORD) -Force
  }
  if ($needResource) {
    # 新部署或从 hailuo-node-* 升级：A/B/Pages 各用独立 32 位 hex，名称里 UUID 前带 6 位同组码。
    $Config | Add-Member -NotePropertyName DEPLOY_GROUP_CODE -NotePropertyValue ([string]$id.DEPLOY_GROUP_CODE) -Force
    $Config | Add-Member -NotePropertyName WORKER_A_RESOURCE_ID -NotePropertyValue ([string]$id.WORKER_A_RESOURCE_ID) -Force
    $Config | Add-Member -NotePropertyName WORKER_B_RESOURCE_ID -NotePropertyValue ([string]$id.WORKER_B_RESOURCE_ID) -Force
    $Config | Add-Member -NotePropertyName PAGES_RESOURCE_ID -NotePropertyValue ([string]$id.PAGES_RESOURCE_ID) -Force
    $Config | Add-Member -NotePropertyName WORKER_A_NAME -NotePropertyValue ([string]$id.WORKER_A_NAME) -Force
    $Config | Add-Member -NotePropertyName WORKER_B_NAME -NotePropertyValue ([string]$id.WORKER_B_NAME) -Force
    $Config | Add-Member -NotePropertyName PAGES_PROJECT_NAME -NotePropertyValue ([string]$id.PAGES_PROJECT_NAME) -Force
  }

  $jsonText = $Config | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($TokenPath, $jsonText + "`n", [System.Text.UTF8Encoding]::new($false))
  Ok "已生成 handle / 默认登录 admin/admin / Worker A·B·Pages 独立资源名（名称内含 6 位同组码，勿提交 git）"
  return $Config
}

function Apply-DeployResourceNames([string]$WorkerAName, [string]$WorkerBName, [string]$TomlAPath, [string]$TomlBPath) {
  if ([string]::IsNullOrWhiteSpace($WorkerAName) -or [string]::IsNullOrWhiteSpace($WorkerBName)) { return }
  Step "回填 wrangler Worker 项目名（$WorkerAName / $WorkerBName）"

  function Update-TomlNames([string]$Path, [string]$PrimaryName, [string]$ServiceAName, [switch]$PatchService) {
    $content = Get-Content -Path $Path -Raw -Encoding UTF8
    $orig = $content
    # 替换 name = "..."（跳过 *-preview 预览环境名）
    $content = [regex]::Replace($content, '(?m)^name = "(?!hailuo-worker-[ab]-preview)([^"]+)"', "name = `"$PrimaryName`"")
    if ($PatchService) {
      # 替换 service = "..."（跳过 a-preview 预览环境名 与 b-local-placeholder 本地占位符，
      # 避免破坏 wrangler dev 时顶层 [[services]] 的占位引用）
      $content = [regex]::Replace($content, '(?m)^service = "(?!hailuo-worker-(?:a-preview|b-local-placeholder))([^"]+)"', "service = `"$ServiceAName`"")
    }
    if ($content -ne $orig) {
      [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
      # 写后立即 re-read 验证写盘成功（P1-4 防反追查：patch 失败必须显式报错）
      $verify = Get-Content -Path $Path -Raw -Encoding UTF8
      $expectedPat = [regex]::Escape($PrimaryName)
      if ($verify -notmatch "(?m)^name\s*=\s*`"$expectedPat`"") {
        throw "Apply-DeployResourceNames patch 验证失败：$Path 写入 name=$PrimaryName 后 re-read 不匹配；文件可能被只读或被外部程序还原"
      }
      Ok "Updated $(Split-Path $Path -Leaf) worker names（写后验证通过）"
    } else {
      # name/service 已是目标值（幂等跳过），不报错
      Ok "$(Split-Path $Path -Leaf) worker 名已是最新，跳过"
    }
  }

  # Worker A：替换顶层 / [env.production] 两层 [[services]] 的 service = "hailuo-worker-b-*" → worker-b 真名
  # （顶层 [[services]] 自身的 -local-placeholder 会被 service 行 regex 跳过，保护 wrangler dev）
  Update-TomlNames $TomlAPath $WorkerAName $WorkerBName -PatchService
  # Worker B：替换顶层 / [env.production] 两层 [[services]] 的 service = "hailuo-worker-a-*" → worker-a 真名
  Update-TomlNames $TomlBPath $WorkerBName $WorkerAName -PatchService
}

function Replace-InToml([string]$Path, [string]$Pattern, [string]$Replacement, [switch]$Quiet) {
  if (-not (Test-Path $Path)) { throw "wrangler.toml not found: $Path" }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  if ($content -match [regex]::Escape($Pattern)) {
    if ($content -eq $content.Replace($Pattern, $Replacement)) {
      if (-not $Quiet) { Ok "$(Split-Path $Path -Leaf) 已是目标值，跳过: $Pattern" }
      return
    }
    $content = $content.Replace($Pattern, $Replacement)
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
    Ok "Updated $(Split-Path $Path -Leaf): $Pattern → $Replacement"
  } elseif (-not $Quiet) {
    Ok "$(Split-Path $Path -Leaf) 无占位符（可能已回填）: $Pattern"
  }
}

function Set-TomlProductionKvId([string]$Path, [string]$Binding, [string]$KvId) {
  if (-not (Test-Path $Path)) { return }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  $pattern = '(\[\[env\.production\.kv_namespaces\]\]\s*\r?\nbinding\s*=\s*"' + [regex]::Escape($Binding) + '"\s*\r?\nid\s*=\s*")([^"]+)(")'
  $newContent = [regex]::Replace($content, $pattern, {
    param($m)
    $m.Groups[1].Value + $KvId + $m.Groups[3].Value
  })
  if ($newContent -ne $content) {
    [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
    # 写后 re-read 验证（TOML kv_namespaces 跨多行，[\s\S] 才能匹配换行符）
    $verify = Get-Content -Path $Path -Raw -Encoding UTF8
    $verifyPattern = '\[\[env\.production\.kv_namespaces\]\][\s\S]*?binding\s*=\s*"' + [regex]::Escape($Binding) + '"[\s\S]*?id\s*=\s*"' + [regex]::Escape($KvId) + '"'
    if ($verify -notmatch $verifyPattern) {
      throw "Set-TomlProductionKvId 验证失败：$Path 写入 $Binding id=$KvId 后 re-read 不匹配"
    }
    Ok "Updated $(Split-Path $Path -Leaf) production $Binding id=$KvId（写后验证通过）"
  }
}

function Set-TomlCronEnabled([string]$Path, [bool]$Enabled) {
  if (-not (Test-Path $Path)) { return }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  # [triggers] 与 crons 之间可有注释（M9-22）；整块匹配以便启用/禁用/去重，避免重复追加 [triggers]
  $blockPattern = '(?ms)^\[triggers\]\s*\r?\n(?:[^\[]*\r?\n)*?crons\s*=\s*\[[^\]]*\]\s*(?:\r?\n)?'
  $singleCronBlock = @"
[triggers]
# 单条 Cron + scheduled 内 minute % 5 分支（原 */5 任务），每节点仅占 1/5 账号槽位
crons = ["* * * * *"]

"@

  $stripped = [regex]::Replace($content, $blockPattern, '')
  $stripped = [regex]::Replace($stripped, '(\r?\n){3,}', "`r`n`r`n")

  if ($Enabled) {
    if ($stripped -match '(?m)^\[vars\]') {
      $newContent = [regex]::Replace($stripped, '(?m)^\[vars\]', ($singleCronBlock.TrimEnd() + "`r`n`r`n[vars]"), 1)
    } else {
      $newContent = $stripped.TrimEnd() + "`r`n`r`n" + $singleCronBlock
    }
  } else {
    $newContent = $stripped
  }

  if ($newContent -ne $content) {
    [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
    if ($Enabled) {
      Ok "Updated $(Split-Path $Path -Leaf) triggers enabled (single cron)"
    } else {
      Ok "Updated $(Split-Path $Path -Leaf) triggers disabled"
    }
  }
}

# M7-40-b（2026-10-21）：legacy 库已删除，删除只服务 binding="DB" 的 Set-TomlProductionD1
# 死函数（无调用方；legacy 库与 binding=DB 同批退役）。业务库走
# Set-TomlProductionD1ByBinding（按 binding 名分别回填 IDENTITY/GOVERNANCE/CONTENT/…）。

function Set-TomlProductionD1ByBinding([string]$Path, [string]$Binding, [string]$DatabaseName, [string]$DatabaseId) {
  if (-not (Test-Path $Path)) { return }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  $pattern = '(?ms)(\[\[env\.production\.d1_databases\]\]\s*\r?\nbinding\s*=\s*"' + [regex]::Escape($Binding) + '".*?database_name\s*=\s*")([^"]+)(".*?database_id\s*=\s*")([^"]+)(")'
  $newContent = [regex]::Replace($content, $pattern, {
    param($m)
    $m.Groups[1].Value + $DatabaseName + $m.Groups[3].Value + $DatabaseId + $m.Groups[5].Value
  }, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($newContent -ne $content) {
    [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
    # 写后 re-read 验证（TOML binding/database_id 跨多行，[\s\S] 才能匹配换行符）
    $verify = Get-Content -Path $Path -Raw -Encoding UTF8
    $verifyPattern = '\[\[env\.production\.d1_databases\]\][\s\S]*?binding\s*=\s*"' + [regex]::Escape($Binding) + '"[\s\S]*?database_id\s*=\s*"' + [regex]::Escape($DatabaseId) + '"'
    if ($verify -notmatch $verifyPattern) {
      throw "Set-TomlProductionD1ByBinding 验证失败：$Path 写入 $Binding database_id=$DatabaseId 后 re-read 不匹配"
    }
    Ok "Updated $(Split-Path $Path -Leaf) production D1 binding=$Binding name=$DatabaseName id=$DatabaseId（写后验证通过）"
  }
}

function Ensure-TomlProductionD1Binding([string]$Path, [string]$Binding, [string]$DatabaseName, [string]$DatabaseId, [string]$MigrationsDir) {
  if (-not (Test-Path $Path)) { return }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  $bindingPattern = '(?ms)\[\[env\.production\.d1_databases\]\]\s*\r?\nbinding\s*=\s*"' + [regex]::Escape($Binding) + '"'
  if ($content -notmatch $bindingPattern) {
    $block = "`r`n[[env.production.d1_databases]]`r`nbinding = `"$Binding`"`r`ndatabase_name = `"$DatabaseName`"`r`ndatabase_id = `"$DatabaseId`"`r`nmigrations_dir = `"$MigrationsDir`"`r`n"
    if ($content -match '(?m)^\[\[env\.production\.kv_namespaces\]\]') {
      $newContent = [regex]::Replace($content, '(?m)^(\[\[env\.production\.kv_namespaces\]\])', ($block + '$1'), 1)
    } else {
      $newContent = $content.TrimEnd() + $block
    }
    [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
    Ok "Added $(Split-Path $Path -Leaf) production D1 binding=$Binding"
  }
  Set-TomlProductionD1ByBinding $Path $Binding $DatabaseName $DatabaseId
}

function Set-TomlProductionVar([string]$Path, [string]$Key, [string]$Value) {
  if (-not (Test-Path $Path)) { return }
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  $escapedValue = $Value.Replace('\', '\\').Replace('"', '\"')
  $sectionPattern = '(?ms)(^\[env\.production\.vars\]\s*\r?\n)(.*?)(?=^\[|\z)'
  $newContent = [regex]::Replace($content, $sectionPattern, {
    param($m)
    $head = $m.Groups[1].Value
    $body = $m.Groups[2].Value
    $linePattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $lines = @($body -split '\r?\n' | Where-Object { $_ -notmatch $linePattern })
    while ($lines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($lines[$lines.Count - 1])) {
      if ($lines.Count -eq 1) {
        $lines = @()
      } else {
        $lines = @($lines[0..($lines.Count - 2)])
      }
    }
    $body2 = if ($lines.Count -gt 0) { ($lines -join "`r`n") + "`r`n" } else { "" }
    $body2 += "$Key = `"$escapedValue`"`r`n`r`n"
    return $head + $body2
  }, 1)
  if ($newContent -eq $content -and $content -notmatch '(?m)^\[env\.production\.vars\]') {
    $newContent = $content.TrimEnd() + "`r`n`r`n[env.production.vars]`r`n$Key = `"$escapedValue`"`r`n"
  }
  if ($newContent -ne $content) {
    [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
    # 写后 re-read 验证：确保写入确实成功（P1-4 防反追查：现场 patch 失败必须显式报错）
    $verify = Get-Content -Path $Path -Raw -Encoding UTF8
    $verifyPattern = '(?m)^\s*' + [regex]::Escape($Key) + '\s*=\s*"' + [regex]::Escape($escapedValue) + '"'
    if ($verify -notmatch $verifyPattern) {
      throw "Set-TomlProductionVar 验证失败：$Path 写入 $Key=`"$Value`" 后 re-read 不匹配；文件可能被只读或被外部程序还原"
    }
    Ok "Updated $(Split-Path $Path -Leaf) production var $Key（写后验证通过）"
  }
}

function Get-SecretFingerprint([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Read-SecretsManifest {
  if (-not (Test-Path $SecretsManifestPath)) { return @{} }
  try {
    $obj = Get-Content $SecretsManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $map = @{}
    foreach ($p in $obj.PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
    return $map
  } catch {
    return @{}
  }
}

function Save-SecretsManifestEntry([string]$Entry, [string]$Fingerprint) {
  $map = Read-SecretsManifest
  $map[$Entry] = $Fingerprint
  $ordered = [ordered]@{}
  foreach ($k in ($map.Keys | Sort-Object)) { $ordered[$k] = $map[$k] }
  ($ordered | ConvertTo-Json -Depth 3) + "`n" | Set-Content -Path $SecretsManifestPath -Encoding UTF8 -NoNewline
}

function Set-WorkerSecret([string]$WorkerDir, [string]$Key, [string]$Value, [string]$WorkerScriptName) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Warn "Secret '$Key' empty, skip"
    return
  }
  # 按 Cloudflare Worker 脚本名记账：换 hailuo-worker-a-{uuid} 后须重新 secret put
  $manifestEntry = if ([string]::IsNullOrWhiteSpace($WorkerScriptName)) {
    "$(Split-Path $WorkerDir -Leaf)/$Key"
  } else {
    "$WorkerScriptName/$Key"
  }
  $workerLabel = if ([string]::IsNullOrWhiteSpace($WorkerScriptName)) {
    Split-Path $WorkerDir -Leaf
  } else {
    $WorkerScriptName
  }
  $fingerprint = Get-SecretFingerprint $Value
  $manifest = Read-SecretsManifest
  if ($manifest.ContainsKey($manifestEntry) -and $manifest[$manifestEntry] -eq $fingerprint) {
    Ok "Secret $Key @ $workerLabel（未变化，跳过）"
    return
  }
  Sync-NodeProxyFromWindows -ConfigProxy (Get-ConfigValue $config @("HTTP_PROXY")) | Out-Null
  $putScript = Join-Path $ScriptsDir "put-worker-secrets.mjs"
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -eq 1) {
      Write-Host "  ... wrangler secret put $Key @ $workerLabel（每条 10–90s，取决于网络）" -ForegroundColor DarkGray
    } else {
      Write-Host "  ... 重试 $attempt/$maxAttempts：$Key @ $workerLabel" -ForegroundColor DarkGray
    }
    # 经 Node spawnSync 写入；用环境变量传值（禁止 PS 管道，避免 CRLF 污染 secret）
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $env:HAILUO_SECRET_PUT_VALUE = $Value
    try {
      node $putScript --one --worker-dir $WorkerDir --key $Key *> $null
      $exitCode = $LASTEXITCODE
    } finally {
      Remove-Item Env:HAILUO_SECRET_PUT_VALUE -ErrorAction SilentlyContinue
      $ErrorActionPreference = $oldPref
    }
    if ($exitCode -eq 0) {
      Save-SecretsManifestEntry $manifestEntry $fingerprint
      Ok "Secret $Key @ $workerLabel (len=$($Value.Length))"
      return
    }
    $retryable = $true
    if ($retryable -and $attempt -lt $maxAttempts) {
      Warn "Secret $Key 失败 (exit=$exitCode)，5 秒后重试（$attempt/$maxAttempts）"
      Start-Sleep -Seconds 5
      continue
    }
    Warn "Secret $Key failed (exit=$exitCode)"
    return
  }
}

function Find-D1Id([string]$Name) {
  try {
    $r = Invoke-WranglerWorkerA { npm exec -- wrangler d1 list --json }
    if ($r.ExitCode -eq 0) {
      $raw = $r.Output
      # wrangler 可能在 stdout 前输出 proxy banner / warning，定位首个 '['
      $startIdx = $raw.IndexOf("[")
      if ($startIdx -lt 0) { return $null }
      $jsonPart = $raw.Substring($startIdx)
      $endIdx = $jsonPart.LastIndexOf("]")
      if ($endIdx -lt $startIdx) { return $null }
      $jsonPart = $jsonPart.Substring(0, $endIdx + 1)
      try {
        $list = $jsonPart | ConvertFrom-Json
      } catch {
        return $null
      }
      $found = $list | Where-Object { $_.name -eq $Name }
      if ($found) { return $found.uuid }
    }
  } catch { }
  return $null
}

# token/toml 里的 D1 uuid 可能已删库（盲 reuse → migrations apply 报 7404）。
# 以云端 list 按 name 为准：不存在则返回 $null（调用方重建）；不一致则以云端 uuid 为准。
function Confirm-D1IdStillExists([string]$Name, [string]$CandidateId) {
  if ([string]::IsNullOrWhiteSpace($CandidateId) -or (Test-PlaceholderId $CandidateId)) {
    return $null
  }
  $cloudId = Find-D1Id $Name
  if (-not $cloudId) {
    Warn "D1 name=$Name 在云端不存在（本地 id=$CandidateId 已失效），将重建 — 防 migrations 7404"
    return $null
  }
  if ($cloudId -ne $CandidateId) {
    Warn "D1 name=$Name 云端 id=$cloudId 与本地 id=$CandidateId 不一致，以云端为准"
  }
  return $cloudId
}

Step "读取 Token"
if (-not (Test-Path $TokenFile)) {
  throw "未找到 $TokenFile`n请复制 cloudflare-api-token.example.json 并填写。"
}
$config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
# 旧 token 仅含 OWNER_HANDLE 时自动迁移到新键名（不写 wrangler 明文）
$legacyBootstrap = Get-ConfigValue $config @("OWNER_HANDLE")
if ((Test-SecretMissing (Get-ConfigValue $config @("BOOTSTRAP_HANDLE"))) -and -not (Test-SecretMissing $legacyBootstrap)) {
  $config | Add-Member -NotePropertyName BOOTSTRAP_HANDLE -NotePropertyValue $legacyBootstrap -Force
  Write-JsonUtf8NoBom $config $TokenFile
  Ok "token：已从 OWNER_HANDLE 迁移为 BOOTSTRAP_HANDLE"
}
$config = Ensure-DeploySecrets $config $TokenFile
$config = Ensure-NodeApiTokenWrapSecret $config $TokenFile
$config = Ensure-TotpWrapSecret $config $TokenFile
$config = Ensure-GroupOwnerKeyWrapSecret $config $TokenFile
$config = Ensure-MediaTicketSecretLocal $config $TokenFile

# 本地部署也要和 CI 一样用「账号 + 槽位」派生稳定身份：先把 Account ID / Token 解析好，
# 再生成 handle / 资源名，避免每次本地部署随机换一套 Worker / Pages / D1 名字。
$cfAccountId = Get-ConfigValue $config @("CLOUDFLARE_ACCOUNT_ID")
$cfApiToken = Get-ConfigValue $config @("CLOUDFLARE_API_TOKEN")
if ([string]::IsNullOrWhiteSpace($cfApiToken)) {
  throw "CLOUDFLARE_API_TOKEN 必填（scripts/cloudflare-api-token.json）"
}
# 与 GitHub CI 同源：缺 Account ID 时用 Token 调 GET /accounts 自动探测，并写回 token 文件
if ([string]::IsNullOrWhiteSpace($cfAccountId)) {
  Step "自动探测 CLOUDFLARE_ACCOUNT_ID（ci-ensure-cf-credentials --json）"
  $env:CLOUDFLARE_API_TOKEN = $cfApiToken
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  $emailFromToken = Get-ConfigValue $config @("CLOUDFLARE_EMAIL")
  if (-not [string]::IsNullOrWhiteSpace($emailFromToken)) {
    $env:CLOUDFLARE_EMAIL = $emailFromToken
  }
  $ensureScript = Join-Path $ScriptsDir "ci-ensure-cf-credentials.mjs"
  if (-not (Test-Path $ensureScript)) {
    throw "缺少 $ensureScript，无法自动探测 Account ID"
  }
  $probeOut = & node $ensureScript --json 2>&1 | Out-String
  $jsonLine = ($probeOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') -and $_.Contains('"accountId"') } | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($jsonLine)) {
    Write-Host $probeOut
    throw "自动探测 CLOUDFLARE_ACCOUNT_ID 失败（无 JSON 结果）。可手动在 token 文件填写 Account ID。"
  }
  try {
    $probe = $jsonLine | ConvertFrom-Json
  } catch {
    throw "自动探测 Account ID 返回无法解析的 JSON：$jsonLine"
  }
  if (-not $probe.ok -or [string]::IsNullOrWhiteSpace($probe.accountId)) {
    throw "自动探测 Account ID 失败：$jsonLine"
  }
  $cfAccountId = [string]$probe.accountId
  $config | Add-Member -NotePropertyName CLOUDFLARE_ACCOUNT_ID -NotePropertyValue $cfAccountId -Force
  Write-JsonUtf8NoBom $config $TokenFile
  Ok "已自动探测并写回 CLOUDFLARE_ACCOUNT_ID（source=$($probe.accountIdSource)；不打印完整 id 以外字段）"
  Ok "Account ID = $cfAccountId"
}
$env:CLOUDFLARE_ACCOUNT_ID = $cfAccountId
$env:CLOUDFLARE_API_TOKEN = $cfApiToken
$slotFromConfig = Get-ConfigValue $config @("HAILUO_NODE_SLOT")
if ([string]::IsNullOrWhiteSpace($env:HAILUO_NODE_SLOT) -and -not [string]::IsNullOrWhiteSpace($slotFromConfig)) {
  $env:HAILUO_NODE_SLOT = $slotFromConfig
}

$config = Ensure-DeployIdentity $config $TokenFile
$workerAName = Get-ConfigValue $config @("WORKER_A_NAME")
$workerBName = Get-ConfigValue $config @("WORKER_B_NAME")
Apply-DeployResourceNames $workerAName $workerBName $TomlA $TomlB
$cronEnabled = (Get-ConfigValue $config @("CRON_ENABLED") "true").Trim().ToLowerInvariant() -in @("1", "true", "yes", "y", "on")
Set-TomlCronEnabled $TomlA $cronEnabled
if ($cronEnabled) {
  Ok "Worker A Cron enabled"
} else {
  Warn "Worker A Cron disabled for this deploy (CRON_ENABLED=false)"
}
$ownerHandle = Get-BootstrapHandle $config
if (Test-SecretMissing $ownerHandle) {
  throw "BOOTSTRAP_HANDLE 生成失败，请检查 generate-deploy-identity.mjs"
}
Sync-NodeProxyFromWindows -ConfigProxy (Get-ConfigValue $config @("HTTP_PROXY")) | Out-Null
Ok "Account / Token 已加载（不打印明文）"

foreach ($p in @($TomlA, $TomlB)) {
  Copy-Item $p "$p.bak" -Force
  Ok "Backup $(Split-Path $p -Leaf).bak"
}

# ── D1（仅 Worker A）────────────────────────────────────────────────────
# M7-40-b（2026-10-21）：legacy 库 `hailuo-node-db-5da477` 已删除（A7-DB-RETIRE 后无 binding=DB，
# 生产 Worker A 从不读它）。历史字段 `D1_DATABASE_NAME` / `D1_DATABASE_ID` 一并从 token json 移除，
# 避免后人再拿它当权威库查（那正是 M7-40 误诊的根因）。业务一律走 IDENTITY/GOVERNANCE/CONTENT，
# 搬家 staging 走 DB_IMPORT。
Step "D1 legacy binding=DB (A7-DB-RETIRE skipped)"
Warn "不再创建/回填 wrangler binding=DB；业务走 IDENTITY/GOVERNANCE/CONTENT，搬家 staging 走 DB_IMPORT。"
Warn "legacy 库已删除且 token json 中对应历史字段已移除——请勿再把 legacy 库名当权威库查询。"

# ── MESSAGING_DB（M16-1a · 会话库 DM+群）────────────────────────────────────
$defaultMessagingD1Name = Get-DefaultMessagingD1Name $config
$messagingD1NameFromConfig = Get-ConfigValue $config @("MESSAGING_D1_DATABASE_NAME")
$messagingD1Id = Get-ConfigValue $config @("MESSAGING_D1_DATABASE_ID")
if ($messagingD1NameFromConfig -eq "messaging-db" -and -not $messagingD1Id -and $defaultMessagingD1Name -ne "messaging-db") {
  $messagingD1NameFromConfig = ""
}
$messagingD1Name = if ([string]::IsNullOrWhiteSpace($messagingD1NameFromConfig)) { $defaultMessagingD1Name } else { $messagingD1NameFromConfig }
Step "MESSAGING_DB: $messagingD1Name"
if (-not $messagingD1Id -and ([string]::IsNullOrWhiteSpace($messagingD1NameFromConfig) -or $messagingD1Name -eq "messaging-db")) {
  $messagingD1Id = Get-TomlProductionD1IdByBinding $TomlA "MESSAGING_DB" $messagingD1Name
}
if ($messagingD1Id) {
  $messagingD1Id = Confirm-D1IdStillExists $messagingD1Name $messagingD1Id
  if ($messagingD1Id) { Ok "MESSAGING_DB reuse verified id=$messagingD1Id" }
}
if (-not $messagingD1Id) {
  $messagingD1Id = Find-D1Id $messagingD1Name
  if ($messagingD1Id) {
    Ok "MESSAGING_DB cloud exists id=$messagingD1Id"
  } else {
    Write-Host "  创建 D1 $messagingD1Name ..."
    $out = (Invoke-WranglerWorkerA { npm exec -- wrangler d1 create $messagingD1Name }).Output
    if ($out -match 'database_id\s*=\s*"([^"]+)"') { $messagingD1Id = $Matches[1] }
    else { $messagingD1Id = Find-D1Id $messagingD1Name }
    if ($messagingD1Id) { Ok "MESSAGING_DB created id=$messagingD1Id" } else { throw "MESSAGING_DB 创建失败: $out" }
  }
}

if ($messagingD1Id) {
  Set-TomlProductionD1ByBinding $TomlA "MESSAGING_DB" $messagingD1Name $messagingD1Id
  $config | Add-Member -NotePropertyName MESSAGING_D1_DATABASE_NAME -NotePropertyValue $messagingD1Name -Force
  $config | Add-Member -NotePropertyName MESSAGING_D1_DATABASE_ID -NotePropertyValue $messagingD1Id -Force
  Write-JsonUtf8NoBom $config $TokenFile
}

# ── MESSAGING_SHARD_1（M16-P · 群消息 overflow 分片，bootstrap 自动创建）────
$defaultMessagingShardD1Name = Get-DefaultMessagingShardD1Name $config
$messagingShardD1NameFromConfig = Get-ConfigValue $config @("MESSAGING_SHARD_D1_DATABASE_NAME")
$messagingShardD1Id = Get-ConfigValue $config @("MESSAGING_SHARD_D1_DATABASE_ID")
if ($messagingShardD1NameFromConfig -eq "messaging-shard-1" -and -not $messagingShardD1Id -and $defaultMessagingShardD1Name -ne "messaging-shard-1") {
  $messagingShardD1NameFromConfig = ""
}
$messagingShardD1Name = if ([string]::IsNullOrWhiteSpace($messagingShardD1NameFromConfig)) { $defaultMessagingShardD1Name } else { $messagingShardD1NameFromConfig }
Step "MESSAGING_SHARD_1: $messagingShardD1Name"
if (-not $messagingShardD1Id -and ([string]::IsNullOrWhiteSpace($messagingShardD1NameFromConfig) -or $messagingShardD1Name -eq "messaging-shard-1")) {
  $messagingShardD1Id = Get-TomlProductionD1IdByBinding $TomlA "MESSAGING_SHARD_1" $messagingShardD1Name
}
if ($messagingShardD1Id) {
  $messagingShardD1Id = Confirm-D1IdStillExists $messagingShardD1Name $messagingShardD1Id
  if ($messagingShardD1Id) { Ok "MESSAGING_SHARD_1 reuse verified id=$messagingShardD1Id" }
}
if (-not $messagingShardD1Id) {
  $messagingShardD1Id = Find-D1Id $messagingShardD1Name
  if ($messagingShardD1Id) {
    Ok "MESSAGING_SHARD_1 cloud exists id=$messagingShardD1Id"
  } else {
    Write-Host "  创建 D1 $messagingShardD1Name ..."
    $out = (Invoke-WranglerWorkerA { npm exec -- wrangler d1 create $messagingShardD1Name }).Output
    if ($out -match 'database_id\s*=\s*"([^"]+)"') { $messagingShardD1Id = $Matches[1] }
    else { $messagingShardD1Id = Find-D1Id $messagingShardD1Name }
    if ($messagingShardD1Id) { Ok "MESSAGING_SHARD_1 created id=$messagingShardD1Id" } else { throw "MESSAGING_SHARD_1 创建失败: $out" }
  }
}

if ($messagingShardD1Id) {
  Ensure-TomlProductionD1Binding $TomlA "MESSAGING_SHARD_1" $messagingShardD1Name $messagingShardD1Id "db/messaging-shard-migrations"
  $config | Add-Member -NotePropertyName MESSAGING_SHARD_D1_DATABASE_NAME -NotePropertyValue $messagingShardD1Name -Force
  $config | Add-Member -NotePropertyName MESSAGING_SHARD_D1_DATABASE_ID -NotePropertyValue $messagingShardD1Id -Force
  Write-JsonUtf8NoBom $config $TokenFile
}

# ── 三库拆分（M-OPT-SPLIT · IDENTITY / GOVERNANCE / CONTENT）──────────────
# 三库命名模式：hailuo-node-db-{groupCode}-{suffix}
# bootstrap 自动创建（Find-or-Create）；wrangler.toml 已有对应 [[env.production.d1_databases]] 块

function New-SplitD1IfAbsent([string]$Suffix, [string]$Binding, [string]$MigrationsDir) {
  $defaultName = "hailuo-node-db-$((Get-DeployGroupCode $config))-$Suffix"
  # StrictMode 下不可把 Suffix.ToUpper() 嵌进 ${...} 当变量名；必须先求值再拼 token 键。
  $configKeyPrefix = $Suffix.ToUpper().Replace('-', '_')
  $nameFromConfig = Get-ConfigValue $config @("${configKeyPrefix}_DATABASE_NAME")
  $idFromConfig = Get-ConfigValue $config @("${configKeyPrefix}_DATABASE_ID")
  $name = if ([string]::IsNullOrWhiteSpace($nameFromConfig)) { $defaultName } else { $nameFromConfig }

  Step "M-OPT-SPLIT $Binding`: $name"
  $existingId = $null
  if (-not [string]::IsNullOrWhiteSpace($idFromConfig) -and -not (Test-PlaceholderId $idFromConfig)) {
    $existingId = Confirm-D1IdStillExists $name $idFromConfig
    if ($existingId) { Ok "reuse token id verified=$existingId" }
  } else {
    $tomlId = Get-TomlProductionD1IdByBinding $TomlA $Binding $name
    if ($tomlId) {
      $existingId = Confirm-D1IdStillExists $name $tomlId
      if ($existingId) { Ok "reuse wrangler.toml id verified=$existingId" }
    }
  }
  if (-not $existingId) {
    $existingId = Find-D1Id $name
    if ($existingId) { Ok "cloud exists id=$existingId" }
  }
  if (-not $existingId) {
    Write-Host "  创建 D1 $name ..."
    $out = (Invoke-WranglerWorkerA { npm exec -- wrangler d1 create $name }).Output
    if ($out -match 'database_id\s*=\s*"([^"]+)"') { $existingId = $Matches[1] }
    else { $existingId = Find-D1Id $name }
    if ($existingId) { Ok "$Binding created id=$existingId" }
    else { throw "$Binding 创建失败: $out" }
  }
  if ($existingId) {
    Ensure-TomlProductionD1Binding $TomlA $Binding $name $existingId $MigrationsDir
    $config | Add-Member -NotePropertyName "${configKeyPrefix}_DATABASE_NAME" -NotePropertyValue $name -Force
    $config | Add-Member -NotePropertyName "${configKeyPrefix}_DATABASE_ID" -NotePropertyValue $existingId -Force
    Write-JsonUtf8NoBom $config $TokenFile
  }
}

New-SplitD1IfAbsent "identity"   "IDENTITY_DB"   "db/migrations-identity"
New-SplitD1IfAbsent "governance" "GOVERNANCE_DB" "db/migrations-governance"
New-SplitD1IfAbsent "content"    "CONTENT_DB"    "db/migrations-content"

# ── DB_IMPORT（M9-7-S2 · 搬家 staging，全量 schema）────────────────────────
# DB_IMPORT 与三库共用 schema（db/migrations），bootstrap 必须 Find-or-Create 后
# 才能在 Phase 1 末尾运行 migrations apply，否则 wrangler 会用占位 id 打 Cloudflare API。
function New-DbImportD1IfAbsent {
  $suffix = "import"
  $defaultName = "hailuo-node-db-$((Get-DeployGroupCode $config))-$suffix"
  $configKeyPrefix = "IMPORT"
  $nameFromConfig = Get-ConfigValue $config @("${configKeyPrefix}_DATABASE_NAME")
  $idFromConfig = Get-ConfigValue $config @("${configKeyPrefix}_DATABASE_ID")
  $name = if ([string]::IsNullOrWhiteSpace($nameFromConfig)) { $defaultName } else { $nameFromConfig }

  Step "DB_IMPORT: $name"
  $existingId = $null
  if (-not [string]::IsNullOrWhiteSpace($idFromConfig) -and -not (Test-PlaceholderId $idFromConfig)) {
    $existingId = Confirm-D1IdStillExists $name $idFromConfig
    if ($existingId) { Ok "reuse token id verified=$existingId" }
  } else {
    $tomlId = Get-TomlProductionD1IdByBinding $TomlA "DB_IMPORT" $name
    if ($tomlId) {
      $existingId = Confirm-D1IdStillExists $name $tomlId
      if ($existingId) { Ok "reuse wrangler.toml id verified=$existingId" }
    }
  }
  if (-not $existingId) {
    $existingId = Find-D1Id $name
    if ($existingId) { Ok "cloud exists id=$existingId" }
  }
  if (-not $existingId) {
    Write-Host "  创建 D1 $name ..."
    $out = (Invoke-WranglerWorkerA { npm exec -- wrangler d1 create $name }).Output
    if ($out -match 'database_id\s*=\s*"([^"]+)"') { $existingId = $Matches[1] }
    else { $existingId = Find-D1Id $name }
    if ($existingId) { Ok "DB_IMPORT created id=$existingId" }
    else { throw "DB_IMPORT 创建失败: $out" }
  }
  if ($existingId) {
    Ensure-TomlProductionD1Binding $TomlA "DB_IMPORT" $name $existingId "db/migrations"
    $config | Add-Member -NotePropertyName "${configKeyPrefix}_DATABASE_NAME" -NotePropertyValue $name -Force
    $config | Add-Member -NotePropertyName "${configKeyPrefix}_DATABASE_ID" -NotePropertyValue $existingId -Force
    Write-JsonUtf8NoBom $config $TokenFile
  }
}

New-DbImportD1IfAbsent

# ── KV（A/B 共用 id）────────────────────────────────────────────────────
$postsKvNameFromConfig = Get-ConfigValue $config @("POSTS_CACHE_KV_NAME")
$imageKvNameFromConfig = Get-ConfigValue $config @("IMAGE_KV_NAME")
$stateKvNameFromConfig = Get-ConfigValue $config @("STATE_KV_NAME")
# posts-cache-kv：与 image-kv / state-kv 后缀口径一致（旧 posts-cache 仅 alias reuse）
$defaultPostsKvName = Get-DefaultKvName $config "posts-cache-kv"
$defaultImageKvName = Get-DefaultKvName $config "image-kv"
$defaultStateKvName = Get-DefaultKvName $config "state-kv"
$postsKvIdFromConfig = Get-ConfigValue $config @("POSTS_CACHE_KV_ID")
$imageKvIdFromConfig = Get-ConfigValue $config @("IMAGE_KV_ID")
$stateKvIdFromConfig = Get-ConfigValue $config @("STATE_KV_ID")
if ($postsKvNameFromConfig -in @("hailuo-node-posts-cache", "worker-hailuo-node-posts-cache", "hailuo-node-posts-cache-kv", "worker-hailuo-node-posts-cache-kv") -and -not $postsKvIdFromConfig -and $defaultPostsKvName -ne "hailuo-node-posts-cache-kv") {
  $postsKvNameFromConfig = ""
}
if ($imageKvNameFromConfig -in @("hailuo-node-image-kv", "worker-hailuo-node-image-kv") -and -not $imageKvIdFromConfig -and $defaultImageKvName -ne "hailuo-node-image-kv") {
  $imageKvNameFromConfig = ""
}
if ($stateKvNameFromConfig -in @("hailuo-node-state-kv", "worker-hailuo-node-state-kv") -and -not $stateKvIdFromConfig -and $defaultStateKvName -ne "hailuo-node-state-kv") {
  $stateKvNameFromConfig = ""
}
$postsGroupCode = Get-DeployGroupCode $config
$postsTitleAliases = @(Get-LegacyKvTitleAliases $config $postsKvNameFromConfig @("hailuo-node-posts-cache", "worker-hailuo-node-posts-cache", "hailuo-node-posts-cache-kv", "worker-hailuo-node-posts-cache-kv"))
# 有组码时仍要命中旧短名 posts-cache（无 -kv），避免改后缀后误建第二套空库
if ($postsGroupCode -and [string]::IsNullOrWhiteSpace($postsKvNameFromConfig)) {
  $postsTitleAliases = @(
    "hailuo-node-$postsGroupCode-posts-cache",
    "worker-hailuo-node-$postsGroupCode-posts-cache",
    "hailuo-node-$postsGroupCode-posts-cache-kv"
  ) + $postsTitleAliases | Select-Object -Unique
}
$kvSpecs = @(
  @{
    Title = if ($postsKvNameFromConfig) { $postsKvNameFromConfig } else { $defaultPostsKvName }
    Binding = "POSTS_CACHE_KV"
    IdConfig = "POSTS_CACHE_KV_ID"
    NameConfig = "POSTS_CACHE_KV_NAME"
    # 与 worker-a/b wrangler.toml production 字面一致（旧 000…01 已退役）
    Placeholder = 'id = "POSTS_CACHE_KV-prod-placeholder"'
    TitleAliases = $postsTitleAliases
    AllowTomlIdReuse = [string]::IsNullOrWhiteSpace($postsKvNameFromConfig) -and ($defaultPostsKvName -eq "hailuo-node-posts-cache-kv" -or $defaultPostsKvName -eq "hailuo-node-posts-cache")
  }
  @{
    Title = if ($imageKvNameFromConfig) { $imageKvNameFromConfig } else { $defaultImageKvName }
    Binding = "IMAGE_KV"
    IdConfig = "IMAGE_KV_ID"
    NameConfig = "IMAGE_KV_NAME"
    Placeholder = 'id = "IMAGE_KV-prod-placeholder"'
    TitleAliases = Get-LegacyKvTitleAliases $config $imageKvNameFromConfig @("hailuo-node-image-kv", "worker-hailuo-node-image-kv")
    AllowTomlIdReuse = [string]::IsNullOrWhiteSpace($imageKvNameFromConfig) -and $defaultImageKvName -eq "hailuo-node-image-kv"
  }
  @{
    Title = if ($stateKvNameFromConfig) { $stateKvNameFromConfig } else { $defaultStateKvName }
    Binding = "STATE_KV"
    IdConfig = "STATE_KV_ID"
    NameConfig = "STATE_KV_NAME"
    Placeholder = 'id = "STATE_KV-prod-placeholder"'
    TitleAliases = Get-LegacyKvTitleAliases $config $stateKvNameFromConfig @("hailuo-node-state-kv", "worker-hailuo-node-state-kv")
    AllowTomlIdReuse = [string]::IsNullOrWhiteSpace($stateKvNameFromConfig) -and $defaultStateKvName -eq "hailuo-node-state-kv"
  }
)

Step "KV namespaces"
$kvList = @(Get-KvNamespaceList)

foreach ($spec in $kvSpecs) {
  $title = $spec.Title
  $binding = $spec.Binding
  $kvId = Get-ConfigValue $config @($spec.IdConfig)
  if (-not $kvId -and $spec.AllowTomlIdReuse) {
    $kvId = Get-TomlProductionKvId $TomlA $binding
  }

  # token/toml 旧 uuid 可能已删库；盲 reuse → Worker deploy 报 10041。
  # 规则：① id 命中云端列表才 reuse；② 否则按 title/alias 取云端；③ 列表非空仍无 → 重建；
  # ④ 列表为空先重拉一次，仍空则 fail-loud（拒盲 reuse，防假绿）。
  if ($kvId) {
    $cloudById = $kvList | Where-Object { (Get-KvNamespaceId $_) -eq $kvId } | Select-Object -First 1
    if ($cloudById) {
      Ok "KV '$title' reuse verified id=$kvId (cloud: $(Get-KvNamespaceTitle $cloudById))"
    } else {
      $byTitle = Find-KvNamespace $kvList $title $spec.TitleAliases
      if ($byTitle) {
        $oldId = $kvId
        $kvId = Get-KvNamespaceId $byTitle
        Warn "KV '$title' 本地 id=$oldId 不在云端，改用同名云端 id=$kvId"
      } elseif (@($kvList).Count -eq 0) {
        Warn "KV list 为空，无法校验本地 id=$kvId；重拉列表…"
        $kvList = @(Get-KvNamespaceList)
        $cloudById2 = $kvList | Where-Object { (Get-KvNamespaceId $_) -eq $kvId } | Select-Object -First 1
        if ($cloudById2) {
          Ok "KV '$title' reuse verified after re-list id=$kvId"
        } else {
          $byTitle2 = Find-KvNamespace $kvList $title $spec.TitleAliases
          if ($byTitle2) {
            $oldId = $kvId
            $kvId = Get-KvNamespaceId $byTitle2
            Warn "KV '$title' 本地 id=$oldId 不在云端，改用同名云端 id=$kvId"
          } elseif (@($kvList).Count -eq 0) {
            throw "KV namespace list 为空，无法校验 id=$kvId（鉴权/网络？）— 拒绝盲 reuse 防 deploy 10041"
          } else {
            Warn "KV '$title' 本地 id=$kvId 已失效，将重建 — 防 deploy 10041"
            $kvId = $null
          }
        }
      } else {
        Warn "KV '$title' 本地 id=$kvId 已失效（云端无此 id 且无同名），将重建 — 防 deploy 10041"
        $kvId = $null
      }
    }
  }
  if (-not $kvId) {
    $existing = Find-KvNamespace $kvList $title $spec.TitleAliases
    if ($existing) {
      $kvId = Get-KvNamespaceId $existing
      Ok "KV '$title' cloud exists as '$(Get-KvNamespaceTitle $existing)' id=$kvId"
    } else {
      Write-Host "  创建 KV $title （Cloudflare API，短名直写）..."
      $kvId = New-CloudflareKvNamespace $title
      if (-not $kvId) {
        $kvList = @(Get-KvNamespaceList)
        $found = Find-KvNamespace $kvList $title $spec.TitleAliases
        if ($found) { $kvId = Get-KvNamespaceId $found }
      }
      if ($kvId) {
        Ok "KV '$title' created id=$kvId"
        if (@($kvList).Count -eq 0) { $kvList = @(Get-KvNamespaceList) }
      } else {
        throw "KV '$title' 创建失败（Cloudflare API 未返回 id，且列表中未找到同名空间）"
      }
    }
  }

  Set-TomlProductionKvId $TomlA $binding $kvId
  Set-TomlProductionKvId $TomlB $binding $kvId
  Replace-InToml $TomlA $spec.Placeholder "id = `"$kvId`"" -Quiet
  Replace-InToml $TomlB $spec.Placeholder "id = `"$kvId`"" -Quiet
  $config | Add-Member -NotePropertyName $spec.NameConfig -NotePropertyValue $title -Force
  $config | Add-Member -NotePropertyName $spec.IdConfig -NotePropertyValue $kvId -Force
}

Write-JsonUtf8NoBom $config $TokenFile

$resolveWorkerUrlsScript = Join-Path $ScriptsDir "resolve-deploy-worker-urls.mjs"
if (Test-Path $resolveWorkerUrlsScript) {
  Invoke-SubScriptCapture { & node $resolveWorkerUrlsScript --token-file $TokenFile --force } -Label "resolve-deploy-worker-urls.mjs"
  $config = Get-Content $TokenFile -Raw -Encoding UTF8 | ConvertFrom-Json
  Ok "Worker/Pages URLs resolved for current node"
}

# ── production vars（非 Secret）──────────────────────────────────────────
$pubKey = Get-ConfigValue $config @("ED25519_PUBLIC_KEY")
$ownerHandle = Get-BootstrapHandle $config
$workerB = (Get-ConfigValue $config @("WORKER_B_HOST", "WORKER_B_URL")).TrimEnd("/")
$pagesUrl = (Get-ConfigValue $config @("PAGES_URL", "WORKER_A_ORIGIN")).TrimEnd("/")
$registryUrl = Get-ConfigValue $config @("REGISTRY_URL") "https://hailuo-registry.allovo.eu.org"

if ($ownerHandle) {
  Set-TomlProductionVar $TomlA "BOOTSTRAP_HANDLE" $ownerHandle
  Set-TomlProductionVar $TomlB "BOOTSTRAP_HANDLE" $ownerHandle
}
if ($pubKey -and $pubKey -notmatch "deploy-after|PLACEHOLDER") {
  Set-TomlProductionVar $TomlA "ED25519_PUBLIC_KEY" $pubKey
  Set-TomlProductionVar $TomlB "ED25519_PUBLIC_KEY" $pubKey
}
if ($workerB) {
  Set-TomlProductionVar $TomlA "WORKER_B_URL" $workerB
}
if ($pagesUrl) {
  Set-TomlProductionVar $TomlA "WORKER_A_ORIGIN" $pagesUrl
  Set-TomlProductionVar $TomlB "WORKER_A_ORIGIN" $pagesUrl
}

# ALL-AUDIT-Y-16 / M-WORKFLOW-AE-1：未开通 Analytics Engine 时，toml 带 ANALYTICS 会在 deploy 报 10089
# 默认（OTEL 关）剥离 production 绑定；仅 OTEL_ENABLED=true 时保留并提示先开 Dashboard
function Remove-TomlProductionAnalyticsEngine([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  $content = [System.IO.File]::ReadAllText($Path)
  # 剥掉 [[env.production.analytics_engine_datasets]] 整块（到下一张 [ / [[ 表头）
  $pattern = '(?ms)(?:\r?\n)+\[\[env\.production\.analytics_engine_datasets\]\][^\[]*'
  $newContent = [regex]::Replace($content, $pattern, "`n")
  if ($newContent -eq $content) { return $false }
  [System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
  return $true
}
$otelEnabled = (Get-ConfigValue $config @("OTEL_ENABLED") "false").Trim().ToLowerInvariant()
if ($otelEnabled -in @("true", "1", "yes", "on")) {
  Set-TomlProductionVar $TomlA "OTEL_ENABLED" "true"
  Set-TomlProductionVar $TomlB "OTEL_ENABLED" "true"
  Ok "Analytics Engine: 保留 ANALYTICS 绑定，OTEL_ENABLED=true（若 deploy 报 10089，请先在 Dashboard 开通 Workers Analytics Engine）"
} else {
  $strippedA = Remove-TomlProductionAnalyticsEngine $TomlA
  $strippedB = Remove-TomlProductionAnalyticsEngine $TomlB
  Ok "Analytics Engine: OTEL 默认关，已剥离 production ANALYTICS（A=$strippedA B=$strippedB），避免未开通 AE 时报 10089"
}

if (-not $SkipSecrets) {
  Step "Worker Secrets"
  $apiCheck = Test-CloudflareApiViaNode
  if ($apiCheck.Ok) { Ok $apiCheck.Message }
  else {
    Warn $apiCheck.Message
    Warn "wrangler 走 Node 路径；若开了系统代理但未注入 HTTP_PROXY，易出现 fetch failed / 100s 超时。"
    Warn "Secret 已配好时可：deploy-all.ps1 -SkipSecrets"
  }
  $internal = Get-ConfigValue $config @("INTERNAL_FORWARD_SECRET")
  Set-WorkerSecret $WorkerADir "JWT_SECRET" (Get-ConfigValue $config @("JWT_SECRET")) $workerAName
  Set-WorkerSecret $WorkerADir "NODE_API_TOKEN_WRAP_SECRET" (Get-ConfigValue $config @("NODE_API_TOKEN_WRAP_SECRET")) $workerAName
  Set-WorkerSecret $WorkerADir "TOTP_WRAP_SECRET" (Get-ConfigValue $config @("TOTP_WRAP_SECRET")) $workerAName
  Set-WorkerSecret $WorkerADir "GROUP_OWNER_KEY_WRAP_SECRET" (Get-ConfigValue $config @("GROUP_OWNER_KEY_WRAP_SECRET")) $workerAName
  Set-WorkerSecret $WorkerADir "ED25519_PRIVATE_KEY" (Get-ConfigValue $config @("ED25519_PRIVATE_KEY")) $workerAName
  Set-WorkerSecret $WorkerADir "HMAC_SECRET" (Get-ConfigValue $config @("HMAC_SECRET")) $workerAName
  Set-WorkerSecret $WorkerADir "INTERNAL_FORWARD_SECRET" $internal $workerAName
  Set-WorkerSecret $WorkerBDir "INTERNAL_FORWARD_SECRET" $internal $workerBName
  if ($registryUrl) {
    Set-WorkerSecret $WorkerADir "REGISTRY_URL" $registryUrl $workerAName
    Set-WorkerSecret $WorkerBDir "REGISTRY_URL" $registryUrl $workerBName
  }
  # SEC-6-SECRET：幂等注入 MEDIA_TICKET_SECRET（已有跳过；缺则 put）
  Step "Worker B MEDIA_TICKET_SECRET（幂等）"
  $ensureMediaTicket = Join-Path $ScriptsDir "lib\ensure-media-ticket-secret.mjs"
  if (-not (Test-Path $ensureMediaTicket)) { throw "缺少 $ensureMediaTicket" }
  Invoke-SubScriptCapture { & node $ensureMediaTicket } -Label "ensure-media-ticket-secret.mjs"
  Ok "MEDIA_TICKET_SECRET 已确保（仅 Worker B；线上已有则保留）"
} else {
  Warn "SkipSecrets：未写入 Secret（含 MEDIA_TICKET_SECRET；升级请勿长期 Skip，旧节点可能缺票据钥）"
}

if (-not $SkipMigrations) {
  Step "Worker A: run D1 migrations（patch 后立即执行，wrangler deploy 的 git checkout 不会影响本进程 TOML）"
  Sync-NodeProxyFromWindows -ConfigProxy (Get-ConfigValue $config @("HTTP_PROXY")) | Out-Null
  # PS 5.1 `@(..., $arr)` 不会自动展平嵌套数组——必须用 `+ $arr` 拼接或内联
  $wranglerTomlArgs = @("-c", "apps/worker-a/wrangler.toml")
  # DB_IMPORT（staging 全量 schema）——wrangler 从 repo root 执行，不需要 Push-Location
  $importExit = Invoke-WranglerWithRetry -WranglerArgs (
    @('d1', 'migrations', 'apply', 'DB_IMPORT', '--remote', '--env', 'production') + $wranglerTomlArgs
  ) -Label "worker-a DB_IMPORT migrations apply" -MaxAttempts 3
  if ($importExit -ne 0) { throw "Worker A DB_IMPORT migration failed（请确认 bootstrap 已创建 import 库）" }
  Ok "Worker A DB_IMPORT migrations applied"

  # 三库拆分（IDENTITY / GOVERNANCE / CONTENT）
  foreach ($d1Binding in @('IDENTITY_DB', 'GOVERNANCE_DB', 'CONTENT_DB')) {
    Step "Worker A: migrate $d1Binding"
    $exit = Invoke-WranglerWithRetry -WranglerArgs (
      @('d1', 'migrations', 'apply', $d1Binding, '--remote', '--env', 'production') + $wranglerTomlArgs
    ) -Label "worker-a $d1Binding migrations apply" -MaxAttempts 3
    if ($exit -ne 0) { throw "Worker A $d1Binding migration failed" }
    Ok "Worker A $d1Binding migrations applied"
  }

  # 私信库（MESSAGING_DB / MESSAGING_SHARD_1）
  foreach ($d1Binding in @('MESSAGING_DB', 'MESSAGING_SHARD_1')) {
    Step "Worker A: migrate $d1Binding"
    $exit = Invoke-WranglerWithRetry -WranglerArgs (
      @('d1', 'migrations', 'apply', $d1Binding, '--remote', '--env', 'production') + $wranglerTomlArgs
    ) -Label "worker-a $d1Binding migrations apply" -MaxAttempts 3
    if ($exit -ne 0) { throw "Worker A $d1Binding migration failed" }
    Ok "Worker A $d1Binding migrations applied"
  }

  Ok "Worker A migrations applied（patch 后立即执行，跳过 deploy-hailuo-workers.ps1 里的 migration 阶段）"
} else {
  Warn "SkipMigrations：未运行 D1 migrations（deploy-all.ps1 会在 Phase 2 单独执行；注意 wrangler deploy 会 git checkout 还原 TOML，需先确认 migration 能在同一进程内执行）"
}

# 可选 R2：与 ci-bootstrap 同一 Node 模块。放在其它 TOML 回填之后。
# 失败不阻断：不 throw，并把 LASTEXITCODE 收回 0，避免 deploy-all 把跳过当成 Bootstrap 失败。
function Invoke-OptionalHailuoR2 {
  $group = Get-DeployGroupCode $config
  if (-not $group) {
    Warn "可选 R2：无组码，跳过（继续用 IMAGE_KV）"
    return
  }
  $r2Script = Join-Path $ScriptsDir "ci-optional-r2.mjs"
  Step "可选 R2（失败不阻断）"
  $status = "skipped"
  $reason = "未执行"
  $bucket = ""
  try {
    # M8-14-1f：node/ci-optional-r2 偶发带 ANSI；解析 JSON 前先脱色，避免 IndexOf/ConvertFrom-Json 吃到转义序列
    $raw = Strip-Ansi (& node $r2Script --group $group 2>&1 | Out-String)
    $start = $raw.IndexOf("{")
    $end = $raw.LastIndexOf("}")
    $parsed = $null
    if ($start -ge 0 -and $end -gt $start) {
      $parsed = $raw.Substring($start, $end - $start + 1) | ConvertFrom-Json
    }
    if ($null -ne $parsed) {
      $statusProp = $parsed.PSObject.Properties["status"]
      $reasonProp = $parsed.PSObject.Properties["reason"]
      $bucketProp = $parsed.PSObject.Properties["bucketName"]
      if ($null -ne $statusProp -and $statusProp.Value) { $status = [string]$statusProp.Value }
      if ($null -ne $reasonProp -and $reasonProp.Value) { $reason = [string]$reasonProp.Value }
      if ($null -ne $bucketProp -and $bucketProp.Value) { $bucket = [string]$bucketProp.Value }
    } else {
      $reason = "无法解析 ci-optional-r2 输出"
    }
    if ($status -eq "bound") {
      Ok "R2 HAILUO_IMAGE_R2 → $bucket"
      $reason = ""
    } else {
      Warn "skip R2：$reason（继续用 IMAGE_KV）"
    }
  } catch {
    $status = "skipped"
    $reason = $_.Exception.Message
    Warn "skip R2：$reason（继续用 IMAGE_KV）"
  } finally {
    $global:LASTEXITCODE = 0
  }
  try {
    $config | Add-Member -NotePropertyName "HAILUO_R2_STATUS" -NotePropertyValue $status -Force
    $config | Add-Member -NotePropertyName "HAILUO_R2_BUCKET" -NotePropertyValue $bucket -Force
    $config | Add-Member -NotePropertyName "HAILUO_R2_REASON" -NotePropertyValue $reason -Force
    Write-JsonUtf8NoBom $config $TokenFile
  } catch {
    Warn "可选 R2 状态未写入 token：$($_.Exception.Message)（部署继续）"
  }
}

Invoke-OptionalHailuoR2

Ok "Bootstrap 完成"
$global:LASTEXITCODE = 0
