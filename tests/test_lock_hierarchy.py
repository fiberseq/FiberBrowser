"""The lock hierarchy (services/lock_order) and Codex round 5's reproductions on integ/fb62.

Hierarchy: 0 operation -> 1 state -> 2 panel context -> 3 panel registry -> 4 download. tests/conftest.py turns
the order checker on for every test.
"""
import asyncio
import hashlib
import json
import socket
import threading
import time

import pysam
import pytest

import services.dataset_registration as registration
from state.browser_state import BrowserState


def _alive(*threads):
    return [t for t in threads if t.is_alive()]


# --- the checker -----------------------------------------------------------------------------------------


def test_the_checker_refuses_an_inverted_order_and_allows_reentry():
    from services import lock_order
    from services.download_locks import download_lock
    from services.genome_loading import state_lock
    from services.panel_genomes import _LOCK
    assert lock_order.CHECK
    state = BrowserState(None)
    with state_lock(state), _LOCK, download_lock("x"):        # 1 -> 3 -> 4
        with state_lock(state):                                # re-entry is fine
            pass
    with download_lock("y"):
        with pytest.raises(lock_order.LockOrderError):
            with state_lock(state):
                pass
    with _LOCK:
        with pytest.raises(lock_order.LockOrderError):
            with state_lock(BrowserState(None)):
                pass
    assert lock_order.held_locks() == []


# --- 1. insertion registration vs a session import restoring one (deadlock) ----------------------------


def test_opening_an_insertion_while_a_session_import_restores_one_never_deadlocks(tmp_path, monkeypatch):
    from insertion_fixtures import SITE, make_insertion_bam
    import services.alt_allele as alt_allele
    import services.sessions_endpoint as sessions_endpoint
    from models.requests import SessionExportRequest, SessionImportRequest
    monkeypatch.setenv("FIBERBROWSER_ALT_ALLELE_DIR", str(tmp_path / "alt"))
    fixture = make_insertion_bam(tmp_path / "ins")
    origin = BrowserState(None)
    assert origin._load_fasta(fixture["fasta"]) is None
    origin.add_dataset("ins", fixture["bam"], label="insertion")
    alt_allele.open_alt_allele(origin, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000})
    session = json.loads(json.dumps(sessions_endpoint.build_session_export_for_request(
        origin, SessionExportRequest(chrom="chrT", start=0, end=30000))["session"], default=str))

    state = BrowserState(None)
    assert state._load_fasta(fixture["fasta"]) is None
    state.add_dataset("ins", fixture["bam"], label="insertion")
    importing = threading.Event()
    real_import, real_build = sessions_endpoint._import_session, alt_allele.ensure_built
    first = [True]

    def import_session(*a, **k):
        importing.set()                      # the import holds the state lock from here
        return real_import(*a, **k)

    def ensure_built(*a, **k):
        out = real_build(*a, **k)
        if first[0]:
            first[0] = False
            importing.wait(10)               # the opener registers only once the import holds the lock
        return out
    monkeypatch.setattr(sessions_endpoint, "_import_session", import_session)
    monkeypatch.setattr(alt_allele, "ensure_built", ensure_built)
    opener = threading.Thread(target=lambda: alt_allele.open_alt_allele(state, "ins", {"chrom": "chrT", "pos": SITE, "flank": 3000}),
                              daemon=True)
    importer = threading.Thread(target=lambda: sessions_endpoint.import_session_for_request(
        state, SessionImportRequest(session=session)), daemon=True)
    opener.start()
    time.sleep(0.2)
    importer.start()
    opener.join(60)
    importer.join(60)
    assert not _alive(opener, importer), "insertion open and session import deadlocked"


# --- 2. merge/unmerge by identity ------------------------------------------------------------------------


def _bam(path, chr1=5000):
    path.parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header={"HD": {"VN": "1.6", "SO": "coordinate"},
                                                      "SQ": [{"SN": "chr1", "LN": chr1}]}):
        pass
    pysam.index(str(path))
    return str(path)


def _pause_inspection(monkeypatch, match, fail=False):
    paused, resume = threading.Event(), threading.Event()
    real = registration.configure_bam_dataset_layers

    def configure(dataset, primary_path):
        if any(match in str(p) for p in dataset.paths):
            paused.set()
            resume.wait(10)
            if fail:
                raise RuntimeError("cannot open")
        return real(dataset, primary_path)
    monkeypatch.setattr(registration, "configure_bam_dataset_layers", configure)
    return paused, resume


def test_a_merge_whose_source_was_replaced_meanwhile_fails_and_keeps_the_replacement(tmp_path, monkeypatch):
    from models.requests import AddDatasetRequest, MergeDatasetsRequest
    from services.dataset_endpoint import add_dataset_for_request, merge_datasets_for_request
    state = BrowserState(None)
    state.add_dataset("a", _bam(tmp_path / "old" / "a.bam"))
    state.add_dataset("b", _bam(tmp_path / "old" / "b.bam"))
    paused, resume = _pause_inspection(monkeypatch, "old/a.bam")       # the merged dataset's inspection
    out = {}
    merger = threading.Thread(target=lambda: out.update(merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))))
    merger.start()
    assert paused.wait(10)
    state.remove_dataset("a")
    added = add_dataset_for_request(state, AddDatasetRequest(path=_bam(tmp_path / "new" / "a.bam")))
    assert added["success"] and added["dataset"]["id"] == "a"
    replacement = state.datasets["a"]
    resume.set()
    merger.join(10)
    assert out["success"] is False
    assert state.datasets.get("a") is replacement                        # never deleted by the stale merge
    assert set(state.datasets) == {"a", "b"} and len(state.dataset_order) == 2


def test_an_unmerge_rollback_never_removes_a_child_replaced_meanwhile(tmp_path, monkeypatch):
    from models.requests import AddDatasetRequest, UnmergeDatasetsRequest
    from services.dataset_endpoint import add_dataset_for_request, unmerge_dataset_for_request
    state = BrowserState(None)
    state.add_dataset("pair", [_bam(tmp_path / "p" / "one.bam"), _bam(tmp_path / "p" / "two.bam")])
    paused, resume = _pause_inspection(monkeypatch, "p/two.bam", fail=True)   # the second child fails
    out = {}
    splitter = threading.Thread(target=lambda: out.update(unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="pair"))))
    splitter.start()
    assert paused.wait(10)
    assert "one" in state.datasets                                         # the first child is published
    state.remove_dataset("one")
    added = add_dataset_for_request(state, AddDatasetRequest(path=_bam(tmp_path / "new" / "one.bam")))
    assert added["success"] and added["dataset"]["id"] == "one"
    replacement = state.datasets["one"]
    resume.set()
    splitter.join(10)
    assert out["success"] is False
    assert state.datasets.get("one") is replacement and "pair" in state.datasets


# --- 3. one owner for a panel view's reference -----------------------------------------------------------


def test_a_plasmid_publication_on_a_panel_view_takes_the_contexts_lock(tmp_path, monkeypatch):
    from services import panel_genomes
    from services.genome_loading import reference_lock
    from services.plasmid_maps import PlasmidMap
    from routers.genome import _load_plasmid_into_state
    state = BrowserState(None)
    ctx = panel_genomes._empty_context()
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    view = panel_genomes.genome_view(state, "other")
    plasmid = PlasmidMap(name="pX", sequence="ACGT" * 500, circular=True, features=[])
    done = threading.Event()
    with reference_lock(panel_genomes.genome_view(state, "other")):       # a FASTA load on another view of it
        writer = threading.Thread(target=lambda: (_load_plasmid_into_state(view, plasmid, str(tmp_path / "pX.gb")), done.set()))
        writer.start()
        assert not done.wait(2.0)                                       # waits for the context, not only the base
        assert "pX" not in (ctx.plasmid_sequences or {})
    writer.join(5)
    assert done.is_set() and "pX" in ctx.plasmid_sequences and "pX" not in (state.plasmid_sequences or {})


# --- 4. a plasmid match published only for the map and dataset it was made against -----------------------


def test_a_stale_plasmid_match_is_not_published(tmp_path, monkeypatch):
    import random
    import services.plasmid_reconcile as pr
    from routers.genome import _load_plasmid_into_state
    from services.plasmid_maps import parse_plasmid_map
    from test_plasmid_reconcile import write_bam, write_map

    def seq(seed):
        rng = random.Random(seed)
        return "".join(rng.choice("ACGT") for _ in range(3000))
    old, new = seq(1), seq(2)
    state = BrowserState(None)
    _load_plasmid_into_state(state, parse_plasmid_map(write_map(tmp_path / "pM.gb", "pM", old)), str(tmp_path / "pM.gb"))
    real_match = pr.match_contig

    def match(*a, **k):
        result = real_match(*a, **k)
        # The map is replaced (same name, another sequence) after the match, before its publication.
        _load_plasmid_into_state(state, parse_plasmid_map(write_map(tmp_path / "pM2.gb", "pM", new)), str(tmp_path / "pM2.gb"))
        return result
    monkeypatch.setattr(pr, "match_contig", match)
    dataset = state.add_dataset("d", write_bam(tmp_path / "d.bam", "pM_aln", old, m5=True))
    links = [l for m in pr._plasmid_maps(state).values() for l in (m.get("links") or [])]
    assert not any(l.get("dataset_id") == "d" and l.get("verified") for l in links), links
    assert not any(l.get("dataset_id") == "d" for l in (dataset.plasmid_report or {}).get("links") or [])


# --- 5. downloads give up -------------------------------------------------------------------------------


def test_a_stalled_download_times_out(tmp_path):
    from port_list import free_ports
    from services.http_download import fetch
    port = free_ports()[0]
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(1)
    held = []
    threading.Thread(target=lambda: held.append(server.accept()), daemon=True).start()   # accepts, never answers
    started = time.monotonic()
    try:
        with pytest.raises(OSError):
            fetch(f"http://127.0.0.1:{port}/genome.fa", str(tmp_path / "g.fa"), timeout=0.5)
        assert time.monotonic() - started < 5
    finally:
        for conn, _ in held:
            conn.close()
        server.close()


# --- 6. catalog loads per workspace and group -------------------------------------------------------------


def test_two_concurrent_catalog_loads_then_an_unload_leave_nothing_open(tmp_path, monkeypatch):
    import services.catalog_endpoint as catalog
    state = BrowserState(None)
    monkeypatch.setattr(catalog, "_remote_entry_problems", lambda locations: [])
    catalog.set_catalog({"groups": [{"datasets": [{"path": _bam(tmp_path / "c" / "sample.bam"), "label": "S"}]}]})
    paused, resume = _pause_inspection(monkeypatch, "c/sample.bam")
    try:
        results = []
        loads = [threading.Thread(target=lambda: results.append(catalog.catalog_load_payload(state, 0))) for _ in range(2)]
        for t in loads:
            t.start()
        assert paused.wait(10)
        time.sleep(0.2)
        resume.set()
        for t in loads:
            t.join(10)
        assert [r["dataset_ids"] for r in results] == [["catalog_0_0"], ["catalog_0_0"]]
        assert list(state.datasets) == ["catalog_0_0"]
        catalog.catalog_unload_payload(state, 0)
        assert state.datasets == {} and state.dataset_order == []
    finally:
        catalog.set_catalog(None)
