#!/usr/bin/env python3
"""Fail a release build whose tracked frontend build is older than the frontend source.

Release builds (the wheel, the Mac app, the WSL distribution) ship the committed
``browser/frontend/dist``; nothing rebuilds it. A dist committed before later frontend
changes ships the old UI. This check compares git history, not file times (a checkout
sets every mtime to the checkout time): the dist is stale when a commit after the last
one that touched the dist changes the frontend source, or when the source has
uncommitted changes.

    python packaging/check_frontend_dist.py            # exit 0: current; 1: stale; 2: cannot tell

A shallow clone that does not reach the dist's last commit cannot tell (exit 2): fetch
the full history (``actions/checkout`` with ``fetch-depth: 0``). Outside a git checkout
(an sdist) there is nothing to compare and the check passes with a note.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

DIST = "browser/frontend/dist"
# What the build is made from (vite: index.html, src/, public/, its configs and the locked dependencies).
SOURCES = (
    "browser/frontend/src",
    "browser/frontend/public",
    "browser/frontend/index.html",
    "browser/frontend/package.json",
    "browser/frontend/package-lock.json",
    "browser/frontend/vite.config.ts",
    "browser/frontend/tsconfig.json",
    "browser/frontend/tsconfig.node.json",
    "browser/frontend/tailwind.config.js",
    "browser/frontend/postcss.config.js",
)
# Source paths that never reach the build (tests).
EXCLUDE = (":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/*.test.tsx", ":(exclude,glob)**/__fixtures__/**")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def check(repo: Path, dist: str = DIST, sources=SOURCES, exclude=EXCLUDE) -> tuple[int, str]:
    """(exit code, message): 0 current, 1 stale, 2 cannot tell."""
    try:
        _git(repo, "rev-parse", "HEAD")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 0, f"{repo} is not a git checkout: the tracked frontend build is not checked."
    last = _git(repo, "log", "-1", "--format=%H", "--", dist)
    shallow = _git(repo, "rev-parse", "--is-shallow-repository") == "true"
    # In a shallow clone the boundary commit seems to add every file: a dist "last changed" there is unknown.
    boundary = set()
    if shallow:
        shallow_file = Path(repo, _git(repo, "rev-parse", "--git-path", "shallow"))
        boundary = set(shallow_file.read_text().split()) if shallow_file.is_file() else set()
    if not last or last in boundary:
        if shallow:
            return 2, (f"Shallow clone: the fetched history does not show when {dist} was last built. Fetch the "
                       "full history (git fetch --unshallow; actions/checkout fetch-depth: 0).")
        return 1, f"{dist} is not tracked: build it (cd browser/frontend && npm run build) and commit it."
    pathspec = [*sources, *exclude]
    later = _git(repo, "rev-list", f"{last}..HEAD", "--", *pathspec).split()
    dirty = _git(repo, "status", "--porcelain", "--untracked-files=no", "--", *pathspec)
    if later or dirty:
        when = _git(repo, "log", "-1", "--format=%cs %h", last)
        parts = []
        if later:
            parts.append(f"{len(later)} commit(s) changed the frontend source after it (latest "
                         f"{_git(repo, 'log', '-1', '--format=%cs %h %s', later[0])})")
        if dirty:
            parts.append("the frontend source has uncommitted changes")
        return 1, (f"The tracked {dist} (last built {when}) is older than the frontend source: "
                   + "; ".join(parts) + ". Rebuild it (cd browser/frontend && npm run build) and commit it.")
    return 0, f"{dist} is current (last built {_git(repo, 'log', '-1', '--format=%cs %h', last)})."


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]), help="the repository (default: this one)")
    parser.add_argument("--dist", default=DIST, help=f"the tracked build (default: {DIST})")
    parser.add_argument("--source", action="append", dest="sources",
                        help="a source path (repeatable; default: the frontend's src, public, index.html, "
                             "package files and configs)")
    args = parser.parse_args(argv)
    code, message = check(Path(args.repo), args.dist, tuple(args.sources) if args.sources else SOURCES)
    print(("ERROR: " if code else "") + message, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
