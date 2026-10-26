"""DAF strand on graph rows with realistic records (graph features, item 11).

No DAF-seq data is public in this workspace, so a DAF-like BAM is derived at test time from the HG002 AluY demo BAM
(FIBERBROWSER_TEST_LIFT_BAM, lifted with FIBERBROWSER_TEST_LIFT_MAP and drawn on FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE):
real sequences, alignments, supplementaries and lift, with deamination marks written as DAF writes them (Y for C>T,
R for G>A in SEQ) on a seeded share of each molecule's C or G bases, an st:Z tag on some primaries, an explicit '.'
on a few, and a few molecules whose marks are mixed. Each graph row's strand must equal the linear lifted rows' strand
of the same record, and a one-strand member's band holds only that strand's rows.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pysam
import pytest

from services.graph_panel import analysis, service
from services.graph_panel import reads as gr
from services.graph_panel.worker import LIVE_PIDS

HELPER = os.environ.get("FIBERBROWSER_TEST_GRAPH_HELPER", "").strip()
HPRC = os.environ.get("FIBERBROWSER_TEST_GRAPH_HPRC_PACKAGE", "").strip()
BAM = os.environ.get("FIBERBROWSER_TEST_LIFT_BAM", "")
MAP = os.environ.get("FIBERBROWSER_TEST_LIFT_MAP", "")
pytestmark = pytest.mark.skipif(not (HELPER and os.path.isfile(HELPER) and HPRC and Path(HPRC).is_dir() and BAM
                                     and Path(BAM).is_file() and MAP and Path(MAP).is_file()),
                                reason="set the graph helper, the HPRC package and the HG002 demo BAM and map")


def _seeded(name: str, salt: str) -> int:
    return int(hashlib.sha1(f"{salt}:{name}".encode()).hexdigest()[:8], 16)


def make_daf_bam(src: str, out: str) -> dict:
    """The DAF-like copy of ``src``: returns {QNAME: intended strand} (None: explicit '.')."""
    intended: dict = {}
    names: dict = {}
    with pysam.AlignmentFile(src) as bam:
        header = bam.header.to_dict()
        header.pop("PG", None)
        records = [r for r in bam.fetch() if not r.is_secondary and not r.is_unmapped]
    with pysam.AlignmentFile(out, "wb", header=header) as w:
        for r in records:
            q = r.query_name
            if q not in names:
                names[q] = f"daf{len(names):04d}"
                h = _seeded(q, "strand")
                intended[names[q]] = "CT" if h % 2 else "GA"
            name = names[q]
            strand = intended[name]
            h = _seeded(q, "kind")
            seq = list(r.query_sequence or "")
            base, mark = ("C", "Y") if strand == "CT" else ("G", "R")
            other_base, other_mark = ("G", "R") if strand == "CT" else ("C", "Y")
            for i, b in enumerate(seq):
                k = _seeded(f"{q}:{r.is_supplementary}:{i}", "mark") % 1000
                if b == base and k < 40:
                    seq[i] = mark
                elif b == other_base and k < (30 if h % 7 == 0 else 3):   # mixed marks on some molecules
                    seq[i] = other_mark
            quals = r.query_qualities
            tags = [(t, v) for t, v in r.get_tags() if t not in ("MM", "ML", "Mm", "Ml", "st")]
            if not r.is_supplementary and h % 5 == 0:
                tags.append(("st", strand))            # an explicit call
            if not r.is_supplementary and h % 23 == 0:
                tags = [(t, v) for t, v in tags if t != "st"] + [("st", ".")]
                intended[name] = None
            r.query_name = name
            r.query_sequence = "".join(seq)
            r.query_qualities = quals
            r.set_tags(tags)
            w.write(r)
    pysam.sort("-o", out + ".s", out)
    os.replace(out + ".s", out)
    pysam.index(out)
    return intended


@pytest.fixture(scope="module")
def daf(tmp_path_factory):
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("FIBERBROWSER_GRAPH_HELPER", HELPER)
        mp.setenv("FIBERBROWSER_GRAPH_REGISTRY", str(tmp_path_factory.mktemp("graph") / "registry.json"))
        mp.delenv("FIBERBROWSER_GRAPH_PACKAGES", raising=False)
        mp.setenv("FIBERBROWSER_LIVE_LIFT", "1")
        service.reset_for_tests()
        analysis.clear_caches()
        gr.clear_cache()
        out = str(tmp_path_factory.mktemp("daf") / "daf.bam")
        intended = make_daf_bam(BAM, out)
        from plugins import init_context
        from services.lift.registration import add_live_lift_dataset
        from state.browser_state import BrowserState
        st = BrowserState(None, None, None, None)
        init_context(st)
        st.max_working_reads = 10000
        assert add_live_lift_dataset(st, paths=[out], manifest=MAP, dataset_id="daf")["success"]
        yield st, intended
        service.reset_for_tests()
        analysis.clear_caches()
        gr.clear_cache()


def _graph_rows(st, window_by_contig):
    async def go():
        try:
            await service.ensure_ready()
            reg = await asyncio.to_thread(service.registry().register, service.helper_status().path, HPRC)
            [bound] = [b for b in gr.read_bindings(st, reg) if b["dataset_id"] == "daf"]
            paths = [{"binding": k, "windows": [{"start": window_by_contig[c][0], "end": window_by_contig[c][1]}]}
                     for k, c in bound["paths"].items() if c in window_by_contig]
            return await asyncio.to_thread(gr.load, st, reg, {
                "datasets": [{"dataset_id": "daf", "revision": bound["revision"]}], "paths": paths}, max_molecules=5000)
        finally:
            await service.shutdown()
    out = asyncio.run(go())
    assert not LIVE_PIDS
    return out["reads"]


def test_graph_rows_have_the_linear_rows_strand_on_realistic_records(daf):
    st, intended = daf
    from services.analysis_query import AnalysisReadQuery
    from services.lift.cohort import record_key
    view = dict(chrom="chr3", start=128650000, end=128670000)
    linear, windows = {}, {}
    for hap in ("MAT", "PAT"):
        q = AnalysisReadQuery.from_request(st, capability="compact_reads", dataset_ids=["daf"], include_methylation=True, **view)
        for r in q.build_working_set(st, "daf", lift_hap=hap).reads:
            s = r.get("strand")
            linear[record_key(r["analysis_id"])] = s if s in ("CT", "GA") else None
            src = r["live_lift"]["source"]
            lo, hi = windows.get(src["contig"], (src["start"], src["end"]))
            windows[src["contig"]] = (min(lo, src["start"]), max(hi, src["end"]))
    st._read_strand_calls = {}   # the graph decides on its own, then both views agree
    gr.clear_cache()
    rows = _graph_rows(st, windows)
    both = [r for r in rows if r["rk"] in linear]
    assert len(both) >= 40, len(both)
    agree = sum(1 for r in both if r.get("ds") == linear[r["rk"]])
    assert agree == len(both), [(r["q"], r.get("ds"), linear[r["rk"]]) for r in both if r.get("ds") != linear[r["rk"]]][:5]
    # The strands are the ones written: explicit calls and clear majorities (mixed molecules may tie).
    called = [r for r in both if r.get("ds")]
    assert len(called) >= 0.8 * len(both)
    assert sum(1 for r in called if r["ds"] == intended.get(r["q"])) >= 0.95 * len(called)
    # A molecule's rows carry one strand.
    by_mol: dict = {}
    for r in rows:
        by_mol.setdefault(r["q"], set()).add(r.get("ds"))
    assert all(len(v) == 1 for v in by_mol.values())
