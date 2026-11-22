"""Existing sessions render exactly as before the scripted-figure options (golden from 81bfce04c).

tests/fixtures/headless_figure/make_golden.py rendered the synthetic session (tests/headless_figure_data.py)
with the headless engine at 81bfce04c; every decompressed PDF stream (page content, read rasters) and the
page box must still match with no new option set.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "headless_figure"


def _make_golden():
    spec = importlib.util.spec_from_file_location("make_golden", FIXTURES / "make_golden.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    return _make_golden().render_cases(tmp_path_factory.mktemp("headless-golden"))


@pytest.mark.parametrize("case", ["session_old_rows", "session_sv_row", "session_caps"])
def test_default_render_matches_the_pre_change_golden(rendered, case):
    golden = json.loads((FIXTURES / "golden_defaults.json").read_text())
    assert rendered[case] == golden[case]
