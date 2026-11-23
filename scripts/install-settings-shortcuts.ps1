param(
    [Parameter(Mandatory=$true)][string]$PluginDirectory,
    [string]$DataDirectory,
    [string]$ShortcutRoot
)
$ErrorActionPreference = 'Stop'
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'CodexLAN' }
$taskOpen = Join-Path $PluginDirectory 'scripts\start-desktop-plugin.ps1'
if (-not (Test-Path -LiteralPath $taskOpen)) { throw '插件未完整安装，找不到设置启动程序' }
New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$taskLauncher = Join-Path $DataDirectory 'open-settings.ps1'
# Store paths only. Each launch obtains a fresh capability; no token in shortcuts.
$taskLauncherText = "`$ErrorActionPreference = 'Stop'`n& '" + $taskOpen.Replace("'","''") + "' -DataDirectory '" + $DataDirectory.Replace("'","''") + "'`n"
[IO.File]::WriteAllText($taskLauncher,$taskLauncherText,[Text.UTF8Encoding]::new($true))
$taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskTargets = if ($ShortcutRoot) { @($ShortcutRoot) } else { @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex LAN')) }
$taskShell = New-Object -ComObject WScript.Shell
foreach ($taskDirectory in $taskTargets) {
    New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
    $taskShortcut = $taskShell.CreateShortcut((Join-Path $taskDirectory '手机连接设置.lnk'))
    $taskShortcut.TargetPath = $taskPowerShell
    $taskShortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskLauncher + '"'
    $taskShortcut.WorkingDirectory = $DataDirectory
    $taskShortcut.Description = '打开 Codex LAN 手机连接设置：电脑连接、EasyTier、配对与设备管理'
    $taskShortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',17'
    $taskShortcut.WindowStyle = 7
    $taskShortcut.Save()
    $shared = Join-Path $PluginDirectory 'scripts\start-shared-owner.ps1'
    if (Test-Path -LiteralPath $shared -PathType Leaf) {
        $sharedShortcut = $taskShell.CreateShortcut((Join-Path $taskDirectory 'Codex 手机共享控制.lnk'))
        $sharedShortcut.TargetPath = $taskPowerShell
        $sharedShortcut.Arguments = '-NoProfile -NoExit -ExecutionPolicy Bypass -File "' + $shared + '" -DataDirectory "' + $DataDirectory + '"'
        $sharedShortcut.WorkingDirectory = $DataDirectory
        $sharedShortcut.Description = '在现有 Codex 完全退出后启动桌面与手机的共享控制'
        $sharedShortcut.IconLocation = $taskShortcut.IconLocation
        $sharedShortcut.Save()
    }
}
Write-Output '已创建桌面和开始菜单入口：手机连接设置。'
