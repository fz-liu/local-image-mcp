<#
.SYNOPSIS
  Install/remove only the managed qwen-image-mcp block. Default: dry-run.
.DESCRIPTION
  Preserves outside bytes, BOM, mixed line endings and block position.
  Writes atomically, refuses duplicate/broken markers, backs up one copy.
  Windows PowerShell 5.1 compatible; this script uses UTF-8 with BOM.
#>
[CmdletBinding()]
param([switch]$Apply, [switch]$Remove, [switch]$Force, [string]$ProfilePatchFile)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SnippetPath = Join-Path $ProjectRoot 'cordis.patch.snippet.yml'
if (-not (Test-Path -LiteralPath $SnippetPath)) { $SnippetPath = Join-Path $ProjectRoot 'cordis.patch.example.yml' }
$StateDir = Join-Path $ProjectRoot 'state'
$LogDir = Join-Path $ProjectRoot 'logs'
$DefaultProfilePatch = Join-Path $env:USERPROFILE '.dsh-pack-better\profiles\desktop\cordis.patch.yml'
$TargetPath = if ($ProfilePatchFile) { [IO.Path]::GetFullPath($ProfilePatchFile) } else { $DefaultProfilePatch }
$Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$PluginIdPattern = '(?m)^[ \t]*-?[ \t]*id[ \t]*:[ \t]*[''"]?mcp-qwen-image[''"]?[ \t]*(?:#[^\r\n]*)?\r?$'

function Get-Hash([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)) }
  finally { $sha.Dispose() }
}
function Get-Bounds([string]$Text) {
  $starts = [regex]::Matches($Text, '(?m)^# >>> qwen-image-mcp[^\r\n]*(?:\r?\n|$)')
  $ends = [regex]::Matches($Text, '(?m)^# <<< qwen-image-mcp <<<[ \t]*(?:\r?\n|$)')
  if ($starts.Count -eq 0 -and $ends.Count -eq 0) { return $null }
  if ($starts.Count -ne 1 -or $ends.Count -ne 1 -or $ends[0].Index -lt $starts[0].Index) {
    throw '标记残缺、重复或顺序错误；请先人工核对，未修改文件。'
  }
  return [pscustomobject]@{ Start = $starts[0].Index; End = $ends[0].Index + $ends[0].Length }
}
function Get-Outside([string]$Text, $Bounds) {
  if ($null -eq $Bounds) { return $Text }
  return $Text.Substring(0, $Bounds.Start) + $Text.Substring($Bounds.End)
}
function Test-DshRunning {
  return @(Get-Process -Name 'DeepSeek Harness', 'dsh' -ErrorAction SilentlyContinue)
}

$tempPath = $null
$replaced = $false
try {
  if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) { throw "目标补丁文件不存在: $TargetPath" }
  $originalBytes = [IO.File]::ReadAllBytes($TargetPath)
  $hasBom = $originalBytes.Length -ge 3 -and $originalBytes[0] -eq 239 -and $originalBytes[1] -eq 187 -and $originalBytes[2] -eq 191
  $offset = if ($hasBom) { 3 } else { 0 }
  $text = $Utf8.GetString($originalBytes, $offset, $originalBytes.Length - $offset)
  $bounds = Get-Bounds $text
  $outside = Get-Outside $text $bounds
  if ([regex]::IsMatch($outside, $PluginIdPattern)) { throw '管理块外存在 id: mcp-qwen-image，拒绝覆盖手工配置。' }
  $snippet = [IO.File]::ReadAllText($SnippetPath, $Utf8) -replace "`r`n", "`n"
  $serverPath = (Join-Path $ProjectRoot 'server.mjs').Replace("'", "''")
  $snippet = $snippet.Replace('__QWENIMG_SERVER_PATH__', $serverPath)
  $snippet = $snippet.TrimEnd("`n") + "`n"
  $snippetBounds = Get-Bounds $snippet
  if ($null -eq $snippetBounds -or $snippetBounds.Start -ne 0 -or $snippetBounds.End -ne $snippet.Length) {
    throw '权威补丁必须恰好包含一个完整管理块。'
  }
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $snippet = $snippet.Replace("`n", $newline)
  if ($Remove) {
    if ($null -eq $bounds) { Write-Host 'NOTHING TO DO: 管理块不存在。'; exit 0 }
    $desired = $outside
  } elseif ($null -ne $bounds) {
    $desired = $text.Substring(0, $bounds.Start) + $snippet + $text.Substring($bounds.End)
  } elseif ($text.Length -eq 0 -or $text.EndsWith("`n")) {
    $desired = $text + $snippet
  } else {
    # Prepend if there is no final newline: removal restores the exact bytes.
    $desired = $snippet + $text
  }
  if ($desired -ceq $text) { Write-Host 'NO-OP: 管理块内容一致。'; exit 0 }
  Write-Host "目标文件: $TargetPath"
  Write-Host "操作: $(if ($Remove) { '移除管理块' } else { '安装或更新管理块' })"
  if (-not $Apply) {
    Write-Host 'DRY RUN: 未写入文件。'
    if (-not $Remove) { Write-Host $snippet }
    if (@(Test-DshRunning).Count) { Write-Host 'DSH 正在运行；实际应用前请正常退出。' }
    Write-Host "应用命令: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Apply"
    exit 0
  }
  if (@(Test-DshRunning).Count -gt 0 -and -not $Force) { throw 'DSH 正在运行，拒绝写入；请先正常退出 DSH。' }
  [IO.Directory]::CreateDirectory($StateDir) | Out-Null
  [IO.Directory]::CreateDirectory($LogDir) | Out-Null
  $backupName = if ($TargetPath -ieq $DefaultProfilePatch) { 'cordis.patch.whale.bak' } else { 'cordis.patch.custom-target.bak' }
  $backupPath = Join-Path $StateDir $backupName
  [IO.File]::WriteAllBytes($backupPath, $originalBytes)
  $encoded = $Utf8.GetBytes($desired)
  [byte[]]$desiredBytes = $encoded
  if ($hasBom) { $desiredBytes = @([byte]239, [byte]187, [byte]191) + $encoded }
  $tempPath = Join-Path ([IO.Path]::GetDirectoryName($TargetPath)) ('.qwenimg-' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllBytes($tempPath, $desiredBytes)
  if ((Get-Hash ([IO.File]::ReadAllBytes($TargetPath))) -ne (Get-Hash $originalBytes)) { throw '目标被其他程序修改，未覆盖。' }
  [IO.File]::Replace($tempPath, $TargetPath, [System.Management.Automation.Language.NullString]::Value)
  $replaced = $true
  $verifiedBytes = [IO.File]::ReadAllBytes($TargetPath)
  if ((Get-Hash $verifiedBytes) -ne (Get-Hash $desiredBytes)) { throw '写入字节不符合预期。' }
  $verifiedText = $Utf8.GetString($verifiedBytes, $offset, $verifiedBytes.Length - $offset)
  $verifiedOutside = Get-Outside $verifiedText (Get-Bounds $verifiedText)
  if ((Get-Hash ($Utf8.GetBytes($verifiedOutside))) -ne (Get-Hash ($Utf8.GetBytes($outside)))) { throw '块外字节自校验失败。' }
  Add-Content -LiteralPath (Join-Path $LogDir 'install-patch.log') -Encoding UTF8 -Value ("{0} action={1} target={2} result=ok" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $(if ($Remove) { 'remove' } else { 'apply' }), $TargetPath)
  Write-Host 'OK: 原子写入完成；块外字节、BOM 与原有换行保持不变。'
  Write-Host '启动 DSH 鲸鱼娘后，先调用 mcp__qwenimg__status，再生成一张图片。'
} catch {
  if ($replaced) { [IO.File]::WriteAllBytes($TargetPath, $originalBytes); Write-Host '已回滚到写入前的字节。' }
  Write-Host ("FAIL: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($tempPath -and [IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
}
exit 0
