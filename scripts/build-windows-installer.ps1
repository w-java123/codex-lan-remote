param([Parameter(Mandatory=$true)][string]$BundleDirectory,
      [Parameter(Mandatory=$true)][string]$OutputDirectory,
      [string]$PreviousBundleDirectory)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/..").Path
$stage = Join-Path $OutputDirectory ('bundle-' + [guid]::NewGuid().ToString('N'))
$plugin = Join-Path $stage 'plugins/codex-lan-desktop'
New-Item -ItemType Directory -Force $plugin | Out-Null
$base = Join-Path $BundleDirectory 'plugins/codex-lan-desktop'
foreach ($name in @('.codex-plugin','.mcp.json','launch.cmd','skills','vendor','runtime','licenses','dependency-hashes.json','scripts')) {
    Copy-Item -LiteralPath (Join-Path $base $name) -Destination $plugin -Recurse
}
foreach ($name in @('configure-desktop-autostart.ps1','install-settings-shortcuts.ps1','start-shared-owner.ps1')) {
    [IO.File]::WriteAllText((Join-Path $plugin "scripts/$name"), [IO.File]::ReadAllText("$root/scripts/$name"), [Text.UTF8Encoding]::new($true))
}
Remove-Item -LiteralPath (Join-Path $plugin 'scripts/run-desktop-background.ps1') -ErrorAction SilentlyContinue
$packet = Join-Path $plugin 'vendor/easytier/Packet.dll'
if (Test-Path -LiteralPath $packet) { Remove-Item -LiteralPath $packet }
foreach ($name in @('server','desktop')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination $plugin -Recurse }
Copy-Item -LiteralPath (Join-Path $base 'desktop/web/qrcode.js') -Destination "$plugin/desktop/web/"
New-Item -ItemType Directory -Force "$stage/.agents/plugins" | Out-Null
Copy-Item "$root/desktop/marketplace.json" "$stage/.agents/plugins/"
Copy-Item "$root/scripts/open-phone-settings.ps1" "$plugin/scripts/"
$installer = [IO.File]::ReadAllText("$root/scripts/install-desktop-plugin.ps1")
$anchor = '& (Join-Path $taskInstalled.installedPath ''scripts\configure-desktop-autostart.ps1'')'
$copy = 'Copy-Item -LiteralPath (Join-Path $taskInstalled.installedPath ''scripts\open-phone-settings.ps1'') -Destination (Join-Path $DataDirectory ''open-settings.ps1'') -Force'
if (!$installer.Contains($anchor)) { throw 'Installer hook missing' }
[IO.File]::WriteAllText("$stage/install-desktop-plugin.ps1", $installer.Replace($anchor, $copy + [Environment]::NewLine + '    ' + $anchor), [Text.UTF8Encoding]::new($true))
foreach($file in Get-ChildItem $stage -Recurse -Force -File) {
    if($file.FullName.Substring($stage.Length) -match '(?i)[\\/](secrets|\.local|shared_prefs|databases)[\\/]|\.local\.(json|md)$|\.(keystore|jks|pfx|p12|pem|key|crt)$') { throw 'Private file in payload' }
}
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskSharedLauncher = Join-Path $plugin 'runtime/CodexLanSharedLaunch.exe'
$taskLauncherSource = Join-Path $PSScriptRoot 'windows-shared-launcher.cs'
$taskLauncherSourceHash = (Get-FileHash -LiteralPath $taskLauncherSource -Algorithm SHA256).Hash
$taskLauncherMarker = 'runtime/shared-launcher-source.sha256'
$taskPriorPlugin = if ($PreviousBundleDirectory) { Join-Path $PreviousBundleDirectory 'plugins/codex-lan-desktop' }
$taskPriorLauncher = if ($taskPriorPlugin) { Join-Path $taskPriorPlugin 'runtime/CodexLanSharedLaunch.exe' }
if ($taskPriorPlugin -and (Test-Path -LiteralPath (Join-Path $taskPriorPlugin $taskLauncherMarker)) -and
    (Get-Content -LiteralPath (Join-Path $taskPriorPlugin $taskLauncherMarker) -Raw).Trim() -eq $taskLauncherSourceHash -and
    (Test-Path -LiteralPath $taskPriorLauncher)) {
    $priorHashes = Get-Content -LiteralPath (Join-Path $taskPriorPlugin 'dependency-hashes.json') -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $taskPriorLauncher -Algorithm SHA256).Hash -ne $priorHashes.'CodexLanSharedLaunch.exe') {
        throw '上一发行版的共享启动器校验失败'
    }
    Copy-Item -LiteralPath $taskPriorLauncher -Destination $taskSharedLauncher -Force
} else {
    & $taskCompiler /nologo /target:winexe /platform:x64 /codepage:65001 "/out:$taskSharedLauncher" /r:System.Windows.Forms.dll $taskLauncherSource
    if ($LASTEXITCODE -ne 0) { throw '共享控制启动程序编译失败' }
}
[IO.File]::WriteAllText((Join-Path $plugin $taskLauncherMarker), $taskLauncherSourceHash)
$launcherHashes = Join-Path $plugin 'dependency-hashes.json'
$launcherManifest = Get-Content -LiteralPath $launcherHashes -Raw | ConvertFrom-Json
$launcherDigest = (Get-FileHash -LiteralPath $taskSharedLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherManifest | Add-Member -NotePropertyName 'CodexLanSharedLaunch.exe' -NotePropertyValue $launcherDigest -Force
$launcherManifest | ConvertTo-Json | Set-Content -LiteralPath $launcherHashes -Encoding utf8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = "$stage.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
$compiler = "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
$framework = Split-Path $compiler
$exe = Join-Path $OutputDirectory 'Codex-LAN-Windows-x64-Setup.exe'
& $compiler /nologo /target:winexe /platform:x64 "/out:$exe" "/resource:$zip,bundle.zip" /r:System.Windows.Forms.dll "/r:$framework/System.IO.Compression.dll" "/r:$framework/System.IO.Compression.FileSystem.dll" (Join-Path $PSScriptRoot 'windows-installer.cs')
if($LASTEXITCODE){throw 'Installer compilation failed'}
$exe
