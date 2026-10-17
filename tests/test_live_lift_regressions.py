"""Regression tests for the P1 review findings (review/p1: Codex and agy
probes), DESIGN_LIVE_LIFT.md v3.1."""
import array
import gzip
import json
import os

import pytest

from live_lift_fixtures import MAT, PAT, TARGET, make_record, write_bam, write_toy_sidecar
from services.compact_read_loader import build_compact_reads_from_bam
from services.lift import live_lift as ll
from services.lift.compose import lift_compact_reads
from services.read_sampling import Sampler, sampling


def _u32(values):
    return array.array("I", values)


@pytest.fixture
def toy_map(tmp_path):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    return ll.open_lift_map(write_toy_sidecar(tmp_path / "map"))


def _load(handle, bam, start=1000, end=9000, **kwargs):
    opts = dict(haplotypes=handle.haplotypes, settings=ll.LiftSettings(), dataset_id="ds",
                loader_options=dict(sv_min_len=50))
    opts.update(kwargs)
    return ll.load_lifted_rows(handle, [bam], TARGET, start, end, **opts)


def _by_id(load):
    out = {}
    for r in load.rows:
        out.setdefault(r["id"], []).append(r)
    return out


# ── Deletions (both HIGH-1) ─────────────────────────────────────────────────

def test_deletions_never_become_gaps_or_msps(toy_map, tmp_path):
    bam = write_bam(tmp_path / "del.bam", lambda h: [
        # One 100 bp nucleosome across a 60 bp deletion, on the '-' chain.
        make_record(h, "minus_del", MAT, 7500, "100M60D100M", tags=[("ns", _u32([10])), ("nl", _u32([100]))]),
        # Two nucleosomes flanking a 100 bp deletion, on the '+' chain.
        make_record(h, "del", MAT, 1000, "500M100D500M", tags=[("ns", _u32([100, 700])), ("nl", _u32([200, 200]))]),
    ])
    rows = _by_id(_load(toy_map, bam))
    (minus,) = rows["minus_del"]
    assert minus["intervals"] == [[13330, 13340, 100], [13400, 13490, 100]]   # no gap inside the deletion
    assert "msp" not in minus["layers"]
    assert minus["live_lift"]["calls"]["layer:nuc"] == ["ns:0", "ns:0"]
    # The decoder's two pieces of one call are one logical group.
    groups = {p[1] for p in minus["live_lift"]["call_parts"]["layer:nuc"]}
    assert len(groups) == 1
    (plus,) = rows["del"]
    # As the native decoder: the gap and MSP between the nucleosomes are cut at the deletion.
    assert plus["intervals"] == [[2100, 2300, 200], [2300, 2500, -500], [2600, 2800, -500], [2800, 3000, 200]]
    assert plus["layers"]["msp"]["intervals"] == [[2300, 2500, 500], [2600, 2800, 500]]
    native = {r["id"]: r for r in build_compact_reads_from_bam(bam, MAT, 0, 10_000, spanning_only=False)}
    assert [iv[:2] for iv in native["del"]["layers"]["msp"]["intervals"]] == [[1300, 1500], [1600, 1800]]


# ── Re-binning and overlapping runs (agy HIGH-2) ────────────────────────────

def test_insertion_marker_at_a_badge_is_not_duplicated(toy_map, tmp_path):
    bam = write_bam(tmp_path / "b.bam", lambda h: [
        make_record(h, "ins_at_badge", MAT, 4900, "200M5I100M",
                    tags=[("ns", _u32([10, 201, 220])), ("nl", _u32([100, 3, 50]))])])
    (r,) = _by_id(_load(toy_map, bam))["ins_at_badge"]
    ids = r["live_lift"]["calls"]["intervals"]
    positives = [cid for iv, cid in zip(r["intervals"], ids) if iv[2] > 0]
    assert positives.count("ns:1") == 1
    tf = r["live_lift"]["calls"]["layer:tf"]
    assert tf.count("ns:1") == 1 and len(tf) == len(r["layers"]["tf"]["intervals"])


def _dup_map(tmp_path):
    """Chain 0 maps source [0, 1000) -> [1000, 2000) and [1000, 2000) -> [1200, 2200)."""
    c0 = [[1000, 0, 1000], [1200, 1000, 1000]]
    manifest = dict(format="graphlift.sidecar", version=2, block_kinds=["anchor", "substitution", "aligned"],
                    gap_reasons=["source_insertion", "target_insertion", "aligned_indel", "dissimilar", "too_big",
                                 "conflict"],
                    targets=[{"name": TARGET, "size": 20_000}], sources=[{"name": MAT, "size": 10_000, "uncovered": []}],
                    chains=[dict(key="c0", ucsc_id="c0", haplotype="H#1", target=0, source=0, strand="+",
                                 fragment="c0", t_start=1000, t_end=2200, q_start=0, q_end=2000, q_start_forward=0,
                                 q_end_forward=2000, aligned=2000)],
                    nets={"H#1": [[0, 1000, 2200, 0, []]]}, target_files={TARGET: ["t0.json.gz", "t0.fills.json.gz"]})
    os.makedirs(tmp_path, exist_ok=True)
    with gzip.open(tmp_path / "t0.json.gz", "wt") as fh:
        json.dump({"target": TARGET, "blocks": {"0": c0}, "gaps": {"0": [[2000, 1000, -800, 0, 1]]}}, fh)
    with gzip.open(tmp_path / "t0.fills.json.gz", "wt") as fh:
        json.dump({"target": TARGET, "fills": {}}, fh)
    with open(tmp_path / "m.json", "w") as fh:
        json.dump(manifest, fh)
    return str(tmp_path / "m.json")


def test_runs_overlapping_in_target_get_their_own_rows(tmp_path):
    ll.clear_selection_cache()
    handle = ll.open_lift_map(_dup_map(tmp_path / "dup"))
    bam = write_bam(tmp_path / "dup.bam", lambda h: [
        make_record(h, "dup", MAT, 0, "2000M", tags=[("ns", _u32([500, 1500])), ("nl", _u32([150, 150]))])])
    load = ll.load_lifted_rows(handle, [bam], TARGET, 0, 5000, haplotypes=["H#1"], settings=ll.LiftSettings(),
                               dataset_id="ds")
    rows = load.rows
    assert len(rows) == 2
    for r in rows:
        spans = r["alignment_spans"]
        assert all(a[1] <= b[0] for a, b in zip(spans, spans[1:]))
        nuc = r["layers"]["nuc"]["intervals"]
        assert len(nuc) == len({tuple(iv) for iv in nuc}) == 1


# ── Call identity (both) ────────────────────────────────────────────────────

def _piece(q0, q1, t0, chain=0, strand="+"):
    return ll.LiftPiece(chain, t0, t0 + q1 - q0, q0, q1, strand, True, "H#1", MAT)


def _pure(pieces, read, a=0, b=10_000, settings=None):
    sel = ll.PieceSelection(TARGET, a, b, a, b, pieces)
    plan = ll.plan_fetch(sel, settings or ll.LiftSettings())
    return lift_compact_reads([read], plan, handle=None, region_start=a, region_end=b,
                              settings=settings or ll.LiftSettings(), key="k", dataset_id="ds")


def _read():
    return {"id": "cross", "reference_start": 0, "reference_end": 300, "alignment_orientation": "forward",
            "intervals": [[50, 250, 200]], "qualities": [200], "methyl_m6a": [150],
            "_fiberbrowser_source_base": 0, "_fiberbrowser_aligned_runs": [[0, 0, 300]],
            "_fiberbrowser_lift_record": {"contig": MAT, "length": 300, "reverse": False},
            "_fiberbrowser_calls": {"intervals": [["ns:0", 50, 250]]}}


def test_call_identity_is_selection_independent():
    full = _pure([_piece(0, 100, 1000), _piece(100, 300, 1110)], _read())
    partial = _pure([_piece(100, 300, 1110)], _read())
    f_ll, p_ll = full[0]["live_lift"], partial[0]["live_lift"]
    assert f_ll["calls"]["intervals"] == ["ns:0", "ns:0"]
    assert p_ll["calls"]["intervals"] == ["ns:0"]
    # The second part keeps the same part and group keys whichever pieces were selected.
    assert f_ll["call_parts"]["intervals"] == [[50, 50], [100, 100]]
    assert p_ll["call_parts"]["intervals"] == [[100, 100]]


def test_call_parts_across_rows_and_crops():
    rows = _pure([_piece(0, 100, 1000), _piece(100, 200, 2000, 1, "-"), _piece(200, 300, 3000, 2)], _read())
    assert [r["live_lift"]["calls"]["intervals"][0] for r in rows] == ["ns:0"] * 3
    groups = [r["live_lift"]["call_parts"]["intervals"][0][1] for r in rows]
    assert len(set(groups)) == 3   # separate logical parts in separate rows
    cropped = _pure([_piece(0, 100, 1000), _piece(100, 300, 1110)], _read(), a=1150, b=2000)
    assert cropped[0]["live_lift"]["call_parts"]["intervals"] == [[100, 100]]


def test_cigar_split_and_chain_gap_groups(toy_map, tmp_path):
    bam = write_bam(tmp_path / "c.bam", lambda h: [
        make_record(h, "cigar_and_chain_split", MAT, 2800, "120M50D200M",
                    tags=[("ns", _u32([100])), ("nl", _u32([200]))])])
    (r,) = _by_id(_load(toy_map, bam))["cigar_and_chain_split"]
    ll_ = r["live_lift"]
    parts = [(cid, part) for iv, cid, part in
             zip(r["intervals"], ll_["calls"]["intervals"], ll_["call_parts"]["intervals"]) if iv[2] > 0]
    assert [cid for cid, _p in parts] == ["ns:0"] * 3
    keys = [p for _cid, p in parts]
    assert len({k[0] for k in keys}) == 3          # three distinct parts
    assert keys[0][1] == keys[1][1] != keys[2][1]   # the deletion keeps the group; the 10 bp connector splits it


def test_overlapping_primary_placements_keep_marks():
    rows = _pure([_piece(0, 300, 1000), _piece(0, 300, 2000, 1)], _read())
    marks = sorted(m for r in rows for m in r["methyl_m6a"])
    assert marks == [1150, 2150]
    assert sorted(iv[0] for r in rows for iv in r["intervals"] if iv[2] > 0) == [1050, 2050]


# ── load_lifted_rows contract (Codex HIGH-2, agy MED-3) ─────────────────────

def _records(h):
    return [
        make_record(h, "del", MAT, 1000, "500M100D500M", tags=[("ns", _u32([100, 700])), ("nl", _u32([200, 200]))]),
        make_record(h, "plus", MAT, 2500, "1000M", tags=[("ns", _u32([10])), ("nl", _u32([100]))]),
        make_record(h, "split", MAT, 4000, "20S100M", flag=2048, tags=[("ns", _u32([30])), ("nl", _u32([50]))]),
        make_record(h, "split", MAT, 6000, "100M20S", tags=[("ns", _u32([30])), ("nl", _u32([50]))]),
    ]


def test_ambient_sampler_and_read_ids_never_filter(toy_map, tmp_path):
    bam = write_bam(tmp_path / "s.bam", _records)
    base = sorted(r["id"] for r in _load(toy_map, bam).rows)
    sampler = Sampler(1, only_ids={"del"})
    with sampling(sampler):
        filtered = _load(toy_map, bam)
    assert sorted(r["id"] for r in filtered.rows) == base
    assert sampler.kept_starts == [] and sampler.skipped_starts == []


def test_explicit_sampler_counts_molecules_at_target_extents(toy_map, tmp_path):
    bam = write_bam(tmp_path / "s.bam", _records)
    sampler = Sampler(1)
    load = _load(toy_map, bam, sampler=sampler)
    starts = sorted(list(sampler.kept_starts) + list(sampler.skipped_starts))
    assert len(starts) == 3                         # 'split' counted once (its primary)
    assert all(s >= 1000 for s in starts)           # target frame (source starts: 1000, 2500, 6000)
    assert starts == [2000, 3500, 6910]
    assert load.counts["sampled"]["estimated"] is True


def test_byte_budget_marks_the_record_that_crosses_it(toy_map, tmp_path):
    bam = write_bam(tmp_path / "one.bam", lambda h: [make_record(h, "one", MAT, 100, "100M")])
    budget = ll.LoadBudget(max_bytes=1)
    load = _load(toy_map, bam, start=1000, end=1100, budget=budget,
                 loader_options={"hide_terminal_gaps": False})
    assert load.truncated


# ── Primary metadata (both MED) ─────────────────────────────────────────────

def test_record_fallback_is_per_record(toy_map, tmp_path):
    bam = write_bam(tmp_path / "f.bam", lambda h: [
        make_record(h, "missing", MAT, 2000, "100M", flag=2048, tags=[("st", "CT")]),
        make_record(h, "missing", PAT, 500, "100M", flag=2048, tags=[("st", "GA")])])
    load = _load(toy_map, bam, settings=ll.LiftSettings(primary_lookup=False),
                 loader_options={"hide_terminal_gaps": False})
    got = sorted((r["live_lift"]["source"]["contig"], r["live_lift"]["hap"], r["strand"],
                  r["live_lift"]["hap_source"]) for r in load.rows)
    assert got == [(MAT, "H#1", "CT", "record"), (PAT, "H#2", "GA", "record")]
    assert load.counts["hap_from_record"] == 2


def test_primary_strand_conflict_propagates_and_cache_follows_the_bam(toy_map, tmp_path):
    from services.bam_handles import discard_bam_handle

    def write(strand, seq):
        return write_bam(tmp_path / "p.bam", lambda h: [
            make_record(h, "mol", MAT, 2000, "100M", flag=2048, tags=[("st", "CT"), ("SA", f"{PAT},101,+,100M,60,0;")]),
            make_record(h, "mol", PAT, 100, "100M", seq=seq, tags=[("st", strand)])])

    path = write("GA", "Y" * 100)            # st GA but the SEQ's marks say CT: a conflict
    (r,) = _load(toy_map, path, haplotypes=["MAT"], loader_options={"hide_terminal_gaps": False}).rows
    assert (r["strand"], r.get("strand_conflict"), r["live_lift"]["hap_label"]) == ("GA", True, "PAT")
    discard_bam_handle(path)
    os.remove(path + ".bai")
    write("CT", "C" * 100)
    (r,) = _load(toy_map, path, haplotypes=["MAT"], loader_options={"hide_terminal_gaps": False}).rows
    assert r["strand"] == "CT" and not r.get("strand_conflict")   # warm cache, new BAM: new answer


def test_sa_budget_counts_point_fetches(toy_map):
    class FakeBam:
        references = (MAT,)

        def __init__(self):
            self.fetches = []

        def fetch(self, chrom, a, b):
            self.fetches.append((chrom, a, b))
            return iter(())

    fake = FakeBam()
    sa = "".join(f"{MAT},{i + 1},+,10M,60,0;" for i in range(40))
    read = {"id": "many_sa", "library_id": "fake", "source_path": "fake",
            "_fiberbrowser_primary": {"is_supplementary": True, "sa": sa},
            "_fiberbrowser_lift_record": {"contig": MAT}}
    counts = {}
    ll.resolve_primary_metadata(toy_map, [read], settings=ll.LiftSettings(), counts=counts,
                                bam_handle_getter=lambda path: fake)
    assert len(fake.fetches) == ll.MAX_PRIMARY_LOOKUPS
    assert counts["primary_lookup_capped"] == 1


# ── Registry, badges, numbering, alias, haplotypes ──────────────────────────

def test_payload_change_reopens_the_map(toy_map):
    target = os.path.join(os.path.dirname(toy_map.path), "toy.t0.chrT.json.gz")
    st = os.stat(target)
    os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    reopened = ll.open_lift_map(toy_map.path)
    assert reopened is not toy_map and reopened.fingerprint != toy_map.fingerprint
    assert ll.lift_key(reopened, ["H#1"], ll.LiftSettings()) != ll.lift_key(toy_map, ["H#1"], ll.LiftSettings())


def test_badge_not_swallowed_when_the_tail_continues_outside(tmp_path, monkeypatch):
    ll.clear_selection_cache()
    path = write_toy_sidecar(tmp_path / "map")
    with open(path) as fh:
        m = json.load(fh)
    m["targets"][0]["size"] = 100_000
    with open(path, "w") as fh:
        json.dump(m, fh)
    handle = ll.open_lift_map(path)
    bam = write_bam(tmp_path / "o.bam", lambda h: [
        make_record(h, "tail", MAT, 4500, "700M", tags=[("ns", _u32([10, 400])), ("nl", _u32([100, 100]))])])
    monkeypatch.setattr(ll, "MARGIN_MIN", 5010)
    load = ll.load_lifted_rows(handle, [bam], TARGET, 0, 1000, haplotypes=["H#1"],
                               settings=ll.LiftSettings(g_split=1000), dataset_id="ds")
    (r,) = load.rows
    assert r["live_lift"]["badges"] == [[6010, "source_insertion", 200, 200, "R"]]


def test_both_rows_around_an_orientation_change_get_the_badge(toy_map, tmp_path):
    bam = write_bam(tmp_path / "x.bam", lambda h: [
        make_record(h, "cross_orient", MAT, 6800, "400M", tags=[("ns", _u32([100])), ("nl", _u32([200]))])])
    rows = _by_id(_load(toy_map, bam))["cross_orient"]
    assert len(rows) == 2
    assert all(len(r["live_lift"]["badges"]) == 1 for r in rows)
    assert {r["live_lift"]["badges"][0][3] for r in rows} == {10}


def test_row_numbering_is_per_placement(toy_map, tmp_path):
    bam = write_bam(tmp_path / "e.bam", lambda h: [
        make_record(h, "elsewhere", MAT, 9400, "500M", tags=[("ns", _u32([10])), ("nl", _u32([50]))])])
    for settings in (ll.LiftSettings(), ll.LiftSettings(cohort_alternatives="include")):
        rows = _load(toy_map, bam, settings=settings).rows
        for r in rows:
            assert (r["live_lift"]["row_index"], r["live_lift"]["row_count"]) == (0, 1)


def test_methyl_alias_lifted_once(toy_map, tmp_path):
    def records(h):
        rec = make_record(h, "m", MAT, 4900, "200M", seq="A" * 200, tags=[("ns", _u32([10])), ("nl", _u32([150])),
                                                                    ("MM", "A+a,0,149;"),
                                                                    ("ML", array.array("B", [255, 255]))])
        return [rec]
    bam = write_bam(tmp_path / "m.bam", records)
    (r,) = _load(toy_map, bam, loader_options=dict(include_methylation=True, hide_terminal_gaps=False)).rows
    # The second mark (source 5050) is inside the 100 bp source insertion [5000, 5100): dropped once, not twice.
    assert r["live_lift"]["dropped"]["points"] == 1
    assert r["methyl"] == r["methyl_m6a"] == [5910]


def test_haplotypes_by_label_and_unknown_values_raise(toy_map, tmp_path):
    bam = write_bam(tmp_path / "h.bam", _records)
    assert {r["live_lift"]["hap_label"] for r in _load(toy_map, bam, haplotypes=["mat"]).rows} == {"MAT"}
    with pytest.raises(ll.LiftSettingsError):
        _load(toy_map, bam, haplotypes=["HG002#9"])
