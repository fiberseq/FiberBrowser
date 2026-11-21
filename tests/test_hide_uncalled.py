"""Min footprints never shows reads without footprint calls: read track, coverage, read stats, analyses.

An uncalled read has no non-empty MA/Ma nuc/msp/tf group and no non-empty ns/nl or as/al
array pair (bam_tags.read_has_footprint_calls). Min footprints hides them at every
threshold, 0 included ("every called read") and its automatic relax to 0; only its last
choice, "All reads, including uncalled" (min_footprints=-1 from the frontend, carried as
hide_uncalled=false internally), shows them.
"""
from array import array

import pysam
import pytest

from models.domain import Dataset
from models.requests import ReadStatsRequest
from services.analysis_query import AnalysisReadQuery
from services.read_auxiliary_endpoint import get_coverage_payload
from services.read_endpoint import compact_reads_payload_for_request
from services.read_stats import compute_read_stats
from services.signal_evidence import hide_uncalled_for_request
from services.working_sets import make_working_cache_key
from state.browser_state import BrowserState

CHROM = "chrH"
LENGTH = 600
CALLED = {"called_ma", "called_msp_only", "called_empty_nuc_msp", "called_legacy"}
UNCALLED = {"uncalled_none", "uncalled_scalar_ns", "uncalled_empty_ma"}
# Away from the others: only reads the caller skipped.
ONLY_UNCALLED = {"lonely_none", "lonely_empty_ma"}


def _write(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    records = [
        # MA nucleosome calls (2 footprints).
        ("called_ma", 1000, [("MA", f"{LENGTH};nuc+Q:11-147,301-147;msp+:158-143"), ("AQ", array("B", [200, 200]))]),
        # Called and fully accessible: one MSP over the read.
        ("called_msp_only", 1010, [("MA", f"{LENGTH};msp+:1-{LENGTH}")]),
        # An empty nucleosome group beside an MSP group: called.
        ("called_empty_nuc_msp", 1020, [("MA", f"{LENGTH};nuc+Q:;msp+:1-{LENGTH}")]),
        # Legacy ns/nl arrays: 6 footprints (passes Min footprints 5).
        ("called_legacy", 1030, [("ns", array("I", [10, 100, 190, 280, 370, 460])),
                                 ("nl", array("I", [60, 60, 60, 60, 60, 60]))]),
        ("uncalled_none", 1040, []),
        # Dorado's scalar ns:i (signal sample count): no call.
        ("uncalled_scalar_ns", 1050, [("ns", 40_000)]),
        # Only empty MA groups.
        ("uncalled_empty_ma", 1060, [("MA", f"{LENGTH};nuc+Q:;msp+:")]),
        ("lonely_none", 5000, []),
        ("lonely_empty_ma", 5010, [("MA", f"{LENGTH};nuc+Q:;tf+Q:")]),
    ]
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, tags in records:
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start = name, 0, start
            read.mapping_quality = 60
            read.query_sequence = "ACGT" * (LENGTH // 4)
            read.cigarstring = f"{LENGTH}M"
            for tag, value in tags:
                read.set_tag(tag, value)
            out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.fixture
def bam(tmp_path):
    return _write(tmp_path / "mixed.bam")


def _state(path):
    state = BrowserState(None)
    state.drop_short_terminal_footprints = False
    dataset = Dataset("ds", [path], "ds", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "msp": True}
    state.datasets["ds"] = dataset
    state.dataset_order.append("ds")
    return state


def _compact(state, start=900, end=1700, **kwargs):
    params = dict(state=state, chrom=CHROM, start=start, end=end, max_reads=100, dataset_id="ds",
                  include_layers=True, layer_names="nuc,tf,msp", spanning=False)
    params.update(kwargs)
    payload = compact_reads_payload_for_request(**params)
    return payload, {read["id"] for read in payload["reads"]}


@pytest.mark.parametrize("hide", [True, False])
def test_read_track_hides_and_counts_uncalled_reads(bam, hide):
    state = _state(bam)
    payload, ids = _compact(state, hide_uncalled=hide)
    assert ids == (CALLED if hide else CALLED | UNCALLED)
    assert payload["signal_counts"]["uncalled"] == 3
    assert payload["signal_counts"]["uncalled_hidden"] == (3 if hide else 0)
    assert payload["signal_counts"]["min_footprints_hidden"] == 0
    # A cached load answers the same way; the other setting is never served from it.
    assert _compact(state, hide_uncalled=hide)[1] == ids
    assert _compact(state, hide_uncalled=not hide)[1] == (CALLED | UNCALLED if hide else CALLED)
    # The opt-in direct path (QC-fail reads shown) too.
    assert _compact(state, hide_uncalled=hide, include_qcfail=True)[1] == ids


def test_called_rule_is_shared_by_loader_and_read_stats(bam):
    from services import read_stats
    from services.bam_tags import read_has_footprint_calls
    assert read_stats.read_has_footprint_calls is read_has_footprint_calls
    with pysam.AlignmentFile(bam) as handle:
        rule = {read.query_name: read_has_footprint_calls(read) for read in handle.fetch()}
    assert {name for name, called in rule.items() if called} == CALLED
    # Records without tag access count as called.
    assert read_has_footprint_calls(object())


@pytest.mark.parametrize("hide", [True, False])
def test_coverage_follows_the_filter(bam, hide):
    state = _state(bam)
    coverage = get_coverage_payload(state, chrom=CHROM, start=900, end=1700, bins=1, hide_uncalled=hide)
    assert coverage["coverage"] == [len(CALLED) if hide else len(CALLED | UNCALLED)]


@pytest.mark.parametrize("hide", [True, False])
def test_read_stats_say_which_filter_hid_what(bam, hide):
    state = _state(bam)
    ids = {"ds": sorted(CALLED | UNCALLED)}
    stats = compute_read_stats(state, CHROM, 900, 1700, False,
                               ReadStatsRequest(read_ids_by_dataset=ids, hide_uncalled=hide, min_footprints=5))
    rows = {row["read_id"]: row for row in stats["per_read"]}
    agg = stats["aggregate"]
    # Owner, 20 Nov 2026: reads that fail Min footprints are left out of the listing (and the distributions), as the
    # read track leaves them out; they are counted as hidden, by reason. Only the legacy read has 5+ footprints.
    assert set(rows) == {"called_legacy"}
    assert set(rows) == _compact(state, min_footprints=5, hide_uncalled=hide)[1]
    assert not stats["missing_read_ids_by_dataset"].get("ds")
    assert stats["found_count"] == 1 and agg["n_reads"] == 1
    assert agg["n_hidden_uncalled"] == (3 if hide else 0)
    # Called reads with fewer than 5 footprints: MA with 2, and the two fully accessible ones;
    # with uncalled reads shown, Min footprints hides those too (0 calls), as the loaders do.
    assert agg["n_hidden_min_footprints"] == (3 if hide else 3 + len(UNCALLED))
    assert agg["min_footprints"] == 5


@pytest.mark.parametrize("hide", [True, False])
def test_read_stats_list_reads_that_pass_min_footprints(bam, hide):
    """Min footprints 2: the MA read (2 footprints) and the legacy one pass and are listed with their footprints; the
    fully accessible ones (0 footprints) are hidden and contribute nothing to the distributions. Uncalled reads follow
    "All reads, including uncalled" as before: with Min footprints off they are listed exactly when shown."""
    state = _state(bam)
    ids = {"ds": sorted(CALLED | UNCALLED)}
    stats = compute_read_stats(state, CHROM, 900, 1700, False,
                               ReadStatsRequest(read_ids_by_dataset=ids, hide_uncalled=hide, min_footprints=2))
    rows = {row["read_id"]: row for row in stats["per_read"]}
    assert set(rows) == {"called_ma", "called_legacy"} == _compact(state, min_footprints=2, hide_uncalled=hide)[1]
    assert stats["aggregate"]["n_hidden_min_footprints"] == (2 if hide else 2 + len(UNCALLED))
    # The distributions hold only the listed reads: 2 and 6 footprints, none uncalled.
    agg = stats["aggregate"]
    assert agg["n_reads"] == 2 and agg["n_not_called"] == 0 and agg["mean_footprint_count"] == 4.0
    assert sum(b["count"] for b in agg["hist_fp_count"]) == 2
    off = compute_read_stats(state, CHROM, 900, 1700, False,
                             ReadStatsRequest(read_ids_by_dataset=ids, hide_uncalled=hide, min_footprints=0))
    assert {row["read_id"] for row in off["per_read"]} == (CALLED if hide else CALLED | UNCALLED)
    assert off["aggregate"]["n_hidden_min_footprints"] == 0


def test_read_stats_request_defaults_to_hide():
    assert ReadStatsRequest(read_ids_by_dataset={}).hide_uncalled is True


@pytest.mark.parametrize("hide", [True, False])
def test_analysis_working_set_follows_the_filter(bam, hide):
    state = _state(bam)
    query = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds",
                                           hide_uncalled=hide)
    assert query.hide_uncalled is hide
    assert {r["id"] for r in query.build_working_set(state, "ds").reads} == (CALLED if hide else CALLED | UNCALLED)
    # Read-ID scopes too (the reads a panel shows).
    scoped = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds",
                                            hide_uncalled=hide, read_ids=sorted(CALLED | UNCALLED))
    assert {r["id"] for r in scoped.build_working_set(state, "ds").reads} == (CALLED if hide else CALLED | UNCALLED)


def test_analyses_without_an_explicit_setting_follow_the_request(bam):
    state = _state(bam)
    plain = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds")
    assert plain.hide_uncalled is True
    assert {r["id"] for r in plain.build_working_set(state, "ds").reads} == CALLED
    with hide_uncalled_for_request("false"):
        shown = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds")
        assert shown.hide_uncalled is False
        assert {r["id"] for r in state.build_working_set("ds", CHROM, 900, 1700).reads} == CALLED | UNCALLED
    assert {r["id"] for r in state.build_working_set("ds", CHROM, 900, 1700).reads} == CALLED


def test_cache_keys_differ_between_settings(bam):
    state = _state(bam)
    common = dict(dataset_id="ds", chrom=CHROM, start=900, end=1700, spanning=False, min_footprints=0,
                  max_working_reads=0, include_methylation=True, layer_key=None, quality_filters=[])
    assert make_working_cache_key(**common, hide_uncalled=True) != make_working_cache_key(**common, hide_uncalled=False)
    hide = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds", hide_uncalled=True)
    show = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds", hide_uncalled=False)
    assert hide != show and repr(hide) != repr(show)
    hide.build_working_set(state, "ds")
    show.build_working_set(state, "ds")
    from services.working_sets import broad_cache_hide_uncalled
    assert {broad_cache_hide_uncalled(key) for key in state._broad_cache} == {True, False}
    assert {key[-1] for key in state._working_set_cache} == {True, False}


def test_escape_hatch_is_min_footprints_minus_one(bam):
    state = _state(bam)
    payload, ids = _compact(state, min_footprints=-1)
    assert ids == CALLED | UNCALLED
    assert payload["signal_counts"]["uncalled_hidden"] == 0
    # 0 is every called read, fully accessible ones included; never the uncalled ones.
    assert _compact(state, min_footprints=0)[1] == CALLED
    q0 = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds", min_footprints=0)
    qall = AnalysisReadQuery.from_request(state, chrom=CHROM, start=900, end=1700, dataset_id="ds", min_footprints=-1)
    assert (q0.min_footprints, q0.hide_uncalled) == (0, True)
    assert (qall.min_footprints, qall.hide_uncalled) == (0, False)
    assert q0 != qall
    assert {r["id"] for r in qall.build_working_set(state, "ds").reads} == CALLED | UNCALLED
    stats = compute_read_stats(state, CHROM, 900, 1700, False, ReadStatsRequest(
        read_ids_by_dataset={"ds": sorted(CALLED | UNCALLED)}, hide_uncalled=False, min_footprints=0))
    assert {r["read_id"] for r in stats["per_read"] if r["call_status"] == "not called"} == UNCALLED


def test_hidden_counts_by_reason(bam):
    state = _state(bam)
    payload, ids = _compact(state, min_footprints=5)
    counts = payload["signal_counts"]
    assert ids == {"called_legacy"}
    # 3 uncalled; 3 called with < 5 calls (MA with 2, the two fully accessible ones).
    assert (counts["uncalled_hidden"], counts["min_footprints"], counts["min_footprints_hidden"]) == (3, 5, 3)
    payload, _ = _compact(state, min_footprints=5, hide_uncalled=False)
    # Uncalled reads allowed but a threshold set: they (0 calls) fall to Min footprints.
    assert (payload["signal_counts"]["uncalled_hidden"], payload["signal_counts"]["min_footprints_hidden"]) == (0, 6)


def test_min_footprints_relaxation_never_shows_uncalled_reads(bam):
    state = _state(bam)
    # Min footprints turned off (the default relaxed to 0): uncalled reads stay hidden.
    assert _compact(state, min_footprints=0)[1] == CALLED
    assert {r["id"] for r in state.build_working_set("ds", CHROM, 900, 1700, min_footprints=0).reads} == CALLED
    # Min footprints 5 hides the called reads with fewer footprints, independently.
    assert _compact(state, min_footprints=5)[1] == {"called_legacy"}
    # A view of uncalled reads only: Min footprints hid nothing (no relaxation is offered);
    # the uncalled filter says how many it hid.
    payload, ids = _compact(state, start=4900, end=5700, min_footprints=5)
    assert ids == set()
    assert "hidden_by_min_footprints" not in payload
    assert payload["signal_counts"]["uncalled_hidden"] == len(ONLY_UNCALLED)
    payload, ids = _compact(state, start=4900, end=5700, min_footprints=0, hide_uncalled=False)
    assert ids == ONLY_UNCALLED


def _add(client, path):
    added = client.post("/api/datasets/add", json={"path": path, "label": "mixed"})
    assert added.status_code == 200, added.text
    body = added.json()
    return body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")


@pytest.fixture
def added(client, bam):
    did = _add(client, bam)
    yield did
    client.delete(f"/api/datasets/{did}")  # the app is shared with other tests


def test_routes_default_to_hide_and_honor_false(client, added):
    did = added
    view = dict(chrom=CHROM, start=900, end=1700)
    default = client.get("/api/reads/compact", params=dict(view, dataset_id=did))
    assert default.status_code == 200, default.text
    assert {r["id"] for r in default.json()["reads"]} == CALLED
    assert default.json()["signal_counts"]["uncalled_hidden"] == 3
    shown = client.get("/api/reads/compact", params=dict(view, dataset_id=did, hide_uncalled="false"))
    assert {r["id"] for r in shown.json()["reads"]} == CALLED | UNCALLED

    for hide, expected in ((None, CALLED), ("false", CALLED | UNCALLED)):
        params = dict(view, dataset_ids=did, **({"hide_uncalled": hide} if hide else {}))
        batch = client.get("/api/reads/compact_all", params=params)
        assert batch.status_code == 200, batch.text
        data = batch.json()["datasets"][did]
        assert {r["id"] for r in data["reads"]} == expected
        assert data["signal_counts"]["uncalled_hidden"] == (3 if hide is None else 0)

        coverage = client.get("/api/coverage", params=dict(view, bins=1, dataset_id=did,
                                                           **({"hide_uncalled": hide} if hide else {})))
        assert coverage.json()["coverage"] == [len(expected)]

        # Footprint sizes (V-plot) read the analysis working set: the request's setting decides.
        vplot = client.post("/api/cluster/vplot", params=dict(chrom=CHROM, region_start=900, region_end=1700,
                                                              **({"hide_uncalled": hide} if hide else {})),
                            json={"group_by": "all", "raw_values": True, "dataset_ids": [did]})
        assert vplot.status_code == 200, vplot.text
        matrices = vplot.json()["data"][did]
        assert next(iter(matrices.values()))["n_reads"] == len(expected)

        stats = client.post("/api/reads/stats", params=view,
                            json={"read_ids_by_dataset": {did: sorted(CALLED | UNCALLED)},
                                  **({"min_footprints": -1} if hide else {})})
        assert stats.status_code == 200, stats.text
        assert {r["read_id"] for r in stats.json()["per_read"]} == expected

    # The frontend's "All reads, including uncalled": min_footprints=-1.
    resp = client.get("/api/reads/compact", params=dict(view, dataset_id=did, min_footprints=-1))
    assert {r["id"] for r in resp.json()["reads"]} == CALLED | UNCALLED
    resp = client.get("/api/reads/compact_all", params=dict(view, dataset_ids=did, min_footprints=-1))
    assert {r["id"] for r in resp.json()["datasets"][did]["reads"]} == CALLED | UNCALLED
    resp = client.get("/api/reads/compact", params=dict(view, dataset_id=did, min_footprints=0))
    assert {r["id"] for r in resp.json()["reads"]} == CALLED


def test_region_reuse_stays_safe_with_uncalled_extents(bam):
    """Reads Min footprints hid are hidden at load time: the payload stays reusable for views
    inside it and carries the uncalled reads' extents so a sub-view counts its own."""
    from services.signal_counts import attach_signal_counts
    state = _state(bam)
    _compact(state)  # publishes the signal window
    payload = attach_signal_counts({}, state, "ds", CHROM, 900, 1700, min_footprints=0)
    assert "_region_reuse_safe" not in payload
    extents = payload["signal_counts"]["uncalled_extents"]
    assert len(extents) == 3 and all(lo >= 1040 and hi <= 1060 + LENGTH for lo, hi in extents)
    # Shown, or loaded with a threshold (never reused by the client): no extents needed.
    assert "uncalled_extents" not in attach_signal_counts({}, state, "ds", CHROM, 900, 1700, hide_uncalled=False)["signal_counts"]
    with_threshold = attach_signal_counts({}, state, "ds", CHROM, 900, 1700, min_footprints=5)
    assert "uncalled_extents" not in with_threshold["signal_counts"] and "_region_reuse_safe" not in with_threshold
    # The cold scan agrees with the window.
    state._signal_counts_cache.clear()
    from services import signal_windows
    signal_windows._windows.clear()
    cold = attach_signal_counts({}, _state(bam), "ds", CHROM, 900, 1700, min_footprints=0)
    assert sorted(cold["signal_counts"]["uncalled_extents"]) == sorted(extents)


@pytest.mark.parametrize("value, expected", [("all", -1), ("All reads, including uncalled", -1), (-1, -1), (3, 3.0), (0, 0.0)])
def test_copilot_set_min_footprints_accepts_all_reads(value, expected):
    from services.natural_language_commands import _normalize_action
    action, warnings = _normalize_action(None, {"type": "set_min_footprints", "value": value}, context=None)
    assert action["value"] == expected and not warnings
    if expected == -1:
        assert "All reads, including uncalled" in action["label"]


def _write_softclipped(path):
    """One read, 300S300M, with six ns/nl footprints: three lie wholly in the soft clip."""
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 20_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        read = pysam.AlignedSegment(out.header)
        read.query_name, read.reference_id, read.reference_start, read.mapping_quality = "clipped", 0, 1000, 60
        read.query_sequence = "ACGT" * 150
        read.cigarstring = "300S300M"
        read.set_tag("ns", array("I", [10, 100, 200, 320, 420, 520]))
        read.set_tag("nl", array("I", [60, 60, 60, 60, 60, 60]))
        out.write(read)
    pysam.index(str(path))
    return str(path)


def test_counts_by_reason_follow_the_loaders_mapped_footprints(tmp_path):
    from services.bam_tags import footprint_call_count
    path = _write_softclipped(tmp_path / "clipped.bam")
    with pysam.AlignmentFile(path) as handle:
        assert footprint_call_count(next(handle.fetch())) == 3
    state = _state(path)
    payload, ids = _compact(state, start=900, end=1700, min_footprints=5)
    assert ids == set()  # the loader places 3 footprints: Min footprints 5 hides the read
    assert payload["signal_counts"]["min_footprints_hidden"] == 1
    assert _compact(state, start=900, end=1700, min_footprints=3)[1] == {"clipped"}
    # The cold scan and Read Stats count it the same way.
    state._signal_counts_cache.clear()
    from services import signal_windows
    signal_windows._windows.clear()
    from services.signal_counts import attach_signal_counts
    assert attach_signal_counts({}, _state(path), "ds", CHROM, 900, 1700, min_footprints=5)["signal_counts"]["min_footprints_hidden"] == 1
    stats = compute_read_stats(state, CHROM, 900, 1700, False, ReadStatsRequest(
        read_ids_by_dataset={"ds": ["clipped"]}, min_footprints=5))
    assert stats["aggregate"]["n_hidden_min_footprints"] == 1


@pytest.mark.parametrize("warm", [True, False])
def test_uncalled_extents_are_bounded_and_only_built_when_returned(bam, monkeypatch, warm):
    from services import signal_counts as sc, signal_windows
    state = _state(bam)
    if warm:
        _compact(state)  # the signal window path
    else:
        signal_windows._windows.clear()
    # Not asked (a threshold, or uncalled reads shown): none are built.
    assert sc.signal_counts(state, "ds", CHROM, 900, 1700, min_footprints=5)["uncalled_extents"] == []
    assert sc.signal_counts(state, "ds", CHROM, 900, 1700)["uncalled_extents"] == []
    # Past the cap: nothing is held, and the view is not reused (counts stay correct).
    assert sc.signal_counts(state, "ds", CHROM, 900, 1700, extents_cap=2)["uncalled_extents"] is None
    assert len(sc.signal_counts(state, "ds", CHROM, 900, 1700, extents_cap=3)["uncalled_extents"]) == 3
    monkeypatch.setattr(sc, "MAX_REUSE_EXTENTS", 2)
    payload = sc.attach_signal_counts({}, state, "ds", CHROM, 900, 1700, min_footprints=0)
    assert payload["_region_reuse_safe"] is False
    assert "uncalled_extents" not in payload["signal_counts"] and payload["signal_counts"]["uncalled_hidden"] == 3


# ---- Min footprints counts: the loader's own mapped footprint count -------------------------

DEMO = pytest.importorskip("pathlib").Path(__file__).resolve().parents[1] / "browser" / "data" / "demo"


def _loader_exact_count(read, frame):
    """The loader's steps for legacy tags, mapper always (no shortcut)."""
    from services.bam_tags import (_exact_mapped_count, interval_tag_pair, legacy_starts_in_seq_frame,
                                   read_legacy_tags_are_molecular)
    from services.compact_read_loader import msp_complement
    starts, lengths = interval_tag_pair(read, "ns", "nl")
    if starts is None:
        a, b = interval_tag_pair(read, "as", "al")
        if a is None:
            return None
        starts, lengths = msp_complement(a, b, read.query_length or 0)
    starts, lengths = [int(x) for x in starts], [int(x) for x in lengths]
    if not starts:
        return 0
    starts = legacy_starts_in_seq_frame(starts, lengths, read, read_legacy_tags_are_molecular(read, frame))
    return _exact_mapped_count(read, starts, lengths)


SYNTHETIC = [
    # (name, start, cigar, ns starts[, nl lengths]) – 100-bp footprints unless given
    ("ins_inside", 1000, "500M200I500M", [520, 540, 560, 580, 600]),       # wholly inside the insertion
    ("ins_span", 3000, "500M200I500M", [10, 450, 650, 900, 1100]),
    ("clip_then_ins", 5000, "50S30I500M", [0, 40, 60, 200, 400]),          # clip next to an insertion
    ("ins_then_clip", 7000, "500M30I50S", [10, 200, 480, 500, 530]),
    ("single_block_ins", 9000, "400M50I", [10, 200, 380, 410, 440]),
    ("single_block_clip", 11000, "300S300M", [10, 100, 250, 320, 520]),
    ("clips_both", 13000, "200S300M20D300M150S", [-50, 50, 150, 450, 820, 900]),
    ("no_clip_negative", 15000, "300M10I290M", [-80, 10, 400, 590, 650]),
    # Audit re-check: a D/N/P between the clip and the insertion, and no aligned block at all.
    ("clip_del_ins", 17000, "50S20D30I200M20D200M", [40, 100, 300]),
    ("clip_skip_ins", 19000, "50S20N30I200M20D200M", [40, 100, 300]),
    ("clip_pad_ins", 21000, "50S20P30I200M20D200M", [40, 100, 300]),
    ("ins_only", 23000, "300I", [10, 150]),
    # The original D/N/P regression: 20-bp footprints (a 100-bp one in the clip reaches aligned bases).
    ("clip_del_ins_20", 24000, "50S20D30I200M20D200M", [10, 40, 100, 300], [20, 20, 20, 20]),
    ("clip_skip_ins_20", 25000, "50S20N30I200M20D200M", [10, 40, 100, 300], [20, 20, 20, 20]),
    ("clip_pad_ins_20", 26000, "50S20P30I200M20D200M", [10, 40, 100, 300], [20, 20, 20, 20]),
    # Zero-length aligned ops beside a clip and an insertion (pysam accepts them).
    ("zero_m", 27000, "50S0M20I200M", [40, 100], [20, 20]),
    ("zero_eq", 27500, "50S0=20I200M", [40, 100], [20, 20]),
    ("zero_x", 28000, "200M20I0X50S", [10, 215], [20, 20]),
]


def _write_synthetic(path):
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": CHROM, "LN": 30_000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, start, cigar, starts, *lengths in SYNTHETIC:
            read = pysam.AlignedSegment(out.header)
            read.query_name, read.reference_id, read.reference_start, read.mapping_quality = name, 0, start, 60
            read.cigarstring = cigar
            read.query_sequence = "A" * read.infer_query_length()
            read.set_tag("ns", array("i", starts))
            read.set_tag("nl", array("I", lengths[0] if lengths else [100] * len(starts)))
            out.write(read)
    pysam.index(str(path))
    return str(path)


def _bam_cases(tmp_path):
    return [(str(DEMO / "h1_chr1_insertion.bam"), "chr1"), (str(DEMO / "napa_ddda.bam"), "chr19"),
            (_write_synthetic(tmp_path / "synthetic.bam"), CHROM)]


def test_footprint_count_is_the_loaders_mapped_count(tmp_path):
    from services.bam_tags import footprint_call_count
    from services.legacy_frame import bam_legacy_frame_for
    for path, _chrom in _bam_cases(tmp_path):
        with pysam.AlignmentFile(path) as handle:
            frame = bam_legacy_frame_for(path, handle.header)
            checked = 0
            for read in handle.fetch():
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                exact = _loader_exact_count(read, frame)
                if exact is None:
                    continue
                assert footprint_call_count(read, frame) == exact, (path, read.query_name)
                checked += 1
            assert checked > 0
    with pysam.AlignmentFile(_write_synthetic(tmp_path / "s2.bam")) as handle:
        counts = {r.query_name: footprint_call_count(r) for r in handle.fetch()}
    assert counts["ins_inside"] == 5  # an insertion maps to its anchor: kept, as the loader keeps it
    # Zero-length aligned ops take the exact mapper (the fast path counted 2 here; the loader places 1).
    assert counts["zero_m"] == counts["zero_eq"] == 1


@pytest.mark.parametrize("warm", [False, True])
def test_hidden_counts_by_reason_equal_what_the_loader_hides(tmp_path, warm):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.bam_handles import get_bam_handle
    from services import signal_windows
    from services.signal_counts import signal_counts
    for path, chrom in _bam_cases(tmp_path):
        with pysam.AlignmentFile(path) as handle:
            reads = [r for r in handle.fetch() if not (r.is_unmapped or r.is_secondary or r.is_supplementary)]
        lo, hi = min(r.reference_start for r in reads), max(r.reference_end for r in reads)
        state = _state(path)

        def shown(threshold, hide=True):
            return {r["id"] for r in build_compact_reads_from_bam(
                path, chrom, lo, hi, spanning_only=False, include_layers=False, hide_terminal_gaps=False,
                terminal_gap_threshold=0, short_terminal_footprint_bp=0, min_footprints=threshold,
                hide_uncalled=hide, bam_handle_getter=get_bam_handle)}

        everything, called = shown(0, hide=False), shown(0)
        for threshold in range(0, 8):
            signal_windows._windows.clear()
            state._signal_counts_cache.clear() if hasattr(state, "_signal_counts_cache") else None
            kept = shown(threshold)  # (publishes this load's signal window)
            if not warm:
                signal_windows._windows.clear()
            counts = signal_counts(state, "ds", chrom, lo, hi, min_footprints=threshold)
            assert counts["few_footprints"] == len(called - kept), (path, threshold)
            assert counts["uncalled"] == len(everything - called), (path, threshold)
