#!/usr/bin/env python3
"""Fail a release build whose tracked frontend build is not the build of the frontend source.

Release builds (the wheel, the Mac app, the WSL distribution) ship the committed
``browser/frontend/dist``; nothing rebuilds it. A dist committed before later frontend
changes ships the old UI.

A build records what it was made from: ``dist/build-inputs.json`` (written by
``browser/frontend/scripts/build-inputs.mjs`` from vite.config.ts, into whichever folder the
build goes to) holds a sha256 over the build inputs (the SOURCES below, without tests and
fixtures) and one over the built files. This check recomputes both with the same algorithm:
the dist is current when its inputs hash matches the source as it is now and its files are
the ones the build wrote. Bytes are hashed as read, so a checkout that converts line endings
(CRLF) needs its own build. Git is not needed for this.

A dist without the manifest (built before 3.1.1) falls back to git history, not file times
(a checkout sets every mtime to the checkout time): it is stale when a commit after the last
one that touched the dist changes the frontend source, or when the source has uncommitted
changes. A shallow clone that does not reach the dist's last commit cannot tell (exit 2):
fetch the full history (``actions/checkout`` with ``fetch-depth: 0``). Outside a git checkout
(an sdist) there is nothing to compare and the check passes with a note.

    python packaging/check_frontend_dist.py            # exit 0: current; 1: stale; 2: cannot tell
"""
from __future__ import annotations

import argparse
import hashlib
import json
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


FRONTEND = "browser/frontend"
# The manifest a build writes into its folder (browser/frontend/scripts/build-inputs.mjs; the hashes below are the
# same algorithm, version 1: keep the two identical).
MANIFEST = "build-inputs.json"
MANIFEST_VERSION = 1
INPUTS = tuple(s[len(FRONTEND) + 1:] for s in SOURCES)


def _is_test(rel: str) -> bool:
    return rel.endswith((".test.ts", ".test.tsx")) or "__fixtures__" in rel.split("/")


def _walk(base: Path, rel: str, out: list) -> None:
    path = base.joinpath(*rel.split("/"))
    if not path.exists():
        return
    if path.is_dir():
        for child in path.iterdir():
            if not child.name.startswith("."):
                _walk(base, f"{rel}/{child.name}", out)
    else:
        out.append(rel)


def _digest(base: Path, files) -> dict:
    """{files, sha256}: sha256 over "<sha256 of the bytes>  <POSIX path>\n" lines sorted by the path's UTF-8 bytes.
    Bytes as read: a checkout that converts line endings (CRLF) hashes differently from the build's."""
    lines = [f"{hashlib.sha256(base.joinpath(*rel.split('/')).read_bytes()).hexdigest()}  {rel}\n"
             for rel in sorted(files, key=lambda r: r.encode("utf-8"))]
    return {"files": len(lines), "sha256": hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()}


def hash_inputs(frontend: Path, inputs=INPUTS) -> dict:
    """The build inputs under browser/frontend, without names starting with "." and without tests and fixtures."""
    files: list = []
    for item in inputs:
        _walk(frontend, item, files)
    return _digest(frontend, [f for f in files if not _is_test(f)])


def hash_outputs(dist: Path) -> dict:
    """The build folder's files, without the manifest and names starting with "."."""
    files: list = []
    if dist.is_dir():
        for child in dist.iterdir():
            if not child.name.startswith(".") and child.name != MANIFEST:
                _walk(dist, child.name, files)
    return _digest(dist, files)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def check_manifest(repo: Path, dist: str = DIST) -> tuple[int, str] | None:
    """The dist's own record of what it was built from, or None when it has none (a build before 3.1.1)."""
    path = Path(repo, dist, MANIFEST)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        version, inputs, outputs = data.get("version"), data["inputs"], data["outputs"]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        return 2, f"{dist}/{MANIFEST} cannot be read ({exc}): rebuild the dist (cd browser/frontend && npm run build)."
    if version != MANIFEST_VERSION:
        return 2, (f"{dist}/{MANIFEST} is hash version {version!r}; this check knows version {MANIFEST_VERSION}. "
                   "Use the check of the same FiberBrowser source, or rebuild the dist.")
    if tuple(inputs.get("paths") or ()) != INPUTS:
        return 2, (f"{dist}/{MANIFEST} lists another input list than this check ({', '.join(INPUTS)}): the build "
                   "and the check come from different FiberBrowser sources.")
    frontend = Path(repo, FRONTEND)
    if not (frontend / "src").is_dir():
        return 0, f"{FRONTEND}/src is not here: the build in {dist} is not compared with its source."
    now = hash_inputs(frontend)
    if now["sha256"] != inputs.get("sha256"):
        return 1, (f"The tracked {dist} was not built from this source (its {MANIFEST} records {inputs.get('files')} "
                   f"input files hashing {str(inputs.get('sha256'))[:12]}; the source now has {now['files']} hashing "
                   f"{now['sha256'][:12]}). Rebuild it (cd browser/frontend && npm run build) and commit it. "
                   "Line endings count: a checkout converting them (CRLF) needs a rebuild on that checkout.")
    built = hash_outputs(Path(repo, dist))
    if built["sha256"] != outputs.get("sha256"):
        return 1, (f"The files in {dist} changed after the build ({built['files']} files now, {outputs.get('files')} "
                   "built): a partly committed or edited build. Rebuild it (cd browser/frontend && npm run build) "
                   "and commit it.")
    return 0, f"{dist} is current: built from this source ({now['files']} input files, {MANIFEST})."


def check(repo: Path, dist: str = DIST, sources=SOURCES, exclude=EXCLUDE) -> tuple[int, str]:
    """(exit code, message): 0 current, 1 stale, 2 cannot tell. A dist with a build-inputs manifest is compared by
    hashes (git is not needed); one without falls back to git history (``sources`` apply to that fallback only)."""
    by_manifest = check_manifest(repo, dist)
    if by_manifest is not None:
        return by_manifest
    try:
        _git(repo, "rev-parse", "HEAD")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 0, f"{repo} is not a git checkout: the tracked frontend build is not checked."
    try:
        Path(repo, dist).resolve().relative_to(Path(repo).resolve())
    except ValueError:
        return 2, (f"{dist} is outside the checkout {repo} and has no {MANIFEST}: its git history cannot be "
                   "compared. Build it with this source (the build writes the manifest) or pass a dist inside it.")
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
                        help="a source path for the git-history fallback (repeatable; default: the frontend's src, "
                             "public, index.html, package files and configs)")
    args = parser.parse_args(argv)
    code, message = check(Path(args.repo), args.dist, tuple(args.sources) if args.sources else SOURCES)
    print(("ERROR: " if code else "") + message, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
