#!/usr/bin/env bash
# Lint and unit-test the Windows launcher/setup scripts (packaging/windows/app)
# with PowerShell in Docker: PSScriptAnalyzer (incl. Windows PowerShell 5.1
# syntax compatibility) and the Pester tests in packaging/windows/tests.
#   bash packaging/windows/test_windows_scripts.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# The .NET SDK image has PowerShell 7 for amd64 and arm64 (the powershell image
# has no arm64 build: it would run emulated).
IMAGE="${FB_PWSH_IMAGE:-mcr.microsoft.com/dotnet/sdk:8.0}"
docker run --rm -v "$HERE:/w:ro" "$IMAGE" pwsh -NoProfile -Command '
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-PSRepository PSGallery -InstallationPolicy Trusted
Install-Module PSScriptAnalyzer -Scope CurrentUser -Force | Out-Null
Install-Module Pester -MinimumVersion 5.5 -Scope CurrentUser -Force -SkipPublisherCheck | Out-Null
$settings = @{
  ExcludeRules = @("PSAvoidUsingWriteHost", "PSUseShouldProcessForStateChangingFunctions", "PSUseSingularNouns",
                   "PSAvoidGlobalVars", "PSUseApprovedVerbs", "PSAvoidUsingPositionalParameters",
                   "PSReviewUnusedParameter")
  Rules = @{ PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @("5.1") } }
}
$issues = Invoke-ScriptAnalyzer -Path /w/app -Recurse -Settings $settings -Severity Warning, Error
$issues | Format-Table -AutoSize RuleName, Severity, ScriptName, Line, Message | Out-String -Width 200 | Write-Host
Write-Host ("PSScriptAnalyzer: {0} finding(s)" -f @($issues).Count)
$config = New-PesterConfiguration
$config.Run.Path = "/w/tests"
$config.Run.Exit = $false
$config.Run.PassThru = $true
$config.Output.Verbosity = "Detailed"
$result = Invoke-Pester -Configuration $config
Write-Host ("Pester: {0} passed, {1} failed" -f $result.PassedCount, $result.FailedCount)
if ($result.FailedCount -gt 0 -or @($issues | Where-Object Severity -eq "Error").Count -gt 0) { exit 1 }
'
