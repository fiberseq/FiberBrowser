import pytest

from services import motifs


pytestmark = pytest.mark.skipif(not motifs.check_pyjaspar(), reason="pyjaspar not installed")


def test_search_ranks_exact_names_and_the_genome_taxon_first():
    results = motifs.search_jaspar("ctcf", taxon="vertebrates")
    assert results[0]["name"] == "CTCF"
    assert results[0]["tax_group"] == "vertebrates"
    assert all("counts" not in row for row in results)
    fly = motifs.search_jaspar("ctcf", taxon="insects")
    assert fly[0]["tax_group"] == "insects"


def test_search_by_matrix_id_and_lookup():
    assert motifs.search_jaspar("MA0139")[0]["matrix_id"].startswith("MA0139")
    entry = motifs.jaspar_matrix("MA0139.2")
    assert entry["name"] == "CTCF" and len(entry["counts"]["A"]) > 10
    assert motifs.jaspar_matrix("MA9999.9") is None


def test_genome_taxon():
    assert motifs.genome_taxon("hg38") == "vertebrates"
    assert motifs.genome_taxon("dm6") == "insects"
    assert motifs.genome_taxon("mystery") is None
