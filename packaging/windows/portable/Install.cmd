@echo off
rem FiberBrowser (portable package): installs FiberBrowser for this Windows user.
rem The same as FiberBrowser-<version>-Setup.exe, for PCs where that can't run.
setlocal
cd /d "%~dp0"
set "TARBALL="
for %%F in ("%~dp0FiberBrowser-*-wsl-amd64.tar.gz") do set "TARBALL=%%~fF"
if not defined TARBALL (
  echo The FiberBrowser-*-wsl-amd64.tar.gz file is missing next to Install.cmd: unzip the whole package first.
  pause
  exit /b 1
)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\FiberBrowserSetup.ps1" -Action PortableInstall -Tarball "%TARBALL%" -Version "@VERSION@"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo FiberBrowser was not installed (code %CODE%). Details: %LOCALAPPDATA%\FiberBrowser\logs\setup.log
pause
exit /b %CODE%
