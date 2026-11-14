param(
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'CodexLAN'),
    [string]$PluginDirectory,
    [switch]$Connect,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
function Resolve-PhoneCodexBinary([string]$CurrentPath, [string]$PluginDirectory, [string]$NodePath) {
    $resolver = Join-Path $PluginDirectory 'server\desktop-binary.mjs'
    $program = "import { pathToFileURL } from 'node:url'; const { resolveDesktopBinary } = await import(pathToFileURL(process.argv[1]).href); try { console.log(await resolveDesktopBinary(process.argv[2].slice(5))); } catch { process.exitCode = 1; }"
    $binary = & $NodePath --input-type=module -e $program $resolver ('path:' + $CurrentPath)
    if ($LASTEXITCODE -ne 0 -or -not $binary) {
        throw 'Desktop Codex executable was not found. Open Codex or check its program path in Phone Settings.'
    }
    return $binary
}
function Test-LauncherTimeout([System.Exception]$ErrorCause) {
    for ($cause = $ErrorCause; $null -ne $cause; $cause = $cause.InnerException) {
        if ($cause -is [TimeoutException] -or
            ($cause -is [Net.WebException] -and $cause.Status -eq [Net.WebExceptionStatus]::Timeout)) {
            return $true
        }
    }
    return $false
}
function Resolve-PhonePluginDirectory([string]$CacheDirectory) {
    $installed = Get-ChildItem -LiteralPath $CacheDirectory -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+(?:-preview)?$' } |
        Sort-Object @{Expression = { [version]($_.Name -replace '-.*$', '') }; Descending = $true} |
        Select-Object -First 1
    if (-not $installed) { throw 'Phone connection plugin is not installed.' }
    return $installed.FullName
}
function Write-LauncherProgress([string]$Step) {
    Write-Host ('[Phone connection] ' + $Step)
    if (Test-Path -LiteralPath $DataDirectory) {
        Add-Content -LiteralPath (Join-Path $DataDirectory 'settings-launcher.log') -Encoding UTF8 -Value (
            (Get-Date -Format o) + ' step=' + $Step
        )
    }
}
try {
    Write-LauncherProgress 'checking-settings'
    if (-not $PluginDirectory) {
        $cache = Join-Path $env:USERPROFILE '.codex\plugins\cache\codex-lan-local\codex-lan-desktop'
        $PluginDirectory = Resolve-PhonePluginDirectory $cache
    }

    $env:CODEX_LAN_DATA_DIR = $DataDirectory
    $node = Join-Path $PluginDirectory 'runtime\node.exe'
    if (-not $CheckOnly) {
        $diagnostics = Join-Path $DataDirectory 'phone-connection-diagnostics.mjs'
        $settingsPath = Join-Path $DataDirectory 'phone-diagnostics-settings.json'
        if ((Test-Path -LiteralPath $diagnostics) -and (Test-Path -LiteralPath $settingsPath)) {
            try {
                $diagnosticSettings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $diagnosticArgs = '"' + $diagnostics + '" --data "' + $DataDirectory + '" --plugin "' + $PluginDirectory + '" --report "' + $diagnosticSettings.reportPath + '"'
                Start-Process -FilePath $node -ArgumentList $diagnosticArgs -WindowStyle Hidden | Out-Null
            } catch { Write-LauncherProgress 'diagnostics-unavailable-connection-kept-running' }
        }
    }
    $endpointPath = Join-Path $DataDirectory 'manager.local.json'
    $managerReady = $false
    function Read-LocalManager {
        $endpoint = Get-Content -LiteralPath $endpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($endpoint.origin -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Invalid local endpoint.' }
        $reply = Invoke-RestMethod -Uri ($endpoint.origin + '/api/status') -Headers @{Authorization = 'Bearer ' + $endpoint.token} -TimeoutSec 2
        if ($reply.kind -ne 'codex-lan-manager') { throw 'Unexpected local service.' }
        return $endpoint
    }
    try { $endpoint = Read-LocalManager; $managerReady = $true } catch { }
    if (-not $managerReady) {
        Write-LauncherProgress 'starting-settings-backend'
        # A scheduled start can silently fail or exceed the plugin opener timeout.
        # Start the same official daemon directly, keeping its existing lock rules.
        $daemon = Join-Path $PluginDirectory 'desktop\daemon.mjs'
        $daemonArgs = '"' + $daemon + '" --data "' + $DataDirectory + '"'
        Start-Process -FilePath $node -ArgumentList $daemonArgs -WindowStyle Hidden | Out-Null
        $deadline = (Get-Date).AddSeconds(120)
        do {
            Start-Sleep -Seconds 1
            try { $endpoint = Read-LocalManager; $managerReady = $true } catch { }
        } while (-not $managerReady -and (Get-Date) -lt $deadline)
    }
    if (-not $managerReady) { throw [TimeoutException]::new('Settings manager is still starting.') }
    Write-LauncherProgress 'settings-backend-ready'
    $url = [Uri]($endpoint.origin + '/#' + $endpoint.token)
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or
        $url.AbsolutePath -ne '/' -or $url.UserInfo -or $url.Query -or
        $url.Fragment.Length -lt 2) { throw 'Invalid local settings address.' }

    $browser = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $browser) { throw 'Microsoft Edge is not installed.' }
    $response = Invoke-WebRequest -Uri $url.GetLeftPart([UriPartial]::Path) -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'Codex LAN') {
        throw 'Settings page is not ready.'
    }
    if ($Connect -and -not $CheckOnly) {
        $headers = @{Authorization = 'Bearer ' + $url.Fragment.Substring(1)}
        $origin = $url.GetLeftPart([UriPartial]::Authority)
        try {
            $status = Invoke-RestMethod -Uri ($origin + '/api/status') -Headers $headers -TimeoutSec 5
            # Desktop updates remove the old build directory. A running gateway can
            # still reject every selected chat if its history reader points there.
            $binary = Resolve-PhoneCodexBinary $status.config.codexBinary $PluginDirectory $node
            $binaryChanged = $binary -ne $status.config.codexBinary
            if ($binaryChanged) {
                Write-LauncherProgress 'repairing-removed-Codex-build-path'
                $status.config.codexBinary = $binary
                Invoke-RestMethod -Uri ($origin + '/api/config') -Headers $headers -Method Post -ContentType 'application/json' -Body ($status.config | ConvertTo-Json -Depth 12) -TimeoutSec 90 | Out-Null
            }
            if ($binaryChanged -or -not $status.gateway.running) {
                Write-LauncherProgress 'starting-saved-connection'
                try {
                    Invoke-RestMethod -Uri ($origin + '/api/start') -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 120 | Out-Null
                } catch {
                    $details = $_.ErrorDetails.Message
                    try { $details = ($details | ConvertFrom-Json).error } catch { }
                    $permissionFailure = $details -match '\u865a\u62df\u7f51\u5361|\u7ba1\u7406\u5458|\u6743\u9650'
                    if ($status.config.mode -ne 'bundled' -or -not $permissionFailure) { throw }
                    # Only this session is elevated after the user accepts Windows UAC.
                    # No scheduled-task permission or persistent configuration is changed.
                    Invoke-RestMethod -Uri ($origin + '/api/shutdown') -Headers $headers -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
                    $shutdownDeadline = (Get-Date).AddSeconds(15)
                    while (Test-Path -LiteralPath $endpointPath) {
                        if ((Get-Date) -gt $shutdownDeadline) { throw 'Previous manager has not stopped.' }
                        Start-Sleep -Milliseconds 250
                    }
                    $daemon = Join-Path $PluginDirectory 'desktop\daemon.mjs'
                    $arguments = '"' + $daemon + '" --data "' + $DataDirectory + '"'
                    Write-LauncherProgress 'waiting-for-Windows-UAC-approval-for-this-session'
                    $session = Start-Process -FilePath $node -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -PassThru
                    $oldUrl = $url.AbsoluteUri
                    $ready = $false
                    $deadline = (Get-Date).AddSeconds(100)
                    do {
                        Start-Sleep -Seconds 2
                        $session.Refresh()
                        if ($session.HasExited) { throw 'Session startup failed.' }
                        try {
                            $endpoint = Get-Content -LiteralPath (Join-Path $DataDirectory 'manager.local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                            if ($endpoint.origin -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Invalid local endpoint.' }
                            $freshUrl = [Uri]($endpoint.origin + '/#' + $endpoint.token)
                            $freshHeaders = @{Authorization = 'Bearer ' + $endpoint.token}
                            $freshStatus = Invoke-RestMethod -Uri ($endpoint.origin + '/api/status') -Headers $freshHeaders -TimeoutSec 2
                            $ready = $freshUrl.AbsoluteUri -ne $oldUrl -and $freshStatus.kind -eq 'codex-lan-manager' -and $freshStatus.gateway.running
                            if ($ready) { $url = $freshUrl }
                        } catch { $ready = $false }
                    } while (-not $ready -and (Get-Date) -lt $deadline)
                    if (-not $ready) { throw [TimeoutException]::new('Session is still starting.') }
                }
            }
            Write-LauncherProgress 'computer-connection-ready-phone-VPN-must-also-be-enabled'
        } catch {
            if (-not (Test-LauncherTimeout $_.Exception)) { throw }
            # An HTTP timeout does not cancel work already accepted by the manager.
            Write-LauncherProgress 'connection-start-pending'
        }
    }
    if ($CheckOnly) {
        Write-Output 'PASS: local settings page and Edge are ready.'
    } else {
        # Invoke the browser directly: rundll32 can exit successfully without opening a tab.
        Start-Process -FilePath $browser -ArgumentList @('--new-tab', $url.AbsoluteUri) -WindowStyle Normal
    }
    Write-LauncherProgress 'completed'
} catch {
    # Do not persist the temporary URL or any pairing credentials in diagnostics.
    if (-not $CheckOnly -and (Test-LauncherTimeout $_.Exception)) {
        Write-LauncherProgress 'settings-start-pending'
        exit 0
    }
    $code = $_.Exception.HResult
    if (Test-Path -LiteralPath $DataDirectory) {
        Add-Content -LiteralPath (Join-Path $DataDirectory 'settings-launcher.log') -Encoding UTF8 -Value (
            (Get-Date -Format o) + ' settings-launch-failed code=' + $code
        )
    }
    if ($CheckOnly) { Write-Error ('Settings launcher failed. Error code: ' + $code) }
    else {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            'Could not complete phone connection startup. See settings-launcher.log in the CodexLAN data folder. You can still use the Phone Settings shortcut.',
            'Codex LAN', 'OK', 'Error'
        ) | Out-Null
    }
    exit 1
}
