"""Regenerate input.json: real Quantify inputs from a meta-locus on the demo BAM, for the Python / TypeScript twin test.

Run from a FiberBrowser tree's root (tests/ and browser/ go on the path):

    python tests/fixtures/window_quant/make_input.py

Then regenerate the golden with the TypeScript engine (it reads input.json):

    cd browser/frontend && FIBERBROWSER_WRITE_QUANT_GOLDEN=1 npx vitest run src/features/windowQuant/pythonTwinGolden.test.ts

input.json holds each case's engine inputs as services/meta_locus_numbers.quant_inputs builds them: the panels' profile
pools (the reads the browser's curves are computed from), the fresh seeded samples, cluster assignments, groups and the
bounds. tests/test_window_quant_twin.py computes the Python side from it; pythonTwinGolden.test.ts the TypeScript side.
Read names are the demo BAM's own.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path.cwd()
sys.path[:0] = [str(ROOT / "tests"), str(ROOT / "browser")]
os.environ.setdefault("FIBERBROWSER_NO_OPEN", "1")
OUT = ROOT / "tests" / "fixtures" / "window_quant" / "input.json"
DEMO = ROOT / "browser" / "data" / "demo" / "napa_ddda.bam"

READ_FIELDS = ("id", "analysis_id", "intervals", "fire", "methyl", "methyl_m6a", "methyl_m5c", "deam", "aligned_blocks")
LAYERS = ("nuc", "footprint", "tf", "msp", "fire")


def slim(read: dict) -> dict:
    out = {k: read[k] for k in READ_FIELDS if read.get(k) is not None}
    layers = {k: {"intervals": v.get("intervals") or []} for k, v in (read.get("layers") or {}).items()
              if k in LAYERS and isinstance(v, dict)}
    if layers:
        out["layers"] = layers
    return out


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="fb-quant-input-"))
    os.environ["FIBERBROWSER_META_LOCUS_CACHE_DIR"] = str(tmp / "cache")
    import conftest  # noqa: F401  (scratch library, settings and runtime files)
    import server as srv
    from plugins import init_context
    from services import meta_locus_jobs as mj
    from services.local_auth import auth_headers
    from services.meta_locus_numbers import quant_inputs
    from starlette.testclient import TestClient
    from test_headless_meta_locus import bed_file

    srv.state = srv.BrowserState(None, None, None, None)
    init_context(srv.state)
    client = TestClient(srv.app, headers=auth_headers())
    copy = tmp / "demo_copy.bam"
    shutil.copy(DEMO, copy)
    shutil.copy(str(DEMO) + ".bai", str(copy) + ".bai")
    ids = []
    for path, label in ((DEMO, "A"), (copy, "B")):
        body = client.post("/api/datasets/add", json={"path": str(path), "label": label}).json()
        ids.append(body.get("id") or body.get("dataset_id") or (body.get("dataset") or {}).get("id"))
    bed = bed_file(tmp)
    two = {"bed": str(bed), "anchor": "start", "flank_bp": 1500, "seed": 2, "count": 240}
    one = {**two, "dataset_ids": [ids[0]], "count": 150}
    clustered = client.post("/api/render/cluster", json={"meta_locus": two, "k": 3, "seed": "twin"}).json()["session"]

    cases = [
        ("curve_clusters_raw", {"session": clustered, "window": [-200, 50], "spec": {"measures": ["layer:nuc", "layer:tf"]}}),
        ("curve_enrich_region_diff", {"session": clustered, "window": [-200, 50],
                                      "spec": {"measures": ["layer:nuc", "layer:tf"], "value": "enrichment", "compare": "diff",
                                               "reference": "cl:1"}}),
        # The same with "Interval: none": no bootstrap, so no interval on values, enrichment or comparisons.
        ("curve_enrich_region_diff_ci_none", {"session": clustered, "window": [-200, 50],
                                              "spec": {"measures": ["layer:nuc", "layer:tf"], "value": "enrichment",
                                                       "compare": "diff", "reference": "cl:1", "ci": "none"}}),
        ("curve_enrich_flank_log2ratio", {"session": clustered, "window": [-120, 120],
                                          "spec": {"measures": ["layer:nuc"], "value": "enrichment", "baseline": "flank",
                                                   "compare": "log2ratio", "bootSeed": 11}}),
        ("curve_enrich_dataset_ratio", {"session": clustered, "window": [-300, 0],
                                        "spec": {"measures": ["layer:tf"], "value": "enrichment", "baseline": "dataset",
                                                 "form": "ratio", "comparison": "clusters-datasets"}}),
        ("exact_area_clusters_datasets", {"session": clustered, "window": [-200, 50],
                                          "spec": {"measures": ["layer:nuc", "layer:tf"], "layerUnits": "exact",
                                                   "stat": "area", "comparison": "clusters-datasets", "resamples": 300}}),
        ("sites_pools_pooled", {"session": clustered,
                                "spec": {"measures": ["layer:nuc"], "bounds": "sites", "comparison": "pools",
                                         "value": "enrichment", "baseline": "pooled", "resamples": 200}}),
        ("fresh_layers", {"meta_locus": one, "window": [-200, 50],
                          "spec": {"measures": ["layer:nuc", "layer:tf"], "readSource": "fetch", "readCap": 120}}),
        ("fresh_size_band_flank", {"meta_locus": one, "window": [-150, 100],
                                   "spec": {"measures": ["size:band"], "value": "enrichment", "baseline": "flank",
                                            "sizeFrom": 10, "sizeTo": 80, "resamples": 400}}),
    ]
    reads: dict = {}

    def ref(r):
        key = f"{len(reads)}"
        reads[key] = slim(r)
        return key

    out_cases = []
    seen: dict = {}
    for name, body in cases:
        inp = quant_inputs(srv.state, body)

        def refs(rs):
            out = []
            for r in rs:
                k = json.dumps(slim(r), sort_keys=True)
                if k not in seen:
                    seen[k] = ref(r)
                out.append(seen[k])
            return out
        pools = [{"key": p["key"], "datasetId": p["datasetId"],
                  "pool": None if p["pool"] is None else {**{k: v for k, v in p["pool"].items() if k != "reads"},
                                                          "reads": refs(p["pool"]["reads"])}} for p in inp["pools"]]
        case = {k: inp[k] for k in ("spec", "view", "bounds", "measures", "has_tf", "panels", "cluster_panels", "visible",
                                    "comparison", "y_baseline", "view_bins")}
        case["assignments"] = {k: v for k, v in inp["assignments"].items() if v}
        case.update(name=name, kind="pipeline", pools=pools,
                    fresh=[[ds, refs(rs)] for ds, rs in inp["fresh"]], marks=[[ds, refs(rs)] for ds, rs in inp["marks"]],
                    size_reads=[[ds, refs(rs)] for ds, rs in inp["size_reads"]])
        out_cases.append(case)

    # Engine-only: shares of reads (Wilson, the equal-shares tests, BH) on synthetic units.
    import random
    rnd = random.Random(7)
    groups = [{"id": f"cl:{c}", "title": f"C{c}", "color": None, "dataset": None,
               "match": [{"dataset": "ds1", "panelKey": "ds1", "cluster": c}]} for c in range(3)]
    assignments = {"ds1": {}}
    units = {"fam:a": {}, "fam:b": {}}
    for i in range(240):
        rid = f"read{i:03d}"
        c = i % 3
        assignments["ds1"][rid] = c
        for fam, p in (("fam:a", (0.2, 0.5, 0.35)), ("fam:b", (0.3, 0.32, 0.29))):
            if rnd.random() < 0.9:
                units[fam][f"ds1\u0001{rid}"] = [1, 1, 0, 0, 1, 1] if rnd.random() < p[c] else [0, 1, 0, 0, 0, 1]
    for name, spec in (("engine_shares_chi2", {"value": "enrichment", "compare": "diff"}),
                       ("engine_shares_g_none", {"test": "g", "adjust": "none", "minReads": 85, "ci": "bootstrap",
                                                 "resamples": 250})):
        out_cases.append({"name": name, "kind": "engine", "spec": spec, "groups": groups, "assignments": assignments,
                          "measures": [{"def": {"id": fam, "label": fam, "source": "fp", "kind": "share",
                                                "unit": "share of reads", "enrichment": True, "windowed": False},
                                        "units": units[fam]} for fam in ("fam:a", "fam:b")],
                          "boundsBp": 250, "seed": 5})

    OUT.write_text(json.dumps({"reads": reads, "cases": out_cases}, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB, {len(reads)} reads, {len(out_cases)} cases)")
    for p in list(mj._pools.values()):
        p.cancel.set()
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
