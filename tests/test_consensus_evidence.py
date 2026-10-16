"""Regional evidence loader tests (ported from the retired targeted TF refinement tests)."""
from __future__ import annotations

from collections import defaultdict
from types import SimpleNamespace

import numpy as np
import pytest

from services.consensus_evidence import (
    ConsensusEvidenceInputError,
    _BigBedRead,
    _bigbed_capability_error,
    _bigbed_read_evidence,
    _resolve_bam_fetch_region,
)


def test_bigbed_evidence_is_capability_gated_not_format_gated():
    complete = {
        "tf": ["tf.bb"],
        "footprint": ["nuc.bb"],
        "msp": ["msp.bb"],
        "deam": ["deam.bb"],
    }
    assert _bigbed_capability_error(complete, "ddda") is None

    missing = {**complete, "deam": [], "m5c": ["m5c.bb"]}
    message = _bigbed_capability_error(missing, "ddda")
    assert "missing deamination events" in message
    assert "Found modification sidecars: m5c" in message
    assert "evidence-gated, not format-gated" in message

    consensus_bundle = {key: value for key, value in complete.items() if key != "footprint"}
    assert _bigbed_capability_error(
        consensus_bundle, "ddda", require_nucleosomes=False
    ) is None


def test_bam_evidence_resolves_chrom_alias_and_clips_fetch(monkeypatch):
    import services.consensus_evidence as evidence_service

    bam = SimpleNamespace(references=("1",), lengths=(100,))
    monkeypatch.setattr(evidence_service, "get_bam_handle", lambda _path: bam)

    assert _resolve_bam_fetch_region(
        "/data/example.bam", "chr1", -25, 150
    ) == ("1", 0, 100, 100)


def test_bam_evidence_reports_missing_contig_as_input_error(monkeypatch):
    import services.consensus_evidence as evidence_service

    bam = SimpleNamespace(references=("chr2L", "chr2R"), lengths=(100, 200))
    monkeypatch.setattr(evidence_service, "get_bam_handle", lambda _path: bam)

    with pytest.raises(ConsensusEvidenceInputError, match="no contig matching"):
        _resolve_bam_fetch_region("/data/example.bam", "chr3L", 10, 20)


def test_bam_evidence_prioritizes_visible_then_spanning_reads(monkeypatch):
    import services.consensus_evidence as evidence_service

    def read(name, start, end):
        return SimpleNamespace(
            query_name=name,
            reference_start=start,
            reference_end=end,
            mapping_quality=60,
            flag=0,
            is_unmapped=False,
            is_secondary=False,
            is_supplementary=False,
        )

    records = [
        read("coordinate-first", 0, 40),
        read("spanning", 0, 100),
        read("visible", 60, 100),
    ]
    bam = SimpleNamespace(fetch=lambda *_args: iter(records))
    monkeypatch.setattr(evidence_service, "get_bam_handle", lambda _path: bam)

    selected, diagnostics = evidence_service._select_bam_evidence_read_names(
        "/data/example.bam",
        "chr1",
        0,
        100,
        selection_start=25,
        selection_end=75,
        maximum_reads=2,
        preferred_read_ids=["visible"],
    )

    assert selected == ["visible", "spanning"]
    assert diagnostics["selection_preferred_read_names_selected"] == 1
    assert diagnostics["selection_spanning_read_names_selected"] == 1


def test_bam_evidence_loader_passes_resolved_clipped_region(monkeypatch):
    import services.consensus_evidence as evidence_service

    bam = SimpleNamespace(references=("1",), lengths=(100,))
    monkeypatch.setattr(evidence_service, "get_bam_handle", lambda _path: bam)
    model = object()
    monkeypatch.setattr(
        evidence_service,
        "_chemistry_runtime",
        lambda *_args, **_kwargs: (
            {"strand_mode": "daf-reverse-complement", "prob_threshold": 225},
            model,
            3,
            "ddda",
            np.zeros(1),
            np.zeros(1),
        ),
    )
    call = {}

    def load_bam(path, chrom, start, end, **kwargs):
        call.update({
            "path": path,
            "chrom": chrom,
            "start": start,
            "end": end,
            **kwargs,
        })
        return ["evidence"]

    dataset = SimpleNamespace(data_type="bam", paths=["/data/example.bam"])
    state = SimpleNamespace(get_dataset=lambda _dataset_id: dataset)
    reads, loaded_model, _preset, diagnostics = (
        evidence_service._load_dataset_evidence(
            state,
            "dataset",
            "ddda",
            chrom="chr1",
            evidence_start=-25,
            evidence_end=150,
            maximum_reads=0,
            runtime={"load_bam": load_bam},
        )
    )

    assert reads == ["evidence"]
    assert loaded_model is model
    assert (call["chrom"], call["start"], call["end"]) == ("1", 0, 100)
    assert diagnostics["files"][0]["browser_chrom"] == "chr1"
    assert diagnostics["files"][0]["bam_chrom"] == "1"


def test_bigbed_hia5_reconstruction_honors_the_bam_probability_threshold():
    from services.fiberhmm_runtime import configure_fiberhmm_runtime

    configure_fiberhmm_runtime()
    from fiberhmm.inference.strand_rescue import IntervalCall, ReadEvidence

    n_contexts = 4 ** 6
    miss_offset = n_contexts + 1

    def encode(sequence, modified, **_kwargs):
        return [0 if index in modified else miss_offset for index in range(len(sequence))]

    record = _BigBedRead(
        name="read1",
        sample="sample",
        alignment_strand="+",
        ref_start=0,
        ref_end=100,
        calls=defaultdict(list, {
            "tf": [(40, 56, (220, 200, 200))],
            "msp": [(5, 95, (240,))],
        }),
        marks=defaultdict(list, {
            "m6a": [(10, 100, 0), (20, 200, 1)],
        }),
    )
    fasta = SimpleNamespace(
        references=("chr1",),
        fetch=lambda _chrom, start, end: "A" * (end - start),
    )
    reads, diagnostics = _bigbed_read_evidence(
        SimpleNamespace(fasta=fasta),
        "dataset",
        [record],
        chemistry="hia5-pacbio",
        chrom="chr1",
        evidence_start=0,
        evidence_end=100,
        model={},
        context_size=3,
        mode="pacbio-fiber",
        llr_hit=np.zeros(n_contexts),
        llr_miss=np.zeros(n_contexts),
        prob_threshold=125,
        maximum_reads=0,
        runtime={
            "IntervalCall": IntervalCall,
            "ReadEvidence": ReadEvidence,
            "encode": encode,
        },
    )

    assert diagnostics["evidence_reads"] == 1
    assert reads[0].positions[reads[0].hits].tolist() == [20]


