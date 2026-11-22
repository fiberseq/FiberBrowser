"""Scripted figures: session path remap and placeholder checks, receipts, and the ``fiberbrowser render`` CLI."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import headless_figure_data as hfd
from fiberbrowser import scripted

REPO = Path(__file__).resolve().parents[1]


# -- remap and file checks ----------------------------------------------------------------------------------

def test_remap_rewrites_the_longest_prefix_and_checks_files(tmp_path):
    paths = hfd.write_datasets(tmp_path / "local" / "deep")
    session = hfd.session({k: v.replace(str(tmp_path / "local"), "/old/root") for k, v in paths.items()})
    session["frontend"]["historySnapshots"] = [{"big": "x" * 10}]
    mapping = {"/old/": "/nowhere/", "/old/root/": str(tmp_path / "local") + "/"}
    out, files = scripted.remap_session(session, mapping)
    assert [d["paths"][0] for d in out["datasets"]] == [paths["ds-a"], paths["ds-b"]]
    assert "historySnapshots" not in out["frontend"]
    assert paths["ds-a"] in files and paths["ds-a"] + ".bai" in files
    assert session["datasets"][0]["paths"][0].startswith("/old/root/")  # the input is not changed


def test_missing_and_zero_size_files_fail_loudly(tmp_path):
    paths = hfd.write_datasets(tmp_path)
    Path(paths["ds-b"] + ".bai").unlink()
    Path(paths["ds-a"]).write_bytes(b"")
    with pytest.raises(scripted.SessionFileError) as err:
        scripted.remap_session(hfd.session(paths))
    assert err.value.missing == [paths["ds-b"] + ".bai"]
    assert err.value.online_only == [(paths["ds-a"], "zero-size file")]
    assert "MISSING" in str(err.value) and "ONLINE-ONLY" in str(err.value)
    scripted.remap_session(hfd.session(paths), check=False)


def _fake_stat(**fields):
    base = dict(st_size=1000, st_blocks=8, st_flags=0, st_file_attributes=0, st_mtime=0)
    base.update(fields)
    return SimpleNamespace(**base)


@pytest.mark.parametrize("fields, reason", [
    ({"st_flags": scripted.SF_DATALESS, "st_blocks": 0}, "macOS dataless (online-only) file"),
    ({"st_file_attributes": scripted.WIN_RECALL_ON_DATA_ACCESS}, "Windows offline/recall-on-access attribute"),
    ({"st_file_attributes": scripted.WIN_OFFLINE}, "Windows offline/recall-on-access attribute"),
    ({"st_blocks": 0}, "no data blocks on disk"),
    ({}, None),
])
def test_placeholder_detection_reads_stat_only(monkeypatch, fields, reason):
    monkeypatch.setattr(scripted.os, "stat", lambda path: _fake_stat(**fields))
    monkeypatch.setattr(scripted, "_wsl_reason", lambda path: None)
    assert scripted.placeholder_reason("/data/x.bam") == reason


# -- receipt --------------------------------------------------------------------------------------------------

def test_receipt_fields(tmp_path):
    paths = hfd.write_datasets(tmp_path)
    out = tmp_path / "panel.pdf"
    out.write_bytes(b"%PDF-1.4 test")
    session_file = tmp_path / "s.json"
    session_file.write_text(json.dumps(hfd.session(paths)))
    manifest = {"sample_seed": "s1", "panels": [{"panel_id": "p", "dataset_id": "ds-a", "label": "A", "reads_drawn": 7}]}
    files = [paths["ds-a"], paths["ds-a"] + ".bai"]
    receipt = scripted.build_receipt(output=str(out), session=hfd.session(paths), session_path=str(session_file),
                                     files=files, manifest=manifest, options={"sample_seed": "s1"}, hash_mode="fast")
    assert receipt["fiberbrowser"]["version"]
    assert receipt["seed"] == "s1" and receipt["read_counts"][0]["reads_drawn"] == 7
    assert receipt["session"]["file_sha256"] == scripted.file_hash(str(session_file))
    first = receipt["inputs"][0]
    assert first["path"] == paths["ds-a"] and first["size"] == os.path.getsize(paths["ds-a"])
    assert first["hash"].startswith("fast:") and "mtime" in first
    full = scripted.build_receipt(output=str(out), session={}, session_path=None, files=files[:1], manifest=None,
                                  options={}, hash_mode="sha256")
    assert len(full["inputs"][0]["sha256"]) == 64


def test_git_commit_from_an_archive_stamp(monkeypatch, tmp_path):
    monkeypatch.setattr(scripted, "app_root", lambda: tmp_path)  # not a git checkout
    assert scripted.git_commit() in (None, os.environ.get("FIBERBROWSER_GIT"))
    monkeypatch.setenv("FIBERBROWSER_GIT", "abc123")
    assert scripted.git_commit() == "abc123"


def test_cli_options_map_to_figure_arguments():
    a = scripted._parser().parse_args([
        "s.json", "--out", "p.pdf", "--seed", "S", "--spanning-only", "--size", "180x120mm", "--hide", "sv,coverage",
        "--dpi", "600", "--min-font", "6", "--fonts", "truetype", "--max-reads", "ds-a=50", "--max-reads", "ds-b=40",
        "--bed", "x.bed", "--classes", "--stats", "--target", "6000-6060"])
    kw = scripted.options_from_args(a)
    assert kw["sample_seed"] == "S" and kw["spanning_only"] is True
    assert kw["page_size"] == "180x120mm" and kw["raster_dpi"] == 600 and kw["min_font_pt"] == 6
    assert kw["hide_tracks"] == ["sv", "coverage"] and kw["pdf_fonts"] == "truetype"
    assert kw["max_reads"] == {"ds-a": 50, "ds-b": 40}
    assert kw["annotations"]["target"] == [6000, 6060] and kw["annotations"]["stats"] == {"per": "both"}
    assert kw["annotations"]["classes"]["thresholds"] == [175.0, 300.0, 500.0]
    plain = scripted.options_from_args(scripted._parser().parse_args(["s.json", "--out", "p.pdf"]))
    assert plain == {}


# -- end to end: a real headless server ------------------------------------------------------------------------

@pytest.mark.slow
def test_render_cli_end_to_end(tmp_path):
    from browser_client import BrowserClient
    from port_list import free_test_port
    pypdf = pytest.importorskip("pypdf")

    paths = hfd.write_datasets(tmp_path / "data")
    session = hfd.session({k: v.replace(str(tmp_path / "data"), "/old/place") for k, v in paths.items()})
    session_file = tmp_path / "fig.json"
    session_file.write_text(json.dumps(session))
    remap = ["--remap", f"/old/place={tmp_path / 'data'}"]
    env = {**os.environ, "PYTHONPATH": str(REPO)}

    def cli(*args):
        port = free_test_port()
        run = subprocess.run([sys.executable, "-m", "fiberbrowser", "render", str(session_file), *remap,
                              "--port", str(port), *args], cwd=str(REPO), env=env, capture_output=True, text=True,
                             timeout=300)
        assert run.returncode == 0, run.stderr[-2000:]
        return run

    # 1. No options: byte-identical to BrowserClient.figure() on the same (remapped) session.
    plain = tmp_path / "plain.pdf"
    cli("--out", str(plain), "--hash", "fast")
    remapped, _files = scripted.remap_session(session, {"/old/place": str(tmp_path / "data")})
    with BrowserClient.headless(port=free_test_port(), timeout=120, quiet=True) as client:
        direct = client.figure(session=remapped, load_session=True, format="pdf", engine="headless")
        # The client's re-cluster call: same seed, same assignments.
        r1 = client.recluster_session(remapped, method="kmeans", k=3, seed="e2e")
        r2 = client.recluster_session(remapped, method="kmeans", k=3, seed="e2e")
        assert r1["session"]["frontend"]["clusterAssignments"] == r2["session"]["frontend"]["clusterAssignments"]
    assert plain.read_bytes() == direct
    receipt = json.loads((tmp_path / "plain.pdf.receipt.json").read_text())
    assert receipt["output"]["sha256"] == scripted.file_hash(str(plain))
    assert {p["dataset_id"]: p["reads_drawn"] for p in receipt["read_counts"]} == {"ds-a": 60, "ds-b": 60}
    assert receipt["session"]["file_sha256"] == scripted.file_hash(str(session_file))
    assert receipt["fiberbrowser"]["git_commit"]

    # 2. Every option: re-cluster, seed, spanning, size, hidden SV strip, dpi, min font, TrueType, annotations.
    bed = tmp_path / "sites.bed"
    bed.write_text("chrS\t6000\t6060\tsite-1\n")
    out = tmp_path / "panel.pdf"
    run = cli("--out", str(out), "--seed", "S", "--spanning-only", "--size", "180x120mm", "--hide", "sv",
              "--dpi", "300", "--min-font", "6", "--fonts", "truetype", "--max-reads", "40",
              "--recluster", "kmeans:3", "--cluster-tsv", str(tmp_path / "clusters.tsv"),
              "--bed", str(bed), "--classes", "--stats", "--read-ids")
    assert "wrote" in run.stdout
    page = pypdf.PdfReader(io.BytesIO(out.read_bytes())).pages[0]
    assert float(page.mediabox.width) == pytest.approx(180 * 72 / 25.4, abs=0.01)
    receipt = json.loads((tmp_path / "panel.pdf.receipt.json").read_text())
    assert receipt["seed"] == "S" and receipt["cluster"]["k"] == 3 and receipt["cluster"]["seed"] == "S"
    assert receipt["options"]["hide_tracks"] == ["sv"]
    panels = receipt["manifest"]["panels"]
    assert all(p["reads_drawn"] == 40 and len(p["read_ids"]) == 40 for p in panels)
    assert all("annotation" in p for p in panels)
    assert (tmp_path / "clusters.tsv").exists() and (tmp_path / "clusters.counts.tsv").exists()

    # 3. A missing file fails before any server starts.
    bad = subprocess.run([sys.executable, "-m", "fiberbrowser", "render", str(session_file), "--out",
                          str(tmp_path / "x.pdf")], cwd=str(REPO), env=env, capture_output=True, text=True, timeout=120)
    assert bad.returncode == 2 and "MISSING" in bad.stderr


@pytest.mark.slow
def test_recluster_is_identical_across_processes(tmp_path):
    """Two fresh processes with different hash seeds: same assignments, counts and PDF."""
    from port_list import free_test_port
    paths = hfd.write_datasets(tmp_path / "data")
    session_file = tmp_path / "s.json"
    session_file.write_text(json.dumps(hfd.session(paths)))
    outputs = []
    for hash_seed in ("1", "98765"):
        env = {**os.environ, "PYTHONPATH": str(REPO), "PYTHONHASHSEED": hash_seed}
        out = tmp_path / f"p{hash_seed}.pdf"
        run = subprocess.run([sys.executable, "-m", "fiberbrowser", "render", str(session_file), "--out", str(out),
                              "--port", str(free_test_port()), "--recluster", "kmeans:4", "--cluster-seed", "det",
                              "--cluster-tsv", str(tmp_path / f"c{hash_seed}.tsv"), "--no-receipt"],
                             cwd=str(REPO), env=env, capture_output=True, text=True, timeout=300)
        assert run.returncode == 0, run.stderr[-2000:]
        outputs.append(((tmp_path / f"c{hash_seed}.tsv").read_text(),
                        (tmp_path / f"c{hash_seed}.counts.tsv").read_text(), out.read_bytes()))
    assert outputs[0] == outputs[1]


def test_render_session_clusters_the_render_region_and_checks_a_call_bed(tmp_path):
    """Release audit 3.1.1: a --region render re-clustered the saved view; a --bed given with the call was neither
    checked nor hashed in the receipt."""
    from fiberbrowser import scripted
    bed = tmp_path / "overlay.bed"
    bed.write_text("chr1\t10\t20\tx\n")
    calls = {}

    class Fake:
        def recluster_session(self, data, **kw):
            calls["recluster"] = kw
            return {"session": data}

        def figure(self, **kw):
            calls["figure"] = kw
            return b"%PDF-fake", {"panels": []}

    out = tmp_path / "fig.pdf"
    info = scripted.render_session({"frontend": {}}, str(out), client=Fake(), recluster={"method": "kmeans", "k": 2},
                                   region="chr1:100-200", annotations={"bed": str(bed)})
    assert calls["recluster"]["region"] == "chr1:100-200"
    assert any(f.get("path") == str(bed) and f.get("sha256") for f in info["inputs"]), info["inputs"]
    with pytest.raises(scripted.SessionFileError):
        scripted.render_session({"frontend": {}}, str(out), client=Fake(), annotations={"bed": str(tmp_path / "missing.bed")})
