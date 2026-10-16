#!/usr/bin/env python3
"""Render the FiberBrowser and FiberHMM icons from their SVG sources.

    python packaging/icons/build_icons.py        (needs rsvg-convert; iconutil on macOS)

Sources (this folder):
  fiberbrowser.svg / fiberhmm.svg              1024 px, Apple icon grid (824 px tile): .icns
  fiberbrowser-small.svg / fiberhmm-small.svg  32 px grid, full-bleed tile: favicons, 24-512 px
  fiberbrowser-16.svg / fiberhmm-16.svg        16 px grid, pixel-aligned: the 16 px sizes

Outputs (committed, so pip installs and CI need no SVG renderer):
  fiberbrowser/icons/                     PNGs 16-512, fiberbrowser.ico, fiberbrowser.svg (Linux menu,
                                          Windows shortcut, app window icon)
  browser/frontend/public/assets/icons/   favicon.svg/.ico, PWA icons (any + maskable),
                                          apple-touch-icon (Vite copies them into dist/assets/icons)
  packaging/macos/FiberBrowser.icns, packaging/macos/FiberHMM.icns
  packaging/icons/png/                    every size of both icons (for the future FiberHMM app)
"""
from __future__ import annotations

import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PACKAGE_ICONS = ROOT / "fiberbrowser" / "icons"
WEB_ICONS = ROOT / "browser" / "frontend" / "public" / "assets" / "icons"
MACOS = ROOT / "packaging" / "macos"
PNG_DIR = HERE / "png"
NAMES = ("fiberbrowser", "fiberhmm")
PNG_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICONSET = {  # iconutil's required names -> pixel size
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32, "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256, "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512, "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}


def render(svg: Path, size: int, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg), "-o", str(out)], check=True)
    return out


def source_for(name: str, size: int, style: str) -> Path:
    """style 'app' = Apple grid (macOS), 'flat' = full-bleed tile (everything else)."""
    if size <= 16:
        return HERE / f"{name}-16.svg"
    if style == "app" and size >= 128:
        return HERE / f"{name}.svg"
    return HERE / f"{name}-small.svg"


def maskable_svg(name: str) -> str:
    """The app icon with its tile widened to a full-bleed square (content stays in the safe zone)."""
    text = (HERE / f"{name}.svg").read_text()
    # Every tile-shaped layer (clip path, fill, sheen, ...) becomes the full square; a rim
    # highlight drawn just inside the tile edge has no place on a full-bleed icon.
    text = re.sub(r'<rect x="100" y="100" width="824" height="824" rx="184"',
                  '<rect x="0" y="0" width="1024" height="1024"', text)
    return re.sub(r'<rect [^>]*stroke="url\(#rim\)"[^>]*/>', "", text)


def write_ico(pngs: list[Path], out: Path) -> None:
    """A Windows .ico holding PNG-compressed images (Vista and later)."""
    blobs = [p.read_bytes() for p in pngs]
    sizes = [struct.unpack(">II", b[16:24]) for b in blobs]
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for (w, h), blob in zip(sizes, blobs):
        entries += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    out.write_bytes(header + entries + b"".join(blobs))


def build_icns(name: str, out: Path) -> None:
    if not shutil.which("iconutil"):
        print(f"  skip {out.name}: iconutil (macOS) not found")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / f"{name}.iconset"
        for filename, size in ICONSET.items():
            render(source_for(name, size, "app"), size, iconset / filename)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)


def main() -> int:
    if not shutil.which("rsvg-convert"):
        sys.exit("rsvg-convert is needed (brew install librsvg / apt install librsvg2-bin)")
    for name in NAMES:
        for size in PNG_SIZES:
            render(source_for(name, size, "flat"), size, PNG_DIR / f"{name}-{size}.png")
        render(source_for(name, 1024, "app"), 1024, PNG_DIR / f"{name}-app-1024.png")
        write_ico([PNG_DIR / f"{name}-{s}.png" for s in ICO_SIZES], PNG_DIR / f"{name}.ico")
        build_icns(name, MACOS / f"{'FiberBrowser' if name == 'fiberbrowser' else 'FiberHMM'}.icns")

    PACKAGE_ICONS.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128, 256, 512):
        shutil.copyfile(PNG_DIR / f"fiberbrowser-{size}.png", PACKAGE_ICONS / f"fiberbrowser-{size}.png")
    shutil.copyfile(PNG_DIR / "fiberbrowser.ico", PACKAGE_ICONS / "fiberbrowser.ico")
    shutil.copyfile(HERE / "fiberbrowser-small.svg", PACKAGE_ICONS / "fiberbrowser.svg")

    WEB_ICONS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE / "fiberbrowser-small.svg", WEB_ICONS / "favicon.svg")
    write_ico([PNG_DIR / f"fiberbrowser-{s}.png" for s in (16, 32, 48)], WEB_ICONS / "favicon.ico")
    for size in (192, 512):
        render(HERE / "fiberbrowser-small.svg", size, WEB_ICONS / f"icon-{size}.png")
    with tempfile.TemporaryDirectory() as tmp:
        masked = Path(tmp) / "maskable.svg"
        masked.write_text(maskable_svg("fiberbrowser"))
        render(masked, 512, WEB_ICONS / "icon-maskable-512.png")
        render(masked, 180, WEB_ICONS / "apple-touch-icon.png")
    print("icons written:", PACKAGE_ICONS, WEB_ICONS, MACOS, PNG_DIR, sep="\n  ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
