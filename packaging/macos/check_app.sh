#!/usr/bin/env bash
# Smoke-test a built FiberBrowser.app, and which hardened-runtime entitlements it needs.
#
#   bash packaging/macos/check_app.sh [path/to/FiberBrowser.app] [--entitlements]
#
# Smoke test (the app as built): numba JIT, a cached FiberHMM kernel, a loky
# worker pool (workers re-run the app binary with -m), the bundled
# fiberhmm-* commands, minimap2, BLAST+ (blastn, makeblastdb: signed, -version,
# system libraries only, found on the server's PATH from launchd's minimal
# PATH), the bundled TE library, the build's flavour, the bundled FiberHMM used by default (its build file; a
# browser_settings.json naming another FiberHMM is ignored), the server role (--serve --help).
# Every release includes the complete analysis feature pack.
#
# --entitlements: on throwaway ad-hoc copies signed with the hardened runtime,
# run the JIT test with and without each entitlement in entitlements.plist.
# Ad-hoc copies also need disable-library-validation (no Team ID; a Developer
# ID build doesn't), which is added to every variant and so doesn't change the
# comparison.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HERE/../../build/macos/dist/FiberBrowser.app}"
[ -d "$APP" ] || { echo "no app at $APP" >&2; exit 1; }
APP="$(cd "$APP" && pwd)"
failures=0
check() {  # name, command...
  local name="$1"; shift
  if out="$("$@" 2>&1)"; then
    printf '  ok    %-28s %s\n' "$name" "$(printf '%s' "$out" | tail -1 | cut -c1-90)"
  else
    printf '  FAIL  %-28s %s\n' "$name" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | cut -c1-200)"
    failures=$((failures + 1))
  fi
}

JIT_TEST='
import numpy as np, numba
@numba.njit
def total(a):
    s = 0.0
    for x in a:
        s += x
    return s
assert total(np.arange(10.0)) == 45.0
from fiberhmm.inference.engine import _footprint_runs_numba
starts, ends = _footprint_runs_numba(np.array([1, 0, 0, 1, 0, 1], dtype=np.int8))
assert list(starts) == [1, 4] and list(ends) == [3, 5], (starts, ends)
print("numba", numba.__version__, "JIT and cached FiberHMM kernel OK")
'
POOL_TEST='
import os
from joblib.externals.loky import ProcessPoolExecutor
from joblib.externals.loky.backend.context import get_context
with ProcessPoolExecutor(max_workers=2, context=get_context("loky")) as pool:
    pids = {pool.submit(os.getpid).result() for _ in range(4)}
    assert os.getpid() not in pids
    print("loky workers:", len(pids), "results:", list(pool.map(abs, [1, -2, 3])))
'

BIN="$APP/Contents/MacOS/FiberBrowser"
echo "Smoke test: $APP"
check "numba JIT + FiberHMM kernel" "$BIN" -c "$JIT_TEST"
check "loky worker pool" "$BIN" -c "$POOL_TEST"
check "primer design (primer3, seqfold)" "$BIN" -c "import primer3, seqfold; print('Tm', round(primer3.calc_tm('GTAAAACGACGGCCAGT'), 1), 'dG', seqfold.dg('GGGAGGTCGTTACATCTGGGTAACACCGGTACTGATCCGGTGACCTCCC', temp=37.0))"
check "contact maps (cooler, h5py)" "$BIN" -c "import cooler, h5py; print('cooler', cooler.__version__, 'h5py', h5py.__version__)"
check "UMAP embedding" "$BIN" -c "import numpy as np, umap; print('umap', umap.UMAP(n_neighbors=5, n_components=2, random_state=0).fit_transform(np.random.default_rng(0).random((40, 6))).shape)"
check "s3:// contact maps (s3fs)" "$BIN" -c "import s3fs, fsspec; print('s3fs', s3fs.__version__)"
check "fiberhmm-call --help" "$APP/Contents/Resources/bin/fiberhmm-call" --help
check "fiberhmm-consensus --help" "$APP/Contents/Resources/bin/fiberhmm-consensus" --help
check "python -m fiberhmm.cli.call" "$BIN" -m fiberhmm.cli.call --help
if [ -x "$APP/Contents/Resources/bin/fiberhmm-pipeline" ]; then  # FiberHMM with the pipeline (New DAF-seq run)
  check "fiberhmm-pipeline --help" "$APP/Contents/Resources/bin/fiberhmm-pipeline" --help
  check "python -m fiberhmm.cli.pipeline" "$BIN" -m fiberhmm.cli.pipeline --help
fi
# The link relay (services/link_proxy.py): public/lab servers read link files through it.
# It prints its port, then exits when its stdin closes.
# Started as the server does (link_proxy._start_locked): from the backend folder.
check "python -m services.link_proxy" sh -c 'cd "$2" && "$1" -m services.link_proxy </dev/null | grep "^PORT "' \
  sh "$BIN" "$APP/Contents/Resources/fiberbrowser/browser"
check "minimap2 --version" "$APP/Contents/Helpers/minimap2" --version
# BLAST+ (blastn, makeblastdb): present, signed, runs, and links only system libraries.
system_libs_only() {  # otool -L lists nothing outside /usr/lib and /System
  local extra
  extra="$(otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/)')"
  [ -z "$extra" ] || { echo "links non-system libraries: $extra"; return 1; }
  echo "system libraries only ($(otool -L "$1" | tail -n +2 | wc -l | tr -d ' '))"
}
for program in blastn makeblastdb; do
  helper="$APP/Contents/Helpers/$program"
  check "$program present" test -x "$helper"
  check "$program signed" codesign --verify --strict "$helper"
  check "$program -version" "$helper" -version
  check "$program libraries" system_libs_only "$helper"
done
check "BLAST+ licence notices" sh -c 'grep -q "PUBLIC DOMAIN NOTICE" "$1/BLAST-LICENSE.txt" \
  && grep -q "OpenLDAP Public License" "$1/BLAST-THIRD-PARTY.txt" && grep -q "Apache License" "$1/BLAST-THIRD-PARTY.txt" \
  && echo "NCBI notice + third-party licences"' sh "$APP/Contents/Resources/licenses"
check "TE library (D. melanogaster)" sh -c 'd="$1/Contents/Resources/te_libraries/dmel-canonical-v10.2"; \
  test -s "$d/D_mel_transposon_sequence_set_v10.2.fa" && test -s "$d/transposon_sequence_set_v10.2.gff" \
  && grep -q "CC0" "$d/LICENSE.txt" && echo "$(grep -c "^>" "$d/D_mel_transposon_sequence_set_v10.2.fa") families"' sh "$APP"
check "public release metadata" grep -Eq '"flavor"[[:space:]]*:[[:space:]]*"public"' "$APP/Contents/Resources/fiberbrowser-build.json"
check "analysis feature pack included" sh -c 'for p in "$1"/Contents/*/fiberbrowser/browser/lab; do
  if [ -s "$p/fiberbrowser-pack.json" ] && [ -s "$p/routers/accessibility.py" ] && [ -s "$p/routers/region_sync.py" ]; then
    echo "NFRs and Synchronise regions"; exit 0
  fi
done; echo "missing analysis feature pack"; exit 1' sh "$APP"
check "bundled tools found (launchd PATH)" env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$BIN" -c '
from fiberbrowser._paths import build_flavor, bundle_bin_dirs
import os, shutil
from fiberbrowser.cli import prepare_process_environment
env = prepare_process_environment({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
found = {n: shutil.which(n, path=env["PATH"]) for n in ("minimap2", "blastn", "makeblastdb")}
helpers = [str(d) for d in bundle_bin_dirs()]
assert all(v and os.path.dirname(v) in helpers for v in found.values()), (found, helpers)
assert env.get("BLAST_USAGE_REPORT") == "false", env.get("BLAST_USAGE_REPORT")
print("found in", helpers[0], ";", build_flavor(), "build")'
check "bundled TE library found" env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$BIN" -c '
import sys
from fiberbrowser._paths import browser_dir
sys.path.insert(0, str(browser_dir()))
from services.te_library import bundled_library_dir
te = bundled_library_dir("dmel-canonical-v10.2")
assert te is not None, "no bundled TE library"
print("TE library", te.name)'
# The app runs its bundled FiberHMM by default: its build file is there, and a browser_settings.json naming another
# FiberHMM (what source runs follow) changes nothing (a throwaway HOME).
BUNDLED_TEST='
import sys
from fiberbrowser._paths import browser_dir
sys.path.insert(0, str(browser_dir()))
from services.app_build import build_info, is_packaged
from services.fiberhmm_runtime import configure_fiberhmm_runtime, fiberhmm_selection
info = build_info()
assert is_packaged() and info and info.get("channel") and info.get("version"), info
s = fiberhmm_selection()
assert s["requested"]["source"] == "bundled" and s["source"] == "bundled" and s["root"] is None, s
assert not s["missing"], ("the bundled FiberHMM lacks", s["missing"])
configure_fiberhmm_runtime()
import fiberhmm
assert "fake-fiberhmm" not in fiberhmm.__file__, fiberhmm.__file__
print("bundled FiberHMM", s["version"], "(", s["package_dir"], ");", info["channel"], "channel", info["version"], "build", info.get("build"))
'
bundled_default() {  # app binary
  local h rc
  h="$(mktemp -d)"
  mkdir -p "$h/.fiberhmm" "$h/fake-fiberhmm/fiberhmm/inference"
  echo '__version__ = "2.16.8"' > "$h/fake-fiberhmm/fiberhmm/__init__.py"
  : > "$h/fake-fiberhmm/fiberhmm/inference/strand_rescue.py"
  printf '{"fiberhmm_source_dir": "%s/fake-fiberhmm"}\n' "$h" > "$h/.fiberhmm/browser_settings.json"
  env -i HOME="$h" PATH=/usr/bin:/bin "$1" -c "$BUNDLED_TEST"; rc=$?
  rm -rf "$h"
  return $rc
}
check "bundled FiberHMM by default" bundled_default "$BIN"
check "server --help" "$BIN" --serve --help
check "signature" codesign --verify --deep --strict "$APP"

if [ "${2:-}" = "--entitlements" ]; then
  echo
  echo "Hardened-runtime entitlements (ad-hoc copies):"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  variants=("both:allow-jit allow-unsigned-executable-memory" "allow-jit:allow-jit"
            "unsigned-memory:allow-unsigned-executable-memory" "none:")
  for variant in "${variants[@]}"; do
    name="${variant%%:*}"; keys="${variant#*:}"
    plist="$tmp/$name.plist"
    {
      echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo '<key>com.apple.security.cs.disable-library-validation</key><true/>'
      for key in $keys; do echo "<key>com.apple.security.cs.$key</key><true/>"; done
      echo '</dict></plist>'
    } > "$plist"
    copy="$tmp/$name/FiberBrowser.app"
    mkdir -p "$tmp/$name" && ditto "$APP" "$copy"
    codesign --force --options runtime --timestamp=none --sign - --entitlements "$plist" "$copy" 2>/dev/null
    if out="$("$copy/Contents/MacOS/FiberBrowser" -c "$JIT_TEST" 2>&1)"; then
      printf '  %-18s JIT works\n' "$name"
    else
      printf '  %-18s JIT FAILS: %s\n' "$name" "$(printf '%s' "$out" | grep -v '^ ' | tail -1 | cut -c1-120)"
    fi
  done
fi
exit $((failures > 0))
