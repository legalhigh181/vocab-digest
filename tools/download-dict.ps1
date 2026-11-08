# 下载 ECDICT 英汉词典（66MB）到 data\ecdict.csv。
# 也可以用系统代理：先设好环境变量 HTTP_PROXY / HTTPS_PROXY 再运行。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'data'
$out = Join-Path $dir 'ecdict.csv'
$url = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
$expect = 66009548

function Get-Size($p) {
    if (Test-Path $p) { (Get-Item $p).Length } else { 0 }
}

if ((Get-Size $out) -eq $expect) {
    Write-Host '  词典已经下好了，不用重复下载。'
    exit 0
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host ''
Write-Host '  正在下载 ECDICT 英汉词典（约 66MB）...'
Write-Host "  来源：$url"
Write-Host ''

$tmp = "$out.part"
if (Test-Path $tmp) { Remove-Item $tmp -Force }

try {
    # curl.exe 在 Windows 10 1803+ 自带，支持断点续传与代理环境变量
    $curl = Join-Path $env:WINDIR 'System32\curl.exe'
    if (Test-Path $curl) {
        & $curl -L --fail --retry 3 -o $tmp $url
    } else {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    }
} catch {
    Write-Host ('  [X] 下载失败：' + $_.Exception.Message)
    Write-Host '      如果你的网络需要代理，先开好代理再试；'
    Write-Host '      或者手动下载后放到 data\ecdict.csv。'
    exit 1
}

$size = Get-Size $tmp
if ($size -ne $expect) {
    Write-Host "  [X] 文件大小不对：$size 字节（应为 $expect），可能没下完。"
    Write-Host "      已保留下载中的文件：$tmp"
    exit 1
}

Move-Item $tmp $out -Force
Write-Host ''
Write-Host '  完成！词典已保存到 data\ecdict.csv'
Write-Host ''
