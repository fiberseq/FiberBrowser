"""The FiberHMM feature contract covers the modules scans, the feature hub, the nucleosome panel, co-occurrence and
graph mode import (fiberhmm.scan, fiberhmm.nuc, fiberhmm.assoc, fiberhmm.io.scan_ma, fiberhmm.io.graph_lift). FiberHMM 3.1.0 has none
of them, so a FiberHMM like it is refused by name; one with them passes.

Two optional checks run against real FiberHMM builds when their paths are set (otherwise they skip):
``FIBERBROWSER_TEST_FIBERHMM_310_WHEEL`` (the FiberHMM 3.1.0 wheel) must fail the contract, and
``FIBERBROWSER_TEST_FIBERHMM_TREE`` (a FiberHMM source tree with these modules) must pass it.
"""
import os
import re
import zipfile
from pathlib import Path

import pytest

from services import fiberhmm_runtime as runtime

NEW_PREFIXES = ("fiberhmm.scan", "fiberhmm.nuc", "fiberhmm.assoc", "fiberhmm.io.scan_ma", "fiberhmm.io.graph_lift")
BROWSER = Path(runtime.__file__).resolve().parent.parent


def new_features():
    return [f for f in runtime.CORE_REQUIREMENTS["features"] if f["module"].startswith(NEW_PREFIXES)]


def write_tree(root: Path, version: str, with_new: bool) -> Path:
    """A FiberHMM package folder with every required module (``with_new``: also the post-3.1.0 ones)."""
    pkg = root / "fiberhmm"
    for req in runtime.required_features():
        for feature in req.get("features") or []:
            if not with_new and feature["module"].startswith(NEW_PREFIXES):
                continue
            body = "".join(f"def {n}(*args, **kwargs):\n    pass\n\n" for n in feature.get("names") or [])
            schema = feature.get("schema")
            path = root.joinpath(*feature["module"].split("."))
            target = (path / "__init__.py") if schema else path.with_suffix(".py")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body)
            if schema:
                spath = root.joinpath(*schema["module"].split(".")).with_suffix(".py")
                spath.parent.mkdir(parents=True, exist_ok=True)
                spath.write_text(f"{schema['name']} = {schema['min']!r}\n")
    (pkg / "__init__.py").write_text(f'__version__ = "{version}"\n')
    return pkg


def test_the_contract_names_every_new_module_with_functions_browser_imports():
    modules = {f["module"] for f in new_features()}
    for prefix in NEW_PREFIXES:
        assert any(m.startswith(prefix) for m in modules), prefix
    # Every listed name is imported from its module somewhere in the Browser.
    source = "\n".join(p.read_text(errors="replace") for p in BROWSER.rglob("*.py") if "tests" not in p.parts)
    for feature in new_features():
        assert feature.get("names"), feature["label"]
        for name in feature["names"]:
            pattern = rf"from {re.escape(feature['module'])} import [^\n]*\b{re.escape(name)}\b"
            assert re.search(pattern, source), (feature["module"], name)
    # A module that is the parent package of another would make one of them a package and the other a file.
    for a in modules:
        assert not any(b.startswith(a + ".") for b in modules), a


def test_a_fiberhmm_without_the_new_modules_is_refused_by_name(tmp_path):
    pkg = write_tree(tmp_path / "old", "3.1.0", with_new=False)
    missing = runtime.missing_features(pkg)
    assert missing == ["FiberHMM 3.2 or newer"] + [f["label"] for f in new_features()]


def test_a_310_version_with_the_new_modules_is_refused_by_version(tmp_path):
    # The floor (FIBERHMM_REQUIREMENT >=3.2.0, CORE_REQUIREMENTS min_version 3.2) refuses 3.1.x even with the files.
    assert runtime.missing_features(write_tree(tmp_path / "v31", "3.1.9", with_new=True)) == ["FiberHMM 3.2 or newer"]


def test_a_fiberhmm_with_the_new_modules_passes(tmp_path):
    assert runtime.missing_features(write_tree(tmp_path / "new", "3.2.0", with_new=True)) == []


def test_a_new_module_lacking_one_imported_name_is_refused(tmp_path):
    pkg = write_tree(tmp_path / "partial", "3.2.0", with_new=True)
    lift = pkg / "io" / "graph_lift.py"
    lift.write_text(lift.read_text().replace("def lift_pg_record", "def renamed"))
    assert runtime.missing_features(pkg) == ["fiberhmm.io.graph_lift (graph mode and live lift)"]


def test_the_updater_check_refuses_an_overlay_without_them(tmp_path):
    site = tmp_path / "site"
    write_tree(site, "3.1.0", with_new=False)
    error = runtime.check_overlay(site, "3.1.0")
    assert error and "fiberhmm.scan (scans and the feature hub)" in error and "fiberhmm.io.graph_lift" in error


@pytest.mark.skipif(not os.environ.get("FIBERBROWSER_TEST_FIBERHMM_310_WHEEL"),
                    reason="set FIBERBROWSER_TEST_FIBERHMM_310_WHEEL to the FiberHMM 3.1.0 wheel")
def test_the_real_fiberhmm_310_wheel_fails_the_contract(tmp_path):
    site = tmp_path / "site"
    with zipfile.ZipFile(os.environ["FIBERBROWSER_TEST_FIBERHMM_310_WHEEL"]) as wheel:
        wheel.extractall(site)
    assert runtime.package_version(site / "fiberhmm") == "3.1.0"
    missing = runtime.missing_features(site / "fiberhmm")
    assert missing == ["FiberHMM 3.2 or newer"] + [f["label"] for f in new_features()]
    error = runtime.check_overlay(site, "3.1.0")
    assert error and all(f["label"] in error for f in new_features())


@pytest.mark.skipif(not os.environ.get("FIBERBROWSER_TEST_FIBERHMM_TREE"),
                    reason="set FIBERBROWSER_TEST_FIBERHMM_TREE to a FiberHMM source tree with fiberhmm.scan")
def test_a_real_fiberhmm_tree_with_the_modules_passes_the_contract():
    tree = Path(os.environ["FIBERBROWSER_TEST_FIBERHMM_TREE"])
    assert runtime.missing_features(tree / "fiberhmm") == []
    # The updater's import check (a disposable process) also imports every listed module and name.
    assert runtime.check_overlay(tree, runtime.package_version(tree / "fiberhmm")) is None
