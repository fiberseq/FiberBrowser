"""Named nucleosome classes were removed (owner, 20 Nov 2026): no named class without an absolute control.

A BAM from FiberHMM 3.1 or earlier still carries the named byte (``nucsz.QQQQ``: coarse, named, posterior, z). It is
ignored silently: the read loads, its marks match coarse/z/TF conditions as before, and nothing reports or matches a
named class. A FiberHMM 3.2.0 three-byte group (coarse, posterior, z) reads the same. A rule that still sends
``nuc_named`` has it ignored, never refused.
"""
from __future__ import annotations

import pytest

pysam = pytest.importorskip("pysam")

import array as array_mod

CONTIG, LENGTH, MOL = "chrS", 200_000, 3500
NUC_STARTS = [301 + 190 * k for k in range(8)]          # 1-based MA starts, 147 bp cores


def _header():
    from fiberhmm.nuc.tags import annotate_header
    pg = {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.1.0",
          "CL": "fiberhmm-call -i in.bam -o out.bam --enzyme hia5 --seq pacbio",
          "DS": "FiberHMM fused apply+recall; coord=molecular; mode=pacbio-fiber"}
    hd = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": LENGTH}], "PG": [pg], "CO": []}
    return annotate_header(pysam.AlignmentHeader.from_dict(hd))


def _record(header, name, ref_start):
    """A FiberHMM 3.1 annotated record: nucsz.QQQQ with a named byte on every mark (octasome 3 on mono calls,
    hexasome 2 on long ones), alternating mono (coarse 2, z 0) and long (coarse 3, z byte 150 = 1.1)."""
    from fiberhmm.nuc.tags import NUCMOL_SPEC, encode_nucmol, record_calls_digest
    r = pysam.AlignedSegment(header)
    r.query_name, r.flag, r.reference_id, r.reference_start = name, 0, 0, ref_start
    r.mapping_quality, r.cigarstring = 60, f"{MOL}M"
    r.query_sequence = ("ACGTTGCA" * (MOL // 8 + 1))[:MOL]
    r.query_qualities = array_mod.array("B", [30] * MOL)
    calls = ",".join(f"{s}-147" for s in NUC_STARTS)
    r.set_tag("MA", f"{MOL};nuc.:{calls}")
    digest = record_calls_digest(r)
    nucmol = encode_nucmol({"nrl": 190.0}, {}, digest=digest)
    r.set_tag("MA", f"{MOL};nuc.:{calls};nucsz.QQQQ:{calls};nucmol.{NUCMOL_SPEC}:1-{MOL}")
    marks = [(2, 3, 230, 128) if k % 2 == 0 else (3, 2, 200, 150) for k in range(len(NUC_STARTS))]
    r.set_tag("AQ", array_mod.array("B", [b for m in marks for b in m] + list(nucmol)))
    r.set_tag("AN", ",".join(["."] * len(NUC_STARTS) + [f"nucsz@{digest}_{k}" for k in range(len(NUC_STARTS))]
                             + ["nucmol"]))
    return r


@pytest.fixture
def named_bam(tmp_path, monkeypatch):
    from services.nuc.store import STORE
    monkeypatch.setenv("FIBERBROWSER_SCAN_CACHE_DIR", str(tmp_path / "cache"))
    STORE.clear()
    path = str(tmp_path / "fiberhmm31_named.bam")
    header = _header()
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        out.write(_record(out.header, "r1", 10_000))
    pysam.index(path)
    yield path
    STORE.clear()


def test_a_fiberhmm_31_bam_with_the_named_byte_loads_and_ignores_it(named_bam):
    from services.clustering_features import nuc_size_index
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.read_metrics import compute_rule_metric
    (read,) = build_compact_reads_from_bam(named_bam, CONTIG, 9_000, 15_000, spanning_only=False, include_layers=True,
                                           requested_layers=None, include_layer_qualities=True,
                                           hide_terminal_gaps=False)
    layer = read["layers"]["nucsz"]
    # The named byte is dropped at parse: no quality name or track for it (nothing can gate or match on it).
    assert len(layer["intervals"]) == len(NUC_STARTS) and len(layer["qualities"]) == 3
    assert layer["quality_names"] == ["coarse", "posterior", "z"]
    _starts, marks, _longest = nuc_size_index(read)
    assert {(m["coarse"], m["posterior"], m["z"]) for m in marks} == {(2, 230, 128), (3, 200, 150)}
    assert all("named" not in m for m in marks)
    base = {"size_min": 1, "size_max": None, "conditions": [], "quality_gates": []}
    count = lambda **nuc: compute_rule_metric(read, 9_000, {**base, **nuc}, [], [], layer="nuc")
    half = len(NUC_STARTS) // 2
    assert count(nuc_coarse=[2]) == half and count(nuc_coarse=[3]) == half and count(nuc_coarse=[1]) == 0
    assert count(z_min=1.0) == half       # the long calls' z byte (z = 1.1), never the named or posterior byte
    # A named-class condition (removed) is ignored, never refused: every call still counts.
    assert count(nuc_named=[3]) == len(NUC_STARTS) and count(nuc_named=[4]) == len(NUC_STARTS)


def test_a_three_byte_layer_matches_like_the_four_byte_one():
    from services.clustering_features import nuc_size_index
    four = {"layers": {"nucsz": {"intervals": [[0, 147, 147]], "quality_names": ["coarse", "named", "posterior", "z"],
                                 "qualities": [[2], [3], [230], [120]]}}}
    three = {"layers": {"nucsz": {"intervals": [[0, 147, 147]], "quality_names": ["coarse", "posterior", "z"],
                                  "qualities": [[2], [230], [120]]}}}
    assert nuc_size_index(four)[1] == nuc_size_index(three)[1] == [
        {"start": 0, "end": 147, "coarse": 2, "posterior": 230, "z": 120, "len": 147}]


def test_graph_pieces_and_the_nuc_store_skip_the_named_byte():
    from services.nuc.layers import QUALITY_NAMES
    from services.nuc.sizebytes import nucsz_bytes, nucsz_positions
    assert QUALITY_NAMES["nucsz"] == ["coarse", "posterior", "z"]
    assert nucsz_positions(4) == (0, 2, 3) and nucsz_positions(3) == (0, 1, 2)
    assert nucsz_bytes((2, 3, 230, 128)) == nucsz_bytes((2, 230, 128)) == (2, 230, 128)
    assert nucsz_bytes((2,)) == (2, None, None)
