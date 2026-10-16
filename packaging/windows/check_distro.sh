#!/usr/bin/env bash
# Smoke-test FiberBrowser's WSL distribution (the counterpart of
# packaging/macos/check_app.sh).
#
#   bash packaging/windows/check_distro.sh [FiberBrowser-<version>-wsl-amd64.tar.gz]
#       imports the tarball into Docker (linux/amd64) and runs the checks in a
#       container as the distribution's user, from the exported files only
#       (no image settings: like `wsl --import`)
#   wsl -d FiberBrowser -- fiberbrowser-check-distro
#       the same checks inside the imported WSL distribution on Windows (plus
#       Windows interop: powershell.exe, explorer.exe, wslpath)
#
# Checks: the layout WSL relies on (wsl.conf, the fiberbrowser user, the
# commands), numba JIT + a cached FiberHMM kernel, a loky worker pool, the
# Mac app's extras (primer3/seqfold, cooler/h5py, s3fs, UMAP), the fiberhmm-*
# commands, minimap2, BLAST+ (blastn, makeblastdb), the build's flavour, the bundled FiberHMM used by default, the link
# relay; then the server as the Windows launcher
# starts it (fiberbrowser-wsl-serve with a token and a log file): /api/health,
# the token check, the page, the demo BAM opened and its reads served,
# /api/quit, and the stop-with-the-launcher fallback.
set -uo pipefail

if [ "${1:-}" != "--inside" ] && [ "$(basename "$0")" != fiberbrowser-check-distro ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  TARBALL="${1:-$(ls -t "$HERE"/../../build/windows/FiberBrowser-*-wsl-amd64.tar.gz 2>/dev/null | head -1)}"
  [ -f "$TARBALL" ] || { echo "no rootfs tarball (build it with build_wsl_distro.sh)" >&2; exit 1; }
  image="fiberbrowser-wsl-check:$(date +%s)"
  echo "Importing $(basename "$TARBALL") as $image (linux/amd64)"
  docker import --platform linux/amd64 "$TARBALL" "$image" >/dev/null || exit 1
  trap 'docker image rm -f "$image" >/dev/null 2>&1' EXIT
  # As WSL runs it: the default user from /etc/wsl.conf, its home, no image ENV.
  user="$(docker run --rm --platform linux/amd64 "$image" sh -c \
    "sed -n 's/^default *= *//p' /etc/wsl.conf | head -1")"
  docker run --rm --platform linux/amd64 -i -u "${user:-fiberbrowser}" -e HOME="/home/${user:-fiberbrowser}" \
    -e WSL_DISTRO_NAME=FiberBrowser -w "/home/${user:-fiberbrowser}" "$image" bash -s -- --inside < "$0"
  exit $?
fi

# --- inside the distribution ------------------------------------------------------------
PY=/opt/fiberbrowser/bin/python
failures=0
check() {  # name, command...
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    printf '  ok    %-34s %s\n' "$name" "$(printf '%s' "$out" | tail -1 | cut -c1-90)"
  else
    printf '  FAIL  %-34s %s\n' "$name" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | cut -c1-220)"
    failures=$((failures + 1))
  fi
}
export PYTHONPYCACHEPREFIX="$HOME/.cache/fiberbrowser/pycache" NUMBA_CACHE_DIR="$HOME/.cache/fiberbrowser/numba"
export OPENBLAS_NUM_THREADS=1 LANG=C.UTF-8

echo "Layout ($(uname -m), $(. /etc/os-release && echo "$PRETTY_NAME"), user $(id -un))"
check "/etc/wsl.conf default user" sh -c 'grep -q "^default *= *fiberbrowser" /etc/wsl.conf && id fiberbrowser'
check "Windows interop enabled" sh -c 'grep -q "^enabled *= *true" /etc/wsl.conf && grep -q "appendWindowsPath *= *true" /etc/wsl.conf && echo interop on'
check "home writable" sh -c 'touch "$HOME/.fb-check" && rm "$HOME/.fb-check" && ls -d "$HOME/data"'
check "install read-only for the user" sh -c '! touch /opt/fiberbrowser/.x 2>/dev/null && echo "/opt/fiberbrowser owned by $(stat -c %U /opt/fiberbrowser)"'
check "commands on PATH" sh -c 'out=""; for c in fiberbrowser fiberbrowser-wsl-serve fiberbrowser-check-distro fiberhmm-call minimap2 blastn makeblastdb; do p="$(command -v "$c")" || { echo "missing $c"; exit 1; }; out="$out $p"; done; echo $out'
if [ -n "${WSL_INTEROP:-}" ]; then  # a real WSL distribution (not the Docker stand-in)
  check "Windows programs (interop)" "$PY" -c "import sys, fiberbrowser._paths as p; sys.path.insert(0, str(p.browser_dir())); from services import wsl_interop as w; found = {n: w.windows_program(n) for n in ('powershell.exe', 'explorer.exe', 'cmd.exe', 'wsl.exe')}; assert all(found.values()), found; print(found['powershell.exe'])"
  check "wslpath both ways" sh -c 'w="$(wslpath -w "$HOME")" && [ "$(wslpath -u "$w")" = "$HOME" ] && echo "$w"'
  check "Windows drive mounted" sh -c 'ls -d /mnt/c/Windows'
fi

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
echo
echo "Runtime"
check "versions" "$PY" -c "import fiberbrowser, fiberhmm, pysam, numpy; print('FiberBrowser', fiberbrowser.__version__, 'FiberHMM', fiberhmm.__version__, 'pysam', pysam.__version__, 'numpy', numpy.__version__)"
check "numba JIT + FiberHMM kernel" "$PY" -c "$JIT_TEST"
check "loky worker pool" "$PY" -c "$POOL_TEST"
check "pyBigWig (numpy, remote tracks)" "$PY" -c "import pyBigWig; assert pyBigWig.numpy and pyBigWig.remote, (pyBigWig.numpy, pyBigWig.remote); print('pyBigWig numpy', pyBigWig.numpy, 'remote', pyBigWig.remote)"
check "primer design (primer3, seqfold)" "$PY" -c "import primer3, seqfold; print('Tm', round(primer3.calc_tm('GTAAAACGACGGCCAGT'), 1), 'dG', seqfold.dg('GGGAGGTCGTTACATCTGGGTAACACCGGTACTGATCCGGTGACCTCCC', temp=37.0))"
check "contact maps (cooler, h5py)" "$PY" -c "import cooler, h5py; print('cooler', cooler.__version__, 'h5py', h5py.__version__)"
check "UMAP embedding" "$PY" -c "import numpy as np, umap; print('umap', umap.UMAP(n_neighbors=5, n_components=2, random_state=0).fit_transform(np.random.default_rng(0).random((40, 6))).shape)"
check "s3:// contact maps (s3fs)" "$PY" -c "import s3fs, fsspec; assert int(s3fs.__version__.split('.')[0]) >= 2024, s3fs.__version__; print('s3fs', s3fs.__version__)"
check "Windows integration module" "$PY" -c "import sys; sys.path.insert(0, __import__('fiberbrowser._paths', fromlist=['x']).browser_dir().as_posix()); from services import wsl_interop; print('wsl_interop', 'is_wsl:', wsl_interop.is_wsl())"
check "fiberhmm-call --help" fiberhmm-call --help
check "fiberhmm-consensus --help" fiberhmm-consensus --help
check "python -m fiberhmm.cli.call" "$PY" -m fiberhmm.cli.call --help
if command -v fiberhmm-pipeline >/dev/null; then
  check "fiberhmm-pipeline --help" fiberhmm-pipeline --help
fi
check "python -m services.link_proxy" sh -c 'cd "$("$1" -c "import fiberbrowser._paths as p; print(p.browser_dir())")" && "$1" -m services.link_proxy </dev/null | grep "^PORT "' sh "$PY"
check "minimap2 --version" minimap2 --version
# BLAST+ is Debian bookworm's ncbi-blast+ (2.12.0) in /usr/bin, only blastn and makeblastdb kept.
check "blastn -version (Debian 2.12.0+)" sh -c 'v="$(BLAST_USAGE_REPORT=false /usr/bin/blastn -version | head -1)"; \
  case "$v" in *" 2.12.0+"*) echo "$v";; *) echo "unexpected: $v"; exit 1;; esac'
check "makeblastdb -version (Debian 2.12.0+)" sh -c 'v="$(BLAST_USAGE_REPORT=false /usr/bin/makeblastdb -version | head -1)"; \
  case "$v" in *" 2.12.0+"*) echo "$v";; *) echo "unexpected: $v"; exit 1;; esac'
check "only blastn and makeblastdb kept" sh -c 'extra="$(dpkg -L ncbi-blast+ | grep "^/usr/bin/" | while read -r f; do [ -e "$f" ] && basename "$f"; done | grep -vx -e blastn -e makeblastdb)"; \
  [ -z "$extra" ] || { echo "also: $extra"; exit 1; }; echo "blastn makeblastdb"'
# Every Debian package that provides a library blastn / makeblastdb load carries its copyright file
# (bookworm's build links no LZO).
check "BLAST+ notices (Debian copyright files)" sh -c 'pk="$(for f in /usr/bin/blastn /usr/bin/makeblastdb /usr/lib/ncbi-blast+/*.so; do ldd "$f"; done \
  | awk "{print \$3}" | grep "^/" | sort -u | while read -r l; do dpkg -S "$(readlink -f "$l")" 2>/dev/null || dpkg -S "$l"; done \
  | cut -d: -f1 | sort -u)"; [ -n "$pk" ] || { echo "no packages found"; exit 1; }; \
  for p in ncbi-blast+ $pk; do [ -s "/usr/share/doc/$p/copyright" ] || { echo "missing /usr/share/doc/$p/copyright"; exit 1; }; done; \
  grep -q "sources.debian.org" /usr/local/share/licenses/THIRD_PARTY_NOTICES.txt && echo "copyright files of" $pk'
check "resolver finds /usr/bin/blastn" env -i HOME="$HOME" PATH=/nonexistent "$PY" -c '
import sys
from fiberbrowser._paths import browser_dir
sys.path.insert(0, str(browser_dir()))
from services import external_tools as et
info = et.resolve("blastn", environ={"PATH": "/nonexistent"})
assert info.path == "/usr/bin/blastn" and info.version.startswith("2.12.0"), (info.path, info.version)
print(info.path, info.version)'
# Debian's per-package licence notices stay in the image (the Dockerfile trims the other docs).
check "Debian copyright files kept" sh -c 'n=0; for p in libc6 openssh-client ca-certificates procps libgomp1 ncbi-blast+; do \
  [ -f "/usr/share/doc/$p/copyright" ] || { echo "missing /usr/share/doc/$p/copyright"; exit 1; }; n=$((n+1)); done; \
  extra="$(find /usr/share/doc -type f ! -name copyright | head -1)"; [ -z "$extra" ] || { echo "untrimmed: $extra"; exit 1; }; \
  echo "$n checked, $(find /usr/share/doc -name copyright | wc -l) copyright files"'
# The server finds them from the PATH it is started with (the resolver's PATH step) and opts out
# of BLAST+ usage reports.
check "server finds BLAST+" env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin "$PY" -c '
import shutil
from fiberbrowser.cli import prepare_process_environment
from fiberbrowser._paths import build_flavor
env = prepare_process_environment({"PATH": "/usr/local/bin:/usr/bin:/bin"})
found = {n: shutil.which(n, path=env["PATH"]) for n in ("minimap2", "blastn", "makeblastdb")}
assert all(found.values()), found
assert env.get("BLAST_USAGE_REPORT") == "false"
print(found["blastn"], ";", build_flavor(), "build")'
check "server finds the TE library" env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin "$PY" -c '
import sys
from fiberbrowser._paths import browser_dir
sys.path.insert(0, str(browser_dir()))
from services.te_library import bundled_library_dir
te = bundled_library_dir("dmel-canonical-v10.2")
assert te is not None and (te / "D_mel_transposon_sequence_set_v10.2.fa").is_file() and (te / "LICENSE.txt").is_file(), te
print("TE library", te)'
check "analysis feature pack included" env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin "$PY" -c '
from fiberbrowser._paths import browser_dir, build_flavor
pack = browser_dir() / "lab"
assert build_flavor() == "public", build_flavor()
for rel in ("fiberbrowser-pack.json", "routers/accessibility.py", "routers/region_sync.py"):
    assert (pack / rel).is_file(), rel
print("NFRs and Synchronise regions")'
# The distribution runs its bundled FiberHMM by default: its build file is there, and a browser_settings.json naming
# another FiberHMM (what source runs follow) changes nothing (a throwaway HOME).
BUNDLED_TEST='
import sys
from fiberbrowser._paths import browser_dir
sys.path.insert(0, str(browser_dir()))
from services.app_build import build_info, is_packaged
from services.fiberhmm_runtime import configure_fiberhmm_runtime, fiberhmm_selection
info = build_info()
assert is_packaged() and info and info.get("channel") and info.get("platform") == "windows-x64", info
s = fiberhmm_selection()
assert s["requested"]["source"] == "bundled" and s["source"] == "bundled" and s["root"] is None, s
assert not s["missing"], ("the bundled FiberHMM lacks", s["missing"])
configure_fiberhmm_runtime()
import fiberhmm
assert fiberhmm.__file__.startswith("/opt/fiberbrowser/"), fiberhmm.__file__
print("bundled FiberHMM", s["version"], "(", s["package_dir"], ");", info["channel"], "channel", info["version"], "build", info.get("build"))
'
bundled_default() {
  local h rc
  h="$(mktemp -d)"
  mkdir -p "$h/.fiberhmm" "$h/fake-fiberhmm/fiberhmm/inference"
  echo '__version__ = "2.16.8"' > "$h/fake-fiberhmm/fiberhmm/__init__.py"
  : > "$h/fake-fiberhmm/fiberhmm/inference/strand_rescue.py"
  printf '{"fiberhmm_source_dir": "%s/fake-fiberhmm"}\n' "$h" > "$h/.fiberhmm/browser_settings.json"
  env -i HOME="$h" PATH=/usr/local/bin:/usr/bin:/bin PYTHONPYCACHEPREFIX="$h/pyc" "$PY" -c "$BUNDLED_TEST"; rc=$?
  rm -rf "$h"
  return $rc
}
check "bundled FiberHMM by default" bundled_default
check "fiberbrowser --version" fiberbrowser --version
check "server --help" fiberbrowser --help

# --- the server, as the Windows launcher starts it -----------------------------------------
echo
echo "Server (fiberbrowser-wsl-serve, as the launcher starts it)"
free_port() { "$PY" - <<'PYPORT'
import socket
for port in range(8880, 8890):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        break
else:
    raise SystemExit("No free test port within 8880–8889")
PYPORT
}
export FIBERBROWSER_PORT_MIN=8880 FIBERBROWSER_PORT_MAX=8889
TOKEN="check-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
LOG="$HOME/.fiberhmm/logs/check-wsl-server.log"
PORT="$(free_port)"
BASE="http://127.0.0.1:$PORT"
HTTP_PY="$(mktemp)"
cat > "$HTTP_PY" <<'PYEOF'
import json, sys, urllib.request, urllib.error
method, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
body = sys.argv[4].encode() if len(sys.argv) > 4 else (b"{}" if method == "POST" else None)
req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
if token != "-":
    req.add_header("X-FiberBrowser-Token", token)
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        status, text = r.status, r.read().decode("utf-8", "replace")
except urllib.error.HTTPError as e:
    status, text = e.code, ""
print(status)
print(text)
PYEOF
http() { "$PY" "$HTTP_PY" "$@"; }   # METHOD URL TOKEN|- [JSON] -> status line, then the body
json_check() { "$PY" -c "import json, sys; d = json.loads(sys.stdin.read().split(chr(10), 1)[1]); $1"; }

rm -f "$LOG"
fiberbrowser-wsl-serve --log "$LOG" --token "$TOKEN" --port "$PORT" &
SERVER=$!
ready=0
for _ in $(seq 1 600); do  # emulated amd64 (Docker on Apple silicon) starts slowly
  kill -0 "$SERVER" 2>/dev/null || break
  if http GET "$BASE/api/status" "$TOKEN" 2>/dev/null | head -1 | grep -q '^200$'; then ready=1; break; fi
  sleep 1
done
c_link() { grep -o "Open http://localhost:$PORT/?token=$TOKEN" "$LOG"; }
c_quiet() { ! grep -qi 'opening your default web browser' "$LOG" && grep -m1 'FiberBrowser WSL server' "$LOG"; }
c_health() { http GET "$BASE/api/health" - | tr '\n' ' ' | grep '^200 .*ok'; }
c_no_token() { http GET "$BASE/api/status" - | head -1 | grep -v '^200$'; }
c_token() { http GET "$BASE/api/status" "$TOKEN" | head -1 | grep '^200$'; }
c_page() { http GET "$BASE/?token=$TOKEN" - | grep -o '<title>[^<]*</title>'; }
c_demo() { http POST "$BASE/api/demo/load" "$TOKEN" | json_check 'assert d.get("success") and d.get("dataset_id"), d; print("dataset", d["dataset_id"], d["region"])'; }
c_reads() { http GET "$BASE/api/reads/compact?chrom=chr19&start=47514000&end=47518000&max_reads=50" "$TOKEN" \
  | json_check 'n = len(d.get("reads") or []); assert n > 0, sorted(d)[:8]; print(n, "reads")'; }
c_winpath() {  # a Windows path is answered (translated in WSL, a plain not-found elsewhere)
  http POST "$BASE/api/datasets/add" "$TOKEN" '{"path": "C:\\nope\\a.bam"}' \
  | json_check 'assert d.get("success") is False, d; print((d.get("error") or "")[:80])'; }
c_quit() {
  http POST "$BASE/api/quit" "$TOKEN" >/dev/null
  for i in $(seq 1 60); do kill -0 "$SERVER" 2>/dev/null || { echo "stopped after $i s"; return 0; }; sleep 1; done
  return 1
}
if [ "$ready" != 1 ]; then
  echo "  FAIL  server did not start; end of its log:"; tail -30 "$LOG" | sed 's/^/        /'
  failures=$((failures + 1))
else
  check "log has the access link" c_link
  check "log: wrapper banner, no browser" c_quiet
  check "/api/health (no token)" c_health
  check "token required" c_no_token
  check "token accepted" c_token
  check "page loads (tokened link)" c_page
  check "demo BAM opens" c_demo
  check "demo reads served" c_reads
  check "Windows path request" c_winpath
  check "/api/quit stops it" c_quit
fi
kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null

# The fallback when the launcher's wsl.exe goes away without /api/quit: the
# wrapper's parent ends, the server is re-parented and stops on its own.
LOG2="$HOME/.fiberhmm/logs/check-wsl-parent.log"
PORT2="$(free_port)"
rm -f "$LOG2" "$HOME/.fb-check-pid"
sh -c 'fiberbrowser-wsl-serve --log "$1" --token "$2" --port "$3" & echo $! > "$HOME/.fb-check-pid"; wait' \
  sh "$LOG2" "$TOKEN" "$PORT2" &
PARENT=$!
for _ in $(seq 1 600); do
  grep -q "Open http://localhost:$PORT2" "$LOG2" 2>/dev/null && break
  sleep 1
done
CHILD="$(cat "$HOME/.fb-check-pid" 2>/dev/null)"
{ kill -9 "$PARENT"; wait "$PARENT"; } 2>/dev/null
c_orphan() {
  for i in $(seq 1 30); do kill -0 "$CHILD" 2>/dev/null || { echo "stopped $i s after its parent"; return 0; }; sleep 1; done
  return 1
}
check "stops when its launcher goes" c_orphan
kill "$CHILD" 2>/dev/null
rm -f "$HOME/.fb-check-pid" "$HTTP_PY"

echo
[ "$failures" -eq 0 ] && echo "All checks passed." || echo "$failures check(s) failed."
exit $((failures > 0))
