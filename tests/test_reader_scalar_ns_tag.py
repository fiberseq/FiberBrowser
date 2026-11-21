"""Dorado writes ns:i (the read's signal sample count) on every basecalled ONT read. The reader took any ns tag
for fibertools footprint starts, failed to parse it without nl and silently dropped the read from every view."""
from __future__ import annotations

from array import array

import pysam

from services.compact_read_loader import build_compact_reads_from_bam


def _write(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        def rec(name, start, tags):
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = name, 0, start, 60
            r.query_sequence = "ACGT" * 500
            r.cigarstring = "2000M"
            for tag, value in tags:
                r.set_tag(tag, value)
            out.write(r)
        # Dorado-basecalled, uncalled: scalar ns / ts, no footprints.
        rec("dorado_raw", 1000, [("ns", 48_213), ("ts", 12), ("qs", 18.5)])
        # Dorado-basecalled, then FiberHMM-called (footprints in MA): the scalar ns must not hide the calls.
        rec("dorado_called", 1100, [("ns", 51_007), ("ts", 9), ("MA", "2000;nuc+Q:101-147,601-147,1801-147"), ("AQ", array("B", [200, 200, 200]))])
        # fibertools footprints: still parsed.
        rec("fibertools", 1200, [("ns", array("I", [100, 600, 1800])), ("nl", array("I", [147, 147, 147]))])
    pysam.index(str(path))
    return str(path)


def _reads(path, **kw):
    out = build_compact_reads_from_bam(path, "chrT", 900, 3400, spanning_only=False, **kw)
    reads = out[0] if isinstance(out, tuple) else out
    return {r["id"]: r for r in reads}


def test_scalar_ns_is_not_a_footprint_tag(tmp_path):
    reads = _reads(_write(tmp_path / "ont.bam"))
    assert set(reads) == {"dorado_raw", "dorado_called", "fibertools"}
    assert sum(1 for iv in reads["fibertools"]["intervals"] if iv[2] > 0) == 3
    assert all(iv[2] <= 0 for iv in reads["dorado_raw"]["intervals"])


def test_called_dorado_read_keeps_its_ma_layers(tmp_path):
    reads = _reads(_write(tmp_path / "ont.bam"), include_layers=True, requested_layers=["nuc"])
    layer = (reads["dorado_called"].get("layers") or {}).get("nuc") or {}
    assert layer.get("intervals"), reads["dorado_called"]


def test_interval_tag_pair(tmp_path):
    from services.bam_tags import interval_tag_pair
    path = _write(tmp_path / "ont.bam")
    with pysam.AlignmentFile(path) as bam:
        by = {r.query_name: r for r in bam.fetch("chrT")}
    assert interval_tag_pair(by["dorado_raw"], "ns", "nl") == (None, None)
    starts, lengths = interval_tag_pair(by["fibertools"], "ns", "nl")
    assert list(starts) == [100, 600, 1800] and list(lengths) == [147, 147, 147]


def test_library_counts_do_not_call_dorado_reads_annotated(tmp_path):
    from services.pipeline_jobs import _count_bam
    counts = _count_bam(_write(tmp_path / "ont.bam"), 100)
    assert counts["called"] == 2 and counts["nucleosomes"] == 3


def test_reads_compact_route_shows_dorado_reads(client, tmp_path):
    # The plain display route: the Dorado reads with calls are shown. The raw Dorado read
    # (a scalar ns:i, no calls) is hidden and counted as uncalled by Min footprints
    # (the default); with hide_uncalled=false every read of the view is shown.
    path = _write(tmp_path / "ont.bam")
    added = client.post("/api/datasets/add", json={"path": path, "label": "ont"})
    assert added.status_code == 200, added.text
    body = added.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    resp = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom="chrT", start=900, end=3400))
    assert resp.status_code == 200, resp.text
    ids = {r["id"] for r in resp.json()["reads"]}
    assert ids >= {"dorado_called", "fibertools"} and "dorado_raw" not in ids
    assert resp.json()["signal_counts"]["uncalled_hidden"] == 1
    shown = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom="chrT", start=900, end=3400,
                                                         hide_uncalled="false"))
    assert shown.status_code == 200, shown.text
    assert {r["id"] for r in shown.json()["reads"]} >= {"dorado_raw", "dorado_called", "fibertools"}
    assert shown.json()["signal_counts"]["uncalled_hidden"] == 0
    # The frontend's Min footprints "All reads, including uncalled" (-1) does the same.
    hatch = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom="chrT", start=900, end=3400, min_footprints=-1))
    assert {r["id"] for r in hatch.json()["reads"]} >= {"dorado_raw", "dorado_called", "fibertools"}


def _write_odd(path):
    """Reads whose tag names collide with the fiber tags in other ways (audit cases)."""
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        def rec(name, start, tags):
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = name, 0, start, 60
            r.query_sequence = "ACGT" * 500
            r.cigarstring = "2000M"
            for tag, value in tags:
                r.set_tag(tag, value)
            out.write(r)
        # Dorado scalar ns + fibertools molecular Ma calls: a called read.
        rec("dorado_Ma", 1000, [("ns", 40_000), ("Ma", "2000;nuc+Q:101-147,601-147")])
        # Dorado scalar ns + an as/al MSP pair: a called read.
        rec("dorado_msp", 1050, [("ns", 41_000), ("as", array("I", [300])), ("al", array("I", [200]))])
        # String-valued ns/nl are not footprints.
        rec("strings", 1100, [("ns", "raw"), ("nl", "none")])
        # Valid footprints with scalar as/al: the read and the reads after it still load.
        rec("scalar_as", 1150, [("ns", array("I", [100, 600, 1800])), ("nl", array("I", [147, 147, 147])), ("as", 7), ("al", 9)])
        rec("after", 1200, [("ns", array("I", [100, 600, 1800])), ("nl", array("I", [147, 147, 147]))])
    pysam.index(str(path))
    return str(path)


def test_library_counts_called_reads_with_ma_or_msps_despite_scalar_ns(tmp_path):
    from services.pipeline_jobs import _count_bam
    counts = _count_bam(_write_odd(tmp_path / "odd.bam"), 100)
    # dorado_Ma, dorado_msp, scalar_as, after; not the string-tag read.
    assert counts["called"] == 4 and counts["nucleosomes"] == 6


def test_string_tags_and_scalar_as_do_not_drop_reads(tmp_path):
    from services.bam_tags import interval_tag_pair
    path = _write_odd(tmp_path / "odd.bam")
    with pysam.AlignmentFile(path) as bam:
        by = {r.query_name: r for r in bam.fetch("chrT")}
    assert interval_tag_pair(by["strings"], "ns", "nl") == (None, None)
    assert interval_tag_pair(by["scalar_as"], "as", "al") == (None, None)
    reads = _reads(path)
    assert {"scalar_as", "after"} <= set(reads)


def test_dafc_reads_use_the_pair_rule(tmp_path):
    """DAF-C (dev line): a scalar or string ns is not footprints; a Dorado read with Ma calls falls back to them, and
    valid ns/nl reads are unaffected by a scalar as/al."""
    from services.dafc_reads import query_bam_for_dafc
    path = _write_odd(tmp_path / "odd.bam")
    # Min footprints hides the uncalled string-tag read by default; "All reads" shows it as uncalled.
    assert "strings" not in {e["name"] for e in query_bam_for_dafc(path, "chrT", 0, 5000)}
    entries = {e["name"]: e for e in query_bam_for_dafc(path, "chrT", 0, 5000, hide_uncalled=False)}
    assert {"dorado_Ma", "strings", "scalar_as", "after"} <= set(entries)
    called = {name for name, e in entries.items() if e.get("footprintsCalled")}
    assert {"dorado_Ma", "scalar_as", "after"} <= called
    assert "strings" not in called
    assert entries["dorado_Ma"]["blockCount"] == 2   # the Ma nuc calls, not the scalar ns
