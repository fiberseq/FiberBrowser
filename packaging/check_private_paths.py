#!/usr/bin/env python3
"""Fail a release whose binaries or wheels carry the builder's home path.

    python packaging/check_private_paths.py [--forbid TEXT ...] PATH [PATH ...]

Every native binary under each PATH (Mach-O, ELF or PE, found by magic bytes, also inside .whl/.zip archives) is
searched for the builder's home: the current ``$HOME`` and ``/Users/<user>`` / ``/home/<user>`` of the current user,
plus every ``--forbid`` string (``--any-home``: any ``/Users/<name>/`` or ``/home/<name>/``, which also flags the CI
paths of upstream wheels). Compilers embed source paths (Rust panics carry ~/.cargo paths, for
example); release builds remap them (``--remap-path-prefix``), and this check proves they did. A PATH that is itself a
wheel or zip is searched member by member. Exit 0: clean; 1: hits (each printed with the file and the match).
Standard library only.
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys
import zipfile
from pathlib import Path

MAGICS = (
    b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce",   # Mach-O
    b"\xca\xfe\xba\xbe",                                                                   # Mach-O universal
    b"\x7fELF",                                                                            # ELF
    b"MZ",                                                                                 # PE
)
HOME_PATTERNS = (
    rb"/Users/(?!Shared/)[A-Za-z0-9._-]+/",
    rb"/home/[A-Za-z0-9._-]+/",
    rb"[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\",
)


def is_binary(head: bytes) -> bool:
    return any(head.startswith(m) for m in MAGICS)


def patterns(forbid: list[str], any_home: bool = False) -> list[re.Pattern]:
    pats = [re.compile(p) for p in HOME_PATTERNS] if any_home else []
    home = os.path.expanduser("~")
    extra = [home] if home and home not in ("/", "~") else []
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or (Path(home).name if home else "")
    if user:
        extra += [f"/Users/{user}/", f"/Users/{user}", f"/home/{user}/"]
    pats += [re.compile(re.escape(s.encode())) for s in [*extra, *forbid] if s]
    return pats


def hits_in(data: bytes, pats: list[re.Pattern]) -> list[str]:
    found: list[str] = []
    for p in pats:
        for m in p.finditer(data):
            text = m.group(0).decode("utf-8", "replace")
            if text not in found:
                found.append(text)
            if len(found) >= 5:
                return found
    return found


def scan_archive(name: str, data: bytes, pats: list[re.Pattern]) -> list[tuple[str, list[str]]]:
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            member = zf.read(info)
            if is_binary(member[:4]):
                found = hits_in(member, pats)
                if found:
                    out.append((f"{name}!{info.filename}", found))
    return out


def scan(paths: list[Path], pats: list[re.Pattern], allow: tuple[str, ...] = ()) -> list[tuple[str, list[str]]]:
    """Hits per file; a file whose name (basename) is in ``allow`` is skipped (an accepted, listed exception)."""
    out: list[tuple[str, list[str]]] = []
    for root in paths:
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file() and not p.is_symlink()]
        for f in files:
            if f.name in allow:
                continue
            try:
                with open(f, "rb") as fh:
                    head = fh.read(4)
                    if f.suffix.lower() in (".whl", ".zip") and head.startswith(b"PK"):
                        fh.seek(0)
                        out += scan_archive(str(f), fh.read(), pats)
                        continue
                    if not is_binary(head):
                        continue
                    fh.seek(0)
                    found = hits_in(fh.read(), pats)
            except OSError:
                continue
            if found:
                out.append((str(f), found))
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--forbid", action="append", default=[], help="another string no binary may contain")
    parser.add_argument("--any-home", action="store_true", help="also any other user's home path")
    parser.add_argument("--allow", action="append", default=[],
                        help="a file name (basename) accepted as an exception; listed in the output")
    args = parser.parse_args(argv)
    for name in args.allow:
        print(f"check_private_paths: accepted exception: {name}")
    hits = scan(args.paths, patterns(args.forbid, args.any_home), tuple(args.allow))
    for name, found in hits:
        print(f"{name}: {', '.join(found)}")
    print(f"check_private_paths: {len(hits)} file(s) with private paths" if hits else "check_private_paths: clean")
    return 1 if hits else 0


if __name__ == "__main__":
    raise SystemExit(main())
