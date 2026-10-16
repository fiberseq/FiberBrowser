#!/usr/bin/env bash
# Build FiberBrowser.app and FiberBrowser-<version>-arm64.dmg (Apple silicon).
#
#   bash packaging/macos/build_app.sh
#
# Safe to re-run: the build venv, the minimap2 build and the downloads (BLAST+, ...)
# are reused, the app, the DMG and the signatures are made fresh each time.
#
# Steps: build venv (FiberBrowser + FiberHMM + pywebview + PyInstaller) ->
# PyInstaller (FiberBrowser.spec) -> bundle minimap2, blastn and makeblastdb
# (Contents/Helpers) and the fiberhmm-* commands (Contents/Resources/bin) ->
# LSMinimumSystemVersion from the bundled binaries -> sign (Developer ID if this
# keychain has one, else ad-hoc) -> notarize + staple (when the notarytool profile
# exists) -> DMG (the app + an Applications link) -> sign, notarize, staple the DMG.
# Every build bundles the D. melanogaster TE library (Contents/Resources/te_libraries; Identify's).
#
# Settings (environment variables):
#   FB_FLAVOR         public (default); legacy lab is an alias for the same complete release
#   FB_BUILD_DIR        work and output folder (default: <repo>/build/macos)
#   FB_PYTHON           base Python for the build venv: 3.10+, native arm64 (default: python3.12,
#                       python3.11, python3.10, python3). Its minimum macOS carries into the app.
#   FB_FIBERBROWSER     what to install as FiberBrowser (default: this checkout)
#   FB_FIBERHMM         FiberHMM to bundle: a pip requirement or a source folder
#                       (default: fiberhmm[consensus]>=3.0,<4 from PyPI)
#   FB_MINIMAP2         an existing arm64 minimap2 to bundle (default: build v$MINIMAP2_VERSION
#                       from source; MIT licence, copied into the app)
#   FB_BLAST_TARBALL    a local copy of NCBI's ncbi-blast-<version>+-aarch64-macosx.tar.gz (offline
#                       builds; checksum-checked). Default: downloaded once from NCBI into FB_BUILD_DIR.
#                       blastn and makeblastdb only are bundled (NCBI's code is public domain; the
#                       libraries they include: packaging/third_party/blast/BLAST-THIRD-PARTY.txt).
#   FB_BUNDLE_BLAST=0   build without BLAST+ (FiberBrowser then uses one installed on the Mac)
#   FB_TE_LIBRARY_DIR   a folder with local copies of the D. melanogaster TE library files
#                       (see packaging/third_party.sh; checksum-checked). Default: downloaded once.
#   FB_SIGN_IDENTITY    codesign identity; "-" forces ad-hoc (default: the first
#                       "Developer ID Application" identity found, else ad-hoc)
#   FB_KEYCHAIN         keychain holding that identity (a separate signing keychain, or CI's
#                       temporary one); unlocked at the start (asks its password) unless
#                       FB_UNLOCK_KEYCHAIN=0
#   FB_NOTARIZE         auto (default: when signed with Developer ID and the profile exists), 1, 0
#   FB_NOTARY_PROFILE   notarytool keychain profile (default: fiberhmm-notary)
#   FB_NOTARY_KEYCHAIN  keychain holding that profile (default: the login keychain)
#   FB_MACOS_TARGET     the app's minimum macOS (default: 14.0); the build stops if a bundled
#                       binary needs a newer one, unless FB_ALLOW_NEWER_MACOS=1
#   FB_SKIP_DMG=1       stop after the app
#   FB_BUILD_NUMBER     the build written into the app (default: the source commit's UTC time, YYYYMMDD.HHMM, the
#                       same as the WSL distribution's of that commit): with the version and
#                       the flavour's update channel in Contents/Resources/fiberbrowser-build.json
#                       (packaging/write_build_info.py; the app then runs its bundled FiberHMM by default)
#   FB_UPDATE_URL       an update manifest address baked into the app (https://, file:// or a path); default: the
#                       channel's GitHub releases (docs/updates.md)
#   FB_UPDATE_REPO      the channel's GitHub repository (owner/name) instead of the flavour's default
set -euo pipefail

MINIMAP2_VERSION=2.31
MINIMAP2_SHA256=c1351de6319c123369c2f4f37ba0ccf18c7ace47e2b1c0a35e30056b4a3bd9c9

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Pinned third-party files: versions, checksums, fetch helpers.
. "$HERE/../third_party.sh"
BUILD="${FB_BUILD_DIR:-$ROOT/build/macos}"
# Every release includes every analysis. Older build wrappers may still pass lab.
case "${FB_FLAVOR:-public}" in
  public|lab) FLAVOR=public ;;
  *) echo "FiberBrowser has one release build; FB_FLAVOR must be public (legacy lab is an alias)" >&2; exit 1 ;;
esac
VENV="$BUILD/venv"
DIST="$BUILD/dist"
APP="$DIST/FiberBrowser.app"
ENTITLEMENTS="$HERE/entitlements.plist"
NOTARY_PROFILE="${FB_NOTARY_PROFILE:-fiberhmm-notary}"
CLEAN_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
# The app's macOS floor (FB_MACOS_TARGET). Packages pip compiles from source
# (pyBigWig has no arm64 wheel) target it too; otherwise they would target the
# build Mac's own macOS and the app would refuse to open on anything older.
MACOS_TARGET="${FB_MACOS_TARGET:-14.0}"
export MACOSX_DEPLOYMENT_TARGET="$MACOS_TARGET"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nbuild_app.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "builds on macOS only"
[ "$(uname -m)" = "arm64" ] || die "builds on Apple silicon (arm64) only for now"
mkdir -p "$BUILD"

# A separate signing keychain (FB_KEYCHAIN) is unlocked once, here, so the long
# build and the signing run unattended: in a terminal its password is asked
# there; without one (e.g. run by a tool), asking the keychain for its settings
# makes macOS show its own unlock dialog if it is locked. FB_UNLOCK_KEYCHAIN=0
# skips this (CI unlocks its own temporary keychain).
if [ -n "${FB_KEYCHAIN:-}" ] && [ "${FB_UNLOCK_KEYCHAIN:-1}" != 0 ]; then
  say "Unlocking the signing keychain $FB_KEYCHAIN"
  if [ -t 0 ]; then
    security unlock-keychain "$FB_KEYCHAIN" || die "could not unlock $FB_KEYCHAIN"
  else
    echo "  (a macOS password dialog appears if it is locked)"
    security show-keychain-info "$FB_KEYCHAIN" >/dev/null 2>&1 || die "could not unlock $FB_KEYCHAIN"
  fi
fi

# --- 1. build venv -------------------------------------------------------------
# A usable base Python: 3.10+, native arm64, and built for a macOS no newer than
# MACOS_TARGET (its libpython and extension modules carry that minimum into the
# app; e.g. Homebrew's Python on a new macOS targets that macOS).
python_ok() {
  "$1" - "$MACOS_TARGET" <<'PY' 2>/dev/null
import platform, sys, sysconfig
target = tuple(int(x) for x in sys.argv[1].split(".")[:2])
built = tuple(int(x) for x in sysconfig.get_platform().split("-")[1].split(".")[:2])
sys.exit(not (sys.version_info >= (3, 10) and platform.machine() == "arm64" and built <= target))
PY
}
pick_python() {
  if [ -n "${FB_PYTHON:-}" ]; then
    python_ok "$FB_PYTHON" || die "FB_PYTHON=$FB_PYTHON is not a native arm64 Python 3.10+ built for macOS <= $MACOS_TARGET"
    echo "$FB_PYTHON"; return
  fi
  local c
  for c in python3.12 python3.11 python3.13 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && python_ok "$(command -v "$c")"; then
      command -v "$c"; return
    fi
  done
  die "no native arm64 Python 3.10+ built for macOS <= $MACOS_TARGET found; set FB_PYTHON (python.org or conda Pythons target macOS 11)"
}
if [ ! -x "$VENV/bin/python" ]; then
  BASE="$(pick_python)"
  say "Creating the build venv with $BASE"
  "$BASE" -m venv "$VENV"
fi
python_ok "$VENV/bin/python" || die "the build venv $VENV was made with a Python built for a macOS newer than $MACOS_TARGET; delete it and rerun"
# A clean PATH: a conda on PATH makes pyBigWig build against conda's libcurl,
# which the app then can't load.
pip_install() { env PATH="$VENV/bin:$CLEAN_PATH" "$VENV/bin/python" -m pip install --disable-pip-version-check "$@"; }
say "Installing FiberBrowser, FiberHMM, pywebview and PyInstaller into $VENV"
pip_install -q --upgrade pip
FIBERHMM_SPEC="${FB_FIBERHMM:-fiberhmm[consensus]>=3.0,<4}"
if [ -d "$FIBERHMM_SPEC" ]; then
  # A source folder: always reinstall it (its version may not have changed).
  pip_install -q --force-reinstall --no-deps "$FIBERHMM_SPEC"
  FIBERHMM_SPEC="$FIBERHMM_SPEC[consensus]"
fi
pip_install -q "$FIBERHMM_SPEC"
pip_install -q --force-reinstall --no-deps "${FB_FIBERBROWSER:-$ROOT}"
# The optional features the app ships with: primer design (primer3-py, seqfold),
# contact maps (cooler, h5py; s3fs for s3:// matrices) and UMAP embeddings
# (umap-learn). The Copilot is left out of the app (it starts its server with
# --no-copilot); it remains available in the pip install. A current s3fs, as the
# Windows image pins it: left free, pip settles a new boto3 by taking s3fs 0.4 (2020).
pip_install -q "${FB_FIBERBROWSER:-$ROOT}[primers,contact-maps,s3,umap]" "s3fs>=2024.1" "pywebview>=5.0" "pyinstaller>=6.10"
# The installed FiberBrowser must be of the flavour asked for (FB_FIBERBROWSER may name another tree or wheel).
# (-I, from the venv: the installed package, never a checkout in the current directory or on PYTHONPATH.)
BUILT_FLAVOR="$(cd "$VENV" && "$VENV/bin/python" -I -c 'from fiberbrowser._paths import build_flavor; print(build_flavor())')" \
  || die "could not read the installed FiberBrowser's flavour"
[ "$BUILT_FLAVOR" = "$FLAVOR" ] \
  || die "FB_FLAVOR=$FLAVOR, but the FiberBrowser installed from ${FB_FIBERBROWSER:-$ROOT} is a $BUILT_FLAVOR build"
# pyBigWig has no macOS arm64 wheel: pip builds it, and may reuse a wheel it
# built earlier against another libcurl. Rebuild it if it doesn't load.
if ! "$VENV/bin/python" -c "import pyBigWig" 2>/dev/null; then
  say "Rebuilding pyBigWig against the system libcurl"
  pip_install -q --no-cache-dir --force-reinstall --no-deps pyBigWig
fi
# pip picks the newest wheel for *this* Mac; swap any that need a newer macOS
# than the app's target for one that doesn't (e.g. orjson's macOS 15 wheel).
"$VENV/bin/python" - "$MACOS_TARGET" > "$BUILD/too_new.txt" <<'PY'
import re, sys
from importlib.metadata import distributions
target = tuple(int(x) for x in sys.argv[1].split("."))
for dist in distributions():
    tags = [l.split(":", 1)[1] for l in (dist.read_text("WHEEL") or "").splitlines() if l.startswith("Tag:")]
    mins = [(int(m[1]), int(m[2])) for t in tags for m in re.finditer(r"macosx_(\d+)_(\d+)_", t)]
    if mins and min(mins) > target:
        print(f"{dist.metadata['Name']}=={dist.version}")
PY
while read -r req; do
  [ -n "$req" ] || continue
  tmp="$BUILD/wheels-macos-$MACOS_TARGET"
  rm -rf "$tmp" && mkdir -p "$tmp"
  if env PATH="$VENV/bin:$CLEAN_PATH" "$VENV/bin/python" -m pip download -q --no-deps --only-binary=:all: \
       --platform "macosx_${MACOS_TARGET/./_}_arm64" -d "$tmp" "$req" >/dev/null 2>&1; then
    pip_install -q --force-reinstall --no-deps "$tmp"/*.whl
    echo "  $req: using the wheel for macOS $MACOS_TARGET"
  else
    echo "  warning: $req has no wheel for macOS $MACOS_TARGET; the app will need a newer macOS"
  fi
done < "$BUILD/too_new.txt"
"$VENV/bin/python" - <<'PY'
import fiberbrowser, fiberhmm, webview, PyInstaller, pyBigWig, pysam, numba
print(f"  FiberBrowser {fiberbrowser.__version__}, FiberHMM {fiberhmm.__version__}, numba {numba.__version__}, "
      f"pysam {pysam.__version__}, pywebview {webview.__version__ if hasattr(webview, '__version__') else '?'}, "
      f"PyInstaller {PyInstaller.__version__}")
PY
VERSION="$("$VENV/bin/python" -c 'import fiberbrowser; print(fiberbrowser.__version__)')"

# --- 2. minimap2 -----------------------------------------------------------------
MM2_DIR="$BUILD/minimap2-$MINIMAP2_VERSION"
if [ -n "${FB_MINIMAP2:-}" ]; then
  MINIMAP2="$FB_MINIMAP2"
  MM2_LICENSE="${FB_MINIMAP2_LICENSE:-}"
else
  MINIMAP2="$MM2_DIR/minimap2"
  MM2_LICENSE="$MM2_DIR/LICENSE.txt"
  if [ ! -x "$MINIMAP2" ]; then
    say "Building minimap2 $MINIMAP2_VERSION (arm64)"
    tarball="$BUILD/minimap2-$MINIMAP2_VERSION.tar.bz2"
    [ -f "$tarball" ] || curl -fsSL -o "$tarball" \
      "https://github.com/lh3/minimap2/releases/download/v$MINIMAP2_VERSION/minimap2-$MINIMAP2_VERSION.tar.bz2"
    echo "$MINIMAP2_SHA256  $tarball" | shasum -a 256 -c - >/dev/null || die "minimap2 download checksum mismatch"
    rm -rf "$MM2_DIR" && tar -xjf "$tarball" -C "$BUILD"
    (cd "$MM2_DIR" && env PATH="$CLEAN_PATH" MACOSX_DEPLOYMENT_TARGET=11.0 make -s -j4 arm_neon=1 aarch64=1 >/dev/null)
  fi
fi
"$MINIMAP2" --version >/dev/null || die "minimap2 at $MINIMAP2 doesn't run"

# --- 2b. BLAST+ (downloaded once, checksum-checked) -----------------------------------
BLAST_BIN="$BUILD/blast-$BLAST_VERSION"
if [ "${FB_BUNDLE_BLAST:-1}" != 0 ]; then
  say "BLAST+ $BLAST_VERSION (blastn, makeblastdb)"
  fetch_pinned "$BUILD/$BLAST_MACOS_TARBALL" "$BLAST_MACOS_SHA256" "$BLAST_URL/$BLAST_MACOS_TARBALL" "${FB_BLAST_TARBALL:-}" \
    || die "no BLAST+ $BLAST_VERSION tarball: set FB_BLAST_TARBALL to a local $BLAST_MACOS_TARBALL, or FB_BUNDLE_BLAST=0 to build without BLAST+"
  rm -rf "$BLAST_BIN" && mkdir -p "$BLAST_BIN"
  members=""
  for program in $BLAST_PROGRAMS; do members="$members ncbi-blast-$BLAST_VERSION+/bin/$program"; done
  # shellcheck disable=SC2086
  tar -xzf "$BUILD/$BLAST_MACOS_TARBALL" -C "$BLAST_BIN" --strip-components 1 ncbi-blast-$BLAST_VERSION+/LICENSE $members
  for program in $BLAST_PROGRAMS; do
    "$BLAST_BIN/bin/$program" -version >/dev/null || die "$program from $BLAST_MACOS_TARBALL doesn't run"
  done
fi
# The TE library (every build; downloaded once, checksum-checked).
TE_SRC="$BUILD/te-$TE_DMEL_ID"
say "D. melanogaster TE library ($TE_DMEL_ID)"
fetch_te_dmel "$TE_SRC" "${FB_TE_LIBRARY_DIR:-}" \
  || die "no TE library files: set FB_TE_LIBRARY_DIR to a folder with local copies (packaging/third_party.sh lists them)"

# --- 3. PyInstaller ----------------------------------------------------------------
say "Building FiberBrowser.app $VERSION ($FLAVOR build) with PyInstaller"
rm -rf "$DIST/FiberBrowser" "$APP"
(cd "$BUILD" && env PATH="$VENV/bin:$CLEAN_PATH" "$VENV/bin/pyinstaller" --noconfirm --log-level WARN \
    --distpath "$DIST" --workpath "$BUILD/work" "$HERE/FiberBrowser.spec")
[ -d "$APP" ] || die "PyInstaller made no app"
rm -rf "$DIST/FiberBrowser"  # the onedir copy; the app holds the same files

# --- 4. helper programs --------------------------------------------------------------
say "Adding minimap2, BLAST+ and the fiberhmm-* commands"
LICENSES="$APP/Contents/Resources/licenses"
mkdir -p "$APP/Contents/Helpers" "$APP/Contents/Resources/bin" "$LICENSES"
cp "$MINIMAP2" "$APP/Contents/Helpers/minimap2"
chmod 755 "$APP/Contents/Helpers/minimap2"
if [ -n "$MM2_LICENSE" ] && [ -f "$MM2_LICENSE" ]; then
  cp "$MM2_LICENSE" "$LICENSES/minimap2-LICENSE.txt"
fi
# blastn and makeblastdb next to minimap2 (fiberbrowser._paths.bundle_bin_dirs).
if [ "${FB_BUNDLE_BLAST:-1}" != 0 ]; then
  for program in $BLAST_PROGRAMS; do
    install -m 755 "$BLAST_BIN/bin/$program" "$APP/Contents/Helpers/$program"
  done
  cp "$BLAST_BIN/LICENSE" "$LICENSES/BLAST-LICENSE.txt"
  cp "$ROOT/packaging/third_party/blast/BLAST-THIRD-PARTY.txt" "$LICENSES/BLAST-THIRD-PARTY.txt"
fi
# The TE library's source files, read-only (services/te_library.py bundled_library_dir):
# Identify sets the library up from them under ~/.fiberhmm/te_libraries, no download.
say "Adding the TE library"
TE_DEST="$APP/Contents/Resources/te_libraries/$TE_DMEL_ID"
mkdir -p "$TE_DEST"
cp "$TE_SRC"/*.fa "$TE_SRC"/*.gff "$TE_DEST/"
cat "$ROOT/packaging/third_party/drosophila-transposons-NOTICE.txt" "$TE_SRC/LICENSE" > "$LICENSES/drosophila-transposons-LICENSE.txt"
cp "$LICENSES/drosophila-transposons-LICENSE.txt" "$TE_DEST/LICENSE.txt"
# The notices, without the export's section markers.
sed -E '/^# lab:(begin|end)$/d' "$ROOT/packaging/third_party/THIRD_PARTY_NOTICES.txt" > "$LICENSES/THIRD_PARTY_NOTICES.txt"
# The build: flavour (= update channel), version, build number, bundled FiberHMM (services/app_build.py). Its presence
# makes the app run its bundled FiberHMM by default, whatever ~/.fiberhmm/browser_settings.json says.
"$VENV/bin/python" "$ROOT/packaging/write_build_info.py" --out "$APP/Contents/Resources/fiberbrowser-build.json" \
  --flavor "$FLAVOR" --version "$VERSION" --platform "macos-$(uname -m)" \
  --fiberhmm-version "$("$VENV/bin/python" -c 'from importlib.metadata import version; print(version("fiberhmm"))')" \
  --commit "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)" --source-root "$ROOT" || die "could not write the build information"
"$VENV/bin/python" - "$APP/Contents/Resources/bin" <<'PY'
import os, sys
from importlib.metadata import distribution
bin_dir = sys.argv[1]
for dist_name in ("fiberhmm", "fiberbrowser"):
    for entry in distribution(dist_name).entry_points:
        if entry.group not in ("console_scripts", "gui_scripts") or entry.name.startswith("fiberbrowser"):
            continue
        path = os.path.join(bin_dir, entry.name)
        with open(path, "w") as handle:
            handle.write('#!/bin/sh\n# FiberHMM command inside FiberBrowser.app: runs the app binary as it.\n'
                         f'exec "$(cd "$(dirname "$0")/../../MacOS" && pwd)/FiberBrowser" --entry-point {entry.name} "$@"\n')
        os.chmod(path, 0o755)
print("  commands:", " ".join(sorted(os.listdir(bin_dir))))
PY

# --- 5. minimum macOS ----------------------------------------------------------------
minos="$("$VENV/bin/python" - "$APP" <<'PY'
import subprocess, sys
from pathlib import Path
best = (11, 0)
for path in Path(sys.argv[1]).rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    with open(path, "rb") as handle:
        magic = handle.read(4)
    if magic not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        continue
    out = subprocess.run(["otool", "-l", str(path)], capture_output=True, text=True).stdout.split()
    for i, word in enumerate(out):
        if word == "minos" and i + 1 < len(out):
            parts = tuple(int(p) for p in out[i + 1].split(".")[:2])
            best = max(best, parts)
print("%d.%d" % best)
PY
)"
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion $minos" "$APP/Contents/Info.plist"
echo "  LSMinimumSystemVersion: macOS $minos (the newest minimum among the bundled binaries)"
if [ "${FB_ALLOW_NEWER_MACOS:-0}" != 1 ] && [ "$(printf '%s\n%s\n' "$MACOS_TARGET" "$minos" | sort -V | tail -1)" != "$MACOS_TARGET" ]; then
  die "the app would need macOS $minos, newer than the target $MACOS_TARGET (see $BUILD/too_new.txt; set FB_ALLOW_NEWER_MACOS=1 to accept)"
fi

# --- 6. sign ---------------------------------------------------------------------------
KEYCHAIN_ARGS=()
[ -n "${FB_KEYCHAIN:-}" ] && KEYCHAIN_ARGS=(--keychain "$FB_KEYCHAIN")
IDENTITY="${FB_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning ${FB_KEYCHAIN:+"$FB_KEYCHAIN"} 2>/dev/null \
              | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "-" ]; then
  IDENTITY="-"
  SIGN_KIND="ad-hoc (no Developer ID Application certificate in the keychain)"
  # No hardened runtime for ad-hoc: its library validation needs a Team ID,
  # which ad-hoc signatures don't have (every bundled library would be
  # refused). The runtime only matters for notarization anyway.
  # check_entitlements.sh tests the runtime + entitlements on an ad-hoc copy.
  SIGN_OPTS=(--timestamp=none)
else
  SIGN_KIND="Developer ID: $IDENTITY (hardened runtime)"
  SIGN_OPTS=(--options runtime --timestamp)
fi
say "Signing with $SIGN_KIND"
# entitlements.plist (no comments: codesign's parser rejects them): allow-jit and
# allow-unsigned-executable-memory, for numba's LLVM JIT and libffi closures.
sign() {
  codesign --force "${SIGN_OPTS[@]}" --sign "$IDENTITY" ${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"} "$@" 2>&1 \
    | { grep -v "replacing existing signature" || true; }
  return "${PIPESTATUS[0]}"
}
# Inside out: every Mach-O (deepest first; executables get the entitlements),
# then framework bundles, then the app. Apple advises against `codesign --deep`
# for signing (it doesn't apply entitlements per executable); it is used below
# only to verify.
"$VENV/bin/python" - "$APP" > "$BUILD/macho.txt" <<'PY'
import os, stat, sys
from pathlib import Path
app = Path(sys.argv[1])
main = app / "Contents" / "MacOS" / "FiberBrowser"
rows = []
for path in app.rglob("*"):
    if path.is_symlink() or not path.is_file() or path == main:
        continue
    with open(path, "rb") as handle:
        head = handle.read(16)
    if head[:4] not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        continue
    filetype = int.from_bytes(head[12:16], "little") if head[:4] == b"\xcf\xfa\xed\xfe" else 0
    kind = "exe" if filetype == 2 else "lib"  # MH_EXECUTE
    rows.append((len(path.parts), kind, str(path)))
for depth, kind, path in sorted(rows, reverse=True):
    print(f"{kind}\t{path}")
PY
count=0
while IFS=$'\t' read -r kind path; do
  if [ "$kind" = "exe" ]; then sign --entitlements "$ENTITLEMENTS" "$path"; else sign "$path"; fi
  count=$((count + 1))
done < "$BUILD/macho.txt"
find "$APP/Contents" -type d -name "*.framework" -depth | while read -r framework; do sign "$framework"; done
sign --entitlements "$ENTITLEMENTS" "$APP"
echo "  signed $count nested binaries and the app"
codesign --verify --deep --strict --verbose=1 "$APP" 2>&1 | tail -2

# --- 7. notarize the app ---------------------------------------------------------------
NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
# The profile is looked up in FB_NOTARY_KEYCHAIN, else in the signing keychain
# (FB_KEYCHAIN) when it holds the profile, else in the login keychain.
if [ -z "${FB_NOTARY_KEYCHAIN:-}" ] && [ -n "${FB_KEYCHAIN:-}" ] \
   && xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --keychain "$FB_KEYCHAIN" >/dev/null 2>&1; then
  FB_NOTARY_KEYCHAIN="$FB_KEYCHAIN"
fi
[ -n "${FB_NOTARY_KEYCHAIN:-}" ] && NOTARY_ARGS+=(--keychain "$FB_NOTARY_KEYCHAIN")
NOTARIZE="${FB_NOTARIZE:-auto}"
if [ "$NOTARIZE" = "auto" ]; then
  NOTARIZE=0
  if [ "$IDENTITY" != "-" ] && xcrun notarytool history "${NOTARY_ARGS[@]}" >/dev/null 2>&1; then NOTARIZE=1; fi
fi
[ "$NOTARIZE" = "1" ] && [ "$IDENTITY" = "-" ] && die "can't notarize an ad-hoc signed app"
notarize() {  # file to submit
  xcrun notarytool submit "$1" "${NOTARY_ARGS[@]}" --wait --timeout 2h | tee "$BUILD/notary.log" || true
  # A dropped connection while waiting doesn't stop Apple's processing: keep
  # waiting on the same submission (up to ~30 retries, a minute apart).
  local id tries=0
  id="$(sed -n 's/^ *id: //p' "$BUILD/notary.log" | head -1)"
  while [ -n "$id" ] && ! grep -q -E "status: (Accepted|Invalid|Rejected)" "$BUILD/notary.log" && [ $tries -lt 30 ]; do
    tries=$((tries + 1)); echo "  (waiting on submission $id again, attempt $tries)"; sleep 60
    xcrun notarytool wait "$id" "${NOTARY_ARGS[@]}" --timeout 2h | tee "$BUILD/notary.log" || true
  done
  grep -q "status: Accepted" "$BUILD/notary.log" || {
    [ -n "$id" ] || id="$(sed -n 's/^ *id: //p' "$BUILD/notary.log" | head -1)"
    [ -n "$id" ] && xcrun notarytool log "$id" "${NOTARY_ARGS[@]}" || true
    die "notarization of $(basename "$1") was not accepted"
  }
}
if [ "$NOTARIZE" = "1" ]; then
  say "Notarizing the app (profile $NOTARY_PROFILE)"
  ditto -c -k --keepParent "$APP" "$BUILD/FiberBrowser-notarize.zip"
  notarize "$BUILD/FiberBrowser-notarize.zip"
  xcrun stapler staple "$APP"
  rm -f "$BUILD/FiberBrowser-notarize.zip"
else
  echo "  (not notarized: $( [ "$IDENTITY" = "-" ] && echo "ad-hoc signature" || echo "no notarytool profile '$NOTARY_PROFILE'"))"
fi

# --- 8. DMG ------------------------------------------------------------------------------
DMG="$DIST/FiberBrowser-$VERSION-arm64.dmg"
if [ "${FB_SKIP_DMG:-0}" != "1" ]; then
  say "Making $(basename "$DMG")"
  staging="$BUILD/dmg"
  rm -rf "$staging" "$DMG" && mkdir -p "$staging"
  ditto "$APP" "$staging/FiberBrowser.app"
  ln -s /Applications "$staging/Applications"
  hdiutil create -quiet -volname "FiberBrowser $VERSION" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$DMG"
  rm -rf "$staging"
  if [ "$IDENTITY" != "-" ]; then
    codesign --force --timestamp --sign "$IDENTITY" ${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"} "$DMG"
  fi
  if [ "$NOTARIZE" = "1" ]; then
    say "Notarizing the DMG"
    notarize "$DMG"
    xcrun stapler staple "$DMG"
  fi
fi

# --- summary -----------------------------------------------------------------------------
say "Done"
echo "  app:     $APP ($(du -sh "$APP" | cut -f1))"
[ -f "$DMG" ] && echo "  dmg:     $DMG ($(du -h "$DMG" | cut -f1))"
echo "  signed:  $SIGN_KIND"
echo "  notarized: $( [ "$NOTARIZE" = "1" ] && echo yes || echo no)"
echo "  update manifest: python3 tools/make_update_manifest.py --channel $FLAVOR --version $VERSION --out $DIST/fiberbrowser-update-$FLAVOR.json $( [ -f "$DMG" ] && echo "$DMG")"
if [ "$IDENTITY" != "-" ]; then
  spctl -a -vv "$APP" 2>&1 | sed 's/^/  spctl: /' || true
fi
