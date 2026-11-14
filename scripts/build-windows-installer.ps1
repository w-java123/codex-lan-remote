param([Parameter(Mandatory=$true)][string]$BundleDirectory,
      [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/..").Path
$stage = Join-Path $OutputDirectory ('bundle-' + [guid]::NewGuid().ToString('N'))
$plugin = Join-Path $stage 'plugins/codex-lan-desktop'
New-Item -ItemType Directory -Force $plugin | Out-Null
$base = Join-Path $BundleDirectory 'plugins/codex-lan-desktop'
foreach ($name in @('.codex-plugin','.mcp.json','launch.cmd','skills','vendor','runtime','licenses','dependency-hashes.json','scripts')) {
    Copy-Item -LiteralPath (Join-Path $base $name) -Destination $plugin -Recurse
}
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
[IO.File]::WriteAllText("$stage/install-desktop-plugin.ps1", $installer.Replace($anchor, $copy + [Environment]::NewLine + $anchor), [Text.UTF8Encoding]::new($true))
foreach($file in Get-ChildItem $stage -Recurse -Force -File) {
    if($file.FullName.Substring($stage.Length) -match '(?i)[\\/](secrets|\.local|shared_prefs|databases)[\\/]|\.local\.(json|md)$|\.(keystore|jks|pfx|p12|pem|key|crt)$') { throw 'Private file in payload' }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = "$stage.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
$compiler = "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
$framework = Split-Path $compiler
$exe = Join-Path $OutputDirectory 'Codex-LAN-Windows-x64-Setup.exe'
& $compiler /nologo /target:winexe /platform:x64 "/out:$exe" "/resource:$zip,bundle.zip" /r:System.Windows.Forms.dll "/r:$framework/System.IO.Compression.dll" "/r:$framework/System.IO.Compression.FileSystem.dll" (Join-Path $PSScriptRoot 'windows-installer.cs')
if($LASTEXITCODE){throw 'Installer compilation failed'}
$exe
