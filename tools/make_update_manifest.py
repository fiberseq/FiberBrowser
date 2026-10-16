#!/usr/bin/env python3
"""Make a channel's update manifest from built files (what the app's update check reads; docs/updates.md).

    python3 tools/make_update_manifest.py --channel public --version 3.0.1 \
        --build-info build/macos/dist/FiberBrowser.app/Contents/Resources/fiberbrowser-build.json \
        --notes "Faster Find classes." --notes-url https://github.com/fiberseq/FiberBrowser/releases/tag/v3.0.1 \
        --out build/fiberbrowser-update-public.json \
        build/macos/dist/FiberBrowser-3.0.1-arm64.dmg build/macos/dist/FiberBrowser-3.0.1-arm64.zip \
        build/windows/FiberBrowser-3.0.1-Setup.exe

Each file is listed under its platform with its sha256 and size; the platform and kind come from the name
(``*-arm64.dmg``: macos-arm64 dmg, ``*-arm64.zip``: macos-arm64 zip, ``*Setup*.exe``: windows-x64 installer), or
``PLATFORM:KIND=PATH`` says them. Files are named, not linked: the app finds them among the release's assets
(GitHub) or next to the manifest (a shared folder, a Dropbox folder). ``--base-url`` gives https links instead
(a web server). Publish the manifest together with the files (tools/publish_release.py for GitHub).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

SCHEMA = "fiberbrowser.update.v1"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$")
RULES = (
    (re.compile(r"-(arm64|aarch64)\.dmg$", re.I), "macos-arm64", "dmg"),
    (re.compile(r"-(arm64|aarch64)\.zip$", re.I), "macos-arm64", "zip"),
    (re.compile(r"-x86_64\.dmg$", re.I), "macos-x86_64", "dmg"),
    (re.compile(r"-x86_64\.zip$", re.I), "macos-x86_64", "zip"),
    (re.compile(r"(setup|installer).*\.exe$", re.I), "windows-x64", "installer"),
    (re.compile(r"-windows.*\.zip$", re.I), "windows-x64", "zip"),
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def classify(spec: str) -> tuple[str, str, Path]:
    """(platform, kind, path) of a file argument: PATH, or PLATFORM:KIND=PATH."""
    match = re.match(r"^([a-z0-9_-]+):([a-z0-9_-]+)=(.+)$", spec)
    if match:
        return match.group(1), match.group(2), Path(match.group(3))
    path = Path(spec)
    for pattern, platform, kind in RULES:
        if pattern.search(path.name):
            return platform, kind, path
    raise SystemExit(f"make_update_manifest: can't tell the platform of {path.name}; write it as PLATFORM:KIND={spec}")


def make_manifest(channel: str, version: str, files: list[str], *, build: str = "", notes: str = "",
                  notes_url: str = "", minimum_macos: str = "", base_url: str = "", released: str = "") -> dict:
    if not re.fullmatch(r"\d+(\.\d+)*([A-Za-z0-9.+-]*)", version):
        raise SystemExit(f"make_update_manifest: {version!r} isn't a version")
    if notes_url and not notes_url.startswith("https://"):
        raise SystemExit("make_update_manifest: --notes-url must be https://")
    if base_url and not base_url.startswith("https://"):
        raise SystemExit("make_update_manifest: --base-url must be https://")
    downloads: dict[str, list] = {}
    for spec in files:
        platform, kind, path = classify(spec)
        if not path.is_file():
            raise SystemExit(f"make_update_manifest: no file {path}")
        if not NAME.match(path.name):
            raise SystemExit(f"make_update_manifest: rename {path.name} (letters, digits, . _ + - only)")
        entry = {"kind": kind, "name": path.name, "sha256": sha256_of(path), "size": path.stat().st_size}
        if base_url:
            entry["url"] = base_url.rstrip("/") + "/" + path.name
        downloads.setdefault(platform, []).append(entry)
    if not downloads:
        raise SystemExit("make_update_manifest: no files")
    manifest = {"schema": SCHEMA, "channel": channel, "version": version, "build": build,
                "released": released or time.strftime("%Y-%m-%d"), "notes": notes, "notes_url": notes_url,
                "downloads": downloads}
    if minimum_macos and any(p.startswith("macos") for p in downloads):
        manifest["minimum_macos"] = minimum_macos
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="+", help="built files: PATH or PLATFORM:KIND=PATH")
    parser.add_argument("--channel", required=True, help="the build's flavour: public, or a plugin pack's")
    parser.add_argument("--version", help="the version (default: --build-info's)")
    parser.add_argument("--build", default="", help="the build number (default: --build-info's)")
    parser.add_argument("--build-info", action="append", default=[],
                        help="a build's fiberbrowser-build.json (version, build); give the Mac app's and the WSL "
                             "distribution's: they must be the same version and build")
    parser.add_argument("--notes", default="", help="short release notes (plain text)")
    parser.add_argument("--notes-file", help="release notes from a file (plain text)")
    parser.add_argument("--notes-url", default="", help="https:// page with the full release notes")
    parser.add_argument("--minimum-macos", default="14.0", help="the Mac app's minimum macOS (default 14.0)")
    parser.add_argument("--base-url", default="", help="https:// folder the files are served from (else by name)")
    parser.add_argument("--out", help="where to write it (default: fiberbrowser-update-<channel>.json)")
    args = parser.parse_args(argv)
    infos = [(path, json.loads(Path(path).read_text())) for path in args.build_info]
    # One manifest serves every platform: its builds must agree, or an app would see its own release as newer.
    for path, other in infos[1:]:
        for key in ("version", "build"):
            if str(other.get(key) or "") != str(infos[0][1].get(key) or ""):
                raise SystemExit(f"make_update_manifest: {path} is {key} {other.get(key)!r}, but {infos[0][0]} is "
                                 f"{infos[0][1].get(key)!r}: build both from one commit, or with one FB_BUILD_NUMBER")
    info = infos[0][1] if infos else {}
    for path, each in infos:
        if each.get("channel") and each["channel"] != args.channel:
            raise SystemExit(f"make_update_manifest: {path} is a {each['channel']} build, not {args.channel}")
    version = args.version or info.get("version")
    if not version:
        raise SystemExit("make_update_manifest: give --version or --build-info")
    if info.get("version") and info["version"] != version:
        raise SystemExit(f"make_update_manifest: {infos[0][0]} is version {info['version']}, not {version}")
    notes = Path(args.notes_file).read_text().strip() if args.notes_file else args.notes
    manifest = make_manifest(args.channel, version, args.files, build=args.build or str(info.get("build") or ""),
                             notes=notes, notes_url=args.notes_url, minimum_macos=args.minimum_macos,
                             base_url=args.base_url)
    out = Path(args.out or f"fiberbrowser-update-{args.channel}.json")
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    count = sum(len(v) for v in manifest["downloads"].values())
    print(f"{out}: {args.channel} {version} build {manifest['build'] or '-'}, {count} file(s) "
          f"for {', '.join(sorted(manifest['downloads']))}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
