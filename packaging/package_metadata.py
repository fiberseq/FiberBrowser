"""Remove pip's local provenance and check installed metadata before shipping."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from urllib.parse import unquote


# Upstream metadata often contains example home paths. Match only our builder's
# home, using a fingerprint when the smoke test runs on another machine.
ACCOUNT_HOME = re.compile(r"/(?:Users|home)/[^/]+|/root\b|[A-Za-z]:/Users/[^/]+")
ABSOLUTE_PATH = re.compile(r"(?:(?<![A-Za-z])[A-Za-z]:/|/)[^\s\"'<>;,()\[\]{}#?]+")


def _normal_path(path: str) -> str:
    path = path.replace("\\", "/")
    if path.startswith("/"):
        path = "/" + path.lstrip("/")
    return str(PurePosixPath(path))


def _fingerprint(path: str) -> str:
    return hashlib.sha256(_normal_path(path).encode("utf-8")).hexdigest()


def home_fingerprints(build_home: str) -> set[str]:
    home = _normal_path(build_home)
    fingerprints = {_fingerprint(home)} if home not in (".", "/") else set()
    # An isolated build HOME may sit beneath the account's real home.
    account = ACCOUNT_HOME.match(home)
    if account:
        fingerprints.add(_fingerprint(account.group()))
    return fingerprints


def check_metadata(roots: list[Path], build_home: str, recorded_homes: set[str] | None = None) -> list[str]:
    problems = []
    homes = home_fingerprints(build_home) | (recorded_homes or set())
    for root in roots:
        if not root.is_dir():
            problems.append(f"missing package root: {root}")
            continue
        problems.extend(f"local provenance: {path}" for path in root.rglob("direct_url.json"))
        metadata = [p for p in root.rglob("*") if p.name.endswith((".dist-info", ".egg-info"))]
        if not metadata:
            problems.append(f"no installed package metadata in {root}")
        for directory in metadata:
            files = directory.rglob("*") if directory.is_dir() else [directory]
            for path in files:
                if not path.is_file():
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                decoded = unquote(text).replace("\\", "/")
                paths = [_normal_path(match.group()) for match in ABSOLUTE_PATH.finditer(decoded)]
                prefixes = (str(parent) for value in paths for parent in
                            (PurePosixPath(value), *PurePosixPath(value).parents))
                if any(_fingerprint(value) in homes for value in prefixes):
                    problems.append(f"build home path in metadata: {path}")
                if path.name == "RECORD":
                    for row in csv.reader(io.StringIO(text)):
                        if row and (PurePosixPath(row[0]).is_absolute() or PureWindowsPath(row[0]).drive
                                    or PureWindowsPath(row[0]).is_absolute()):
                            problems.append(f"absolute path in RECORD: {path}")
                            break
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", type=Path, nargs="+")
    parser.add_argument("--build-home", default=str(Path.home()))
    parser.add_argument("--remove-direct-urls", action="store_true")
    parser.add_argument("--record-build-home", action="store_true")
    args = parser.parse_args()
    fingerprint_file = Path(__file__).with_suffix(".home-sha256")
    if args.record_build_home:
        fingerprint_file.write_text("\n".join(sorted(home_fingerprints(args.build_home))) + "\n")
    recorded_homes = set(fingerprint_file.read_text().splitlines()) if fingerprint_file.is_file() else set()
    if args.remove_direct_urls:
        for root in args.roots:
            for path in root.rglob("direct_url.json"):
                path.unlink()
    problems = check_metadata(args.roots, args.build_home, recorded_homes)
    if problems:
        print("\n".join(problems))
        return 1
    print("Package metadata: no direct_url.json, home paths or absolute RECORD paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
