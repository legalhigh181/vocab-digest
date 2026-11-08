# 在桌面和开始菜单创建「词汇库」快捷方式。
# 由 安装.cmd 调用；也可以右键「使用 PowerShell 运行」。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# ── 启动器：有 exe 就用 exe，没有就退回 vbs + wscript ──────────────
$exe = Join-Path $root '词汇库.exe'
$vbs = Join-Path $root '客户端.vbs'
$useExe = Test-Path $exe
if (-not $useExe -and -not (Test-Path $vbs)) {
    Write-Host "  找不到启动器（词汇库.exe 或 客户端.vbs）"
    exit 1
}

# ── 图标：必须放在「纯英文路径」下 ─────────────────────────────────
# 实测：同一个 .ico 放在含中文的目录（比如 Documents\工作区 2\...）里，
# 快捷方式会显示成白纸；复制到 %LOCALAPPDATA%\VocabDigest\ 后立刻正常。
# 所以这里复制一份出去，再让快捷方式指向复制品。
$icoSrc = Join-Path $root 'app\public\img\vocab.ico'
$icoDir = Join-Path $env:LOCALAPPDATA 'VocabDigest'
$ico = Join-Path $icoDir 'vocab.ico'
if (Test-Path $icoSrc) {
    New-Item -ItemType Directory -Force -Path $icoDir | Out-Null
    Copy-Item $icoSrc $ico -Force
}

$targets = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)

$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in $targets) {
    if (-not (Test-Path $dir)) { continue }
    $lnk = Join-Path $dir '词汇库.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
    $s = $wsh.CreateShortcut($lnk)
    if ($useExe) {
        $s.TargetPath = $exe
        $s.Arguments = ''
        $s.WindowStyle = 1
    } else {
        $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $s.Arguments = '"' + $vbs + '"'
        $s.WindowStyle = 7
    }
    $s.WorkingDirectory = $root
    if (Test-Path $ico) { $s.IconLocation = $ico + ',0' }
    $s.Description = '词汇库 - 弹幕字幕英语词汇整理'
    $s.Save()
    Write-Host "  已创建：$lnk"
}

# 让资源管理器刷新图标缓存
try { & ie4uinit.exe -show } catch {}
Write-Host '  完成。'
