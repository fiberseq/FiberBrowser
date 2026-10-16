@echo off
setlocal

cd /d "%~dp0"

echo FiberBrowser opens its access link (http://localhost:PORT/?token=...) in your web browser.
echo To open it again, use the link printed below.

if defined FIBERBROWSER_PYTHON (
  set "PYTHON_BIN=%FIBERBROWSER_PYTHON%"
) else (
  set "PYTHON_BIN="
)

if not defined PYTHON_BIN (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 browser.py %*
    goto done
  )
)

if not defined PYTHON_BIN (
  where python >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_BIN=python"
  )
)

if not defined PYTHON_BIN (
  echo Could not find Python.
  echo Install dependencies, or set FIBERBROWSER_PYTHON=C:\path\to\python.exe and run this launcher again.
  echo.
  pause
  exit /b 1
)

"%PYTHON_BIN%" browser.py %*

:done
if errorlevel 1 (
  echo.
  echo FiberBrowser exited with an error.
  echo If dependencies are installed in a specific environment, set FIBERBROWSER_PYTHON=C:\path\to\python.exe.
  echo.
  pause
)

