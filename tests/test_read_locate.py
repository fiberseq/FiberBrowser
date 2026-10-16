"""Finding reads by name (fb-r4-clicks): a read name pasted into a locus box.

The search widens step by step (the view, its chromosome, every other contig),
always ends (a budget), reports names it could not find, and a split read's
segment id finds its read.
"""
from pathlib import Path
from types import SimpleNamespace

import pysam
import pytest

from conftest import auth_headers

DEMO_BAM = Path(__file__).resolve().parents[1] / "browser" / "data" / "demo" / "napa_ddda.bam"
needs_demo = pytest.mark.skipif(not DEMO_BAM.exists(), reason="NAPA demo BAM not present")
DEMO_READ = "m84046_240619_124816_s1/240062573/ccs"


@pytest.fixture(autouse=True)
def _fresh_cache():
    from services.read_locate import clear_cache
    clear_cache()
    yield
    clear_cache()


def _state(datasets: dict, chroms=()):
    """A minimal state: {dataset id: (data_type, [paths])}."""
    objs = {i: SimpleNamespace(id=i, data_type=kind, paths=[str(p) for p in paths], label=i)
            for i, (kind, paths) in datasets.items()}
    return SimpleNamespace(get_dataset=objs.get, dataset_order=list(objs), chroms=list(chroms))


def _bam(path: Path, reads, contigs=(("chr1", 100_000), ("chr2", 100_000), ("chrX", 100_000))) -> Path:
    """reads: [(name, contig, start, length, flag)]."""
    names = [c for c, _ in contigs]
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": c, "LN": n} for c, n in contigs]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for name, contig, start, length, flag in sorted(reads, key=lambda r: (names.index(r[1]), r[2])):
            seg = pysam.AlignedSegment(out.header)
            seg.query_name = name
            seg.flag = flag
            seg.reference_id = names.index(contig)
            seg.reference_start = start
            seg.cigartuples = [(0, length)]
            seg.query_sequence = "A" * length
            seg.mapping_quality = 60
            out.write(seg)
    pysam.index(str(path))
    return path


@needs_demo
def test_region_scope_finds_a_read_in_view_with_its_full_alignment():
    from services.read_locate import locate_reads
    state = _state({"demo": ("bam", [DEMO_BAM])})
    res = locate_reads(state, [DEMO_READ], scope="region", chrom="chr19", start=47_515_000, end=47_516_000)
    assert res["not_found"] == [] and res["complete"]
    hit = res["found"][0]
    assert hit["name"] == DEMO_READ and hit["read_id"] == DEMO_READ and hit["dataset_id"] == "demo"
    # The whole read, not the part in view.
    assert (hit["chrom"], hit["start"], hit["end"]) == ("chr19", 47_514_487, 47_518_985)
    assert hit["strand"] in ("+", "-")


@needs_demo
def test_region_scope_away_from_the_read_does_not_find_it_but_chrom_scope_does():
    from services.read_locate import locate_reads
    state = _state({"demo": ("bam", [DEMO_BAM])})
    miss = locate_reads(state, [DEMO_READ], scope="region", chrom="chr19", start=1_000, end=2_000)
    assert miss["found"] == [] and miss["not_found"] == [DEMO_READ] and miss["complete"]
    hit = locate_reads(state, [DEMO_READ], scope="chrom", chrom="19")  # an alias of the file's contig
    assert [f["name"] for f in hit["found"]] == [DEMO_READ]


def test_genome_scope_searches_the_other_contigs_and_reports_missing_names(tmp_path):
    from services.read_locate import locate_reads
    bam = _bam(tmp_path / "x.bam", [
        ("a/1/ccs", "chr1", 100, 500, 0),
        ("b/2/ccs", "chr2", 2_000, 800, 16),
        ("c/3/ccs", "chrX", 50_000, 300, 0),
    ])
    state = _state({"d": ("bam", [bam])})
    # The view's chromosome (chr1) is the previous scope's: genome skips it.
    res = locate_reads(state, ["b/2/ccs", "c/3/ccs", "nope/9/ccs"], scope="genome", chrom="chr1")
    found = {f["name"]: f for f in res["found"]}
    assert set(found) == {"b/2/ccs", "c/3/ccs"}
    assert (found["b/2/ccs"]["chrom"], found["b/2/ccs"]["start"], found["b/2/ccs"]["end"]) == ("chr2", 2_000, 2_800)
    assert found["b/2/ccs"]["strand"] == "-"
    assert res["not_found"] == ["nope/9/ccs"] and res["complete"]


def test_secondary_alignments_never_answer_and_a_primary_beats_a_supplementary(tmp_path):
    from services.read_locate import locate_reads
    bam = _bam(tmp_path / "x.bam", [
        ("r", "chr1", 100, 200, 0x800),   # supplementary first in the file
        ("r", "chr2", 500, 900, 0),       # the primary
        ("s", "chr1", 300, 100, 0x100),   # secondary only
    ])
    state = _state({"d": ("bam", [bam])})
    res = locate_reads(state, ["r", "s"], scope="genome")
    found = {f["name"]: f for f in res["found"]}
    assert (found["r"]["chrom"], found["r"]["start"], found["r"]["supplementary"]) == ("chr2", 500, False)
    assert "s" not in found and res["not_found"] == ["s"]


def test_a_split_reads_segment_id_finds_its_read(tmp_path):
    from services.read_locate import locate_reads
    bam = _bam(tmp_path / "x.bam", [("m1/7/ccs", "chr1", 100, 500, 0)])
    res = locate_reads(_state({"d": ("bam", [bam])}), ["m1/7/ccs_2"], scope="genome")
    assert res["found"][0]["name"] == "m1/7/ccs_2" and res["found"][0]["read_id"] == "m1/7/ccs"


def test_a_spent_budget_or_a_cancel_ends_the_search_incomplete(tmp_path):
    from services.read_locate import locate_reads
    bam = _bam(tmp_path / "x.bam", [(f"r{i}", "chr1", i * 10, 50, 0) for i in range(50)])
    state = _state({"d": ("bam", [bam])})
    res = locate_reads(state, ["r49"], scope="genome", budget_s=0)
    assert res["complete"] is False and res["not_found"] == ["r49"]
    res = locate_reads(state, ["r49"], scope="genome", cancelled=lambda: True)
    assert res["complete"] is False
    res = locate_reads(state, ["r49"], scope="genome", max_records=0)
    assert res["complete"] is False


def test_a_read_found_once_is_found_again_without_a_scan(tmp_path, monkeypatch):
    import services.read_locate as rl
    bam = _bam(tmp_path / "x.bam", [("q/1/ccs", "chr2", 4_000, 600, 0)])
    state = _state({"d": ("bam", [bam])})
    assert rl.locate_reads(state, ["q/1/ccs"], scope="genome")["found"]
    monkeypatch.setattr(rl, "_scan_bam", lambda *a, **k: pytest.fail("scanned again"))
    res = rl.locate_reads(state, ["q/1/ccs"], scope="region", chrom="chr1", start=0, end=10)
    assert res["found"][0]["start"] == 4_000


def test_names_are_trimmed_and_deduplicated():
    from services.read_locate import MAX_NAMES, normalize_names
    assert normalize_names([" @a/1/ccs ", "a/1/ccs", "", "b"]) == ["a/1/ccs", "b"]
    # Not capped here: a request answers the names over the limit as not searched (below).
    assert len(normalize_names(str(i) for i in range(MAX_NAMES + 10))) == MAX_NAMES + 10


def test_names_over_the_limit_are_answered_as_not_searched_never_dropped(tmp_path):
    """Codex 19: 2,001 names, the last one in the file: it was silently cut and reported missing."""
    from services.read_locate import MAX_NAMES, locate_reads
    bam = _bam(tmp_path / "x.bam", [("last/1/ccs", "chr1", 100, 500, 0)])
    names = [f"absent/{i}/ccs" for i in range(MAX_NAMES)] + ["last/1/ccs"]
    res = locate_reads(_state({"d": ("bam", [bam])}), names, scope="genome")
    assert res["not_searched"] == ["last/1/ccs"]
    assert "last/1/ccs" not in res["not_found"]
    assert res["complete"] is False and res["max_names"] == MAX_NAMES
    # Sent on its own (the client's next chunk), it is found.
    again = locate_reads(_state({"d": ("bam", [bam])}), res["not_searched"], scope="genome")
    assert [f["name"] for f in again["found"]] == ["last/1/ccs"] and again["complete"]


def test_an_unreadable_file_is_reported_not_answered_as_read_not_found(tmp_path):
    """Codex 20: a BAM whose index is gone: the fetch errors were swallowed and the search said complete."""
    from services.read_locate import locate_reads
    bam = _bam(tmp_path / "noindex.bam", [("r/1/ccs", "chr1", 100, 500, 0)])
    (tmp_path / "noindex.bam.bai").unlink()
    state = _state({"d": ("bam", [bam])})
    for scope, kw in (("region", dict(chrom="chr1", start=0, end=1_000)), ("chrom", dict(chrom="chr1")), ("genome", {})):
        res = locate_reads(state, ["r/1/ccs"], scope=scope, **kw)
        assert res["complete"] is False, scope
        assert res["errors"] and res["errors"][0]["dataset_id"] == "d" and res["errors"][0]["path"] == str(bam), scope
    # A file that is not there at all.
    gone = _state({"g": ("bam", [tmp_path / "gone.bam"])})
    res = locate_reads(gone, ["r/1/ccs"], scope="genome")
    assert res["complete"] is False and [e["dataset_id"] for e in res["errors"]] == ["g"]
    # A readable file has no errors.
    ok = _bam(tmp_path / "ok.bam", [("r/1/ccs", "chr1", 100, 500, 0)])
    res = locate_reads(_state({"d": ("bam", [ok])}), ["r/1/ccs"], scope="genome")
    assert res["errors"] == [] and res["complete"]


def test_a_file_replaced_at_the_same_path_is_searched_again(tmp_path):
    """Codex 21: the remembered answer was keyed by path and name only, so a re-aligned BAM answered old coordinates."""
    import os
    from services.read_locate import locate_reads
    path = tmp_path / "x.bam"
    _bam(path, [("q/1/ccs", "chr1", 4_000, 600, 0)])
    state = _state({"d": ("bam", [path])})
    assert locate_reads(state, ["q/1/ccs"], scope="genome")["found"][0]["start"] == 4_000
    # Re-aligned: the same read elsewhere, written to the same path (the old handle stays open in this thread).
    (tmp_path / "x.bam.bai").unlink()
    path.unlink()
    _bam(path, [("q/1/ccs", "chr2", 9_000, 600, 0)])
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    res = locate_reads(state, ["q/1/ccs"], scope="genome")
    assert (res["found"][0]["chrom"], res["found"][0]["start"]) == ("chr2", 9_000)


class _FakeBigBed:
    """pyBigWig's reader surface the search uses: chroms() and entries()."""

    def __init__(self, rows):
        self.rows = rows  # {contig: [(start, end, rest)]}

    def chroms(self):
        return {"chr1": 100_000, "chr2": 100_000}

    def entries(self, contig, lo, hi):
        return [r for r in self.rows.get(contig, []) if r[0] < hi and r[1] > lo]


def test_bigbed_rows_are_found_by_their_name(monkeypatch):
    import services.random_window as rw
    import services.read_locate as rl
    fake = _FakeBigBed({
        "chr1": [(100, 900, "f1\t0\t+")],
        # A FIRE decorator row: the fiber is its decorated item.
        "chr2": [(3_100, 3_200, "NUC\t0\t+\t3100\t3200\t0,0,0\t1\t100\t0\tchr2:3000-5000:f2")],
    })
    monkeypatch.setattr(rl, "get_bigbed_handle", lambda _p: fake)
    monkeypatch.setattr(rw, "get_bigbed_handle", lambda _p: fake)
    state = _state({"bb": ("bigbed", ["x.bb"])})
    res = rl.locate_reads(state, ["f2", "f9"], scope="genome")
    assert [(f["name"], f["chrom"], f["start"], f["end"]) for f in res["found"]] == [("f2", "chr2", 3_000, 5_000)]
    assert res["not_found"] == ["f9"]
    res = rl.locate_reads(state, ["f1"], scope="region", chrom="chr1", start=0, end=200)
    assert res["found"][0]["end"] == 900


@needs_demo
def test_locate_route_answers_through_the_server(standalone_app, tmp_path):
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        state.add_dataset("demo", str(DEMO_BAM), "demo")
        client = TestClient(standalone_app, headers=auth_headers())
        resp = client.post("/api/reads/locate", json={
            "names": f"{DEMO_READ}, missing/1/ccs", "scope": "chrom", "chrom": "chr19",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [f["name"] for f in body["found"]] == [DEMO_READ]
        assert body["not_found"] == ["missing/1/ccs"]
        bad = client.post("/api/reads/locate", json={"names": [DEMO_READ], "scope": "everywhere"})
        assert bad.status_code == 400
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


@needs_demo
@pytest.mark.parametrize("route", ["/api/reads/compact", "/api/reads/compact_all"])
@pytest.mark.parametrize("include_layers,include_methylation", [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize("mode,include_cigar", [("auto", False), ("low", False), ("low", True)])
def test_a_pinned_read_stays_in_the_display_sample(standalone_app, route, include_layers, include_methylation, mode,
                                                   include_cigar):
    """Going to a read by name: the view has 3,202 reads, the panel shows a few;
    the read must be among them (pin_ids), and nothing else changes. Low
    memory (4-core or 8 GiB machines, the Windows app on many laptops) decodes
    a sample of the view's reads: a pin outside the sample was dropped there, on the
    working-set path and on the direct path (include_cigar) alike."""
    import server as srv
    from starlette.testclient import TestClient
    from plugins import init_context
    from state import runtime_state
    from state.browser_state import BrowserState
    from state.runtime_state import set_browser_state

    previous, previous_runtime = srv.state, runtime_state._state
    state = BrowserState(None, None, None, None)
    srv.state = state
    set_browser_state(state)
    init_context(state)
    try:
        if mode != "auto":
            from services.performance import apply_mode
            apply_mode(state, mode)
        state.add_dataset("demo", str(DEMO_BAM), "demo")
        client = TestClient(standalone_app, headers=auth_headers())
        params = {"chrom": "chr19", "start": 47_514_000, "end": 47_519_500, "max_reads": 3,
                  "dataset_id": "demo", "include_layers": str(include_layers).lower(),
                  "include_methylation": str(include_methylation).lower(), "sample_seed": "s"}
        if include_cigar:
            params["include_cigar"] = "true"

        def ids(extra=None):
            resp = client.get(route, params={**params, **(extra or {})})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            data = body["datasets"]["demo"] if "datasets" in body else body
            return [r["id"] for r in data["reads"]], {k: data.get(k) for k in ("total", "total_overlapping", "total_spanning")}

        plain, counts = ids()
        bam = pysam.AlignmentFile(str(DEMO_BAM))
        others = []
        for read in bam.fetch("chr19", 47_514_000, 47_519_500):
            if read.query_name not in plain and not read.is_secondary and not read.is_supplementary:
                others.append(read.query_name)
            if len(others) >= 400:
                break
        target = others[-1]
        pinned, pinned_counts = ids({"pin_ids": target})
        assert target in pinned
        if mode == "low":
            # Low memory parses the pinned read into its sampled load rather than loading every
            # read: the pinned read is shown, and it counts in that load (one read more).
            assert len(pinned) <= len(plain) + 1
            assert all(pinned_counts[k] - counts[k] in (0, 1) for k in counts), (pinned_counts, counts)
        else:
            assert set(plain) <= set(pinned) and len(pinned) == len(plain) + 1
            assert pinned_counts == counts
        # A pin that is not in view changes nothing.
        assert ids({"pin_ids": "not/in/view"})[0] == plain
    finally:
        srv.state = previous
        set_browser_state(previous_runtime)
        init_context(previous)


def test_a_remembered_read_is_named_on_each_workspaces_own_chromosome(tmp_path, monkeypatch):
    """The cache is process-wide (public sessions, workspaces): it keeps the
    file's contig and maps it to the asking workspace's chromosome."""
    import services.read_locate as rl
    bam = _bam(tmp_path / "x.bam", [("p/1/ccs", "chr2", 100, 300, 0)])
    names = {"A": "map_A", "B": "map_B"}
    monkeypatch.setattr(rl, "_state_chrom", lambda state, contig, _ds: names[state.tag] if contig == "chr2" else contig)
    a = _state({"d": ("bam", [bam])}); a.tag = "A"
    b = _state({"d": ("bam", [bam])}); b.tag = "B"
    assert rl.locate_reads(a, ["p/1/ccs"], scope="genome")["found"][0]["chrom"] == "map_A"
    assert rl.locate_reads(b, ["p/1/ccs"], scope="region", chrom="chr9", start=0, end=1)["found"][0]["chrom"] == "map_B"


def test_bigbed_search_stops_inside_a_window_when_cancelled(monkeypatch):
    import services.random_window as rw
    import services.read_locate as rl
    rows = [(i * 10, i * 10 + 5, f"f{i}\t0\t+") for i in range(10_000)]
    fake = _FakeBigBed({"chr1": rows})
    monkeypatch.setattr(rl, "get_bigbed_handle", lambda _p: fake)
    monkeypatch.setattr(rw, "get_bigbed_handle", lambda _p: fake)
    seen = {"n": 0}
    real = rl._bigbed_entry_name

    def counting(rest):
        seen["n"] += 1
        return real(rest)
    monkeypatch.setattr(rl, "_bigbed_entry_name", counting)
    calls = {"n": 0}

    def cancelled():
        calls["n"] += 1
        return calls["n"] > 2  # past the first checks: the client went away
    res = rl.locate_reads(_state({"bb": ("bigbed", ["x.bb"])}), ["f9999"], scope="genome", cancelled=cancelled)
    assert res["complete"] is False and res["not_found"] == ["f9999"]
    assert seen["n"] < 10_000


def test_pins_never_change_a_metaprofile_sample():
    from services.read_endpoint import compact_metaprofile_for_reads
    from services.read_pins import pinned_reads
    reads = [{"id": f"r{i}", "intervals": [[0, 100, 100]]} for i in range(20)]
    plain = compact_metaprofile_for_reads(reads, region_width=100, requested_layers=[], profile_max_reads=3)
    with pinned_reads(["r19", "r7"]):
        pinned = compact_metaprofile_for_reads(reads, region_width=100, requested_layers=[], profile_max_reads=3)
    assert pinned[1] == plain[1] == 3
    assert pinned == plain


def test_a_linked_panels_sample_keeps_a_pinned_molecule():
    from services.linked_read_compact import sample_linked_reads
    from services.read_pins import pinned_reads
    reads = [{"id": f"m{i}"} for i in range(100)]
    regions = {"x_start": 0, "y_start": 0}
    plain = [r["id"] for r in sample_linked_reads(reads, 5, "s", "sess", regions)]
    missing = next(r["id"] for r in reads if r["id"] not in plain)
    with pinned_reads([missing]):
        kept = [r["id"] for r in sample_linked_reads(reads, 5, "s", "sess", regions)]
    assert kept == plain + [missing]


def test_a_file_that_breaks_while_it_is_read_is_reported_and_the_others_still_searched(tmp_path, monkeypatch):
    """Codex review: an error while iterating (a truncated BAM, a broken stream) aborted the whole lookup."""
    import services.read_locate as rl
    good = _bam(tmp_path / "good.bam", [("g/1/ccs", "chr2", 100, 500, 0)])
    bad = _bam(tmp_path / "bad.bam", [("b/1/ccs", "chr1", 100, 500, 0)])
    real = rl.get_bam_handle

    class Broken:
        def __init__(self, handle):
            self._h = handle

        def __getattr__(self, name):
            return getattr(self._h, name)

        def fetch(self, *a, **k):
            def gen():
                raise OSError("truncated file")
                yield  # pragma: no cover
            return gen()

    monkeypatch.setattr(rl, "get_bam_handle", lambda p: Broken(real(p)) if p == str(bad) else real(p))
    # The scan opens a handle of its own (decompression threads); make it the broken one for bad.bam.
    monkeypatch.setattr(rl, "_open_scan_handle", lambda p, state=None: (Broken(real(p)), False) if p == str(bad) else (real(p), False))
    state = _state({"bad": ("bam", [bad]), "good": ("bam", [good])})
    res = rl.locate_reads(state, ["g/1/ccs"], scope="genome")
    assert [f["name"] for f in res["found"]] == ["g/1/ccs"]
    assert res["complete"] is False and [e["dataset_id"] for e in res["errors"]] == ["bad"]


def test_remote_sources_are_never_answered_from_memory(monkeypatch):
    """Codex review: a URL has no file version, so a replaced remote file was answered from the cache."""
    import services.read_locate as rl
    rl._cache_put("https://example.org/x.bam", None, "r", {"read_id": "r", "contig": "chr1", "start": 1, "end": 2, "strand": "+"})
    assert rl._cache_get("https://example.org/x.bam", None, "r") is None


def test_name_scan_releases_shared_iterator_after_early_match(monkeypatch):
    from types import SimpleNamespace
    import services.read_locate as locate
    closed = []
    read = SimpleNamespace(query_name='wanted', is_unmapped=False, is_secondary=False, is_supplementary=False)
    def records():
        try:
            yield read
            yield read
        finally:
            closed.append(1)
    iterator = records()  # Retained outside the scan: collection cannot release it.
    search = SimpleNamespace(wanted={'wanted': 'wanted'}, remaining={'wanted'}, scanned=0,
        done=lambda: not search.remaining, out_of_budget=lambda: False,
        record=lambda *args, **kwargs: search.remaining.clear())
    monkeypatch.setattr(locate, '_bam_hit', lambda *args: {})
    locate._scan_bam_records(search, None, None, 'reads.bam',
                            SimpleNamespace(fetch=lambda *args: iterator), [('chr1', 0, 100)])
    assert closed == [1]
