"""Whole-file random reads (services/plots_random_reads, POST /api/plots/random_reads): proportional across contigs,
primary mapped reads only (no QC-fail / strand-swap chimeras unless asked), the same reads for the same seed whatever
the chunking, other reads for another seed, and a golden sample pinned on a synthetic BAM."""
from types import SimpleNamespace

import pysam
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import plots_random_reads as R


def make_bam(path, per_contig):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": c, "LN": 1_000_000} for c, _ in per_contig]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for ci, (contig, n) in enumerate(per_contig):
            for i in range(n):
                a = pysam.AlignedSegment(out.header)
                a.query_name = f"{contig}_r{i:05d}"
                a.query_sequence = "A" * 50
                a.flag = 0
                if i % 50 == 7:
                    a.flag = 0x200          # QC-fail
                elif i % 50 == 11:
                    a.flag = 0x800          # supplementary
                elif i % 50 == 13:
                    a.flag = 0x100          # secondary
                a.reference_id = ci
                a.reference_start = i * 100
                a.mapping_quality = 60
                a.cigar = [(0, 50)]
                if i % 50 == 17:
                    a.set_tag("xc", "strand_swap", "Z")
                if i % 50 != 19:
                    a.set_tag("MA", "50;nuc+:5-20", "Z")   # a footprint call; i % 50 == 19 is uncalled
                out.write(a)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def bam(tmp_path):
    return make_bam(tmp_path / "multi.bam", [("chrA", 3000), ("chrB", 1000), ("chrC", 0)])


def run(jobs, paths, seed, hide_uncalled=True):
    """The client's selection over scan results: per contig its share of smallest keys."""
    by = {}
    for job in jobs:
        cands = R.scan_segment(paths[job["dataset"]], job["dataset"], job["contig"], job["start"], job["end"], job["frac"], seed, False, hide_uncalled)
        e = by.setdefault((job["dataset"], job["contig"]), {"share": job["share"], "c": []})
        e["c"] += cands
    return {k: [c[0] for c in R.select(v["c"], v["share"])] for k, v in by.items()}


def test_allocation_is_proportional(bam):
    stats = R.contig_stats([bam])
    assert [(c, m) for c, _, m in stats] == [("chrA", 3000), ("chrB", 1000)]
    assert R.allocate(400, [3000, 1000]) == [300, 100]
    assert sum(R.allocate(7, [3, 3, 3])) == 7


def test_seeded_proportional_and_primary_only(bam):
    paths = {"d1": [bam]}
    jobs = R.plan(paths, 400)
    picked = run(jobs, paths, 1)
    assert len(picked[("d1", "chrA")]) == 300 and len(picked[("d1", "chrB")]) == 100
    names = [n for v in picked.values() for n in v]
    idx = [int(n.split("_r")[1]) % 50 for n in names]
    assert not {7, 11, 13, 17, 19} & set(idx)      # QC-fail, supplementary, secondary, strand swap, uncalled: never sampled
    assert run(jobs, paths, 1) == picked          # same seed, same reads
    assert set(run(jobs, paths, 2)[("d1", "chrA")]) != set(picked[("d1", "chrA")])


def test_same_reads_whatever_the_segments(bam, monkeypatch):
    paths = {"d1": [bam]}
    whole = run(R.plan(paths, 200), paths, 1)
    monkeypatch.setattr(R, "SEGMENT_BP", 37_000)
    pieces = run(R.plan(paths, 200), paths, 1)
    assert pieces == whole


def test_uncalled_reads_only_with_all_reads_including_uncalled(bam):
    paths = {"d1": [bam]}
    jobs = R.plan(paths, 1000)
    hidden = [int(n.split("_r")[1]) % 50 for v in run(jobs, paths, 1).values() for n in v]
    shown = [int(n.split("_r")[1]) % 50 for v in run(jobs, paths, 1, hide_uncalled=False).values() for n in v]
    assert 19 not in hidden and 19 in shown


def test_golden_sample(bam):
    paths = {"d1": [bam]}
    picked = run(R.plan(paths, 8), paths, 1)
    assert picked == GOLDEN


# Pinned: any change to the sampler (keys, allocation, selection, eligibility) fails here.
GOLDEN = {('d1', 'chrA'): ['chrA_r00371', 'chrA_r02974', 'chrA_r01488', 'chrA_r00066', 'chrA_r00230', 'chrA_r02860'],
          ('d1', 'chrB'): ['chrB_r00736', 'chrB_r00423']}


def _route(bam):
    from routers import files as files_router
    app = FastAPI()
    app.include_router(files_router.router)
    files_router._RANDOM_PLANS.clear()
    state = SimpleNamespace(datasets={"d1": SimpleNamespace(paths=[bam], data_type="bam")})
    app.dependency_overrides[files_router.get_state] = lambda: state
    return TestClient(app)


def test_route_chunks_give_the_same_candidates(bam):
    client = _route(bam)
    one = client.post("/api/plots/random_reads", json={"phase": "scan", "dataset_ids": ["d1"], "n": 50, "seed": 3, "job_limit": 100}).json()
    total = one["jobs_total"]
    parts = [client.post("/api/plots/random_reads", json={"phase": "scan", "dataset_ids": ["d1"], "n": 50, "seed": 3, "job_offset": k, "job_limit": 1}).json()
             for k in range(total)]
    flat = lambda jobs: sorted(c[0] for j in jobs for c in j["candidates"])
    assert flat([j for p in parts for j in p["jobs"]]) == flat(one["jobs"]) and one["seed"] == 3
    assert all(isinstance(c[1], str) for j in one["jobs"] for c in j["candidates"])


def test_random_reads_take_the_shared_call_rule_qcfail_exempt():
    # Shown QC-fail records are exempt from the uncalled rule, as in the read loaders (bam_tags.record_passes_call_rule).
    import pysam
    from services.plots_random_reads import eligible
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1000}]})

    def rec(qcfail):
        a = pysam.AlignedSegment(header)
        a.query_name, a.reference_id, a.reference_start, a.cigarstring = "r", 0, 10, "50M"
        a.query_sequence = "A" * 50
        a.flag = 0x200 if qcfail else 0
        return a

    assert eligible(rec(True), include_qcfail=True, hide_uncalled=True)
    assert not eligible(rec(True), include_qcfail=False, hide_uncalled=True)
    assert not eligible(rec(False), include_qcfail=False, hide_uncalled=True)
    assert eligible(rec(False), include_qcfail=False, hide_uncalled=False)
