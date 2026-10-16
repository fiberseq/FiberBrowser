#!/usr/bin/env bash
# Build FiberBrowser's WSL distribution: a linux/amd64 root filesystem tarball
# (FiberBrowser-<version>-wsl-amd64.tar.gz) that the Windows installer imports
# with `wsl --import FiberBrowser <dir> <tarball>`.
#
#   bash packaging/windows/build_wsl_distro.sh
#
# Steps: wheels (FiberBrowser from this checkout's committed HEAD, FiberHMM) ->
# docker buildx --platform linux/amd64 (Dockerfile: Python 3.12 slim, the wheels
# with the Mac app's extras, minimap2, Debian's BLAST+ (blastn, makeblastdb), the
# fiberbrowser user and /etc/wsl.conf; the D. melanogaster TE library, Identify's)
# -> docker export of a container -> gzip (without Docker's /.dockerenv marker).
# Runs on any Docker host (on Apple silicon, amd64 runs emulated: slower).
#
# Settings (environment variables):
#   FB_BUILD_DIR      work and output folder (default: <repo>/build/windows)
#   FB_FIBERBROWSER   a FiberBrowser wheel, or a git checkout whose committed HEAD is built
#                     (git archive: untracked files never reach the wheel; default: this checkout)
#   FB_FIBERHMM       a FiberHMM wheel, or a git checkout (built from a fresh clone of its HEAD,
#                     so the wheel records the commit), or a pip requirement
#                     (default: fiberhmm[consensus]>=3.0,<4 from PyPI)
#   FB_PYTHON         Python with `build` for the wheels (default: python3)
#   FB_PYTHON_IMAGE   base image (default: python:3.12-slim-bookworm)
#   FB_GZIP_LEVEL     1-9 (default 9)
#   FB_BUILD_NUMBER, FB_UPDATE_URL, FB_UPDATE_REPO
#                     the build written into the distribution (/opt/fiberbrowser/share/fiberbrowser/build.json,
#                     packaging/write_build_info.py), as build_app.sh does for the Mac app
#   FB_FLAVOR         public (default); legacy lab is an alias for the same complete release
#   FB_TE_LIBRARY_DIR a folder with local copies of the TE library files (packaging/third_party.sh)
set -euo pipefail

MINIMAP2_VERSION=2.31
MINIMAP2_SHA256=c1351de6319c123369c2f4f37ba0ccf18c7ace47e2b1c0a35e30056b4a3bd9c9
PLATFORM=linux/amd64

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Pinned third-party files: versions, checksums, fetch helpers.
. "$HERE/../third_party.sh"
BUILD="${FB_BUILD_DIR:-$ROOT/build/windows}"
# Every release includes every analysis. Older build wrappers may still pass lab.
case "${FB_FLAVOR:-public}" in
  public|lab) FLAVOR=public ;;
  *) echo "FiberBrowser has one release build; FB_FLAVOR must be public (legacy lab is an alias)" >&2; exit 1 ;;
esac
PY="${FB_PYTHON:-python3}"
IMAGE_BASE="${FB_PYTHON_IMAGE:-python:3.12-slim-bookworm}"
CTX="$BUILD/context"
WHEELS="$CTX/wheels"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nbuild_wsl_distro.sh: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "needs Docker (Docker Desktop, or docker + buildx)"
docker info >/dev/null 2>&1 || die "the Docker daemon isn't running"
"$PY" -c "import build" 2>/dev/null || die "$PY has no 'build' module (pip install build)"
mkdir -p "$BUILD"
rm -rf "$CTX" && mkdir -p "$WHEELS"

# --- 1. wheels -----------------------------------------------------------------------
wheel_from_checkout() {  # git checkout, label -> builds its committed HEAD into $WHEELS
  local src="$1" label="$2" tmp
  tmp="$BUILD/src-$label"
  rm -rf "$tmp"
  git -C "$src" rev-parse HEAD >/dev/null 2>&1 || die "$src is not a git checkout"
  echo "  $label: $(git -C "$src" log --oneline -1)"
  [ -z "$(git -C "$src" status --porcelain --untracked-files=no)" ] \
    || echo "  ($label has uncommitted changes; they are NOT built: only the committed HEAD is)"
  if [ "$label" = fiberhmm ]; then
    # A clone (not an archive): FiberHMM's build records its git commit.
    git clone -q --no-hardlinks "$src" "$tmp"
    git -C "$tmp" checkout -q "$(git -C "$src" rev-parse HEAD)"
  else
    mkdir -p "$tmp" && git -C "$src" archive HEAD | tar -x -C "$tmp"
  fi
  (cd "$tmp" && "$PY" -m build --wheel --outdir "$WHEELS" . >"$BUILD/wheel-$label.log" 2>&1) \
    || { tail -20 "$BUILD/wheel-$label.log"; die "building the $label wheel failed"; }
  rm -rf "$tmp"
}

say "Wheels"
FB_SRC="${FB_FIBERBROWSER:-$ROOT}"
if [ -f "$FB_SRC" ]; then cp "$FB_SRC" "$WHEELS/"; else wheel_from_checkout "$FB_SRC" fiberbrowser; fi
FH="${FB_FIBERHMM:-fiberhmm[consensus]>=3.0,<4}"
if [ -f "$FH" ]; then
  cp "$FH" "$WHEELS/"
elif [ -d "$FH" ]; then
  wheel_from_checkout "$FH" fiberhmm
else
  "$PY" -m pip download -q --no-deps --only-binary=:all: -d "$WHEELS" "$FH" || die "could not download $FH"
fi
ls "$WHEELS"/fiberbrowser-*.whl "$WHEELS"/fiberhmm-*.whl >/dev/null 2>&1 || die "missing a wheel in $WHEELS"
# The wheel must be of the flavour asked for (FB_FIBERBROWSER may name another tree or wheel): its plugin packs'
# manifests (fiberbrowser/browser/<pack>/fiberbrowser-pack.json) name it; the complete release is public.
BUILT_FLAVOR="$("$PY" - "$WHEELS"/fiberbrowser-*.whl <<'PY'
import json, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as wheel:
    names = sorted(n for n in wheel.namelist() if re.fullmatch(r"fiberbrowser/browser/[^/]+/fiberbrowser-pack\.json", n))
    flavors = [json.loads(wheel.read(n)).get("flavor") or n.split("/")[2] for n in names]
print(flavors[0] if flavors else "public")
PY
)" || die "could not read the FiberBrowser wheel's flavour"
[ "$BUILT_FLAVOR" = "$FLAVOR" ] || die "FB_FLAVOR=$FLAVOR, but the FiberBrowser wheel from $FB_SRC is a $BUILT_FLAVOR build"
VERSION="$(basename "$WHEELS"/fiberbrowser-*.whl | cut -d- -f2)"
FIBERHMM_VERSION="$(basename "$WHEELS"/fiberhmm-*.whl | cut -d- -f2)"
echo "  $(cd "$WHEELS" && ls)"

# --- 2. image --------------------------------------------------------------------------
tarball="$BUILD/minimap2-$MINIMAP2_VERSION.tar.bz2"
[ -f "$tarball" ] || curl -fsSL -o "$tarball" \
  "https://github.com/lh3/minimap2/releases/download/v$MINIMAP2_VERSION/minimap2-$MINIMAP2_VERSION.tar.bz2"
echo "$MINIMAP2_SHA256  $tarball" | shasum -a 256 -c - >/dev/null || die "minimap2 download checksum mismatch"
cp "$tarball" "$CTX/"
# BLAST+ is Debian's ncbi-blast+ package (Dockerfile): its copyright files come with it.
mkdir -p "$CTX/licenses"
fetch_te_dmel "$BUILD/te-$TE_DMEL_ID" "${FB_TE_LIBRARY_DIR:-}" \
  || die "no TE library files: set FB_TE_LIBRARY_DIR to a folder with local copies (packaging/third_party.sh lists them)"
mkdir -p "$CTX/te_libraries/$TE_DMEL_ID" "$CTX/licenses/drosophila-transposons"
cp "$BUILD/te-$TE_DMEL_ID"/*.fa "$BUILD/te-$TE_DMEL_ID"/*.gff "$CTX/te_libraries/$TE_DMEL_ID/"
cat "$ROOT/packaging/third_party/drosophila-transposons-NOTICE.txt" "$BUILD/te-$TE_DMEL_ID/LICENSE" \
  > "$CTX/licenses/drosophila-transposons/LICENSE"
cp "$CTX/licenses/drosophila-transposons/LICENSE" "$CTX/te_libraries/$TE_DMEL_ID/LICENSE.txt"
# The notices, without the export's section markers.
sed -E '/^# lab:(begin|end)$/d' "$ROOT/packaging/third_party/THIRD_PARTY_NOTICES.txt" > "$CTX/licenses/THIRD_PARTY_NOTICES.txt"
cp -R "$HERE/rootfs" "$CTX/rootfs"
# The build: flavour (= update channel), version, build number, bundled FiberHMM (services/app_build.py). Its presence
# makes the distribution run its bundled FiberHMM by default (the Dockerfile puts it in /opt/fiberbrowser/share).
FB_COMMIT=""
# The packaged tree's own provenance (its packaging/source.json, its commit time): the build number it shares with
# the Mac build of the same commit.
SRC_ROOT_ARG=()
[ -d "$FB_SRC" ] && SRC_ROOT_ARG=(--source-root "$FB_SRC")
[ -f "$FB_SRC" ] || FB_COMMIT="$(git -C "$FB_SRC" rev-parse --short HEAD 2>/dev/null || true)"
"$PY" "$ROOT/packaging/write_build_info.py" --out "$CTX/build.json" --flavor "$FLAVOR" --version "$VERSION" \
  --platform windows-x64 --fiberhmm-version "$FIBERHMM_VERSION" --commit "$FB_COMMIT" \
  ${SRC_ROOT_ARG[@]+"${SRC_ROOT_ARG[@]}"} \
  || die "could not write the build information"
# The smoke test, for the owner of a Windows PC: wsl -d FiberBrowser -- fiberbrowser-check-distro
cp "$HERE/check_distro.sh" "$CTX/rootfs/usr/local/bin/fiberbrowser-check-distro"
chmod 755 "$CTX/rootfs/usr/local/bin/"*
cp "$HERE/Dockerfile" "$CTX/Dockerfile"

TAG="fiberbrowser-wsl:$VERSION"
say "Building $TAG ($PLATFORM, from $IMAGE_BASE)"
docker buildx build --platform "$PLATFORM" --load --progress plain \
  --build-arg PYTHON_IMAGE="$IMAGE_BASE" \
  --build-arg MINIMAP2_VERSION="$MINIMAP2_VERSION" --build-arg MINIMAP2_SHA256="$MINIMAP2_SHA256" \
  -t "$TAG" "$CTX" >"$BUILD/docker-build.log" 2>&1 \
  || { tail -40 "$BUILD/docker-build.log"; die "docker build failed (log: $BUILD/docker-build.log)"; }
grep -E "^#[0-9]+ .*FiberBrowser [0-9]" "$BUILD/docker-build.log" | tail -1 | sed 's/^#[0-9]* [0-9.]* /  /' || true

# --- 3. root filesystem tarball ----------------------------------------------------------
OUT="$BUILD/FiberBrowser-$VERSION-wsl-amd64.tar.gz"
say "Exporting $(basename "$OUT")"
cid="$(docker create --platform "$PLATFORM" "$TAG" /bin/true)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
rm -f "$OUT"
# bsdtar copies the exported entries as they are (owners, modes, links), minus
# Docker's marker file; GNU tar can't, so it is filtered with Python there.
if tar --version 2>/dev/null | grep -q bsdtar; then
  docker export "$cid" | tar -c -z --options "gzip:compression-level=${FB_GZIP_LEVEL:-9}" \
    --exclude '.dockerenv' -f "$OUT" @-
else
  docker export "$cid" | "$PY" -c '
import sys, tarfile
src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
dst = tarfile.open(sys.argv[1], mode="w:gz", compresslevel=int(sys.argv[2]), format=tarfile.PAX_FORMAT)
for member in src:
    if member.name.lstrip("./") == ".dockerenv":
        continue
    dst.addfile(member, src.extractfile(member) if member.isreg() else None)
dst.close()' "$OUT" "${FB_GZIP_LEVEL:-9}"
fi
docker rm -f "$cid" >/dev/null; trap - EXIT
(cd "$BUILD" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")

say "Done"
echo "  rootfs:  $OUT ($(du -h "$OUT" | cut -f1), sha256 $(cut -c1-16 "$OUT.sha256")...)"
echo "  image:   $TAG ($(docker image inspect "$TAG" --format '{{.Size}}' | awk '{printf "%.0f MB uncompressed", $1/1e6}'))"
echo "  check:   bash packaging/windows/check_distro.sh \"$OUT\""
