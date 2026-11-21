"""Min footprints' uncalled-read rule on every path that reads BAM records itself (FiberBrowser 3.1 cleanup).

The read track, coverage, read stats and the analysis working sets follow the rule since 3.0.6
(tests/test_hide_uncalled.py). These are the other paths: the dense loader (/api/reads/info, image, meta,
meta_all), random/top windows, the BAM-path Variants (SNP scan, allele reads, SVs, SV split, linkage), the
insertion lens and insertion clusters, DAF-C and linked reads, graph-mode reads and analyses, Differences,
region detection and autozoom. Each hides reads without footprint calls by default and shows them with
``hide_uncalled=false`` ("All reads, including uncalled"). QC-fail reads are exempt (shown only by choice);
a supplementary follows its primary.

One small real BAM: called reads (ns/nl arrays or an MA nuc group), uncalled reads (no tags, a scalar ns:i)
and empty-group reads (MA groups without intervals), each carrying what the paths report: a SNP, a deletion,
an insertion; plus a QC-fail uncalled read and an uncalled primary with a supplementary piece.
"""
from array import array
import random

import pysam
import pytest

from models.domain import Dataset
from services.bam_tags import read_has_footprint_calls, record_passes_call_rule
from services.signal_evidence import hide_uncalled_for_request
from state.browser_state import BrowserState

CHROM = "chrU"
LENGTH = 12_000
SNP = 1300            # every read at 1000..1600 carries the alt base here
DEL_AT = 3250         # 100 bp deletions on the reads at 3000
INS_AT = 5250         # 60 bp insertions on the reads at 5000
MA_CALL = "MA:600;nuc+Q:11-147,301-147"

_rng = random.Random(7)
REF = "".join(_rng.choice("ACGT") for _ in range(LENGTH))
ALT = {"A": "C", "C": "G", "G": "T", "T": "A"}[REF[SNP]]

CALL_TAGS = {
    "called_ns": [("ns", array("I", [10, 200])), ("nl", array("I", [140, 140]))],
    "called_ma": [("MA", "600;nuc+Q:11-147,301-147"), ("AQ", array("B", [200, 200]))],
    "uncalled_none": [],
    "uncalled_scalar_ns": [("ns", 40_000)],
    "empty_groups": [("MA", "600;nuc+Q:;msp+:")],
}
CALLED_KINDS = ("called_ns", "called_ma")
UNCALLED_KINDS = ("uncalled_none", "uncalled_scalar_ns", "empty_groups")
PER_KIND = 2   # reads of each kind at each site


def _names(site):
    return {f"{site}_{kind}_{i}" for kind in CALL_TAGS for i in range(PER_KIND)}


def _called(site):
    return {f"{site}_{kind}_{i}" for kind in CALLED_KINDS for i in range(PER_KIND)}


def _write_bam(path):
    header = pysam.AlignmentHeader.from_dict({"HD": {"VN": "1.6", "SO": "coordinate"},
                                              "SQ": [{"SN": CHROM, "LN": LENGTH}]})
    records = []

    def add(name, start, cigar, seq, tags, flag=0):
        read = pysam.AlignedSegment(header)
        read.query_name, read.reference_id, read.reference_start = name, 0, start
        read.flag = flag
        read.mapping_quality = 60
        read.cigarstring = cigar
        read.query_sequence = seq
        read.query_qualities = pysam.qualitystring_to_array("I" * len(seq))
        for tag, value in tags:
            read.set_tag(tag, value)
        records.append(read)

    for kind, tags in CALL_TAGS.items():
        for i in range(PER_KIND):
            # SNP site: 600M with the alt base at SNP.
            seq = list(REF[1000:1600])
            if i % 2 == 0:
                seq[SNP - 1000] = ALT   # one read of each kind alt, one ref: a SNP whatever is shown
            add(f"snp_{kind}_{i}", 1000, "600M", "".join(seq), tags, flag=16 if i % 2 else 0)
            # Deletion site: 250M100D250M.
            add(f"del_{kind}_{i}", 3000, "250M100D250M", REF[3000:3250] + REF[3350:3600], tags)
            # Insertion site: 250M60I250M.
            add(f"ins_{kind}_{i}", 5000, "250M60I250M", REF[5000:5250] + "G" * 60 + REF[5250:5500], tags)
    # A QC-fail read without calls (FiberHMM chimeras carry none): exempt from the rule when QC-fail reads are shown.
    seq = list(REF[1000:1600])
    seq[SNP - 1000] = ALT
    add("snp_qcfail_uncalled", 1000, "600M", "".join(seq), [], flag=0x200)
    # Three uncalled reads on their own (no called read near them).
    for i in range(3):
        add(f"lonely_uncalled_{i}", 7000 + 10 * i, "600M", REF[7000 + 10 * i:7600 + 10 * i], [])
    # An uncalled primary with a supplementary piece far away: the molecule goes (or stays) whole.
    add("sa_uncalled", 3000, "250M100D250M", REF[3000:3250] + REF[3350:3600],
        [("SA", f"{CHROM},9001,+,500S100M,60,0;")])
    add("sa_uncalled", 9000, "500H100M", REF[9000:9100], [("SA", f"{CHROM},3001,+,250M100D250M,60,0;")], flag=2048)
    records.sort(key=lambda r: r.reference_start)
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for read in records:
            out.write(read)
    pysam.index(str(path))
    return str(path)


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("uncalled_paths")
    bam = _write_bam(tmp / "mixed.bam")
    fasta = tmp / "ref.fa"
    fasta.write_text(f">{CHROM}\n" + "\n".join(REF[i:i + 60] for i in range(0, LENGTH, 60)) + "\n")
    pysam.faidx(str(fasta))
    return {"bam": bam, "fasta": str(fasta)}


def _state(files, fasta=False):
    state = BrowserState(None)
    state.drop_short_terminal_footprints = False
    dataset = Dataset("ds", [files["bam"]], "ds", data_type="bam")
    dataset.available_layers = {"footprint": True, "nuc": True, "msp": True}
    state.datasets["ds"] = dataset
    state.dataset_order.append("ds")
    if fasta:
        state.fasta = pysam.FastaFile(files["fasta"])
        state.fasta_path = files["fasta"]
    return state


def _both(fn):
    """fn() under the default request and under "All reads, including uncalled"."""
    default = fn()
    with hide_uncalled_for_request("false"):
        shown = fn()
    return default, shown


def test_fixture_reads_are_what_they_say(files):
    with pysam.AlignmentFile(files["bam"]) as bam:
        primaries = [r for r in bam.fetch(CHROM) if not r.is_supplementary]
    called = {r.query_name for r in primaries if read_has_footprint_calls(r)}
    assert called == _called("snp") | _called("del") | _called("ins")


def test_record_rule_matrix(files):
    with pysam.AlignmentFile(files["bam"]) as bam:
        by = {}
        for r in bam.fetch(CHROM):
            by.setdefault((r.query_name, r.is_supplementary), r)
    uncalled = by[("snp_uncalled_none_0", False)]
    assert not record_passes_call_rule(uncalled)                     # default: the request's rule (hide)
    assert record_passes_call_rule(uncalled, False)
    assert record_passes_call_rule(by[("snp_called_ma_0", False)], True)
    assert not record_passes_call_rule(by[("snp_empty_groups_0", False)], True)
    assert record_passes_call_rule(by[("snp_qcfail_uncalled", False)], True)   # QC-fail: exempt
    assert record_passes_call_rule(by[("sa_uncalled", True)], True)            # supplementary: its primary decides
    with hide_uncalled_for_request("false"):
        assert record_passes_call_rule(uncalled)


# ── dense loader: /api/reads/info, image, meta, meta_all ──────────────────────

def test_dense_loader_reads_follow_the_rule(files):
    from services.read_auxiliary_endpoint import get_reads_info_payload, get_meta_all_payload, get_meta_payload
    state = _state(files)
    view = dict(chrom=CHROM, start=900, end=1700)
    default, shown = _both(lambda: get_reads_info_payload(state, dataset_id="ds", **view)["count"])
    assert (default, shown) == (len(_called("snp")), len(_names("snp")))
    # The meta profile cache keeps one entry per setting (default, shown, default again).
    sizes = []
    for value in (None, "false", None):
        with hide_uncalled_for_request(value):
            payload = get_meta_payload(state, dataset_id="ds", **view)
            sizes.append(sum(payload["nucleosome_profile"] or [0]))
    assert sizes[0] == sizes[2]
    assert get_meta_all_payload(state, spanning=False, **view) is not None
    with hide_uncalled_for_request("false"):
        assert get_reads_info_payload(state, dataset_id="ds", **view)["count"] == len(_names("snp"))
    assert get_reads_info_payload(state, dataset_id="ds", **view)["count"] == len(_called("snp"))


# ── random and top windows ────────────────────────────────────────────────────

def test_top_and_random_windows_count_the_shown_reads(files):
    from services import random_window
    state = _state(files)
    state.chrom_sizes = {CHROM: LENGTH}

    def depth():
        out = random_window.top_covered_windows(state, span=400, dataset_id="ds", n=1, samples=40, seed=3)
        return out["windows"][0]["depth"] if out.get("windows") else 0
    # Distinct searches per setting (cache key), each counting only the reads the panel shows.
    default, shown = _both(depth)
    # The deepest window: 4 called reads either site by default; with all reads the deletion site's 10 reads and
    # the uncalled primary of the split molecule (the QC-fail read stays hidden at the SNP site).
    assert default == len(_called("snp")) and shown == len(_names("del")) + 1
    found = random_window.random_covered_window(state, span=400, dataset_id="ds", seed=1,
                                                min_coverage=len(_names("snp")))
    assert not found["success"]
    with hide_uncalled_for_request("false"):
        found = random_window.random_covered_window(state, span=400, dataset_id="ds", seed=1,
                                                    min_coverage=len(_names("snp")), max_attempts=200)
    assert found["success"]


def test_window_fitting_ignores_uncalled_reads(files):
    from services import random_window
    from services.random_window import _Contig, _Scope
    ds = _state(files).datasets["ds"]
    scope = _Scope(contigs={"ds": [_Contig(path=files["bam"], contig=CHROM, weight=1.0, size=LENGTH)]},
                   with_data=1, data_contigs=1)
    # A window holding only uncalled reads fits to nothing while the rule is on (no reads to fit).
    assert random_window._fit_window_to_reads([ds], scope, CHROM, 6000, 9000, 20_000, True) is None
    assert random_window._fit_window_to_reads([ds], scope, CHROM, 6000, 9000, 20_000, False) is not None


# ── Variants: SNP scan, allele reads, SVs, SV split, linkage ─────────────────

def test_snp_scan_and_allele_reads_follow_the_rule(files):
    from services import variants_endpoint as ve
    state = _state(files, fasta=True)
    body = dict(dataset_id="ds", chrom=CHROM, start=900, end=1700, min_depth=1, mode="basecall")

    def scan():
        out = ve.snps_payload(state, dict(body))
        snp = next(s for s in out["snps"] if s["pos"] == SNP)
        return snp["depth"]
    default, shown = _both(scan)
    assert default == len(_called("snp")) and shown == len(_names("snp"))
    # In the body too ("All reads" as min_footprints -1 or hide_uncalled false), and cached per setting.
    assert scan() == len(_called("snp"))
    out = ve.snps_payload(state, dict(body, min_footprints=-1))
    assert next(s for s in out["snps"] if s["pos"] == SNP)["depth"] == len(_names("snp"))

    def groups(**extra):
        snp_id = next(s["id"] for s in ve.snps_payload(state, dict(body, **extra))["snps"] if s["pos"] == SNP)
        grouped = ve.alleles_payload(state, dict(body, snps=[snp_id], **extra))
        return set(grouped["assignments"])
    assert groups() == _called("snp")
    assert groups(hide_uncalled=False) == _names("snp")


def test_sv_list_split_and_linkage_follow_the_rule(files):
    from services import variants_endpoint as ve
    from services.sv_endpoint import sv_split_payload
    state = _state(files, fasta=True)
    body = dict(dataset_id="ds", chrom=CHROM, start=2900, end=3700, min_len=50)
    default, shown = _both(lambda: ve.svs_payload(state, dict(body)))
    sv_default = next(c for c in default["clusters"] if c["t"] == "D")
    sv_shown = next(c for c in shown["clusters"] if c["t"] == "D")
    assert default["n_reads"] == len(_called("del"))
    assert shown["n_reads"] == len(_names("del")) + 1          # + the uncalled primary with an SA piece
    assert sv_shown["support"] > sv_default["support"]

    def split(**kw):
        out = sv_split_payload(state, dataset_id="ds", chrom=CHROM, start=2900, end=3700, t="D",
                               ref=sv_default["ref"], length=sv_default["len"], **kw)
        return {name for name, allele in out["assignments"].items()}
    assert split() == _called("del")
    assert split(hide_uncalled=False) == _names("del") | {"sa_uncalled"}
    with hide_uncalled_for_request("false"):
        assert split() == _names("del") | {"sa_uncalled"}
    linkage = ve.sv_linkage_payload(state, dict(body, t="D", ref=sv_default["ref"], len=sv_default["len"],
                                                 min_depth=1, mode="basecall"))
    assert linkage["counts"]["carriers"] + linkage["counts"]["reference"] + linkage["counts"]["not_informative"] \
        == len(_called("del"))


def test_sv_split_route_takes_the_body_setting(files, monkeypatch):
    from services.sv_evidence import call_rule_keeps, select_cohort
    entries = [dict(id="a", uncalled=True, qcfail=False, _key=(None,)),
               dict(id="a", supplementary=True, _key=(None,)),
               dict(id="b", uncalled=False, _key=(None,)),
               dict(id="q", uncalled=True, qcfail=True, _key=(None,))]
    assert [c["id"] for c in select_cohort(entries, hide_uncalled=True)] == ["b", "q"]
    assert [c["id"] for c in select_cohort(entries, include_qcfail=False, hide_uncalled=True)] == ["b"]
    assert len(select_cohort(entries, hide_uncalled=False)) == 4
    assert call_rule_keeps({"id": "layer-row"}, True)   # FiberHMM var/sv layer rows carry no flag: called


# ── insertion clusters, lens, alt allele ─────────────────────────────────────

def test_insertion_clusters_and_lens_follow_the_rule(files):
    from services.insertion_lens import classify_site, insertion_clusters_payload
    state = _state(files)

    def clusters():
        out = insertion_clusters_payload(state, chrom=CHROM, start=4900, end=5800, dataset_id="ds", min_len=30)
        return max((c.get("n_carriers", c.get("support", 0)) for c in out["clusters"]), default=0)
    default, shown = _both(clusters)
    assert default == len(_called("ins")) and shown == len(_names("ins"))

    def carriers():
        site = classify_site([files["bam"]], CHROM, pos=INS_AT, len_min=30)
        return {plan[1].query_name for plan in site["carriers"]}
    default, shown = _both(carriers)
    assert default == _called("ins") and shown == _names("ins")


# ── DAF-C selections and linked reads ────────────────────────────────────────

def test_dafc_and_linked_reads_follow_the_rule(files):
    from services.dafc_reads import query_bam_for_dafc
    default, shown = _both(lambda: {r["name"] for r in query_bam_for_dafc(files["bam"], CHROM, 900, 1700)})
    # DAF-C hides QC-fail reads unless they are shown (3.1.0; tests/test_read_policy_paths.py).
    assert default == _called("snp")
    assert shown == _names("snp")
    assert {r["name"] for r in query_bam_for_dafc(files["bam"], CHROM, 900, 1700, hide_uncalled=False)} == shown


# ── graph mode ───────────────────────────────────────────────────────────────

def test_graph_mode_loader_options_carry_the_rule():
    from services.graph_panel import analysis
    from services.graph_panel.reads import loader_options
    from types import SimpleNamespace
    default, shown = _both(loader_options)
    assert default["hide_uncalled"] is True and shown["hide_uncalled"] is False
    a, b = _both(lambda: analysis._loader_options(SimpleNamespace()))
    assert a["hide_uncalled"] is True and b["hide_uncalled"] is False   # in the row cache key (json options)


def test_graph_mode_decode_drops_uncalled_records(files):
    """The graph decode is the live-lift source decode with these loader options."""
    from services.compact_read_loader import build_compact_reads_from_bam
    from services.graph_panel.reads import loader_options

    def ids():
        options = {k: v for k, v in loader_options().items() if k in ("hide_uncalled", "include_duplicates")}
        return {r["id"] for r in build_compact_reads_from_bam(files["bam"], CHROM, 900, 1700, spanning_only=False,
                                                                 **options)}
    default, shown = _both(ids)
    assert default == _called("snp") and shown == _names("snp")


# ── Differences ──────────────────────────────────────────────────────────────

def test_differences_native_bundles_and_revision_follow_the_rule(files):
    from services.differences.projected_service import native_bundles
    from services.differences.projection import ProjectionBudget, ProjectionPolicy
    from services.differences.workspace import _workspace_revision
    state = _state(files)

    def molecules():
        bundles, _reasons, _interrupted = native_bundles(state, "ds", CHROM, 2900, 3700, include_sequence=False,
                                                         include_duplicates=False,
                                                         budget=ProjectionBudget(ProjectionPolicy()))
        return len(bundles)
    default, shown = _both(molecules)
    assert default == len(_called("del"))
    assert shown == len(_names("del")) + 1   # + the split molecule
    a, b = _both(lambda: _workspace_revision(state, ["ds"]))
    assert a != b   # frozen calls name the setting they were made under


# ── region detection, autozoom ───────────────────────────────────────────────

def test_regions_and_autozoom_follow_the_rule(files):
    from services.bam_boundaries import get_read_boundaries_from_bam
    from services.region_detect import detect_regions
    state = _state(files)
    default, shown = _both(lambda: len(get_read_boundaries_from_bam(files["bam"], CHROM, 900, 1700)))
    # Autozoom hides QC-fail reads unless they are shown (3.1.0; tests/test_read_policy_paths.py).
    assert (default, shown) == (len(_called("snp")), len(_names("snp")))

    def regions():
        out = detect_regions(state, "ds", chrom=CHROM, start=0, end=LENGTH, min_reads=1)
        return sum(r.get("reads", r.get("n_reads", 0)) for r in out.get("regions", []))
    default, shown = _both(regions)
    assert default < shown


# ── background jobs: one job per setting ─────────────────────────────────────

def test_background_job_keys_separate_the_settings():
    from services.background_work import _job_key
    a, b = _both(lambda: _job_key(("top_windows", 1)))
    assert a != b


# ── the routes: the query's hide_uncalled reaches each path (SignalFilterMiddleware) ──

@pytest.fixture
def added(client, files):
    resp = client.post("/api/datasets/add", json={"path": files["bam"], "label": "uncalled_paths"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    did = body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id")
    yield did
    client.delete(f"/api/datasets/{did}")  # the app is shared with other tests


def test_routes_default_to_hide_and_honor_false(client, added):
    did = added

    def get(path, hide, **params):
        resp = client.get(path, params={**params, **({"hide_uncalled": "false"} if not hide else {})})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def post(path, hide, body, **params):
        resp = client.post(path, params={**params, **({"hide_uncalled": "false"} if not hide else {})}, json=body)
        assert resp.status_code == 200, resp.text
        return resp.json()

    carriers, found = {}, {}
    for hide in (True, False):
        snp_reads = len(_called("snp")) if hide else len(_names("snp"))
        assert get("/api/reads/info", hide, chrom=CHROM, start=900, end=1700, dataset_id=did)["count"] == snp_reads
        svs = post("/api/variants/svs", hide, dict(dataset_id=did, chrom=CHROM, start=2900, end=3700, min_len=50))
        assert svs["n_reads"] == (len(_called("del")) if hide else len(_names("del")) + 1)
        sv = next(c for c in svs["clusters"] if c["t"] == "D")
        split = post("/api/sv/split", hide, dict(dataset_id=did, chrom=CHROM, start=2900, end=3700, t="D",
                                                 ref=sv["ref"], len=sv["len"]))
        assert set(split["assignments"]) == (_called("del") if hide else _names("del") | {"sa_uncalled"})
        clusters = get("/api/insertions/clusters", hide, chrom=CHROM, start=4900, end=5800, dataset_id=did, min_len=30)
        carriers[hide] = max(c.get("n_carriers", c.get("support", 0)) for c in clusters["clusters"])
        regions = get("/api/reads/regions", hide, dataset_id=did, chrom=CHROM, start=0, end=LENGTH, min_reads=1)
        found[hide] = regions.get("regions") or []
    assert carriers == {True: len(_called("ins")), False: len(_names("ins"))}
    # The lone uncalled reads at 7,000 make a region only with all reads.
    assert len(found[False]) > len(found[True])
    # The SV split body setting (the Variants panel sends it with min_footprints -1 too).
    body = dict(dataset_id=did, chrom=CHROM, start=2900, end=3700, t="D", ref=DEL_AT, len=100)
    shown = post("/api/sv/split", True, dict(body, hide_uncalled=False))
    hidden = post("/api/sv/split", True, body)
    assert len(shown["assignments"]) > len(hidden["assignments"])


def test_comma_string_ns_nl_are_not_calls(tmp_path):
    """FiberBrowser 3.0.5's array-pair rule (bam_tags.interval_tag_pair, audited): ns/nl and as/al count only as
    arrays. No FiberHMM or fibertools writer stores them as strings; a comma string (``ns:Z:100,700``) is not read
    as footprints, as ``ns:Z:raw`` or Dorado's scalar ``ns:i`` are not."""
    header = pysam.AlignmentHeader.from_dict({"SQ": [{"SN": CHROM, "LN": LENGTH}]})
    read = pysam.AlignedSegment(header)
    read.query_name, read.reference_id, read.reference_start, read.cigarstring = "s", 0, 100, "1000M"
    read.query_sequence = "A" * 1000
    read.set_tag("ns", "100,700")
    read.set_tag("nl", "147,147")
    assert not read_has_footprint_calls(read)
    read.set_tag("ns", array("I", [100, 700]))
    read.set_tag("nl", array("I", [147, 147]))
    assert read_has_footprint_calls(read)
