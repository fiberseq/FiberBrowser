"""scripts/unified_demo.py: where the graph helper comes from when --graph-helper isn't given, and the demo loci
(--locus) that pick the samples and the start view."""
import importlib.util
import os
import re
import stat
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def launcher():
    spec = importlib.util.spec_from_file_location("unified_demo_under_test", ROOT / "scripts" / "unified_demo.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _exe(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_explicit_flag_wins(launcher, tmp_path):
    flag = _exe(tmp_path / "flag-helper")
    env = {"FIBERBROWSER_GRAPH_HELPER": str(_exe(tmp_path / "env-helper")), "PATH": str(tmp_path)}
    assert launcher.find_graph_helper(str(flag), env) == (str(flag), "--graph-helper")


def test_environment_variable_used_without_flag(launcher, tmp_path):
    helper = _exe(tmp_path / "env-helper")
    assert launcher.find_graph_helper(None, {"FIBERBROWSER_GRAPH_HELPER": str(helper), "PATH": ""}) == (
        str(helper), "FIBERBROWSER_GRAPH_HELPER")


def test_helper_on_path_used_without_flag_or_variable(launcher, tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    helper = _exe(bindir / "fiberbrowser-graph")
    assert launcher.find_graph_helper(None, {"PATH": str(bindir)}) == (str(helper), "PATH")


def test_nothing_found_leaves_the_server_to_search(launcher, tmp_path):
    assert launcher.find_graph_helper(None, {"PATH": str(tmp_path)}) == (None, None)


def test_found_helper_reaches_the_server_environment(launcher, tmp_path, monkeypatch):
    """The server's environment drops inherited FIBERBROWSER_* variables, so the helper found in the launcher's own
    environment must be passed on explicitly (before this, a set FIBERBROWSER_GRAPH_HELPER was thrown away)."""
    helper = _exe(tmp_path / "env-helper")
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    mapfile = tmp_path / "map.chain"
    mapfile.write_text("")
    bam = tmp_path / "a.bam"
    bam.write_text("")
    monkeypatch.setenv("FIBERBROWSER_GRAPH_HELPER", str(helper))
    a = launcher.parse_args(["--sample", "S", str(bam), "--map", str(mapfile), "--graph-package", str(pkg),
                             "--fasta", str(tmp_path / "none.fa"), "--home", str(tmp_path / "home")])
    launcher.check_inputs(a)
    a.home = str(tmp_path / "home")
    env = launcher.server_env(a)
    assert env["FIBERBROWSER_GRAPH_HELPER"] == str(helper)
    assert a.graph_helper_source == "FIBERBROWSER_GRAPH_HELPER"


# ── Demo loci ────────────────────────────────────────────────────────────────

def _span(text):
    chrom, a, b = re.search(r"(chr\w+):([\d,]+)-([\d,]+)", text).groups()
    return chrom, int(a.replace(",", "")), int(b.replace(",", ""))


def test_default_locus_is_the_alu_demo(launcher, tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "WORK", str(tmp_path))
    a = launcher.parse_args([])
    assert a.locus == "alu"
    assert a.sample == [["Sample A", str(tmp_path / "demo_data" / "sample_a.alu_chr3.hg002v1.1.bam"),
                         str(tmp_path / "demo_data" / "sample_a.alu_chr3.GRCh38.bam")]]
    assert a.view == "chr3:128,653,000-128,661,000" and a.locus_note is None


def test_mhc_locus_loads_its_samples_view_and_the_not_carrier_note(launcher, tmp_path, monkeypatch):
    """--locus mhc: the MHC slice (lifted and native) at the paternal-only deletion where graph clustering shows
    "Not a carrier", and a note under the start link naming the region (and its BED, once it is in demo_data/)."""
    monkeypatch.setattr(launcher, "WORK", str(tmp_path))
    a = launcher.parse_args(["--locus", "mhc"])
    assert a.sample == [["Sample A", str(tmp_path / "demo_data" / "sample_a.mhc.hg002v1.1.bam"),
                         str(tmp_path / "demo_data" / "sample_a.mhc.GRCh38.bam")]]
    assert a.view == "chr6:31,044,530-31,045,730"
    assert "chr6:31,045,089-31,045,177" in a.locus_note and "chr6:31,045,099-31,045,167" in a.locus_note
    assert "import" not in a.locus_note and "Option-drag" in a.locus_note
    bed = tmp_path / "demo_data" / "sample_a.mhc.not_carrier_region.bed"
    bed.parent.mkdir()
    bed.write_text("chr6\t31045098\t31045167\n")
    assert f"import {bed}" in launcher.parse_args(["--locus", "mhc"]).locus_note


def test_mhc_region_lies_inside_the_deletion_and_the_view(launcher):
    """A region touching either flank is carried by the paternal path too (no "Not a carrier"): the printed region
    stays strictly inside the deletion, and the start view shows the whole deletion."""
    mhc = launcher.LOCI["mhc"]
    chrom, d0, d1 = _span(mhc["note"])
    rchrom, r0, r1 = _span(mhc["region"])
    vchrom, v0, v1 = _span(mhc["view"])
    assert chrom == rchrom == vchrom == "chr6"
    assert d0 < r0 < r1 < d1 and r1 - r0 >= 10   # (a drawn graph region is at least 10 bp)
    assert v0 < d0 and d1 < v1 and v1 - v0 <= 50_000   # (graph mode hands off to linear past 50 kb)


def test_explicit_samples_and_view_override_the_locus(launcher, tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "WORK", str(tmp_path))
    a = launcher.parse_args(["--locus", "mhc", "--sample", "S", "/data/s.bam", "--view", "chr6:1-100"])
    assert a.sample == [["S", "/data/s.bam"]] and a.view == "chr6:1-100"
    assert a.locus_note is None   # the note is about the locus's own demo data
    assert launcher.parse_args(["--locus", "mhc", "--sample", "S", "/data/s.bam"]).view == "chr6:31,044,530-31,045,730"
