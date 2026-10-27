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
# - Optional machine-specific settings (graph helper, packages, pg-lift data, dm6 data) can live in a
#   file outside the repository: FIBERBROWSER_E2E_ENV=/path/to/e2e.env (sourced first). Specs whose
#   data isn't configured skip with the reason.
#
# Other settings:
#   FIBERBROWSER_E2E_WORK   work folder (default: a new temporary folder; reuse one to keep caches)
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
mkdir -p "$work/home"
work="$(cd "$work" && pwd)"

python="${FIBERBROWSER_TEST_PYTHON:-python}"
export FIBERBROWSER_TEST_PYTHON="$python"
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

# The current source, built outside the checkout.
npx vite build --outDir "$work/dist" --emptyOutDir --logLevel warn
export FIBERBROWSER_FRONTEND_DIST="$work/dist"

started=$(date +%s)
set +e
npx playwright test --output "$work/results" "$@"
status=$?
set -e
echo "e2e:full: finished in $(( ($(date +%s) - started) / 60 )) min (exit $status); artifacts in $work/results"
exit $status
