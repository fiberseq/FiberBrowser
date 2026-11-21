"""MA/AQ layers: walking only the intervals that can reach the view (bam_tags._ma_region_plan) gives exactly the rows
of walking every interval, for every loader output field, on the demo and fixture BAMs (both strands, molecular and
SEQ frame, insertions, envelope groups), small and large views, with and without qualities."""
from __future__ import annotations

from array import array
from pathlib import Path

import pysam
import pytest

from services import bam_tags
from services.compact_read_loader import build_compact_reads_from_bam

ROOT = Path(__file__).resolve().parents[1]
BAMS = [ROOT / "browser/data/demo/napa_ddda.bam", ROOT / "browser/data/demo/h1_chr1_insertion.bam",
        *sorted((ROOT / "tests/fixtures/fibertools_frame").glob("*.bam"))]


def _views(path, n=6):
    with pysam.AlignmentFile(str(path)) as bam:
        stats = [s for s in bam.get_index_statistics() if s.mapped]
        if not stats:
            return []
        contig = max(stats, key=lambda s: s.mapped).contig
        spans = [(r.reference_start, r.reference_end) for r in bam.fetch(contig) if r.reference_end]
    lo, hi = min(a for a, _ in spans), max(b for _, b in spans)
    out = []
    for i in range(n):
        centre = lo + (hi - lo) * (i + 1) // (n + 1)
        for half in (40, 300, 1500):
            out.append((contig, max(0, centre - half), centre + half))
    out.append((contig, lo, hi))
    return out


def _rows(path, contig, start, end, **kw):
    out = build_compact_reads_from_bam(str(path), contig, start, end, spanning_only=False, **kw)
    return out[0] if isinstance(out, tuple) else out


@pytest.mark.parametrize("path", BAMS, ids=lambda p: p.name)
@pytest.mark.parametrize("options", [dict(include_layers=True), dict(include_layers=True, include_layer_qualities=False),
                                     dict(include_layers=True, include_methylation=True, requested_layers=["nuc", "tf"])],
                         ids=["layers", "no_qualities", "requested"])
def test_region_plan_rows_are_identical(path, options, monkeypatch):
    views = _views(path)
    assert views
    planned = [_rows(path, *v, **options) for v in views]
    monkeypatch.setattr(bam_tags, "_ma_region_plan", lambda *a, **k: None)
    walked = [_rows(path, *v, **options) for v in views]
    assert planned == walked
    assert sum(len(r) for r in planned) > 0


def _synthetic(tmp_path, reverse, molecular_header):
    """Reads with long MA sections (> 16 intervals: the batched path), insertions, deletions, a soft clip, nucsz
    marks inside an insertion (envelope groups), on either strand, with or without a molecular-frame header."""
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrT", "LN": 100_000}]}
    if molecular_header:
        header["PG"] = [{"ID": "fiberhmm", "PN": "fiberhmm", "CL": "fiberhmm-apply --coords molecular"}]
    path = tmp_path / f"syn_{int(reverse)}_{int(molecular_header)}.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(6):
            r = pysam.AlignedSegment(out.header)
            r.query_name, r.reference_id, r.reference_start, r.mapping_quality = f"r{i}", 0, 1000 + 400 * i, 60
            r.flag = 16 if reverse else 0
            r.cigarstring = "50S1500M30I1200M40D2200M"
            qlen = 50 + 1500 + 30 + 1200 + 2200
            r.query_sequence = "ACGT" * (qlen // 4) + "ACGT"[: qlen % 4]
            nuc = [(60 + 190 * k, 147) for k in range(25)]
            tf = [(130 + 97 * k, 20) for k in range(45)]
            nucsz = [(1555, 10), (1560, 12)] + [(2000 + 180 * k, 147) for k in range(20)]
            ma = f"{qlen};nuc+Q:" + ",".join(f"{a + 1}-{b}" for a, b in nuc)
            ma += ";tf+QQQ:" + ",".join(f"{a + 1}-{b}" for a, b in tf)
            ma += ";nucsz+QQQQ:" + ",".join(f"{a + 1}-{b}" for a, b in nucsz)
            r.set_tag("MA", ma)
            r.set_tag("AQ", array("B", [(7 * k) % 256 for k in range(len(nuc) + 3 * len(tf) + 4 * len(nucsz))]))
            out.write(r)
    pysam.index(str(path))
    return path


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("molecular", [False, True])
def test_region_plan_synthetic_edges(tmp_path, monkeypatch, reverse, molecular):
    path = _synthetic(tmp_path, reverse, molecular)
    views = [("chrT", s, s + w) for s in (900, 1500, 2550, 2560, 3000, 4500, 6000) for w in (5, 60, 700, 9000)]
    planned = [_rows(path, *v, include_layers=True) for v in views]
    monkeypatch.setattr(bam_tags, "_ma_region_plan", lambda *a, **k: None)
    walked = [_rows(path, *v, include_layers=True) for v in views]
    assert planned == walked
    assert any(r.get("layers") for rows in planned for r in rows)


def test_present_names_counts_layers_outside_the_view():
    """A layer mapped only outside the view still counts as present (the loader's layer availability)."""
    from models.domain import CigarCoordMapper
    mapper = CigarCoordMapper([(0, 5000)], 1000)
    ma = "5000;tf+Q:" + ",".join(f"{100 + 10 * k}-5" for k in range(40))
    present: set = set()
    layers = bam_tags.parse_ma_aq_tags_into_layers(ma, array("B", [1] * 40), mapper, 5000, 5100, present_names=present)
    assert layers == {} and present == {"tf"}


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("qualities", [True, False])
def test_parser_parity_with_envelope_groups_and_insertions(monkeypatch, reverse, qualities):
    """The parser itself, over sections the loader may not request: nucsz marks inside an insertion (mapped to the
    nearest aligned base), every view edge, present names, molecular flips."""
    from models.domain import CigarCoordMapper
    cigar = [(4, 50), (0, 1500), (1, 30), (0, 1200), (2, 40), (0, 2200)]
    qlen = 50 + 1500 + 30 + 1200 + 2200
    nuc = [(60 + 190 * k, 147) for k in range(25)]
    nucsz = [(1555, 10), (1560, 12), (1552, 20)] + [(2000 + 180 * k, 147) for k in range(20)]
    ma = (f"{qlen};nuc+Q:" + ",".join(f"{a + 1}-{b}" for a, b in nuc)
          + ";nucsz+QQQQ:" + ",".join(f"{a + 1}-{b}" for a, b in nucsz))
    aq = array("B", [(5 * k) % 256 for k in range(len(nuc) + 4 * len(nucsz))])

    def run(start, end):
        present: set = set()
        layers = bam_tags.parse_ma_aq_tags_into_layers(ma, aq, CigarCoordMapper(cigar, 1000), start, end,
                                                       include_qualities=qualities, read_length=qlen, is_reverse=reverse,
                                                       tags_are_molecular=reverse, present_names=present)
        return layers, present

    views = [(s, s + w) for s in (900, 1500, 2490, 2500, 2505, 3000, 4500, 6000) for w in (1, 5, 60, 700, 9000)]
    planned = [run(*v) for v in views]
    monkeypatch.setattr(bam_tags, "_ma_region_plan", lambda *a, **k: None)
    walked = [run(*v) for v in views]
    assert planned == walked
    assert any("nucsz" in layers for layers, _ in planned)
