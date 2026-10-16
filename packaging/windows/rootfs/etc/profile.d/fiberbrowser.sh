# FiberBrowser WSL distribution: a shell here (wsl -d FiberBrowser) has the
# fiberbrowser and fiberhmm-* commands, with caches outside the read-only install.
export LANG="${LANG:-C.UTF-8}"
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$HOME/.cache/fiberbrowser/pycache}"
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-$HOME/.cache/fiberbrowser/numba}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
