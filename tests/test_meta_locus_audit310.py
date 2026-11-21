"""Meta-locus release-audit regressions (3.1.0): Read Stats on the virtual contig, the decoded-view cache and signal
filters, uploaded BEDs under lab confinement, and sites near a chromosome start."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

DEMO = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"


@pytest.fixture()
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(tmp_path / "cache"))
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    mj._pools.clear()
    client = TestClient(srv.app, headers=auth_headers())
    added = client.post("/api/datasets/add", json={"path": str(DEMO), "label": "demo"})
    assert added.status_code == 200, added.text
    body = added.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    yield client, did, tmp_path
    for p in list(mj._pools.values()):
        p.cancel.set()
    mj._pools.clear()
    srv.state = old


def _bed(tmp_path, n=8):
    import pysam
    with pysam.AlignmentFile(str(DEMO)) as f:
        spans = [(r.reference_start, r.reference_end) for r in f.fetch("chr19")]
    lo, hi = min(a for a, _ in spans), max(b for _, b in spans)
    path = tmp_path / "demo_sites.bed"
    path.write_text("".join(f"chr19\t{lo + (hi - lo) * (i + 1) // (n + 1)}\t{lo + (hi - lo) * (i + 1) // (n + 1) + 1}\ts{i}\t0\t{'+-'[i % 2]}\n"
                            for i in range(n)))
    return path


def _ready(client, pid, timeout=60):
    t = time.monotonic()
    while True:
        st = client.get(f"/api/meta_locus/pools/{pid}").json()
        if st["status"] != "building" or time.monotonic() - t > timeout:
            return st
        time.sleep(0.05)


def _open(client, tmp, flank=800, count=80):
    started = client.post("/api/meta_locus/pools", json={"bed_path": str(_bed(tmp)), "flank_bp": flank, "count": count}).json()
    st = _ready(client, started["pool_id"])
    assert st["status"] == "ready"
    return st


def _stats(client, chrom, width, did, ids):
    out = client.post("/api/reads/stats", params=dict(chrom=chrom, start=0, end=width), json={"read_ids_by_dataset": {did: ids}})
    assert out.status_code == 200, out.text
    return out.json()


def test_read_stats_resolves_unshared_meta_locus_reads(app_client):
    """One site (the demo's reads all span it): plain read ids, no '#site' suffix."""
    client, did, tmp = app_client
    path = tmp / "one_site.bed"
    path.write_text("chr19\t47516700\t47516701\tone\t0\t-\n")
    started = client.post("/api/meta_locus/pools", json={"bed_path": str(path), "flank_bp": 500, "count": 30}).json()
    st = _ready(client, started["pool_id"])
    rows = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=st["chrom"], start=0, end=st["width"])).json()["reads"]
    assert rows and not any(r["meta"]["shared"] for r in rows)
    ids = [r["id"] for r in rows[:5]]
    body = _stats(client, st["chrom"], st["width"], did, ids)
    assert body["found_count"] == len(ids) and {e["read_id"] for e in body["per_read"]} == set(ids)


def test_read_stats_resolves_meta_locus_reads(app_client):
    client, did, tmp = app_client
    st = _open(client, tmp, flank=800, count=400)
    chrom, width = st["chrom"], st["width"]
    rows = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=chrom, start=0, end=width)).json()["reads"]
    assert rows
    # distinct molecules on plus and minus sites (all shared here: every demo read spans every site)
    picked, names = [], set()
    for strand in "+-+-":
        r = next((r for r in rows if r["meta"]["strand"] == strand and r["meta"]["identity"]["name"] not in names), None)
        if r is not None:
            picked.append(r)
            names.add(r["meta"]["identity"]["name"])
    assert len(picked) == 4
    ids = [r["id"] for r in picked]
    body = _stats(client, chrom, width, did, ids)
    assert body["found_count"] == len(ids), body["missing_read_ids_by_dataset"]
    assert not body["missing_read_ids_by_dataset"].get(did)
    got = {e["read_id"]: e for e in body["per_read"]}
    assert set(got) == set(ids)
    for r in picked:
        e = got[r["id"]]
        assert e["dataset_id"] == did and e["read_length"] > 0
        assert e["ref_start"] == r["meta"]["real"]["reference_start"]
        assert e["meta"]["site"] == r["meta"]["site"]

    # A shared read's other observations are their own entries.
    shared = next(r for r in picked if r["meta"]["shared"])
    others = [r for r in rows if r["meta"]["identity"]["name"] == shared["meta"]["identity"]["name"]]
    if len(others) > 1:
        both = _stats(client, chrom, width, did, [x["id"] for x in others[:2]])
        assert both["found_count"] == 2 and {e["meta"]["site"] for e in both["per_read"]} == {x["meta"]["site"] for x in others[:2]}

    # One read (a minus-strand site, then a plus one; the whole window, then a zoomed view): its footprints,
    # read-relative, are the real record's (un-mirrored).
    views = [(0, width), (width // 4, 3 * width // 4)]
    for (v0, v1), one in [(v, r) for v in views for r in ([r for r in picked if r["meta"]["strand"] == "-"][:1]
                                                           + [r for r in picked if r["meta"]["strand"] == "+"][:1])]:
        out = client.post("/api/reads/stats", params=dict(chrom=chrom, start=v0, end=v1), json={"read_ids_by_dataset": {did: [one["id"]]}})
        assert out.status_code == 200, out.text
        single = out.json()
        assert single["found_count"] == 1
        entry = single["per_read"][0]
        assert entry["cigar_string"]
        real = one["meta"]["real"]
        plain = client.get("/api/reads/compact", params=dict(dataset_id=did, chrom=real["chrom"], start=real["reference_start"],
                                                             end=real["reference_end"], filter_ids=one["meta"]["identity"]["name"],
                                                             max_reads=0)).json()["reads"]
        ref = next(r for r in plain if r["id"] == one["meta"]["identity"]["name"])
        # the plain view starts at the read's own start: its intervals are read-relative already
        ref_ivs = {(iv[0], iv[1], iv[2]) for iv in ref["intervals"] if len(iv) > 2 and iv[2] and iv[2] > 0}
        lo, hi = min(a for a, *_ in ref["intervals"]), max(b for _a, b, *_ in ref["intervals"])
        inner = [tuple(iv) for iv in entry["fp_intervals"] or [] if iv[2] and iv[2] > 0]
        # footprints not cut by the site window's edges are exactly the record's
        window = one["meta"]["window"]
        flank = width // 2
        # the view's real span at this site (minus-strand sites mirrored)
        if one["meta"]["strand"] == "-":
            r0, r1 = window[1] - v1, window[1] - v0
        else:
            r0, r1 = window[1] - 2 * flank + v0, window[1] - 2 * flank + v1
        w0, w1 = r0 - real["reference_start"], r1 - real["reference_start"]
        whole = [iv for iv in inner if iv[0] > max(lo, w0) and iv[1] < min(hi, w1)]
        assert whole and all(iv in ref_ivs for iv in whole), (whole[:3], sorted(ref_ivs)[:3])


# ----------------------------------------------------------------------------------------------------- signal filters


def test_decoded_view_cache_follows_the_signal_filters(app_client):
    import json
    client, did, tmp = app_client
    st = _open(client, tmp, count=40)
    chrom, width = st["chrom"], st["width"]
    params = dict(dataset_id=did, chrom=chrom, start=0, end=width)
    plain = client.get("/api/reads/compact", params=params).json()["reads"]
    assert plain
    # The demo reads carry no producer signal evidence (unscored): "require detectable" hides them all.
    strict = client.get("/api/reads/compact", params={**params, "signal_filters": json.dumps({"requireDetectable": True})}).json()["reads"]
    assert strict == []
    again = client.get("/api/reads/compact", params=params).json()["reads"]
    assert {r["id"] for r in again} == {r["id"] for r in plain}


class _InlineWorkers:
    """A worker pool stand-in that runs each job in a fresh context (as a spawned worker sees it: no request
    context variables)."""
    def submit(self, fn, *args, **kwargs):
        import contextvars
        from concurrent.futures import Future
        f = Future()
        f.set_result(contextvars.Context().run(fn, *args, **kwargs))
        return f


def test_parallel_decode_carries_the_signal_filters_to_workers(monkeypatch):
    from services import meta_locus_decode as md
    from services import meta_locus_pool as mp
    from services.signal_evidence import signal_filters_for_request
    regions = [["chr19", 47514600 + i * 300, 47514601 + i * 300, "+", f"s{i}"] for i in range(4)]
    sites = mp.build_sites(regions, "centre", 300)
    spec = dict(mp.DEFAULTS, regions_sha256=mp.regions_sha256(regions), flank_bp=300)
    ix = mp.enumerate_dataset("d1", [str(DEMO)], sites, spec)
    ents = [int(e) for e in ix.ranked(1)[:20]]
    assert ents
    monkeypatch.setattr(md, "worker_pool", lambda _n: _InlineWorkers())
    opts = {"workers": 2, "parallel_min_reads": 1}
    loader = dict(include_methylation=False, include_layers=False)
    assert md.decode_entries_parallel([str(DEMO)], ix, sites, ents, loader_options=loader, options=opts)
    with signal_filters_for_request({"requireDetectable": True}):
        assert md.decode_entries_parallel([str(DEMO)], ix, sites, ents, loader_options=loader, options=opts) == {}


# ----------------------------------------------------------------------------------------------------- contig start


def test_sites_near_the_contig_start_keep_the_anchor_at_virtual_zero():
    from services import meta_locus_decode as md
    from services import meta_locus_pool as mp
    flank = 1000
    s = mp.build_sites([["c", 100, 101, "+", "p"], ["c", 100, 101, "-", "m"]], "start", flank)
    # fetch bounds are clamped at 0; the projection origin is not
    assert list(s.win_start) == [0, 0]
    plus_anchor, minus_anchor = int(s.anchor[0]), int(s.anchor[1])
    assert int(s.origin[0]) == plus_anchor - flank and int(s.origin[1]) == minus_anchor - flank + 1
    assert s.provenance(0)["origin"] == plus_anchor - flank
    for i, a in ((0, plus_anchor), (1, minus_anchor)):
        v = md.virtualize_read({"reference_start": a, "reference_end": a + 1, "intervals": []}, s, i)
        assert (v["reference_start"], v["reference_end"]) == (flank, flank + 1)  # the anchor base: virtual 0


def test_decode_projects_from_the_logical_origin_when_the_fetch_start_is_clamped():
    """A site whose fetch start was clamped (win_start > origin) decodes as the ordinary loader's reads moved by the
    unclamped origin: the anchor lands at virtual 0 (window coordinate flank)."""
    import numpy as np
    import pysam
    from services import meta_locus_decode as md
    from services import meta_locus_pool as mp
    from services.compact_read_loader import build_compact_reads_from_bam
    flank = 400
    regions = [["chr19", 47514600 + i * 300, 47514601 + i * 300, "-" if i % 2 else "+", f"s{i}"] for i in range(6)]
    base = mp.build_sites(regions, "centre", flank)
    clamp = 150  # as if each window's start had been clamped this far in
    sites = mp.Sites(base.chrom, base.win_start + clamp, base.win_end, base.anchor, base.minus, base.name, flank,
                     origin=base.origin.copy())
    ix = mp.enumerate_dataset("d1", [str(DEMO)], base, dict(mp.DEFAULTS, regions_sha256=mp.regions_sha256(regions), flank_bp=flank))
    ents = [int(e) for e in ix.ranked(1)[:120]]
    opts = dict(include_methylation=True, include_layers=False)
    got = md.decode_entries([str(DEMO)], ix, sites, ents, loader_options=opts)
    with pysam.AlignmentFile(str(DEMO)) as f:
        spans = [(r.reference_start, r.reference_end) for r in f.fetch("chr19")]
    lo = min(min(a for a, _ in spans), int(base.win_start.min()))
    hi = max(max(b for _, b in spans), int(base.win_end.max()))
    rows = build_compact_reads_from_bam(str(DEMO), "chr19", lo, hi, spanning_only=False, **opts)
    whole = {r["id"]: r for r in (rows[0] if isinstance(rows, tuple) else rows)}
    checked = 0
    for e in ents:
        if e not in got:
            continue
        si = int(ix.site[e])
        ref = md.clip_compact_read(whole[ix.names[int(ix.mol[e])]], lo - int(base.origin[si]), 2 * flank)
        if sites.minus[si]:
            ref = md.mirror_compact_read(ref, 2 * flank)
        assert got[e]["intervals"] == ref["intervals"]
        checked += 1
    assert checked > 20
    # parallel workers get the origin too
    payload_sites = {"chrom": sites.chrom, "win_start": sites.win_start, "win_end": sites.win_end, "anchor": sites.anchor,
                     "minus": sites.minus, "name": sites.name, "flank": flank}
    assert np.array_equal(mp.Sites(**payload_sites).origin, sites.win_start)  # (no origin given: win_start)


def test_parallel_decode_sends_the_origin(monkeypatch):
    from services import meta_locus_decode as md
    from services import meta_locus_pool as mp
    flank = 400
    regions = [["chr19", 47514600 + i * 300, 47514601 + i * 300, "+", f"s{i}"] for i in range(4)]
    base = mp.build_sites(regions, "centre", flank)
    sites = mp.Sites(base.chrom, base.win_start + 150, base.win_end, base.anchor, base.minus, base.name, flank,
                     origin=base.origin.copy())
    ix = mp.enumerate_dataset("d1", [str(DEMO)], base, dict(mp.DEFAULTS, regions_sha256=mp.regions_sha256(regions), flank_bp=flank))
    ents = [int(e) for e in ix.ranked(1)[:40]]
    loader = dict(include_methylation=False, include_layers=False)
    here = md.decode_entries([str(DEMO)], ix, sites, ents, loader_options=loader)
    monkeypatch.setattr(md, "worker_pool", lambda _n: _InlineWorkers())
    par = md.decode_entries_parallel([str(DEMO)], ix, sites, ents, loader_options=loader, options={"workers": 2, "parallel_min_reads": 1})
    assert here and {e: r["intervals"] for e, r in par.items()} == {e: r["intervals"] for e, r in here.items()}


# ----------------------------------------------------------------------------------------------------- lab uploads

from lab_fixtures import lab, member_client  # noqa: E402,F401


def test_uploaded_bed_reopens_under_lab_confinement(lab, monkeypatch):
    import shutil
    monkeypatch.setenv("FIBERBROWSER_META_LOCUS_CACHE_DIR", str(lab.tmp / "ml_cache"))
    from services import meta_locus_jobs as mj
    mj._pools.clear()
    for suffix in ("", ".bai"):
        shutil.copy(str(DEMO) + suffix, lab.data / ("demo.bam" + suffix))
    client = member_client(lab)
    added = client.post("/api/datasets/add", json={"path": str(lab.data / "demo.bam"), "label": "demo"})
    assert added.status_code == 200, added.text
    text = _bed(lab.tmp).read_text()
    try:
        started = client.post("/api/meta_locus/pools", json={"bed_text": text, "bed_name": "sites.bed", "flank_bp": 500, "count": 20})
        assert started.status_code == 200, started.text
        saved = started.json()["spec"]["bed_path"]
        assert Path(saved).resolve().is_relative_to(Path(lab.cfg.uploads_dir).resolve())
        # Reopening by the returned path (a session, a link, the dialog's probe) passes the lab's path rules.
        probe = client.post("/api/meta_locus/pools/probe", json={"bed_path": saved, "flank_bp": 500})
        assert probe.status_code == 200, probe.text
        again = client.post("/api/meta_locus/pools", json={"bed_path": saved, "flank_bp": 500, "count": 20})
        assert again.status_code == 200, again.text
        assert again.json()["pool_id"] == started.json()["pool_id"]
    finally:
        for p in list(mj._pools.values()):
            p.cancel.set()
        mj._pools.clear()


def test_uploaded_bed_outside_lab_mode_stays_in_the_cache(app_client):
    client, did, tmp = app_client
    started = client.post("/api/meta_locus/pools", json={"bed_text": _bed(tmp).read_text(), "bed_name": "sites.bed", "flank_bp": 500, "count": 20})
    assert started.status_code == 200, started.text
    assert Path(started.json()["spec"]["bed_path"]).parent == tmp / "cache" / "beds"


# ------------------------------------------------------------------------------------------- Read Stats near position 0


@pytest.mark.parametrize("strand", ["+", "-"])
def test_read_stats_resolves_sites_near_the_contig_start(tmp_path, strand):
    """BED [100, 101), flank 1000: the view's real span starts at -900. The BAM is fetched from 0 (pysam refuses a
    negative start); the footprints stay relative to the logical start."""
    import pysam
    from types import SimpleNamespace
    from services import read_stats as rs
    path = tmp_path / "near_start.bam"
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "c1", "LN": 10_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        seg = pysam.AlignedSegment(out.header)
        seg.query_name, seg.reference_id, seg.reference_start = "r1", 0, 50
        seg.query_sequence = "A" * 1500
        seg.cigartuples = [(0, 1500)]
        seg.mapping_quality = 60
        seg.query_qualities = pysam.qualitystring_to_array("I" * 1500)
        out.write(seg)
    pysam.index(str(path))
    width = 2000
    # View-relative (logical) footprint [1100, 1200): real [200, 300) on a plus site; on a minus site the row is
    # mirrored, so [800, 900) is real [200, 300) too.
    iv = [1100, 1200, 100] if strand == "+" else [800, 900, 100]
    meta = {"identity": {"name": "r1"}, "real": {"chrom": "c1"}, "chrom": "c1", "site": 0, "strand": strand,
            "window": [0, 1100], "origin": -900}
    row = {"id": "r1#0", "intervals": [iv], "meta": meta}
    per_read: list = []
    wanted = {"r1#0"}
    rs._collect_meta_read_stats(
        dataset=SimpleNamespace(paths=[str(path)]), dataset_id="d", requested_ids=["r1#0"], wanted=wanted,
        ws=SimpleNamespace(read_by_id={"r1#0": row}), start=0, end=width, per_read=per_read, all_fp_sizes=[],
        all_acc_pcts=[], all_lengths=[], all_mapqs=[], all_methyl_pcts=[], strand_counts={"+": 0, "-": 0})
    assert [e["read_id"] for e in per_read] == ["r1#0"]
    assert not wanted
    entry = per_read[0]
    assert entry["ref_start"] == 50
    assert entry["fp_intervals"] == [[150, 250, 100]]
