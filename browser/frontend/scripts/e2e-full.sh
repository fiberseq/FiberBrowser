#!/usr/bin/env bash
# The whole Playwright e2e suite in one command: `npm run e2e:full` (from browser/frontend).
#
#   FIBERBROWSER_TEST_FASTA=/path/to/hg38.fa npm run e2e:full [-- <playwright args, e.g. a spec name>]
#
# - Needs an indexed hg38 FASTA (FIBERBROWSER_TEST_FASTA, with its .fai): the demo BAM is on chr19 and
#   the pangenome specs are on chr3. Tests never download hg38; without it this script stops.
# - Two test ports (FIBERBROWSER_TEST_PORTS, default 8880,8881): specs that run two servers at once
#   skip, saying so, when only one is listed.
# - Builds the current source into a work folder and serves that build (FIBERBROWSER_FRONTEND_DIST),
#   so the tracked dist/ is never rebuilt and there is nothing to restore afterwards.
# - The servers run with a scratch HOME in the work folder: they never read or write ~/.fiberhmm
#   (its genome cache included). Playwright's browsers and Python's user site stay where they were.
# - Identify's TE libraries and genome BLAST databases persist outside that HOME in
#   FIBERBROWSER_E2E_CACHE (default: fiberbrowser-e2e-cache next to the work folder).
#   Servers receive FIBERBROWSER_TE_LIBRARY_DIR and FIBERBROWSER_BLAST_DB_DIR there.
#   The cache must be outside the scratch HOME and checkout and never in a .fiberhmm folder.
# - Optional machine-specific settings (graph helper, packages, pg-lift data, dm6 data) can live in a
#   file outside the repository: FIBERBROWSER_E2E_ENV=/path/to/e2e.env (sourced first). Specs whose
#   data isn't configured skip with the reason.
#
# Other settings:
#   FIBERBROWSER_E2E_WORK   work folder (default: a new temporary folder)
#   FIBERBROWSER_E2E_CACHE  persistent Identify cache (default: next to the work folder)
#   FIBERBROWSER_TEST_PYTHON  the Python that runs browser.py (needs FiberHMM importable)
set -euo pipefail

frontend="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$frontend"

if [[ -n "${FIBERBROWSER_E2E_ENV:-}" ]]; then
  # shellcheck disable=SC1090
  source "$FIBERBROWSER_E2E_ENV"
fi

fail() { echo "e2e:full: $*" >&2; exit 2; }

fasta="${FIBERBROWSER_TEST_FASTA:-}"
[[ -n "$fasta" ]] || fail "set FIBERBROWSER_TEST_FASTA to an indexed hg38 FASTA (tests never download hg38)"
[[ -f "$fasta" ]] || fail "FIBERBROWSER_TEST_FASTA is not a file: $fasta"
# Absolute: the servers run from the repository root, not from here.
fasta="$(cd "$(dirname "$fasta")" && pwd)/$(basename "$fasta")"
[[ -f "$fasta.fai" ]] || fail "FIBERBROWSER_TEST_FASTA has no index ($fasta.fai): run samtools faidx on it"
for contig in chr19 chr3; do
  grep -q "^${contig}	" "$fasta.fai" || fail "FIBERBROWSER_TEST_FASTA has no $contig: the specs need hg38 with chr19 and chr3"
done
export FIBERBROWSER_TEST_FASTA="$fasta"

export FIBERBROWSER_TEST_PORTS="${FIBERBROWSER_TEST_PORTS:-8880,8881}"
export FIBERBROWSER_TEST_PORT="${FIBERBROWSER_TEST_PORT:-${FIBERBROWSER_TEST_PORTS%%,*}}"

work="${FIBERBROWSER_E2E_WORK:-}"
if [[ -z "$work" ]]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/fiberbrowser-e2e.XXXXXX")"
fi
created=""
[[ -d "$work" ]] || { mkdir -p "$work"; created=1; }
work="$(cd "$work" && pwd -P)"
# Never inside the checkout: the build there would replace a tracked folder (dist/) or leave files in the tree.
repo="$(cd "$frontend/../.." && pwd -P)"
if [[ "$work/" == "$repo/"* ]]; then
  [[ -n "$created" ]] && rmdir "$work" 2>/dev/null
  fail "FIBERBROWSER_E2E_WORK must be outside the repository ($repo): $work"
fi
# The scratch HOME must be a real folder, never a link back to a real home or its ~/.fiberhmm.
for link in "$work/home" "$work/home/.fiberhmm"; do
  [[ -L "$link" ]] && fail "$link is a symbolic link: the servers' HOME must be a scratch folder"
done
mkdir -p "$work/home"

python="${FIBERBROWSER_TEST_PYTHON:-python}"
export FIBERBROWSER_TEST_PYTHON="$python"
# Resolve links before creating anything: neither the root nor either cache child
# may lead back to a real home cache, the scratch HOME, or the checkout.
cache="${FIBERBROWSER_E2E_CACHE:-$(dirname "$work")/fiberbrowser-e2e-cache}"
cache="$("$python" - "$cache" "$work/home" "$repo" <<'PY'
import pathlib
import sys

root, home, repo = (pathlib.Path(p).resolve() for p in sys.argv[1:])
for path in (root, (root / 'te_libraries').resolve(), (root / 'blast').resolve()):
    if '.fiberhmm' in path.parts or path == home or home in path.parents or path == repo or repo in path.parents:
        sys.exit('e2e:full: Identify cache must be outside .fiberhmm, scratch HOME and checkout')
print(root)
PY
)" || fail "invalid FIBERBROWSER_E2E_CACHE"
mkdir -p "$cache/te_libraries" "$cache/blast"
export FIBERBROWSER_TE_LIBRARY_DIR="$cache/te_libraries"
export FIBERBROWSER_BLAST_DB_DIR="$cache/blast"
# Keep what lives under the real HOME before switching it: Playwright's browsers and Python's user site.
if [[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
  else
    export PLAYWRIGHT_BROWSERS_PATH="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"
  fi
fi
if [[ -z "${PYTHONUSERBASE:-}" ]]; then
  PYTHONUSERBASE="$("$python" -c 'import site; print(site.getuserbase())' 2>/dev/null || true)"
  [[ -n "$PYTHONUSERBASE" ]] && export PYTHONUSERBASE
fi
export npm_config_cache="${npm_config_cache:-$HOME/.npm}"
export HOME="$work/home"
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$work/pycache}"
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-$work/numba}"

echo "e2e:full: work folder $work"
echo "e2e:full: ports $FIBERBROWSER_TEST_PORTS, reference $FIBERBROWSER_TEST_FASTA"

# The current source, built outside the checkout (the build empties its folder first: never through a link).
[[ -L "$work/dist" ]] && fail "$work/dist is a symbolic link: remove it (the build empties the folder it points to)"
if [[ -e "$work/dist" ]] && [[ "$(cd "$work/dist" && pwd -P)/" == "$repo/"* ]]; then
  fail "$work/dist is inside the repository ($repo)"
fi
npx vite build --outDir "$work/dist" --emptyOutDir --logLevel warn
export FIBERBROWSER_FRONTEND_DIST="$work/dist"

started=$(date +%s)
set +e
npx playwright test --output "$work/results" "$@"
status=$?
set -e
echo "e2e:full: finished in $(( ($(date +%s) - started) / 60 )) min (exit $status); artifacts in $work/results"
exit $status
