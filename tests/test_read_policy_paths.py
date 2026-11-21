"""The duplicate and QC-fail toggles on the paths that read BAM records themselves (3.1.0, owner decision).

The dense loader (/api/reads/info, image, meta, meta_all), DAF-C and linked reads, autozoom and lift
difference reads hide duplicate (0x400) and QC-fail (0x200) reads by default, exactly as the main
compact read paths do, and show them when the read track's toggles are on: the request's
``include_duplicates`` / ``include_qcfail`` query parameters (SignalFilterMiddleware), or explicit
arguments. Caches and background jobs keep one entry per setting.

The BAM is the public demo BAM (DddA DAF reads, almost all with footprint calls), copied with some
called reads flagged duplicate and some QC-fail.
"""
from pathlib import Path

import pysam
import pytest

from models.domain import Dataset
from services.bam_tags import read_has_footprint_calls, record_passes_read_policy
from services.signal_evidence import read_policy_for_request
from state.browser_state import BrowserState

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
CHROM = "chr19"
START, END = 47_515_900, 47_516_100


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    """The demo BAM with every 7th called primary in the view flagged duplicate and every 11th QC-fail."""
    path = str(tmp_path_factory.mktemp("read_policy") / "flagged.bam")
    names = {"dup": set(), "qcfail": set(), "kept": set()}
    with pysam.AlignmentFile(str(DEMO_BAM)) as src, pysam.AlignmentFile(path, "wb", template=src) as out:
        index = 0
        for read in src.fetch():
            in_view = read.reference_start < END and (read.reference_end or 0) > START
            primary = not (read.is_secondary or read.is_supplementary or read.is_unmapped)
            if in_view and primary and read_has_footprint_calls(read):
                index += 1
                if index % 7 == 0:
                    read.is_duplicate = True
                    names["dup"].add(read.query_name)
                elif index % 11 == 0:
                    read.is_qcfail = True
                    names["qcfail"].add(read.query_name)
                else:
                    names["kept"].add(read.query_name)
            out.write(read)
    pysam.index(path)
    assert names["dup"] and names["qcfail"] and len(names["kept"]) > 100
    return {"bam": path, **names}


def _expected(files, dups=False, qcfail=False):
    return files["kept"] | (files["dup"] if dups else set()) | (files["qcfail"] if qcfail else set())


def _state(files):
    state = BrowserState(None)
    dataset = Dataset("ds", [files["bam"]], "ds", data_type="bam")
    state.datasets["ds"] = dataset
    state.dataset_order.append("ds")
    return state


SETTINGS = [(False, False), (True, False), (False, True), (True, True)]


def _called_in(names, files):
    """Restrict to the reads the fixture classified (the view's called primaries)."""
    return set(names) & (files["kept"] | files["dup"] | files["qcfail"])


def test_record_policy_matrix(files):
    with pysam.AlignmentFile(files["bam"]) as bam:
        by = {r.query_name: r for r in bam.fetch(CHROM, START, END) if not r.is_supplementary}
    dup = by[next(iter(files["dup"]))]
    qc = by[next(iter(files["qcfail"]))]
    assert not record_passes_read_policy(dup) and not record_passes_read_policy(qc)
    assert record_passes_read_policy(dup, include_duplicates=True)
    assert not record_passes_read_policy(qc, include_duplicates=True)
    assert record_passes_read_policy(qc, include_qcfail=True)
    with read_policy_for_request("true", "true"):
        assert record_passes_read_policy(dup) and record_passes_read_policy(qc)


# ── dense loader: Dataset.get_reads (/api/reads/info, image, meta, meta_all) ──

@pytest.mark.parametrize("dups,qcfail", SETTINGS)
def test_dense_loader_follows_the_toggles(files, dups, qcfail):
    from services.read_auxiliary_endpoint import get_reads_info_payload
    state = _state(files)
    with read_policy_for_request(dups, qcfail):
        df = state.get_reads(CHROM, START, END, False, dataset_id="ds")
        count = get_reads_info_payload(state, chrom=CHROM, start=START, end=END, dataset_id="ds")["count"]
    assert _called_in(df["read_id"], files) == _expected(files, dups, qcfail)
    assert count == len(df)
    # Explicit arguments win over the request.
    df = state.datasets["ds"].get_reads(CHROM, START, END, spanning=False, include_duplicates=dups, include_qcfail=qcfail)
    assert _called_in(df["read_id"], files) == _expected(files, dups, qcfail)


def test_dense_loader_shows_qcfail_reads_without_calls(tmp_path, files):
    """A QC-fail read shown by choice is exempt from the uncalled rule (FiberHMM chimeras carry no calls)."""
    path = str(tmp_path / "chimera.bam")
    with pysam.AlignmentFile(files["bam"]) as src, pysam.AlignmentFile(path, "wb", template=src) as out:
        for read in src.fetch():
            if read.query_name in files["qcfail"] and not read.is_supplementary:
                for tag in ("ns", "nl", "as", "al", "MA", "AQ"):
                    if read.has_tag(tag):
                        read.set_tag(tag, None)
            out.write(read)
    pysam.index(path)
    state = _state({"bam": path})
    with read_policy_for_request(None, True):
        df = state.get_reads(CHROM, START, END, False, dataset_id="ds")
    assert files["qcfail"] <= set(df["read_id"])


def test_meta_profile_cache_keeps_one_entry_per_setting(files):
    from services.read_auxiliary_endpoint import get_meta_payload
    state = _state(files)
    for dups, qcfail in SETTINGS:
        with read_policy_for_request(dups, qcfail):
            get_meta_payload(state, chrom=CHROM, start=START, end=END, dataset_id="ds")
    keys = list(state._meta_profile_cache.keys())
    assert len(keys) == 4
    # The default key is unchanged (no policy part), as before 3.1.0.
    policy = [k for k in keys if any(isinstance(p, tuple) and p[:1] in (("duplicates",), ("qcfail",)) for p in k)]
    assert len(policy) == 3


# ── DAF-C and linked reads ────────────────────────────────────────────────────

@pytest.mark.parametrize("dups,qcfail", SETTINGS)
def test_dafc_reads_follow_the_toggles(files, dups, qcfail):
    from services.dafc_reads import query_bam_for_dafc, query_reads_for_dafc
    from types import SimpleNamespace
    names = {r["name"] for r in query_bam_for_dafc(files["bam"], CHROM, START, END, include_duplicates=dups,
                                                   include_qcfail=qcfail)}
    assert _called_in(names, files) == _expected(files, dups, qcfail)
    # Linked-read views and DAF-C selections: the request's toggles.
    state = _state(files)
    with read_policy_for_request(dups, qcfail):
        names = {r["name"] for r in query_reads_for_dafc(CHROM, START, END, state=state,
                                                         dafc_state=SimpleNamespace(bb=None))}
    assert _called_in(names, files) == _expected(files, dups, qcfail)


# ── autozoom ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("dups,qcfail", SETTINGS)
def test_autozoom_boundaries_follow_the_toggles(files, dups, qcfail):
    from services.bam_boundaries import get_read_boundaries_from_bam
    with pysam.AlignmentFile(files["bam"]) as bam:
        others = sum(1 for r in bam.fetch(CHROM, START, END)
                     if not (r.is_unmapped or r.is_secondary or r.is_supplementary)
                     and r.query_name not in files["kept"] | files["dup"] | files["qcfail"]
                     and read_has_footprint_calls(r))
    with read_policy_for_request(dups, qcfail):
        boundaries = get_read_boundaries_from_bam(files["bam"], CHROM, START, END, max_reads=100_000)
    assert len(boundaries) == len(_expected(files, dups, qcfail)) + others


# ── background jobs ───────────────────────────────────────────────────────────

def test_background_job_keys_separate_the_toggles():
    from services.background_work import _job_key
    keys = set()
    for dups, qcfail in SETTINGS:
        with read_policy_for_request(dups, qcfail):
            keys.add(_job_key(("meta", 1)))
    assert len(keys) == 4
    assert _job_key(("meta", 1)) == ("meta", 1)   # the default key is unchanged


# ── the routes: the query parameters reach each path (SignalFilterMiddleware) ──

@pytest.fixture
def added(client, files):
    resp = client.post("/api/datasets/add", json={"path": files["bam"], "label": "read_policy_paths"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    yield did
    client.delete(f"/api/datasets/{did}")  # the app is shared with other tests


def test_routes_follow_the_query_toggles(client, added, files):
    counts = {}
    for dups, qcfail in SETTINGS:
        params = {**({"include_duplicates": "true"} if dups else {}), **({"include_qcfail": "true"} if qcfail else {})}
        resp = client.get("/api/reads/info", params=dict(chrom=CHROM, start=START, end=END, dataset_id=added, **params))
        assert resp.status_code == 200, resp.text
        counts[(dups, qcfail)] = resp.json()["count"]
        resp = client.post("/api/autozoom", params=dict(chrom=CHROM, start=START, end=END, spanning="false", **params),
                           json={"dataset_ids": [added], "distance": 1000})
        assert resp.status_code == 200, resp.text
    base = counts[(False, False)]
    assert counts[(True, False)] == base + len(files["dup"])
    assert counts[(False, True)] == base + len(files["qcfail"])
    assert counts[(True, True)] == base + len(files["dup"]) + len(files["qcfail"])


# ── lift difference reads ─────────────────────────────────────────────────────

def test_lift_difference_reads_follow_the_toggles(tmp_path):
    """The lifted records an inspection reads (a real BAM through the graphlift reader and the display
    composer; tests/live_lift_fixtures.py)."""
    import array
    from types import SimpleNamespace
    from live_lift_fixtures import MAT, SSIZE, TARGET, TSIZE, make_record, write_bam, write_difference_sidecar
    from services.lift import differences as diff
    from services.lift import live_lift as ll
    from services.lift.dataset import LiveLiftConfig

    ll.clear_selection_cache()
    ll.clear_primary_cache()
    manifest = write_difference_sidecar(tmp_path / "map")
    source = tmp_path / "source.fa"
    source.write_text(f">{MAT}\n{'A' * SSIZE}\n")
    pysam.faidx(str(source))
    target = tmp_path / "target.fa"
    target.write_text(f">{TARGET}\n{'A' * TSIZE}\n")
    pysam.faidx(str(target))
    calls = [("ns", array.array("I", [90, 400])), ("nl", array.array("I", [100, 100])), ("MD", "6000")]
    bam = write_bam(tmp_path / "source.bam", lambda h: [
        make_record(h, "kept", MAT, 0, "6000M", tags=calls),
        make_record(h, "dup", MAT, 0, "6000M", flag=0x400, tags=calls),
        make_record(h, "qcfail", MAT, 0, "6000M", flag=0x200, tags=calls)])
    ds = SimpleNamespace(id="lift", paths=[bam], live_lift=LiveLiftConfig(manifest, [], source_fasta=str(source)),
                         data_type="bam_livelift")
    state = SimpleNamespace(fasta=pysam.FastaFile(str(target)), datasets={ds.id: ds})
    try:
        seen = {}
        for dups, qcfail in SETTINGS:
            with read_policy_for_request(dups, qcfail):
                seen[(dups, qcfail)] = {r["id"] for r in diff.difference_reads(state, ds, TARGET, 1100, 1101)["rows"]}
        assert seen[(False, False)] == {"kept"}
        assert seen[(True, False)] == {"kept", "dup"}
        assert seen[(False, True)] == {"kept", "qcfail"}
        assert seen[(True, True)] == {"kept", "dup", "qcfail"}
    finally:
        state.fasta.close()


def test_window_fitting_and_top_windows_follow_the_toggles(tmp_path):
    """3.1.0 audit (agy): window fitting applied the uncalled rule but not the read policy, so duplicate and
    QC-fail reads widened a fitted window with both toggles off; the window search's coverage hid them
    whatever the toggles. Both follow the toggles, and the candidate cache keeps one entry per setting."""
    from array import array
    from services import random_window
    from services.random_window import _Contig, _Scope
    path = str(tmp_path / "fit.bam")
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrF", "LN": 50_000}]}
    calls = [("ns", array("I", [10])), ("nl", array("I", [60]))]
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        for i, (start, length, flag) in enumerate([(10_000, 600, 0), (10_010, 600, 0), (10_020, 600, 0),
                                                   (10_030, 6000, 0x400), (10_040, 6000, 0x200)]):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = f"r{i}", 0, start
            read.flag, read.mapping_quality = flag, 60
            read.query_sequence = "A" * length
            read.cigarstring = f"{length}M"
            for tag, value in calls:
                read.set_tag(tag, value)
            out.write(read)
    pysam.index(path)
    state = BrowserState(None)
    ds = Dataset("ds", [path], "ds", data_type="bam")
    state.datasets["ds"] = ds
    state.dataset_order.append("ds")
    scope = _Scope(contigs={"ds": [_Contig(path=path, contig="chrF", weight=1.0, size=50_000)]},
                   with_data=1, data_contigs=1)

    def fit():
        return random_window._fit_window_to_reads([ds], scope, "chrF", 9000, 21_000, 12_000, True)

    plain = fit()
    assert plain is not None and plain[1] - plain[0] < 2000      # fitted to the three 600 bp reads
    with read_policy_for_request(include_duplicates=True, include_qcfail=True):
        shown = fit()
    assert shown is None or shown[1] - shown[0] > 5000
    state.chrom_sizes = {"chrF": 50_000}

    def depth():
        out = random_window.top_covered_windows(state, span=400, dataset_id="ds", n=1, samples=40, seed=3)
        return out["windows"][0]["depth"] if out.get("windows") else 0
    assert depth() == 3
    with read_policy_for_request(include_duplicates=True, include_qcfail=True):
        assert depth() == 5
    assert depth() == 3


def test_window_fitting_and_region_scan_follow_the_signal_filters(tmp_path):
    """3.1.0 re-check (agy #4): window fitting and the region scan applied the read policy but not the
    signal filters, so a called background read (``bg`` 1) hidden by "Hide background" still widened a
    fitted window and counted in the scan; the window and region caches are keyed by the filters too."""
    import json
    import time
    from array import array
    from types import SimpleNamespace
    from services import random_window, region_detect
    from services.random_window import _Contig, _Scope
    from services.signal_evidence import signal_filters_for_request
    path = str(tmp_path / "signal_fit.bam")
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chrF", "LN": 50_000}],
              "CO": ["FIBERHMM-SIGNAL:v1:" + json.dumps(dict(tag_schema=5))]}
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        for i, (start, length, bg) in enumerate([(10_000, 600, 0), (10_010, 600, 0), (10_020, 600, 0),
                                                 (10_030, 6000, 1)]):
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = f"r{i}", 0, start
            read.mapping_quality = 60
            read.query_sequence = "A" * length
            read.cigarstring = f"{length}M"
            read.set_tag("ns", array("I", [10]))
            read.set_tag("nl", array("I", [60]))
            read.set_tag("bg", bg, value_type="i")
            out.write(read)
    pysam.index(path)
    ds = Dataset("ds", [path], "ds", data_type="bam")
    scope = _Scope(contigs={"ds": [_Contig(path=path, contig="chrF", weight=1.0, size=50_000)]},
                   with_data=1, data_contigs=1)

    def fit():
        return random_window._fit_window_to_reads([ds], scope, "chrF", 9000, 21_000, 12_000, True)

    def scanned():
        contig = SimpleNamespace(path=path, contig="chrF", size=50_000)
        _rows, seen, _partial = region_detect._scan([contig], time.monotonic() + 30)
        return seen

    shown = fit()
    assert shown is None or shown[1] - shown[0] > 5000     # the 6 kb background read widens it
    assert scanned() == 4
    with signal_filters_for_request({"hideBackground": True}):
        hidden = fit()
        assert hidden is not None and hidden[1] - hidden[0] < 2000
        assert scanned() == 3
    # The window search's candidate cache: one entry per filter setting.
    state = BrowserState(None)
    state.datasets["ds"] = ds
    state.dataset_order.append("ds")
    state.chrom_sizes = {"chrF": 50_000}

    def depth():
        out = random_window.top_covered_windows(state, span=400, dataset_id="ds", n=1, samples=40, seed=3)
        return out["windows"][0]["depth"] if out.get("windows") else 0
    assert depth() == 4
    with signal_filters_for_request({"hideBackground": True}):
        assert depth() == 3
    assert depth() == 4
