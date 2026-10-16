# Pester 5 tests of the Windows launcher/setup helpers (app/FiberBrowser.Common.ps1),
# and syntax checks of the scripts. Run by test_windows_scripts.sh (PowerShell in
# Docker, or pwsh / Windows PowerShell with Pester 5 directly):
#   Invoke-Pester packaging/windows/tests
BeforeAll {
    if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) ('fb-test-' + [guid]::NewGuid()) }
    $script:AppScripts = Join-Path (Split-Path -Parent $PSScriptRoot) 'app'
    . (Join-Path $script:AppScripts 'FiberBrowser.Common.ps1')
}

Describe 'ConvertTo-WslPath' {
    It 'maps a drive path under /mnt' {
        ConvertTo-WslPath 'C:\Users\Ann Lee\AppData\Local\FiberBrowser\logs\server.log' |
            Should -Be '/mnt/c/Users/Ann Lee/AppData/Local/FiberBrowser/logs/server.log'
        ConvertTo-WslPath 'D:/data/run 1/' | Should -Be '/mnt/d/data/run 1'
        ConvertTo-WslPath 'E:\' | Should -Be '/mnt/e'
    }
    It 'refuses other paths' {
        { ConvertTo-WslPath '\\server\share\a.bam' } | Should -Throw
    }
}

Describe 'Command lines' {
    It 'quotes arguments as CommandLineToArgvW expects' {
        ConvertTo-CommandLineArgument 'plain' | Should -Be 'plain'
        ConvertTo-CommandLineArgument '' | Should -Be '""'
        ConvertTo-CommandLineArgument 'with space' | Should -Be '"with space"'
        ConvertTo-CommandLineArgument 'say "hi"' | Should -Be '"say \"hi\""'
        ConvertTo-CommandLineArgument 'C:\My Dir\' | Should -Be '"C:\My Dir\\"'
        ConvertTo-CommandLineArgument 'C:\plain\dir\' | Should -Be 'C:\plain\dir\'
        ConvertTo-CommandLineArgument 'a\\"b c' | Should -Be '"a\\\\\"b c"'
    }
    It 'joins the server command' {
        $line = Join-CommandLine @('-d', 'FiberBrowser', '-u', 'fiberbrowser', '-e', '/usr/local/bin/fiberbrowser-wsl-serve',
            '--log', '/mnt/c/Users/Ann Lee/x.log', '--token', 'abc_-1', '--port', '8756')
        $line | Should -Be '-d FiberBrowser -u fiberbrowser -e /usr/local/bin/fiberbrowser-wsl-serve --log "/mnt/c/Users/Ann Lee/x.log" --token abc_-1 --port 8756'
    }
    It 'opens an app window in its own profile' {
        $argv = Get-AppBrowserArguments -Url 'http://127.0.0.1:8756/?token=t' -ProfileDir 'C:\Users\Ann Lee\AppData\Local\FiberBrowser\BrowserProfile'
        $argv[0] | Should -Be '--app=http://127.0.0.1:8756/?token=t'
        $argv | Should -Contain '--no-first-run'
        Join-CommandLine $argv | Should -Match '"--user-data-dir=C:\\Users\\Ann Lee\\AppData\\Local\\FiberBrowser\\BrowserProfile"'
    }
}

Describe 'Tokens and addresses' {
    It 'makes URL-safe random tokens' {
        $a = New-AccessToken; $b = New-AccessToken
        $a | Should -Match '^[A-Za-z0-9_-]{43}$'
        $a | Should -Not -Be $b
    }
    It 'adds the token to the page address' {
        Get-AppUrl -Port 8756 -Token 'abc' | Should -Be 'http://127.0.0.1:8756/?token=abc'
        Get-AppUrl -Port 8757 -Token 'a+b' -Path '/?workspace=new' | Should -Be 'http://127.0.0.1:8757/?workspace=new&token=a%2Bb'
        Get-AppUrl -Port 1 -Token 't' -Path 'x' | Should -Be 'http://127.0.0.1:1/x?token=t'
    }
}

Describe 'Ports' {
    It 'prefers 8756, then the next free one' {
        Select-ServerPort -Preferred @(8756, 8757, 8758) -IsFree { param($p) $p -ne 8756 } | Should -Be 8757
        Select-ServerPort -Preferred @(8756) -IsFree { param($p) $true } | Should -Be 8756
    }
    It 'falls back to any free port' {
        $port = Select-ServerPort -Preferred @(8756) -IsFree { param($p) $false }
        $port | Should -BeGreaterThan 0
        $port | Should -Not -Be 8756
    }
    It 'checks a port by binding it' {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
        $listener.Start()
        try { Test-PortFree $listener.LocalEndpoint.Port | Should -BeFalse } finally { $listener.Stop() }
    }
    It 'reads the port the server took from its log' {
        Get-PortFromServerLog @('  Port 8756 is already in use.', '  Using port 8757 instead.',
            '  Open http://localhost:8757/?token=abc in your browser') | Should -Be 8757
        Get-PortFromServerLog @('starting...') | Should -BeNullOrEmpty
    }
}

Describe 'Files' {
    It 'reads a log another process holds open' {
        $path = Join-Path $env:LOCALAPPDATA 'shared.log'
        New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null
        $writer = New-Object System.IO.StreamWriter ([System.IO.File]::Open($path, 'Create', 'Write', 'ReadWrite'))
        try {
            $writer.WriteLine('line one'); $writer.WriteLine('Open http://localhost:8756/?token=x'); $writer.Flush()
            (Read-SharedText $path) | Should -Contain 'line one'
        } finally { $writer.Dispose() }
        Read-SharedText (Join-Path $env:LOCALAPPDATA 'missing.log') | Should -BeNullOrEmpty
    }
    It 'keeps the server state between launches' {
        Write-ServerState @{ port = 8756; token = 'tok'; ready = $true; launcher = 42 }
        $state = Read-ServerState
        $state.port | Should -Be 8756
        $state.token | Should -Be 'tok'
        $state.ready | Should -BeTrue
    }
}

Describe 'Setup' {
    It 'explains wsl --import failures' {
        Get-ImportFailureCode 'Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/0x80370102 Please enable virtualization' | Should -Be 20
        Get-ImportFailureCode 'HCS_E_HYPERV_NOT_INSTALLED' | Should -Be 21
        Get-ImportFailureCode 'WSL 2 requires an update to its kernel component. 0x800701bc' | Should -Be 22
        Get-ImportFailureCode 'The system cannot find the file specified.' | Should -Be 29
    }
}

Describe 'Windows lookups' {
    It 'finds no browser without throwing (StrictMode, missing registry keys)' {
        { Get-AppPathsValue 'no-such-program.exe' } | Should -Not -Throw
        Get-AppPathsValue 'no-such-program.exe' | Should -BeNullOrEmpty
        { Find-AppBrowser } | Should -Not -Throw
    }
    It 'compiles the kill-on-close job helper' {
        Add-KillOnCloseJob $null | Should -BeFalse
        ('FiberBrowserJob' -as [type]) | Should -Not -BeNullOrEmpty
    }
}

Describe 'Locks' {
    It 'sees a lock held elsewhere, and takes a free one' {
        $name = 'Local\FiberBrowser.Test.' + [guid]::NewGuid().ToString('N')
        # Held by another thread (a named mutex belongs to a thread, as to another process).
        $holder = [powershell]::Create()
        [void]$holder.AddScript({
            param($name)
            $mutex = New-Object System.Threading.Mutex($false, $name)
            [void]$mutex.WaitOne()
            Start-Sleep -Seconds 4
            $mutex.ReleaseMutex()
        }).AddArgument($name)
        $async = $holder.BeginInvoke()
        try {
            Start-Sleep -Seconds 1
            Test-FbLockHeld $name | Should -BeTrue
            Enter-FbLock $name | Should -BeNullOrEmpty
        } finally {
            [void]$holder.EndInvoke($async)
            $holder.Dispose()
        }
        Test-FbLockHeld $name | Should -BeFalse
        $mine = Enter-FbLock $name
        $mine | Should -Not -BeNullOrEmpty
        Exit-FbLock $mine
    }
}

Describe 'Scripts' {
    It '<name> parses' -ForEach @(
        @{ name = 'FiberBrowser.ps1' }, @{ name = 'FiberBrowserSetup.ps1' }, @{ name = 'FiberBrowser.Common.ps1' }
    ) {
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $script:AppScripts $name), [ref]$null, [ref]$errors)
        $errors | Should -BeNullOrEmpty
    }
    It 'are ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)' {
        foreach ($file in Get-ChildItem (Join-Path $script:AppScripts '*.ps1')) {
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            ($bytes | Where-Object { $_ -gt 127 }) | Should -BeNullOrEmpty -Because $file.Name
        }
    }
}
