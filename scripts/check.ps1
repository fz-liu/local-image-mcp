<#
.SYNOPSIS
  One-shot health check for the qwen-image-mcp deployment (run this after every DSH upgrade).

.DESCRIPTION
  Read-only. Prints PASS / WARN / FAIL lines, ends with an overall verdict and a
  suggested next step. Exit code 1 when anything FAILed, 0 otherwise.

  Checks:
    1. Node >= 22
    2. project files present
    3. config.json paths + model files really exist
    4. node server.mjs --self-test
    5. the managed block in the 鲸鱼娘 profile patch matches cordis.patch.snippet.yml
       (+ the wincu entry is still there, read-only)
    6. host exe version vs the launcher's $validatedVersion
    7. state\last-check.json dshVersionChecked vs the current version
    8. with -Live: node server.mjs --status (touches ComfyUI, never starts it)

  This script never reads or writes the official C:\Users\Administrator\.dsh data
  directory, and never modifies the launcher or the profile patch.
#>
[CmdletBinding()]
param(
  [switch]$Live,
  [switch]$Record
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServerPath = Join-Path $ProjectRoot 'server.mjs'
$ConfigPath = Join-Path $ProjectRoot 'config.json'
$TemplatePath = Join-Path $ProjectRoot 'workflow_api.template.json'
$SnippetPath = Join-Path $ProjectRoot 'cordis.patch.snippet.yml'
if (-not (Test-Path -LiteralPath $SnippetPath)) { $SnippetPath = Join-Path $ProjectRoot 'cordis.patch.example.yml' }
$StateDir = Join-Path $ProjectRoot 'state'
$LastCheckPath = Join-Path $StateDir 'last-check.json'

$ProfilePatchPath = Join-Path $env:USERPROFILE '.dsh-pack-better\profiles\desktop\cordis.patch.yml'
$LauncherPath = Join-Path $env:USERPROFILE 'dsh-launchers\launch-dsh.ps1'
$HostExePath = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'

$MarkerStart = '# >>> qwen-image-mcp'
$MarkerEnd = '# <<< qwen-image-mcp <<<'

$NodeExe = 'E:\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) { $NodeExe = 'node' }

$results = New-Object System.Collections.ArrayList

function Add-Result([string]$Status, [string]$Name, [string]$Detail, [string]$Fix) {
  [void]$results.Add([pscustomobject]@{ Status = $Status; Name = $Name; Detail = $Detail; Fix = $Fix })
  $color = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
  Write-Host ("[{0}] {1}" -f $Status, $Name) -ForegroundColor $color
  if ($Detail) { Write-Host ("       {0}" -f $Detail) }
  if ($Fix -and $Status -ne 'PASS') { Write-Host ("       建议: {0}" -f $Fix) -ForegroundColor $color }
}

function Get-NormalizedText([string]$Path) {
  $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return ($raw -replace "`r`n", "`n")
}

# ── 1. Node ─────────────────────────────────────────────────────────────────
# Native process helper: captures stdout/stderr without a child's stderr write
# tripping $ErrorActionPreference='Stop'.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [hashtable]$ExtraEnv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $quoted = @()
  foreach ($arg in $Arguments) {
    if ($arg -match '[\s"]') { $quoted += ('"' + ($arg -replace '"', '\"') + '"') } else { $quoted += $arg }
  }
  $psi.Arguments = ($quoted -join ' ')
  $psi.UseShellExecute = $false
  if ($ExtraEnv) { foreach ($k in $ExtraEnv.Keys) { $psi.EnvironmentVariables[[string]$k] = [string]$ExtraEnv[$k] } }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit(60000)) {
    try { $proc.Kill() } catch { }
    return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; StdOut = ''; StdErr = '子进程 60 秒内未结束'; All = '子进程 60 秒内未结束' }
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = -1
  try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = -1 }
  return [pscustomobject]@{
    ExitCode = $exitCode
    TimedOut = $false
    StdOut   = $stdout
    StdErr   = $stderr
    All      = ($stdout + "`n" + $stderr)
  }
}

$nodeVersion = $null
try {
  $nodeProbe = Invoke-Native $NodeExe @('--version')
  if ($nodeProbe.ExitCode -eq 0) { $nodeVersion = ($nodeProbe.StdOut -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() }
} catch {
  $nodeVersion = $null
}
if (-not $nodeVersion) {
  Add-Result 'FAIL' 'Node 可用性' "无法运行 $NodeExe" '确认 E:\nodejs\node.exe 存在（或把 node 加入 PATH）'
  $nodeMajor = 0
} else {
  $nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
  if ($nodeMajor -ge 22) {
    Add-Result 'PASS' 'Node 版本' "$NodeExe -> $nodeVersion"
  } else {
    Add-Result 'FAIL' 'Node 版本' "$NodeExe -> $nodeVersion（要求 >= 22）" 'server.mjs 需要内置 fetch；请升级 Node'
  }
}

# ── 1b. DSH embedded runtime ────────────────────────────────────────────────
# DSH launches MCP servers with process.execPath, which is "DeepSeek Harness.exe"
# running in Node mode (verified against the live wincu process), NOT E:\nodejs.
# So the runtime that actually matters is the host's embedded one.
$embeddedMajor = 0
if (Test-Path -LiteralPath $HostExePath) {
  try {
    $embProbe = Invoke-Native $HostExePath @('-p', 'process.versions.node + "|" + typeof fetch + "|" + typeof WebSocket + "|" + typeof process.getBuiltinModule') @{ ELECTRON_RUN_AS_NODE = '1' }
    $embLine = ($embProbe.StdOut -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($embProbe.ExitCode -eq 0 -and $embLine -match '^(\d+)\.(\d+)\.(\d+)\|(\w+)\|(\w+)\|(\w+)$') {
      $embeddedMajor = [int]$Matches[1]
      $embVer = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
      if ($embeddedMajor -ge 22 -and $Matches[4] -eq 'function' -and $Matches[6] -eq 'function') {
        Add-Result 'PASS' 'DSH 内置运行时' "Node $embVer（fetch=$($Matches[4]) WebSocket=$($Matches[5]) getBuiltinModule=$($Matches[6])）"
        $embSelf = Invoke-Native $HostExePath @($ServerPath, '--self-test') @{ ELECTRON_RUN_AS_NODE = '1' }
        $embPass = ($embSelf.All -split "`r?`n" | Where-Object { $_ -match 'SELF-TEST (PASS|FAIL)' } | Select-Object -Last 1)
        if ($embSelf.ExitCode -eq 0 -and $embPass -match 'PASS') {
          Add-Result 'PASS' 'server --self-test（内置运行时）' $embPass.Trim()
        } else {
          Add-Result 'FAIL' 'server --self-test（内置运行时）' "$embPass" 'DSH 实际用这个运行时拉起 MCP；宿主升级后内置 Node 行为可能变化，按失败项修 server.mjs，或把补丁 command 改成 E:\nodejs\node.exe 绝对路径'
        }
      } else {
        Add-Result 'FAIL' 'DSH 内置运行时' "Node $embVer，fetch=$($Matches[4]) WebSocket=$($Matches[5]) getBuiltinModule=$($Matches[6])（要求 Node>=22 且 fetch/getBuiltinModule 可用）" '宿主升级后内置 Node 变旧：把 cordis.patch.snippet.yml 里的 command 改成 E:\nodejs\node.exe 绝对路径后重新 -Apply'
      }
    } else {
      Add-Result 'WARN' 'DSH 内置运行时' "无法以 Node 模式探测（exit=$($embProbe.ExitCode)）" '宿主可能不再支持 ELECTRON_RUN_AS_NODE；确认 wincu 是否仍正常，必要时把补丁 command 改成 E:\nodejs\node.exe'
    }
  } catch {
    Add-Result 'WARN' 'DSH 内置运行时' $_.Exception.Message '同上'
  }
} else {
  Add-Result 'WARN' 'DSH 内置运行时' "找不到 $HostExePath" '确认 DSH 安装位置'
}

# ── 2. project files ────────────────────────────────────────────────────────
$required = @($ServerPath, $ConfigPath, $TemplatePath, $SnippetPath, (Join-Path $PSScriptRoot 'install-patch.ps1'), (Join-Path $PSScriptRoot 'mcp-client-test.mjs'))
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missing.Count -eq 0) {
  Add-Result 'PASS' '项目文件齐全' "$ProjectRoot"
} else {
  Add-Result 'FAIL' '项目文件齐全' ("缺少: " + ($missing -join ', ')) '从备份/仓库恢复这些文件'
}

# ── 3. config paths and model files ─────────────────────────────────────────
$config = $null
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Add-Result 'FAIL' 'config.json 解析' $_.Exception.Message '修好 JSON 语法'
  }
}

if ($config) {
  $pathChecks = @(
    @{ Name = 'comfy_python'; Value = $config.comfy_python; Kind = 'Leaf' },
    @{ Name = 'comfy_main'; Value = $config.comfy_main; Kind = 'Leaf' },
    @{ Name = 'comfy_root'; Value = $config.comfy_root; Kind = 'Container' },
    @{ Name = 'comfy_output_dir'; Value = $config.comfy_output_dir; Kind = 'Container' }
  )
  $badPaths = @()
  foreach ($check in $pathChecks) {
    if (-not (Test-Path -LiteralPath $check.Value)) { $badPaths += ("{0}={1}" -f $check.Name, $check.Value) }
  }
  if ($badPaths.Count -eq 0) {
    Add-Result 'PASS' 'config 路径存在' 'comfy_python / comfy_main / comfy_root / comfy_output_dir'
  } else {
    Add-Result 'FAIL' 'config 路径存在' ($badPaths -join ' | ') 'ComfyUI 可能被移动/改名，改 config.json 后重跑'
  }

  $modelBad = @()
  foreach ($model in @($config.models.unet, $config.models.clip, $config.models.vae)) {
    if (-not $model) { $modelBad += '(空)'; continue }
    $found = Get-ChildItem -LiteralPath $config.comfy_root -Recurse -Filter $model -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { $modelBad += $model }
  }
  if ($modelBad.Count -eq 0) {
    Add-Result 'PASS' '模型文件存在' ("{0} / {1} / {2}" -f $config.models.unet, $config.models.clip, $config.models.vae)
  } else {
    Add-Result 'FAIL' '模型文件存在' ("在 comfy_root 下找不到: " + ($modelBad -join ', ')) '核对 config.json 的 models 与磁盘上的实际文件名'
  }
}

# ── 4. offline self test ────────────────────────────────────────────────────
$serverVersion = '(未知)'
if (Test-Path -LiteralPath $ServerPath) {
  $selfTest = Invoke-Native $NodeExe @($ServerPath, '--self-test')
  $selfTestOutput = $selfTest.StdOut
  $selfTestExit = $selfTest.ExitCode
  $passLine = ($selfTestOutput -split "`r?`n" | Where-Object { $_ -match 'SELF-TEST' } | Select-Object -First 1)
  if ($selfTestExit -eq 0) {
    Add-Result 'PASS' 'server --self-test' $passLine
  } else {
    $failLines = ($selfTestOutput -split "`r?`n" | Where-Object { $_ -match 'FAIL ' } | Select-Object -First 6) -join ' / '
    Add-Result 'FAIL' 'server --self-test' ("{0} :: {1}" -f $passLine, $failLines) '按上面列出的失败项修复 server.mjs / config.json'
  }
  $versionMatch = [regex]::Match([System.IO.File]::ReadAllText($ServerPath, [System.Text.Encoding]::UTF8), 'SERVER_VERSION\s*=\s*"([^"]+)"')
  if ($versionMatch.Success) { $serverVersion = $versionMatch.Groups[1].Value }
}

# ── 5. profile patch block ──────────────────────────────────────────────────
$patchApplied = $false
if (-not (Test-Path -LiteralPath $ProfilePatchPath)) {
  Add-Result 'FAIL' '鲸鱼娘 profile 补丁文件' "$ProfilePatchPath 不存在" '确认整合包已正确安装；本 MCP 只支持鲸鱼娘 profile'
} else {
  $patchText = Get-NormalizedText $ProfilePatchPath
  $snippetText = Get-NormalizedText $SnippetPath
  $snippetText = $snippetText.Replace('__QWENIMG_SERVER_PATH__', (Join-Path $ProjectRoot 'server.mjs').Replace("'", "''"))
  $snippetText = $snippetText.TrimEnd("`n") + "`n"

  if ($patchText.IndexOf($MarkerStart) -lt 0) {
    Add-Result 'WARN' 'MCP 补丁块' '未找到 qwen-image-mcp 管理块' '可能被整合包更新覆盖：正常退出 DSH 后运行 scripts\install-patch.ps1 -Apply'
  } else {
    $start = $patchText.IndexOf($MarkerStart)
    $end = $patchText.IndexOf($MarkerEnd, $start)
    if ($end -lt 0) {
      Add-Result 'FAIL' 'MCP 补丁块' '只有开始标记，没有结束标记' '人工修好标记行，或删掉残留标记后重跑 install-patch.ps1 -Apply'
    } else {
      $endOfLine = $patchText.IndexOf("`n", $end)
      if ($endOfLine -lt 0) { $endOfLine = $patchText.Length - 1 }
      $block = $patchText.Substring($start, $endOfLine + 1 - $start)
      # Line-wise comparison: invariant to trailing whitespace / final newline
      # differences, still sensitive to any real content change.
      $blockLines = (($block -split "`n") | ForEach-Object { $_.TrimEnd() }) -join "`n"
      $snippetLines = (($snippetText -split "`n") | ForEach-Object { $_.TrimEnd() }) -join "`n"
      if ($blockLines.Trim() -eq $snippetLines.Trim()) {
        $patchApplied = $true
        Add-Result 'PASS' 'MCP 补丁块' '已应用，且与 cordis.patch.snippet.yml 完全一致'
      } else {
        Add-Result 'WARN' 'MCP 补丁块' '已存在但与权威副本不一致' '用 install-patch.ps1 -Apply 覆盖为权威内容（块外内容不受影响）'
      }
    }
  }

  if ($patchText -match '(?m)^\s*-?\s*id\s*:\s*[''"]?mcp-dsh-computer-use-win[''"]?\s*$' -or $patchText -match 'serverName:\s*wincu') {
    Add-Result 'PASS' 'wincu 条目仍在' '未破坏现有电脑操控 MCP（只读确认）'
  } else {
    Add-Result 'WARN' 'wincu 条目仍在' '没找到 wincu/serverName 相关条目' '确认没有误删整合包自带插件；本 MCP 不依赖它，但它的缺失说明补丁文件被大改过'
  }
}

# ── 6. host version vs launcher guard ───────────────────────────────────────
$hostVersion = $null
if (Test-Path -LiteralPath $HostExePath) {
  $hostVersion = (Get-Item -LiteralPath $HostExePath).VersionInfo.FileVersion
}
$validatedVersion = $null
if (Test-Path -LiteralPath $LauncherPath) {
  $launcherText = [System.IO.File]::ReadAllText($LauncherPath, [System.Text.Encoding]::UTF8)
  $guardMatch = [regex]::Match($launcherText, '\$validatedVersion\s*=\s*[''"]([^''"]+)[''"]')
  if ($guardMatch.Success) { $validatedVersion = $guardMatch.Groups[1].Value }
}

if (-not $hostVersion) {
  Add-Result 'WARN' 'DSH 宿主版本' "读不到 $HostExePath 的 FileVersion" '确认 DSH 仍安装在该路径'
} elseif (-not $validatedVersion) {
  Add-Result 'WARN' '对照启动器版本保护' '未能在启动器里解析出 $validatedVersion' '只读检查失败；确认启动器未被重写'
} elseif ($hostVersion -eq $validatedVersion) {
  Add-Result 'PASS' '对照启动器版本保护' "宿主 $hostVersion = 启动器放行版本 $validatedVersion"
} else {
  Add-Result 'WARN' '对照启动器版本保护' "宿主 $hostVersion ≠ 启动器放行版本 $validatedVersion" '启动器会拦截，这是正常保护；需按 vault 里《启动与更新》流程验证新宿主后再更新该变量'
}

# ── 7. last-check record ────────────────────────────────────────────────────
$lastCheck = $null
if (Test-Path -LiteralPath $LastCheckPath) {
  try {
    $lastCheck = Get-Content -LiteralPath $LastCheckPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Add-Result 'WARN' 'state\last-check.json' '解析失败' '删除该文件后重跑 check.ps1 -Live -Record'
  }
}
if ($lastCheck -and $hostVersion) {
  $lastCheckedVersion = if ($lastCheck.dshVersionChecked) { $lastCheck.dshVersionChecked } else { $lastCheck.dshVersionVerified }
  if ($lastCheckedVersion -eq $hostVersion) {
    Add-Result 'PASS' '上次环境核对的宿主版本' "$($lastCheck.date) 记录为 $lastCheckedVersion（不代表 DSH 内工具实测）"
  } else {
    Add-Result 'WARN' '上次环境核对的宿主版本' "记录为 $lastCheckedVersion，当前宿主是 $hostVersion" '宿主已变化：重启 DSH 后重新验证，并用 check.ps1 -Live -Record 记录'
  }
} elseif (-not $lastCheck) {
  Add-Result 'WARN' 'state\last-check.json' '还没有验证记录' '重启 DSH 并确认工具可用后运行 check.ps1 -Live -Record'
}

# ── 8. live check ───────────────────────────────────────────────────────────
if ($Live) {
  if (Test-Path -LiteralPath $ServerPath) {
    $statusRun = Invoke-Native $NodeExe @($ServerPath, '--status')
    $statusOutput = $statusRun.StdOut
    $statusExit = $statusRun.ExitCode
    Write-Host '--- server --status ---'
    Write-Host $statusOutput.TrimEnd()
    Write-Host '-----------------------'
    if ($statusExit -eq 0) {
      if ($statusOutput -match 'comfyui=未运行') {
        Add-Result 'WARN' 'ComfyUI 联机状态' '未运行（check 不会自动拉起，避免占显存）' '需要出图时运行 E:\ComfyUI\启动Qwen8GB.bat，或在 DSH 里直接调用 generate 让 MCP 拉起'
      } else {
        $modelLines = ($statusOutput -split "`r?`n" | Where-Object { $_ -match '^model_' }) -join ' ; '
        if ($modelLines -match '缺失') {
          Add-Result 'FAIL' 'ComfyUI 联机状态' $modelLines '模型名与 config.json 不一致，或模型文件被移动'
        } else {
          Add-Result 'PASS' 'ComfyUI 联机状态' "可达；$modelLines"
        }
      }
    } else {
      Add-Result 'FAIL' 'ComfyUI 联机状态' 'server --status 非零退出' '看上面输出，或 logs\ 下最新日志'
    }
  }
} else {
  Write-Host '[SKIP] ComfyUI 联机状态（未加 -Live，不触碰 GPU）' -ForegroundColor DarkGray
}

# ── summary ─────────────────────────────────────────────────────────────────
$failCount = @($results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = @($results | Where-Object { $_.Status -eq 'WARN' }).Count
$passCount = @($results | Where-Object { $_.Status -eq 'PASS' }).Count

Write-Host ''
Write-Host ("汇总: PASS={0} WARN={1} FAIL={2}" -f $passCount, $warnCount, $failCount)

if ($failCount -gt 0) {
  Write-Host '结论: 有问题需要处理（见上面 FAIL 行）。' -ForegroundColor Red
  Write-Host '建议下一步: 先修 FAIL 项；补丁相关一律先 install-patch.ps1（dry-run）再 -Apply。' -ForegroundColor Red
} elseif (-not $patchApplied) {
  Write-Host '结论: 文件层面正常，但 MCP 补丁未应用（或与权威副本不一致），DSH 里看不到 mcp__qwenimg__* 工具。' -ForegroundColor Yellow
  Write-Host '建议下一步: 正常退出 DSH -> scripts\install-patch.ps1（预览）-> -Apply -> 重启“DSH 鲸鱼娘” -> check.ps1 -Live -Record。' -ForegroundColor Yellow
} elseif ($warnCount -gt 0) {
  Write-Host '结论: 基本正常，有 WARN 需要注意。' -ForegroundColor Yellow
  Write-Host '建议下一步: 逐条看 WARN；宿主版本相关 WARN 属于启动器保护，需要人工验证新宿主。' -ForegroundColor Yellow
} else {
  Write-Host '结论: 全部通过。' -ForegroundColor Green
  Write-Host '建议下一步: 在 DSH 里调用 mcp__qwenimg__status 与 generate 复测；需要留档就加 -Record。' -ForegroundColor Green
}

if ($Record) {
  if (-not $Live) {
    Write-Host 'NOTE: -Record 需要配合 -Live 使用，本次未写记录。' -ForegroundColor Yellow
  } elseif ($failCount -gt 0) {
    Write-Host 'NOTE: 仍有 FAIL，未写 last-check.json。' -ForegroundColor Yellow
  } else {
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
    $checkRecord = [pscustomobject]@{
      date               = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
      dshVersionChecked  = $hostVersion
      dshToolsVerified   = $false
      launcherValidated  = $validatedVersion
      serverVersion      = $serverVersion
      patchApplied       = $patchApplied
      node               = $nodeVersion
      live               = [bool]$Live
      result             = ("PASS={0} WARN={1} FAIL={2}" -f $passCount, $warnCount, $failCount)
    }
    $checkRecord | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $LastCheckPath -Encoding UTF8
    Write-Host ("已写入验证记录: {0}" -f $LastCheckPath) -ForegroundColor Green
  }
}

if ($failCount -gt 0) { exit 1 }
exit 0
