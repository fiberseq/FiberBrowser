#!/usr/bin/env python3
"""Write a packaged build's information file (browser/services/app_build.py reads it at run time).

    python3 packaging/write_build_info.py --out FiberBrowser.app/Contents/Resources/fiberbrowser-build.json \
        --flavor public --version 3.0.0 --platform macos-arm64 --fiberhmm-version 3.0.0 [--commit abc1234]

Its presence makes FiberBrowser a packaged app: it runs its bundled FiberHMM by default and offers app updates
from its channel (the flavour). Optional settings from the environment:

    FB_BUILD_NUMBER   the build (default: the source commit's UTC time, YYYYMMDD.HHMM, so the Mac app and the WSL
                      distribution built from one commit share it and an update manifest compares them right; the
                      UTC time now when there is no commit). A lab rebuild of the same version is newer when its
                      build is.

The commit: --commit, else the source commit an exported (public) tree records in packaging/source.json
(legacy source archives record it there), else none.
    FB_UPDATE_URL     an update manifest address baked into the build (https://, file:// or a path); default none
    FB_UPDATE_REPO    the GitHub repository (owner/name) of the channel's releases, instead of the flavour's default
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

SCHEMA = "fiberbrowser.build.v1"
HERE = Path(__file__).resolve().parent
# Legacy source archives may record their original commit and its time here.
SOURCE_FILE = HERE / "source.json"


def source_record(path: Path = SOURCE_FILE) -> dict:
    """The exported tree's source commit ({} in a git checkout of the source)."""
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def commit_time(root: Path = HERE.parent) -> int | None:
    """The checkout's HEAD commit time (Unix seconds), None outside a git checkout."""
    try:
        out = subprocess.run(["git", "-C", str(root), "log", "-1", "--format=%ct"], capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def default_build_number(source: dict | None = None, root: Path = HERE.parent) -> str:
    """The source commit's UTC time (shared by every build of that commit), else the time now."""
    record = source_record() if source is None else source
    when = record.get("committed_at") if isinstance(record.get("committed_at"), (int, float)) else commit_time(root)
    return time.strftime("%Y%m%d.%H%M", time.gmtime(when if when is not None else time.time()))


def build_info(flavor: str, version: str, platform: str, fiberhmm_version: str = "", commit: str = "",
               environ=None, source: dict | None = None, source_root: Path | None = None) -> dict:
    """`source_root`: the tree being packaged (default: the one holding this script); its packaging/source.json and
    its git commit time give the build's source commit and default build number."""
    env = os.environ if environ is None else environ
    root = Path(source_root) if source_root else HERE.parent
    record = (source_record(root / "packaging" / "source.json") if source is None else source)
    if source is None and not record.get("committed_at"):
        when = commit_time(root)
        if when is not None:
            record = {**record, "committed_at": when}
    source_commit = str(record.get("commit") or "").strip()
    return {
        "schema": SCHEMA,
        "flavor": flavor,
        "channel": flavor,
        "version": version,
        "build": (env.get("FB_BUILD_NUMBER") or default_build_number(record)).strip(),
        "commit": commit or source_commit or None,
        # An archived tree's source commit (also when --commit names the export's own repository commit).
        "source_commit": source_commit or commit or None,
        "platform": platform,
        "fiberhmm_version": fiberhmm_version or None,
        "update_manifest_url": (env.get("FB_UPDATE_URL") or "").strip(),
        "update_repo": (env.get("FB_UPDATE_REPO") or "").strip(),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", required=True)
    parser.add_argument("--flavor", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", required=True, help="macos-arm64, windows-x64, ...")
    parser.add_argument("--fiberhmm-version", default="")
    parser.add_argument("--commit", default="")
    parser.add_argument("--source-root", default="", help="the FiberBrowser tree being packaged (default: this one)")
    args = parser.parse_args(argv)
    info = build_info(args.flavor, args.version, args.platform, args.fiberhmm_version, args.commit,
                      source_root=Path(args.source_root) if args.source_root else None)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(info, indent=2) + "\n")
    print(f"  build info: {info['channel']} {info['version']} build {info['build']} ({info['platform']}) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
