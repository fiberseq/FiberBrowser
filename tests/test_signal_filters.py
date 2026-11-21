"""Alignment signal semantics through loading, sampling, transport and exports."""
from array import array
import json
import os
from pathlib import Path

import pysam
import pytest

from models.domain import Dataset
from state.browser_state import BrowserState
from services.signal_evidence import (STATUS_CODES, parse_signal_tags, record_signal, signal_header,
    signal_keeps, signal_filters_for_request)


def detail(code, schema=5, structure=None):
    return dict(schema=schema, signal_status=STATUS_CODES[code], signal_reason="test_evidence",
                p_signal=None if code == -2 else .0, background_p=None, opportunities=None,
                structure=structure or dict(status="unscored", score=None, p_value=None))


@pytest.mark.parametrize("code", [1, 0, -1, -2])
def test_signal_enum_and_independent_filters(code):
    evidence = parse_signal_tags(code, json.dumps(detail(code)))
    assert evidence["status"] == STATUS_CODES[code]
    assert signal_keeps(evidence, {"hideBackground": True}) == (code != 1)
    assert signal_keeps(evidence, {"excludeUnscored": True}) == (code != -2)
    assert signal_keeps(evidence, {"requireDetectable": True}) == (code == 0)
    assert not signal_keeps(evidence, {"requireStructure": True})
    assert evidence["background_p"] is None


@pytest.mark.parametrize("tags", [
    {}, {"bg": 1}, {"bg": True, "me": detail(1)}, {"bg": -3, "me": detail(1)},
    {"bg": 1, "me": "{"}, {"bg": 1, "me": "null"}, {"bg": 1, "me": "[]"},
    {"bg": 1, "me": '{"schema":5,"signal_status":"background","p_signal":NaN}'},
    {"bg": 1, "db": 0, "me": detail(1)},
    {"bg": 1, "me": detail(0)}, {"bg": 1, "me": {"schema": 99, "signal_status": "background"}},
    {"bg": 1, "me": {"schema": 1, "status": "under"}},
    {"bg": 1, "me": {"schema": 2, "status": "over"}},
    {"bg": 1, "me": {"schema": 3, "status": "under"}},
    {"bg": 1, "me": {"schema": 3, "signal_class": []}},
    {"bg": 1, "me": {"schema": "5", "signal_status": "background"}},
])
def test_signal_unknown_annotation_loads_and_stays_visible(tags):
    evidence = parse_signal_tags(**tags)
    assert evidence["status"] == "unknown"
    assert signal_keeps(evidence, {"hideBackground": True})
    assert not signal_keeps(evidence, {"excludeUnscored": True})


def test_signal_fallback_header_and_model_provenance():
    meta = dict(tag_schema=5, codes={v: k for k, v in STATUS_CODES.items()}, pg="signal.1", quality_policy="base Q >= 20")
    header = signal_header({"CO": ["FIBERHMM-SIGNAL:v1:" + json.dumps(meta)],
                            "PG": [{"ID": "signal.1", "PN": "fiberhmm-tag-signal"}]})
    assert header["annotation_program"]["PN"] == "fiberhmm-tag-signal"
    assert parse_signal_tags(bg=1, header=header)["status"] == "background"
    assert parse_signal_tags(me=detail(-1), header=header)["quality_policy"] == "base Q >= 20"
    assert parse_signal_tags(me=detail(0))["status"] == "detectable"
    assert signal_header({"CO": ["FIBERHMM-SIGNAL:v1:{"]}) == {}


@pytest.mark.parametrize("code", [1, 0, -1, -2])
def test_signal_legacy_four(code):
    evidence = parse_signal_tags(db=code, me=dict(detail(code, 4), p_dddb=.4, floor_p=.7, sites=402))
    assert (evidence["status"], evidence["enzyme"]) == (STATUS_CODES[code], "dddb")
    assert (evidence["p_signal"], evidence["background_p"], evidence["opportunities"]) == (.4, .7, 402)
    assert parse_signal_tags(db=code, me=detail(1, 4))["status"] == (
        "background" if code == 1 else "unknown")


@pytest.mark.parametrize("signal_class,reason,status", [
    ("no detectable DddB signal (consistent with untreated/failed)", None, "background"),
    ("converted normally", None, "detectable"),
    ("low but genuine DddB signal (consistent with quiet chromatin)", None, "detectable"),
    ("unclassified", "too_few_sites", "unclassified"),
    ("unclassified", "not_sampled", "unscored"),
    ("under", None, "unknown"),
])
def test_signal_legacy_three_explicit_classes(signal_class, reason, status):
    evidence = parse_signal_tags(me=dict(schema=3, signal_class=signal_class, signal_reason=reason))
    assert evidence["status"] == status


def test_signal_strict_and_never_infers_structure_from_signal():
    strict = dict(requireDetectable=True, requireStructure=True)
    for code in STATUS_CODES:
        for structure in ("supported", "not_detected", "unclassified", "unscored"):
            evidence = parse_signal_tags(code, detail(code, structure=dict(status=structure, score=1, p_value=.01)))
            assert signal_keeps(evidence, strict) == (code == 0 and structure == "supported")
    for p_value in (None, .01):
        evidence = parse_signal_tags(0, detail(0, structure=dict(status="supported", score=None, p_value=p_value)))
        assert evidence["structure"]["status"] == "unscored"
        assert not signal_keeps(evidence, strict)


@pytest.fixture
def signal_bam(tmp_path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr1", "LN": 10000}], "RG": [{"ID": "one"}, {"ID": "two"}],
        "CO": ["FIBERHMM-SIGNAL:v1:" + json.dumps(dict(tag_schema=5))]})
    rows = []
    for i, code in enumerate([1, 0, -1, -2, None, 0, 1, 0]):
        read = pysam.AlignedSegment(header)
        read.query_name = f"read{i}"
        read.reference_id = 0
        read.reference_start = 100
        read.flag = 16 if i == 1 else 1024 if i == 5 else 0
        read.mapping_quality = 5 if i == 7 else 60
        read.cigarstring = "100M3D100M2I98M"
        read.query_sequence = "A" * 300
        read.set_tag("RG", "one")
        read.set_tag("ns", array("i", [20, 180]))
        read.set_tag("nl", array("i", [50, 50]))
        if code is not None:
            read.set_tag("bg", code, value_type="i")
            read.set_tag("me", json.dumps(detail(code, structure=dict(status="supported", score=2, p_value=.01)
                if i in (1, 6) else None)))
        rows.append(read)
    # Same query name, another RG and supplementary segment: no inherited score.
    extra = pysam.AlignedSegment.fromstring(rows[0].to_string(), header)
    extra.flag = 2048
    extra.set_tag("RG", "two")
    extra.set_tag("bg", -2, value_type="i")
    extra.set_tag("me", json.dumps(detail(-2)))
    rows.append(extra)
    path = tmp_path / "signal.bam"
    with pysam.AlignmentFile(path, "wb", header=header) as bam:
        for read in rows:
            bam.write(read)
    pysam.index(str(path))
    return path


def state_for(path):
    state = BrowserState(None)
    state.datasets = {"signal": Dataset("signal", str(path), "signal", data_type="bam")}
    state.dataset_order = ["signal"]
    return state


@pytest.mark.parametrize('edges', [False, True])
def test_decoded_signal_windows_match_scan_for_every_filter_without_refetch(signal_bam, monkeypatch, edges):
    from itertools import product
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.signal_counts import signal_counts
    from services.signal_windows import find_signal_window
    from services import bam_handles
    with pysam.AlignmentFile(signal_bam) as bam:
        header = signal_header(bam.header)
        rows = [read for read in bam.fetch() if not (read.is_unmapped or read.is_secondary or read.is_supplementary)]
    # Evidence includes duplicates and records removed by signal/call filters.
    with signal_filters_for_request({"requireDetectable": True}):
        regions = [(0, 250), (300, 1000)] if edges else None
        assert build_compact_reads_from_bam(str(signal_bam), "chr1", 0, 1000,
            spanning_only=False, min_footprints=100, hide_terminal_gaps=False, fetch_regions=regions) == []
        if edges:
            assert find_signal_window(str(signal_bam), "chr1", 100, 401) is None
            build_compact_reads_from_bam(str(signal_bam), "chr1", 250, 300,
                spanning_only=False, min_footprints=100, hide_terminal_gaps=False)
    assert find_signal_window(str(signal_bam), "chr1", 100, 401) is not None
    def no_reader(*args, **kwargs):
        raise AssertionError("cached summary acquired a BAM reader")
    monkeypatch.setattr(bam_handles, "get_bam_handle", no_reader)
    state = state_for(signal_bam)
    keys = ("hideBackground", "excludeUnscored", "requireDetectable", "requireStructure")
    for bits in product((False, True), repeat=4):
        filters = dict(zip(keys, bits))
        with signal_filters_for_request(filters):
            for duplicates, spanning, (start, end) in product((False, True), (False, True),
                    ((100, 401), (150, 200), (500, 600))):
                selected = [r for r in rows if r.reference_start < end and r.reference_end > start
                    and (duplicates or not r.is_duplicate)
                    and (not spanning or (r.reference_start <= start and r.reference_end >= end))]
                evidence = [record_signal(r, header) for r in selected]
                counts = signal_counts(state, "signal", "chr1", start, end,
                                       include_duplicates=duplicates, spanning=spanning)
                expected = {status: sum(e["status"] == status for e in evidence)
                            for status in (*STATUS_CODES.values(), "unknown")}
                kept = sum(signal_keeps(e, filters) for e in evidence)
                expected.update(total=len(evidence), kept=kept, hidden=len(evidence)-kept,
                    structure_scored=sum(e["structure"]["status"] != "unscored" for e in evidence))
                assert {key: counts[key] for key in expected} == expected
    alias = signal_counts(state, "signal", "1", 100, 401)
    assert alias["total"] == alias["kept"] == 7
    assert alias["provenance"] == [header]


@pytest.mark.parametrize('edges', [False, True])
def test_signal_window_discards_cancelled_decode_and_changed_source(signal_bam, monkeypatch, edges):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.background_work import Cancelled
    from services import signal_evidence
    from services.signal_windows import find_signal_window, find_signal_source
    regions = [(0, 250), (300, 1000)] if edges else None
    if edges:
        build_compact_reads_from_bam(str(signal_bam), "chr1", 250, 300, spanning_only=False)
    original = signal_evidence.record_signal
    calls = 0
    def cancel_midway(*args):
        nonlocal calls
        calls += 1
        if calls == 3: raise Cancelled()
        return original(*args)
    with monkeypatch.context() as patch:
        patch.setattr(signal_evidence, "record_signal", cancel_midway)
        with pytest.raises(Cancelled):
            build_compact_reads_from_bam(str(signal_bam), "chr1", 0, 1000,
                spanning_only=False, fetch_regions=regions)
    assert find_signal_window(str(signal_bam), "chr1", 100, 401) is None
    build_compact_reads_from_bam(str(signal_bam), "chr1", 0, 1000, spanning_only=False, fetch_regions=regions)
    assert find_signal_window(str(signal_bam), "chr1", 100, 401) is not None
    assert find_signal_source(str(signal_bam)) is not None
    stamp = signal_bam.stat()
    os.utime(signal_bam, ns=(stamp.st_atime_ns, stamp.st_mtime_ns+1_000_000))
    assert find_signal_window(str(signal_bam), "chr1", 100, 401) is None
    assert find_signal_source(str(signal_bam)) is None


def test_signal_window_bounds_sidecar_memory_and_circular_overlap(signal_bam):
    from types import SimpleNamespace
    from services.signal_windows import SignalWindow, find_signal_window
    evidence = parse_signal_tags()
    read = SimpleNamespace(reference_start=100, reference_end=9995, is_duplicate=False)
    bounded = SignalWindow(str(signal_bam), "chr1", 0, 10000)
    bounded.max_records = 1
    bounded.append(read, evidence)
    bounded.append(read, evidence)
    bounded.finish()
    assert not bounded.enabled and bounded.starts is None
    assert find_signal_window(str(signal_bam), "chr1", 0, 10000) is None
    complete = SignalWindow(str(signal_bam), "chr1", 0, 10000)
    complete.append(read, evidence)
    complete.finish()
    assert complete.counts(9990, 10000)["total"] == 1
    assert complete.counts(0, 150, previous=[(9990, 10000)])["total"] == 0


def payload(state, **kwargs):
    from services.read_endpoint import compact_reads_payload_for_request
    return compact_reads_payload_for_request(state, chrom="chr1", start=100, end=401,
        dataset_id="signal", max_reads=0, hide_terminal_gaps=False, terminal_gap_threshold=0,
        min_footprints=0, include_cigar=True, include_layers=True, **kwargs)


def test_signal_counts_cache_export_and_geometry(signal_bam, tmp_path):
    from services.read_bam_subset import write_read_subset_bam
    from services.read_auxiliary_endpoint import get_coverage_payload
    state = state_for(signal_bam)
    before = payload(state)
    assert len(before["reads"]) == 7
    with signal_filters_for_request({"hideBackground": True}):
        after = payload(state)
        expected = [r for r in before["reads"] if r.get("signal", {}).get("status") != "background"]
        assert after["reads"] == expected  # coordinates, CIGAR, reverse-read layers unchanged
        c = after["signal_counts"]
        assert (c["total"], c["kept"], c["hidden"], c["unclassified"], c["unscored"], c["unknown"]) == (7, 5, 2, 1, 1, 1)
        assert get_coverage_payload(state, chrom="chr1", start=100, end=401, bins=1)["coverage"] == [5]
        assert len(payload(state, include_duplicates=True)["reads"]) == 6
        out = tmp_path / "subset.bam"
        write_read_subset_bam(state, "signal", "chr1", 100, 401, [r["id"] for r in before["reads"]], str(out))
        with pysam.AlignmentFile(out) as bam:
            records = list(bam.fetch(until_eof=True))
        assert all(record_signal(r)["status"] != "background" for r in records)
        same_name = [r for r in records if r.query_name == "read0"]
        assert len(same_name) == 1 and same_name[0].is_supplementary and same_name[0].get_tag("RG") == "two"
    assert payload(state)["reads"] == before["reads"]
    assert get_coverage_payload(state, chrom="chr1", start=100, end=401, bins=1)["coverage"] == [7]
    with signal_filters_for_request({"hideBackground": True, "excludeUnscored": True}):
        assert {r["id"] for r in payload(state)["reads"]} == {"read1", "read2", "read7"}
    with signal_filters_for_request({"requireDetectable": True, "requireStructure": True}):
        assert [r["id"] for r in payload(state)["reads"]] == ["read1"]


def test_signal_before_sampling_and_stream_frames(signal_bam):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.read_sampling import Sampler, sampling
    from services.read_stream import decoded_read_sink
    from services.read_binary import encode_reads, reads_response
    from test_read_binary import decode
    seen = []
    class Sink:
        def append(self, read):
            seen.append(read)
    names = []
    class ObservedSampler(Sampler):
        def keep(self, name):
            names.append(name)
            return super().keep(name)
    sampler = ObservedSampler(1)
    token = decoded_read_sink.set(Sink())
    try:
        with signal_filters_for_request({"hideBackground": True}), sampling(sampler):
            reads = build_compact_reads_from_bam(str(signal_bam), "chr1", 100, 401, spanning_only=False,
                hide_terminal_gaps=False, terminal_gap_threshold=0)
    finally:
        decoded_read_sink.reset(token)
    assert "read0" not in names and "read6" not in names
    assert all(r.get("signal", {}).get("status") != "background" for r in seen)
    plain = json.loads(reads_response({"reads": reads}).body)
    assert decode(encode_reads(plain)) == plain


def test_signal_native_input_filters_records_before_loader_and_restores_identity(signal_bam):
    from services.signal_bam_input import load_signal_bam_payload
    def loader(datasets, region, options, progress):
        path = datasets[0]["paths"][0]
        with pysam.AlignmentFile(path) as bam:
            reads = [r for r in bam.fetch("chr1", 100, 401) if r.mapping_quality >= 20 and not r.is_duplicate]
        assert {r.query_name for r in reads} == {"read1", "read2", "read3", "read4", "read0"}
        assert all(record_signal(r)["status"] != "background" for r in reads)
        return dict(input_files=[dict(path=path)], library_id="browser:signal:" + path)
    with signal_filters_for_request({"hideBackground": True}):
        result = load_signal_bam_payload(loader, [dict(dataset_id="signal", paths=[str(signal_bam)])],
            dict(chrom="chr1", start=100, end=401), {}, None)
    assert result["input_files"][0]["path"] == str(signal_bam)
    assert result["library_id"] == "browser:signal:" + str(signal_bam)


def test_signal_native_refinement_keeps_filtered_inputs_alive(signal_bam):
    import gc
    from fiberhmm.inference.consensus.loader_sampling import SampledPayload
    from services.signal_bam_input import load_signal_bam_payload
    temporary = []
    def loader(datasets, region, options, progress):
        path = datasets[0]["paths"][0]
        temporary.append(Path(path))
        def body():
            with pysam.AlignmentFile(path) as bam:
                rows = list(bam.fetch("chr1", 100, 401))
            assert all(record_signal(r)["status"] != "background" for r in rows)
            return dict(strata=[dict(dataset_id="signal", units=[dict(id=r.query_name) for r in rows])],
                        input_files=[dict(path=path)])
        return SampledPayload(body(), lambda requirements: body())
    with signal_filters_for_request({"hideBackground": True}):
        result = load_signal_bam_payload(loader, [dict(dataset_id="signal", paths=[str(signal_bam)])],
                                        dict(chrom="chr1", start=100, end=401), {}, None)
    assert temporary[0].exists()
    result.refine([])
    assert result["input_files"][0]["path"] == str(signal_bam)
    assert result["signal_filters"]["hideBackground"]
    del result
    gc.collect()
    assert not temporary[0].exists()


def test_signal_source_replacement_invalidates_handle_counts_and_span_cache(signal_bam, tmp_path):
    from services.bam_handles import get_bam_handle
    state = state_for(signal_bam)
    with signal_filters_for_request({"hideBackground": True}):
        before = payload(state)
        identity = state.get_dataset("signal").to_dict()["source_identity"]
        old = get_bam_handle(str(signal_bam))
        with pysam.AlignmentFile(signal_bam) as source:
            rows = list(source.fetch(until_eof=True))
            header = source.header
        replacement = tmp_path / "replacement.bam"
        with pysam.AlignmentFile(replacement, "wb", header=header) as out:
            for read in rows:
                if read.has_tag("bg") and read.get_tag("bg") == 1:
                    read.set_tag("bg", 0, value_type="i")
                    read.set_tag("me", json.dumps(detail(0)))
                out.write(read)
        pysam.index(str(replacement))
        os.replace(replacement, signal_bam)
        os.replace(str(replacement) + ".bai", str(signal_bam) + ".bai")
        after = payload(state)
        assert old.closed
        assert state.get_dataset("signal").to_dict()["source_identity"] != identity
        assert len(after["reads"]) == len(before["reads"]) + 2
        assert after["signal_counts"]["hidden"] == 0


def test_signal_correspondence_counts_each_member_before_pooling(signal_bam):
    from services.correspondence_scanning import CorrespondenceScanRequest, run
    from services.correspondence_clustering import RegionViewport, FrameBlock
    state = state_for(signal_bam)
    state.datasets["other"] = Dataset("other", str(signal_bam), "other", data_type="bam")
    state.dataset_order.append("other")
    views = [RegionViewport(dataset_id=ds, result_key=ds, chrom="chr1", start=100, end=401,
              blocks=[FrameBlock(frame=(0, 301), genomic=(100, 401))]) for ds in state.dataset_order]
    request = CorrespondenceScanRequest(length=301, viewports=views, min_reads=1)
    original = run(state, request)
    with signal_filters_for_request({"hideBackground": True}):
        filtered = run(state, request)
    for ds in state.dataset_order:
        assert filtered["members"][ds]["n_reads"] == original["members"][ds]["n_reads"] - 2
    assert filtered["n_reads"] == original["n_reads"] - 4
    assert run(state, request) == original


def test_signal_middleware_isolates_concurrent_requests():
    import asyncio
    from urllib.parse import urlencode
    from services.signal_evidence import SignalFilterMiddleware, active_signal_filters
    seen = {}
    async def app(scope, receive, send):
        before = active_signal_filters()
        await asyncio.sleep(0)
        seen[scope["path"]] = active_signal_filters()
        assert seen[scope["path"]] == before
    middleware = SignalFilterMiddleware(app)
    async def run():
        async def call(path, filters):
            await middleware(dict(type="http", path=path,
                query_string=urlencode(dict(signal_filters=filters)).encode()), None, None)
        await asyncio.gather(call("filtered", '{"hideBackground":true}'), call("plain", '{}'), call("malformed", '{'))
    asyncio.run(run())
    assert seen["filtered"]["hideBackground"]
    assert not any(seen["plain"].values()) and not any(seen["malformed"].values())
    assert not any(active_signal_filters().values())


def test_signal_identical_names_do_not_share_evidence(signal_bam, tmp_path):
    from services.compact_read_loader import build_compact_reads_from_bam
    with pysam.AlignmentFile(signal_bam) as source:
        rows = list(source.fetch(until_eof=True))
        header = source.header
    # A second primary alignment shares the name but has another RG and no score.
    rows[-1].flag = 0
    path = tmp_path / "same-name.bam"
    with pysam.AlignmentFile(path, "wb", header=header) as target:
        for row in rows:
            target.write(row)
    pysam.index(str(path))
    args = (str(path), "chr1", 100, 401)
    options = dict(spanning_only=False, hide_terminal_gaps=False, terminal_gap_threshold=0)
    original = build_compact_reads_from_bam(*args, **options)
    assert [r["signal"]["status"] for r in original if r["id"] == "read0"] == ["background", "unscored"]
    with signal_filters_for_request({"hideBackground": True}):
        filtered = build_compact_reads_from_bam(*args, **options)
    assert [r["signal"]["status"] for r in filtered if r["id"] == "read0"] == ["unscored"]


def test_signal_real_tagged_and_older_inputs(tmp_path):
    folder = os.environ.get("FIBERBROWSER_SIGNAL_DATA")
    if not folder:
        pytest.skip("Set FIBERBROWSER_SIGNAL_DATA to scratch symlinks of the signal fixtures")
    root = Path(folder)
    for path in sorted(root.glob("*.fiberhmm.dddb.bam")):
        state = state_for(path)
        from services.read_endpoint import compact_reads_payload_for_request
        def view():
            return compact_reads_payload_for_request(state, dataset_id="signal", chrom="chr2L", start=6351950,
                end=6363000, max_reads=0, min_footprints=0, hide_terminal_gaps=False, terminal_gap_threshold=0,
                include_cigar=True, include_layers=True)
        original = view()
        assert original["reads"], path.name
        with signal_filters_for_request({"requireDetectable": True, "requireStructure": True}):
            strict = view()
        assert strict["reads"] == [r for r in original["reads"] if r.get("signal", {}).get("status") == "detectable"
                                    and r["signal"]["structure"]["status"] == "supported"]
        with signal_filters_for_request({"hideBackground": True}):
            filtered = view()
            assert filtered["reads"] == [r for r in original["reads"] if r.get("signal", {}).get("status") != "background"]
            with pysam.AlignmentFile(path) as bam:
                raw = [r for r in bam.fetch("chr2L", 6351950, 6363000)
                       if not (r.is_unmapped or r.is_secondary or r.is_supplementary or r.is_duplicate)]
            assert filtered["signal_counts"]["kept"] == sum(record_signal(r)["status"] != "background" for r in raw)
            assert filtered["signal_counts"]["hidden"] == sum(record_signal(r)["status"] == "background" for r in raw)
            if path.name == "1x_brain.fiberhmm.dddb.bam":
                from services.read_bam_subset import write_read_subset_bam
                names = {r["id"] for r in original["reads"]}
                destination = tmp_path / "real-subset.bam"
                write_read_subset_bam(state, "signal", "chr2L", 6351950, 6363000, list(names), str(destination))
                with pysam.AlignmentFile(path) as source:
                    expected = [r.to_string() for r in source.fetch("chr2L", 6351950, 6363000)
                                if r.query_name in names and record_signal(r)["status"] != "background"]
                with pysam.AlignmentFile(destination) as output:
                    actual = [r.to_string() for r in output.fetch(until_eof=True)]
                assert sorted(actual) == sorted(expected)
        assert view()["reads"] == original["reads"]
    examples = json.loads((root / "examples.json").read_text())
    assert {record["bg"] for record in examples} == {1, 0, -1, -2}
    for record in examples:
        with pysam.AlignmentFile(root / Path(record["bam"]).name) as bam:
            matches = [r for r in bam.fetch(record["reference"], record["start"], record["start"] + 1)
                       if r.query_name == record["read_name"] and r.get_tag("RG") == record["read_group"]
                       and r.flag == record["flag"] and r.cigarstring == record["cigar"]]
        assert any(record_signal(r)["status"] == STATUS_CODES[record["bg"]] for r in matches)
    from services.compact_read_loader import build_compact_reads_from_bam
    args = (str(root / "older.bam"), "chr2L", 6351950, 6363000)
    options = dict(spanning_only=False, hide_terminal_gaps=False, terminal_gap_threshold=0)
    before = build_compact_reads_from_bam(*args, **options)
    with signal_filters_for_request({"hideBackground": True}):
        after = build_compact_reads_from_bam(*args, **options)
    assert before and after == before
    assert all(r.get("signal", {}).get("status", "unknown") == "unknown" for r in after)


def test_signal_variant_scans_and_allele_cache_keep_the_panel_cohort(signal_bam):
    from services.variants_endpoint import snps_payload, svs_payload, alleles_payload
    state = state_for(signal_bam)
    body = dict(dataset_id="signal", chrom="chr1", start=100, end=401, min_mapq=0, min_bq=0)
    original = snps_payload(state, body)
    assert original["n_reads"] == 7
    with signal_filters_for_request({"hideBackground": True}):
        filtered = snps_payload(state, body)
        assert filtered["n_reads"] == 5
        assert filtered["scan_key"] != original["scan_key"]
        assert snps_payload(state, body)["cached"] is True
        assert svs_payload(state, body)["n_reads"] == 5
        split = {**body, "read_ids": ["read0", "read1", "read6"], "source": "hp"}
        assert snps_payload(state, split)["n_reads"] == 1
        assert set(alleles_payload(state, split)["assignments"]) <= {"read1"}
    assert snps_payload(state, body)["n_reads"] == 7
    assert svs_payload(state, body)["n_reads"] == 7


def test_signal_coaccessibility_matrix_cache_matches_filtered_reads(signal_bam):
    from services.coaccessibility_endpoint import _coacc_scope, get_coacc_metadata_payload
    state = state_for(signal_bam)
    def metadata():
        scope = _coacc_scope(state, chrom="chr1", start=100, end=401, bin_size=50, dataset_ids="signal")
        return get_coacc_metadata_payload(state, scope, "raw", 0)
    assert metadata()["n_reads"] == 7
    with signal_filters_for_request({"hideBackground": True}):
        assert metadata()["n_reads"] == 5
        assert metadata()["n_reads"] == 5
    assert metadata()["n_reads"] == 7


def test_signal_sv_split_and_insertion_caches_filter_before_carrier_sampling(signal_bam, tmp_path):
    from services.sv_endpoint import scan_view
    from services.insertion_lens import insertion_clusters_payload, insertion_lens_payload
    path = tmp_path / "insertion.bam"
    with pysam.AlignmentFile(signal_bam) as source, pysam.AlignmentFile(path, "wb", header=source.header) as out:
        for read in source.fetch(until_eof=True):
            read.cigarstring = "100M30I170M"
            out.write(read)
    pysam.index(str(path))
    state = state_for(path)
    def split():
        return scan_view(state, "signal", "chr1", 100, 401, 20)
    def clusters():
        return insertion_clusters_payload(state, chrom="chr1", start=100, end=401,
                                          dataset_id="signal", min_len=20)["clusters"]
    def lens():
        return insertion_lens_payload(state, chrom="chr1", pos=200, ref=200, length=30, len_min=20,
                                      dataset_id="signal", flank=50, max_carriers=2, consensus=False)
    assert len(split()) == 9  # raw primary + supplementary records; molecule counts below remain deduplicated
    assert clusters()[0]["carriers"] == 7
    assert lens()["cluster"]["carriers"] == 7
    with signal_filters_for_request({"hideBackground": True}):
        assert len(split()) == 6
        assert clusters()[0]["carriers"] == 5
        filtered = lens()
        assert filtered["cluster"]["carriers"] == 5
        assert len(filtered["carriers"]) == 2
        assert all(r["id"] not in {"read0", "read6"} for r in filtered["carriers"])
        assert lens() == filtered
    assert len(split()) == 9
    assert clusters()[0]["carriers"] == 7
    assert lens()["cluster"]["carriers"] == 7


@pytest.mark.parametrize('filters', [
    {'hideBackground': True}, {'excludeUnscored': True},
    {'requireDetectable': True}, {'requireStructure': True},
])
def test_decode_processes_preserve_request_signal_filters(signal_bam, filters):
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.parallel_reads import parallel_bam_reads
    options = dict(spanning_only=False, hide_terminal_gaps=False,
                   include_duplicates=True, include_layers=True, include_methylation=True)
    with signal_filters_for_request(filters):
        expected = build_compact_reads_from_bam(str(signal_bam), 'chr1', 100, 401, **options)
        actual = parallel_bam_reads(str(signal_bam), 'chr1', 100, 401, options, 2)
    assert actual == expected
    assert actual and all(signal_keeps(r.get('signal'), filters) for r in actual)


def test_pooled_workers_return_complete_signal_windows_for_navigation(signal_bam, monkeypatch):
    from services.parallel_reads import parallel_bam_files
    from services import signal_windows, bam_handles
    from services.signal_counts import signal_counts
    state = state_for(signal_bam)
    expected = {}
    for duplicate in (False, True):
        for spanning in (False, True):
            for hide in (False, True):
                with signal_filters_for_request({'hideBackground': hide}):
                    expected[duplicate, spanning, hide] = signal_counts(state, 'signal', 'chr1', 130, 390,
                        include_duplicates=duplicate, spanning=spanning)
    state._signal_counts_cache.clear()
    signal_windows._windows.clear()
    signal_windows._sources.clear()
    with signal_filters_for_request({'hideBackground': True}):
        parallel_bam_files([str(signal_bam)] * 2, 'chr1', 100, 401,
            [dict(spanning_only=False, min_footprints=5)] * 2, 2)
    assert signal_windows.find_signal_window(str(signal_bam), 'chr1', 130, 390) is not None
    monkeypatch.setattr(bam_handles, 'get_bam_handle', lambda *a: pytest.fail('signal counts refetched BAM'))
    for (duplicate, spanning, hide), counts in expected.items():
        with signal_filters_for_request({'hideBackground': hide}):
            assert signal_counts(state, 'signal', 'chr1', 130, 390,
                                 include_duplicates=duplicate, spanning=spanning) == counts


@pytest.mark.parametrize('mode', ['low', 'standard', 'high'])
@pytest.mark.parametrize('sort_by,layer,rule', [
    ('length', None, None), ('occupancy', None, None), ('fp_count', 'nuc', None),
    ('fp_rate', None, None), ('accessibility', None, None),
    ('rule', 'all_fp', {'size_min': 20, 'size_max': 100}),
])
def test_interval_sort_preserves_order_with_fast_mismatch_decode(signal_bam, monkeypatch, mode, sort_by, layer, rule):
    from services.filtering_endpoint import sort_reads_for_request
    from services.performance import apply_mode, release_caches
    from models.requests import SortReadsRequest
    state = state_for(signal_bam)
    state.add_dataset('copy', str(signal_bam), 'Copy')
    apply_mode(state, mode)
    req = SortReadsRequest(dataset_ids=['signal', 'copy'], sort_by=sort_by, layer=layer, rule=rule,
                           linked=True, cluster_assignments={ds: {f'read{i}': i % 2 for i in range(8)}
                                                             for ds in ('signal', 'copy')})
    try:
        with signal_filters_for_request({'hideBackground': True}):
            with monkeypatch.context() as patch:
                patch.setattr('services.bam_tags._daf_mismatches_from_md', lambda *args: None)
                expected = sort_reads_for_request(state, req, chrom='chr1', start=100, end=401)
            release_caches(state)
            actual = sort_reads_for_request(state, req, chrom='chr1', start=100, end=401)
            assert actual == expected
            assert actual['results']['signal']['read_sort_order']
    finally:
        apply_mode(state, 'standard')


def test_low_correspondence_scan_caps_explicit_scope_on_warm_and_cold_paths(signal_bam):
    from services.analysis_query import AnalysisReadQuery
    from services.clustering_endpoint import _compute_scan_counts_from_broad_cache
    from services.correspondence_scanning import CorrespondenceScanRequest, run
    from services.correspondence_clustering import RegionViewport, FrameBlock
    from services.performance import apply_mode, release_caches
    state = state_for(signal_bam)
    apply_mode(state, 'low')
    state.max_working_reads = 2
    ids = [f'read{i}' for i in range(8)]
    query = AnalysisReadQuery.from_request(state, dataset_id='signal', chrom='chr1', start=100, end=401,
                                           read_ids=ids, include_methylation=False)
    try:
        # A display load can retain a broad cohort larger than the analysis cap.
        state.build_working_set('signal', 'chr1', 100, 401, include_methylation=False)
        assert state._broad_cache
        assert _compute_scan_counts_from_broad_cache(state=state, query=query, dataset_id='signal',
                   signal_source='accessibility', region_width=301) is None
        viewport = RegionViewport(dataset_id='signal', result_key='a', chrom='chr1', start=100, end=401,
                                   read_ids=ids, blocks=[FrameBlock(frame=(0, 301), genomic=(100, 401))])
        req = CorrespondenceScanRequest(length=301, viewports=[viewport,
            viewport.model_copy(update={'result_key': 'b'})], min_reads=1)
        warm = run(state, req)
        release_caches(state)
        cold = run(state, req)
        assert warm['n_reads'] == cold['n_reads'] <= 4
        assert all(member['n_reads'] <= 2 for member in warm['members'].values())
        assert warm['members'] == cold['members']
        assert warm['profiles'] == cold['profiles']
        apply_mode(state, 'standard')
        assert run(state, req)['n_reads'] > warm['n_reads']
    finally:
        apply_mode(state, 'standard')
