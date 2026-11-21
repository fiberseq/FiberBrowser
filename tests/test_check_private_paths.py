"""Release binaries never carry the builder's home path (packaging/check_private_paths.py), and the graph helper wheel
builder refuses a helper that does (the 0.5.0 helper once embedded ~/.cargo paths)."""
from __future__ import annotations

import importlib.util
import os
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


cpp = _load("check_private_paths", ROOT / "packaging" / "check_private_paths.py")
MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 60
# Home paths built at run time (the repository hygiene test keeps literal home paths out of tracked files).
USERS = "/" + "Users"
HOME = f"{USERS}/builder"
B_HOME = HOME.encode()


def test_binaries_and_wheel_members_with_the_builders_home_are_flagged(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", HOME)
    monkeypatch.setenv("USER", "builder")
    (tmp_path / "clean").write_bytes(MACHO + b"/build/.cargo/registry/src/x.rs\0" + USERS.encode() + b"/runner/work\0")
    (tmp_path / "dirty").write_bytes(MACHO + B_HOME + b"/.cargo/registry/src/x.rs\0")
    (tmp_path / "text.py").write_bytes(b"# " + B_HOME + b"/notes\n")          # not a binary: not searched
    with zipfile.ZipFile(tmp_path / "pkg.whl", "w") as zf:
        zf.writestr("pkg/bin/helper", MACHO + B_HOME + b"/x\0")
        zf.writestr("pkg/__init__.py", f"x = '{HOME}'\n")
    assert cpp.main([str(tmp_path / "clean")]) == 0
    hits = cpp.scan([tmp_path], cpp.patterns([]))
    names = sorted(Path(n.split("!")[0]).name + ("!" + n.split("!")[1] if "!" in n else "") for n, _ in hits)
    assert names == ["dirty", "pkg.whl!pkg/bin/helper"]
    # --any-home also flags another user's home (upstream CI paths); --forbid adds strings.
    assert cpp.scan([tmp_path / "clean"], cpp.patterns([], any_home=True))
    assert cpp.scan([tmp_path / "clean"], cpp.patterns(["registry/src"]))
    # An accepted exception is skipped by file name only; every other file is still checked.
    assert [n.endswith("pkg.whl!pkg/bin/helper") for n, _ in cpp.scan([tmp_path], cpp.patterns([]), ("dirty",))] == [True]
    assert cpp.main(["--allow", "dirty", str(tmp_path / "dirty")]) == 0


def test_the_graph_wheel_builder_refuses_a_helper_with_the_builders_paths(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", HOME)
    monkeypatch.setenv("USER", "builder")
    bw = _load("graph_native_build_wheel", ROOT / "packaging" / "graph-native" / "build_wheel.py")
    helper = tmp_path / "fiberbrowser-graph"
    helper.write_bytes(MACHO + B_HOME + b"/.cargo/registry/src/serde/de.rs\0")
    with pytest.raises(SystemExit, match="builder's paths"):
        bw.build(helper, tmp_path / "out", None, None, False, "macosx_11_0_arm64")
