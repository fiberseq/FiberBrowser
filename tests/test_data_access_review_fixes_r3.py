"""Backend data-access fixes from the module review, round 3 (B1)."""
import os
import time
from types import SimpleNamespace

import pandas as pd
import pytest


def _fasta(path, records):
    import pysam
    path.write_text("".join(f">{name}\n{seq}\n" for name, seq in records))
    pysam.faidx(str(path))
    return str(path)


def _state():
    from state.browser_state import BrowserState
    return BrowserState(None, None, None, None)


# --- 1. upload cleanup keeps a dataset's companion files ---------------------------

def test_cleanup_keeps_companion_and_derived_files_of_loaded_datasets(tmp_path):
    from services.upload_store import cleanup_uploads, loaded_file_paths, mark_uploads_used
    files = {name: tmp_path / name for name in (
        "s_footprint.bb", "s_tf.bb", "s.fiberlayers.bb", "s.fiberlayers.json", "other.bb")}
    old = time.time() - 30 * 86400
    for path in files.values():
        path.write_text("x")
        os.utime(path, (old, old))
    dataset = SimpleNamespace(
        paths=[str(files["s_footprint.bb"])],
        companion_layers={"tf": [str(files["s_tf.bb"])]},
        derived_layers={"cls": {"bundle_path": str(files["s.fiberlayers.bb"]),
                                "manifest_path": str(files["s.fiberlayers.json"])}},
    )
    state = SimpleNamespace(datasets={"s": dataset}, orthogonal_tracks=[], gtf_path=None, fasta_path=None)

    mark_uploads_used(loaded_file_paths(state), directory=str(tmp_path))
    removed = cleanup_uploads(directory=str(tmp_path), max_age_days=7)["removed"]

    assert removed == [str(files["other.bb"])]


# --- 2. only circular contigs wrap -------------------------------------------------------

def test_a_linear_chromosome_has_no_circular_size():
    from services.circular_genome import circular_chrom_size
    state = SimpleNamespace(circular_chroms={}, _chrom_size_for=lambda chrom: 10)
    assert circular_chrom_size(state, "chr1") is None
    state.circular_chroms = {"chrM": {"source": "user"}}
    assert circular_chrom_size(state, "chrM") == 10


def test_sequence_past_the_end_of_a_linear_chromosome_is_clamped(tmp_path):
    from routers.genome import get_sequence
    import asyncio
    state = _state()
    assert state._load_fasta(_fasta(tmp_path / "a.fa", [("chr1", "ACGTAAAAAA")] )) is None
    result = asyncio.run(get_sequence(chrom="chr1", start=8, end=12, state=state))
    assert result["sequence"] == "AA" and not result.get("circular")


# --- 3. paired references replace old plasmids ---------------------------------------

def test_reference_pairs_drop_plasmids_of_the_previous_reference(tmp_path):
    from services.reference_collection import load_reference_pairs
    state = _state()
    state.add_supplemental_plasmid_reference("p", "AAAA")
    load_reference_pairs(state, [{"fasta": _fasta(tmp_path / "r.fa", [("p", "CCCC"), ("chrM", "A" * 20)])}])
    assert state.plasmid_sequences == {}
    assert state.fasta.fetch("p", 0, 4) == "CCCC"
    assert set(state.circular_chroms) == {"chrM"}


# --- 4. another assembly replaces identity and annotations ---------------------------

def test_a_fasta_of_another_assembly_drops_the_old_genome(tmp_path):
    state = _state()
    state._load_fasta(_fasta(tmp_path / "human.fa", [("chr1", "A" * 100), ("chr20", "C" * 40)]))
    state.current_genome = "hg38"
    state.gtf_data = {"transcripts": pd.DataFrame([{"chrom": "chr20", "start": 0, "end": 10}])}
    state.gtf_path = "/g/hg38.gtf"

    state._load_fasta(_fasta(tmp_path / "mouse.fa", [("chr1", "A" * 150), ("chr19", "C" * 40)]))

    assert state.current_genome is None
    assert state.gtf_data is None and state.gtf_path is None


def test_reloading_the_same_assembly_keeps_its_annotations(tmp_path):
    state = _state()
    state._load_fasta(_fasta(tmp_path / "a.fa", [("chr1", "A" * 100)]))
    state.current_genome = "hg38"
    gtf = {"transcripts": pd.DataFrame([{"chrom": "chr1", "start": 0, "end": 10}])}
    state.gtf_data = gtf

    state._load_fasta(_fasta(tmp_path / "copy.fa", [("1", "A" * 100)]))

    assert state.current_genome == "hg38" and state.gtf_data is gtf


# --- 5. motif caches tell reference collections apart --------------------------------

def test_reference_collections_with_the_same_names_have_different_identities(tmp_path):
    import pysam
    from services.orthogonal_tracks import _reference_identity
    from services.reference_collection import ReferenceCollection
    a = ReferenceCollection([pysam.FastaFile(_fasta(tmp_path / "a.fa", [("chr1", "ACGT")]))])
    b = ReferenceCollection([pysam.FastaFile(_fasta(tmp_path / "b.fa", [("chr1", "TTTT")]))])
    assert _reference_identity(a) != _reference_identity(b)


# --- 6. BAM and BigBed files are not one dataset ---------------------------------------

def test_a_combined_dataset_of_bam_and_bigbed_is_refused(tmp_path):
    from services.dataset_registration import validate_dataset_source
    bam, bb = tmp_path / "a.bam", tmp_path / "b.bb"
    bam.write_text("x")
    bb.write_text("x")
    with pytest.raises(ValueError, match="BAM and BigBed"):
        validate_dataset_source([str(bam), str(bb)])
    assert validate_dataset_source([str(bam), str(bam)])[1] is True


# --- 7. custom motifs find the FASTA's alias ------------------------------------------------

def test_custom_motif_lookup_resolves_chrm_to_mt():
    from services.orthogonal_tracks import get_track_annotations
    fetched = []

    class Fasta:
        references = ("1", "MT")
        filename = None

        def get_reference_length(self, name):
            return 16_000

        def fetch(self, name, start, end):
            fetched.append(name)
            return "A" * (end - start)

    track = {"format": "custom_motif", "label": "m", "pssm": [[0.25] * 4], "threshold": 0.85, "path": "/m.jaspar"}
    get_track_annotations(track, "chrM", 100, 200, fasta=Fasta(), motif_scanner=lambda seq, pssm, th: [])
    assert fetched == ["MT"]
