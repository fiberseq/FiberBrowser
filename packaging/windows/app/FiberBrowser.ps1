<#
.SYNOPSIS
FiberBrowser for Windows: what the Start-menu and desktop shortcuts run (through
FiberBrowser.exe, which starts this without a console window).

.DESCRIPTION
1. One FiberBrowser at a time: a second launch opens another window on the
   running one (the server's state is in %LOCALAPPDATA%\FiberBrowser\run).
2. Starts the server inside the FiberBrowser WSL distribution
   (fiberbrowser-wsl-serve) on a free port (8756 when available, so the page
   keeps its display preferences between launches) with a new access token,
   and shows "Starting FiberBrowser..." until it answers.
3. Opens it in an app window of Edge (or Chrome) with FiberBrowser's own
   browser profile (%LOCALAPPDATA%\FiberBrowser\BrowserProfile); without
   either, in the default web browser.
4. When the last FiberBrowser window closes, stops the server; when the server
   stops (the page's Quit button, its last tab closed), closes the windows; if
   the server crashes, says so with the end of its log.

Logs: %LOCALAPPDATA%\FiberBrowser\logs\launcher.log and server.log.
#>
[CmdletBinding()]
param(
    # The page to open (e.g. '/?workspace=new' for an independent workspace).
    [string]$Page = '/',
    # Seconds to wait for the server (the first start after installing compiles its code).
    [int]$StartTimeout = 300
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'FiberBrowser.Common.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$IconPath = Join-Path $PSScriptRoot 'FiberBrowser.ico'
$ServerLog = Join-Path $script:LogDir 'server.log'

function Show-FbMessage {
    param([string]$Text, [string]$Icon = 'Error', [switch]$OfferLogs)
    Write-FbLog ("message: " + ($Text -replace "`r?`n", ' | '))
    # A top-most owner: this process has no window of its own, and the box
    # would otherwise open behind whatever is in front.
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    try {
        if ($OfferLogs) {
            $answer = [System.Windows.Forms.MessageBox]::Show($owner, ($Text + "`n`nOpen the logs folder?"), 'FiberBrowser',
                [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::$Icon)
            if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
                Start-Process -FilePath 'explorer.exe' -ArgumentList (ConvertTo-CommandLineArgument $script:LogDir)
            }
        } else {
            [void][System.Windows.Forms.MessageBox]::Show($owner, $Text, 'FiberBrowser', [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::$Icon)
        }
    } finally {
        $owner.Dispose()
    }
}

function Get-LogTail {
    param([string]$Path, [int]$Count = 12)
    $lines = @(Read-SharedText $Path | Where-Object { $_ -ne '' })
    if ($lines.Count -eq 0) { return '(the log is empty)' }
    return (($lines | Select-Object -Last $Count) -join "`n")
}

function New-Splash {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'FiberBrowser'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $true
    $form.StartPosition = 'CenterScreen'
    $form.ClientSize = New-Object System.Drawing.Size 420, 130
    if (Test-Path -LiteralPath $IconPath) { $form.Icon = New-Object System.Drawing.Icon $IconPath }
    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Starting FiberBrowser...'
    $title.Font = New-Object System.Drawing.Font 'Segoe UI', 12
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point 20, 18
    $detail = New-Object System.Windows.Forms.Label
    $detail.Text = 'Its window opens in a moment. The first start after installing takes up to a minute.'
    $detail.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $detail.Size = New-Object System.Drawing.Size 380, 36
    $detail.Location = New-Object System.Drawing.Point 20, 50
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object System.Drawing.Point 320, 92
    $cancel.Add_Click({ $this.FindForm().Tag = 'cancel' })
    $form.Controls.AddRange(@($title, $detail, $cancel))
    $form.Add_FormClosing({ if ($this.Tag -ne 'done') { $this.Tag = 'cancel' } })
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    return $form
}

function Close-Splash {
    param($Form)
    if ($null -ne $Form) { $Form.Tag = 'done'; $Form.Close(); $Form.Dispose() }
}

function Open-AppWindow {
    # Returns the browser process that owns FiberBrowser's windows (null: the default browser, untracked).
    param([string]$Url)
    $browser = Find-AppBrowser
    if (-not $browser) {
        Write-FbLog 'no Edge or Chrome: opening the default web browser'
        Start-Process -FilePath $Url
        return $null
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $browser
    $info.Arguments = Join-CommandLine (Get-AppBrowserArguments -Url $Url -ProfileDir $script:BrowserProfileDir)
    $info.UseShellExecute = $false
    Write-FbLog ('opening an app window with ' + $browser)
    $started = [System.Diagnostics.Process]::Start($info)
    # The process that owns the profile: this one, or one already running with
    # the profile (then this one hands over the window and exits).
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        $owner = Find-AppBrowserProcess -ProfileDir $script:BrowserProfileDir
        if ($null -ne $owner) { return $owner }
    }
    if (-not $started.HasExited) { return $started }
    return $null
}

function Stop-Server {
    param($Process, [int]$Port, [string]$Token)
    if ($null -eq $Process -or $Process.HasExited) { return }
    Write-FbLog 'stopping the server (/api/quit)'
    [void](Invoke-LocalRequest -Url ('http://127.0.0.1:{0}/api/quit' -f $Port) -Token $Token -Method 'POST')
    if (-not $Process.WaitForExit(15000)) {
        # The server also stops on its own once this wsl.exe is gone (fiberbrowser-wsl-serve).
        Write-FbLog 'the server did not stop in 15 s: ending its wsl.exe'
        try { $Process.Kill() } catch { Write-FbLog "kill: $_" }
    }
}

# --- one FiberBrowser at a time ---------------------------------------------------------------
foreach ($dir in @($script:AppDir, $script:RunDir, $script:LogDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
$mutex = Enter-FbLock $script:LauncherLockName
if ($null -eq $mutex) {
    # Another launch runs FiberBrowser: open another window on it.
    $state = $null
    for ($i = 0; $i -lt 20; $i++) {
        $state = Read-ServerState
        if ($null -ne $state -and $state.ready -and (Test-ServerReady -Port $state.port -Token $state.token)) { break }
        $state = $null
        Start-Sleep -Milliseconds 500
    }
    if ($null -ne $state) {
        Write-FbLog ('already running on port {0}: opening another window' -f $state.port)
        [void](Open-AppWindow -Url (Get-AppUrl -Port $state.port -Token $state.token -Path $Page))
    } elseif (Test-FbLockHeld $script:SetupLockName) {
        Show-FbMessage -Icon 'Information' 'FiberBrowser Setup is running. Start FiberBrowser again when it has finished.'
    } else {
        Write-FbLog 'already starting: nothing to do'
    }
    exit 0
}

function Invoke-Launcher {
    $server = $null
    $splash = $null
    $port = 0
    $token = ''
    try {
        Write-FbLog ('FiberBrowser launcher (PowerShell {0}, {1})' -f $PSVersionTable.PSVersion, [Environment]::OSVersion.VersionString)
        $wsl = Get-WslExe
        if (-not (Test-Path -LiteralPath $wsl) -or -not (Test-DistroRegistered)) {
            Show-FbMessage ("FiberBrowser's WSL distribution ('$($script:DistroName)') is not installed.`n`n" +
                'Run FiberBrowser Setup again to install it.')
            return 1
        }
        $port = Select-ServerPort
        $token = New-AccessToken
        Write-ServerState @{ port = $port; token = $token; ready = $false; launcher = $PID }
        if (Test-Path -LiteralPath $ServerLog) { Move-Item -LiteralPath $ServerLog -Destination ($ServerLog + '.previous') -Force }
        $splash = New-Splash

        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $wsl
        # -e: run it directly (no Linux shell parsing the arguments).
        $info.Arguments = Join-CommandLine @('-d', $script:DistroName, '-u', $script:DistroUser, '-e',
            '/usr/local/bin/fiberbrowser-wsl-serve', '--log', (ConvertTo-WslPath $ServerLog), '--token', $token,
            '--port', [string]$port)
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        Write-FbLog ('starting the server: wsl.exe -d {0} ... --port {1}' -f $script:DistroName, $port)
        $server = [System.Diagnostics.Process]::Start($info)
        # If this launcher is killed, its wsl.exe goes too (and with it the server).
        try {
            if (-not (Add-KillOnCloseJob $server)) { Write-FbLog 'could not tie the server to this launcher (job object)' }
        } catch {
            Write-FbLog "job object: $_"
        }

        # --- wait for it ------------------------------------------------------------------------
        $deadline = (Get-Date).AddSeconds($StartTimeout)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            if ($splash.Tag -eq 'cancel') { break }
            if ($server.HasExited) { break }
            $actual = Get-PortFromServerLog (Read-SharedText $ServerLog)
            if ($null -ne $actual -and $actual -ne $port) {
                Write-FbLog ('the server took port {0} instead of {1}' -f $actual, $port)
                $port = $actual
            }
            if (Test-ServerReady -Port $port -Token $token) { $ready = $true; break }
            for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Milliseconds 100; [System.Windows.Forms.Application]::DoEvents() }
        }
        if (-not $ready) {
            $cancelled = ($splash.Tag -eq 'cancel')
            Close-Splash $splash; $splash = $null
            if ($cancelled) {
                Write-FbLog 'cancelled while starting'
                Stop-Server -Process $server -Port $port -Token $token
                return
            }
            if ($server.HasExited) {
                $why = 'The server stopped while starting (exit code {0}).' -f $server.ExitCode
            } else {
                $why = 'The server did not answer within {0} s.' -f $StartTimeout
                Stop-Server -Process $server -Port $port -Token $token
            }
            Show-FbMessage -OfferLogs ("FiberBrowser could not start. $why`n`nEnd of the server log ($ServerLog):`n" + (Get-LogTail $ServerLog))
            return 2
        }
        Write-ServerState @{ port = $port; token = $token; ready = $true; launcher = $PID }
        Write-FbLog ('server ready on port {0}' -f $port)
        Close-Splash $splash; $splash = $null

        # --- the window -----------------------------------------------------------------------
        $window = Open-AppWindow -Url (Get-AppUrl -Port $port -Token $token -Path $Page)
        $stoppedHere = $false
        if ($null -eq $window) {
            # The default browser: the server stops by itself once its last tab closes.
            $server.WaitForExit()
        } else {
            while (-not $server.HasExited) {
                if ($window.HasExited) {
                    # A window may still be open in another process of the profile (a relaunch).
                    $window = Find-AppBrowserProcess -ProfileDir $script:BrowserProfileDir
                    if ($null -eq $window) { break }
                }
                Start-Sleep -Milliseconds 500
            }
            if (-not $server.HasExited) {
                Write-FbLog 'the FiberBrowser windows closed'
                $stoppedHere = $true
                Stop-Server -Process $server -Port $port -Token $token
            }
        }
        if (-not $stoppedHere -and $server.HasExited) {
            $code = $server.ExitCode
            Write-FbLog ('the server stopped (exit code {0})' -f $code)
            # 0, or ended by SIGTERM/SIGINT (wsl.exe reports 128+15 / 128+2): asked to
            # stop (the page's Quit button, its last tab closed).
            $requested = (@(0, 130, 143) -contains $code) -or (Get-LogTail $ServerLog 40).Contains('shutting down')
            if (-not $requested) {
                Show-FbMessage -OfferLogs ("FiberBrowser's server stopped unexpectedly (exit code $code). Your data files are unchanged; start FiberBrowser again to continue.`n`nEnd of the server log:`n" + (Get-LogTail $ServerLog))
            }
            if ($null -ne $window -and -not $window.HasExited) {
                [void]$window.CloseMainWindow()
                if (-not $window.WaitForExit(5000)) { try { $window.Kill() } catch { Write-FbLog "close: $_" } }
            }
        }
        return 0
    } catch {
        Write-FbLog ("error: " + ($_ | Out-String))
        Close-Splash $splash; $splash = $null
        Show-FbMessage -OfferLogs ("FiberBrowser's launcher failed: " + $_.Exception.Message)
        if ($null -ne $server -and -not $server.HasExited) { try { $server.Kill() } catch { Write-FbLog "kill: $_" } }
        return 3
    } finally {
        Close-Splash $splash
        Remove-Item -LiteralPath $script:StateFile -Force -ErrorAction SilentlyContinue
        Exit-FbLock $mutex
    }
}

$result = @(Invoke-Launcher)
$code = 0
if ($result.Count -gt 0 -and $result[-1] -is [int]) { $code = $result[-1] }
exit $code
