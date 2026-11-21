"""Recent and pinned genomes (owner requests, 3.1.0): the reference/annotation pairs the user loaded, server side.

Most recent first, deduplicated by real path (a registry genome once, download or cache), capped (pinned never
count), missing files listed as missing, pins in pin order that survive Clear recent, lab confinement, and the
matching against the data's contigs (index only, pinned first).
"""
import json
import os
import time

import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from state.browser_state import BrowserState


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    path = tmp_path / "recent.json"
    monkeypatch.setenv("FIBERBROWSER_RECENT_GENOMES", str(path))
    monkeypatch.setenv("FIBERBROWSER_PREFERENCES", str(tmp_path / "prefs.json"))
    return path


def _fasta(path, contigs):
    with open(path, "w") as fh:
        for name, length in contigs:
            fh.write(f">{name}\n" + "A" * length + "\n")
    pysam.faidx(str(path))
    return str(path)


def _gtf(path, chrom="c1"):
    attrs = 'gene_id "g"; gene_name "G1"; transcript_id "t";'
    with open(path, "w") as fh:
        for f in ("gene", "transcript", "exon"):
            fh.write(f"{chrom}\tt\t{f}\t2\t9\t.\t+\t.\t{attrs}\n")
    return str(path)


def _state_with(fasta, gtf=None):
    state = BrowserState(None)
    assert state._load_fasta(fasta) is None
    if gtf:
        from services.gene_annotations import load_gtf
        state.gtf_data = load_gtf(gtf)
        state.gtf_path = gtf
    return state


def _client(state):
    from routers.genome import router
    from state.dependencies import get_state
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    return TestClient(app)


def test_order_dedupe_by_real_path_and_registry_once(tmp_path, store):
    from services import recent_genomes as rg
    a = _fasta(tmp_path / "a.fa", [("c1", 20)])
    b = _fasta(tmp_path / "b.fa", [("c1", 30)])
    os.symlink(a, tmp_path / "a_link.fa")
    os.symlink(a + ".fai", tmp_path / "a_link.fa.fai")
    rg.record(_state_with(a))
    time.sleep(0.01)
    rg.record(_state_with(b))
    time.sleep(0.01)
    rg.record(_state_with(str(tmp_path / "a_link.fa")))     # the same file by another name: once, most recent
    names = [e["fasta_name"] for e in rg.listing()["recent"]]
    assert names == ["a.fa", "b.fa"]
    # A registry genome counts once, however it was loaded.
    s = BrowserState(None)
    s.current_genome, s.fasta, s.fasta_path = "dm6", object(), "https://s3.amazonaws.com/x/dm6.fa"
    rg.record(s)
    s.registry_fasta = ("dm6", "/cache/dm6.fa")
    s.fasta_path = "/cache/dm6.fa"
    rg.record(s)
    keys = [e["key"] for e in rg.listing()["recent"]]
    assert keys.count("registry:dm6") == 1 and keys[0] == "registry:dm6"
    assert json.loads(store.read_text())["schema"] == rg.SCHEMA


def test_the_annotation_is_paired_and_kept(tmp_path, store):
    from services import recent_genomes as rg
    fa = _fasta(tmp_path / "custom.fa", [("c1", 20)])
    gtf = _gtf(tmp_path / "custom.gtf")
    rg.record(_state_with(fa, gtf))
    rg.record(_state_with(fa))      # the FASTA again, its annotation not loaded yet: the pair stays
    (entry,) = rg.listing()["recent"]
    assert entry["gtf_name"] == "custom.gtf" and entry["gtf_exists"] is True and entry["exists"] is True


def test_cap_and_missing_files(tmp_path, store, monkeypatch):
    from services import recent_genomes as rg
    from services.analysis_preferences import update_preferences
    paths = [_fasta(tmp_path / f"g{i}.fa", [("c1", 10 + i)]) for i in range(11)]
    for p in paths:
        rg.record(_state_with(p))
        time.sleep(0.002)
    assert len(rg.listing()["recent"]) == 8                     # the default N
    update_preferences({"recent_genomes_max": 3})
    listed = rg.listing()
    assert listed["max"] == 3 and [e["fasta_name"] for e in listed["recent"]] == ["g10.fa", "g9.fa", "g8.fa"]
    monkeypatch.setattr(rg, "MAX_RECENT", 5)
    rg.record(_state_with(paths[0]))
    assert len(json.loads(store.read_text())["entries"]) == 5   # the file keeps at most MAX_RECENT
    os.remove(paths[0])
    first = rg.listing()["recent"][0]
    assert first["fasta_name"] == "g0.fa" and first["exists"] is False
    assert [e["fasta_name"] for e in rg.remove(first["key"])["recent"]][0] == "g10.fa"


def test_pin_unpin_order_clear_and_cap(tmp_path, store):
    from services import recent_genomes as rg
    from services.analysis_preferences import update_preferences
    update_preferences({"recent_genomes_max": 2})
    p = [_fasta(tmp_path / f"p{i}.fa", [("c1", 10 + i)]) for i in range(5)]
    for path in p:
        rg.record(_state_with(path))
        time.sleep(0.002)
    key = {os.path.basename(e["fasta"]): e["key"] for e in rg.listing(limit=10)["recent"]}
    rg.set_pinned(key["p0.fa"], True)
    rg.set_pinned(key["p2.fa"], True)
    listed = rg.set_pinned(key["p1.fa"], True)
    assert [e["fasta_name"] for e in listed["pinned"]] == ["p0.fa", "p2.fa", "p1.fa"]   # in the order pinned
    assert [e["fasta_name"] for e in listed["recent"]] == ["p4.fa", "p3.fa"]            # pinned don't count
    listed = rg.reorder_pinned([key["p1.fa"], key["p0.fa"]])
    assert [e["fasta_name"] for e in listed["pinned"]] == ["p1.fa", "p0.fa", "p2.fa"]
    listed = rg.clear_recent()
    assert listed["recent"] == [] and len(listed["pinned"]) == 3                        # Clear recent keeps pins
    os.remove(p[2])
    assert next(e for e in rg.listing()["pinned"] if e["fasta_name"] == "p2.fa")["exists"] is False  # stays listed
    listed = rg.set_pinned(key["p0.fa"], False)                                          # back to Recent
    assert [e["fasta_name"] for e in listed["pinned"]] == ["p1.fa", "p2.fa"]
    assert [e["fasta_name"] for e in listed["recent"]] == ["p0.fa"]
    # Persisted: a fresh read of the file (a restarted server) lists the same.
    assert [e["key"] for e in rg.listing()["pinned"]] == [key["p1.fa"], key["p2.fa"]]


def test_lab_confinement_and_members(tmp_path, store, monkeypatch):
    from services import recent_genomes as rg
    import services.lab.paths as lab_paths
    import services.runtime as runtime
    inside_dir = tmp_path / "data"
    inside_dir.mkdir()
    inside = _fasta(inside_dir / "in.fa", [("c1", 20)])
    outside = _fasta(tmp_path / "out.fa", [("c1", 21)])
    member = type("U", (), {"name": "ann"})()
    s_in, s_out = _state_with(inside), _state_with(outside)
    monkeypatch.setattr(lab_paths, "enforcing", lambda: True)
    monkeypatch.setattr(lab_paths, "allowed", lambda path, write=False: os.path.realpath(path).startswith(str(inside_dir)))
    monkeypatch.setattr(runtime, "current_lab_user", lambda: member)
    rg.record(s_in)
    rg.record(s_out)                                # outside the member's data roots: never recorded
    assert [e["fasta_name"] for e in rg.listing()["recent"]] == ["in.fa"]
    monkeypatch.setattr(runtime, "current_lab_user", lambda: type("U", (), {"name": "bob"})())
    assert rg.listing()["recent"] == []             # another member's entries are theirs


def test_routes_open_with_its_annotation_and_refuse_public(tmp_path, store, monkeypatch):
    from services import recent_genomes as rg
    fa = _fasta(tmp_path / "custom.fa", [("c1", 20)])
    gtf = _gtf(tmp_path / "custom.gtf")
    rg.record(_state_with(fa, gtf))
    key = rg.listing()["recent"][0]["key"]
    fresh = BrowserState(None)
    client = _client(fresh)
    body = client.post("/api/recent_genomes/open", json={"key": key}).json()
    assert body["success"] and body["fasta_loaded"] and body["gtf_loaded"] and body["gene_count"] == 1
    assert os.path.realpath(fresh.fasta_path) == os.path.realpath(fa) and fresh.gtf_path == os.path.realpath(gtf)
    # Opened again: already loaded, nothing reloaded.
    monkeypatch.setattr(fresh, "_load_fasta", lambda *a, **k: pytest.fail("reloaded"))
    assert client.post("/api/recent_genomes/open", json={"key": key}).json()["already_loaded"] is True
    os.remove(fa)
    missing = client.post("/api/recent_genomes/open", json={"key": key}).json()
    assert missing["success"] is False and missing["missing"] is True
    assert client.post("/api/recent_genomes/pin", json={"key": key, "pinned": True}).json()["pinned"][0]["key"] == key
    assert client.post("/api/recent_genomes/clear").json()["pinned"][0]["key"] == key
    monkeypatch.setattr("services.runtime.get_public_mode", lambda: True)
    assert client.get("/api/recent_genomes").status_code == 403
    assert client.post("/api/recent_genomes/open", json={"key": key}).status_code == 403


def test_best_match_scores_the_index_and_prefers_pinned(tmp_path, store):
    from services import recent_genomes as rg
    data = {f"chr{i}": 100 + i for i in range(8)}
    full = _fasta(tmp_path / "full.fa", list(data.items()))
    also_full = _fasta(tmp_path / "also_full.fa", list(data.items()) + [("extra", 5)])
    partial = _fasta(tmp_path / "partial.fa", list(data.items())[:7] + [("chr7", 999)])
    other = _fasta(tmp_path / "other.fa", [("zz", 10)])
    for p in (partial, other, full, also_full):
        rg.record(_state_with(p))
        time.sleep(0.002)
    current = {"chr0": 100, "chr1": 101}       # 2 of 8 match now
    m = rg.best_match(data, current)
    assert m["matched"] == 8 and m["fit"] == "all 8 contigs match" and m["fasta_name"] == "also_full.fa"
    rg.set_pinned(next(e["key"] for e in rg.listing()["recent"] if e["fasta_name"] == "full.fa"), True)
    assert rg.best_match(data, current)["fasta_name"] == "full.fa"      # pinned first on a tie
    # Nothing clearly better: no offer.
    assert rg.best_match(data, dict(data)) is None
    assert rg.best_match({"q1": 5, "q2": 6}, {}) is None
    # Partial fits say so; missing files are skipped.
    os.remove(full)
    os.remove(also_full)
    m = rg.best_match(data, {})
    assert m["fasta_name"] == "partial.fa" and m["fit"] == "7 of 8 contigs match" and m["current_matched"] == 0
    # Not clearly better than a reference that already matches 7: no offer.
    assert rg.best_match(data, {k: v for k, v in list(data.items())[:7]}) is None


def test_fai_scores_are_cached_by_mtime(tmp_path, store, monkeypatch):
    from services import recent_genomes as rg
    fa = _fasta(tmp_path / "x.fa", [("c1", 20)])
    assert rg.fai_contigs(fa) == {"c1": 20}
    calls = []
    real_open = open
    monkeypatch.setattr("builtins.open", lambda *a, **k: (calls.append(a[0]), real_open(*a, **k))[1])
    assert rg.fai_contigs(fa) == {"c1": 20} and calls == []


def test_writes_hold_a_lock_other_server_processes_wait_for(tmp_path, store):
    """Audit (final 3.1.0, MED): every port and the app share recent_genomes.json; a read-modify-write holds a file
    lock another process can't take meanwhile, so two pins made at once in two servers both stay."""
    import subprocess
    import sys
    from services import recent_genomes as RG
    probe = ("import fcntl, sys\n"
             "f = open(sys.argv[1], 'a')\n"
             "try:\n    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n    sys.exit(3)\n"
             "sys.exit(0)\n")
    lock_path = str(RG.store_path().with_suffix('.lock'))
    with RG._locked():
        assert subprocess.run([sys.executable, '-c', probe, lock_path]).returncode == 3
    assert subprocess.run([sys.executable, '-c', probe, lock_path]).returncode == 0
