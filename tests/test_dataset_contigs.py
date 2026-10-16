"""Which datasets have reads on a contig (plasmids open beside the view for them)."""
from pathlib import Path
from types import SimpleNamespace

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


def test_datasets_with_contig_reads_headers_and_aliases():
    from services.dataset_contigs import datasets_with_contig
    napa = SimpleNamespace(path=str(DEMO_BAM), paths=[str(DEMO_BAM)])
    missing = SimpleNamespace(path="/nonexistent.bam", paths=["/nonexistent.bam"])
    state = SimpleNamespace(datasets={"napa": napa, "gone": missing})
    assert datasets_with_contig(state, "chr19") == ["napa"]
    assert datasets_with_contig(state, "19") == ["napa"]
    assert datasets_with_contig(state, "pPhased") == []
    assert "chr19" in napa._header_contigs  # cached
