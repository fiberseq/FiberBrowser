"""P3 (DESIGN_LIVE_LIFT.md §2.3): supplementary_display='fold' draws a
molecule's supplementary records on its primary record's row, and hard-clipped
supplementaries follow FiberHMM's per-record annotation-scope rule."""
import array

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.lift import live_lift as ll
from services.lift.cohort import prepare_lift_cohort
from services.read_selection import read_matches_id_filter


def _u32(values):
    return array.array("I", values)


def _u8(values):
    return array.array("B", values)


# ── Display fold ────────────────────────────────────────────────────────────

def _fold_records(h):
    return [
        # Primary on chain 0 (+), across the 10 bp target-only gap at source 3000 (a connector).
        make_record(h, "fold", MAT, 2950, "100M100S", tags=[("ns", _u32([20, 70])), ("nl", _u32([20, 20])),
                                                             ("st", "CT"), ("SA", f"{MAT},7301,+,100S100M,60,0;")]),
        # Its supplementary on chain 1 (-): another orientation, another target locus.
        make_record(h, "fold", MAT, 7300, "100S100M", flag=2048,
                    tags=[("ns", _u32([120])), ("nl", _u32([30])), ("SA", f"{MAT},2951,+,100M100S,60,0;")]),
        make_record(h, "plain", MAT, 2600, "300M", tags=[("ns", _u32([10])), ("nl", _u32([50]))]),
    ]


@pytest.fixture
def toy(tmp_path):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))
    return handle, write_bam(tmp_path / "src.bam", _fold_records)


def _display(toy, settings):
    handle, bam = toy
    load = ll.load_lifted_rows(handle, [bam], TARGET, 1000, 15_000, haplotypes=handle.haplotypes, settings=settings,
                               dataset_id="ds", loader_options=dict(include_methylation=True))
    return load.rows, prepare_lift_cohort(load.rows, "display", settings)


def test_fold_draws_the_supplementary_on_the_primary_row(toy):
    rows, own = _display(toy, ll.LiftSettings())
    assert len([r for r in own.rows if r["id"] == "fold"]) == 2
    _, folded = _display(toy, ll.LiftSettings(supplementary_display="fold"))
    (row,) = [r for r in folded.rows if r["id"] == "fold"]
    lift = row["live_lift"]
    # Both members' segments keep their chain and strand; the primary's connector stays drawn.
    assert {(s[2], s[3]) for s in lift["segments"]} == {(0, "+"), (1, "-")}
    assert lift["connectors"]
    assert lift["folded"]["records"] == 2 and lift["folded"]["supplementary_rows"] == 1
    assert not lift["source"]["supplementary"]                     # anchored on the primary row
    own_rows = [r for r in own.rows if r["id"] == "fold"]
    primary = next(r for r in own_rows if not r["live_lift"]["source"]["supplementary"])
    supp = next(r for r in own_rows if r["live_lift"]["source"]["supplementary"])
    assert row["analysis_id"] == primary["analysis_id"]
    assert set(lift["folded"]["analysis_ids"]) == {primary["analysis_id"], supp["analysis_id"]}
    # Every member's calls are on the row, record-qualified (two records never share a call).
    assert sorted(iv[:2] for iv in row["intervals"] if iv[2] > 0) == sorted(
        iv[:2] for r in own_rows for iv in r["intervals"] if iv[2] > 0)
    assert len({c for c in lift["calls"]["intervals"] if c}) == len([iv for iv in row["intervals"] if iv[2] > 0])
    assert row["reference_start"] == min(r["reference_start"] for r in own_rows)
    assert row["reference_end"] == max(r["reference_end"] for r in own_rows)
    # A filter by either member's cohort identity keeps the folded row.
    assert read_matches_id_filter(row, {supp["analysis_id"]})
    assert read_matches_id_filter(row, {primary["analysis_id"]})
    assert folded.description["folded_display_rows"] == 1
    # The unrelated molecule is untouched.
    def plain(rows):   # lift_key differs with the setting; nothing else may
        return [{**r, "live_lift": {k: v for k, v in r["live_lift"].items() if k != "key"}} for r in rows if r["id"] == "plain"]
    assert plain(folded.rows) == plain(own.rows)


def test_hide_drops_and_the_key_changes(toy):
    handle, _ = toy
    _, hidden = _display(toy, ll.LiftSettings(supplementary_display="hide"))
    assert not any(r["live_lift"]["source"]["supplementary"] for r in hidden.rows)
    keys = {ll.lift_key(handle, handle.haplotypes, ll.LiftSettings(supplementary_display=mode))
            for mode in ("own_rows", "hide", "fold")}
    assert len(keys) == 3


@pytest.mark.parametrize("cohort", ["all_records", "follow_display"])
def test_analysis_cohort_is_independent_of_the_display_fold(toy, cohort):
    rows, _ = _display(toy, ll.LiftSettings())
    def analysis(mode):
        settings = ll.LiftSettings(supplementary_display=mode, cohort_supplementaries=cohort)
        prepared = prepare_lift_cohort(rows, "analysis", settings)
        return [(r["analysis_id"], r["intervals"]) for r in prepared.rows], prepared.description["supplementary_rows"]
    assert analysis("own_rows") == analysis("fold")
    assert analysis("fold")[1] == 1


def test_fold_without_a_loaded_primary_joins_the_supplementaries():
    def row(record, start, molspan):
        return dict(id="m", intervals=[[start, start + 10, 10]], reference_start=start, reference_end=start + 10,
                    analysis_id=f"id-{record}",
                    live_lift=dict(molecule="g|m", record=record, row_index=0, placement="1", alt=False, hap="MAT",
                                   hap_label="MAT", source={"supplementary": True},
                                   segments=[[start, start + 10, 1, "-", True]], connectors=[], badges=[],
                                   badge_ids=[], calls={"intervals": ["ns:0"]}, call_parts={"intervals": [[0, 0]]},
                                   molecular_spans=[[start, start + 10, molspan, 1, True]]))
    from services.lift.cohort import fold_display_supplementaries
    out, n = fold_display_supplementaries([row("b", 50, 100), row("a", 0, 0)])
    assert n == 1 and len(out) == 1
    assert out[0]["analysis_id"] == "id-a"                         # the lowest supplementary anchors
    assert [s[:2] for s in out[0]["live_lift"]["segments"]] == [[0, 10], [50, 60]]
    assert all(s[3] == "-" for s in out[0]["live_lift"]["segments"])


def test_overlapping_molecular_bases_are_drawn_once():
    def row(record, supp, start, molspan):
        return dict(id="m", intervals=[[start, start + 20, 20]], reference_start=start, reference_end=start + 20,
                    analysis_id=f"id-{record}",
                    live_lift=dict(molecule="g|m", record=record, row_index=0, placement="1", alt=False, hap="MAT",
                                   hap_label="MAT", source={"supplementary": supp},
                                   segments=[[start, start + 20, 7, "+", True]], connectors=[], badges=[],
                                   badge_ids=[], calls={"intervals": ["ns:0"]}, call_parts={"intervals": [[0, 0]]},
                                   molecular_spans=[[start, start + 20, molspan, 1, True]]))
    from services.lift.cohort import fold_display_supplementaries
    # The supplementary repeats molecular bases 10-20 of the primary: the primary keeps them.
    out, _ = fold_display_supplementaries([row("p", False, 0, 0), row("s", True, 100, 10)])
    segments = out[0]["live_lift"]["segments"]
    assert [s[:2] for s in segments] == [[0, 20], [110, 120]] and all(s[2:4] == [7, "+"] for s in segments)


# ── Endpoint ────────────────────────────────────────────────────────────────

@pytest.fixture
def lift_env(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient

    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    manifest = write_toy_sidecar(tmp_path / "map")
    bam = write_bam(tmp_path / "src.bam", _fold_records)
    try:
        yield client, manifest, bam
    finally:
        srv.state = old
        init_context(old)


def test_compact_reads_endpoint_returns_the_folded_row(lift_env):
    client, manifest, bam = lift_env
    did = client.post("/api/lift/datasets", json={"paths": [bam], "manifest": manifest}).json()["dataset"]["id"]

    def compact():
        r = client.get("/api/reads/compact", params=dict(chrom=TARGET, start=1000, end=15_000, dataset_id=did,
                                                         max_reads=5000, full_working_set="true"))
        assert r.status_code == 200, r.text
        return [x for x in r.json()["reads"] if x["id"] == "fold"]

    assert len(compact()) == 2
    r = client.post(f"/api/lift/datasets/{did}/settings", json={"settings": {"supplementary_display": "fold"}})
    assert r.json()["success"], r.text
    (row,) = compact()
    assert row["live_lift"]["folded"]["records"] == 2
    assert {(s[2], s[3]) for s in row["live_lift"]["segments"]} == {(0, "+"), (1, "-")}


# ── Hard-clip annotation scope ──────────────────────────────────────────────

LEFT = 20       # clipped bases at the record's left (reference orientation)


def _variant(h, clip, scope, reverse, tag):
    """The same 120 bp molecule's supplementary, 100 bases aligned at MAT 2000,
    soft-clipped (whole-molecule tags) or hard-clipped with tags on the stored
    SEQ (partial) or on the whole molecule."""
    cigar = f"{LEFT}{'S' if clip == 'soft' else 'H'}100M"
    whole = clip == "soft" or scope == "whole"
    if tag == "ns":          # legacy SEQ frame (no provenance header): stored = full - left clip
        starts = [30, 95] if whole else [30 - LEFT, 95 - LEFT]
        tags = [("ns", _u32(starts)), ("nl", _u32([20, 20]))]
    else:                    # fibertools Ma: always molecular; the molecule's 5' clip is the right one on reverse
        shift = 0 if whole else (0 if reverse else LEFT)
        tags = [("Ma", f"{120 if whole else 100};nuc+:{31 - shift}-20,{96 - shift}-20")]
    return [make_record(h, "mol", MAT, 2000, cigar, reverse=reverse, flag=2048, tags=tags)]


def _lifted_supplementary(tmp_path, name, records):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / f"map_{name}"))
    bam = write_bam(tmp_path / f"{name}.bam", records)
    load = ll.load_lifted_rows(handle, [bam], TARGET, 2500, 3500, haplotypes=handle.haplotypes,
                               settings=ll.LiftSettings(primary_lookup=False), dataset_id="ds",
                               loader_options=dict(include_layers=True))
    (row,) = [r for r in load.rows if r["id"] == "mol"]
    return row, load.counts


def _calls(row):
    layers = {name: layer["intervals"] for name, layer in (row.get("layers") or {}).items()}
    return dict(intervals=[iv for iv in row["intervals"] if iv[2] > 0], layers=layers,
                calls=row["live_lift"]["calls"], parts=row["live_lift"]["call_parts"],
                segments=row["live_lift"]["segments"])


@pytest.mark.parametrize("tag", ["ns", "Ma"])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("scope", ["partial", "whole"])
def test_hard_clipped_calls_match_the_soft_clipped_record(tmp_path, tag, reverse, scope):
    soft, _ = _lifted_supplementary(tmp_path, "soft", lambda h: _variant(h, "soft", scope, reverse, tag))
    hard, counts = _lifted_supplementary(tmp_path, "hard", lambda h: _variant(h, "hard", scope, reverse, tag))
    assert _calls(soft)["intervals"] or _calls(soft)["layers"]
    assert _calls(hard) == _calls(soft)
    assert counts["hard_clipped_scoped"][scope] == 1
    assert "hard_clipped_supplementary" not in counts


@pytest.mark.parametrize("mn,kept", [(None, True), (100, True), (120, False)])
def test_hard_clipped_modifications_follow_the_stored_seq(tmp_path, mn, kept):
    def records(h):
        tags = [("ns", _u32([10])), ("nl", _u32([20])), ("MM", "C+m,0,3;"), ("ML", _u8([250, 240]))]
        if mn is not None:
            tags.append(("MN", mn, "i"))
        return [make_record(h, "mol", MAT, 2000, "20H100M", flag=2048, tags=tags)]
    from services.compact_read_loader import build_compact_reads_from_bam
    counts = {}
    reads = build_compact_reads_from_bam(write_bam(tmp_path / "m.bam", records), MAT, 0, 10_000,
                                         spanning_only=False, include_lift_meta=True, infer_legacy_layers=False,
                                         include_supplementary=True, include_methylation=True, lift_counts=counts)
    (read,) = reads
    assert bool(read.get("methyl") or read.get("methyl_m5c")) is kept
    assert counts.get("hard_clip_mods_dropped", 0) == (0 if kept else 1)


def test_whole_molecule_modifications_with_unsized_mm_are_dropped(tmp_path):
    # Without MN, MM that needs more C bases than the stored SEQ has describes the whole molecule.
    def records(h):
        return [make_record(h, "mol", MAT, 2000, "20H100M", flag=2048,
                            tags=[("ns", _u32([10])), ("nl", _u32([20])), ("MM", "C+m,105;"), ("ML", _u8([250]))])]
    from services.compact_read_loader import scope_hard_clipped_supplementary
    import pysam
    bam = write_bam(tmp_path / "w.bam", records)
    with pysam.AlignmentFile(bam) as f:
        read = next(f.fetch())
        counts = {}
        out = scope_hard_clipped_supplementary(read, counts)
    assert out is not None and not out.has_tag("MM")
    assert counts == {"hard_clipped_scoped": {"partial": 1, "whole": 0, "none": 0}, "hard_clip_mods_dropped": 1}


# ── Hard-clip scope: modification calls ─────────────────────────────────────

_MOLECULE = ("ACGTTACCAGTACGATCCAGTA" * 6)[:120]      # mixed bases: a frame shift moves calls
_REVCOMP = str.maketrans("ACGT", "TGCA")


def _encode_mm(molecule, calls):
    """MM/ML of ``calls`` (``{(base, code): {molecular position: probability}}``) on
    the molecule-oriented sequence ``molecule``."""
    groups, ml = [], []
    for (base, code), sites in calls.items():
        positions = [i for i, b in enumerate(molecule) if b == base]
        deltas, last = [], -1
        for k, p in enumerate(positions):
            if p in sites:
                deltas.append(sum(1 for q in positions if last < q < p))
                ml.append(sites[p])
                last = p
        groups.append(f"{base}+{code}," + ",".join(map(str, deltas)) + ";")
    return "".join(groups), _u8(ml)


def _mod_variant(clip, scope, reverse, mn):
    full = _MOLECULE[::-1].translate(_REVCOMP) if reverse else _MOLECULE    # SEQ, reference orientation
    left = LEFT
    stored = full if clip == "soft" else full[left:left + 100]
    stored_molecule = stored[::-1].translate(_REVCOMP) if reverse else stored
    # Molecular offset of the stored bases (the molecule's 5' clip: right on reverse, here 0).
    offset = 0 if clip == "soft" else (0 if reverse else left)
    # Calls at molecular positions of the aligned part only, on C (5mC) and A (6mA).
    want = {}
    aligned = range(0, 100) if reverse else range(left, 120)
    for base, code in (("C", "m"), ("A", "a")):
        sites = [i for i in aligned if _MOLECULE[i] == base][1::3]
        want[(base, code)] = {i - offset: 100 + 7 * n for n, i in enumerate(sites)}
    mm, ml = _encode_mm(stored_molecule, want)
    whole = clip == "soft" or scope == "whole"
    starts = [30, 95] if whole else [30 - LEFT, 95 - LEFT]
    tags = [("ns", _u32(starts)), ("nl", _u32([20, 20])), ("MM", mm), ("ML", ml)]
    if mn:
        tags.append(("MN", len(stored), "i"))
    cigar = f"{LEFT}{'S' if clip == 'soft' else 'H'}100M"
    return lambda h: [make_record(h, "mol", MAT, 2000, cigar, reverse=reverse, flag=2048, tags=tags, seq=stored)]


def _lifted_mods(tmp_path, name, records):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    handle = ll.open_lift_map(write_toy_sidecar(tmp_path / f"map_{name}"))
    bam = write_bam(tmp_path / f"{name}.bam", records)
    load = ll.load_lifted_rows(handle, [bam], TARGET, 2500, 3500, haplotypes=handle.haplotypes,
                               settings=ll.LiftSettings(primary_lookup=False), dataset_id="ds",
                               loader_options=dict(include_methylation=True))
    (row,) = [r for r in load.rows if r["id"] == "mol"]
    return row, load.counts


@pytest.mark.parametrize("mn", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("scope", ["partial", "whole"])
def test_hard_clipped_modifications_match_the_soft_clipped_record(tmp_path, scope, reverse, mn):
    soft, _ = _lifted_mods(tmp_path, "soft", _mod_variant("soft", scope, reverse, mn))
    hard, counts = _lifted_mods(tmp_path, "hard", _mod_variant("hard", scope, reverse, mn))
    fields = ("methyl", "methyl_m6a", "methyl_m5c", "methyl_probs", "methyl_m6a_probs", "methyl_m5c_probs")
    marks = {f: soft.get(f) for f in fields if soft.get(f) is not None}
    assert marks.get("methyl_m6a") and marks.get("methyl_m5c")           # both kinds reach the row
    assert {f: hard.get(f) for f in marks} == marks
    assert counts["hard_clipped_scoped"][scope] == 1 and "hard_clip_mods_dropped" not in counts


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("mm", ["C+m,0;", "C-m,0;", "G-m,0;", "G+m,0;", "C+m,1;", "C-m,0,0;", "A+a,0;", "N+m,3;", "N+m,4;"])
def test_stored_seq_modification_check_agrees_with_htslib(tmp_path, reverse, mm):
    import pysam
    from services.compact_read_loader import _mods_fit_stored_seq
    def records(h):
        return [make_record(h, "mol", MAT, 2000, "2H4M", reverse=reverse, flag=2048, seq="CCAA",
                            tags=[("MM", mm), ("ML", _u8([200] * (mm.count(",") )))])]
    with pysam.AlignmentFile(write_bam(tmp_path / "v.bam", records)) as f:
        read = next(f.fetch())
        assert _mods_fit_stored_seq(read) == (read.modified_bases is not None)


def test_minus_strand_modifications_on_a_hard_clipped_record_are_kept(tmp_path):
    # 'C-m' counts C bases of the stored SEQ (htslib); the call stays at reference 2000.
    def records(h):
        return [make_record(h, "mol", MAT, 2000, "20H100M", flag=2048,
                            tags=[("ns", _u32([10])), ("nl", _u32([20])), ("MM", "C-m,0;"), ("ML", _u8([250]))])]
    from services.compact_read_loader import build_compact_reads_from_bam
    counts = {}
    (read,) = build_compact_reads_from_bam(write_bam(tmp_path / "m.bam", records), MAT, 0, 10_000,
                                           spanning_only=False, include_lift_meta=True, infer_legacy_layers=False,
                                           include_supplementary=True, include_methylation=True, lift_counts=counts)
    marks = [p for f in ("methyl", "methyl_m5c", "methyl_m6a") for p in read.get(f) or ()]
    assert 2000 in marks and "hard_clip_mods_dropped" not in counts


@pytest.mark.parametrize("reverse", [False, True])
def test_any_base_modifications_survive_whole_scope_padding(tmp_path, reverse):
    """``N+m`` counts every base, so the pad at the molecule's 5' end must be skipped."""
    sites = [25, 46]                                  # molecular positions inside the aligned part
    def variant(clip):
        # The clip sits at the molecule's 5' end: SEQ left on forward, SEQ right on reverse.
        cigar = (f"{LEFT}{clip}100M" if not reverse else f"100M{LEFT}{clip}")
        offset = 0 if clip == "S" else LEFT
        first = sites[0] - offset
        mm = f"N+m,{first},{sites[1] - sites[0] - 1};"
        seq = _MOLECULE if clip == "S" else (_MOLECULE[LEFT:] if not reverse else _MOLECULE[:100])
        seq = seq[::-1].translate(_REVCOMP) if reverse else seq
        if reverse and clip == "S":
            seq = _MOLECULE[::-1].translate(_REVCOMP)
        tags = [("ns", _u32([30, 95])), ("nl", _u32([20, 20])), ("MM", mm), ("ML", _u8([250, 240]))]
        return lambda h: [make_record(h, "mol", MAT, 2000, cigar, reverse=reverse, flag=2048, tags=tags, seq=seq)]
    soft, _ = _lifted_mods(tmp_path, "soft", variant("S"))
    hard, counts = _lifted_mods(tmp_path, "hard", variant("H"))
    fields = ("methyl", "methyl_m6a", "methyl_m5c")
    marks = {f: soft.get(f) for f in fields if soft.get(f)}
    assert marks and sum(len(v) for v in marks.values()) >= 2
    assert {f: hard.get(f) for f in marks} == marks
    assert counts["hard_clipped_scoped"]["whole"] == 1 and "hard_clip_mods_dropped" not in counts
