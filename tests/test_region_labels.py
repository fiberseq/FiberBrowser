"""Region names (nearest gene) on real annotation excerpts (fb-n2-regions, audit H3).

The fixtures are transcript lines cut from the GENCODE v46 hg38 GTF and the
BDGP6.46 dm6 GTF the app downloads (tests/fixtures/region_labels). On hg38,
transcripts were merged by gene name across a whole chromosome, so a
multi-copy name (Metazoa_SRP: 510 copies, Y_RNA) became one span from its first
copy to its last and named every region: the NAPA amplicon of the demo was
"Metazoa_SRP", and chrX:566,827-580,013 (no gene there) was "In Metazoa_SRP".
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pandas as pd
import pytest

from conftest import auth_headers

FIXTURES = Path(__file__).parent / "fixtures" / "region_labels"


def _annotation(tmp_path: Path, name: str) -> dict:
    """The excerpt parsed by the app's own loader (a copy: the loader writes a cache beside it)."""
    from services.gene_annotations import load_gtf

    path = tmp_path / name
    shutil.copy(FIXTURES / name, path)
    data = load_gtf(str(path))
    assert data is not None and len(data["transcripts"]) > 0
    return data


@pytest.fixture
def hg38(tmp_path):
    from services.region_detect import GeneIndex
    return GeneIndex(_annotation(tmp_path, "hg38_excerpt.gtf"))


@pytest.fixture
def dm6(tmp_path):
    from services.region_detect import GeneIndex
    return GeneIndex(_annotation(tmp_path, "dm6_excerpt.gtf"))


def test_the_napa_amplicon_is_named_napa_not_a_repeat_family(hg38):
    got = hg38.label("chr19", 47_514_487, 47_518_985)
    assert got["label"] == "NAPA" and got["gene"] == "NAPA"
    assert "Metazoa_SRP" not in got["detail"] and "Y_RNA" not in got["detail"]


def test_a_region_without_genes_is_not_inside_a_multi_copy_name(hg38):
    # chrX PAR1: no gene overlaps it; KRT18P53 (a processed pseudogene) is 21 kb away, SHOX 44 kb.
    got = hg38.label("chrX", 566_827, 580_013)
    assert not got["label"].startswith("In ") and "Metazoa_SRP" not in got["detail"]
    assert got["label"] == "near SHOX (44.3 kb)" and got["gene"] == "SHOX"


def test_one_copy_of_a_multi_copy_name_still_names_its_own_locus(hg38):
    # chr19:1,724,115-1,724,395 is one Metazoa_SRP copy (1-based GTF; 0-based start here).
    got = hg38.label("chr19", 1_724_114, 1_724_395)
    assert got["label"] == "Metazoa_SRP"
    spans = [s for s in hg38._spans("chr19") if s[2] == "Metazoa_SRP"]
    # One small span per copy, never one across the chromosome.
    assert len(spans) > 5 and max(e - s for s, e, _n, _t in spans) < 1_000


def test_dm6_amplicons_keep_their_gene_names(dm6):
    """Three DddB amplicons (dm6) were named right before: they still are."""
    assert dm6.label("chr2L", 6_356_893, 6_357_548)["label"] == "CG9500"
    assert dm6.label("chr2L", 9_464_006, 9_467_048)["label"] == "numb"
    assert dm6.label("chr2L", 9_485_680, 9_487_224)["label"] == "near Gdi (4.0 kb)"


def test_a_protein_coding_gene_is_named_before_a_larger_non_coding_overlap():
    from services.region_detect import GeneIndex

    tx = pd.DataFrame([
        ("chr1", 1_000, 9_000, "+", "BIG-AS1", "t1", "lncRNA"),
        ("chr1", 4_000, 5_200, "-", "SMALLPC", "t2", "protein_coding"),
        ("chr1", 4_100, 4_400, "+", "U6", "t3", "snRNA"),
    ], columns=["chrom", "start", "end", "strand", "gene_name", "transcript_id", "biotype"])
    got = GeneIndex({"transcripts": tx}).label("chr1", 4_000, 6_000)
    assert got["label"] == "SMALLPC" and got["detail"] == "In SMALLPC (also BIG-AS1, U6)"


def test_flanking_genes_skip_repeat_copies_and_unnamed_genes():
    from services.region_detect import GeneIndex

    tx = pd.DataFrame([
        ("chr1", 10_000, 20_000, "+", "GENEA", "t1", "protein_coding"),
        ("chr1", 49_000, 49_300, "+", "Y_RNA", "t2", "misc_RNA"),
        ("chr1", 50_500, 51_000, "+", "ENSG00000281849", "t3", "lncRNA"),
        ("chr1", 90_000, 95_000, "+", "GENEB", "t4", "protein_coding"),
    ], columns=["chrom", "start", "end", "strand", "gene_name", "transcript_id", "biotype"])
    got = GeneIndex({"transcripts": tx}).label("chr1", 50_000, 50_400)
    assert got["label"] == "between GENEA and GENEB"
    # A chromosome with only repeat copies still names its regions after them.
    only = GeneIndex({"transcripts": tx[tx["gene_name"] == "Y_RNA"]}).label("chr1", 50_000, 50_400)
    assert only["label"] == "near Y_RNA (700 bp)"


def test_label_endpoint_on_the_hg38_excerpt(standalone_app, tmp_path):
    """GET /api/regions/label answers NAPA for the demo's amplicon (it said Metazoa_SRP)."""
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        state.gtf_data = _annotation(tmp_path, "hg38_excerpt.gtf")
        client = TestClient(standalone_app, headers=auth_headers())
        body = client.get("/api/regions/label", params={"chrom": "chr19", "start": 47_514_487, "end": 47_518_985}).json()
        assert body["label"] == "NAPA" and body["detail"] == "In NAPA"
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)
