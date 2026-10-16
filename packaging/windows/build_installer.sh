#!/usr/bin/env bash
# Build the Windows installer and the portable package around a WSL root
# filesystem made by build_wsl_distro.sh:
#
#   bash packaging/windows/build_installer.sh [FiberBrowser-<version>-wsl-amd64.tar.gz]
#
# Outputs (in FB_BUILD_DIR, default <repo>/build/windows):
#   FiberBrowser-<version>-Setup.exe             NSIS installer (per-user, no admin)
#   FiberBrowser-<version>-windows-portable.zip  Install.cmd + the same files
#   SHA256SUMS
# Needs makensis (NSIS 3; macOS: brew install makensis) and zip. Runs on macOS
# or Linux; nothing here is signed (see docs/install.md: SmartScreen).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="${FB_BUILD_DIR:-$ROOT/build/windows}"
ROOTFS="${1:-$(ls -t "$BUILD"/FiberBrowser-*-wsl-amd64.tar.gz 2>/dev/null | head -1)}"

die() { printf '\nbuild_installer.sh: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
command -v makensis >/dev/null || die "needs makensis (brew install makensis / apt install nsis)"
command -v zip >/dev/null || die "needs zip"
[ -f "$ROOTFS" ] || die "no rootfs tarball (run build_wsl_distro.sh first, or pass its path)"
# Absolute paths from here on: makensis runs from the .nsi folder and the zip
# step from a staging folder, so a relative tarball or build path would break.
ROOTFS="$(cd "$(dirname "$ROOTFS")" && pwd)/$(basename "$ROOTFS")"
mkdir -p "$BUILD" && BUILD="$(cd "$BUILD" && pwd)"
VERSION="$(basename "$ROOTFS" | sed -n 's/^FiberBrowser-\(.*\)-wsl-amd64\.tar\.gz$/\1/p')"
[ -n "$VERSION" ] || die "can't read the version from $(basename "$ROOTFS")"
# NSIS wants a numeric X.Y.Z(.W) version for the file properties.
NUMERIC="$(printf '%s' "$VERSION" | sed 's/[^0-9.].*//')"

crlf() { sed 's/$/\r/' "$1" > "$2"; }   # Windows line endings (cmd.exe needs them in .cmd)

# --- the app folder: launcher, setup scripts, icon ----------------------------------------
APP="$BUILD/app"
say "Staging the app files ($VERSION)"
rm -rf "$APP" && mkdir -p "$APP"
for f in "$HERE"/app/*.ps1; do
  LC_ALL=C grep -q '[^[:print:][:space:]]' "$f" && die "$(basename "$f") has non-ASCII characters (Windows PowerShell 5.1 reads it as ANSI)"
  crlf "$f" "$APP/$(basename "$f")"
done
cp "$ROOT/fiberbrowser/icons/fiberbrowser.ico" "$APP/FiberBrowser.ico"
crlf "$HERE/portable/Uninstall.cmd" "$APP/Uninstall.cmd"
crlf "$ROOT/LICENSE" "$APP/LICENSE.txt"
makensis -V2 -DOUTFILE="$APP/FiberBrowser.exe" -DICON="$APP/FiberBrowser.ico" -DVERSION="$NUMERIC" \
  "$HERE/launcher.nsi" || die "makensis failed on launcher.nsi"

# --- Setup.exe ------------------------------------------------------------------------------
SETUP="$BUILD/FiberBrowser-$VERSION-Setup.exe"
say "Compiling $(basename "$SETUP")"
makensis -V2 -DVERSION="$NUMERIC" -DROOTFS="$ROOTFS" -DAPPDIR="$APP" -DLICENSE="$APP/LICENSE.txt" \
  -DOUTFILE="$SETUP" "$HERE/installer.nsi" || die "makensis failed on installer.nsi"

# --- the portable zip ------------------------------------------------------------------------
NAME="FiberBrowser-$VERSION-windows-portable"
ZIP="$BUILD/$NAME.zip"
say "Making $(basename "$ZIP")"
STAGE="$BUILD/portable/$NAME"
rm -rf "$BUILD/portable" "$ZIP" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/app"
sed "s/@VERSION@/$VERSION/g" "$HERE/portable/Install.cmd" > "$STAGE/Install.cmd.lf" && crlf "$STAGE/Install.cmd.lf" "$STAGE/Install.cmd" && rm "$STAGE/Install.cmd.lf"
sed "s/@VERSION@/$VERSION/g" "$HERE/portable/README.txt" > "$STAGE/README.lf" && crlf "$STAGE/README.lf" "$STAGE/README.txt" && rm "$STAGE/README.lf"
cp "$ROOTFS" "$STAGE/"
# The tarball is already compressed: stored as is (-n), the rest deflated.
(cd "$BUILD/portable" && zip -q -r -X -n .gz "$ZIP" "$NAME")
rm -rf "$BUILD/portable"

# One line per file, named by its base name (the files are published side by
# side), wherever the tarball lives: it need not be in FB_BUILD_DIR.
sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }
SUMS=""
for f in "$SETUP" "$ZIP" "$ROOTFS"; do
  h="$(sha256 "$f")" && [ -n "$h" ] || die "can't checksum $f"
  SUMS+="$h  $(basename "$f")"$'\n'
done
printf '%s' "$SUMS" > "$BUILD/SHA256SUMS"
say "Done"
echo "  setup:    $SETUP ($(du -h "$SETUP" | cut -f1))"
echo "  portable: $ZIP ($(du -h "$ZIP" | cut -f1))"
echo "  sums:     $BUILD/SHA256SUMS"
echo "  (unsigned: Windows SmartScreen shows 'Windows protected your PC' > More info > Run anyway)"
