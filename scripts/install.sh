#!/usr/bin/env bash
# One-time FiberBrowser setup: a private Python environment (./.venv) with
# everything the browser and, on Apple Silicon Macs, the local Copilot need.
#
#   bash scripts/install.sh            (or double-click "Install FiberBrowser.command")
#
# It picks a Python 3.10+ (a native arm64 one on Apple Silicon: an Intel
# Python under Rosetta can't run the Copilot model), creates the venv,
# upgrades pip (old pips can't read the requirement markers or find wheels),
# installs requirements.txt with a clean PATH (a conda on PATH makes pyBigWig
# build against conda's libraries, which then fail to load), checks the
# install, and runs the setup doctor. Safe to re-run.
#
# Environment: FIBERBROWSER_PYTHON (base Python to use), FIBERBROWSER_VENV
# (venv folder, default ./.venv), FIBERBROWSER_ALLOW_INTEL=1 (accept an Intel
# Python on Apple Silicon: the browser works, the Copilot won't).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
VENV="${FIBERBROWSER_VENV:-$ROOT/.venv}"

say() { printf '%s\n' "$*"; }
die() { printf '\nSetup stopped: %s\n' "$*" >&2; exit 1; }

apple_silicon=0
if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  apple_silicon=1
fi

# "ok" | "old" | "intel" for a candidate base Python.
check_base() {
  "$1" -c 'import platform, sys
if sys.version_info < (3, 10): print("old")
elif platform.machine() != "arm64" and "'"$apple_silicon"'" == "1": print("intel")
else: print("ok")' 2>/dev/null
}

pick_base() {
  local c verdict
  local -a candidates
  if [ -n "${FIBERBROWSER_PYTHON:-}" ]; then
    candidates=("$FIBERBROWSER_PYTHON")
  else
    candidates=(python3.13 python3.12 python3.11 python3.10
                /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11
                /Library/Frameworks/Python.framework/Versions/3.13/bin/python3
                /Library/Frameworks/Python.framework/Versions/3.12/bin/python3
                /Library/Frameworks/Python.framework/Versions/3.11/bin/python3
                "$HOME/miniforge3/bin/python3" "$HOME/mambaforge/bin/python3"
                "$HOME/miniconda3/bin/python3" "$HOME/anaconda3/bin/python3" /opt/anaconda3/bin/python3
                python3.14 /opt/homebrew/bin/python3.14 python3 /opt/homebrew/bin/python3)
  fi
  BASE=""; SAW_OLD=""; SAW_INTEL=""
  for c in "${candidates[@]}"; do
    command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || continue
    verdict="$(check_base "$c")"
    case "$verdict" in
      ok) BASE="$c"; return 0 ;;
      old) SAW_OLD="${SAW_OLD:-$c}" ;;
      intel) SAW_INTEL="${SAW_INTEL:-$c}" ;;
    esac
  done
  if [ -n "$SAW_INTEL" ] && [ "${FIBERBROWSER_ALLOW_INTEL:-0}" = "1" ]; then
    BASE="$SAW_INTEL"; return 0
  fi
  return 1
}

say "FiberBrowser setup"
say "  folder: $ROOT"
say "  venv:   $VENV"
say

if ! pick_base; then
  if [ -n "$SAW_INTEL" ]; then
    say "Found only Intel (x86_64) Pythons, e.g. $SAW_INTEL; on this Apple Silicon Mac they run"
    say "under Rosetta, where the local Copilot can't load. Install a native arm64 Python:"
    say "  curl -LO https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-arm64.sh"
    say "  bash Miniforge3-MacOSX-arm64.sh -b -p ~/miniforge3"
    say "then run this script again. (Or FIBERBROWSER_ALLOW_INTEL=1 bash scripts/install.sh to set up"
    say "the browser without the Copilot.)"
  elif [ -n "$SAW_OLD" ]; then
    say "Found only Python older than 3.10 (e.g. $SAW_OLD; macOS's own /usr/bin/python3 is 3.9)."
  else
    say "No Python found."
  fi
  if [ -z "$SAW_INTEL" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      say "Install Python 3.12, then run this script again. Any one of:"
      say "  brew install python@3.12                     (Homebrew: https://brew.sh)"
      say "  the macOS installer from https://www.python.org/downloads/"
      say "  Miniforge: curl -LO https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-$(uname -m).sh"
    else
      say "Install Python 3.10+ (e.g. your package manager's python3.12, or Miniforge), then run this again."
    fi
  fi
  die "no suitable Python."
fi
say "Using $("$BASE" -c 'import platform, sys; print("%s (Python %s, %s)" % (sys.executable, platform.python_version(), platform.machine()))')"

# pyBigWig has no macOS arm64 wheel: it compiles, which needs Apple's
# Command Line Tools.
if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  say
  say "Apple's Command Line Tools are needed to build one package (pyBigWig). Install them with:"
  say "  xcode-select --install"
  die "Command Line Tools missing; install them, then run this script again."
fi

PY="$VENV/bin/python"
if [ -x "$PY" ] && "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  say "Reusing the existing venv."
else
  say "Creating the venv..."
  rm -rf "$VENV"
  "$BASE" -m venv "$VENV" || die "could not create $VENV (python -m venv failed)."
fi

# A clean PATH: only the venv and the system tools (no conda / Homebrew
# curl-config or compilers leaking into source builds).
CLEAN_PATH="$VENV/bin:/usr/bin:/bin:/usr/sbin:/sbin"
say "Upgrading pip..."
env PATH="$CLEAN_PATH" "$PY" -m pip install --quiet --upgrade pip setuptools wheel \
  || die "pip upgrade failed (offline? behind a proxy? set HTTPS_PROXY and try again)."
say "Installing FiberBrowser's packages (a few minutes the first time)..."
if ! env PATH="$CLEAN_PATH" "$PY" -m pip install -r requirements.txt; then
  if ! env PATH="$CLEAN_PATH" "$PY" -m pip install --dry-run --quiet "fiberhmm[consensus]>=3.0,<4" >/dev/null 2>&1; then
    say
    say "pip could not find FiberHMM 3.x (fiberhmm[consensus]>=3.0,<4), which footprint classes,"
    say "chemistry detection and BAM export need. If you have a FiberHMM 3 source checkout, install it"
    say "into this venv and re-run this script:"
    say "  $PY -m pip install \"/path/to/FiberHMM[consensus]\""
    say "Installing everything else now; the browser runs without FiberHMM."
    grep -v -i '^fiberhmm' requirements.txt > "$VENV/requirements-no-fiberhmm.txt"
    env PATH="$CLEAN_PATH" "$PY" -m pip install -r "$VENV/requirements-no-fiberhmm.txt" \
      || die "pip install failed; the error is above. Re-running this script resumes."
  else
    die "pip install -r requirements.txt failed; the error is above. Re-running this script resumes."
  fi
fi

say "Checking the install..."
if ! "$PY" -c 'import numpy, fastapi, uvicorn, pysam, pyBigWig' 2>/dev/null; then
  say "A core package won't load; rebuilding pyBigWig against the system libraries..."
  env PATH="$CLEAN_PATH" "$PY" -m pip install --force-reinstall --no-cache-dir pyBigWig \
    || die "pyBigWig rebuild failed; see above."
  "$PY" -c 'import numpy, fastapi, uvicorn, pysam, pyBigWig' || die "core packages still won't load; see above."
fi
# PyPI's x86_64 Linux pyBigWig wheel has no libcurl: it reads local tracks only.
if ! "$PY" -c 'import sys, pyBigWig; sys.exit(0 if getattr(pyBigWig, "remote", 1) else 1)' 2>/dev/null; then
  say "pyBigWig can't read remote (http/s3/ssh) tracks; rebuilding it from source with libcurl..."
  if env PATH="$CLEAN_PATH" "$PY" -m pip install --force-reinstall --no-cache-dir --no-deps --no-binary pyBigWig pyBigWig \
     && "$PY" -c 'import sys, pyBigWig; sys.exit(0 if pyBigWig.remote else 1)' 2>/dev/null; then
    say "pyBigWig now reads remote tracks."
  else
    say "Warning: pyBigWig still can't read remote tracks (local files work). Install a C compiler and the"
    say "libcurl + zlib headers (e.g. sudo apt install build-essential libcurl4-openssl-dev zlib1g-dev),"
    say "then run this script again."
  fi
fi

if ! "$PY" -c 'import requests' 2>/dev/null; then
  die "the requests package won't load (the Jupyter client needs it); see the pip output above."
fi
if ! "$PY" -c 'import sys, fiberhmm
major = int(str(getattr(fiberhmm, "__version__", "0")).split(".")[0] or 0)
sys.exit(0 if major >= 3 else 1)' 2>/dev/null; then
  say "Warning: FiberHMM 3.x is not importable in $VENV. The browser runs, but footprint classes,"
  say "chemistry detection and BAM export need it:"
  say "  $PY -m pip install \"fiberhmm[consensus]>=3.0,<4\""
elif ! "$PY" -c 'import numba, sklearn' 2>/dev/null; then
  say "Warning: FiberHMM is installed without its consensus extras; footprint classes need them:"
  say "  $PY -m pip install \"fiberhmm[consensus]>=3.0,<4\""
fi

say
"$PY" browser.py --copilot-doctor
say
say "Done. Start FiberBrowser with the command below; it opens its access link"
say "(http://localhost:8000/?token=...) in your web browser. Start it with:"
say "  \"$ROOT/Launch Browser.command\"   (double-click in Finder), or"
say "  $PY browser.py"
