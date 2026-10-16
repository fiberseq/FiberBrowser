"""Round-8 review fixes: data access (B1) and other analyses (B6)."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


# ── B1 #1: paired annotations record the lengths of their own reference ─────
def test_reference_pairs_record_the_new_assembly_for_their_annotations(tmp_path):
    from services.reference_collection import load_reference_pairs
    from state.browser_state import BrowserState

    state = BrowserState(None, None, None, None)
    fa_a = tmp_path / "a.fa"
    fa_a.write_text(">chr1\n" + "A" * 40 + "\n")
    fa_b = tmp_path / "b.fa"
    fa_b.write_text(">chr1\n" + "C" * 80 + "\n")
    bed = tmp_path / "b.bed"
    bed.write_text("chr1\t10\t60\tGENE\t0\t+\n")
    load_reference_pairs(state, [dict(fasta=str(fa_a), annotation=None)])
    load_reference_pairs(state, [dict(fasta=str(fa_b), annotation=str(bed))])
    # B's annotations are tied to B's lengths, not A's.
    assert list(state._gtf_reference_lengths.values()) == [80]
    state.fasta.close()


# ── B1 #2: an all-remote [footprint, m6a] merge is grouped, not read twice ──
def test_all_remote_bigbed_pair_is_grouped_with_companions(monkeypatch):
    import services.dataset_registration as dr
    from models.domain import Dataset

    fp = "https://example.org/sample_footprint.bb"
    m6a = "https://example.org/sample_m6a.bb"
    monkeypatch.setattr(dr, "detect_overlay_type", lambda path: "m6a" if "m6a" in path else "footprint")
    monkeypatch.setattr(dr, "is_annotation_bigbed", lambda path: False)
    monkeypatch.setattr(dr, "is_derived_layer_bigbed", lambda path: False)
    monkeypatch.setattr(dr, "_bigbed_has_circular_groups", lambda files: False)
    monkeypatch.setattr(dr, "discover_annotation_bigbeds", lambda *a, **k: None)
    monkeypatch.setattr(dr, "discover_derived_layer_files", lambda *a, **k: None)
    dataset = Dataset("s", [fp, m6a], label="s")
    state = SimpleNamespace(annotation_state=SimpleNamespace(files={}))
    dr.configure_bigbed_dataset_layers(state, "s", dataset, fp)
    # Grouped like a local set: footprint primary, m6a a companion layer.
    assert dataset.layer_type == "footprint"
    assert dataset.paths[0] == fp
    assert dataset.companion_layers == {"m6a": [m6a]}
    assert dataset.available_layers.get("m6a") is True


# ── B1 #3: a merged BAM dataset offers every file's layers ──────────────────
def test_merged_bam_capabilities_are_the_union_of_its_files(monkeypatch):
    import services.dataset_registration as dr
    from models.domain import Dataset

    probes = {
        "/data/A.bam": dict(has_nucleosomes=True, has_m6a=True, has_m5c=False, has_deam=False,
                            has_msps=False, has_fire=False, ma_layers=["nuc"]),
        "/data/B.bam": dict(has_nucleosomes=True, has_m6a=False, has_m5c=True, has_deam=False,
                            has_msps=False, has_fire=False, ma_layers=["tf"]),
    }
    seen = []
    monkeypatch.setattr(dr, "diagnose_bam_tags", lambda path, limit: seen.append(path) or probes[path])
    monkeypatch.setattr(dr, "discover_derived_layer_files", lambda *a, **k: None)
    dataset = Dataset("m", ["/data/A.bam", "/data/B.bam"], label="m", data_type="bam")
    dr.configure_bam_dataset_layers(dataset, "/data/A.bam")
    assert seen == ["/data/A.bam", "/data/B.bam"]
    assert dataset.available_layers["m6a"] is True
    assert dataset.available_layers["m5c"] is True
    assert dataset.available_layers["nuc"] is True and dataset.available_layers["tf"] is True


# ── B1 #4: footprint analysis reads a loaded plasmid's sequence ─────────────
def test_supplemental_sequences_resolve_and_wrap():
    from services.supplemental_sequences import supplemental_sequence_for_chrom, supplemental_sequence_slice

    state = SimpleNamespace(plasmid_sequences={"pUC19": "ACGTACGTAA"}, circular_chroms={"pUC19": {"size": 10}})
    name, seq = supplemental_sequence_for_chrom(state, "pUC19")
    assert name == "pUC19" and seq == "ACGTACGTAA"
    assert supplemental_sequence_slice(state, name, seq, 2, 6) == "GTAC"
    # Across the origin of a circular plasmid.
    assert supplemental_sequence_slice(state, name, seq, 8, 12) == "AAAC"
    assert supplemental_sequence_for_chrom(state, "chr1") is None


def test_footprint_analysis_uses_the_plasmid_sequence():
    import inspect

    import services.footprint_endpoint as fe

    source = inspect.getsource(fe)
    assert "supplemental_sequence_for_chrom(state, resolved_chrom)" in source
    assert "supplemental_sequence_slice(" in source


# ── B6 #1: the automatic primer FASTA follows the loaded genome ─────────────
def test_primer_design_follows_a_newly_loaded_genome(tmp_path):
    from services.primer_orchestration import resolve_primer_runtime_config

    first = tmp_path / "dm6.fa"
    first.write_text(">chr2L\nACGT\n")
    second = tmp_path / "hg38.fa"
    second.write_text(">chr1\nACGT\n")
    state = SimpleNamespace(fasta_path=str(first), primer_fasta=None, primer_blast_db=None, current_genome="dm6")
    resolve_primer_runtime_config(state, require_blastn=False)
    state.fasta_path = str(second)
    state.current_genome = "hg38"
    resolve_primer_runtime_config(state, require_blastn=False)
    assert state.primer_fasta is None
    explicit = SimpleNamespace(fasta_path=str(second), primer_fasta=str(first), primer_blast_db=None, current_genome="hg38")
    resolve_primer_runtime_config(explicit, require_blastn=False)
    assert explicit.primer_fasta == str(first)


# ── B6 #2: the notebook sequence cache follows the reference collection ─────
def test_notebook_sequence_cache_follows_the_reference_collection():
    from services.jupyter_sequences import get_cached_fasta_dict

    calls = []

    def loader(path):
        calls.append(path)
        return {"n": len(calls)}

    state = SimpleNamespace(fasta_path="/ref/a.fa", fasta=object(),
                            reference_pairs=[{"fasta": "/ref/a.fa"}, {"fasta": "/ref/b.fa"}])
    first = get_cached_fasta_dict(state, loader=loader, path="/ref/a.fa")
    assert get_cached_fasta_dict(state, loader=loader, path="/ref/a.fa") is first
    # Same first file, another collection: a new view.
    state.fasta = object()
    state.reference_pairs = [{"fasta": "/ref/a.fa"}, {"fasta": "/ref/c.fa"}]
    second = get_cached_fasta_dict(state, loader=loader, path="/ref/a.fa")
    assert second is not first and calls == ["/ref/a.fa", "/ref/a.fa"]


# ── B6 #3: Unicode track labels download instead of failing ────────────────
def test_content_disposition_handles_unicode_names():
    from starlette.responses import Response

    from utils.responses import content_disposition

    value = content_disposition("β-catenin.tsv")
    assert value == "attachment; filename=\"_-catenin.tsv\"; filename*=UTF-8''%CE%B2-catenin.tsv"
    Response(content=b"x", headers={"Content-Disposition": value})  # Latin-1 encodable
    assert content_disposition("plain.tsv", "inline") == 'inline; filename="plain.tsv"'
    assert content_disposition('a"b.tsv') == "attachment; filename=\"a_b.tsv\"; filename*=UTF-8''a%22b.tsv"


def test_track_export_route_uses_the_safe_header():
    import inspect

    import routers.sessions as sessions_router
    import routers.tracks as tracks_router

    assert "filename=\"{export" not in inspect.getsource(tracks_router)
    assert "filename=\"{export" not in inspect.getsource(sessions_router)


# ── B6 #4: get_tracks returns the list it documents ────────────────────────
def test_client_get_tracks_returns_a_list(monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import browser_client

    client = browser_client.BrowserClient.__new__(browser_client.BrowserClient)
    monkeypatch.setattr(client, "_get", lambda endpoint, params=None: {"tracks": [{"index": 0}, {"index": 1}]}, raising=False)
    assert [t["index"] for t in client.get_tracks()] == [0, 1]
    monkeypatch.setattr(client, "_get", lambda endpoint, params=None: {"tracks": []}, raising=False)
    assert client.get_tracks() == []
