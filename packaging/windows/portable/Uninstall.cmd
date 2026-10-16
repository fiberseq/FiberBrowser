@echo off
rem Removes a FiberBrowser installed with the portable package's Install.cmd
rem (Apps & features runs this). It runs from a copy in %TEMP% so it can
rem remove its own folder.
setlocal
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\FiberBrowser-Uninstall.cmd" >nul
  "%TEMP%\FiberBrowser-Uninstall.cmd" --from-temp "%~dp0."
  exit /b
)
set "APPDIR=%~f2"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\FiberBrowserSetup.ps1" -Action PortableUninstall
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" (
  cd /d "%TEMP%"
  rd /s /q "%APPDIR%"
  rd "%APPDIR%\.." 2>nul
)
pause
(goto) 2>nul & del "%~f0"
