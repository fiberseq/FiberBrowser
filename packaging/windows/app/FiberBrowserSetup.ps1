<#
.SYNOPSIS
Installs, updates and removes FiberBrowser's WSL distribution. Run by
FiberBrowser-<version>-Setup.exe and its uninstaller (NSIS), and by the
portable package's Install.cmd / Uninstall.cmd.

.DESCRIPTION
Actions (exit codes below):
  Check            Is WSL 2 ready? (0 yes; 10 WSL missing or too old for WSL 2)
  InstallWsl       wsl --install --no-distribution (run elevated; Windows may need a restart)
  Install          Import the distribution from -Tarball into <InstallDir>\distro. An existing
                   one is replaced; the user's Linux home (settings, sessions, the Library,
                   downloaded genomes, files in its data folder) is kept: backed up first,
                   restored after (-RemoveData: replaced without keeping it).
  Uninstall        Unregister the distribution. The user's Linux home is kept as a backup in
                   %LOCALAPPDATA%\FiberBrowser\UserData (restored by the next install) unless
                   -RemoveData, which also deletes that backup, the browser profile and logs.
  PortableInstall  Install.cmd: copy the app files to %LOCALAPPDATA%\FiberBrowser\app, Check
                   (offering InstallWsl), Install, shortcuts, Apps & features entry.
  PortableUninstall  Uninstall.cmd / Apps & features for a portable install.

The distribution is imported with `wsl --import FiberBrowser`: your other WSL
distributions and your WSL settings are never touched.

Exit codes: 0 ok; 10 WSL 2 not available; 20 virtualization off in the
firmware; 21 Virtual Machine Platform missing; 22 WSL kernel update needed;
29 import failed (see the log); 30 not enough disk space for the data backup;
31 data backup failed; 32 installed, but the data backup could not be restored
(it is kept, renamed, in UserData); 40 FiberBrowser (or another Setup) is
running; 50 cancelled.
Log: %LOCALAPPDATA%\FiberBrowser\logs\setup.log
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Check', 'InstallWsl', 'Install', 'Uninstall', 'PortableInstall', 'PortableUninstall')]
    [string]$Action,
    [string]$Tarball = '',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'FiberBrowser'),
    [switch]$RemoveData,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'FiberBrowser.Common.ps1')
$env:WSL_UTF8 = '1'   # wsl.exe's own messages in UTF-8 (else UTF-16)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose "no console: $_" }

$BackupFile = Join-Path $script:UserDataDir 'home.tar'
$script:SetupLock = $null
$script:LaunchLock = $null

function Say {
    param([string]$Message)
    Write-FbLog $Message 'setup.log'
    try { [Console]::Out.WriteLine($Message) } catch { Write-Verbose $Message }
}

function Invoke-Wsl {
    # wsl.exe with these arguments: @{ ExitCode; Output } (stdout and stderr, NULs dropped).
    param([string[]]$Arguments, [int]$TimeoutSeconds = 3600)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Get-WslExe
    $info.Arguments = Join-CommandLine $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    try {
        $proc = [System.Diagnostics.Process]::Start($info)
    } catch {
        return @{ ExitCode = -1; Output = $_.Exception.Message }
    }
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { $proc.Kill() } catch { Write-Verbose "kill: $_" }
        return @{ ExitCode = -2; Output = 'timed out' }
    }
    $proc.WaitForExit()
    $text = ($out.Result + "`n" + $err.Result) -replace "`0", ''
    Write-FbLog ('wsl ' + ($Arguments -join ' ') + ' -> ' + $proc.ExitCode + ': ' + ($text.Trim() -replace "`r?`n", ' | ')) 'setup.log'
    return @{ ExitCode = $proc.ExitCode; Output = $text }
}

function Test-Wsl {
    $wsl = Get-WslExe
    if (-not (Test-Path -LiteralPath $wsl)) { Say 'WSL is not installed (no wsl.exe).'; return 10 }
    # `wsl --version` answers only with the current WSL (the Microsoft Store one, WSL 2 ready).
    $result = Invoke-Wsl @('--version') 60
    if ($result.ExitCode -eq 0) {
        Say ('WSL: ' + (($result.Output -split "`r?`n" | Where-Object { $_ -match 'WSL' } | Select-Object -First 1)))
        return 0
    }
    Say 'WSL is missing or too old for WSL 2 (wsl --version failed).'
    return 10
}

function Test-FiberBrowserRunning {
    $state = Read-ServerState
    return ($null -ne $state -and (Test-ServerReady -Port $state.port -Token $state.token))
}

function Set-BackupAside {
    # An existing backup is never overwritten or restored by surprise: it is
    # renamed (kept for the user) before a new one is made or when it isn't wanted.
    param([string]$Why = 'earlier')
    if (-not (Test-Path -LiteralPath $BackupFile)) { return }
    $kept = Join-Path $script:UserDataDir ('home-{0}-{1}.tar' -f $Why, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $BackupFile -Destination $kept -Force
    Say "A backup of your FiberBrowser data is kept as $kept."
}

function Backup-Home {
    # The user's Linux home (minus caches) to UserData\home.tar.
    if (-not (Test-Path -LiteralPath $script:UserDataDir)) { New-Item -ItemType Directory -Path $script:UserDataDir -Force | Out-Null }
    Set-BackupAside 'earlier'
    $size = Invoke-Wsl @('-d', $script:DistroName, '-u', 'root', '-e', 'du', '-sb', '--exclude=.cache', $script:DistroHome) 600
    $bytes = 0
    if ($size.ExitCode -eq 0 -and $size.Output -match '^\s*(\d+)') { $bytes = [int64]$Matches[1] }
    $drive = (Get-Item -LiteralPath $script:UserDataDir).PSDrive
    $free = [int64]$drive.Free
    Say ('Your FiberBrowser data: {0:N1} GB (free on {1}: {2:N1} GB).' -f ($bytes / 1GB), $drive.Name, ($free / 1GB))
    if ($bytes + 200MB -gt $free) {
        Say ('Not enough free space on {0}: to keep your FiberBrowser data, {1:N1} GB are needed.' -f $drive.Name, (($bytes + 200MB) / 1GB))
        return 30
    }
    $tmp = $BackupFile + '.partial'
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Say 'Keeping your FiberBrowser data (settings, sessions, the Library, genomes, files in its data folder)...'
    $tar = Invoke-Wsl @('-d', $script:DistroName, '-u', 'root', '-e', 'tar', '-C', $script:DistroHome,
        '--exclude=./.cache', '-cf', (ConvertTo-WslPath $tmp), '.') 7200
    if ($tar.ExitCode -ne 0) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Say ('Could not back up your FiberBrowser data: ' + $tar.Output.Trim())
        return 31
    }
    Move-Item -LiteralPath $tmp -Destination $BackupFile -Force
    return 0
}

function Restore-Home {
    # 0: restored (or nothing to restore); 32: failed (the backup is kept, renamed).
    if (-not (Test-Path -LiteralPath $BackupFile)) { return 0 }
    Say 'Restoring your FiberBrowser data...'
    $result = Invoke-Wsl @('-d', $script:DistroName, '-u', 'root', '-e', 'sh', '-c',
        'tar -C "$1" -xpf "$2" && chown -R fiberbrowser:fiberbrowser "$1"', 'sh', $script:DistroHome,
        (ConvertTo-WslPath $BackupFile)) 7200
    if ($result.ExitCode -eq 0) {
        Remove-Item -LiteralPath $BackupFile -Force
        return 0
    }
    Say ('Could not restore your FiberBrowser data: ' + $result.Output.Trim())
    Set-BackupAside 'unrestored'
    return 32
}

function Expand-GzipFile {
    param([string]$Source, [string]$Destination)
    $in = [System.IO.File]::OpenRead($Source)
    try {
        $gz = New-Object System.IO.Compression.GZipStream $in, ([System.IO.Compression.CompressionMode]::Decompress)
        $out = [System.IO.File]::Create($Destination)
        try { $gz.CopyTo($out, 1MB) } finally { $out.Dispose(); $gz.Dispose() }
    } finally {
        $in.Dispose()
    }
}

function Install-Distro {
    # -KeepData:$false replaces an existing distribution without backing up its home.
    param([string]$Source, [string]$Target, [bool]$KeepData = $true)
    if (-not $Source -or -not (Test-Path -LiteralPath $Source)) { Say "No distribution tarball at '$Source'."; return 29 }
    $check = Test-Wsl
    if ($check -ne 0) { return $check }
    if (Test-FiberBrowserRunning) { Say 'FiberBrowser is running: quit it first.'; return 40 }
    $distroDir = Join-Path $Target 'distro'
    if (Test-DistroRegistered) {
        if ($KeepData) {
            $backup = Backup-Home
            if ($backup -ne 0) { return $backup }
        }
        Say 'Removing the previous FiberBrowser distribution...'
        $gone = Invoke-Wsl @('--unregister', $script:DistroName) 600
        if ($gone.ExitCode -ne 0 -and (Test-DistroRegistered)) { Say ('Could not remove it: ' + $gone.Output.Trim()); return 29 }
    }
    if (-not (Test-Path -LiteralPath $distroDir)) { New-Item -ItemType Directory -Path $distroDir -Force | Out-Null }
    Say "Installing FiberBrowser's Linux system (WSL distribution '$($script:DistroName)'); this takes a minute or two..."
    $import = Invoke-Wsl @('--import', $script:DistroName, $distroDir, $Source, '--version', '2') 3600
    if ($import.ExitCode -ne 0 -and -not (Test-DistroRegistered)) {
        $code = Get-ImportFailureCode $import.Output
        if ($code -eq 29 -and $Source -like '*.gz') {
            # Older WSL versions import only an uncompressed tar.
            Say 'Retrying with an uncompressed copy...'
            $plain = Join-Path $env:TEMP ('FiberBrowser-rootfs-{0}.tar' -f $PID)
            try {
                Expand-GzipFile -Source $Source -Destination $plain
                $import = Invoke-Wsl @('--import', $script:DistroName, $distroDir, $plain, '--version', '2') 3600
            } finally {
                Remove-Item -LiteralPath $plain -Force -ErrorAction SilentlyContinue
            }
            if ($import.ExitCode -ne 0 -and -not (Test-DistroRegistered)) { $code = Get-ImportFailureCode $import.Output }
            else { $code = 0 }
        }
        if ($code -ne 0) {
            Say ('wsl --import failed: ' + $import.Output.Trim())
            return $code
        }
    }
    $restored = 0
    if ($KeepData) {
        $restored = Restore-Home
    } else {
        Set-BackupAside 'earlier'
    }
    Say 'Checking the installation...'
    $probe = Invoke-Wsl @('-d', $script:DistroName, '-u', $script:DistroUser, '-e', '/usr/local/bin/fiberbrowser', '--version') 600
    Say ($probe.Output.Trim())
    [void](Invoke-Wsl @('--terminate', $script:DistroName) 120)
    if ($probe.ExitCode -ne 0) { return 29 }
    Say 'FiberBrowser is installed.'
    return $restored
}

function Uninstall-Distro {
    param([string]$Target, [bool]$DeleteData)
    if (Test-FiberBrowserRunning) { Say 'FiberBrowser is running: quit it first.'; return 40 }
    if ((Test-Path -LiteralPath (Get-WslExe)) -and (Test-DistroRegistered)) {
        if (-not $DeleteData) {
            $backup = Backup-Home
            if ($backup -ne 0) { return $backup }
        }
        Say "Removing FiberBrowser's WSL distribution..."
        $gone = Invoke-Wsl @('--unregister', $script:DistroName) 600
        if ($gone.ExitCode -ne 0 -and (Test-DistroRegistered)) { Say ('Could not remove it: ' + $gone.Output.Trim()) ; return 29 }
    }
    Remove-Item -LiteralPath (Join-Path $Target 'distro') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:RunDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($DeleteData) {
        Say 'Deleting your FiberBrowser data...'
        foreach ($dir in @($script:UserDataDir, $script:BrowserProfileDir, $script:LogDir)) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    } elseif (Test-Path -LiteralPath $BackupFile) {
        Say "Your FiberBrowser data is kept in $BackupFile (installing FiberBrowser again restores it)."
    }
    return 0
}

function Install-WslElevated {
    # Run as administrator. Installs (or updates to) the current WSL with WSL 2, no Linux distribution.
    Say 'Installing WSL (wsl --install --no-distribution)...'
    $result = Invoke-Wsl @('--install', '--no-distribution') 3600
    if ($result.ExitCode -ne 0) {
        Say 'Trying wsl --update...'
        $result = Invoke-Wsl @('--update') 3600
    }
    Say $result.Output.Trim()
    return $result.ExitCode
}

function New-Shortcut {
    param([string]$Path, [string]$Target, [string]$Icon, [string]$Description)
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.WorkingDirectory = Split-Path -Parent $Target
    $link.IconLocation = $Icon + ',0'
    $link.Description = $Description
    $link.Save()
}

function Install-Portable {
    param([string]$Source)
    $here = $PSScriptRoot
    $appDir = Join-Path $InstallDir 'app'
    if ($here.TrimEnd('\') -ne $appDir.TrimEnd('\')) {
        if (-not (Test-Path -LiteralPath $appDir)) { New-Item -ItemType Directory -Path $appDir -Force | Out-Null }
        Copy-Item -Path (Join-Path $here '*') -Destination $appDir -Recurse -Force
        Get-ChildItem -LiteralPath $appDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    }
    $check = Test-Wsl
    if ($check -ne 0) {
        Say ''
        Say 'FiberBrowser runs in WSL 2 (Windows Subsystem for Linux), which is not installed or is too old here.'
        $answer = Read-Host 'Install WSL now? Windows asks for administrator approval, and may need a restart. [Y/n]'
        if ($answer -match '^[Nn]') { return 10 }
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = Join-CommandLine @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $appDir 'FiberBrowserSetup.ps1'), '-Action', 'InstallWsl')
        try {
            Start-Process -FilePath $ps -ArgumentList $arguments -Verb RunAs -Wait
        } catch {
            Say 'WSL was not installed (administrator approval was declined).'
            return 10
        }
        if ((Test-Wsl) -ne 0) {
            Say ''
            Say 'Restart Windows to finish installing WSL, then run Install.cmd again.'
            return 10
        }
    }
    $code = Install-Distro -Source $Source -Target $InstallDir
    if ($code -ne 0 -and $code -ne 32) { return $code }
    $exe = Join-Path $appDir 'FiberBrowser.exe'
    $icon = Join-Path $appDir 'FiberBrowser.ico'
    $programs = [Environment]::GetFolderPath('Programs')
    New-Shortcut -Path (Join-Path $programs 'FiberBrowser.lnk') -Target $exe -Icon $icon -Description 'FiberBrowser'
    New-Shortcut -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FiberBrowser.lnk') -Target $exe -Icon $icon -Description 'FiberBrowser'
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FiberBrowser'
    New-Item -Path $key -Force | Out-Null
    $uninstall = '"{0}"' -f (Join-Path $appDir 'Uninstall.cmd')
    $values = @{ DisplayName = 'FiberBrowser'; DisplayVersion = $Version; Publisher = 'FiberBrowser Authors';
        DisplayIcon = $icon; InstallLocation = $InstallDir; UninstallString = $uninstall }
    foreach ($name in $values.Keys) { Set-ItemProperty -Path $key -Name $name -Value $values[$name] }
    Set-ItemProperty -Path $key -Name 'NoModify' -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -Type DWord
    Say ''
    Say 'Done: start FiberBrowser from the Start menu or the desktop shortcut.'
    return $code
}

function Uninstall-Portable {
    $answer = Read-Host 'Remove FiberBrowser? [y/N]'
    if ($answer -notmatch '^[Yy]') { return 50 }
    $delete = (Read-Host 'Also delete your FiberBrowser data (settings, sessions, the Library, downloaded genomes and files in its data folder)? [y/N]') -match '^[Yy]'
    $code = Uninstall-Distro -Target $InstallDir -DeleteData $delete
    if ($code -eq 30) {
        if ((Read-Host 'Not enough space to keep your data. Delete it and continue? [y/N]') -notmatch '^[Yy]') { return 30 }
        $code = Uninstall-Distro -Target $InstallDir -DeleteData $true
    }
    if ($code -ne 0) { return $code }
    $programs = [Environment]::GetFolderPath('Programs')
    Remove-Item -LiteralPath (Join-Path $programs 'FiberBrowser.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FiberBrowser.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FiberBrowser' -Recurse -Force -ErrorAction SilentlyContinue
    # The app folder (this script's) is removed by Uninstall.cmd once this exits.
    Say 'FiberBrowser is removed.'
    return 0
}

function Invoke-Setup {
    Write-FbLog ("setup $Action (PowerShell {0}, {1})" -f $PSVersionTable.PSVersion, [Environment]::OSVersion.VersionString) 'setup.log'
    if (@('Install', 'Uninstall', 'PortableInstall', 'PortableUninstall') -contains $Action) {
        # Nothing may start FiberBrowser (or another Setup) while the distribution
        # is backed up, replaced or removed; a FiberBrowser starting now holds this lock too.
        $script:SetupLock = Enter-FbLock $script:SetupLockName
        $script:LaunchLock = Enter-FbLock $script:LauncherLockName
        if ($null -eq $script:SetupLock -or $null -eq $script:LaunchLock) {
            Say 'FiberBrowser (or another FiberBrowser Setup) is running: quit it first.'
            return 40
        }
    }
    switch ($Action) {
        'Check' { return (Test-Wsl) }
        'InstallWsl' { return (Install-WslElevated) }
        'Install' { return (Install-Distro -Source $Tarball -Target $InstallDir -KeepData (-not $RemoveData)) }
        'Uninstall' { return (Uninstall-Distro -Target $InstallDir -DeleteData ([bool]$RemoveData)) }
        'PortableInstall' { return (Install-Portable -Source $Tarball) }
        'PortableUninstall' { return (Uninstall-Portable) }
    }
    return 1
}

try {
    $result = @(Invoke-Setup)
    $code = 0
    if ($result.Count -gt 0 -and $result[-1] -is [int]) { $code = $result[-1] }
} catch {
    Say ('Setup failed: ' + $_.Exception.Message)
    Write-FbLog ($_ | Out-String) 'setup.log'
    $code = 1
} finally {
    Exit-FbLock $script:LaunchLock
    Exit-FbLock $script:SetupLock
}
exit $code
