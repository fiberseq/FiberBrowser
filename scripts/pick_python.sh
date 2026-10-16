# Pick the Python that runs FiberBrowser. Sourced (POSIX sh; zsh-safe) by
# "Launch Browser.command" and "Launch Browser.sh"; sets PYTHON_BIN.
#
# Order: $FIBERBROWSER_PYTHON, the installer's venv (scripts/install.sh →
# ./.venv, or $FIBERBROWSER_VENV), the active virtualenv / conda env, then
# python3 / python on PATH and the usual install locations. A candidate counts
# only when it is Python 3.10+ and FiberBrowser's packages import in it, so a
# conda base or the system Python 3.9 without them is skipped instead of
# failing later. On an Apple Silicon Mac a native arm64 Python is preferred
# (an Intel one under Rosetta runs the browser, but not the local Copilot).

_fb_probe() {
  # 0 = usable; 3 = too old; 4 = packages missing; 5 = not a Python
  [ -n "$1" ] || return 5
  command -v "$1" >/dev/null 2>&1 || [ -x "$1" ] || return 5
  "$1" -c 'import sys
if sys.version_info < (3, 10): sys.exit(3)
try:
    import numpy, fastapi, uvicorn, pysam, pyBigWig  # noqa: F401
except Exception:
    sys.exit(4)' >/dev/null 2>&1
}

_fb_arch() {
  "$1" -c 'import platform; print(platform.machine())' 2>/dev/null
}

_fb_apple_silicon() {
  [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]
}

_fb_consider() {
  # $1 candidate; $2 = "arm64" to accept only a native arm64 Python.
  _fb_probe "$1"
  _fb_status=$?
  if [ "$_fb_status" -eq 0 ]; then
    if [ "$2" = "arm64" ] && [ "$(_fb_arch "$1")" != "arm64" ]; then
      return 1
    fi
    PYTHON_BIN="$1"
    return 0
  fi
  if [ "$_fb_status" -eq 4 ] && [ -z "$_FB_BARE" ]; then
    _FB_BARE="$1"  # Python 3.10+ without FiberBrowser's packages: named in the hint
  fi
  return 1
}

_fb_scan() {
  _fb_consider "${FIBERBROWSER_VENV:-./.venv}/bin/python" "$1" && return 0
  [ -n "${VIRTUAL_ENV:-}" ] && _fb_consider "$VIRTUAL_ENV/bin/python" "$1" && return 0
  [ -n "${CONDA_PREFIX:-}" ] && _fb_consider "$CONDA_PREFIX/bin/python" "$1" && return 0
  _fb_consider python3 "$1" && return 0
  _fb_consider python "$1" && return 0
  _fb_consider /opt/homebrew/bin/python3 "$1" && return 0
  _fb_consider "$HOME/miniforge3/bin/python" "$1" && return 0
  _fb_consider "$HOME/mambaforge/bin/python" "$1" && return 0
  _fb_consider "$HOME/miniconda3/bin/python" "$1" && return 0
  _fb_consider "$HOME/anaconda3/bin/python" "$1" && return 0
  _fb_consider /opt/anaconda3/bin/python "$1" && return 0
  _fb_consider /usr/local/bin/python3 "$1" && return 0
  return 1
}

pick_python() {
  PYTHON_BIN=""
  _FB_BARE=""
  if [ -n "${FIBERBROWSER_PYTHON:-}" ]; then
    PYTHON_BIN="$FIBERBROWSER_PYTHON"  # the user's choice: used as is
    return 0
  fi
  if _fb_apple_silicon; then
    _fb_scan arm64 && return 0
  fi
  _fb_scan any && return 0
  return 1
}

describe_python() {
  "$PYTHON_BIN" -c 'import platform, sys; print("  %s  (Python %s, %s)" % (sys.executable, platform.python_version(), platform.machine()))' 2>/dev/null
  if _fb_apple_silicon && [ "$(_fb_arch "$PYTHON_BIN")" != "arm64" ]; then
    echo "  Note: this is an Intel (x86_64) Python running under Rosetta. The browser works,"
    echo "  but the local Copilot needs a native arm64 Python: run scripts/install.sh"
    echo "  (or: python browser.py --copilot-doctor for the exact fix)."
  fi
}

no_python_help() {
  echo "Could not find a Python 3.10+ with FiberBrowser's packages installed."
  if [ -n "$_FB_BARE" ]; then
    echo "  $_FB_BARE is Python 3.10+ but the packages aren't installed in it."
  fi
  echo
  echo "Set it up once (creates ./.venv with everything FiberBrowser needs):"
  echo "  bash scripts/install.sh        (or double-click \"Install FiberBrowser.command\" on a Mac)"
  echo "Or use your own environment: set FIBERBROWSER_PYTHON=/path/to/python and run this launcher again."
}
