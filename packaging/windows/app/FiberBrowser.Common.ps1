# Shared by the FiberBrowser launcher (FiberBrowser.ps1) and setup
# (FiberBrowserSetup.ps1) on Windows. Windows PowerShell 5.1 syntax: these run
# with the powershell.exe every Windows 10/11 has.
#
# FiberBrowser on Windows is a WSL 2 distribution named "FiberBrowser" (a
# Linux root filesystem with Python, FiberHMM and FiberBrowser) plus these
# scripts: the launcher starts the server inside the distribution and shows it
# in an Edge app window.

Set-StrictMode -Version 2

$script:DistroName = 'FiberBrowser'
$script:DistroUser = 'fiberbrowser'
$script:DistroHome = '/home/fiberbrowser'
$script:AppDir = Join-Path $env:LOCALAPPDATA 'FiberBrowser'
$script:RunDir = Join-Path $script:AppDir 'run'
$script:LogDir = Join-Path $script:AppDir 'logs'
$script:UserDataDir = Join-Path $script:AppDir 'UserData'
$script:BrowserProfileDir = Join-Path $script:AppDir 'BrowserProfile'
$script:StateFile = Join-Path $script:RunDir 'server.json'
# A stable port keeps the page's origin, and with it its saved display
# preferences, the same from one launch to the next (as in the Mac app).
$script:PreferredPorts = 8756..8775

function Get-WslExe {
    # The 64-bit wsl.exe also from a 32-bit process (Sysnative), where System32 is redirected.
    $native = Join-Path $env:SystemRoot 'Sysnative\wsl.exe'
    if (-not [Environment]::Is64BitProcess -and (Test-Path -LiteralPath $native)) { return $native }
    return (Join-Path $env:SystemRoot 'System32\wsl.exe')
}

function Write-FbLog {
    param([string]$Message, [string]$Name = 'launcher.log')
    try {
        if (-not (Test-Path -LiteralPath $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }
        $path = Join-Path $script:LogDir $Name
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 1MB) {
            Move-Item -LiteralPath $path -Destination ($path + '.1') -Force
        }
        $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        Add-Content -LiteralPath $path -Value $line -Encoding UTF8
    } catch {
        Write-Verbose "log: $_"
    }
}

function ConvertTo-WslPath {
    # C:\Users\Me\AppData\... -> /mnt/c/Users/Me/AppData/... (the distribution mounts drives under /mnt).
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($Path -match '^([A-Za-z]):[\\/]?(.*)$') {
        $rest = $Matches[2] -replace '\\', '/'
        return ('/mnt/{0}/{1}' -f $Matches[1].ToLowerInvariant(), $rest).TrimEnd('/')
    }
    throw "Not a drive path: $Path"
}

function ConvertTo-CommandLineArgument {
    # One argument for a Windows command line (CommandLineToArgvW / MSVCRT rules).
    param([AllowEmptyString()][string]$Value)
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * (2 * $backslashes + 1)); [void]$sb.Append('"')
        } else {
            [void]$sb.Append('\' * $backslashes); [void]$sb.Append($ch)
        }
        $backslashes = 0
    }
    [void]$sb.Append('\' * (2 * $backslashes))
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Join-CommandLine {
    param([string[]]$Arguments)
    return (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
}

function New-AccessToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-AppUrl {
    # The tokened address of a page on the server (path may carry its own query).
    param([int]$Port, [string]$Token, [string]$Path = '/')
    if (-not $Path.StartsWith('/')) { $Path = '/' + $Path }
    $separator = '?'
    if ($Path.Contains('?')) { $separator = '&' }
    return ('http://127.0.0.1:{0}{1}{2}token={3}' -f $Port, $Path, $separator, [Uri]::EscapeDataString($Token))
}

function Test-PortFree {
    param([int]$Port)
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) { try { $listener.Stop() } catch { Write-Verbose "stop: $_" } }
    }
}

function Select-ServerPort {
    # The first free preferred port; else any free one. -IsFree: for tests.
    param([int[]]$Preferred = $script:PreferredPorts, [scriptblock]$IsFree = { param($p) Test-PortFree $p })
    foreach ($port in $Preferred) {
        if (& $IsFree $port) { return $port }
    }
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $listener.Start()
    try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Get-PortFromServerLog {
    # The port the server actually took (it moves to the next one when its port is in use).
    param([string[]]$Lines)
    $port = $null
    foreach ($line in $Lines) {
        if ($line -match 'Open http://(?:localhost|127\.0\.0\.1):(\d+)/') { $port = [int]$Matches[1] }
    }
    return $port
}

function Read-SharedText {
    # A file another process is writing (the server log).
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $stream = New-Object System.IO.FileStream $Path, ([System.IO.FileMode]::Open), ([System.IO.FileAccess]::Read), ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
        $reader = New-Object System.IO.StreamReader $stream, ([System.Text.Encoding]::UTF8)
        try { return ($reader.ReadToEnd() -split "`r?`n") } finally { $reader.Dispose() }
    } catch {
        return @()
    }
}

function Invoke-LocalRequest {
    # A request to the local server (no proxy), with the access token. Returns the HTTP status (0: no answer).
    param([string]$Url, [string]$Token = '', [string]$Method = 'GET', [int]$TimeoutMs = 3000)
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = $Method
        $request.Proxy = $null
        $request.Timeout = $TimeoutMs
        if ($Token) { $request.Headers.Add('X-FiberBrowser-Token', $Token) }
        if ($Method -eq 'POST') {
            $request.ContentType = 'application/json'
            $body = [System.Text.Encoding]::UTF8.GetBytes('{}')
            $request.ContentLength = $body.Length
            $out = $request.GetRequestStream(); $out.Write($body, 0, $body.Length); $out.Close()
        }
        $response = $request.GetResponse()
        $status = [int]$response.StatusCode
        $response.Close()
        return $status
    } catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    } catch {
        return 0
    }
}

function Test-ServerReady {
    param([int]$Port, [string]$Token)
    return ((Invoke-LocalRequest -Url ('http://127.0.0.1:{0}/api/status' -f $Port) -Token $Token) -eq 200)
}

function Read-ServerState {
    if (-not (Test-Path -LiteralPath $script:StateFile)) { return $null }
    try { return (Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Write-ServerState {
    param([hashtable]$State)
    if (-not (Test-Path -LiteralPath $script:RunDir)) { New-Item -ItemType Directory -Path $script:RunDir -Force | Out-Null }
    $tmp = $script:StateFile + '.tmp'
    ($State | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $script:StateFile -Force
}

function Get-ImportFailureCode {
    # What a failed `wsl --import` means, from its message.
    param([string]$Output)
    if ($Output -match '0x80370102|virtualization|Virtualisierung') { return 20 }
    if ($Output -match '0x80370114|HCS_E_HYPERV_NOT_INSTALLED|Virtual Machine Platform|0x8004032d') { return 21 }
    if ($Output -match '0x800701bc|kernel|wsl --update|WSL_E_WSL2_NEEDS_UPDATE') { return 22 }
    return 29
}

function Test-DistroRegistered {
    # Registered WSL distributions are listed under HKCU\...\Lxss (no wsl.exe output to decode).
    param([string]$Name = $script:DistroName)
    $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (-not (Test-Path -LiteralPath $root)) { return $false }
    foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($null -ne $props -and ($props.PSObject.Properties.Name -contains 'DistributionName') -and $props.DistributionName -eq $Name) {
            return $true
        }
    }
    return $false
}

function Get-AppPathsValue {
    # A program's registered path (App Paths, per user then per machine), or $null.
    param([string]$Exe)
    $keys = @(
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Exe",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Exe",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$Exe"
    )
    foreach ($key in $keys) {
        $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        $value = $item.GetValue('')
        if ($value) { return ([string]$value).Trim('"') }
    }
    return $null
}

function Find-AppBrowser {
    # Edge (every Windows 10/11 has it), else Chrome: both open a page as an app window (--app).
    $folders = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($exe in @('msedge.exe', 'chrome.exe')) {
        $candidates = @(Get-AppPathsValue $exe)
        foreach ($folder in $folders) {
            if ($exe -eq 'msedge.exe') { $candidates += (Join-Path $folder 'Microsoft\Edge\Application\msedge.exe') }
            else { $candidates += (Join-Path $folder 'Google\Chrome\Application\chrome.exe') }
        }
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
        }
    }
    return $null
}

function Get-AppBrowserArguments {
    # An app-style window (no tabs or address bar) in FiberBrowser's own browser profile.
    param([string]$Url, [string]$ProfileDir)
    return @(
        ('--app=' + $Url),
        ('--user-data-dir=' + $ProfileDir),
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1440,900'
    )
}

function Find-AppBrowserProcess {
    # The browser process that owns FiberBrowser's profile (not its helper processes).
    param([string]$ProfileDir)
    $needle = $ProfileDir.TrimEnd('\').ToLowerInvariant()
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        $line = [string]$proc.CommandLine
        if ($line -and $line.ToLowerInvariant().Contains($needle) -and $line -notmatch '--type=') {
            try { return (Get-Process -Id $proc.ProcessId -ErrorAction Stop) } catch { Write-Verbose "gone: $_" }
        }
    }
    return $null
}

# One FiberBrowser launch, or one Setup, at a time (both hold the launcher's
# lock); Setup also holds its own, so a launch during Setup can say so.
$script:LauncherLockName = 'Local\FiberBrowser.Launcher'
$script:SetupLockName = 'Local\FiberBrowser.Setup'

function Enter-FbLock {
    # The named lock, or $null when another process holds it.
    param([string]$Name)
    $mutex = New-Object System.Threading.Mutex($false, $Name)
    $owned = $false
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if ($owned) { return $mutex }
    $mutex.Dispose()
    return $null
}

function Exit-FbLock {
    param($Mutex)
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch { Write-Verbose "release: $_" }
    $Mutex.Dispose()
}

function Test-FbLockHeld {
    # Whether another process holds the named lock now.
    param([string]$Name)
    $mutex = Enter-FbLock $Name
    if ($null -eq $mutex) { return $true }
    Exit-FbLock $mutex
    return $false
}

function Add-KillOnCloseJob {
    # Ends $Process when this PowerShell ends, even when it is killed (a job
    # object that closes with this process). Returns $false where unavailable.
    param([System.Diagnostics.Process]$Process)
    if (-not ('FiberBrowserJob' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FiberBrowserJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static IntPtr job = IntPtr.Zero;
    public static bool Add(IntPtr process) {
        if (job == IntPtr.Zero) {
            IntPtr created = CreateJobObject(IntPtr.Zero, null);
            if (created == IntPtr.Zero) return false;
            ExtendedLimits info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(created, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) return false;
            job = created;
        }
        return AssignProcessToJobObject(job, process);
    }
}
"@
    }
    if ($null -eq $Process) { return $false }
    try { return [FiberBrowserJob]::Add($Process.Handle) } catch { return $false }
}

