"""B6 round 7: 4C viewpoint bounds, notebook read IDs, compressed references, catalog reloads."""
import asyncio
from types import SimpleNamespace

import pysam
import pytest


# ── 1. A 4C viewpoint past the contig end is refused ─────────────────

def test_4c_viewpoint_beyond_the_chromosome_is_refused(monkeypatch):
    pytest.importorskip("primer3")  # optional Primer-panel package
    from models.requests import FourCPrimerDesignRequest
    from services import primer_4c_endpoint as ep

    seq = "ACGT" * 500  # 2,000 bp
    monkeypatch.setattr(ep, "_resolve_primer_runtime_config",
                        lambda state: (SimpleNamespace(fasta_path="/ref.fa"), None))
    monkeypatch.setattr(ep, "_get_fasta_interface",
                        lambda state, path: (lambda c, s, e: seq[s:e], lambda c: len(seq), {"chr1"}))
    result = ep.design_4c_primers_payload(FourCPrimerDesignRequest(chrom="chr1", start=1000, end=2200), SimpleNamespace())
    assert result["success"] is False
    assert "exceeds chromosome length" in result["message"]


# ── 2. Pushed reads never reuse (and overwrite) an earlier dataset ────

def test_push_reads_allocates_an_unused_id():
    from models.requests import PushReadsReplaceRequest, PushReadsRequest
    from services.jupyter_endpoint import clear_pushed_reads, push_reads_for_request, push_reads_replace_for_request

    js = SimpleNamespace(custom_reads={}, version=0)
    push_reads_replace_for_request(js, PushReadsReplaceRequest(reads=[{"id": "p"}]))
    first = push_reads_for_request(js, PushReadsRequest(reads=[{"id": "a"}]))["dataset_id"]
    clear_pushed_reads(js)
    second = push_reads_for_request(js, PushReadsRequest(reads=[{"id": "b"}]))["dataset_id"]
    assert first != second
    assert js.custom_reads[first] == [{"id": "a"}] and js.custom_reads[second] == [{"id": "b"}]


# ── 3. Notebook sequences read a BGZF-compressed reference ────────────

def test_notebook_sequences_read_a_bgzf_reference(tmp_path):
    from services.jupyter_sequences import extract_sequence_regions, get_cached_fasta_dict

    plain = tmp_path / "ref.fa"
    plain.write_text(">chr1\n" + "ACGTACGTAA" * 10 + "\n")
    packed = tmp_path / "ref.fa.gz"
    pysam.tabix_compress(str(plain), str(packed), force=True)
    pysam.faidx(str(packed))

    state = SimpleNamespace(fasta=None, fasta_path=str(packed))
    fa = get_cached_fasta_dict(state, path=str(packed))
    region = SimpleNamespace(chrom="chr1", start=2, end=8, name=None)
    out = extract_sequence_regions([region], fa)
    assert out[0]["sequence"] == "GTACGT"
    assert len(fa["chr1"]) == 100 and "1" not in fa and "chr1" in fa


# ── 4. A catalog group whose dataset was removed loads again ──────────

class _State:
    def __init__(self):
        self._catalog_loaded = {}
        self._catalog_loaded_tracks = set()
        self.datasets = {}
        self.dataset_order = []

    def add_dataset(self, dataset_id, path, label):
        self.datasets[dataset_id] = SimpleNamespace(path=path, label=label, color=None, available_layers=None)
        self.dataset_order.append(dataset_id)


def test_catalog_group_reloads_after_its_dataset_is_removed():
    from routers.catalog import catalog_load, set_catalog
    from services import catalog_endpoint

    set_catalog({"groups": [{"datasets": [{"path": "/data/a.bam", "label": "a"}]}]})
    try:
        state = _State()
        assert asyncio.run(catalog_load(0, state))["dataset_ids"] == ["catalog_0_0"]
        del state.datasets["catalog_0_0"]  # removed through the dataset list
        assert catalog_endpoint.get_catalog_payload(state)["catalog"]["groups"][0]["loaded"] is False
        again = asyncio.run(catalog_load(0, state))
        assert again["message"] != "Already loaded" and "catalog_0_0" in state.datasets
    finally:
        set_catalog(None)


@pytest.fixture(autouse=True)
def _reset_catalog():
    yield
    from routers.catalog import set_catalog
    set_catalog(None)
