"""Datasets on two assemblies at start-up (fb-n1-bugs 3).

`browser.py --dataset hg38.bam --dataset dm6.bam --fasta hg38.fa` opened on
the store's built-in locus (chr2L:1,000,000) under hg38's chromosome list,
with no reads in either panel: /api/status gave no initial position as soon
as any dataset didn't fit the loaded genome. The main view now opens on the
reads of the datasets it shows on the loaded genome; a dataset on another
assembly (or with its own panel genome) no longer decides it, and only when
no dataset fits does the view stay put.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import services.panel_genomes as panel_genomes
import services.random_window as rw
from services.genome_check import main_genome_dataset_ids
from test_genome_check import DM6_FASTA, DEMO_BAM, HG38_FASTA, FakeFasta, _bam, _dataset, _state

DM6_CONTIGS = {k: v for k, v in DM6_FASTA.items() if k != "chrY"}


def test_main_genome_datasets_leave_out_another_assembly(tmp_path):
    human = _dataset("human", str(DEMO_BAM))
    fly = _dataset("fly", _bam(tmp_path, "fly.bam", DM6_CONTIGS))
    state = _state([fly, human], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38")
    assert main_genome_dataset_ids(state) == ["human"]
    # dm6 loaded instead: the fly dataset is the main view's.
    state = _state([fly, human], fasta=DM6_FASTA, fasta_path="/refs/dm6.fa", current_genome="dm6")
    assert main_genome_dataset_ids(state) == ["fly"]


def test_main_genome_datasets_leave_out_one_with_its_own_panel_genome(tmp_path, monkeypatch):
    human = _dataset("human", str(DEMO_BAM))
    other = _dataset("other", str(DEMO_BAM))
    state = _state([human, other], fasta=HG38_FASTA, fasta_path="/refs/hg38.fa", current_genome="hg38")
    monkeypatch.setattr(panel_genomes, "dataset_genome", lambda _s, d: "own" if d == "other" else None)
    assert main_genome_dataset_ids(state) == ["human"]


def test_covered_window_search_can_be_limited_to_some_datasets():
    a = SimpleNamespace(id="a", data_type="bam", paths=["a.bam"])
    b = SimpleNamespace(id="b", data_type="bam", paths=["b.bam"])
    state = SimpleNamespace(dataset_order=["a", "b"], get_dataset={"a": a, "b": b}.get)
    assert rw._search_datasets(state, None) == [a, b]
    assert rw._search_datasets(state, None, ["b"]) == [b]
    assert rw._search_datasets(state, None, []) == []


def test_cached_start_position_follows_the_reference(monkeypatch):
    """Same datasets, another reference: the start position is sampled again, not reused."""
    from state.browser_state import BrowserState

    calls = []

    def fake_window(state, *, span, seed, max_attempts, dataset_ids):
        calls.append(tuple(dataset_ids))
        chrom = state.chroms[0].name
        return {"success": True, "chrom": chrom, "start": 100, "end": 300, "max_coverage": 5}

    monkeypatch.setattr(rw, "random_covered_window", fake_window)
    state = SimpleNamespace(dataset_order=["a"], datasets={"a": SimpleNamespace(paths=["a.bam"])},
                            chroms=[SimpleNamespace(name="chr1", size=1000), SimpleNamespace(name="chr2", size=900)],
                            fasta=None, fasta_path="/refs/one.fa", current_genome=None, plasmid_metadata={},
                            INITIAL_DATA_SAMPLES=1, INITIAL_DATA_WINDOW_BP=200)
    state._initial_data_position_key = lambda ids: BrowserState._initial_data_position_key(state, ids)
    first = BrowserState._initial_data_position(state)
    assert first["chrom"] == "chr1"
    assert BrowserState._initial_data_position(state) == first and len(calls) == 1  # cached
    state.chroms = [SimpleNamespace(name="chr2", size=900)]
    state.fasta_path = "/refs/two.fa"
    assert BrowserState._initial_data_position(state)["chrom"] == "chr2"
    assert len(calls) == 2
    # Another set of datasets is its own entry.
    state.dataset_order = ["a", "b"]
    state.datasets["b"] = SimpleNamespace(paths=["b.bam"])
    BrowserState._initial_data_position(state, ["b"])
    assert calls[-1] == ("b",)


@pytest.fixture
def mixed_start(monkeypatch, tmp_path):
    """hg38 loaded; a dm6 BAM listed first, the hg38 demo second (as on the command line)."""
    import server as srv
    fly = _dataset("fly", _bam(tmp_path, "fly.bam", DM6_CONTIGS))
    human = _dataset("human", str(DEMO_BAM))
    for ds in (fly, human):
        ds.to_dict = (lambda d: lambda: {"id": d.id, "label": d.label, "path": d.path})(ds)
    monkeypatch.setattr(srv.state, "datasets", {"fly": fly, "human": human})
    monkeypatch.setattr(srv.state, "dataset_order", ["fly", "human"])
    monkeypatch.setattr(srv.state, "fasta", FakeFasta(HG38_FASTA))
    monkeypatch.setattr(srv.state, "fasta_path", "/refs/hg38.fa")
    monkeypatch.setattr(srv.state, "current_genome", "hg38")
    asked: list = []

    def initial_position(self, window_size=10000, dataset_ids=None):
        asked.append(dataset_ids)
        # Where each dataset's reads are: the demo's on chr19, the fly BAM's on chr2L.
        ids = list(self.dataset_order) if dataset_ids is None else dataset_ids
        chrom = "chr2L" if ids and ids[0] == "fly" else "chr19"
        return {"chrom": chrom, "start": 47_515_640, "end": 47_517_640, "gene_name": ""}

    monkeypatch.setattr(type(srv.state), "get_initial_position", initial_position)
    return srv.state, asked


def test_status_opens_on_the_reads_of_the_loaded_genomes_datasets(client, mixed_start):
    state, asked = mixed_start
    body = client.get("/api/status").json()
    assert body["genome_mismatch"]["dataset_ids"] == ["fly"]
    assert body["initial_position"]["chrom"] == "chr19"
    assert asked[-1] == ["human"]


def test_status_stays_put_when_no_dataset_fits(client, mixed_start, monkeypatch):
    state, _asked = mixed_start
    monkeypatch.setattr(state, "datasets", {"fly": state.datasets["fly"]})
    monkeypatch.setattr(state, "dataset_order", ["fly"])
    body = client.get("/api/status").json()
    assert body["genome_mismatch"]["dataset_ids"] == ["fly"]
    assert body["initial_position"] is None
