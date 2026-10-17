"""Synthetic graphlift sidecars and source BAMs for the live-lift tests.

The toy map (``write_toy_sidecar``): target ``chrT`` (20 kb); source
``chrS_MATERNAL`` (10 kb, haplotype ``H#1``) and ``chrS_PATERNAL`` (10 kb,
``H#2``).

- chain 0, MAT ``+``: source ``[0, 3000)`` -> target ``[1000, 4000)``; a 10 bp
  target-only gap; ``[3000, 5000)`` -> ``[4010, 6010)``; a 100 bp source-only gap
  (``source_insertion``); ``[5100, 6990)`` -> ``[6010, 7900)``.
- chain 1, MAT ``-``: source ``[7000, 9000)`` -> target ``[12000, 14000)``.
- chain 2, PAT ``+``: source ``[0, 4000)`` -> target ``[15000, 19000)``.
- chain 3, MAT ``+``: source ``[9100, 9500)`` -> target ``[8000, 8400)`` with a
  3 bp target gap after source 9300 (``[9300, 9500)`` -> ``[8203, 8403)``).
"""
from __future__ import annotations

import gzip
import json
import os

import pysam

TARGET, TSIZE = "chrT", 20_000
MAT, PAT = "chrS_MATERNAL", "chrS_PATERNAL"
SSIZE = 10_000
GAP_REASONS = ["source_insertion", "target_insertion", "aligned_indel", "dissimilar", "too_big", "conflict"]


def _chain(key, hap, source, strand, blocks, qsize):
    t0 = blocks[0][0]
    t1 = blocks[-1][0] + blocks[-1][2]
    q0 = blocks[0][1]
    q1 = blocks[-1][1] + blocks[-1][2]
    qf = (q0, q1) if strand == "+" else (qsize - q1, qsize - q0)
    return dict(key=key, ucsc_id=key, haplotype=hap, target=0, source=source, strand=strand, fragment=key,
                t_start=t0, t_end=t1, q_start=q0, q_end=q1, q_start_forward=qf[0], q_end_forward=qf[1],
                aligned=sum(b[2] for b in blocks))


def _gaps(blocks, reasons):
    out = []
    for (a, b, reason) in zip(blocks, blocks[1:], reasons):
        t, q = a[0] + a[2], a[1] + a[2]
        out.append([t, q, b[0] - t, b[1] - q, GAP_REASONS.index(reason)])
    return out


def write_toy_sidecar(directory) -> str:
    """Write the toy sidecar (manifest plus target files); returns the manifest path."""
    c0 = [[1000, 0, 3000], [4010, 3000, 2000], [6010, 5100, 1890]]
    c1 = [[12000, SSIZE - 9000, 2000]]           # '-' blocks are in reverse-complement source coordinates
    c2 = [[15000, 0, 4000]]
    c3 = [[8000, 9100, 200], [8203, 9300, 200]]
    chains = [_chain("c0", "H#1", 0, "+", c0, SSIZE), _chain("c1", "H#1", 0, "-", c1, SSIZE),
              _chain("c2", "H#2", 1, "+", c2, SSIZE), _chain("c3", "H#1", 0, "+", c3, SSIZE)]
    payload = {
        "target": TARGET,
        "blocks": {"0": c0, "1": c1, "2": c2, "3": c3},
        "gaps": {"0": _gaps(c0, ["target_insertion", "source_insertion"]), "1": [], "2": [],
                 "3": _gaps(c3, ["target_insertion"])},
    }
    nets = {"H#1": [[0, 1000, 7900, 0, []], [0, 8000, 8403, 3, []], [0, 12000, 14000, 1, []]],
            "H#2": [[0, 15000, 19000, 2, []]]}
    manifest = dict(format="graphlift.sidecar", version=2, block_kinds=["anchor", "substitution", "aligned"],
                    gap_reasons=GAP_REASONS, targets=[{"name": TARGET, "size": TSIZE}],
                    sources=[{"name": MAT, "size": SSIZE, "uncovered": []},
                             {"name": PAT, "size": SSIZE, "uncovered": []}],
                    chains=chains, nets=nets,
                    target_files={TARGET: ["toy.t0.chrT.json.gz", "toy.t0.chrT.fills.json.gz"]})
    os.makedirs(directory, exist_ok=True)
    with gzip.open(os.path.join(directory, "toy.t0.chrT.json.gz"), "wt") as fh:
        json.dump(payload, fh)
    with gzip.open(os.path.join(directory, "toy.t0.chrT.fills.json.gz"), "wt") as fh:
        json.dump({"target": TARGET, "fills": {}}, fh)
    path = os.path.join(directory, "toy.graphlift.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh)
    return path


def make_record(header, name, contig, pos, cigar, seq_len=None, *, reverse=False, flag=0, tags=(), seq=None):
    rec = pysam.AlignedSegment(header)
    rec.query_name = name
    rec.reference_id = header.get_tid(contig)
    rec.reference_start = pos
    rec.cigarstring = cigar
    rec.flag = flag | (16 if reverse else 0)
    rec.mapping_quality = 60
    if seq is None:
        seq = "C" * (seq_len if seq_len is not None else rec.infer_query_length())
    rec.query_sequence = seq
    rec.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
    for tag in tags:
        rec.set_tag(*tag)
    return rec


def write_bam(path, records_fn, contigs=((MAT, SSIZE), (PAT, SSIZE)), header_extra=None):
    """Write and index a coordinate-sorted BAM; ``records_fn(header)`` returns records."""
    hdr = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": n, "LN": ln} for n, ln in contigs]}
    hdr.update(header_extra or {})
    header = pysam.AlignmentHeader.from_dict(hdr)
    records = sorted(records_fn(header), key=lambda r: (r.reference_id, r.reference_start))
    tmp = str(path) + ".unsorted.bam"
    with pysam.AlignmentFile(tmp, "wb", header=header) as out:
        for rec in records:
            out.write(rec)
    pysam.sort("-o", str(path), tmp)
    os.remove(tmp)
    pysam.index(str(path))
    return str(path)
