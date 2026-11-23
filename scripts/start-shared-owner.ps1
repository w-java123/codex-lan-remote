param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'CodexLAN' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请用普通用户权限打开共享控制入口'
}
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw '未找到当前 Windows Codex 桌面安装' }
$desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$binary = Join-Path $package.InstallLocation 'app\resources\codex.exe'
if (-not (Test-Path -LiteralPath $desktop -PathType Leaf) -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw '当前桌面安装缺少配套 App Server'
}
$current = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
    Where-Object { $_.ExecutablePath -eq $desktop -and $_.CommandLine -notmatch '(?:^|\s)--type=' }
if ($current) { throw '请先等待正在执行的任务结束并正常退出 Codex，再打开共享控制入口' }
$plugin = Split-Path -Parent $PSScriptRoot
& (Join-Path $plugin 'runtime\node.exe') (Join-Path $plugin 'desktop\shared-owner.mjs') $DataDirectory $desktop $binary
if ($LASTEXITCODE) { exit $LASTEXITCODE }
