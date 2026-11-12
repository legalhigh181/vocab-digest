# 词汇库 安装脚本：检查 Node.js、创建桌面与开始菜单快捷方式。
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root '客户端.vbs'

Write-Host ''
Write-Host '  词汇库 - 安装'
Write-Host '  ================================'
Write-Host ''

# ── 1. 找 Node.js ────────────────────────────────────────────
# 注意：刚装完 Node 时，当前这个进程的 PATH 里还没有它。
# 所以除了 PATH，还要去几个常见安装位置找一遍。
$nodePath = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) {
    $nodePath = $cmd.Source
} else {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $nodePath = $c; break }
    }
}

if (-not $nodePath) {
    Write-Host '  [X] 这台电脑还没装 Node.js。'
    Write-Host ''
    Write-Host '      词汇库是用 Node.js 写的，需要一个运行环境（装一次就好）。'
    Write-Host '      步骤：'
    Write-Host '        1) 打开 https://nodejs.org/zh-cn/download'
    Write-Host '        2) 下载标着 LTS 的 Windows 安装包（.msi），一路「下一步」'
    Write-Host '        3) 装完关掉这个黑窗口，再双击一次「安装.cmd」'
    Write-Host ''
    Write-Host '      要不要现在就帮你打开下载页面？'
    $ans = Read-Host '      输入 y 打开 / 直接回车跳过'
    if ($ans -eq 'y' -or $ans -eq 'Y') {
        Start-Process 'https://nodejs.org/zh-cn/download'
        Write-Host '      已经打开了，下载安装完再双击「安装.cmd」。'
    }
    exit 1
}

# ── 2. 检查版本 ──────────────────────────────────────────────
$verText = (& $nodePath -v).Trim()
$ver = $verText.TrimStart('v')
$major = [int]($ver.Split('.')[0])
Write-Host ('  [ok] Node.js ' + $verText + '  (' + $nodePath + ')')
if ($major -lt 20) {
    Write-Host ''
    Write-Host ('  [X] 版本太旧了（需要 20 或更高，当前是 ' + $major + '）。')
    Write-Host '      去 https://nodejs.org/zh-cn/download 装新版，覆盖安装即可。'
    exit 1
}

# ── 3. 检查启动器 ────────────────────────────────────────────
if (-not (Test-Path $vbs)) {
    Write-Host ('  [X] 找不到启动器：' + $vbs)
    Write-Host '      zip 可能没解压完整，重新解压一次试试。'
    exit 1
}

# ── 4. 建快捷方式 ────────────────────────────────────────────
Write-Host '  正在创建快捷方式...'
& (Join-Path $PSScriptRoot 'install-shortcuts.ps1')

# ── 5. 词典提示 ──────────────────────────────────────────────
$dict = Join-Path $root 'data\ecdict.csv'
if (-not (Test-Path $dict)) {
    Write-Host ''
    Write-Host '  [提示] 还没有本地英汉词典 data\ecdict.csv（约 66MB）。'
    Write-Host '         没有它也能用，只是多数词条只有英文释义。'
    Write-Host '         想要中文释义，双击「下载词典.cmd」下载即可，只需一次。'
    $ans = Read-Host '         现在下载吗？(y / 回车跳过)'
    if ($ans -eq 'y' -or $ans -eq 'Y') {
        & (Join-Path $PSScriptRoot 'download-dict.ps1')
    }
}

# ── 6. 试跑一次 ──────────────────────────────────────────────
Write-Host ''
Write-Host '  正在做一次自检...'
Push-Location $root
try {
    $out = & $nodePath 'bin\vocab-english.js' 'status' 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Host '  [ok] 程序能正常运行'
    } else {
        Write-Host '  [!] 自检没通过，输出如下：'
        Write-Host $out
    }
} catch {
    Write-Host '  [!] 自检时出错：' + $_.Exception.Message
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '  装好了！以后双击桌面的「词汇库」就能打开。'
Write-Host ''
