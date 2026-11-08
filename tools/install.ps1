# 词汇库 安装脚本：检查 Node.js、创建桌面与开始菜单快捷方式。
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root '客户端.vbs'
$ico = Join-Path $root 'app\public\img\vocab.ico'

Write-Host ''
Write-Host '  词汇库 - 安装'
Write-Host '  ================================'
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '  [X] 没有找到 Node.js。'
    Write-Host '      这个工具需要 Node.js 20 或更高版本。'
    Write-Host '      下载：https://nodejs.org/zh-cn/download'
    Write-Host '      装完再运行一次「安装.cmd」即可。'
    exit 1
}
Write-Host ('  [ok] Node.js ' + (& node -v))

if (-not (Test-Path $vbs)) {
    Write-Host "  [X] 找不到启动器：$vbs"
    exit 1
}

Write-Host '  正在创建快捷方式...'
& (Join-Path $PSScriptRoot 'install-shortcuts.ps1')

if (-not (Test-Path (Join-Path $root 'data\ecdict.csv'))) {
    Write-Host ''
    Write-Host '  [提示] 还没有本地英汉词典 data\ecdict.csv。'
    Write-Host '         没有它也能用，只是多数词条只有英文释义。'
    Write-Host '         需要的话，双击「下载词典.cmd」会自动下载（约 66MB）。'
}

Write-Host ''
Write-Host '  装好了。以后双击桌面的「词汇库」就能打开。'
Write-Host ''
