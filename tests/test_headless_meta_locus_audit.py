"""Regression tests for the audit of the headless meta-locus work: public refusal of session meta-loci, the numbers'
filter context, pool eligibility, panel scope, the server-metaprofile export, contig renaming with a spec, seed 0,
drawing caps and site provenance, clone eviction, session working-set overrides, the meta axis sign, JS rounding."""
from __future__ import annotations

import contextlib
import json
import shutil
import sys
from pathlib import Path

import pytest

from test_headless_meta_locus import DEMO, app, bed_file, render  # noqa: F401

REPO = Path(__file__).resolve().parents[1]


def meta_session(did, bed, chrom="meta:0011223344556677", **fe):
    return {"version": "2.0", "datasets": [{"id": did, "path": str(DEMO), "label": "demo"}],
            "viewport": {"chrom": chrom, "start": 0, "end": 3000},
            "frontend": {"chrom": chrom, "start": 0, "end": 3000,
                         "metaLocus": {"bed_path": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 1, "count": 150,
                                       "extra_entries": [], "pool_id": chrom[5:]}, **fe}}


def test_a_public_server_refuses_a_session_meta_locus_before_reading_its_bed(app, monkeypatch):
    client, add, tmp = app
    did = add(DEMO, "demo")
    import routers.files as files
    read = []
    monkeypatch.setattr(files, "read_bed_text", lambda path: read.append(path) or ("", path))
    import services.figure.api as fapi
    monkeypatch.setattr(fapi, "_public_mode", lambda: True)
    r = client.post("/api/render", json={"engine": "headless", "format": "svg",
                                         "session": meta_session(did, tmp / "anything.bed")})
    assert r.status_code == 403 and "public" in r.json()["error"] and read == []


def test_numbers_read_inside_the_views_filter_context_and_fetch_when_pools_cannot_answer(app, monkeypatch):
    client, add, tmp = app
    add(DEMO, "demo")
    import services.figure.compose as compose
    entered = []
    real = compose.view_filters

    def spy(spec, state):
        entered.append(spec.chrom)
        return real(spec, state)
    monkeypatch.setattr(compose, "view_filters", spy)
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    assert client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "spec": {"measures": ["layer:nuc"]}}).status_code == 200
    assert client.post("/api/meta_locus/profile", json={"meta_locus": spec, "channels": ["nuc"]}).status_code == 200
    assert len(entered) == 2 and all(c.startswith("meta:") for c in entered)

    from services import window_quant as wq
    pool = {"reads": [{"id": "r", "intervals": [[0, 10, 1]], "layers": {"nuc": {"intervals": [[0, 5, 5]]}}}],
            "chrom": "c", "start": 0, "end": 10, "resolution": 500, "layers": ["nuc"], "marks": False}
    view = {"chrom": "c", "start": 0, "end": 10}
    assert wq.pools_usable(["nuc"], [{"pool": pool}], view)
    assert not wq.pools_usable(["m6a"], [{"pool": pool}], view)           # marks not fetched
    assert not wq.pools_usable(["nuc"], [{"pool": {**pool, "end": 11}}], view)  # another view
    assert wq.pool_layer_data(["m6a"], [{"key": "k", "datasetId": "d", "pool": pool}], view, {"from": 0, "to": 5},
                              0.1, "curve", False) is None


def test_quantify_reads_the_selected_panel_and_its_scope(app, tmp_path):
    client, add, tmp = app
    copy = tmp_path / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    a, b = add(DEMO, "A"), add(copy, "B")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    session = client.post("/api/render/cluster", json={"meta_locus": spec, "k": 2, "seed": "s"}).json()["session"]
    both = client.post("/api/meta_locus/quantify", json={"session": session, "window": [-200, 50],
                                                         "spec": {"measures": ["layer:nuc"], "comparison": "datasets"}}).json()
    assert {g["id"] for g in both["result"]["groups"]} == {f"ds:{a}", f"ds:{b}"}
    session["frontend"]["selectedDatasets"] = [a]
    one = client.post("/api/meta_locus/quantify", json={"session": session, "window": [-200, 50],
                                                        "spec": {"measures": ["layer:nuc"], "comparison": "datasets"}}).json()
    assert [g["id"] for g in one["result"]["groups"]] == [f"ds:{a}"]


def test_the_profile_export_is_the_server_metaprofile_where_the_browser_draws_it(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    prof = client.post("/api/meta_locus/profile", json={"meta_locus": spec, "channels": ["nuc"]}).json()
    g = prof["groups"][f"dataset:{did}"]
    assert g["source"] == "server metaprofile" and g["coverage"] is None
    # equal to what the figure draws there (composite.dataset_profile, the server's profile)
    import server as srv
    from services.figure.data import DataCache
    from services.figure.meta_locus import draw_whole_working_set, resolve
    from services.figure.spec import resolve_spec
    from services.figure.tracks import TrackContext
    from services.figure.tracks.composite import dataset_profile
    mv = resolve(srv.state, spec, None)
    fs = resolve_spec(srv.state, chrom=mv.chrom, start=0, end=mv.width, source="defaults")
    draw_whole_working_set(fs, mv, explicit_cap=False)
    ctx = TrackContext(srv.state, fs, fs.panels[0], DataCache(srv.state, fs), fs.width)
    drawn = dataset_profile(ctx, did)
    assert g["channels"]["nuc"] == pytest.approx(drawn["layers"]["nuc"], abs=1e-12)
    assert "\tNA" in prof["tsv"].splitlines()[2]


def test_a_spec_with_a_meta_session_still_renames_its_contig_and_seed_zero_is_kept(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    import server as srv
    from services.figure import meta_locus as ml
    session = meta_session(did, bed, readSortOrder={"meta:0011223344556677": ["x"]})
    mv = ml.resolve(srv.state, {"bed": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 4, "count": 100}, session)
    assert mv.session["viewport"]["chrom"] == mv.chrom and mv.chrom in mv.session["frontend"]["readSortOrder"]
    assert ml.spec_from_session({"bed_path": str(bed), "seed": 0})["seed"] == 0
    assert ml.spec_from_session({"bed_path": str(bed)})["seed"] == 1


def test_caps_cover_added_reads_and_every_assigned_read_has_its_site(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    import server as srv
    from services import meta_locus_jobs as mj
    from services.figure import meta_locus as ml
    mv = ml.resolve(srv.state, {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 1, "count": 3}, None)
    ix = mv.pool.index_for(did)
    ranked = [int(e) for e in ix.ranked(1, True)[:40]]
    # an added read that is also in the first ranks: the decoder fills the count without it, then adds it
    first = ranked[0]
    extra = [[did, ix.names[int(ix.mol[first])], int(ix.site[first])]]
    mv2 = ml.resolve(srv.state, {"pool_id": mv.pool.pool_id, "seed": 1, "count": 3, "extra_entries": extra}, None)
    decoded = mj._decode_view(mv2.view, did, dict(include_methylation=False, include_layers=False, include_layer_qualities=False))
    assert ml.view_share(mv2, did) >= len(decoded) == 4
    # a read beyond the view's first ranks (as a top-up would take) still gets its site
    late = ranked[30]
    name, site = ix.names[int(ix.mol[late])], int(ix.site[late])
    rid = f"{name}#site{site}" if bool(ix.shared[late]) else name
    got = ml.read_sites(mv2, {did: [rid]})[did][rid]
    assert got and got["site"] == site and got["read_name"] == name and got["key"] == f"{name}#site{site}"


def test_leased_clones_are_never_evicted_and_idle_ones_are_capped(app):
    client, add, tmp = app
    add(DEMO, "demo")
    import server as srv
    from services import meta_locus_jobs as mj
    from services.figure import meta_locus as ml
    mv = ml.resolve(srv.state, {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 1, "count": 10}, None)
    held = mv.view  # leased by resolve() until release()
    burst = [mj.view_clone(mv.pool, seed=s, count=10) for s in range(2, 2 + mj.MAX_VIEW_CLONES + 4)]
    assert mj.pool_for_chrom(held.chrom) is held
    for c in burst:
        mj.release_view_clone(c)
    owned = [p for p in mj._view_pools.values() if p.owner == held.owner]
    assert held in owned and len([p for p in owned if p.leases == 0]) <= mj.MAX_VIEW_CLONES
    mv.release()
    mv.release()  # idempotent
    assert held.leases == 0
    # every route releases its lease: after a figure, a quantify and a profile nothing is leased
    spec = {"pool_id": mv.pool.pool_id, "seed": 5, "count": 20}
    assert client.post("/api/render", json={"engine": "headless", "format": "svg", "source": "defaults", "meta_locus": spec}).status_code == 200
    assert client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "spec": {"measures": ["layer:nuc"]}}).status_code == 200
    assert client.post("/api/meta_locus/profile", json={"meta_locus": spec}).status_code == 200
    bad = client.post("/api/meta_locus/quantify", json={"meta_locus": spec, "spec": {"measures": ["fp:x"]}})
    assert bad.status_code == 400
    assert all(p.leases == 0 for p in mj._view_pools.values())


def test_session_working_set_overrides_and_the_meta_axis_ignore_a_selected_gene(app):
    client, add, tmp = app
    did = add(DEMO, "demo")
    bed = bed_file(tmp)
    sys.path.insert(0, str(REPO))
    from browser_client import BrowserClient
    c = BrowserClient.__new__(BrowserClient)
    body = c._meta_numbers_body(None, meta_session(did, bed), 8, 99)
    assert body["session"]["frontend"]["metaLocus"]["seed"] == 8 and body["session"]["frontend"]["metaLocus"]["count"] == 99
    with pytest.raises(ValueError, match="meta-locus view"):
        c._meta_numbers_body(None, {"frontend": {}}, 8, None)
    gene = {"name": "g", "chrom": "chr19", "start": 1, "end": 2, "strand": "-"}
    svg, _ = render(client, session=meta_session(did, bed, selectedGenes=[gene], showRelativeCoords=True, relativeTSS=5))
    assert ">-1,000<" in svg and ">+1,000<" in svg and ">TSS<" in svg


def test_js_rounding_of_halves():
    from services import window_quant as wq
    assert wq._fmt(126.5625) == "126.563" and wq._fmt(-126.5625) == "-126.563" and wq._fmt(0.5) == "0.5"
    s = wq.normalize_spec({"seed": 2.5, "resamples": 50.5, "bootSeed": 3.5})
    assert (s["seed"], s["resamples"], s["bootSeed"]) == (3, 51, 4)


def test_panel_scope_follows_the_browser_rules():
    from services.panel_scope import chart_scope, target_state_keys
    main = ("chr1", 0, 100)
    fe = {"panels": [{"id": "p1", "datasetId": "A", "stateKey": "k1"}, {"id": "p2", "datasetId": "A", "stateKey": "k2"},
                     {"id": "p3", "datasetId": "B"}], "selectedDatasets": ["p1"]}
    assert target_state_keys(fe, ["A", "B"]) == ["k1"]                       # only the selected panel of A
    fe["panels"][2]["linkGroup"] = fe["panels"][0]["linkGroup"] = "g"
    assert target_state_keys(fe, ["A", "B"]) == ["k1", "B"]                  # and its link group
    assert target_state_keys({"panels": fe["panels"]}, ["A", "B"]) == ["k1", "k2", "B"]
    # per-panel navigation: the latest move still on screen is the active view
    per = {"navigationMode": "perPanel", "panels": [
        {"id": "a", "datasetId": "A", "viewportOverride": {"chrom": "chr2", "start": 0, "end": 50}},
        {"id": "b", "datasetId": "B"}],
        "lastMovedPanels": {"none": [{"panelId": "a", "locus": {"chrom": "chr2", "start": 0, "end": 50}, "at": 5}]}}
    view, keys = chart_scope(per, ["A", "B"], ["A", "B"], main)
    assert (view.chrom, keys) == ("chr2", ["A"])
    # the same coordinates on another reference are another view
    refs = {"panels": [{"id": "a", "datasetId": "A"}, {"id": "b", "datasetId": "B", "genome": "hg19"}]}
    view, keys = chart_scope(refs, ["A", "B"], ["A", "B"], main)
    assert view.genome is None and keys == ["A"]


def test_short_server_profiles_and_bins_on_the_server_path(app):
    client, add, tmp = app
    add(DEMO, "demo")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200, "window": [-50, 50]}
    prof = client.post("/api/meta_locus/profile", json={"meta_locus": spec, "channels": ["nuc"]})
    assert prof.status_code == 200, prof.text
    g = next(v for k, v in prof.json()["groups"].items() if k.startswith("dataset:"))
    assert g["source"] == "server metaprofile" and len(g["channels"]["nuc"]) == g["bins"] <= 100
    assert g["n_reads"] is None or g["n_reads"] > 0
    assert prof.json()["view"]["end"] - prof.json()["view"]["start"] == 100
    bins = client.post("/api/meta_locus/profile", json={"meta_locus": spec, "channels": ["nuc"], "bins": 50})
    assert bins.status_code == 400 and "server's metaprofile" in bins.json()["error"]


def test_scope_over_drawn_panels_and_folded_graph_members():
    from services.panel_scope import chart_scope, target_state_keys
    main = ("chr1", 0, 100)
    fe = {"panels": [{"id": "a", "datasetId": "A", "collapsed": True,
                      "viewportOverride": {"chrom": "chr2", "start": 200, "end": 300}},
                     {"id": "b", "datasetId": "B"}],
          "selectedDatasets": ["a"]}
    # the collapsed panel is not drawn headlessly: never scoped (no panel at another view substituted for it)
    view, keys = chart_scope(fe, ["A", "B"], target_state_keys(fe, ["A", "B"], {"b"}), main, {"b"})
    assert keys == [] or all(k == "B" for k in keys)
    graph = {"panels": [{"id": "h", "datasetId": "A", "viewMode": "graph", "graphView": {"role": "host"}},
                        {"id": "m", "datasetId": "B", "collapsed": True, "collapsedByGraphGroup": "h", "graphMemberOf": "h"}],
             "selectedDatasets": ["h"]}
    assert target_state_keys(graph, ["A", "B"]) == ["A", "B"]  # selectedWithHost: the folded member too


def test_no_lease_leaks_on_bad_regions_and_a_rebuilt_pool_never_replaces_a_held_clone(app):
    client, add, tmp = app
    add(DEMO, "demo")
    import dataclasses
    import server as srv
    from services import meta_locus_jobs as mj
    from services.figure import meta_locus as ml
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 1, "count": 10}
    bad = client.post("/api/render/cluster", json={"meta_locus": spec, "region": "not a region", "k": 2})
    assert bad.status_code == 400
    assert all(p.leases == 0 for p in mj._view_pools.values())
    mv = ml.resolve(srv.state, spec, None)
    held = mv.view
    rebuilt = dataclasses.replace(mv.pool, indexes=dict(mv.pool.indexes), instance=next(mj._GENERATIONS))
    other = mj.view_clone(rebuilt, seed=1, count=10)
    assert other is not held and other.pool_id != held.pool_id and mj.pool_for_chrom(held.chrom) is held
    mj.release_view_clone(other)
    mv.release()


def test_short_profile_metadata_matches_its_grid(app):
    client, add, tmp = app
    add(DEMO, "demo")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200, "window": [-50, 50]}
    prof = client.post("/api/meta_locus/profile", json={"meta_locus": spec, "channels": ["nuc"]}).json()
    g = next(v for k, v in prof["groups"].items() if k.startswith("dataset:"))
    assert prof["bins"] == g["bins"] and prof["bin_bp"] == pytest.approx(g["bin_bp"])
    assert f"bins of {g['bin_bp']:g} bp" in prof["tsv"].splitlines()[0]


def test_collapsed_panels_are_named_as_left_out(app, tmp_path):
    client, add, tmp = app
    copy = tmp_path / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    a, b = add(DEMO, "A"), add(copy, "B")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    session = client.post("/api/render/cluster", json={"meta_locus": spec, "k": 2, "seed": "s"}).json()["session"]
    session["frontend"]["panels"] = [{"id": a, "datasetId": a, "contentType": "dataset"},
                                     {"id": b, "datasetId": b, "contentType": "dataset", "collapsed": True}]
    out = client.post("/api/meta_locus/quantify", json={"session": session, "window": [-200, 50],
                                                        "spec": {"measures": ["layer:nuc"], "comparison": "datasets"}}).json()
    assert [g["id"] for g in out["result"]["groups"]] == [f"ds:{a}"] and out["left_out"] == [b]
    assert any(line.startswith("# left out") and b in line for line in out["tsv"].splitlines())
    # a pool over one dataset does not call the other "left out"
    one = client.post("/api/meta_locus/quantify", json={"meta_locus": {**spec, "datasets": [a]}, "window": [-200, 50],
                                                        "spec": {"measures": ["layer:nuc"]}}).json()
    assert one["left_out"] == []


def test_target_keys_fall_back_to_the_dataset_and_named_datasets_get_their_default_panel(app, tmp_path):
    from services.panel_scope import target_state_keys
    graph = {"panels": [{"id": "h", "datasetId": "A", "viewMode": "graph", "graphView": {"role": "host"}},
                        {"id": "m", "datasetId": "B", "collapsed": True, "collapsedByGraphGroup": "h", "graphMemberOf": "h",
                         "linkGroup": "g"},
                        {"id": "c", "datasetId": "C", "linkGroup": "g"}],
             "selectedDatasets": ["h"]}
    assert target_state_keys(graph, ["A", "B", "C"]) == ["A", "B", "C"]  # C via the member's link group: [ds] fallback
    client, add, tmp = app
    copy = tmp_path / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    a, b = add(DEMO, "A"), add(copy, "B")
    spec = {"bed": str(bed_file(tmp)), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 200}
    session = client.post("/api/render/cluster", json={"meta_locus": spec, "k": 2, "seed": "s"}).json()["session"]
    session["frontend"]["panels"] = [{"id": a, "datasetId": a, "contentType": "dataset"}]
    out = client.post("/api/meta_locus/quantify", json={"session": session, "dataset_ids": [a, b], "window": [-200, 50],
                                                        "spec": {"measures": ["layer:nuc"], "comparison": "datasets"}}).json()
    assert {g["id"] for g in out["result"]["groups"]} == {f"ds:{a}", f"ds:{b}"} and out["left_out"] == []
    prof = client.post("/api/meta_locus/profile", json={"session": session, "channels": ["nuc"]}).json()
    assert all("bins" in g and "bin_bp" in g for g in prof["groups"].values())


def test_target_keys_expand_the_selection_over_undrawn_folded_members():
    # Codex R15: a selected graph host A with folded member B (not drawn headlessly) linked to a visible C: B's link
    # group brings C into the target, as in the browser, although B itself has no drawn panel.
    from types import SimpleNamespace as NS
    from services.meta_locus_numbers import _target_keys
    fe = {"panels": [{"id": "h", "datasetId": "A", "viewMode": "graph", "graphView": {"role": "host"}},
                     {"id": "m", "datasetId": "B", "collapsed": True, "collapsedByGraphGroup": "h", "graphMemberOf": "h",
                      "linkGroup": "g"},
                     {"id": "c", "datasetId": "C", "linkGroup": "g"}],
          "selectedDatasets": ["h"]}
    spec = NS(fe=fe, panels=[NS(id="h", dataset_id="A", state_key=None), NS(id="c", dataset_id="C", state_key=None)])
    assert _target_keys(spec, NS(dataset_order=["A", "B", "C"])) == ["A", "C"]


def test_quantify_window_keeps_the_sessions_saved_comparison_unless_asked():
    # Codex R15: the client sent comparison="clusters" when the caller gave none, overriding a session saved with
    # "datasets"; the scripted and CLI defaults did the same.
    from browser_client import BrowserClient
    sent = []
    client = object.__new__(BrowserClient)
    client._post_json_or_raise = lambda path, body: sent.append(body) or {"tsv": ""}
    session = {"frontend": {"windowQuant": {"spec": {"comparison": "datasets"}}}}
    client.quantify_window({"session": session})
    assert "comparison" not in sent[-1]["spec"]
    client.quantify_window({"session": session}, comparison="clusters")
    assert sent[-1]["spec"]["comparison"] == "clusters"
    from fiberbrowser import scripted
    import inspect
    assert inspect.signature(scripted.quantify_session).parameters["comparison"].default is None


def test_live_lifted_datasets_are_left_out_of_headless_numbers_and_named():
    # As usePlotTargets: Plots and Quantify leave live-lifted datasets out, and say so (never silently).
    from types import SimpleNamespace as NS
    from services.meta_locus_numbers import (LIFTED_LEFT_OUT_NOTE, _left_out, _lifted_left_out, _lifted_note,
                                             _target_keys)
    fe = {"panels": [{"id": "r", "datasetId": "R"}, {"id": "l", "datasetId": "L"}], "selectedDatasets": []}
    spec = NS(fe=fe, panels=[NS(id="r", dataset_id="R", state_key=None), NS(id="l", dataset_id="L", state_key=None)],
              chrom="chrT", start=0, end=1000)
    state = NS(dataset_order=["R", "L"],
               datasets={"R": NS(data_type="bam", label="Reference reads"),
                         "L": NS(data_type="bam_livelift", label="HG002 lifted")})
    assert _target_keys(spec, state) == ["R"]
    assert _lifted_left_out(spec, state) == ["HG002 lifted"]
    assert _left_out(state, spec, ["R"]) == []   # reported on its own, not as "not drawn headlessly"
    assert _lifted_note(["HG002 lifted"]) == f"{LIFTED_LEFT_OUT_NOTE}: left out HG002 lifted."
    assert LIFTED_LEFT_OUT_NOTE == "Live-lifted datasets aren't plotted or quantified yet"


def test_lifted_exclusions_name_collapsed_panels_refuse_all_lifted_targets_and_drop_their_layers(monkeypatch):
    # Codex R20: a collapsed lifted panel linked to the selection is named too; a target of lifted datasets only
    # says why nothing is quantified; a lifted dataset's layers are not offered.
    from types import SimpleNamespace as NS
    from services import meta_locus_numbers as mln
    state = NS(dataset_order=["R", "L"], datasets={"R": NS(data_type="bam", label="Reference reads"),
                                                   "L": NS(data_type="bam_livelift", label="HG002 lifted")})
    fe = {"panels": [{"id": "r", "datasetId": "R", "linkGroup": "g"},
                     {"id": "l", "datasetId": "L", "linkGroup": "g", "collapsed": True}], "selectedDatasets": ["r"]}
    spec = NS(fe=fe, panels=[NS(id="r", dataset_id="R", state_key=None, dataset=state.datasets["R"])],
              chrom="chrT", start=0, end=1000)
    assert mln._target_keys(spec, state) == ["R"]
    assert mln._lifted_left_out(spec, state) == ["HG002 lifted"]
    assert mln._lifted_left_out(spec, state, ["R"]) == []        # not asked for: not left out
    only_lifted = NS(fe={"panels": [{"id": "l", "datasetId": "L"}], "selectedDatasets": ["l"]},
                     panels=[NS(id="l", dataset_id="L", state_key=None, dataset=state.datasets["L"])],
                     chrom="chrT", start=0, end=1000)
    assert mln._target_keys(only_lifted, state) == []
    with pytest.raises(mln.NumbersError, match="Live-lifted datasets aren't plotted or quantified yet: left out HG002"):
        mln._refuse_all_lifted(only_lifted, state, [], None)
    seen = []
    monkeypatch.setattr("services.figure.defaults.metaprofile_source_entries", lambda ds: seen.append(ds) or [])
    # Production figure panels carry the dataset as the /api/datasets dict (services/figure/spec.build_panels).
    from models.domain import Dataset
    from services.figure.defaults import dataset_dict
    ref, lifted = Dataset("R", "/r.bam", "R"), Dataset("L", "/l.bam", "L")
    lifted.data_type = "bam_livelift"
    r, l = dataset_dict(ref), dataset_dict(lifted)
    assert l["data_type"] == "bam_livelift"
    mln.layer_entries(NS(panels=[NS(dataset=r), NS(dataset=l)]))
    assert seen == [[r]]
    # A restriction to the lifted dataset itself still names it (selection resolved over every panel first).
    linked = NS(fe=fe, panels=[NS(id="r", dataset_id="R", state_key=None, dataset=r)], chrom="chrT", start=0, end=1000)
    assert mln._lifted_left_out(linked, state, ["L"]) == ["HG002 lifted"]
