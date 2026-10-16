"""A manageable display working set for deep BAM views (services/read_sampling.py).

On a deep PacBio library (~24,000 reads per 150 kb) a 100 kb view parsed every
read into the working set although ~800 are drawn: 77 s per view. The display
load now keeps a stable sample, decided on the read name before any tag is
parsed. These check that the sample is deterministic, nested across levels
and stable across pans, that "N of M" is exact, that "Load all" loads every
read, and that analyses building their own working set still get every read.
"""
from __future__ import annotations

import numpy as np
import pytest

from services import read_sampling as RS


def test_the_sample_is_deterministic_and_nested():
    names = [f"m84046_250324_212902_s3/{i}/ccs" for i in range(20_000)]
    for level in range(1, 5):
        kept = {n for n in names if RS.keeps(n, level)}
        # About 1 in 2^level.
        assert abs(len(kept) / len(names) - RS.fraction(level)) < 0.02
        # The same reads every time (no per-process salt).
        assert kept == {n for n in names if RS.keeps(n, level)}
        # Nested: a lower level (zoomed in) keeps every read a higher one keeps.
        assert kept <= {n for n in names if RS.keeps(n, level - 1)}
    assert all(RS.keeps(n, 0) for n in names[:100])


def test_the_hash_is_stable_across_runs():
    # A fixed value: a read's membership never changes between sessions.
    assert RS.name_hash("m84046_250324_212902_s3/107155689/ccs") == RS.name_hash("m84046_250324_212902_s3/107155689/ccs")
    import hashlib
    expected = int.from_bytes(hashlib.blake2b(b"read/1/ccs", digest_size=8).digest(), "little")
    assert RS.name_hash("read/1/ccs") == expected


def test_target_grows_slowly_with_the_window(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_WORKING_READS_TARGET", raising=False)
    assert RS.target_reads(20_000) == RS.DEFAULT_TARGET
    assert RS.DEFAULT_TARGET < RS.target_reads(150_000) <= 2 * RS.DEFAULT_TARGET
    assert RS.target_reads(5_000_000) == 2 * RS.DEFAULT_TARGET
    monkeypatch.setenv("FIBERBROWSER_WORKING_READS_TARGET", "0")
    assert RS.target_reads(100_000) == 0


def test_skipped_extents_make_the_total_exact():
    reads = RS.SampledReads([{"id": "a"}], level=2, skipped_starts=[0, 50, 200], skipped_ends=[40, 150, 300],
                            kept_starts=[90], kept_ends=[400])
    info = RS.sampling_info(reads, 100, 160, kept_overlapping=1, kept_spanning=0)
    assert info["total"] == 2 and info["kept"] == 1 and info["level"] == 2 and info["loaded"] == 1
    assert info["total_spanning"] == 1 and info["kept_spanning"] == 1  # only the kept 90-400 spans 100-160
    assert RS.sampling_info([{"id": "a"}], 0, 10, 1, 1) is None


# ---------------------------------------------------------------------------
# The BAM: the insertion fixture (43 reads around chrT:15,000), with a tiny target


@pytest.fixture(scope="module")
def bam(tmp_path_factory):
    from insertion_fixtures import make_insertion_bam
    return make_insertion_bam(tmp_path_factory.mktemp("sampling"))


def test_the_index_estimate_counts_the_reads(bam):
    import pysam
    from insertion_fixtures import SITE
    handle = pysam.AlignmentFile(bam["bam"])
    est = RS.estimate_reads(bam["bam"], "chrT", SITE - 2000, SITE + 2000, bam_handle_getter=lambda p: handle)
    n = handle.count("chrT", SITE - 2000, SITE + 2000)
    assert est is not None and 0.3 * n <= est <= 3 * n
    assert RS.estimate_reads("s3://bucket/x.bam", "chrT", 0, 10) is None


@pytest.fixture
def dataset(client, bam, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_WORKING_READS_TARGET", "8")
    resp = client.post("/api/datasets/add", json={"path": bam["bam"], "label": "sampling"})
    assert resp.status_code == 200 and resp.json()["success"], resp.text
    ds = resp.json()["dataset"]
    yield ds
    client.delete(f"/api/datasets/{ds['id']}")


def _compact(client, ds, start, end, **extra):
    params = {"chrom": "chrT", "start": start, "end": end, "dataset_id": ds["id"], "max_reads": 1000,
              "include_layers": "true", "min_footprints": 0, **extra}
    resp = client.get("/api/reads/compact", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_deep_view_is_sampled_and_says_so(client, dataset):
    from insertion_fixtures import SITE
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000)
    full = _compact(client, dataset, SITE - 3000, SITE + 3000, full_working_set="true")
    assert "working_sampling" not in full
    info = sampled["working_sampling"]
    assert info["level"] >= 1
    # "N of M": both count primary alignments in view on their extents, before
    # the read filters (exact); "loaded" is what the panel counts after them.
    import pysam
    with pysam.AlignmentFile(dataset["path"] if "path" in dataset else dataset["paths"][0]) as bam_file:
        names = [(r.query_name) for r in bam_file.fetch("chrT", SITE - 3000, SITE + 3000)
                 if not (r.is_secondary or r.is_supplementary or r.is_duplicate or r.is_unmapped)]
    assert info["total"] == len(names)
    assert info["kept"] == sum(1 for n in names if RS.keeps(n, info["level"])) < info["total"]
    assert info["loaded"] == sampled["total_overlapping"] <= info["kept"]
    ids = {r["id"] for r in sampled["reads"]}
    assert ids and all(RS.keeps(i, info["level"]) for i in ids)
    # SV counts come from the sampled reads: the band says "in loaded reads".
    if sampled.get("sv_summary"):
        assert sampled["sv_summary"]["scope"] == "loaded"
    if full.get("sv_summary"):
        assert full["sv_summary"]["scope"] == "all"
    assert ids <= {r["id"] for r in full["reads"]}
    # A full load elsewhere (an analysis, "Load all") doesn't change what the
    # sampled display shows: the same reads as before.
    again = _compact(client, dataset, SITE - 3000, SITE + 3000)
    assert {r["id"] for r in again["reads"]} == ids and again["working_sampling"] == info


def test_panning_keeps_the_same_reads(client, dataset):
    from insertion_fixtures import SITE
    a = _compact(client, dataset, SITE - 3000, SITE + 3000)
    b = _compact(client, dataset, SITE - 2500, SITE + 3500)
    if a["working_sampling"]["level"] != b["working_sampling"]["level"]:
        pytest.skip("the pan crossed a depth level")
    ids_a = {r["id"] for r in a["reads"]}
    ids_b = {r["id"] for r in b["reads"]}
    full_b = {r["id"] for r in _compact(client, dataset, SITE - 2500, SITE + 3500, full_working_set="true")["reads"]}
    # A read of the first view still in the second view is still in its sample.
    shared = ids_a & full_b
    assert shared <= ids_b


def test_analyses_building_their_own_working_set_get_every_read(client, dataset):
    import server as srv
    from insertion_fixtures import SITE
    from state.dependencies import get_state
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000)
    assert sampled.get("working_sampling")
    full = _compact(client, dataset, SITE - 3000, SITE + 3000, full_working_set="true")
    state = srv.state
    ws = state.build_working_set(dataset["id"], "chrT", SITE - 3000, SITE + 3000, False, 0, include_methylation=False)
    assert len(ws.reads) == full["total_overlapping"]
    # Asked about the reads the panel shows (all in the sample): the display's load serves.
    shown = [r["id"] for r in sampled["reads"]]
    ws_ids = state.build_working_set(dataset["id"], "chrT", SITE - 3000, SITE + 3000, False, 0,
                                     read_ids=shown, include_methylation=False)
    assert {r["id"] for r in ws_ids.reads} == set(shown)
    # Its totals are the view's, not the sample's.
    assert ws_ids.total_overlapping == sampled["working_sampling"]["total"]


def test_a_deep_view_prefetches_no_more_than_its_reads_afford(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_WORKING_READS_TARGET", raising=False)
    density = 0.2  # reads per bp (a targeted PacBio library: ~24,000 per 120 kb)
    monkeypatch.setattr(RS, "estimate_dataset_reads", lambda state, ds, chrom, s, e: (e - s) * density)
    # 30 kb at level 0 would parse 60,000 reads at 10x: down to a view on each side.
    assert RS.bounded_prefetch(None, None, "chr2L", 0, 30_000, 10, 0) == RS.MIN_PREFETCH
    # Sampled 1 in 16, 10x is affordable.
    assert RS.bounded_prefetch(None, None, "chr2L", 0, 30_000, 10, 4) == 10
    # Sparse data keeps the configured prefetch.
    monkeypatch.setattr(RS, "estimate_dataset_reads", lambda state, ds, chrom, s, e: (e - s) * 0.001)
    assert RS.bounded_prefetch(None, None, "chr2L", 0, 30_000, 10, 0) == 10
    # Unknown depth (a remote BAM): unchanged.
    monkeypatch.setattr(RS, "estimate_dataset_reads", lambda *a: None)
    assert RS.bounded_prefetch(None, None, "chr2L", 0, 30_000, 10, 0) == 10


def test_the_level_holds_across_pans_inside_a_block(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_WORKING_READS_TARGET", raising=False)
    # A lumpy (targeted) library: deep in 100-250 kb, empty elsewhere.
    def est(state, ds, chrom, s, e):
        return max(0, min(e, 250_000) - max(s, 100_000)) * 0.2
    monkeypatch.setattr(RS, "estimate_dataset_reads", est)
    width = 30_000
    lo, hi = RS.level_block(130_000, 130_000 + width)
    levels = {RS.sample_level(None, None, "chr2L", a, a + width)
              for a in range(lo, hi - width, width // 4)
              if RS.level_block(a, a + width) == (lo, hi)}
    assert len(levels) == 1 and levels.pop() >= 1


def test_an_analysis_asking_for_a_read_outside_the_sample_gets_every_read(client, dataset):
    import server as srv
    from insertion_fixtures import SITE
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000)
    level = sampled["working_sampling"]["level"]
    full = _compact(client, dataset, SITE - 3000, SITE + 3000, full_working_set="true")
    outside = [r["id"] for r in full["reads"] if not RS.keeps(r["id"], level)]
    assert outside
    ask = [outside[0], sampled["reads"][0]["id"]]
    ws = srv.state.build_working_set(dataset["id"], "chrT", SITE - 3000, SITE + 3000, False, 0,
                                     read_ids=ask, include_methylation=False)
    assert {r["id"] for r in ws.reads} == set(ask)


def test_merged_sampling_of_a_circular_view_adds_its_segments():
    a = {"level": 1, "fraction": 0.5, "kept": 3, "total": 6, "kept_spanning": 0, "total_spanning": 1, "loaded": 2, "loaded_spanning": 0}
    b = {"level": 2, "fraction": 0.25, "kept": 1, "total": 4, "kept_spanning": 0, "total_spanning": 0, "loaded": 1, "loaded_spanning": 0}
    merged = RS.merge_sampling_info([a, None, b])
    assert merged["level"] == 2 and merged["kept"] == 4 and merged["total"] == 10 and merged["loaded"] == 3
    assert RS.merge_sampling_info([None]) is None


def test_a_peak_scan_of_the_reads_shown_reuses_the_sampled_load(client, dataset):
    import server as srv
    from insertion_fixtures import SITE
    from services.working_sets import broad_cache_topology
    # The display filters by Min footprints (its load is keyed by it); the scan doesn't.
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000, min_footprints=1)
    assert sampled.get("working_sampling")
    shown = [r["id"] for r in sampled["reads"]]
    resp = client.post("/api/scan_peaks", params={"chrom": "chrT", "start": SITE - 3000, "end": SITE + 3000,
                                                  "dataset_id": dataset["id"]},
                       json={"read_ids_by_dataset": {dataset["id"]: shown}, "dataset_ids": [dataset["id"]]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["n_reads"] == len(shown)
    # No load of every read was needed: every cached load of this dataset is the sampled one.
    tokens = [broad_cache_topology(k) for k in srv.state._broad_cache if k[0] == dataset["id"]]
    assert tokens and all("sample" in t for t in tokens)


def test_a_read_gone_to_by_name_is_shown_even_outside_the_sample(client, dataset):
    from insertion_fixtures import SITE
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000)
    level = sampled["working_sampling"]["level"]
    full = _compact(client, dataset, SITE - 3000, SITE + 3000, full_working_set="true")
    outside = next(r["id"] for r in full["reads"] if not RS.keeps(r["id"], level))
    pinned = _compact(client, dataset, SITE - 3000, SITE + 3000, pin_ids=outside, max_reads=1)
    assert outside in {r["id"] for r in pinned["reads"]}
    assert "working_sampling" not in pinned


def test_a_laxer_sampled_load_never_serves_a_stricter_analysis(client, dataset):
    import server as srv
    from insertion_fixtures import SITE
    from services.working_sets import broad_cache_topology
    sampled = _compact(client, dataset, SITE - 3000, SITE + 3000, min_footprints=0)
    shown = [r["id"] for r in sampled["reads"]]
    srv.state.build_working_set(dataset["id"], "chrT", SITE - 3000, SITE + 3000, False, 3,
                                read_ids=shown, include_methylation=False)
    # Min footprints 3 is stricter than the display's 0: its own (full) load, not the sample.
    tokens = [broad_cache_topology(k) for k in srv.state._broad_cache if k[0] == dataset["id"]]
    assert any("sample" not in t for t in tokens)
