"""Dataset mutations and reference publication under one state lock (Codex round 4, fb62).

Dataset routes now run in workers, which exposed races the event loop used to serialize: a dataset's header
chromosomes published over a FASTA loaded meanwhile; a failed merge/unmerge rolling back a concurrent add; two
adds of different sample.bam files both getting id ``sample``; a panel attach loading under the registry lock.
"""
import random
import threading
import time
from pathlib import Path

import pysam
import pytest

import services.dataset_registration as registration
import state.browser_state as browser_state_module
from state.browser_state import BrowserState


def _bam(path: Path, chr1: int = 5000) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header={"HD": {"VN": "1.6", "SO": "coordinate"},
                                                      "SQ": [{"SN": "chr1", "LN": chr1}]}):
        pass
    pysam.index(str(path))
    return str(path)


def _fasta(path: Path, chr1: int) -> str:
    path.write_text(">chr1\n" + "A" * chr1 + "\n")
    pysam.faidx(str(path))
    return str(path)


def _consistent(state):
    assert len(state.dataset_order) == len(set(state.dataset_order))
    assert set(state.dataset_order) == set(state.datasets)


def test_a_header_read_never_publishes_over_a_fasta_loaded_meanwhile(tmp_path, monkeypatch):
    from services.genome_loading import reference_lock
    state = BrowserState(None)
    reading, resume = threading.Event(), threading.Event()
    real = browser_state_module.detect_chroms_from_bam

    def paused(path):
        reading.set()
        resume.wait(5)
        return real(path)
    monkeypatch.setattr(browser_state_module, "detect_chroms_from_bam", paused)
    bam = _bam(tmp_path / "hg19.bam", chr1=249_250)
    adder = threading.Thread(target=state.add_dataset, args=("hg19", bam))
    adder.start()
    assert reading.wait(5)
    with reference_lock(state):
        assert state._load_fasta(_fasta(tmp_path / "hg38.fa", 248_956)) is None
    resume.set()
    adder.join(10)
    assert "hg19" in state.datasets
    assert [(c.name if hasattr(c, "name") else c["name"]) for c in state.chroms] == ["chr1"]
    size = state.chroms[0].size if hasattr(state.chroms[0], "size") else state.chroms[0]["size"]
    assert size == 248_956          # the FASTA's, not the dataset header's
    _consistent(state)


def _pausing_inspection(monkeypatch, fail_on: str):
    """Datasets whose path contains ``fail_on`` pause their file inspection, then fail."""
    inspecting, resume = threading.Event(), threading.Event()
    real = registration.configure_bam_dataset_layers

    def configure(dataset, primary_path):
        if fail_on in str(primary_path) or any(fail_on in str(p) for p in dataset.paths):
            inspecting.set()
            resume.wait(5)
            raise RuntimeError("cannot open")
        return real(dataset, primary_path)
    monkeypatch.setattr(registration, "configure_bam_dataset_layers", configure)
    return inspecting, resume


def test_a_failed_merge_never_removes_a_dataset_added_meanwhile(tmp_path, monkeypatch):
    from models.requests import AddDatasetRequest, MergeDatasetsRequest
    from services.dataset_endpoint import add_dataset_for_request, merge_datasets_for_request
    state = BrowserState(None)
    state.add_dataset("a", _bam(tmp_path / "a" / "a_bad.bam"))
    state.add_dataset("b", _bam(tmp_path / "b" / "b_bad.bam"))
    inspecting, resume = _pausing_inspection(monkeypatch, "_bad.bam")
    result = {}
    merger = threading.Thread(target=lambda: result.update(
        merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))))
    merger.start()
    assert inspecting.wait(5)
    added = add_dataset_for_request(state, AddDatasetRequest(path=_bam(tmp_path / "c" / "c.bam")))
    assert added["success"]
    resume.set()
    merger.join(10)
    assert result["success"] is False
    assert set(state.datasets) == {"a", "b", added["dataset"]["id"]}
    _consistent(state)


def test_a_failed_unmerge_never_removes_a_dataset_added_meanwhile(tmp_path, monkeypatch):
    from models.requests import AddDatasetRequest, UnmergeDatasetsRequest
    from services.dataset_endpoint import add_dataset_for_request, unmerge_dataset_for_request
    state = BrowserState(None)
    state.add_dataset("pair", [_bam(tmp_path / "p" / "one.bam"), _bam(tmp_path / "p" / "two_bad.bam")])
    inspecting, resume = _pausing_inspection(monkeypatch, "two_bad.bam")
    result = {}
    splitter = threading.Thread(target=lambda: result.update(
        unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="pair"))))
    splitter.start()
    assert inspecting.wait(5)
    added = add_dataset_for_request(state, AddDatasetRequest(path=_bam(tmp_path / "c" / "c.bam")))
    resume.set()
    splitter.join(10)
    assert result["success"] is False
    assert set(state.datasets) == {"pair", added["dataset"]["id"]}   # the half-made "one" is gone, "c" stays
    _consistent(state)


def test_two_files_with_one_name_get_two_ids(tmp_path, monkeypatch):
    state = BrowserState(None)
    started = threading.Barrier(2)
    real = registration.configure_bam_dataset_layers

    def configure(dataset, primary_path):
        started.wait(5)          # both allocated their id before either publishes
        return real(dataset, primary_path)
    monkeypatch.setattr(registration, "configure_bam_dataset_layers", configure)
    paths = [_bam(tmp_path / "x" / "sample.bam"), _bam(tmp_path / "y" / "sample.bam")]
    out = []
    threads = [threading.Thread(target=lambda p=p: out.append(state.add_dataset("sample", p))) for p in paths]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(d.id for d in out) == ["sample", "sample_1"]
    assert {d.paths[0] for d in state.datasets.values()} == set(paths)
    _consistent(state)


def test_attach_reloads_a_vanished_context_outside_the_registry_lock(tmp_path, monkeypatch):
    from services import panel_genomes
    state = BrowserState(None)
    state.add_dataset("x", _bam(tmp_path / "x.bam"))
    state.add_dataset("y", _bam(tmp_path / "y.bam"))
    loads, locked_during_load = [], []

    def registry(genome_id):
        # Is the process-wide registry lock free while loading? (another thread tries it)
        free = []
        probe = threading.Thread(target=lambda: free.append(panel_genomes._LOCK.acquire(timeout=0.5)
                                                            and (panel_genomes._LOCK.release() or True)))
        probe.start()
        probe.join()
        locked_during_load.append(not free[0])
        loads.append(genome_id)
        ctx = BrowserState(None)
        ctx._panel_genome_spec = {"kind": "registry", "genome_id": genome_id, "assembly": genome_id,
                                  "label": genome_id, "source": {"genome_id": genome_id}}
        return ctx
    monkeypatch.setattr(panel_genomes, "_load_registry", registry)
    panel_genomes.attach(state, ["y"], genome_id="mm10", span=0)
    assert loads == ["mm10"]
    real_prepare = panel_genomes._prepare_context
    first = [True]

    def prepare(*a, **k):
        prepared = real_prepare(*a, **k)
        if first[0]:
            first[0] = False
            assert prepared is None                      # it saw the existing context ...
            panel_genomes.detach(state, ["y"])           # ... which goes before it commits
        return prepared
    monkeypatch.setattr(panel_genomes, "_prepare_context", prepare)
    result = panel_genomes.attach(state, ["x"], genome_id="mm10", span=0)
    assert result["success"] and panel_genomes.assignments(state) == {"x": "mm10"}
    assert loads == ["mm10", "mm10"] and locked_during_load == [False, False]


def test_concurrent_mixed_mutations_keep_the_state_consistent(tmp_path):
    from models.requests import AddDatasetRequest, MergeDatasetsRequest, UnmergeDatasetsRequest
    from services.dataset_endpoint import (add_dataset_for_request, merge_datasets_for_request,
                                           unmerge_dataset_for_request)
    state = BrowserState(None)
    files = [_bam(tmp_path / f"d{i}" / "sample.bam") for i in range(12)]
    errors = []
    rng = random.Random(7)

    def worker(seed):
        r = random.Random(seed)
        for _ in range(15):
            try:
                ids = list(state.datasets)
                op = r.random()
                if op < 0.45 or len(ids) < 2:
                    add_dataset_for_request(state, AddDatasetRequest(path=r.choice(files)))
                elif op < 0.65:
                    state.remove_dataset(r.choice(ids))
                elif op < 0.85:
                    merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=r.sample(ids, 2)))
                else:
                    multi = [d for d, ds in list(state.datasets.items()) if len(ds.paths) > 1]
                    if multi:
                        unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id=r.choice(multi)))
                _consistent(state)
            except AssertionError as exc:
                errors.append(exc)
    threads = [threading.Thread(target=worker, args=(rng.random(),)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors
    _consistent(state)
    assert all(not hasattr(state, "_reserved_dataset_ids") or not state._reserved_dataset_ids for _ in [0])
