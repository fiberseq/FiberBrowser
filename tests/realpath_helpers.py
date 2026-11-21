"""Helpers for the real-path route tests (coverage plan, group B): a TestClient on a fresh
main state holding given BAMs, and a synthetic chromatin BAM with planted open loci.

Everything here is synthetic or the tracked demo BAM; nothing is patched.
"""
from __future__ import annotations

import array
import contextlib
from pathlib import Path

import numpy as np

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@contextlib.contextmanager
def state_client(app, datasets: dict[str, str], *, configure=None):
    """A TestClient whose main state holds ``datasets`` ({id: BAM path}); restored afterwards."""
    import server as srv
    from starlette.testclient import TestClient
    from conftest import auth_headers
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous = srv.state
    previous_runtime = runtime_state._state
    state = BrowserState(None, None, None, None)
    for dataset_id, path in datasets.items():
        state.add_dataset(dataset_id, str(path), dataset_id)
    if configure:
        configure(state)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        yield TestClient(app, headers=auth_headers()), state
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


# --------------------------------------------------------------------------
# Planted chromatin: packed nucleosomes everywhere, one open locus in some reads
# --------------------------------------------------------------------------

CONTIG = "chrP"
CONTIG_LEN = 20_000
READ_START, READ_END = 1_000, 19_000
OPEN_LOCUS = (9_000, 9_300)        # open (an MSP) in the reads marked open
CLOSED_LOCUS = (14_000, 14_300)    # a nucleosome in every read


def _header() -> dict:
    pg = {"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.2",
          "CL": "fiberhmm-call -i in.bam -o out.bam --enzyme hia5 --seq pacbio",
          "DS": "FiberHMM fused apply+recall; coord=molecular; mode=pacbio-fiber"}
    return {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CONTIG, "LN": CONTIG_LEN}], "PG": [pg]}


def _pack(rng, a: int, b: int) -> list[tuple[int, int]]:
    """Footprints packed over [a, b) at a random phase: 147 bp with 8-12 bp linkers; the first
    starts at a and the last runs to b, so only the short linkers are open."""
    first = a + int(rng.integers(0, 157)) + 147
    out, pos = [(a, first)], first + int(rng.integers(8, 13))
    while b - pos >= 147 + 12 + 147:
        out.append((pos, pos + 147))
        pos += 147 + int(rng.integers(8, 13))
    if b > pos:
        out.append((pos, b))
    return out


def planted_bam(path, *, n_reads: int = 40, open_fraction: float = 0.7, seed: int = 5) -> tuple[str, set[str]]:
    """Write and index the BAM; return (path, names of the reads open at OPEN_LOCUS).

    Each read spans READ_START..READ_END, packed with footprints and 8-12 bp linkers (far below
    any peak threshold; the jitter keeps the reads out of phase). In the open reads OPEN_LOCUS
    is one 300 bp MSP; CLOSED_LOCUS is inside one footprint in every read.
    """
    import pysam
    rng = np.random.default_rng(seed)
    length = READ_END - READ_START
    seq = "".join(rng.choice(list("ACGT"), size=length))
    open_reads = set()
    records = []
    n_open = int(round(n_reads * open_fraction))
    closed = (CLOSED_LOCUS[0] - 20, CLOSED_LOCUS[1] + 20)
    for k in range(n_reads):
        name = f"planted-{k:03d}"
        is_open = k < n_open
        if is_open:
            open_reads.add(name)
            nucs = _pack(rng, READ_START, OPEN_LOCUS[0]) + _pack(rng, OPEN_LOCUS[1], closed[0])
        else:
            nucs = _pack(rng, READ_START, closed[0])
        nucs += [closed] + _pack(rng, closed[1], READ_END)
        prev = READ_START
        msps = []
        for s, e in nucs:
            if s > prev:
                msps.append((prev, s))
            prev = e
        if prev < READ_END:
            msps.append((prev, READ_END))
        records.append((name, nucs, msps))

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with pysam.AlignmentFile(str(path), "wb", header=_header()) as out:
        for name, nucs, msps in records:
            r = pysam.AlignedSegment(out.header)
            r.query_name = name
            r.flag = 0
            r.reference_id = 0
            r.reference_start = READ_START
            r.mapping_quality = 60
            r.cigarstring = f"{length}M"
            r.query_sequence = seq
            r.query_qualities = array.array("B", [30] * length)
            # fibertools-style footprint tags in molecular coordinates: ns/nl nucleosomes, as/al MSPs.
            r.set_tag("ns", array.array("I", [s - READ_START for s, _ in nucs]))
            r.set_tag("nl", array.array("I", [e - s for s, e in nucs]))
            r.set_tag("as", array.array("I", [s - READ_START for s, _ in msps]))
            r.set_tag("al", array.array("I", [e - s for s, e in msps]))
            out.write(r)
    pysam.index(str(path))
    return str(path), open_reads
