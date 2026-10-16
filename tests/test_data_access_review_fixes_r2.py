"""Backend data-access fixes from the module review, round 2 (B1)."""
from types import SimpleNamespace

import pandas as pd
import pytest

from models.requests import MergeDatasetsRequest, UnmergeDatasetsRequest


# --- chromosome X is not chromosome 10 --------------------------------------------

def test_chrx_and_chr10_stay_distinct_and_yeast_numerals_still_match():
    from utils.chrom import get_chrom_variants, normalize_chrom_name, resolve_reference_name
    assert normalize_chrom_name("chrX") != normalize_chrom_name("chr10")
    assert "chrX" not in get_chrom_variants("chr10") and "X" not in get_chrom_variants("chr10")
    assert resolve_reference_name("chr10", ("chrX", "chr10")) == "chr10"
    assert resolve_reference_name("chrX", ("X", "10")) == "X"
    # Yeast: roman <-> arabic keeps working, and chrX matches X.
    assert normalize_chrom_name("chrXVI") == normalize_chrom_name("16")
    assert resolve_reference_name("chrIV", ("4",)) == "4"
    assert resolve_reference_name("chrX", ("X",)) == "X"


def test_a_genome_with_chrx_and_chr10_builds_one_entry_each():
    from utils.chrom import build_chrom_map
    chrom_map = build_chrom_map(["chr10", "chrX"])
    assert chrom_map[normalize("chr10")] == "chr10"
    assert chrom_map[normalize("chrX")] == "chrX"


def normalize(name):
    from utils.chrom import normalize_chrom_name
    return normalize_chrom_name(name)


# --- merge / unmerge --------------------------------------------------------------

class _State:
    def __init__(self, fail_paths=()):
        self.datasets, self.dataset_order, self.fail_paths = {}, [], set(fail_paths)

    def add_dataset(self, dataset_id, path_arg, label=None, data_type=None):
        paths = path_arg if isinstance(path_arg, list) else [path_arg]
        if any(p in self.fail_paths for p in paths):
            # Like the real registry: a dataset is published only once it opened, so a failure registers
            # nothing (and a caller's rollback must not remove anything it did not create).
            raise ValueError("cannot open")
        kind = data_type or ("bam" if all(p.endswith(".bam") for p in paths) else "bigbed")
        ds = SimpleNamespace(id=dataset_id, paths=paths, label=label, data_type=kind, derived_layers={},
                             available_layers={}, companion_layers={},
                             to_dict=lambda: {"id": dataset_id, "path": path_arg})
        self.datasets[dataset_id] = ds
        self.dataset_order.append(dataset_id)
        return ds

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def remove_dataset(self, dataset_id):
        self.datasets.pop(dataset_id, None)
        if dataset_id in self.dataset_order:
            self.dataset_order.remove(dataset_id)


def test_bam_and_bigbed_are_not_merged():
    from services.dataset_endpoint import merge_datasets_for_request
    state = _State()
    state.add_dataset("a", "/d/a.bam", "A")
    state.add_dataset("b", "/d/b.bb", "B")
    result = merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))
    assert not result["success"] and "BAM and BigBed" in result["error"]
    assert state.dataset_order == ["a", "b"]


def test_a_failed_merge_leaves_no_half_registered_dataset():
    from services.dataset_endpoint import merge_datasets_for_request
    state = _State(fail_paths={"/d/b.bam"})
    state.add_dataset("a", "/d/a.bam", "A")
    state.datasets["b"] = SimpleNamespace(id="b", paths=["/d/b.bam"], label="B", data_type="bam",
                                          derived_layers={}, companion_layers={})
    state.dataset_order.append("b")
    result = merge_datasets_for_request(state, MergeDatasetsRequest(dataset_ids=["a", "b"]))
    assert not result["success"]
    assert state.dataset_order == ["a", "b"]


def test_unmerge_keeps_the_combined_dataset_when_a_part_fails():
    from services.dataset_endpoint import unmerge_dataset_for_request
    state = _State(fail_paths={"/d/b.bam"})
    state.datasets["ab"] = SimpleNamespace(id="ab", paths=["/d/a.bam", "/d/b.bam"], companion_layers={})
    state.dataset_order.append("ab")
    result = unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="ab"))
    assert not result["success"]
    assert state.dataset_order == ["ab"]


def test_unmerge_removes_the_combined_dataset_once_the_parts_exist():
    from services.dataset_endpoint import unmerge_dataset_for_request
    state = _State()
    state.datasets["ab"] = SimpleNamespace(id="ab", paths=["/d/a.bam", "/d/b.bam"], companion_layers={})
    state.dataset_order.append("ab")
    result = unmerge_dataset_for_request(state, UnmergeDatasetsRequest(dataset_id="ab"))
    assert result["success"] and "ab" not in state.dataset_order and len(state.dataset_order) == 2


def test_a_class_from_two_merged_bundles_keeps_both(monkeypatch):
    import services.dataset_registration as registration
    from services.working_sets import _derived_layer_paths_for_request
    definitions = {
        "/d/a.fiberlayers.bb": {"cls": {"id": "cls", "bundle_path": "/d/a.fiberlayers.bb"}},
        "/d/b.fiberlayers.bb": {"cls": {"id": "cls", "bundle_path": "/d/b.fiberlayers.bb"}},
    }
    monkeypatch.setattr(registration, "load_derived_layer_definitions", lambda path: dict(definitions[path]))
    ds = SimpleNamespace(derived_layers={}, available_layers={})
    registration.register_derived_layer_file(ds, "/d/a.fiberlayers.bb")
    registration.register_derived_layer_file(ds, "/d/b.fiberlayers.bb")
    assert _derived_layer_paths_for_request(ds, None) == ["/d/a.fiberlayers.bb", "/d/b.fiberlayers.bb"]


# --- reference loading ------------------------------------------------------------

def _plain_state():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


def test_a_fasta_that_fails_to_load_keeps_the_current_reference_and_plasmids(tmp_path):
    state = _plain_state()
    old = object()
    state.fasta, state.fasta_path = old, "/g/old.fa"
    state.plasmid_sequences = {"pUC": "ACGT"}
    state.plasmid_metadata = {"pUC": {"size": 4}}
    fasta = tmp_path / "new.fa"
    fasta.write_text(">chr1\nACGT\n")  # no .fai
    error = state._load_fasta(str(fasta))
    assert error and "Index not found" in error
    assert state.fasta is old and state.fasta_path == "/g/old.fa"
    assert state.plasmid_sequences == {"pUC": "ACGT"}


def _write_fasta(path, records):
    import pysam
    path.write_text("".join(f">{name}\n{seq}\n" for name, seq in records))
    pysam.faidx(str(path))
    return str(path)


def test_a_new_reference_replaces_circular_lengths_and_drops_the_old_genomes(tmp_path):
    state = _plain_state()
    state._load_fasta(_write_fasta(tmp_path / "a.fa", [("chrM", "A" * 100), ("chrQ", "C" * 50)]))
    state.set_circular_chrom("chrQ", source="user")
    assert state.circular_chroms["chrM"]["size"] == 100
    state._load_fasta(_write_fasta(tmp_path / "b.fa", [("chrM", "A" * 160), ("chr1", "C" * 50)]))
    assert state.circular_chroms["chrM"]["size"] == 160
    assert "chrQ" not in state.circular_chroms


# --- annotations without exon rows --------------------------------------------------

def test_genes_without_exon_rows_display_with_no_exons(tmp_path):
    from services.gene_annotations import load_gtf
    from services.read_auxiliary_endpoint import get_genes_payload
    gff = tmp_path / "genes.gff3"
    gff.write_text("##gff-version 3\nchr1\tsrc\tgene\t101\t200\t.\t+\t.\tID=g1;Name=Alpha\n")
    data = load_gtf(str(gff))
    assert list(data["exons"].columns) == ["chrom", "start", "end", "transcript_id"]
    state = SimpleNamespace(gtf_data=data, circular_chroms={}, chroms=[], chrom_map={})
    genes = get_genes_payload(state, chrom="chr1", start=0, end=1000)["content"]["genes"]
    assert [(g["name"], g["start"], g["exons"]) for g in genes] == [("Alpha", 100, [])]
    cached = load_gtf(str(gff))  # from the JSON cache
    assert list(cached["exons"].columns) == ["chrom", "start", "end", "transcript_id"]


# --- TSS on the minus strand -----------------------------------------------------

def test_minus_strand_tss_is_the_last_base_of_the_half_open_gene():
    from services.files_endpoint import search_gene_payload
    from services.transcription_state import get_footprints_in_region
    tx = pd.DataFrame([{"chrom": "chr1", "start": 1000, "end": 2000, "strand": "-", "gene_name": "Minus",
                        "transcript_id": "t", "gene_id": "g", "biotype": "protein_coding"}])
    state = SimpleNamespace(gtf_data={"transcripts": tx})
    assert search_gene_payload(state, "Minus")["tss"] == 1999
    # The pause window sits 10-50 bp downstream of the TSS base, inside the gene.
    sizes = get_footprints_in_region([[1949 - 1000, 1989 - 1000, 30]], 1999, 10, 50, "-", 1000)
    assert sizes == [30]


# --- sequence names -------------------------------------------------------------------

def test_sequence_resolves_chrm_to_mt():
    from utils.chrom import resolve_reference_name
    assert resolve_reference_name("chrM", ("1", "MT")) == "MT"


# --- contigs of an unopenable BigBed ----------------------------------------------------

def test_unopenable_bigbed_has_no_contigs(monkeypatch):
    import pyBigWig
    from services.dataset_contigs import _file_contigs
    monkeypatch.setattr(pyBigWig, "open", lambda _path: None)
    assert _file_contigs("/d/x.bb") == set()


# --- direct loading keeps spanning reads whose terminal gaps are hidden -----------------------

def test_direct_loading_asks_the_loader_for_spanning_reads(monkeypatch):
    import services.read_endpoint as endpoint
    seen = {}

    def fake_bigbed_reads(paths, chrom, start, end, **kwargs):
        seen.update(kwargs)
        # A spanning read whose intervals start at its first footprint (gap hidden).
        return [{"id": "r1", "intervals": [[35, 60, 20]], "layers": {}}]

    monkeypatch.setattr(endpoint, "build_direct_bigbed_reads", fake_bigbed_reads)
    dataset = SimpleNamespace(id="bb", data_type="bigbed", paths=["/d/a.bb"], companion_layers={},
                              derived_layers={}, layer_type="footprint")
    reads = endpoint.load_direct_reads_for_dataset(
        SimpleNamespace(circular_chroms={}, chroms=[]), dataset, chrom="chr1", start=0, end=100,
        spanning_only=True, include_methylation=False, ml_threshold=125, min_fp_quality=0, include_cigar=False,
        hide_terminal_gaps=True, terminal_gap_threshold=400, include_layers=True, requested_layers=None,
        include_layer_qualities=True, infer_legacy_layers=True, legacy_nuc_min_size=90,
    )
    assert seen["spanning_only"] is True
    assert [r["id"] for r in reads] == ["r1"]
