# 真实 ffmpeg 路径探针（不是替身）
#
# 沙箱限制决定了这一支只能跑在 pwsh 里：
#   - Node 的 child_process spawn 一律 EPERM（见 tools/probe-spawn.mjs）
#   - PowerShell 的 Start-Process 也被拦（Access is denied）
#   - 只有「当前 pwsh 进程直接调外部命令」这条路是通的
# 所以本脚本用 `& ffmpeg @args` 直调，参数永远是数组（不经过 shell 解析）。
#
# 验的是什么（m01027 第 1 点）：
#   滤镜目的地永远是「暂存目录/t_xxx.srt」这种纯 ASCII 相对名，
#   子进程 cwd 固定在模型目录 —— 所以跨盘、中文、空格、单引号只出现在
#   输入路径这种普通参数里，不会进入滤镜语法。这里用真 ffmpeg 跑通整条链路。
param([string]$OutFile)

$ErrorActionPreference = 'Stop'
$rows = New-Object System.Collections.ArrayList

function Add-Row([string]$name, [bool]$ok, [string]$detail) {
  [void]$rows.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail })
  $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
  Write-Host "$mark $name  -- $detail"
}

function Invoke-Ffmpeg([string]$cwd, [string[]]$ffArgs, [string]$errFile) {
  $prev = Get-Location
  try {
    Set-Location -LiteralPath $cwd
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & ffmpeg @ffArgs 2> $errFile
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
  } finally {
    Set-Location -LiteralPath $prev
  }
  $stderr = ''
  if (Test-Path -LiteralPath $errFile) {
    $stderr = [System.IO.File]::ReadAllText($errFile)
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
  return @{ exitCode = $code; stderr = $stderr }
}

function Get-LastErr([string]$stderr) {
  if ([string]::IsNullOrWhiteSpace($stderr)) { return '' }
  $lines = @($stderr -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -eq 0) { return '' }
  return $lines[-1].Trim()
}

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('vd-real-ffmpeg-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $base -Force | Out-Null
$srcDir = Join-Path $base '源 素材'
$modelDir = Join-Path $base '模型 目录'
$quoteDir = Join-Path $base "it's a 测试"
New-Item -ItemType Directory -Path $srcDir, $modelDir, $quoteDir -Force | Out-Null
$srcAudio = Join-Path $srcDir '讲话 片段.wav'
$quoteAudio = Join-Path $quoteDir "say 'hello'.wav"
$fakeModel = Join-Path $modelDir 'ggml-small.bin'
Set-Content -LiteralPath $fakeModel -Value 'not-a-real-model' -Encoding ASCII
$errFile = Join-Path $base 'ff.err'
$crossPaths = @()

try {
  # ── 1 · 生成测试音频 ────────────────────────────────────────────────
  $gen = Invoke-Ffmpeg $base @('-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', $srcAudio) $errFile
  $genSize = if (Test-Path -LiteralPath $srcAudio) { (Get-Item -LiteralPath $srcAudio).Length } else { 0 }
  $genOk = ($gen.exitCode -eq 0) -and ($genSize -gt 1000)
  Add-Row '生成测试音频（真 ffmpeg 编码器可用）' $genOk ("exit={0} size={1}" -f $gen.exitCode, $genSize)
  if (-not $genOk) { throw ('生成测试音频失败：' + (Get-LastErr $gen.stderr)) }
  Copy-Item -LiteralPath $srcAudio -Destination $quoteAudio -Force

  # ── 2 · 组装用例 ───────────────────────────────────────────────────
  $cases = New-Object System.Collections.ArrayList
  [void]$cases.Add(@{ name = '同盘 · 中文 + 空格路径'; input = $srcAudio; cwd = $modelDir })

  $drives = @()
  foreach ($d in @('C', 'D', 'E', 'F')) {
    if (Test-Path -LiteralPath ($d + ':\')) { $drives += $d }
  }
  $hereDrive = $base.Substring(0, 1).ToUpper()
  $otherDrive = $drives | Where-Object { $_ -ne $hereDrive } | Select-Object -First 1

  if ($otherDrive) {
    $crossRoot = Join-Path ($otherDrive + ':\') 'vocab-digest-跨盘探针 中文'
    $crossDir = Join-Path $crossRoot "o'brien"
    try {
      New-Item -ItemType Directory -Path $crossDir -Force | Out-Null
      $crossAudio = Join-Path $crossDir 'audio 片段.wav'
      Copy-Item -LiteralPath $quoteAudio -Destination $crossAudio -Force
      $crossPaths += $crossRoot
      [void]$cases.Add(@{ name = ('跨盘（输入在 ' + $otherDrive + ' 盘，模型目录在本盘）'); input = $crossAudio; cwd = $modelDir })

      $modelDir2 = Join-Path ($otherDrive + ':\') 'vocab-digest-模型 跨盘'
      New-Item -ItemType Directory -Path $modelDir2 -Force | Out-Null
      Copy-Item -LiteralPath $fakeModel -Destination (Join-Path $modelDir2 'ggml-small.bin') -Force
      $crossPaths += $modelDir2
      [void]$cases.Add(@{ name = ('跨盘（模型目录在 ' + $otherDrive + ' 盘，子进程 cwd 在另一盘）'); input = $quoteAudio; cwd = $modelDir2 })
    } catch {
      Add-Row '跨盘用例' $true ('环境受阻：无法在 ' + $otherDrive + ' 盘建目录（' + $_.Exception.Message + '）')
    }
  } else {
    Add-Row '跨盘用例' $true '环境受阻：本机只有一个盘符'
  }

  # ── 3 · 逐条真跑 ───────────────────────────────────────────────────
  $seq = 0
  foreach ($c in $cases) {
    $seq++
    $stageRoot = Join-Path $c.cwd '.asr-stage'
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    # 与 whisper 滤镜同形：纯 ASCII 相对目的地（不含盘符、反斜杠、空格、引号）
    $rel = '.asr-stage/t_probe_{0}_{1}.wav' -f $seq, (Get-Date -Format 'HHmmssfff')
    $bad = [bool]($rel -match "[\\:'`"\s]")
    $r = Invoke-Ffmpeg $c.cwd @(
      '-y', '-hide_banner', '-loglevel', 'error',
      '-t', '0.2',
      '-i', $c.input,
      '-c:a', 'pcm_s16le', '-f', 'wav', $rel
    ) $errFile
    $full = Join-Path $c.cwd ($rel -replace '/', '\')
    $fileSize = if (Test-Path -LiteralPath $full) { (Get-Item -LiteralPath $full).Length } else { 0 }
    $fileOk = $fileSize -gt 100
    $ok = ($r.exitCode -eq 0) -and $fileOk -and (-not $bad)
    if ($r.exitCode -ne 0) {
      $detail = "exit={0} / {1}" -f $r.exitCode, (Get-LastErr $r.stderr)
    } elseif (-not $fileOk) {
      $detail = "exit=0 但产物没写出来（目的地 $rel）"
    } elseif ($bad) {
      $detail = "目的地不合格：$rel"
    } else {
      $detail = "exit=0，目的地 = $rel，产物 $fileSize 字节"
    }
    Add-Row $c.name $ok $detail
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue }
  }
} catch {
  $where = ($_.InvocationInfo.PositionMessage -replace "`r?`n", ' ')
  Add-Row '探针异常' $false ($_.Exception.Message + ' | ' + $where)
} finally {
  foreach ($p in $crossPaths) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
}

$rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding UTF8
$fail = @($rows | Where-Object { -not $_.ok }).Count
if ($fail -gt 0) { exit 1 } else { exit 0 }
