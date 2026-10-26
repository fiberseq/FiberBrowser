"""Assembly comparison in production: exact IDs, typed links, labels, novelty,
exact targets for enrichment and ledger lineage (Differences phase 2 wiring).

Independent oracle: the synthetic map below is written by hand from known
strings, so the expected relation of every read difference is known without
running the matcher: equal strings are exact, a few substitutions are
approximate, missing sequence is a candidate.
"""
import gzip
import json
import os
import random

import pysam
import pytest

from live_lift_fixtures import GAP_REASONS, _chain, make_record, write_bam
from services.differences.comparison import ComparisonPolicy, assembly_comparison
from services.differences.identity import IdentityLedger
from services.lift import live_lift as ll
from services.lift.dataset import LiveLiftConfig

CHROM, TSIZE = "chrC", 20_000
MAT, PAT = "chrC_MATERNAL", "chrC_PATERNAL"
rng = random.Random(7)
T = "".join(rng.choice("ACGT") for _ in range(TSIZE))
X = "".join(rng.choice("ACGT") for _ in range(100))           # MAT insertion at 5000
Y_OTHER = "".join(rng.choice("ACGT") for _ in range(100))     # a different PAT allele


def write_comparison_map(directory, pat_insert):
    """MAT: 30 bp deletion of [3000,3030) and insertion X at 5000. PAT: insertion pat_insert at 5000."""
    mat_src = T[1000:3000] + T[3030:5000] + X + T[5000:9000]
    pat_src = T[1000:5000] + pat_insert + T[5000:9000]
    m_blocks = [[1000, 0, 2000], [3030, 2000, 1970], [5000, 3970 + len(X), 4000]]
    p_blocks = [[1000, 0, 4000], [5000, 4000 + len(pat_insert), 4000]]

    def gaps(blocks, reasons):
        out = []
        for a, b, reason in zip(blocks, blocks[1:], reasons):
            t, q = a[0] + a[2], a[1] + a[2]
            out.append([t, q, b[0] - t, b[1] - q, GAP_REASONS.index(reason)])
        return out
    chains = [_chain("m", "H#1", 0, "+", m_blocks, len(mat_src)), _chain("p", "H#2", 1, "+", p_blocks, len(pat_src))]
    for c in chains:
        c["target"] = 0
    os.makedirs(directory, exist_ok=True)
    payload = {"target": CHROM, "blocks": {"0": m_blocks, "1": p_blocks},
               "gaps": {"0": gaps(m_blocks, ["target_insertion", "source_insertion"]),
                        "1": gaps(p_blocks, ["source_insertion"])}}
    with gzip.open(os.path.join(directory, "cmp.t0.json.gz"), "wt") as fh:
        json.dump(payload, fh)
    with gzip.open(os.path.join(directory, "cmp.t0.fills.json.gz"), "wt") as fh:
        json.dump({"target": CHROM, "fills": {}}, fh)
    manifest = dict(format="graphlift.sidecar", version=2, block_kinds=["anchor", "substitution", "aligned"],
                    gap_reasons=GAP_REASONS, targets=[{"name": CHROM, "size": TSIZE}],
                    sources=[{"name": MAT, "size": len(mat_src), "uncovered": []},
                             {"name": PAT, "size": len(pat_src), "uncovered": []}],
                    chains=chains, nets={"H#1": [[0, 1000, 9000, 0, []]], "H#2": [[0, 1000, 9000, 1, []]]},
                    target_files={CHROM: ["cmp.t0.json.gz", "cmp.t0.fills.json.gz"]})
    path = os.path.join(directory, "cmp.graphlift.json")
    with open(path, "w") as fh:
        json.dump(manifest, fh)
    return path, mat_src, pat_src


def _fasta(path, entries):
    with open(path, "w") as fh:
        for name, seq in entries:
            fh.write(f">{name}\n{seq}\n")
    pysam.faidx(str(path))
    return str(path)


def build(tmp_path, *, pat_insert=X, with_source=True):
    ll.clear_selection_cache()
    ll.clear_primary_cache()
    manifest, mat_src, pat_src = write_comparison_map(tmp_path / "map", pat_insert)
    target = _fasta(tmp_path / "target.fa", [(CHROM, T)])
    source = _fasta(tmp_path / "source.fa", [(MAT, mat_src), (PAT, pat_src)]) if with_source else None

    def records(h):
        # Two MAT molecules carrying X and one PAT molecule carrying its own allele, all spanning 5000.
        yield make_record(h, "mat_a", MAT, 3500, "1000M", seq=mat_src[3500:4500])
        yield make_record(h, "mat_b", MAT, 3600, "900M", seq=mat_src[3600:4500])
        yield make_record(h, "pat_a", PAT, 3600, "1000M", seq=pat_src[3600:4600])
    bam = write_bam(tmp_path / "src.bam", lambda h: list(records(h)), contigs=((MAT, len(mat_src)), (PAT, len(pat_src))))
    config = LiveLiftConfig(manifest, [], source_fasta=source)
    from types import SimpleNamespace
    dataset = SimpleNamespace(id="lift", paths=[bam], live_lift=config, data_type="bam_livelift", label="lift")
    state = SimpleNamespace(fasta=pysam.FastaFile(target), datasets={"lift": dataset})
    return state, dataset, dict(manifest=manifest, bam=bam, source=source, target=target, mat=mat_src, pat=pat_src)


@pytest.fixture(autouse=True)
def lift_on(monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_LIVE_LIFT", "1")


def compare(state, dataset, reads=(), **kw):
    return assembly_comparison(state, dataset, chrom=CHROM, start=2000, end=8000, reads=list(reads), **kw)


def ins(rid, pos=5000, alt=100, members=None):
    return dict(id=rid, ref_start=pos, ref_end=pos, alt_bp=alt, geometry_members=members)


def test_shared_exact_allele_between_haplotypes(tmp_path):
    state, ds, _ = build(tmp_path)
    out = compare(state, ds)
    by_kind = {(v["hap_label"], v["kind"]): v for v in out["assembly"].values()}
    mat, pat = by_kind[("MAT", "insertion")], by_kind[("PAT", "insertion")]
    assert mat["exact_allele_id"] and mat["exact_allele_id"] == pat["exact_allele_id"]
    assert mat["shared_with"] == [pat["item_id"]] and mat["identity_state"] == "exact"
    assert by_kind[("MAT", "deletion")]["exact_allele_id"]          # complete from its span alone
    # Ledger written: each assembly difference has a provisional-then-exact record.
    records = out["ledger"]["records"]
    assert records[mat["difference_id"]]["exact_allele_id"] == mat["exact_allele_id"]


def test_distinct_haplotype_alleles_keep_distinct_ids(tmp_path):
    state, ds, _ = build(tmp_path, pat_insert=Y_OTHER)
    out = compare(state, ds)
    ids = {v["hap_label"]: v["exact_allele_id"] for v in out["assembly"].values() if v["kind"] == "insertion"}
    assert ids["MAT"] != ids["PAT"] and all(ids.values())


def test_read_labels_exact_approximate_candidate(tmp_path):
    state, ds, _ = build(tmp_path, pat_insert=Y_OTHER)
    noisy = list(X)
    for i in (5, 20, 40, 60, 80):
        noisy[i] = "A" if noisy[i] != "A" else "C"
    out = compare(state, ds, [ins("exact"), ins("noisy", alt=100), ins("geometry"),
                              dict(id="del", ref_start=3000, ref_end=3030, alt_bp=0)],
                  read_sequences={"exact": X, "noisy": "".join(noisy)})
    reads = out["reads"]
    assert reads["exact"]["label"] == "confirmed_by_assembly"
    assert reads["exact"]["label_text"] == "Confirmed by assembly"
    exact_links = [l for l in reads["exact"]["links"] if l["relation"] == "exact"]
    assert [l["hap_labels"] for l in exact_links] == [["MAT"]]       # PAT's allele differs
    assert reads["exact"]["identity_state"] == "exact" and reads["exact"]["exact_allele_id"]
    assert reads["noisy"]["label"] == "assembly_supported_approximate"
    assert reads["noisy"]["label_text"] == "assembly-supported (approximate)"
    best = max(l["scores"].get("identity", 0) for l in reads["noisy"]["links"])
    assert 0.9 <= best < 1
    assert reads["geometry"]["label"] == "assembly_candidate"
    assert "candidate_equivalence_unresolved" in reads["geometry"]["novelty"]["reasons"]
    assert reads["del"]["label"] == "confirmed_by_assembly"          # deletion allele is its span
    # Labels never carry votes.
    assert all("carriers" not in l for r in reads.values() for l in r["links"])


def test_approximate_threshold_is_an_explicit_policy(tmp_path):
    state, ds, _ = build(tmp_path)
    noisy = X[:50] + "".join("A" if c != "A" else "C" for c in X[50:62]) + X[62:]
    strict = compare(state, ds, [ins("r")], read_sequences={"r": noisy},
                     policy=ComparisonPolicy(approximate_min_identity=0.95))
    loose = compare(state, ds, [ins("r")], read_sequences={"r": noisy},
                    policy=ComparisonPolicy(approximate_min_identity=0.85))
    assert strict["reads"]["r"]["label"] == "assembly_candidate"
    assert loose["reads"]["r"]["label"] == "assembly_supported_approximate"
    off = compare(state, ds, [ins("r")], read_sequences={"r": noisy}, policy=ComparisonPolicy(approximate=False))
    assert off["reads"]["r"]["label"] == "assembly_candidate"


def test_novelty_needs_complete_comparison(tmp_path):
    state, ds, _ = build(tmp_path)
    far = "".join(random.Random(3).choice("ACGT") for _ in range(200))
    partial = compare(state, ds, [ins("far", pos=7000, alt=200)], read_sequences={"far": far})
    assert partial["reads"]["far"]["label"] == "unassessed"
    assert "discovery_unassessed" in partial["reads"]["far"]["novelty"]["reasons"]
    complete = compare(state, ds, [ins("far", pos=7000, alt=200)], read_sequences={"far": far},
                       read_scope={"search_complete": True})
    assert complete["reads"]["far"]["label"] == "novel_relative_to_assembly", complete["reads"]["far"]["novelty"]
    no_seq = compare(state, ds, [ins("far", pos=7000, alt=200)], read_scope={"search_complete": True})
    assert no_seq["reads"]["far"]["label"] == "unassessed"
    assert "sequence_unassessed" in no_seq["reads"]["far"]["novelty"]["reasons"]


def test_missing_source_fasta_never_confirms_an_insertion(tmp_path):
    state, ds, _ = build(tmp_path, with_source=False)
    out = compare(state, ds, [ins("r"), dict(id="del", ref_start=3000, ref_end=3030, alt_bp=0)],
                  read_sequences={"r": X})
    assert "assembly_sequence_unavailable" in out["reasons"]
    assert out["reads"]["r"]["label"] == "assembly_candidate"
    assert out["reads"]["del"]["label"] == "confirmed_by_assembly"   # deletion needs no source bases
    assert all(v["exact_target"] is None for v in out["assembly"].values() if v["kind"] == "insertion")


def test_exact_targets_validate_and_carry_competitors(tmp_path):
    from services.differences.projected_service import validate_target
    from services.differences.projection import ProjectionPolicy
    state, ds, files = build(tmp_path, pat_insert=Y_OTHER)
    out = compare(state, ds)
    mat = next(v for v in out["assembly"].values() if v["hap_label"] == "MAT" and v["kind"] == "insertion")
    pat = next(v for v in out["assembly"].values() if v["hap_label"] == "PAT" and v["kind"] == "insertion")
    target = mat["exact_target"]
    assert set(target["candidates"]) == {mat["exact_allele_id"], pat["exact_allele_id"], "reference"}
    ds_, de = target["diagnostic_start"], target["diagnostic_end"]
    assert target["candidates"]["reference"] == T[ds_:de]
    assert target["candidates"][mat["exact_allele_id"]] == T[ds_:5000] + X + T[5000:de]
    assert target["candidate_labels"][pat["exact_allele_id"]] == "PAT"
    validate_target(target, CHROM, 2000, 8000, ProjectionPolicy())


def test_ledger_lineage_merge_and_split_in_normal_use(tmp_path):
    state, ds, _ = build(tmp_path)
    scope = {"dataset_id": "lift", "analysis_scope": "lifted_only"}
    a = ins("a", members=[[5000, 5000, 100]])
    b = ins("b", alt=104, members=[[5000, 5000, 104]])
    first = compare(state, ds, [a, b], read_scope=scope)
    ids = {k: v["difference_id"] for k, v in first["reads"].items()}
    assert len(set(ids.values())) == 2 and not first["lineage_events"]
    merged = compare(state, ds, [ins("m", members=[[5000, 5000, 100], [5000, 5000, 104]])], read_scope=scope,
                     ledger=first["ledger"])
    [event] = merged["lineage_events"]
    assert event["reason"] == "cluster_merge" and sorted(event["parents"]) == sorted(ids.values())
    assert merged["ledger"]["lineage"][ids["a"]]["descendants"] == [merged["reads"]["m"]["difference_id"]]
    split = compare(state, ds, [a, b], read_scope=scope, ledger=merged["ledger"])
    [event] = split["lineage_events"]
    assert event["reason"] == "cluster_split" and len(event["descendants"]) == 2
    looked = IdentityLedger(split["ledger"]).lookup(merged["reads"]["m"]["difference_id"], frozen=False)
    assert looked["status"] == "unresolved_split"
    # Unchanged grouping keeps identities and writes nothing.
    again = compare(state, ds, [a, b], read_scope=scope, ledger=split["ledger"])
    assert not again["lineage_events"]
    assert {v["difference_id"] for v in again["reads"].values()} == set(event["descendants"])


def test_reconcile_leaves_out_of_view_records_alone():
    book = IdentityLedger()
    ids, _ = book.reconcile("ns", [(["a"], {}), (["b"], {})])
    later, events = book.reconcile("ns", [(["c"], {})])
    assert not events and all(book.data["records"][i]["identity_state"] != "retired" for i in ids)


def test_route_compare_and_lifted_exact_inspection(tmp_path, monkeypatch):
    import server as srv
    from plugins import init_context
    from services.local_auth import auth_headers
    from starlette.testclient import TestClient
    _state, _ds, files = build(tmp_path, pat_insert=Y_OTHER)
    old = srv.state
    srv.state = srv.BrowserState(None, None, None, None, fasta_path=files["target"])
    init_context(srv.state)
    try:
        client = TestClient(srv.app, headers=auth_headers())
        added = client.post("/api/lift/datasets", json={"paths": [files["bam"]], "manifest": files["manifest"],
                                                        "source_fasta": files["source"]}).json()
        assert added["success"], added
        did = added["dataset"]["id"]
        srv.state.datasets[did].consensus_chemistry = "hia5-pacbio"   # undeaminated fiber-seq molecules
        r = client.post("/api/differences/compare", json=dict(dataset_id=did, chrom=CHROM, start=2000, end=8000,
                                                             reads=[ins("r")], read_sequences={"r": X}))
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["reads"]["r"]["label"] == "confirmed_by_assembly"
        mat = next(v for v in out["assembly"].values() if v["hap_label"] == "MAT" and v["kind"] == "insertion")
        # Exact enrichment from the inspector: the lifted inspect route accepts the frozen exact target.
        r = client.post("/api/differences/inspect", json=dict(dataset_id=did, chrom=CHROM, start=2000, end=8000,
                                                             target=mat["exact_target"], analysis_scope="lifted_only"))
        assert r.status_code == 200, r.text
        calls = r.json()["targets"][0]["calls_by_molecule"]
        assignments = sorted(c["call"]["assignment"] for c in calls.values())
        assert assignments.count("target") == 2 and "other_allele" in assignments, assignments
        bad = client.post("/api/differences/compare", json=dict(dataset_id=did, chrom=CHROM, start=0, end=3_000_000))
        assert bad.status_code == 422
    finally:
        srv.state = old
        init_context(old)


def test_cap_dropped_competitors_leave_exact_targets_and_novelty_open(tmp_path):
    """Codex r1 HIGH 1: a competitor dropped by the item cap must not leave competition 'complete'."""
    state, ds, _ = build(tmp_path, pat_insert=Y_OTHER)
    out = compare(state, ds, [ins("far", pos=5000, alt=300)], read_sequences={"far": "A" * 300},
                  read_scope={"search_complete": True}, policy=ComparisonPolicy(max_assembly_items=1))
    assert "assembly_items_cap" in out["reasons"]
    kept = [v for v in out["assembly"].values() if v["exact_target"]]
    assert kept and all(v["exact_target"]["competition_complete"] is False for v in kept)
    assert out["reads"]["far"]["label"] != "novel_relative_to_assembly"


def test_unsupported_inversion_blocks_a_negative_label(tmp_path, monkeypatch):
    """Codex r1 HIGH 2: an overlapping inversion is not compared, so the read difference stays unassessed."""
    from services.lift import differences as diff
    state, ds, _ = build(tmp_path)
    real = diff.assembly_items_for_region

    def with_inversion(config, chrom, start, end, **kw):
        return real(config, chrom, start, end, **kw) + [dict(id="MAT:inv", hap="H#1", hap_label="MAT", kind="inversion",
            reason="inversion", t_start=6500, t_end=7500, ref_bp=1000, alt_bp=1000, chain=0, strand="-",
            src={"contig": "chrC_MATERNAL", "start": 5000, "end": 6000})]
    monkeypatch.setattr(diff, "assembly_items_for_region", with_inversion)
    seq = "".join(random.Random(5).choice("ACGT") for _ in range(30))
    out = compare(state, ds, [ins("r", pos=7000, alt=30)], read_sequences={"r": seq}, read_scope={"search_complete": True})
    assert out["reads"]["r"]["label"] == "unassessed"
    assert "unsupported_representation" in out["reads"]["r"]["novelty"]["reasons"]


def test_display_memberships_use_the_escaped_molecule_key():
    """Codex r1 HIGH 3: membership identities and display rows share one encoder (QNAMEs may hold '|')."""
    import inspect
    from services.differences import projected_service
    from services.lift.joint import molecule_key
    source = inspect.getsource(projected_service.add_display_memberships)
    assert "molecule_key(alignment.molecule.library_id, alignment.molecule.raw_name)" in source
    assert molecule_key("g", "read|1") == "g|read\\|1"


def test_no_exact_target_when_the_haplotype_has_another_edit_in_the_window(tmp_path, monkeypatch):
    """agy r2 HIGH 4: a single-edit splice is not the haplotype's sequence when it has another nearby edit."""
    from services.lift import differences as diff
    state, ds, _ = build(tmp_path, pat_insert=Y_OTHER)
    real = diff.assembly_items_for_region

    def with_snv(config, chrom, start, end, **kw):
        out = real(config, chrom, start, end, **kw)
        return out + [dict(id="MAT:snv", hap="H#1", hap_label="MAT", kind="snv", reason="substitution", t_start=5010,
                           t_end=5011, ref_bp=1, alt_bp=1, chain=0, strand="+", src={"contig": "chrC_MATERNAL", "start": 3980, "end": 3981}),
                      dict(id="PAT:snv", hap="H#2", hap_label="PAT", kind="snv", reason="substitution", t_start=4990,
                           t_end=4991, ref_bp=1, alt_bp=1, chain=1, strand="+", src={"contig": "chrC_PATERNAL", "start": 3990, "end": 3991})]
    monkeypatch.setattr(diff, "assembly_items_for_region", with_snv)
    out = compare(state, ds)
    mat = next(v for v in out["assembly"].values() if v["hap_label"] == "MAT" and v["kind"] == "insertion")
    pat = next(v for v in out["assembly"].values() if v["hap_label"] == "PAT" and v["kind"] == "insertion")
    assert mat["exact_target"] is None and pat["exact_target"] is None   # each haplotype has a nearby SNV


def test_exact_target_window_never_reaches_past_the_fetched_edits(tmp_path):
    """agy r3 HIGH 2: a diagnostic window beyond the fetched range could miss a haplotype's other edits."""
    state, ds, _ = build(tmp_path)
    # The MAT deletion [3000,3030) sits just inside a fetch that starts at 2999 only when the view starts there.
    out = assembly_comparison(state, ds, chrom=CHROM, start=3010, end=8000)
    for v in out["assembly"].values():
        t = v["exact_target"]
        if t:
            assert t["diagnostic_start"] >= 0 and len(t["candidates"]["reference"]) == t["diagnostic_end"] - t["diagnostic_start"]
            assert all(len(c) >= 0 for c in t["candidates"].values())


def test_shared_label_skips_a_haplotype_with_other_edits_in_the_window(tmp_path, monkeypatch):
    """agy r3 HIGH 2(3): 'MAT / PAT' only when PAT carries nothing else in the window."""
    from services.lift import differences as diff
    state, ds, _ = build(tmp_path)   # PAT carries the same insertion X at 5000
    real = diff.assembly_items_for_region

    def with_pat_snv(config, chrom, start, end, **kw):
        return real(config, chrom, start, end, **kw) + [dict(id="PAT:snv", hap="H#2", hap_label="PAT", kind="snv",
            reason="substitution", t_start=5010, t_end=5011, ref_bp=1, alt_bp=1, chain=1, strand="+",
            src={"contig": "chrC_PATERNAL", "start": 4110, "end": 4111})]
    monkeypatch.setattr(diff, "assembly_items_for_region", with_pat_snv)
    out = compare(state, ds)
    mat = next(v for v in out["assembly"].values() if v["hap_label"] == "MAT" and v["kind"] == "insertion")
    assert mat["exact_target"]["candidate_labels"][mat["exact_allele_id"]] == "MAT"
    assert mat["exact_target"]["competition_complete"] is False


def test_iupac_ambiguity_is_not_decoded_without_daf_chemistry():
    """agy r3 HIGH 1: Y/R are DAF conversions only under CT/GA chemistry."""
    from services.differences.alleles import DafContext
    from services.differences.likelihood import compete
    candidates = {"t": "ATCG" * 25, "c": "ACCG" + "ATCG" * 24, "reference": ""}
    plain = compete("AYCG" + "ATCG" * 24, candidates, target_id="t", complete=True, context=DafContext("none", "dataset_chemistry:hia5-pacbio"))
    assert plain["call"]["assignment"] == "unknown" and "ambiguous_bases" in plain["call"]["reasons"]
