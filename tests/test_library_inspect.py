"""The Library reads headers only: chemistry from the v1 declaration, reference
identity, read count from the index, QC and pipeline outputs beside the BAM,
cloud placeholders untouched, and FiberHMM advisories when available."""
from __future__ import annotations

import os
import sys
import types

import pytest

from library_fixtures import (
    make_bam, make_fiberhmm_bam, make_fibertools_bam, make_pipeline_run, md5, seq, write_qc_json,
)
from services import library_inspect as inspect


def test_fiberhmm_bam_header(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "embryo_2-4h.fiberhmm.dddb.bam", sample="embryo 2-4h", date="2026-08-06")
    info = inspect.inspect_file(bam)
    assert info["kind"] == "bam"
    assert info["chemistry"]["key"] == "dddb" and info["chemistry"]["declared"] is True
    assert info["chemistry"]["platform"] == "nanopore"
    assert info["fiberhmm"]["fiberhmm_version"] == "3.0.0" and info["fiberhmm"]["version_source"] == "@PG"
    assert info["reference"]["genome"] == "dm6" and info["reference"]["plasmid"] is False
    assert [c["name"] for c in info["reference"]["contigs"]] == ["chr2L", "chrX"]
    assert info["reads"] == 6 and info["mapped"] == 6
    assert info["sample"] == "embryo 2-4h"
    assert info["date"] == "2026-08-06" and info["date_source"] == "@RG DT"
    assert len(info["identity"]["header_sha256"]) == 64
    assert info["identity"]["size"] == os.path.getsize(bam)


def test_fibertools_and_other_bams_are_unknown(tmp_path):
    # FiberBrowser's loader guesses Hia5 from fibertools provenance; the Library does not.
    fibertools = inspect.inspect_file(make_fibertools_bam(tmp_path / "ft.bam"))
    plain = inspect.inspect_file(make_bam(tmp_path / "plain.bam"))
    assert fibertools["chemistry"] == {"key": "unknown", "declared": False}
    assert plain["chemistry"]["key"] == "unknown"
    assert "fiberhmm_version" not in plain["fiberhmm"]


def test_pre_v1_fiberhmm_bam_is_inferred_from_its_call_record(tmp_path):
    legacy = make_bam(tmp_path / "old.bam", programs=[{
        "ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "2.16.7",
        "DS": "mode=daf enzyme=dddb", "CL": "fiberhmm-call -i a.bam -o b.bam --mode daf --enzyme dddb"}])
    chemistry = inspect.inspect_file(legacy)["chemistry"]
    assert chemistry["key"] == "dddb" and chemistry["declared"] is False and chemistry["inferred"] is True


def test_declared_table_digests_and_version_are_kept(tmp_path):
    declaration = ("FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf;"
                   "fiberhmm_version=3.0.1;fiberhmm_commit=abc1234;apply_sha256=aa11;recall_sha256=bb22")
    info = inspect.inspect_file(make_bam(tmp_path / "x.bam", comments=[declaration]))
    assert info["chemistry"]["key"] == "ddda"
    assert info["fiberhmm"]["fiberhmm_version"] == "3.0.1"
    assert info["fiberhmm"]["apply_sha256"] == "aa11" and info["fiberhmm"]["recall_sha256"] == "bb22"
    assert info["fiberhmm"]["version_source"] == "declaration"


def test_no_index_means_no_read_count_and_no_index_is_written(tmp_path):
    bam = make_bam(tmp_path / "noindex.bam", index=False)
    before = sorted(os.listdir(tmp_path))
    info = inspect.inspect_file(bam)
    assert info["reads"] is None
    assert sorted(os.listdir(tmp_path)) == before


def test_sample_name_from_file_name(tmp_path):
    assert inspect.sample_from_name("/x/XYZ789_3_construct_a.fiberhmm.dddb.bam") == "XYZ789_3_construct_a"
    assert inspect.sample_from_name("/x/A3.aligned.sorted.bam") == "A3"
    assert inspect.sample_from_name("/x/stage_d_recalled.bam") == "stage_d"


def test_qc_json_beside_the_bam(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "s.fiberhmm.bam")
    write_qc_json(tmp_path / "qc" / "s.fiberhmm.qc.json", overall="WARN", duplicate_fraction=0.31)
    info = inspect.inspect_file(bam)
    qc = info["qc"]
    assert qc["verdicts"]["overall"] == "WARN" and qc["verdicts"]["periodicity"] == "WARN"
    assert qc["verdicts"]["overall_score"] == 81.2 and qc["verdicts"]["duplicate_fraction"] == 0.31
    assert qc["numbers"]["nrl_bp"] == 187.0 and qc["numbers"]["sampled_reads"] == 5000
    assert qc["curves"].endswith("s.fiberhmm.qc.curves.json")


STATE_QC = os.path.join(os.path.dirname(__file__), "fixtures", "qc_state_aware")


def test_state_aware_qc_json_beside_the_bam(tmp_path):
    """fiberhmm-qc 3.0 (state-aware; real output for the demo BAM): the Library keeps
    efficiency and background with their scores, the verdict basis and the in-MSP /
    outside-MSP rates; the badge's overall verdict is the state-aware one."""
    import shutil
    bam = make_fiberhmm_bam(tmp_path / "napa_ddda.bam")
    os.makedirs(tmp_path / "qc")
    for name in ("napa_ddda.qc.json", "napa_ddda.qc.curves.json"):
        shutil.copy(os.path.join(STATE_QC, name), tmp_path / "qc" / name)
    qc = inspect.inspect_file(bam)["qc"]
    verdicts, numbers = qc["verdicts"], qc["numbers"]
    assert verdicts["overall"] == "WARN" and verdicts["verdict_basis"] == "state-aware"
    assert verdicts["signal"] == "FAIL"  # reported, not in the state-aware verdict
    assert verdicts["efficiency"] == "WARN" and verdicts["efficiency_score"] == 67.5
    assert verdicts["background"] == "PASS" and verdicts["background_score"] == 96.3
    assert numbers["state_source"] == "tags"
    assert numbers["msp_rate"] == pytest.approx(0.6212, abs=1e-4)
    assert numbers["outside_msp_rate"] == pytest.approx(0.1684, abs=1e-4)
    assert numbers["msp_to_outside_ratio"] == pytest.approx(3.661, abs=1e-3)
    assert numbers["msp_length_fraction"] == pytest.approx(0.2907, abs=1e-4)
    assert numbers["overall_state_rate"] == pytest.approx(0.3085, abs=1e-4)
    assert qc["curves"].endswith("napa_ddda.qc.curves.json")


def test_older_qc_json_has_no_state_fields(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "s.fiberhmm.bam")
    write_qc_json(tmp_path / "qc" / "s.fiberhmm.qc.json")
    qc = inspect.inspect_file(bam)["qc"]
    assert not {"efficiency", "background", "verdict_basis"} & set(qc["verdicts"])
    assert not set(inspect.STATE_NUMBER_KEYS) & set(qc["numbers"])


def test_outputs_json_state_verdicts_without_the_qc_json(tmp_path):
    """outputs.json qc.verdicts from fiberhmm-pipeline 3.0 (state-aware) when its QC JSON
    is gone: flat verdicts kept, the nested state_rates summary becomes numbers."""
    import json
    outputs = make_pipeline_run(tmp_path / "run", sample="S7")
    out_json = tmp_path / "run" / "outputs.json"
    data = json.loads(out_json.read_text())
    data["qc"]["verdicts"] = {
        "overall": "WARN", "overall_score": 69.9, "signal": "FAIL", "periodicity": "WARN",
        "efficiency": "WARN", "efficiency_score": 67.5, "background": "PASS", "background_score": 96.3,
        "verdict_basis": "state-aware",
        "state_rates": {"source": "light_call", "overall_rate": 0.31, "msp_rate": 0.62, "outside_msp_rate": 0.17,
                        "aggregate_msp_rate": 0.618, "aggregate_outside_msp_rate": 0.169,
                        "msp_to_outside_ratio": 3.66, "msp_length_fraction": 0.29, "min_msp_bp": 85},
    }
    out_json.write_text(json.dumps(data))
    os.remove(data["qc"]["json"])
    os.remove(data["qc"]["curves"])
    qc = inspect.inspect_file(outputs["called_bam"])["qc"]
    assert qc["source"] == "outputs.json" and qc["json"] is None
    assert qc["verdicts"]["efficiency"] == "WARN" and qc["verdicts"]["background"] == "PASS"
    assert qc["verdicts"]["verdict_basis"] == "state-aware" and "state_rates" not in qc["verdicts"]
    assert qc["numbers"] == {"state_source": "light_call", "msp_rate": 0.62, "outside_msp_rate": 0.17,
                             "msp_to_outside_ratio": 3.66, "msp_length_fraction": 0.29, "overall_state_rate": 0.31}


def test_no_qc_files_no_qc(tmp_path):
    assert "qc" not in inspect.inspect_file(make_fiberhmm_bam(tmp_path / "s.bam"))


def test_pipeline_outputs_json(tmp_path):
    outputs = make_pipeline_run(tmp_path / "run", sample="S7")
    called = inspect.inspect_file(outputs["called_bam"])
    aligned = inspect.inspect_file(outputs["aligned_bam"])
    assert called["role"] == "called" and aligned["role"] == "aligned"
    assert called["sample"] == "S7"
    assert called["pipeline"]["aligned_bam"] == outputs["aligned_bam"]
    assert called["qc"]["source"] == "outputs.json" and called["qc"]["verdicts"]["overall"] == "PASS"
    assert "qc" not in aligned


def test_plasmid_bam_and_map(tmp_path):
    sequence = seq(3)
    outputs = make_pipeline_run(tmp_path / "prun", plasmid_seq=sequence)
    bam = inspect.inspect_file(outputs["called_bam"])
    ref = bam["reference"]
    assert ref["plasmid"] is True and ref["genome"] is None
    assert ref["contigs"][0]["circular"] is True and ref["contigs"][0]["md5"] == md5(sequence)
    assert ref["plasmid_maps"][0]["path"] == outputs["plasmid_map"]
    plasmid = inspect.inspect_file(outputs["plasmid_map"])
    assert plasmid["kind"] == "plasmid_map"
    assert plasmid["reference"]["contigs"][0]["md5"] == md5(sequence)


def test_cloud_placeholder_is_not_opened(tmp_path, monkeypatch):
    placeholder = tmp_path / "offline.bam"
    placeholder.write_bytes(b"")
    import pysam
    monkeypatch.setattr(pysam, "AlignmentFile", lambda *a, **k: pytest.fail("opened a cloud placeholder"))
    info = inspect.inspect_file(str(placeholder))
    assert info["cloud_only"] is True and "chemistry" not in info


def test_unreadable_file_is_listed_with_an_error(tmp_path):
    bad = tmp_path / "broken.bam"
    bad.write_bytes(b"not a bam at all" * 10)
    info = inspect.inspect_file(str(bad))
    assert info["error"] and info["identity"]["size"] == 160


def _bed_to_bigbed():
    import shutil
    return shutil.which("bedToBigBed") or next(
        (p for p in (os.path.expanduser("~/ucsc_tools/bedToBigBed"),) if os.path.isfile(p)), None)


def test_bigbed(tmp_path):
    import subprocess
    tool = _bed_to_bigbed()
    if tool is None:
        pytest.skip("bedToBigBed is not installed")
    (tmp_path / "fp.bed").write_text("chr2L\t100\t250\tr1\nchr2L\t300\t420\tr2\n")
    (tmp_path / "sizes").write_text("chr2L\t23513712\nchrX\t23542271\n")
    subprocess.run([tool, str(tmp_path / "fp.bed"), str(tmp_path / "sizes"), str(tmp_path / "fp.bb")],
                   check=True, capture_output=True)
    info = inspect.inspect_file(str(tmp_path / "fp.bb"))
    assert info["kind"] == "bigbed" and "error" not in info
    assert info["reference"]["genome"] == "dm6" and info["reads"] is None
    assert info["chemistry"]["key"] == "unknown"


# ---------------------------------------------------------------------------
# Advisories (fiberhmm.advisories, optional)
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_advisories(monkeypatch):
    module = types.ModuleType("fiberhmm.advisories")
    calls = []

    def check_header(header):
        calls.append(header)
        declared = any("dddb" in str(c) for c in header.get("CO", []))
        if not declared:
            return []
        return [{"id": "dddb-table-gt-swap", "severity": "rerun-required",
                 "title": "DddB Nanopore table", "reason": "called with the pre-3.0 table",
                 "affected": "footprint tags", "fix": "fiberhmm-pipeline", "confidence": "high"}]

    module.check_header = check_header
    module.check_bam = lambda path: []
    import fiberhmm
    monkeypatch.setitem(sys.modules, "fiberhmm.advisories", module)
    monkeypatch.setattr(fiberhmm, "advisories", module, raising=False)
    return calls


def test_advisories_when_the_module_exists(tmp_path, fake_advisories):
    info = inspect.inspect_file(make_fiberhmm_bam(tmp_path / "x.bam"))
    advisories = info["advisories"]
    assert advisories["items"][0]["severity"] == "rerun-required"
    assert advisories["key"].startswith(info["identity"]["header_sha256"])
    assert inspect.needs_rerun(advisories) == "rerun-required"
    assert len(fake_advisories) == 1


def test_no_advisories_module_shows_nothing(tmp_path, monkeypatch):
    import fiberhmm
    monkeypatch.setitem(sys.modules, "fiberhmm.advisories", None)  # import fails
    monkeypatch.delattr(fiberhmm, "advisories", raising=False)
    info = inspect.inspect_file(make_fiberhmm_bam(tmp_path / "x.bam"))
    assert "advisories" not in info
    assert inspect.needs_rerun(None) is None


def test_a_failing_advisories_module_never_breaks_inspection(tmp_path, fake_advisories, monkeypatch):
    def boom(header):
        raise RuntimeError("bad table registry")
    monkeypatch.setattr(sys.modules["fiberhmm.advisories"], "check_header", boom)
    info = inspect.inspect_file(make_fiberhmm_bam(tmp_path / "x.bam"))
    assert "advisories" not in info and "error" not in info


# --- Review round 4: sidecars (malformed, cloud-only) -----------------------

def _dataless(monkeypatch, *paths):
    """Simulate macOS SF_DATALESS (Dropbox online-only) on these paths; nothing is hydrated."""
    real_stat = os.stat
    flagged = {os.path.abspath(str(p)) for p in paths}

    def fake_stat(path, *args, **kwargs):
        st = real_stat(path, *args, **kwargs)
        if isinstance(path, (str, os.PathLike)) and os.path.abspath(os.fspath(path)) in flagged:
            fields = ("st_mode", "st_size", "st_mtime_ns", "st_ino", "st_dev", "st_mtime")
            return types.SimpleNamespace(**{k: getattr(st, k) for k in fields}, st_flags=inspect.SF_DATALESS)
        return st

    monkeypatch.setattr(inspect.os, "stat", fake_stat)
    monkeypatch.setattr(inspect.sys, "platform", "darwin")


def test_malformed_qc_json_keeps_the_bam_and_notes_the_sidecar(tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "data.bam")
    (tmp_path / "data.qc.json").write_text('{"signal": "invalid", "overall": ["x"], "deduplication": 3}')
    info = inspect.inspect_file(bam)  # raised AttributeError before
    assert "error" not in info and info["chemistry"]["key"] == "dddb" and info["reads"] == 6
    assert info["qc"]["json"].endswith("data.qc.json") and info["qc"]["verdicts"] == {}
    (tmp_path / "data.qc.json").write_text("[1, 2, 3]")
    info = inspect.inspect_file(bam)
    assert "error" not in info and info["sidecar_errors"] == ["data.qc.json: not a JSON object"]
    (tmp_path / "data.qc.json").write_text("{not json")
    assert "not readable JSON" in inspect.inspect_file(bam)["sidecar_errors"][0]


def test_malformed_outputs_json_keeps_the_bam(tmp_path):
    run = make_pipeline_run(tmp_path / "run")
    outputs = tmp_path / "run" / "outputs.json"
    import json
    raw = json.loads(outputs.read_text())
    raw.update(sample={"not": "a name"}, open="nope", qc={"json": 5, "verdicts": "PASS"})
    outputs.write_text(json.dumps(raw))
    info = inspect.inspect_file(run["called_bam"])
    assert "error" not in info and info["pipeline"]["sample"] is None and info["sample"] == "S1"
    assert info["qc"]["verdicts"]["overall"] == "PASS"  # from the qc/ JSON beside it


def test_an_unexpected_sidecar_failure_never_costs_the_entry(tmp_path, monkeypatch):
    bam = make_fiberhmm_bam(tmp_path / "data.bam")
    write_qc_json(tmp_path / "data.qc.json")
    monkeypatch.setattr(inspect, "qc_summary_for_bam", lambda *a, **k: 1 / 0)
    info = inspect.inspect_file(bam)
    assert "error" not in info and info["reads"] == 6 and "qc" not in info
    assert info["sidecar_errors"] == ["QC: ZeroDivisionError: division by zero"]


def test_cloud_only_sidecars_and_index_are_never_opened(tmp_path, monkeypatch):
    bam = make_fiberhmm_bam(tmp_path / "data.bam")
    qc = write_qc_json(tmp_path / "data.qc.json", curves=False)
    _dataless(monkeypatch, qc, bam + ".bai")
    assert inspect.stat_identity(qc)["cloud_only"] is True
    assert inspect.read_small_json(qc) is None  # opened and parsed it before
    import builtins
    real_open = builtins.open
    monkeypatch.setattr(builtins, "open", lambda path, *a, **k: pytest.fail(f"opened {path}")
                        if os.path.abspath(str(path)) == qc else real_open(path, *a, **k))
    import pysam
    real_alignment_file = pysam.AlignmentFile

    def checked_alignment_file(*args, **kwargs):
        assert kwargs.get("index_filename") is None, "the cloud-only index was handed to pysam"
        return real_alignment_file(*args, **kwargs)

    monkeypatch.setattr(pysam, "AlignmentFile", checked_alignment_file)
    info = inspect.inspect_file(bam)
    assert "error" not in info and info["chemistry"]["key"] == "dddb"
    assert info["reads"] is None and info["index_path"] is None  # the index was not read either
    assert "verdicts" not in (info.get("qc") or {}) or not info["qc"]["verdicts"]
    assert sorted(info["sidecars_online_only"]) == sorted([qc, bam + ".bai"])
    assert info["sidecars"][qc][3] is True  # stamped: a rescan notices when it is downloaded


def test_an_index_outside_the_approved_folder_is_not_read(tmp_path):
    outside = make_fiberhmm_bam(tmp_path / "outside" / "o.bam")
    watched = tmp_path / "watched"
    watched.mkdir()
    import shutil
    shutil.copy(outside, watched / "d.bam")
    os.symlink(outside + ".bai", watched / "d.bam.bai")
    info = inspect.inspect_file(str(watched / "d.bam"), root=str(watched))
    assert info["index_path"] is None and info["reads"] is None
    assert inspect.inspect_file(str(watched / "d.bam"))["reads"] is None  # outside its own folder too


def test_an_unusable_bai_does_not_hide_a_usable_csi(tmp_path):
    import pysam
    watched = tmp_path / "watched"
    bam = make_fiberhmm_bam(watched / "d.bam", index=False)
    pysam.index("-c", bam)  # d.bam.csi
    make_fiberhmm_bam(tmp_path / "outside" / "o.bam")
    os.symlink(tmp_path / "outside" / "o.bam.bai", watched / "d.bam.bai")
    info = inspect.inspect_file(bam, root=str(watched))
    assert info["index_path"] == bam + ".csi" and info["reads"] == 6


def test_qc_json_sections_override_outputs_json_scores_and_keep_its_state_numbers(tmp_path):
    """The QC JSON decides a component it has (an ungraded one keeps no stale
    outputs.json score); a QC JSON without a state block keeps outputs.json's rates."""
    import json
    outputs = make_pipeline_run(tmp_path / "run", sample="S8")
    out_json = tmp_path / "run" / "outputs.json"
    data = json.loads(out_json.read_text())
    data["qc"]["verdicts"].update({"efficiency": "PASS", "efficiency_score": 80.0,
                                   "state_rates": {"source": "tags", "msp_rate": 0.5}})
    out_json.write_text(json.dumps(data))
    qc_json = json.loads(open(data["qc"]["json"]).read())
    qc_json["efficiency"] = {"status": "INSUFFICIENT", "score": None, "value": None}
    with open(data["qc"]["json"], "w") as handle:
        json.dump(qc_json, handle)
    qc = inspect.inspect_file(outputs["called_bam"])["qc"]
    assert qc["verdicts"]["efficiency"] == "INSUFFICIENT" and "efficiency_score" not in qc["verdicts"]
    assert qc["numbers"]["msp_rate"] == 0.5 and qc["numbers"]["state_source"] == "tags"
    assert qc["numbers"]["nrl_bp"] == 187.0
