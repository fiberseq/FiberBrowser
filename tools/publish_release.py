#!/usr/bin/env python3
"""Publish built FiberBrowser files and their update manifest as a GitHub release (``gh release create``).

    python3 tools/publish_release.py --channel public --tag v3.0.1 --manifest build/fiberbrowser-update-public.json \
        --notes-file notes.md build/macos/dist/FiberBrowser-3.0.1-arm64.dmg build/windows/FiberBrowser-3.0.1-Setup.exe \
        --dry-run

Always try ``--dry-run`` first: it prints exactly what would run and runs nothing (no network). Without it the
tool checks the repository (a private channel's must be private), asks for confirmation (``--yes`` skips that)
and runs ``gh release create`` for a tag that must already be pushed (``--verify-tag``); it never pushes code or
creates or moves a tag.

Checks before anything runs: the manifest is this channel's (``fiberbrowser-update-<channel>.json``, its schema,
channel and version match the tag), every file it lists is given here with the same sha256, and nothing else is
uploaded. The app's update check reads the release's assets (services/app_update.py, docs/updates.md).

Repositories: ``--repo``, else the channel's default (public: fiberseq/FiberBrowser).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_REPOS = {"public": "fiberseq/FiberBrowser"}
PRIVATE_CHANNELS: set = set()
SCHEMA = "fiberbrowser.update.v1"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def plan(channel: str, tag: str, manifest_path: Path, files: list[Path], *, repo: str = "", title: str = "",
         notes_file: str = "", draft: bool = False, prerelease: bool = False) -> dict:
    """The checked commands (raises SystemExit with the reason when something doesn't match)."""
    repo = repo or DEFAULT_REPOS.get(channel, "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo or ""):
        raise SystemExit(f"publish_release: give --repo owner/name for the {channel} channel")
    if not re.fullmatch(r"v\d+(\.\d+)*([A-Za-z0-9.+-]*)", tag):
        raise SystemExit(f"publish_release: tag {tag!r} should look like v3.0.1")
    expected_name = f"fiberbrowser-update-{channel}.json"
    if manifest_path.name != expected_name:
        raise SystemExit(f"publish_release: the manifest must be named {expected_name} (the app looks for that asset)")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema") != SCHEMA or manifest.get("channel") != channel:
        raise SystemExit(f"publish_release: {manifest_path} is not a {channel} update manifest")
    if manifest.get("version") != tag[1:]:
        raise SystemExit(f"publish_release: the manifest is version {manifest.get('version')}, the tag {tag}")
    listed = {e["name"]: e for entries in manifest.get("downloads", {}).values() for e in entries}
    given = {p.name: p for p in files}
    if set(listed) != set(given):
        raise SystemExit(f"publish_release: the files given ({sorted(given)}) aren't the manifest's ({sorted(listed)})")
    for name, path in given.items():
        if not path.is_file():
            raise SystemExit(f"publish_release: no file {path}")
        if sha256_of(path) != listed[name]["sha256"]:
            raise SystemExit(f"publish_release: {name} doesn't match the manifest's sha256 (rebuild the manifest)")
    create = ["gh", "release", "create", tag, *[str(p) for p in files], str(manifest_path), "--repo", repo,
              "--title", title or f"FiberBrowser {tag[1:]}" + (f" ({channel})" if channel != "public" else ""),
              "--verify-tag"]
    if notes_file:
        create += ["--notes-file", notes_file]
    else:
        create += ["--notes", str(manifest.get("notes") or f"FiberBrowser {tag[1:]}")]
    if draft:
        create.append("--draft")
    if prerelease:
        create.append("--prerelease")
    return {"repo": repo, "tag": tag, "private": channel in PRIVATE_CHANNELS,
            "check": ["gh", "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"],
            "create": create}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="+", type=Path, help="the built files the manifest lists")
    parser.add_argument("--channel", required=True, choices=sorted(DEFAULT_REPOS))
    parser.add_argument("--tag", required=True, help="the release tag, e.g. v3.0.1 (it must exist: --verify-tag)")
    parser.add_argument("--manifest", required=True, type=Path, help="fiberbrowser-update-<channel>.json")
    parser.add_argument("--repo", default="", help="owner/name (default: the channel's)")
    parser.add_argument("--title", default="")
    parser.add_argument("--notes-file", default="")
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--prerelease", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="print what would run; run nothing")
    parser.add_argument("--yes", action="store_true", help="don't ask before publishing")
    args = parser.parse_args(argv)
    steps = plan(args.channel, args.tag, args.manifest, args.files, repo=args.repo, title=args.title,
                 notes_file=args.notes_file, draft=args.draft, prerelease=args.prerelease)
    if args.dry_run:
        print(f"Dry run: would publish {args.tag} to {steps['repo']} ({args.channel} channel). Nothing was run.")
        if steps["private"]:
            print("  1. check that the repository is private:")
            print("     " + shlex.join(steps["check"]))
        print(f"  {2 if steps['private'] else 1}. create the release with its files and the manifest:")
        print("     " + shlex.join(steps["create"]))
        return 0
    if not shutil.which("gh"):
        raise SystemExit("publish_release: needs the GitHub CLI (gh), signed in with write access to " + steps["repo"])
    if steps["private"]:
        visibility = subprocess.run(steps["check"], capture_output=True, text=True, check=True).stdout.strip()
        if visibility.upper() != "PRIVATE":
            raise SystemExit(f"publish_release: {steps['repo']} is {visibility or 'unknown'}, not private; "
                             f"a {args.channel} release must not be public")
    if not args.yes:
        answer = input(f"Publish {args.tag} to {steps['repo']}? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Nothing published.")
            return 1
    subprocess.run(steps["create"], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
