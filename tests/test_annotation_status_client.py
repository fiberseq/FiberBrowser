"""BrowserClient.get_annotation_status: the browser's "No genes loaded for dm6 · Load dm6 genes" decision, headless."""
from browser_client import BrowserClient


def _client(check):
    client = object.__new__(BrowserClient)
    client._get = lambda endpoint, params=None: check if endpoint == "/api/genome/check" else {}
    return client


DM6 = {"genome_id": "dm6", "name": "D. melanogaster (dm6)", "gtf_label": "", "cached": False}


def test_a_catalog_genome_without_genes_is_downloadable_where_the_loader_may_run():
    status = _client({"reference": {"kind": "registry", "label": "dm6", "assembly": "dm6"},
                      "annotation": {"loaded": False, "gene_count": 0, "target": DM6, "can_reset": True}}).get_annotation_status()
    assert status["downloadable"] and status["target"]["genome_id"] == "dm6" and not status["loaded"]
    assert not status["can_upload_gtf"]
    public = _client({"reference": {"kind": "registry"}, "annotation": {"loaded": False, "target": DM6, "can_reset": False}})
    assert not public.get_annotation_status()["downloadable"]


def test_loaded_genes_and_local_fastas():
    loaded = _client({"reference": {"kind": "registry"}, "annotation": {"loaded": True, "gene_count": 12, "target": DM6,
                                                                       "can_reset": True, "genome_id": "dm6"}})
    s = loaded.get_annotation_status()
    assert s["loaded"] and s["gene_count"] == 12 and not s["downloadable"] and s["genome_id"] == "dm6"
    fasta = _client({"reference": {"kind": "fasta", "label": "mine"}, "annotation": {"loaded": False, "target": None}})
    assert fasta.get_annotation_status()["can_upload_gtf"] and not fasta.get_annotation_status()["downloadable"]


def test_no_gtf_upload_offered_on_a_public_server():
    public = _client({"reference": {"kind": "fasta", "label": "mine"}, "can_load_genomes": False,
                      "annotation": {"loaded": False, "target": None}})
    assert not public.get_annotation_status()["can_upload_gtf"]
