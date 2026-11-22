"""Synthetic data for the scripted (headless) figure tests: two small BAMs and a saved session.

Everything is generated at test time from fixed seeds, so the reads, read names and session are the
same on every machine. Nothing here comes from real samples.

Each BAM covers ``chrS`` (12 kb). Reads carry fibertools-style footprint tags in molecular coordinates
(ns/nl nucleosomes, as/al MSPs). At OPEN_LOCUS every read is open by a planted MSP of one of
OPEN_WIDTHS (0 = closed: a nucleosome covers the locus). Every tenth read (k % 10 == 3) has a
DELETION_LEN bp deletion at DELETION_START, so the panel's "SV - in loaded reads" strip shows. Every
seventh read starts at PARTIAL_START, so it does not span the view.
"""
from __future__ import annotations

import array
import copy
from pathlib import Path

import numpy as np

CONTIG = "chrS"
CONTIG_LEN = 12_000
READ_START, READ_END = 1_000, 11_000
PARTIAL_START = 5_000
VIEW = (2_000, 10_000)
OPEN_LOCUS = (6_000, 6_060)          # the annotated interval (reads open here by a planted MSP)
OPEN_WIDTHS = (0, 120, 250, 400, 650)
DELETION_START, DELETION_LEN = 8_500, 300
CLEAR = (8_400, 8_900)               # no nucleosome is placed here in deletion reads

DATASETS = (("ds-a", "Sample A", "#2563eb", 11), ("ds-b", "Sample B", "#dc2626", 23))


def _pack(rng, a: int, b: int) -> list[tuple[int, int]]:
    """147 bp footprints with 15-40 bp linkers over [a, b), at a random phase."""
    out, pos = [], a + int(rng.integers(5, 60))
    while pos + 147 <= b:
        out.append((pos, pos + 147))
        pos += 147 + int(rng.integers(15, 41))
    return out


def _read(rng, k: int):
    start = PARTIAL_START if k % 7 == 6 else READ_START
    width = OPEN_WIDTHS[k % len(OPEN_WIDTHS)]
    deletion = k % 10 == 3
    o0 = OPEN_LOCUS[0] - int(rng.integers(0, 30))
    if width:
        nucs = _pack(rng, start, o0) + _pack(rng, o0 + width, READ_END)
    else:
        nucs = _pack(rng, start, OPEN_LOCUS[0] - 60) + [(OPEN_LOCUS[0] - 50, OPEN_LOCUS[0] + 97)] \
            + _pack(rng, OPEN_LOCUS[0] + 97, READ_END)
    if deletion:
        nucs = [(s, e) for s, e in nucs if e <= CLEAR[0] or s >= CLEAR[1]]
    msps, prev = [], start
    for s, e in nucs:
        if s > prev:
            msps.append((prev, s))
        prev = e
    if prev < READ_END:
        msps.append((prev, READ_END))
    return start, nucs, msps, deletion


def _to_query(pos: int, start: int, deletion: bool) -> int:
    if deletion and pos >= DELETION_START + DELETION_LEN:
        return pos - start - DELETION_LEN
    return pos - start


def write_bam(path, seed: int, n_reads: int = 60, prefix: str = "syn") -> str:
    """Write and index one synthetic BAM; returns its path."""
    import pysam
    rng = np.random.default_rng(seed)
    seq_rng = np.random.default_rng(1000 + seed)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": CONTIG_LEN}],
              "PG": [{"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.2.1",
                      "CL": "fiberhmm-call -i in.bam -o out.bam --enzyme hia5 --seq pacbio",
                      "DS": "FiberHMM fused apply+recall; coord=molecular; mode=pacbio-fiber"}]}
    records = []
    for k in range(n_reads):
        start, nucs, msps, deletion = _read(rng, k)
        ref_len = READ_END - start
        qlen = ref_len - (DELETION_LEN if deletion else 0)
        records.append((start, f"{prefix}-{seed:02d}-{k:03d}", nucs, msps, deletion, qlen))
    records.sort(key=lambda r: (r[0], r[1]))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for start, name, nucs, msps, deletion, qlen in records:
            r = pysam.AlignedSegment(out.header)
            r.query_name = name
            r.flag = 0
            r.reference_id = 0
            r.reference_start = start
            r.mapping_quality = 60
            if deletion:
                left = DELETION_START - start
                r.cigarstring = f"{left}M{DELETION_LEN}D{qlen - left}M"
            else:
                r.cigarstring = f"{qlen}M"
            r.query_sequence = "".join(seq_rng.choice(list("ACGT"), size=qlen))
            r.query_qualities = array.array("B", [30] * qlen)
            r.set_tag("ns", array.array("I", [_to_query(s, start, deletion) for s, _ in nucs]))
            r.set_tag("nl", array.array("I", [e - s for s, e in nucs]))
            r.set_tag("as", array.array("I", [_to_query(s, start, deletion) for s, _ in msps]))
            r.set_tag("al", array.array("I", [_to_query(e, start, deletion) - _to_query(s, start, deletion)
                                              for s, e in msps]))
            out.write(r)
    pysam.index(str(path))
    return str(path)


def write_datasets(folder) -> dict:
    """Both BAMs under ``folder``: {dataset id: path}."""
    folder = Path(folder)
    return {ds_id: write_bam(folder / f"{ds_id}.bam", seed) for ds_id, _label, _color, seed in DATASETS}


def read_names(seed: int, n_reads: int = 60, prefix: str = "syn") -> list[str]:
    return [f"{prefix}-{seed:02d}-{k:03d}" for k in range(n_reads)]


def session(paths: dict, *, sv_row: bool = False) -> dict:
    """A FiberBrowser 3.1-style saved session over both datasets.

    Reversed view, two stacked panels, stored k-means style cluster assignments (keyed by read name) and
    a cluster order in the first panel. Like sessions saved before the SV row was its own track, its
    panels list no 'sv' sub-track unless ``sv_row``.
    """
    sub = [{"type": "axis", "visible": True}, {"type": "reads", "visible": True}, {"type": "gene", "visible": True}]
    if sv_row:
        sub.insert(1, {"type": "sv", "visible": True})
    seed_a = DATASETS[0][3]
    names_a = read_names(seed_a)
    assignments = {name: (i * 7 + 3) % 4 for i, name in enumerate(names_a)}
    return {
        "version": "2.0",
        "viewport": {"chrom": CONTIG, "start": VIEW[0], "end": VIEW[1]},
        "datasets": [{"id": ds_id, "label": label, "paths": [paths[ds_id]], "color": color, "data_type": "bam"}
                     for ds_id, label, color, _seed in DATASETS],
        "frontend": {
            "chrom": CONTIG, "start": VIEW[0], "end": VIEW[1],
            "isReversed": True,
            "readRowHeight": 3,
            "spanningOnly": False,
            "panels": [
                {"id": f"panel-{ds_id}", "contentType": "dataset", "datasetId": ds_id,
                 "subTracks": copy.deepcopy(sub), "collapsed": False, "layoutRow": 0, "layoutColumn": 0}
                for ds_id, _label, _color, _seed in DATASETS
            ],
            "clusterAssignments": {"ds-a": assignments},
            "clusterOrder": {"ds-a": [2, 0, 3, 1]},
        },
    }
