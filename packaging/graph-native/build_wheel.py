#!/usr/bin/env python3
"""Build the ``fiberbrowser-graph-native`` companion wheel around a built ``fiberbrowser-graph`` helper.

    python packaging/graph-native/build_wheel.py --helper <graphlift>/target/release/fiberbrowser-graph \\
        --cargo-dir <graphlift> --out dist/

The helper is built in graphlift (``cargo build --locked --release --bin fiberbrowser-graph``, baseline CPU, no
``target-cpu=native``). This script checks it (the framed handshake must report protocol 1 and the schemas
FiberBrowser reads), takes the wheel's version from the helper's producer string, derives the platform tag from
the binary itself (macOS: its LC_BUILD_VERSION minimum and architecture; Linux: the given --manylinux tag), and
writes a py3-none-<platform> wheel with:

- ``fiberbrowser_graph_native/bin/fiberbrowser-graph`` (mode 755) and ``helper_path()``;
- a ``fiberbrowser-graph`` console script;
- ``THIRD_PARTY_NOTICES.txt``: every crate compiled into the helper with its licence (``cargo metadata``), when
  ``--cargo-dir`` is given (a release build requires it: ``--require-notices``).

No network access; standard library only. FiberBrowser itself stays a py3-none-any wheel and pins this one through
its ``graph`` extra.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = "fiberbrowser_graph_native"
PROJECT = "fiberbrowser-graph-native"
SUPPORTED_DB_SCHEMA = "GBZ-base version 4"


def handshake(helper: Path) -> dict:
    out = subprocess.run([str(helper), "handshake"], stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=True).stdout
    (length,) = struct.unpack(">I", out[:4])
    frame = json.loads(out[4:4 + length])
    if frame.get("protocol") != 1 or frame.get("type") != "ready":
        raise SystemExit(f"{helper}: not a protocol-1 helper")
    hs = frame["handshake"]
    if SUPPORTED_DB_SCHEMA not in hs.get("db_schemas", []) or 1 not in hs.get("package_schemas", []) or 2 not in hs.get("map_schemas", []):
        raise SystemExit(f"{helper}: schemas {hs.get('db_schemas')}/{hs.get('package_schemas')}/{hs.get('map_schemas')} are not FiberBrowser's")
    return hs


def macos_tag(helper: Path) -> str:
    """macosx_<major>_<minor>_<arch> from the binary (otool -l minos, lipo -archs)."""
    text = subprocess.run(["otool", "-l", str(helper)], capture_output=True, text=True, check=True).stdout
    found = re.findall(r"\bminos (\d+)\.(\d+)", text)
    if not found:
        found = re.findall(r"cmd LC_VERSION_MIN_MACOSX.*?version (\d+)\.(\d+)", text, re.S)
    if not found:
        raise SystemExit("cannot read the helper's minimum macOS")
    major, minor = (int(x) for x in found[0])
    archs = subprocess.run(["lipo", "-archs", str(helper)], capture_output=True, text=True, check=True).stdout.split()
    arch = "universal2" if set(archs) >= {"arm64", "x86_64"} else archs[0]
    if major >= 11:
        minor = 0   # pip compares macOS 11+ by major version
    return f"macosx_{major}_{minor}_{arch}"


def platform_tag(helper: Path, manylinux: str | None) -> str:
    if sys.platform == "darwin":
        return macos_tag(helper)
    if manylinux:
        return manylinux
    raise SystemExit("on Linux give --manylinux (e.g. manylinux_2_28_x86_64) matching the helper's glibc baseline")


def crate_notices(cargo_dir: Path, target: str) -> str:
    """Every package compiled into the helper (normal and build dependencies) with its licence."""
    env = dict(os.environ)
    meta = json.loads(subprocess.run(
        ["cargo", "metadata", "--offline", "--locked", "--format-version", "1", "--filter-platform", target],
        cwd=cargo_dir, capture_output=True, text=True, check=True, env=env).stdout)
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = next(p["id"] for p in meta["packages"] if p["name"] == "graphlift")
    seen, stack = set(), [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        for dep in nodes[pid]["deps"]:
            kinds = {k.get("kind") for k in dep.get("dep_kinds", [])}
            if kinds & {None, "build"}:
                stack.append(dep["pkg"])
    lines = ["fiberbrowser-graph third-party notices", "",
             "The helper executable statically links the following packages (name version: licence).",
             "SQLite (through libsqlite3-sys, bundled) is in the public domain.", ""]
    for pid in sorted(seen, key=lambda i: (packages[i]["name"], packages[i]["version"])):
        p = packages[pid]
        lines.append(f"{p['name']} {p['version']}: {p.get('license') or p.get('license_file') or 'see its source'}")
    return "\n".join(lines) + "\n"


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def build(helper: Path, out_dir: Path, cargo_dir: Path | None, manylinux: str | None, require_notices: bool,
          plat_tag: str | None = None) -> Path:
    hs = handshake(helper)
    producer = str(hs.get("producer", ""))
    m = re.match(r"fiberbrowser-graph (\d+\.\d+\.\d+)$", producer)
    if not m:
        raise SystemExit(f"cannot read a version from the helper's producer {producer!r}")
    version = m.group(1)
    tag = plat_tag or platform_tag(helper, manylinux)
    notices = crate_notices(cargo_dir, hs["build_target"]) if cargo_dir else None
    if require_notices and not notices:
        raise SystemExit("--require-notices: give --cargo-dir")
    init = (HERE / DIST / "__init__.py").read_text().replace('__version__ = "0.0.0"', f'__version__ = "{version}"')
    dist_info = f"{DIST}-{version}.dist-info"
    meta = "\n".join([
        "Metadata-Version: 2.1", f"Name: {PROJECT}", f"Version: {version}",
        "Summary: The native graph helper for FiberBrowser's graph view (fiberbrowser-graph)",
        "License: MIT", "Requires-Python: >=3.10",
        f"Description: {producer} for {hs.get('build_target')} ({hs.get('toolchain')}); graphlift {hs.get('graphlift_revision')}, gbz-base {hs.get('gbz_base_version')} {hs.get('gbz_base_revision')}.",
        "",
    ])
    wheel_meta = "\n".join(["Wheel-Version: 1.0", "Generator: fiberbrowser packaging/graph-native/build_wheel.py",
                            "Root-Is-Purelib: false", f"Tag: py3-none-{tag}", ""])
    entry_points = "[console_scripts]\nfiberbrowser-graph = fiberbrowser_graph_native:main\n"
    build_info = json.dumps({k: hs.get(k) for k in ("producer", "graphlift_revision", "gbz_base_version", "gbz_base_revision",
                                                    "build_target", "toolchain", "db_schemas", "package_schemas", "map_schemas")}, indent=1)
    files: list[tuple[str, bytes, int]] = [
        (f"{DIST}/__init__.py", init.encode(), 0o644),
        (f"{DIST}/bin/fiberbrowser-graph", helper.read_bytes(), 0o755),
        (f"{DIST}/build_info.json", build_info.encode(), 0o644),
    ]
    if notices:
        files.append((f"{DIST}/THIRD_PARTY_NOTICES.txt", notices.encode(), 0o644))
    files += [(f"{dist_info}/METADATA", meta.encode(), 0o644), (f"{dist_info}/WHEEL", wheel_meta.encode(), 0o644),
              (f"{dist_info}/entry_points.txt", entry_points.encode(), 0o644)]
    record = [record_line(name, data) for name, data, _ in files] + [f"{dist_info}/RECORD,,"]
    files.append((f"{dist_info}/RECORD", ("\n".join(record) + "\n").encode(), 0o644))
    out_dir.mkdir(parents=True, exist_ok=True)
    wheel = out_dir / f"{DIST}-{version}-py3-none-{tag}.whl"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
    wheel.write_bytes(buf.getvalue())
    return wheel


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--helper", required=True, type=Path, help="the built fiberbrowser-graph executable")
    parser.add_argument("--out", required=True, type=Path, help="output folder")
    parser.add_argument("--cargo-dir", type=Path, help="the graphlift checkout it was built from (licence notices)")
    parser.add_argument("--manylinux", help="Linux platform tag, e.g. manylinux_2_28_x86_64")
    parser.add_argument("--require-notices", action="store_true", help="fail without --cargo-dir (release builds)")
    parser.add_argument("--plat-tag", help="the platform tag, instead of reading it from the binary (tests, cross builds)")
    args = parser.parse_args(argv)
    wheel = build(args.helper.resolve(), args.out, args.cargo_dir, args.manylinux, args.require_notices, args.plat_tag)
    print(wheel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
