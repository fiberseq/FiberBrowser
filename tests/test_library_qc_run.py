"""Run QC from the Library: fiberhmm-qc on an entry's BAM without opening it, remembered
with the entry for that file version only, refused where it can't run."""
from __future__ import annotations

import json
import os
import shlex
import sys

import pytest

from library_fixtures import make_fiberhmm_bam
from services import library_store as store

FAKE_QC = r'''
import json, os, sys
args = sys.argv[1:]
bam, out = args[args.index("-i") + 1], args[args.index("-o") + 1]
with open(os.environ["FAKE_QC_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
stem = os.path.basename(bam)[:-4] if bam.endswith(".bam") else os.path.basename(bam)
qc = {"schema_version": 1, "input": bam, "overall": {"status": os.environ.get("FAKE_QC_STATUS", "PASS"), "score": 80.0},
      "signal": {"status": "PASS", "score": 90.0, "label": "deamination", "median_per_read_rate": 0.2},
      "periodicity": {"status": "WARN", "score": 55.0, "nrl_bp": 187.0},
      "outputs": {"plot": os.path.join(out, stem + ".qc.png")}}
with open(os.path.join(out, stem + ".qc.json"), "w") as h:
    json.dump(qc, h)
with open(os.path.join(out, stem + ".qc.curves.json"), "w") as h:
    json.dump({"schema": "fiberhmm.qc.curves.v1"}, h)
with open(os.path.join(out, stem + ".qc.png"), "wb") as h:
    h.write(b"\x89PNG fake")
'''


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    from services.library_hooks import wait_idle
    wait_idle(20)
    monkeypatch.setenv("FIBERBROWSER_LIBRARY", str(tmp_path / "home" / "library.json"))
    monkeypatch.setenv("FIBERBROWSER_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("FIBERBROWSER_QC_CACHE_DIR", str(tmp_path / "qc_cache"))
    script = tmp_path / "fake_qc.py"
    script.write_text(FAKE_QC)
    monkeypatch.setenv("FIBERBROWSER_QC_COMMAND", f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}")
    monkeypatch.setenv("FAKE_QC_LOG", str(tmp_path / "fake_qc.log"))
    # The fixture BAMs are on dm6's contigs: never this computer's downloaded genomes.
    from services import pipeline_inputs
    monkeypatch.setattr(pipeline_inputs, "catalog_genome_fasta", lambda genome: (None, "not downloaded"))
    return tmp_path


def _runs(tmp_path) -> list[list[str]]:
    log = tmp_path / "fake_qc.log"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def _add(client, path) -> str:
    return client.post("/api/library/entries", json={"paths": [str(path)]}).json()["ids"][0]


def _listed(client, entry_id) -> dict:
    return next(e for e in client.get("/api/library").json()["entries"] if e["id"] == entry_id)


def test_run_qc_on_an_entry_and_remember_it(client, tmp_path):
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    assert "verdicts" not in (_listed(client, entry_id).get("qc") or {})

    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is True and body["entry_id"] == entry_id and body["remembered"] is True
    assert body["available"] and body["qc"]["overall"]["status"] == "PASS"
    assert body["curves"]["schema"] == "fiberhmm.qc.curves.v1"
    assert body["enzyme"] == "dddb" and body["reference"] is None and "reference FASTA" in body["reference_note"]
    key = body["cache_key"]
    assert body["plots"] == {"plot": f"/api/library/entries/{entry_id}/qc/files/plot"}
    assert "json_path" not in body
    # The run was told the entry's chemistry, wrote into FiberBrowser's cache and nothing beside the BAM.
    (args,) = _runs(tmp_path)
    assert args[args.index("--enzyme") + 1] == "dddb" and args[args.index("-o") + 1] == str(tmp_path / "qc_cache" / key)
    assert sorted(os.listdir(tmp_path / "d")) == ["a.fiberhmm.bam", "a.fiberhmm.bam.bai"]
    assert client.get(body["plots"]["plot"]).content == b"\x89PNG fake"
    assert client.get(f"/api/qc/files/{key}/plot").content == b"\x89PNG fake"
    assert client.get(f"/api/library/entries/{entry_id}/qc/files/nope").status_code == 404

    # The table's QC column and filter read it; the details show the full report.
    listed = _listed(client, entry_id)
    assert listed["qc"]["verdicts"]["overall"] == "PASS" and listed["qc"]["verdicts"]["periodicity"] == "WARN"
    assert listed["qc"]["json"] and "qc_run" not in listed
    payload = client.get(f"/api/library/entries/{entry_id}/qc").json()
    assert payload["available"] and payload["qc"]["overall"]["status"] == "PASS"
    assert payload["plots"] == {"plot": f"/api/library/entries/{entry_id}/qc/files/plot"} and payload["curves"]

    # Kept on disk (an app restart reads library.json again), and through a rescan.
    saved = json.loads(open(store.library_file()).read())["entries"][entry_id]["qc_run"]
    assert saved["cache_key"] == key and saved["verdicts"]["overall"] == "PASS"
    assert client.post(f"/api/library/entries/{entry_id}/rescan").json()["success"]
    assert _listed(client, entry_id)["qc"]["verdicts"]["overall"] == "PASS"

    # A second run of the same file version is the cached result.
    again = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert again["success"] and again["cache_key"] == key and len(_runs(tmp_path)) == 1


def test_the_genome_fasta_is_passed_when_it_is_on_this_computer(client, tmp_path, monkeypatch):
    from services import pipeline_inputs
    fasta = tmp_path / "genomes" / "dm6.fa"
    fasta.parent.mkdir()
    fasta.write_text(">chr2L\nACGT\n")
    monkeypatch.setattr(pipeline_inputs, "catalog_genome_fasta", lambda genome: (str(fasta), None))
    entry_id = _add(client, make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam"))
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] and body["reference"] == str(fasta) and body["reference_note"] is None
    (args,) = _runs(tmp_path)
    assert args[args.index("--reference") + 1] == str(fasta)


def test_a_changed_file_is_not_shown_with_its_old_qc(client, tmp_path, monkeypatch):
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    first = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert _listed(client, entry_id)["qc"]["verdicts"]["overall"] == "PASS"

    with open(bam, "ab") as handle:  # new size and modification time
        handle.write(b"\0" * 64)
    assert "verdicts" not in (_listed(client, entry_id).get("qc") or {})
    assert client.get(f"/api/library/entries/{entry_id}/qc").json()["available"] is False

    monkeypatch.setenv("FAKE_QC_STATUS", "FAIL")
    second = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert second["success"] and second["cache_key"] != first["cache_key"] and len(_runs(tmp_path)) == 2
    assert _listed(client, entry_id)["qc"]["verdicts"]["overall"] == "FAIL"

    # Only the modification time changes: also a new file version.
    os.utime(bam, ns=(os.stat(bam).st_atime_ns, os.stat(bam).st_mtime_ns + 5_000_000_000))
    assert "verdicts" not in (_listed(client, entry_id).get("qc") or {})


def test_the_cache_key_is_the_file_version_chemistry_and_reference(tmp_path):
    from services.qc_view import cache_key
    bam = make_fiberhmm_bam(tmp_path / "a.bam")
    fasta = tmp_path / "ref.fa"
    fasta.write_text(">p\nACGT\n")
    keys = {cache_key(bam), cache_key(bam, "dddb"), cache_key(bam, "auto", str(fasta))}
    assert len(keys) == 3
    fasta.write_text(">p\nACGTACGT\n")  # the same reference path, other contents
    assert cache_key(bam, "auto", str(fasta)) not in keys
    with open(bam, "ab") as handle:
        handle.write(b"\0")
    assert cache_key(bam) not in keys


def test_refusals(client, tmp_path):
    def entry(path, kind):
        return store.record({"kind": kind, "path": path, "folder": os.path.dirname(path), "label": os.path.basename(path)},
                            "added")["id"]

    bigbed = tmp_path / "d" / "tracks.bb"
    bigbed.parent.mkdir(parents=True)
    bigbed.write_bytes(b"not really")
    cases = {
        entry(str(bigbed), "bigbed"): "not a BAM",
        entry("ssh://cluster/data/a.bam", "bam"): "cluster",
        entry(str(tmp_path / "gone" / "a.bam"), "bam"): "Locate",
    }
    for entry_id, why in cases.items():
        body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
        assert body["success"] is False and why in body["error"], body
    assert client.post("/api/library/entries/e-none/qc/run", json={}).status_code == 404
    assert _runs(tmp_path) == []


def test_an_online_only_file_is_downloaded_only_when_confirmed(client, tmp_path, monkeypatch):
    from services import library_inspect as inspect
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    real_identity = inspect.stat_identity
    monkeypatch.setattr(inspect, "stat_identity", lambda path: dict(real_identity(path), cloud_only=True)
                        if real_identity(path) and os.path.abspath(path) == bam else real_identity(path))
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is False and body["needs_confirmation"] is True and "downloads" in body["error"]
    assert _runs(tmp_path) == []
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={"confirm": True}).json()
    assert body["success"] is True and len(_runs(tmp_path)) == 1


def test_a_result_is_not_kept_for_an_entry_removed_or_a_file_changed_mid_run(client, tmp_path, monkeypatch):
    from services import qc_view
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    real_run = qc_view.run_dataset_qc

    def removed_meanwhile(*args, **kwargs):
        store.remove_entries([entry_id])
        return real_run(*args, **kwargs)

    monkeypatch.setattr(qc_view, "run_dataset_qc", removed_meanwhile)
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is True and body["remembered"] is False

    entry_id = _add(client, bam)

    def changed_meanwhile(*args, **kwargs):
        payload = real_run(*args, **kwargs)
        with open(bam, "ab") as handle:
            handle.write(b"\0" * 8)
        return payload

    monkeypatch.setattr(qc_view, "run_dataset_qc", changed_meanwhile)
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is False and "changed while QC ran" in body["error"]
    assert "qc_run" not in store.load()["entries"][entry_id]


def test_a_timed_out_or_unfinished_run_is_never_a_cached_result(client, tmp_path, monkeypatch):
    import subprocess
    from services import qc_view
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    real_run = subprocess.run

    def times_out(argv, **kwargs):
        out = argv[argv.index("-o") + 1]
        with open(os.path.join(out, "a.fiberhmm.qc.json"), "w") as handle:
            handle.write("{\"overall\": {\"status\": \"PASS\"}}")  # written, then the run is cut off
        raise subprocess.TimeoutExpired(argv, 1)

    monkeypatch.setattr(qc_view.subprocess, "run", times_out)
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is False and "TimeoutExpired" in body["error"]
    assert "qc_run" not in store.load()["entries"][entry_id]
    monkeypatch.setattr(qc_view.subprocess, "run", real_run)
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is True and len(_runs(tmp_path)) == 1  # ran again, not the partial JSON

    # A folder another server process is still writing (no completion marker) is not a result either.
    os.remove(os.path.join(qc_view.qc_cache_dir(), body["cache_key"], qc_view.DONE_MARKER))
    assert "verdicts" not in (_listed(client, entry_id).get("qc") or {})


def test_a_placeholder_with_a_size_also_asks_first(client, tmp_path, monkeypatch):
    from services import cloud_placeholders
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    real = cloud_placeholders.availability
    monkeypatch.setattr(cloud_placeholders, "availability",
                        lambda path, st=None: "cloud" if os.path.abspath(str(path)) == bam else real(path, st))
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is False and body["needs_confirmation"] is True and _runs(tmp_path) == []
    # The Library's own record says online-only too (so adding or rescanning never reads it).
    assert _listed(client, entry_id)["cloud_only"] is True


def test_a_failed_run_is_shown_and_not_cached(client, tmp_path, monkeypatch):
    bam = make_fiberhmm_bam(tmp_path / "d" / "a.fiberhmm.bam")
    entry_id = _add(client, bam)
    monkeypatch.setenv("FIBERBROWSER_QC_COMMAND", f"{shlex.quote(sys.executable)} -c \"import sys; sys.exit('boom')\"")
    body = client.post(f"/api/library/entries/{entry_id}/qc/run", json={}).json()
    assert body["success"] is False and "fiberhmm-qc failed" in body["error"] and "boom" in body["error"]
    assert "qc_run" not in store.load()["entries"][entry_id]


def test_enzyme_and_reference_from_the_entry(tmp_path):
    from services.library_qc import entry_enzyme, entry_reference
    assert entry_enzyme({"chemistry": {"key": "hia5-pacbio"}}) == "hia5"
    assert entry_enzyme({"chemistry": {"key": "ddda"}}) == "ddda"
    assert entry_enzyme({"chemistry": {"key": "unknown"}}) == "auto"
    assert entry_enzyme({"chemistry": {"key": "conflict", "enzyme": "dddb"}}) == "auto"
    assert entry_enzyme({"chemistry": {"key": "unknown"}, "pipeline": {"enzyme": "DddB"}}) == "dddb"
    fasta = tmp_path / "ref.fa"
    fasta.write_text(">p\nACGT\n")
    gbk = tmp_path / "p.gbk"
    gbk.write_text("LOCUS")
    assert entry_reference({"pipeline": {"reference_fasta": str(fasta)}}) == str(fasta)
    assert entry_reference({"pipeline": {"plasmid_map": str(gbk)}}) is None  # a map is not a FASTA
    both = {"pipeline": {"plasmid_map": str(gbk), "reference_fasta": str(fasta)}}
    assert entry_reference(both) == str(fasta)
