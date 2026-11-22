"""Packaged-app smoke (opt-in): the browser-driven checks of the 3.1.0 release smoke, as tests.

Each test opens the built app headless on its own scratch HOME (tests/app_smoke/conftest.py) and drives its UI with
a small Node Playwright script in tests/app_smoke/ui/ (the frontend's Playwright, headless Chromium/WebKit).

- layer colours: a nucleosome colour picked in Labels -> Layer colours repaints the read track, is saved as the
  default, and after a restart on the same HOME is the read track's colour and the source shown;
- cluster legend: every k-means Overview card has the same legend and geometry, a cluster without a layer keeps the
  full legend with a hollow entry, a user layer colour reaches every card;
- Plots Compare with summary: Compare needs two groups; by cluster, A − B with Summary gives one value and interval;
  Size enrichment while comparing turns Summary off with the reason;
- full-UI capture: Export -> Capture full UI downloads a PNG with the reads drawn, in WebKit and Chromium;
- sessions opened during start-up: a session opened as soon as the page shows Open keeps its datasets, also when the
  start-up dataset list is held until after the import;
- graph: the bundled graph helper answers; with a graph package configured, the Graph view draws it;
- FiberHMM updater: the app's own update check, against a PyPI index served by a loopback proxy with a throwaway CA,
  offers the right release in the API and the UI, and installs nothing.

Optional inputs:
    FIBERBROWSER_APP_SMOKE_SESSION_RUNS=3            how many fresh launches each session test makes (default 3)
    FIBERBROWSER_APP_SMOKE_GRAPH_PACKAGE=/path/pkg   a graph package (graphlift output) for the graph render test
    FIBERBROWSER_APP_SMOKE_GRAPH_REGION=chr:start-end  a region the package covers (required with the package)
    FIBERBROWSER_APP_SMOKE_GRAPH_BAM=/path/x.bam     optional: a BAM on that reference, opened as a dataset
    FIBERBROWSER_APP_SMOKE_GRAPH_GENOME=dm6          optional: declared as the current genome (no FASTA is loaded)
    FIBERBROWSER_APP_SMOKE_NETWORK=1                 the updater test reads the live PyPI index (read-only, from the
                                                     test process) and serves that to the app; otherwise a synthetic one
    FIBERBROWSER_APP_SMOKE_PROXY_PORT=18961          the loopback port of the PyPI proxy (default: any free port)
The app itself never reaches the network: every instance has a dead proxy, or the PyPI proxy that answers only the
FiberHMM index.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

APP = os.environ.get("FIBERBROWSER_APP_SMOKE_APP", "")  # see tests/app_smoke/conftest.py
PICK = "#ffd400"
PICK_RGB = (255, 212, 0)


def _near(rgb, want=PICK_RGB, tol=24) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(rgb, want))


def _demo(app) -> dict:
    demo = app.call("POST", "/api/demo/load")
    assert demo.get("success"), demo
    reg = demo["region"]
    return {"chrom": reg["chrom"], "start": int(reg["start"]), "end": int(reg["end"])}


def _version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def test_layer_colour_ui_applies_and_survives_a_restart(packaged_app, ui_driver):
    app = packaged_app("layer_colour_ui")
    region = _demo(app)
    set_ = ui_driver("layer_colours.mjs", {"base": app.base, "region": region, "phase": "set", "colour": PICK})
    before, after = set_["before"], set_["after_pick"]
    assert before and before["green"] > 0 and before["picked"] == 0, before
    assert after["picked"] > 0 and after["green"] < before["green"] * 0.1, (before, after)
    assert re.search(r"this session", set_["source_after_pick"] or "", re.I), set_["source_after_pick"]
    # Saved as the default (the session's own pick still shows as "this session" until the next start).
    assert re.search(r"as your defaults?", set_["save_message"] or "", re.I), set_["save_message"]
    assert set_["store_end"]["user"].get("nuc") == PICK, set_["store_end"]
    assert set_["prefs"].get("layer_colors", {}).get("nuc") == PICK, set_["prefs"]
    assert not set_["page_errors"], set_["page_errors"]
    app.stop()

    again = packaged_app("layer_colour_ui")
    assert again.call("GET", "/api/preferences/analysis").get("layer_colors", {}).get("nuc") == PICK
    region = _demo(again)
    kept = ui_driver("layer_colours.mjs", {"base": again.base, "region": region, "phase": "after-restart", "colour": PICK})
    assert re.search(r"your default", kept["source_fresh"] or "", re.I), kept["source_fresh"]
    assert kept["after_restart"]["picked"] > 0 and kept["after_restart"]["green"] < before["green"] * 0.1, kept["after_restart"]
    assert not kept["page_errors"], kept["page_errors"]


def test_cluster_overview_legend_and_user_layer_colour(packaged_app, ui_driver):
    app = packaged_app("cluster_legend")
    region = _demo(app)
    r = ui_driver("legend_compare.mjs", {"base": app.base, "region": region, "part": "legend", "colour": PICK})
    cards = [c for c in r["natural"] if c]
    assert len(cards) >= 2, r["natural"]
    # One legend and one plot geometry for every card, and the layer turned on is in it.
    for key in ("legend", "left", "width", "canvas"):
        assert len({c[key] for c in cards}) == 1, (key, cards)
    assert r["layer"] and len(cards[0]["legend"].split("|")) >= 2, cards[0]
    missing = [c for c in r["with_missing"] if c]
    assert r["dropped"] is not None and r["missing_items"], (r["dropped"], r["missing_items"])
    assert len({c["legend"] for c in missing}) == 1 and missing[0]["legend"] == cards[0]["legend"], missing
    for key in ("left", "width", "canvas"):
        assert len({c[key] for c in missing}) == 1, (key, missing)
    # The user colour: no card swatch has it before; after, every card has exactly one entry in it (the layer's,
    # hollow in the cluster that lost the layer is skipped) and the other entries keep their colours.
    before, after = [s for s in r["swatches_before"] if s], [s for s in r["swatches_after"] if s]
    assert len(before) == len(after) == len(cards), (before, after)
    for b, a in zip(before, after):
        assert len(b) == len(a) and not any(_near(e["rgb"]) for e in b), b
        changed = [i for i, (eb, ea) in enumerate(zip(b, a)) if eb["rgb"] != ea["rgb"]]
        filled = [e for e in a if not e["missing"]]
        if len(filled) == len(a):
            assert len(changed) == 1 and _near(a[changed[0]]["rgb"]), (b, a)
        else:
            assert all(not _near(e["rgb"]) for e in b) and len(changed) <= 1, (b, a)
    assert [c["legend"] for c in r["after_colour_geometry"] if c] == [c["legend"] for c in missing]
    assert not r["page_errors"], r["page_errors"]


def test_plots_compare_with_summary(packaged_app, ui_driver):
    app = packaged_app("plots_compare")
    region = _demo(app)
    r = ui_driver("legend_compare.mjs", {"base": app.base, "region": region, "part": "compare"})
    one = r["one_group"]
    assert one["diff_disabled"] and re.search(r"two groups", (one["diff_title"] or "") + one["hint"], re.I), one
    assert int(r["two_groups"]) >= 2 and r["diff_enabled"], r
    assert r["comparing"] == "a-vs-b", r["comparing"]
    values, intervals = json.loads(r["summary"]["values"]), json.loads(r["summary"]["intervals"])
    assert len(intervals) == 1 and intervals[0], r["summary"]
    flat = [x for x in (values if isinstance(values, list) else [values]) if x is not None]
    flat = [y for x in flat for y in (x if isinstance(x, list) else [x])]
    assert flat and all(isinstance(x, (int, float)) and math.isfinite(x) for x in flat), r["summary"]
    assert r["summary"]["chart_visible"], r["summary"]
    assert "comparing" in r["state_line"].lower() and "summary" in r["state_line"].lower(), r["state_line"]
    size = r["size"]
    assert size["summary_disabled"] and size["summary_count"] == 0, size
    assert re.search(r"summary is off while comparing", size["blocked"] or "", re.I), size
    assert not r["page_errors"], r["page_errors"]


def test_full_ui_capture_in_webkit_and_chromium(packaged_app, ui_driver):
    app = packaged_app("ui_capture")
    region = _demo(app)
    r = ui_driver("capture_ui.mjs", {"base": app.base, "region": region})
    for name in ("webkit", "chromium"):
        b = r[name]
        assert b["read_tracks"] == 2 and b["download_bytes"] > 50_000, (name, b)
        assert b["ink"]["panels"] and all(f > 0.02 for f in b["ink"]["panels"]), (name, b["ink"])
        assert b["could_not_load_reads_text"] == 0 and b["export_error_text"] == 0, (name, b)
        assert not b["page_errors"], (name, b["page_errors"])


def _session_file(smoke_root: Path, app) -> Path:
    """A session with two datasets that are not the start-up demo: copies of the bundled demo BAM, at the demo
    region. Written once per smoke run."""
    path = smoke_root / "early_open_session.json"
    if path.is_file():
        return path
    listing = app.call("GET", "/api/datasets")
    datasets = listing if isinstance(listing, list) else listing.get("datasets", [])
    demo_bam = next(p for d in datasets for p in (d.get("paths") or [d.get("path")]) if p and p.endswith(".bam"))
    region = app.call("GET", "/api/demo")["region"]
    folder = smoke_root / "session_data"
    folder.mkdir(exist_ok=True)
    entries = []
    for i, colour in enumerate(("#3b82f6", "#ef4444")):
        bam = folder / f"early_open_{i}.bam"
        shutil.copyfile(demo_bam, bam)
        for suffix in (".bai", ".csi"):
            if Path(demo_bam + suffix).is_file():
                shutil.copyfile(demo_bam + suffix, str(bam) + suffix)
        entries.append({"id": f"early_open_{i}", "label": f"early_open_{i}", "paths": [str(bam)], "color": colour,
                        "data_type": "bam", "is_remote": False, "layer_type": "bam"})
    viewport = {"chrom": region["chrom"], "start": int(region["start"]) + 500, "end": int(region["end"]) - 500}
    session = {"version": "2.0", "fiberbrowser_version": app.version["current"], "viewport": viewport,
               "datasets": entries, "frontend": {**viewport, "datasets": [e["id"] for e in entries]}}
    path.write_text(json.dumps(session, indent=1))
    return path


@pytest.mark.parametrize("hold_ms", [0, 2500], ids=["early", "startup-list-held"])
def test_session_opened_during_startup_keeps_its_datasets(packaged_app, ui_driver, smoke_root, hold_ms):
    runs = int(os.environ.get("FIBERBROWSER_APP_SMOKE_SESSION_RUNS", "3"))
    for i in range(runs):
        app = packaged_app(f"session_{'held' if hold_ms else 'early'}_{i}")
        _demo(app)  # the start-up dataset list is non-empty and differs from the session's
        session = _session_file(smoke_root, app)
        want = json.loads(session.read_text())
        r = ui_driver("open_session.mjs", {"base": app.base, "session": str(session), "hold_ms": hold_ms})
        where = f"run {i + 1}/{runs}"
        assert r["import"]["success"] is True and not r["import"]["datasets_failed"], (where, r["import"])
        assert r["picker_calls"] == 1, (where, r["picker_calls"])
        if hold_ms:
            # The held start-up list really landed after the import (the race this guards against).
            released = next((n for n, t in enumerate(r["timeline"]) if "released after" in t), None)
            imported = next((n for n, t in enumerate(r["timeline"]) if "POST /api/session/import" in t), None)
            assert released is not None and imported is not None and imported < released, (where, r["timeline"])
        state = r["state"]
        assert state["datasets"] == [d["paths"] for d in want["datasets"]], (where, state["datasets"], r["timeline"])
        assert sum(1 for n in state["reads"].values() if n) >= len(want["datasets"]), (where, state["reads"])
        assert state["viewport"] == want["viewport"], (where, state["viewport"])
        assert r["stable"], where
        assert r["error_banners"] == {"dismiss": 0, "crash": 0} and state["error"] is None, (where, r["error_banners"], state["error"])
        assert not r["page_errors"] and not r["genome_requests"], (where, r["page_errors"], r["genome_requests"])
        app.stop()


def _graph_status_ok(app) -> dict:
    status = app.call("GET", "/api/graph/status")
    helper = status.get("helper") or {}
    assert helper.get("available") and helper.get("source") == "bundled" and not helper.get("error"), helper
    assert "/Contents/" in (helper.get("path") or ""), helper.get("path")
    return status


def test_graph_helper_is_bundled_and_answers(packaged_app, smoke_root):
    app = packaged_app("graph_helper", env={"FIBERBROWSER_GRAPH_REGISTRY": str(smoke_root / "graph_helper" / "graph_registrations.json")})
    status = _graph_status_ok(app)
    assert str(status["helper"].get("producer", "")).startswith("fiberbrowser-graph"), status["helper"]


def test_graph_view_renders_a_configured_package(packaged_app, ui_driver, smoke_root):
    package = os.environ.get("FIBERBROWSER_APP_SMOKE_GRAPH_PACKAGE")
    region_text = os.environ.get("FIBERBROWSER_APP_SMOKE_GRAPH_REGION")
    if not package or not region_text:
        pytest.skip("graph render: set FIBERBROWSER_APP_SMOKE_GRAPH_PACKAGE and FIBERBROWSER_APP_SMOKE_GRAPH_REGION "
                    "(chr:start-end) to a graph package and a region it covers")
    m = re.fullmatch(r"([^:]+):([\d,]+)-([\d,]+)", region_text.strip())
    assert m, f"FIBERBROWSER_APP_SMOKE_GRAPH_REGION={region_text!r} is not chr:start-end"
    region = {"chrom": m.group(1), "start": int(m.group(2).replace(",", "")), "end": int(m.group(3).replace(",", ""))}
    if not Path(package).is_dir():
        pytest.skip(f"graph render: the package {package} is not here")
    bam = os.environ.get("FIBERBROWSER_APP_SMOKE_GRAPH_BAM")
    genome = os.environ.get("FIBERBROWSER_APP_SMOKE_GRAPH_GENOME")
    app = packaged_app("graph_render", env={"FIBERBROWSER_GRAPH_PACKAGES": package,
                                            "FIBERBROWSER_GRAPH_REGISTRY": str(smoke_root / "graph_render" / "graph_registrations.json")})
    status = _graph_status_ok(app)
    assert not status.get("registration_errors"), status.get("registration_errors")
    assert any(r.get("verification") == "verified" for r in status.get("registrations", [])), status.get("registrations")
    if bam:
        added = app.call("POST", "/api/datasets/add", {"path": bam})
        assert added.get("success"), added
    r = ui_driver("graph_panel.mjs", {"base": app.base, "region": region, "genome": genome, "has_dataset": bool(bam)})
    attrs = r["attrs"]
    assert not attrs.get("data-graph-error"), (attrs, r["status_text"])
    assert len(attrs.get("data-graph-lanes", "").split(",")) >= 2, attrs
    assert r["scene"] and r["scene"]["rows"] > 0 and r["scene"]["hit_kinds"], r["scene"]
    if genome:
        # With the package's genome declared, the Graph view follows the main view.
        assert attrs.get("data-graph-link") == "follow" and attrs.get("data-graph-drawn-start") == str(region["start"]), attrs
    assert r["error_banners"]["dismiss"] == 0 and r["error_banners"]["store_error"] is None, r["error_banners"]
    assert not r["page_errors"], r["page_errors"]


def _wheel(version: str, digest: str, yanked: bool = False) -> dict:
    name = f"fiberhmm-{version}-py3-none-any.whl"
    return {"packagetype": "bdist_wheel", "filename": name, "yanked": yanked, "digests": {"sha256": digest},
            "url": f"https://files.pythonhosted.org/packages/smoke/{name}"}


def _expected_offer(index: dict, minimum: str, current: str) -> str | None:
    """What services/fiberhmm_update.select_release should offer from ``index``: the highest non-yanked
    py3-none-any wheel with a sha256 in [minimum, 4), if it is newer than ``current``."""
    from packaging.version import InvalidVersion, Version
    best = None
    for version, files in index.get("releases", {}).items():
        try:
            v = Version(version)
        except InvalidVersion:
            continue
        if v.is_prerelease or v.is_devrelease or not (Version(minimum) <= v < Version("4")):
            continue
        if any(not f.get("yanked") and f.get("packagetype") == "bdist_wheel" and f.get("filename", "").endswith("-py3-none-any.whl")
               and re.fullmatch(r"[0-9a-fA-F]{64}", f.get("digests", {}).get("sha256", "")) and f.get("url", "").startswith("https://")
               for f in files):
            best = v if best is None or v > best else best
    return str(best) if best is not None and best > Version(current) else None


def test_fiberhmm_update_offer_from_pypi_installs_nothing(packaged_app, ui_driver, smoke_root):
    pytest.importorskip("cryptography", reason="the PyPI proxy makes its throwaway CA with cryptography")
    from app_smoke.pypi_mock import PypiMockProxy
    build = json.loads((Path(APP) / "Contents" / "Resources" / "fiberbrowser-build.json").read_text())
    minimum, bundled = build.get("fiberhmm_min_version") or "3.2.2", build.get("fiberhmm_version")
    assert bundled, build
    if os.environ.get("FIBERBROWSER_APP_SMOKE_NETWORK") == "1":
        try:
            opener = urllib.request.build_opener()
            with opener.open("https://pypi.org/pypi/fiberhmm/json", timeout=20) as response:  # read-only
                index = json.loads(response.read())
        except OSError as error:
            pytest.skip(f"FIBERBROWSER_APP_SMOKE_NETWORK=1 but PyPI is not reachable: {error}")
        source = "live PyPI index"
    else:
        major, minor, patch = _version_tuple(bundled)
        newer = f"{major}.{minor}.{patch + 7}"
        index = {"info": {"name": "fiberhmm", "version": newer}, "releases": {
            "3.0.4": [_wheel("3.0.4", "a" * 64)],                  # below the app's minimum: never offered
            bundled: [_wheel(bundled, "b" * 64)],
            newer: [_wheel(newer, "c" * 64)],                       # the offer
            f"{major}.{minor}.{patch + 8}": [_wheel(f"{major}.{minor}.{patch + 8}", "d" * 64, yanked=True)],
            f"{major}.{minor + 1}.0rc1": [_wheel(f"{major}.{minor + 1}.0rc1", "e" * 64)],
            "4.0.0": [_wheel("4.0.0", "f" * 64)],                  # next major: never offered
        }}
        source = "synthetic index"
    want = _expected_offer(index, minimum, bundled)
    port = int(os.environ.get("FIBERBROWSER_APP_SMOKE_PROXY_PORT", "0"))
    with PypiMockProxy(index, smoke_root / "pypi_proxy", port) as proxy:
        app = packaged_app("fiberhmm_update", env={"HTTPS_PROXY": proxy.url, "HTTP_PROXY": proxy.url,
                                                   "https_proxy": proxy.url, "http_proxy": proxy.url,
                                                   "SSL_CERT_FILE": str(proxy.ca_file)})
        check = app.call("GET", "/api/app/update?force=true")
        fh = check.get("fiberhmm") or {}
        assert any(r.get("answered") for r in proxy.requests), (
            f"the app's FiberHMM check never read the index through the proxy ({source}): {proxy.requests}, {fh}")
        assert fh.get("current") == bundled and fh.get("packaged"), fh
        if want:
            assert fh.get("status") == "update_available" and fh.get("latest") == want, (source, want, fh)
            ui = ui_driver("updater_ui.mjs", {"base": app.base})
            assert f"FiberHMM {want} is available" in ui["banner"], ui["banner"]
            assert f"FiberHMM {want} is available" in ui["section"], ui["section"]
            assert ui["install_button"]["count"] == 1 and ui["install_button"]["text"].strip() == f"Update FiberHMM to {want}", ui["install_button"]
            assert ui["blocked"] == [] and not ui["page_errors"], (ui["blocked"], ui["page_errors"])
        else:
            assert fh.get("status") == "up_to_date", (source, fh)
        job = app.call("GET", "/api/app/fiberhmm/update")
        assert (job.get("job") or job).get("state") == "idle", job
        requests = list(proxy.requests)
    # Nothing was downloaded or installed: only the index was answered, no overlay was written.
    assert all(r["target"] == "https://pypi.org/pypi/fiberhmm/json" for r in requests if r.get("answered")), requests
    assert not any("files.pythonhosted.org" in r["target"] for r in requests), requests
    overlays = app.home / ".fiberhmm" / "fiberhmm"
    assert not overlays.exists() or not any(overlays.iterdir()), sorted(p.name for p in overlays.iterdir())
