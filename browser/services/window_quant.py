"""Quantify a window on the server: the Python twin of the browser's Quantify card.

A literal port of frontend/src/features/windowQuant (engine.ts computeQuant / binnedMeasure / buildGroups / quantTsv,
windowMaths.ts, the layer and size-band sources in sources.ts) and the helpers they call (utils/metaprofileReads.ts
layerChannelRead, plots/profileEngine.ts accumulateChannels 'touch' via services/profile_engine.py, utils/statistics.ts
Wilson / equal-shares / chi-squared / BH, utils/stableSample.ts Poisson draws via services/stable_sample.py), so a
script gets the card's table: the same values, the same Wilson and bootstrap intervals, the same seeds.

Pinned to the browser by a golden file both sides compute (tests/fixtures/window_quant/golden.json):
frontend/src/features/windowQuant/pythonTwinGolden.test.ts writes / checks it with the TypeScript engine and
tests/test_window_quant_twin.py checks this module against it. Change one side and the other's test fails.

Per-read units are keyed ``<dataset>\\u0001<read id>`` (unitKey). On a meta-locus each read-site pair is its own unit
(its id carries ``#site<N>`` when the read is in several windows), as the browser counts.

Measures here: read layers (curve units from the panels' profile pools, or exact bp; a fresh seeded sample when a
panel has no pool, e.g. one dataset unclustered, where the browser draws the server's metaprofile) and the footprint
size band. Families (Find classes, NFR runs, geometries) and the regularity score need browser-side runs and are
refused with a message (UNSUPPORTED_SOURCES).
"""
from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np

from services.profile_engine import accumulate_channels
from services.stable_sample import percentile_interval as _percentile_interval
from services.stable_sample import poisson_weights

UNIT_COLS = 6
BINNED_BOOT_BUDGET = 6e7
RESOLUTION = 500              # the read track's metaprofile grid (ReadTrack computeMetaprofileFromReads)
ALL_FOOTPRINTS = "all_footprints"
SIZE_BAND_MEASURE = "size:band"

# Measure sources the browser's registry has that need browser-side runs (hub sets, cluster-view regularity).
UNSUPPORTED_SOURCES = {
    "fp": "footprint families (a Find classes run in the browser)",
    "nfr": "NFR families (an Accessibility run in the browser)",
    "geo": "nucleosome geometries (Find geometries in the browser)",
    "nuc": "the regularity score (Clusters > Profiles in the browser)",
}

DEFAULT_SPEC = {
    "measures": [], "bounds": "window", "comparison": "clusters", "reference": None, "value": "raw", "baseline": "auto",
    "form": "log2", "stat": "mean", "compare": "off", "ci": "auto", "resamples": 1000, "bootSeed": None, "test": "chi2",
    "adjust": "bh", "minReads": 20, "readCap": 10000, "seed": 1, "flankFraction": 0.1, "layerUnits": "curve",
    "readSource": "panel", "sizeFrom": 0, "sizeTo": 90, "chart": "bar", "view": "chart", "sort": "panel",
}
SNAKE = {"boot_seed": "bootSeed", "min_reads": "minReads", "read_cap": "readCap", "flank_fraction": "flankFraction",
         "layer_units": "layerUnits", "read_source": "readSource", "size_from": "sizeFrom", "size_to": "sizeTo"}


def _pick(v, opts, d):
    return v if isinstance(v, str) and v in opts else d


def _int(v, lo, hi, d):
    """Math.round(Math.min(hi, Math.max(lo, v))): halves round up, as in JavaScript."""
    return int(math.floor(min(hi, max(lo, v)) + 0.5)) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else d


def normalize_spec(raw: Any) -> dict:
    """normalizeQuantSpec (spec.ts); snake_case keys are accepted too."""
    r = {SNAKE.get(k, k): v for k, v in (raw or {}).items()} if isinstance(raw, dict) else {}
    d = DEFAULT_SPEC
    ff = r.get("flankFraction")
    ff = min(0.45, max(0.02, ff)) if isinstance(ff, (int, float)) and math.isfinite(ff) else d["flankFraction"]
    measures = r.get("measures")
    if isinstance(measures, str):
        measures = [m for m in measures.replace(",", " ").split() if m]
    out = {
        "measures": list(dict.fromkeys(m for m in (measures or []) if isinstance(m, str) and 0 < len(m) < 400))[:64],
        "bounds": _pick(r.get("bounds"), ("window", "region", "sites"), d["bounds"]),
        "comparison": _pick(r.get("comparison"), ("clusters", "datasets", "clusters-datasets", "pools"), d["comparison"]),
        "reference": r["reference"] if isinstance(r.get("reference"), str) and r.get("reference") else None,
        "value": _pick(r.get("value"), ("raw", "enrichment"), d["value"]),
        "baseline": _pick(r.get("baseline"), ("auto", "pooled", "rest", "reference", "region", "flank", "dataset"), d["baseline"]),
        "form": _pick(r.get("form"), ("percent", "ratio", "log2"), d["form"]),
        "stat": _pick(r.get("stat"), ("mean", "area"), d["stat"]),
        "compare": _pick(r.get("compare"), ("off", "diff", "log2ratio"), d["compare"]),
        "ci": _pick(r.get("ci"), ("auto", "bootstrap", "wilson", "none"), d["ci"]),
        "resamples": _int(r.get("resamples"), 50, 10000, d["resamples"]),
        "bootSeed": int(math.floor(max(0, r["bootSeed"]) + 0.5)) if isinstance(r.get("bootSeed"), (int, float)) and not isinstance(r.get("bootSeed"), bool) and math.isfinite(r["bootSeed"]) else None,
        "test": _pick(r.get("test"), ("chi2", "g", "off"), d["test"]),
        "adjust": _pick(r.get("adjust"), ("bh", "none"), d["adjust"]),
        "minReads": _int(r.get("minReads"), 0, 100000, d["minReads"]),
        "readCap": _int(r.get("readCap"), 50, 20000, d["readCap"]),
        "seed": _int(r.get("seed"), 0, 2 ** 31 - 1, d["seed"]),
        "flankFraction": ff,
        "layerUnits": _pick(r.get("layerUnits"), ("curve", "exact"), d["layerUnits"]),
        "readSource": _pick(r.get("readSource"), ("panel", "fetch"), d["readSource"]),
        "chart": _pick(r.get("chart"), ("bar", "line"), d["chart"]),
        "view": _pick(r.get("view"), ("chart", "table"), d["view"]),
        "sort": _pick(r.get("sort"), ("panel", "value", "enrichment", "spread"), d["sort"]),
    }
    a, b = _int(r.get("sizeFrom"), 0, 100000, d["sizeFrom"]), _int(r.get("sizeTo"), 1, 100000, d["sizeTo"])
    out["sizeFrom"], out["sizeTo"] = (a, b) if a < b else (d["sizeFrom"], d["sizeTo"])
    return out


# ------------------------------------------------------------------------------------------------ keys, window maths

def unit_key(dataset: str, read: str) -> str:
    return f"{dataset}\u0001{read}"


def unit_parts(key: str) -> tuple[str, str]:
    i = key.index("\u0001")
    return key[:i], key[i + 1:]


def overlap_bp(a0, a1, b0, b1) -> float:
    return max(0, min(a1, b1) - max(a0, b0))


def merge_intervals(ivs) -> list:
    srt = sorted(([iv[0], iv[1]] for iv in ivs if iv[1] > iv[0]), key=lambda x: x[0])
    out: list = []
    for a, b in srt:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def view_flanks(start, end, fraction) -> list:
    w = max(1, _js_round((end - start) * fraction))
    return [[start, start + w], [end - w, end]]


def _js_round(x: float) -> int:
    """Math.round: halves round up (towards +infinity)."""
    return int(math.floor(x + 0.5))


def _layer_and_span(r: dict, ranges, merged) -> tuple:
    num = den = 0
    for a, b in ranges:
        lo, hi = max(a, r["start"]), min(b, r["end"])
        if hi <= lo:
            continue
        den += hi - lo
        if merged is not None:
            for x, y in merged:
                num += overlap_bp(x, y, lo, hi)
        else:
            for p in r.get("points") or []:
                if lo <= p < hi:
                    num += 1
    return num, den


def read_sums(r: dict, win, flanks, view) -> list:
    merged = None if r.get("points") is not None else merge_intervals(r.get("intervals") or [])
    n0, d0 = _layer_and_span(r, [win], merged)
    n1, d1 = _layer_and_span(r, flanks, merged)
    n2, d2 = _layer_and_span(r, [view], merged)
    return [n0, d0, n1, d1, n2, d2]


def bin_window_weights(n: int, start, end, frm, to) -> np.ndarray:
    w = np.zeros(max(0, n))
    if not n > 0 or not end > start:
        return w
    size = (end - start) / n
    for i in range(n):
        a = start + i * size
        w[i] = overlap_bp(a, a + size, frm, to) / size
    return w


def flank_bins(res: int, fraction: float) -> list:
    k = max(1, min(res // 2, _js_round(res * fraction)))
    return list(range(k)) + list(range(res - k, res))


# ------------------------------------------------------------------------------------------------ reads as channels

MARK_LAYER_CHANNELS = {"m6a": ("layer:m6a", "mod"), "mod": ("layer:m6a", "mod"), "m5c": ("layer:m5c",), "deam": ("layer:deam",)}


def is_mark_layer(key: str) -> bool:
    return key in MARK_LAYER_CHANNELS


def mark_layer_points(points: dict, key: str) -> list:
    for ch in MARK_LAYER_CHANNELS.get(key, ()):
        if points.get(ch):
            return points[ch]
    return []


def read_point_channels(read: dict) -> dict:
    points = {}
    if read.get("methyl"):
        points["mod"] = list(read["methyl"])
    if read.get("methyl_m6a"):
        points["layer:m6a"] = list(read["methyl_m6a"])
    if read.get("methyl_m5c"):
        points["layer:m5c"] = list(read["methyl_m5c"])
    if read.get("deam"):
        points["layer:deam"] = [d[0] for d in read["deam"]]
    return points


def layer_channel_read(read: dict) -> dict:
    """layerChannelRead (utils/metaprofileReads.ts): the read as the read track's metaprofiles see it."""
    spans: dict = {}
    points = read_point_channels(read)
    rs, re_ = math.inf, -math.inf
    for iv in read.get("intervals") or []:
        rs, re_ = min(rs, iv[0]), max(re_, iv[1])
    for name, layer in (read.get("layers") or {}).items():
        ivs = (layer or {}).get("intervals") or []
        if not ivs:
            continue
        ch = f"layer:{'fire' if name == 'msp' else name}"
        for iv in ivs:
            if (iv[2] if len(iv) > 2 else 0) > 0:
                spans.setdefault(ch, []).append([iv[0], iv[1]])
    for f in read.get("fire") or []:
        spans.setdefault("fire", []).append([f[0], f[1]])
    ok = rs < re_
    return {"start": rs if ok else 0, "end": re_ if ok else 0, "spans": spans, "points": points}


def finish_channels(acc: dict) -> dict:
    cov = acc["coverage"]
    return {name: [v / cov[i] if cov[i] > 0 else v for i, v in enumerate(arr)] for name, arr in acc["channels"].items()}


def _channel_of(key: str, cr: dict) -> dict:
    if is_mark_layer(key):
        return {"pts": mark_layer_points(cr["points"], key)}
    sp = cr["spans"]
    if key in ("nuc", "footprint"):
        return {"ivs": sp.get("layer:nuc") if "layer:nuc" in sp else sp.get("layer:footprint", [])}
    if key in ("fire", "msp"):
        return {"ivs": sp.get("layer:fire") if "layer:fire" in sp else sp.get("fire", [])}
    return {"ivs": sp.get(f"layer:{key}", [])}


def _channel_name(key: str, cr: dict) -> str:
    if key in ("nuc", "footprint"):
        return "layer:nuc" if "layer:nuc" in cr["spans"] else "layer:footprint"
    if key in ("fire", "msp"):
        return "layer:fire" if "layer:fire" in cr["spans"] else "fire"
    return f"layer:{key}"


def source_layers(source: str) -> list:
    if source == ALL_FOOTPRINTS:
        return ["nuc", "tf"]
    if source == "fire":
        return ["msp", "fire"]
    if source == "m6a":
        return []
    return [source]


def pool_carries(pool: dict, key: str) -> bool:
    """poolCarries (sources.ts)."""
    if is_mark_layer(key):
        return pool.get("marks") is not False
    reads = pool.get("reads") or []
    if not reads:
        return True
    names = ["nuc", "footprint"] if key in ("nuc", "footprint") else source_layers(key)
    if pool.get("layers") is not None and any(n in pool["layers"] for n in names):
        return True
    return any(len(((r.get("layers") or {}).get(n) or {}).get("intervals") or []) > 0 for r in reads for n in names)


def pools_usable(keys: list, pools: list, view: dict) -> bool:
    """poolLayerData's guard: every panel has a pool for this view that carries every layer asked for."""
    if not pools or any(not p.get("pool") or p["pool"]["chrom"] != view["chrom"] or p["pool"]["start"] != view["start"]
                        or p["pool"]["end"] != view["end"] for p in pools):
        return False
    return all(pool_carries(p["pool"], k) for p in pools for k in keys)


def pool_layer_data(keys: list, pools: list, view: dict, bounds: dict, flank_fraction: float, layer_units: str,
                    view_bins: bool) -> Optional[dict]:
    """poolLayerData (sources.ts). ``pools``: per panel {key, datasetId, pool: {reads, chrom, start, end, resolution,
    layers?, marks?}} in panel order; reads in window coordinates. None when a panel has no pool for this view."""
    if not pools_usable(keys, pools, view):
        return None
    out: dict = {}
    width = view["end"] - view["start"]
    wa, wb = bounds["from"] - view["start"], bounds["to"] - view["start"]
    fl = view_flanks(0, width, flank_fraction)
    res = int(pools[0]["pool"]["resolution"])
    all_w = bin_window_weights(res, 0, width, wa, wb)
    keep = [i for i in range(res) if all_w[i] > 0]
    weights = np.array([all_w[i] for i in keep], dtype=np.float64)
    at = {i: j for j, i in enumerate(keep)}
    for key in keys:
        mid = f"layer:{key}"
        if is_mark_layer(key) or layer_units == "exact":
            out[mid] = {"units": {}, "sampled": {}, "readSource": "panel"}
        else:
            binned = {"weights": weights, "units": {}, "binBp": width / res}
            if view_bins:
                binned.update(res=res, flank=flank_bins(res, flank_fraction))
            out[mid] = {"binned": binned, "sampled": {}, "readSource": "panel"}
    seen: set = set()
    for p in pools:
        for key in keys:
            out[f"layer:{key}"]["sampled"].setdefault(p["datasetId"], {"used": 0})
    for p in pools:
        for read in p["pool"]["reads"]:
            uid = unit_key(p["datasetId"], read.get("analysis_id") or read["id"])
            if uid in seen:
                continue
            seen.add(uid)
            for key in keys:
                out[f"layer:{key}"]["sampled"][p["datasetId"]]["used"] += 1
            cr = layer_channel_read(read)
            s0 = cr["start"] if cr["end"] > cr["start"] else math.inf
            e0 = cr["end"] if cr["end"] > cr["start"] else -math.inf
            for ivs in cr["spans"].values():
                for a, b in ivs:
                    if b > a:
                        s0, e0 = min(s0, a), max(e0, b)
            if not e0 > s0:
                continue
            acc = None
            for key in keys:
                ch = _channel_of(key, cr)
                d = out[f"layer:{key}"]
                if "binned" in d:
                    if acc is None:
                        acc = accumulate_channels([cr], res, width, "touch")
                    sig = acc["channels"].get(_channel_name(key, cr))
                    cov = acc["coverage"]
                    idx, sv, cv = [], [], []
                    for i in keep:
                        c = cov[i]
                        if c > 0:
                            idx.append(at[i])
                            cv.append(c)
                            sv.append(sig[i] if sig else 0)
                    unit = {"idx": idx, "sig": sv, "cov": cv}
                    if view_bins:
                        ai = [i for i in range(res) if cov[i] > 0]
                        if ai:
                            unit["all"] = {"idx": ai, "sig": [sig[i] if sig else 0 for i in ai], "cov": [cov[i] for i in ai]}
                    if idx or unit.get("all"):
                        d["binned"]["units"][uid] = unit
                else:
                    r = {"start": s0, "end": e0}
                    if "pts" in ch:
                        r["points"] = ch["pts"]
                    else:
                        r["intervals"] = ch["ivs"] or []
                    sums = read_sums(r, [wa, wb], fl, [0, width])
                    if sums[1] > 0 or sums[5] > 0:
                        d["units"][uid] = sums
    return out


def engine_read(r: dict, offset: int, source: str) -> Optional[dict]:
    """engineRead (plots/useProfileData.ts): a compact read in genomic coordinates for one source."""
    blocks = r.get("aligned_blocks") or []
    ivs = r.get("intervals") or []
    if blocks:
        start, end = min(b[0] for b in blocks), max(b[1] for b in blocks)
    elif ivs:
        start, end = offset + min(i[0] for i in ivs), offset + max(i[1] for i in ivs)
    else:
        return None
    if not end > start:
        return None
    if source == "m6a":
        pts = r.get("methyl_m6a") or r.get("methyl") or []
        return {"start": start, "end": end, "points": [offset + x for x in pts]}

    def iv(i):
        return [offset + i[0], offset + i[1], i[2]] if len(i) > 2 and i[2] is not None and i[2] > 0 else [offset + i[0], offset + i[1]]

    def from_layer(name):
        return [iv(i) for i in (((r.get("layers") or {}).get(name) or {}).get("intervals") or [])
                if (i[2] if len(i) > 2 and i[2] is not None else 1) > 0]

    layers = r.get("layers") or {}
    if source == ALL_FOOTPRINTS:
        nuc = from_layer("nuc") if layers.get("nuc") else [iv(i) for i in ivs if i[2] > 0]
        intervals = nuc + from_layer("tf")
    elif source == "nuc" and not layers.get("nuc"):
        intervals = [iv(i) for i in ivs if i[2] > 0]
    elif source == "fire":
        intervals = from_layer("msp") + from_layer("fire")
    else:
        intervals = from_layer(source)
    return {"start": start, "end": end, "intervals": intervals}


def fetch_layer_data(measures: list, reads_by_dataset: list, mark_reads_by_dataset: list, view: dict, bounds: dict,
                     flank_fraction: float) -> dict:
    """loadLayers' fresh-sample path (exact bp): ``reads_by_dataset`` [(dataset, compact reads)] in the order the
    browser lists the datasets; ``mark_reads_by_dataset`` the separate marks request."""
    win = [bounds["from"], bounds["to"]]
    flanks = view_flanks(view["start"], view["end"], flank_fraction)
    vw = [view["start"], view["end"]]
    offset = _js_round(view["start"])
    out = {}
    for m in measures:
        key = m["id"][len("layer:"):]
        source = "nuc" if key == "footprint" else key
        mark = is_mark_layer(key)
        units, sampled = {}, {}
        for ds, reads in (mark_reads_by_dataset if mark else reads_by_dataset):
            sampled[ds] = {"used": len(reads)}
            for r in reads:
                span = engine_read(r, offset, "nuc" if mark else source)
                if not span:
                    continue
                if mark:
                    er = {"start": span["start"], "end": span["end"],
                          "points": [offset + x for x in mark_layer_points(read_point_channels(r), key)]}
                else:
                    er = span
                sums = read_sums(er, win, flanks, vw)
                if sums[1] > 0 or sums[5] > 0:
                    units[unit_key(ds, r.get("analysis_id") or r["id"])] = sums
        out[m["id"]] = {"units": units, "sampled": sampled, "readSource": "fetch"}
    return out


# ------------------------------------------------------------------------------------------------ footprint size band

def original_bounds(a, b, size, region) -> list:
    if size is None or not size > b - a:
        return [a, b]
    cut_start, cut_end = a <= region["start"], b >= region["end"]
    if cut_start and not cut_end:
        return [b - size, b]
    if cut_end and not cut_start:
        return [a, a + size]
    mid = (a + b) / 2
    return [mid - size / 2, mid + size / 2]


def cut_both_ends(iv, view) -> bool:
    return len(iv) > 2 and iv[2] is not None and iv[2] > iv[1] - iv[0] and iv[0] <= view["start"] and iv[1] >= view["end"]


def band_counts(fps, ranges, band) -> list:
    k = n = 0
    for a, b, whole in fps:
        c = (a + b) / 2
        if not any(x <= c < y for x, y in ranges):
            continue
        n += 1
        size = whole if whole is not None else b - a
        if band[0] <= size < band[1]:
            k += 1
    return [k, n]


def size_band_data(reads_by_dataset: list, view: dict, bounds: dict, flank_fraction: float, band: list) -> dict:
    """loadSizeBand (sources.ts)."""
    flanks = view_flanks(view["start"], view["end"], flank_fraction)
    v = {"start": _js_round(view["start"]), "end": _js_round(view["end"])}
    units, sampled = {}, {}
    for ds, reads in reads_by_dataset:
        sampled[ds] = {"used": len(reads)}
        for r in reads:
            er = engine_read(r, _js_round(view["start"]), ALL_FOOTPRINTS)
            if not er:
                continue
            fps = []
            for iv in er.get("intervals") or []:
                if not iv[1] > iv[0] or cut_both_ends(iv, v):
                    continue
                whole = iv[2] if len(iv) > 2 else None
                a, b = original_bounds(iv[0], iv[1], whole, v)
                fps.append([a, b, whole if whole is not None else iv[1] - iv[0]])
            w = band_counts(fps, [[bounds["from"], bounds["to"]]], band)
            f = band_counts(fps, flanks, band)
            vv = band_counts(fps, [[view["start"], view["end"]]], band)
            if w[1] > 0 or vv[1] > 0:
                units[unit_key(ds, r.get("analysis_id") or r["id"])] = [w[0], w[1], f[0], f[1], vv[0], vv[1]]
    return {SIZE_BAND_MEASURE: {"units": units, "sampled": sampled}}


# ------------------------------------------------------------------------------------------------ statistics

NORMAL_975 = 1.959963984540054


def inverse_normal_cdf(probability: float) -> float:
    eps = 2.220446049250313e-16
    p = max(eps, min(1 - eps, probability))
    if abs(p - 0.975) < 1e-12:
        return NORMAL_975
    a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
    b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
    c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
    d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
    lower = 0.02425
    if p < lower:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - lower:
        return -inverse_normal_cdf(1 - p)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def wilson_interval(successes: float, total: float, level: float = 0.95) -> tuple:
    n = max(0, math.floor(total))
    k = max(0, min(n, successes))
    if n == 0:
        return 0.0, 0.0
    z = inverse_normal_cdf(0.5 + max(0.01, min(0.9999, level)) / 2)
    p = k / n
    z2 = z * z
    den = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / den
    half = z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / den
    return (0.0 if k == 0 else max(0.0, centre - half)), (1.0 if k == n else min(1.0, centre + half))


def benjamini_hochberg(ps: list) -> list:
    if not ps:
        return []
    idx = sorted(((max(0.0, min(1.0, p if (p is not None and math.isfinite(p)) else 1.0)), i) for i, p in enumerate(ps)),
                 key=lambda t: (t[0], t[1]))
    out = [0.0] * len(ps)
    run = 1.0
    for i in range(len(idx) - 1, -1, -1):
        run = min(run, idx[i][0] * len(idx) / (i + 1))
        out[idx[i][1]] = min(1.0, run)
    return out


def _log_gamma(z: float) -> float:
    co = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
          12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7]
    if z < 0.5:
        return math.log(math.pi) - math.log(math.sin(math.pi * z)) - _log_gamma(1 - z)
    s = z - 1
    x = co[0]
    for i in range(1, len(co)):
        x += co[i] / (s + i)
    t = s + 7.5
    return 0.5 * math.log(2 * math.pi) + (s + 0.5) * math.log(t) - t + math.log(x)


def regularized_gamma_q(a: float, x: float) -> float:
    if not a > 0 or not x >= 0 or not math.isfinite(x):
        return 0.0 if x == math.inf else math.nan
    if x == 0:
        return 1.0
    gln = _log_gamma(a)
    if x < a + 1:
        total = 1 / a
        delta = total
        ap = a
        for _ in range(500):
            ap += 1
            delta *= x / ap
            total += delta
            if abs(delta) < abs(total) * 1e-15:
                break
        return max(0.0, min(1.0, 1 - total * math.exp(-x + a * math.log(x) - gln)))
    fpmin = 1e-300
    b = x + 1 - a
    c = 1 / fpmin
    d = 1 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < fpmin:
            d = fpmin
        c = b + an / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-15:
            break
    return max(0.0, min(1.0, math.exp(-x + a * math.log(x) - gln) * h))


def chi_square_sf(x: float, df: float) -> float:
    if not df > 0:
        return math.nan
    if not x > 0:
        return 1.0
    return regularized_gamma_q(df / 2, x / 2)


def equal_shares_test(rows: list, method: str = "chi2") -> Optional[dict]:
    used = [r for r in rows if r["n"] > 0]
    if len(used) < 2:
        return None
    K, N = sum(r["k"] for r in used), sum(r["n"] for r in used)
    if not K > 0 or not K < N:
        return None
    p_hat = K / N
    stat = 0.0
    for r in used:
        for o, e in ((r["k"], r["n"] * p_hat), (r["n"] - r["k"], r["n"] * (1 - p_hat))):
            if method == "chi2":
                stat += (o - e) ** 2 / e
            elif o > 0:
                stat += 2 * o * math.log(o / e)
    df = len(used) - 1
    return {"stat": stat, "df": df, "p": chi_square_sf(stat, df)}


def percentile_interval(values: list):
    v = [x for x in values if x is not None and math.isfinite(x)]
    if not v:
        return None
    lo, hi = _percentile_interval(v)
    return [float(lo), float(hi)]


class Weights(dict):
    """cachedPoissonWeights' cache: a unit's draws per (seed, resamples, id), shared by its group, baseline, reference."""

    def get_draws(self, seed: int, unit: str, resamples: int) -> np.ndarray:
        key = (seed, resamples, unit)
        w = self.get(key)
        if w is None:
            w = np.asarray(poisson_weights(seed, unit, resamples), dtype=np.float64)
            self[key] = w
        return w

    def prefetch(self, seed: int, units, resamples: int) -> None:
        """Draw many units at once (poisson_weight_matrix: the same draws, vectorised)."""
        from services.stable_sample import poisson_weight_matrix
        todo = [u for u in dict.fromkeys(units) if (seed, resamples, u) not in self]
        if not todo or resamples <= 0:
            return
        m = poisson_weight_matrix(seed, todo, resamples).astype(np.float64)
        for u, row in zip(todo, m):
            self[(seed, resamples, u)] = row


def bootstrap_draws(units: list, resamples: int, seed: int, weights: Weights) -> np.ndarray:
    """bootstrapDraws (plots/summary.ts): resamples x 6 sums (a unit with all-zero values adds nothing)."""
    k = len(units[0][1]) if units else UNIT_COLS
    S = np.zeros((resamples, k))
    weights.prefetch(seed, [uid for uid, v in units if any(v)], resamples)
    for uid, v in units:
        if not any(v):
            continue
        w = weights.get_draws(seed, uid, resamples)
        S += np.outer(w, np.asarray(v, dtype=np.float64))
    return S


# ------------------------------------------------------------------------------------------------ the engine

def is_member(g: dict, dataset: str, read: str, assignments: dict) -> bool:
    import re
    for m in g["match"]:
        if m["dataset"] != dataset:
            continue
        if m["cluster"] is None:
            return True
        a = assignments.get(m["panelKey"])
        if a:
            c = a.get(read)
            if c is None:
                c = a.get(re.sub(r"_\d+$", "", read))
            if c == m["cluster"]:
                return True
    return False


def cluster_label(c: int) -> str:
    """getClusterLabel(c, compact=True) for ordinary clusters."""
    if c == -1:
        return "Unassigned"
    return f"C{c}"


def build_groups(comparison: str, panels: list, cluster_panels: list, visible: list) -> list:
    """buildGroups (engine.ts). panels: {key, datasetId, label, datasetLabel?, color?}; visible: [{cluster, color}]."""
    def datasets_of(ps):
        seen, out = set(), []
        for p in ps:
            if p["datasetId"] not in seen:
                seen.add(p["datasetId"])
                out.append(p)
        return out

    if comparison in ("datasets", "pools"):
        return [{"id": f"ds:{p['datasetId']}", "title": p.get("datasetLabel") or p["label"], "color": p.get("color"),
                 "dataset": p["datasetId"], "match": [{"dataset": p["datasetId"], "panelKey": p["key"], "cluster": None}]}
                for p in datasets_of(panels)]
    cps = cluster_panels
    if not cps or not visible:
        return []
    if comparison == "clusters-datasets" or len(cps) == 1:
        first = {}
        for i, p in enumerate(cps):
            first.setdefault(p["datasetId"], i)
        shared = {p["datasetId"] for i, p in enumerate(cps) if first[p["datasetId"]] != i}

        def name(p):
            return p["label"] if p["datasetId"] in shared else (p.get("datasetLabel") or p["label"])
        return [{"id": f"{p['key']}|{c['cluster']}",
                 "title": f"{name(p) + ' · ' if len(cps) > 1 else ''}{cluster_label(c['cluster'])}",
                 "color": c.get("color"), "dataset": p["datasetId"],
                 "match": [{"dataset": p["datasetId"], "panelKey": p["key"], "cluster": c["cluster"]}]}
                for p in cps for c in visible]
    return [{"id": f"cl:{c['cluster']}", "title": cluster_label(c["cluster"]), "color": c.get("color"), "dataset": None,
             "match": [{"dataset": p["datasetId"], "panelKey": p["key"], "cluster": c["cluster"]} for p in cps]}
            for c in visible]


def ci_method_for(kind: str, ci: str) -> str:
    if kind == "group" or ci == "none":
        return "none"
    if ci == "wilson":
        return "wilson" if kind == "share" else "none"
    if ci == "bootstrap":
        return "bootstrap"
    return "wilson" if kind == "share" else "bootstrap"


def baseline_for(kind: str, windowed: bool, baseline: str, y_scale_baseline: str = "region") -> str:
    layer = kind in ("fraction", "rate", "ratio")
    b = (y_scale_baseline if layer else "pooled") if baseline == "auto" else baseline
    if b in ("flank", "dataset") and not (layer and windowed):
        return "region"
    return b


def value_scale(kind: str, stat: str, bounds_bp: float) -> float:
    if kind == "rate":
        return bounds_bp if stat == "area" else 1000
    if kind == "fraction" and stat == "area":
        return bounds_bp
    return 1


def enrich_form(ratio, form: str):
    if ratio is None or not math.isfinite(ratio):
        return None
    if form == "percent":
        return ratio * 100
    if form == "log2":
        return math.log2(ratio) if ratio > 0 else None
    return ratio


def _ratio(n, d):
    return n / d if d > 0 else None


def compute_quant(spec: dict, measures: list, groups: list, assignments: dict, bounds_bp: float, seed: int,
                  y_scale_baseline: str = "region", weights: Optional[Weights] = None) -> dict:
    """computeQuant (engine.ts). measures: [(def, data)] with def {id, label, kind, unit, source, color?, enrichment,
    windowed, note?} and data {units?: {key: sums}, binned?: {...}, sampled?, readSource?}."""
    B = spec["resamples"]
    weights = weights if weights is not None else Weights()
    ref_id = spec["reference"] if spec["reference"] and any(g["id"] == spec["reference"] for g in groups) else (groups[0]["id"] if groups else None)
    cells, tests, infos = [], {}, []
    datasets = list(dict.fromkeys(m["dataset"] for g in groups for m in g["match"]))
    for d, data in measures:
        method = ci_method_for(d["kind"], spec["ci"])
        enrich_on = spec["value"] == "enrichment" and d["enrichment"] and d["kind"] != "group"
        base = baseline_for(d["kind"], d["windowed"], spec["baseline"], y_scale_baseline) if enrich_on else None
        info = {"id": d["id"], "label": d["label"], "kind": d["kind"], "unit": d["unit"], "source": d["source"],
                "color": d.get("color"), "enrichment": d["enrichment"], "windowed": d["windowed"], "note": d.get("note"),
                "baseline": base, "method": method}
        infos.append(info)
        scale = value_scale(d["kind"], spec["stat"], bounds_bp)
        if data.get("binned"):
            info["units"] = "curve"
            if base in ("flank", "dataset") and not data["binned"].get("res"):
                info["baseline"] = "region"
            used = _binned_measure(d, data["binned"], spec, groups, assignments, seed, info["baseline"], method, enrich_on,
                                   scale, ref_id, datasets, cells, weights)
            if used < B:
                info["resamplesUsed"] = used
            tests[d["id"]] = None
            continue
        if d["kind"] in ("fraction", "rate"):
            info["units"] = "exact"
        units = data.get("units") or {}
        by_group = [[] for _ in groups]
        by_dataset = {ds: [] for ds in datasets}
        for key, v in units.items():
            ds, read = unit_parts(key)
            u = (key, list(v))
            if ds in by_dataset:
                by_dataset[ds].append(u)
            for i, g in enumerate(groups):
                if is_member(g, ds, read, assignments):
                    by_group[i].append(u)

        def totals(lst):
            t = np.zeros(UNIT_COLS)
            for _k, v in lst:
                t += np.asarray(v, dtype=np.float64)
            return t
        T = [totals(lst) for lst in by_group]
        Td = {ds: totals(lst) for ds, lst in by_dataset.items()}

        def n_of(lst):
            return sum(1 for _k, v in lst if v[1] > 0)
        Tall = np.sum(T, axis=0) if T else np.zeros(UNIT_COLS)
        ref_idx = next((i for i, g in enumerate(groups) if g["id"] == ref_id), -1) if ref_id else -1

        def base_of(i, X, allv, Dx):
            g = groups[i]
            own = X(i)

            def ds_sum(c0):
                n = dd = 0.0
                for ds in dict.fromkeys(m["dataset"] for m in g["match"]):
                    s = Dx(ds)
                    if s is not None:
                        n += s[c0]
                        dd += s[c0 + 1]
                return n, dd
            if base == "pooled":
                return allv[0], allv[1]
            if base == "rest":
                return allv[0] - own[0], allv[1] - own[1]
            if base == "reference":
                if ref_idx < 0:
                    return None
                r = X(ref_idx)
                return r[0], r[1]
            if base == "region":
                return ds_sum(0)
            if base == "flank":
                return own[2], own[3]
            if base == "dataset":
                return ds_sum(4)
            return None

        need_boot = method == "bootstrap" or enrich_on or spec["compare"] != "off"
        S, Sd, Sall = [], {}, None
        if need_boot and B > 0:
            S = [bootstrap_draws(lst, B, seed, weights) if lst else np.zeros((B, UNIT_COLS)) for lst in by_group]
            if base in ("region", "dataset"):
                Sd = {ds: (bootstrap_draws(lst, B, seed, weights) if lst else np.zeros((B, UNIT_COLS))) for ds, lst in by_dataset.items()}
            Sall = np.sum(S, axis=0) if S else np.zeros((B, UNIT_COLS))
        values = [None if _ratio(t[0], t[1]) is None else _ratio(t[0], t[1]) * scale for t in T]
        ref_value = values[ref_idx] if ref_idx >= 0 else None

        def cmp_of(v, r):
            if v is None or r is None:
                return None
            if spec["compare"] == "diff":
                return v - r
            return math.log2(v / r) if v > 0 and r > 0 else None

        for i, g in enumerate(groups):
            t = T[i]
            n = n_of(by_group[i])
            value = values[i]
            lo = hi = None
            if value is not None and method == "wilson":
                wl, wh = wilson_interval(t[0], t[1])
                lo, hi = wl * scale, wh * scale
            vb, eb, cb = [], [], []
            enrich = None
            if enrich_on:
                bs = base_of(i, lambda j: T[j], Tall, lambda ds: Td.get(ds))
                br = _ratio(bs[0], bs[1]) if bs else None
                enrich = enrich_form(_ratio(t[0], t[1]) / (br if br is not None else math.nan), spec["form"]) if bs and value is not None else None
            if S and Sall is not None:
                for b in range(B):
                    x = S[i][b]
                    r = _ratio(x[0], x[1])
                    if r is None:
                        continue
                    vb.append(r * scale)
                    if enrich_on:
                        bs = base_of(i, lambda j: S[j][b], Sall[b], lambda ds: Sd[ds][b] if ds in Sd else None)
                        br = _ratio(bs[0], bs[1]) if bs else None
                        e = enrich_form(r / br, spec["form"]) if br else None
                        if e is not None:
                            eb.append(e)
                    if spec["compare"] != "off" and ref_idx >= 0 and ref_idx != i:
                        rx = S[ref_idx][b]
                        rr = _ratio(rx[0], rx[1])
                        c = cmp_of(r * scale, None if rr is None else rr * scale)
                        if c is not None:
                            cb.append(c)
                if method == "bootstrap" and value is not None:
                    ci = percentile_interval(vb)
                    if ci:
                        lo, hi = ci
            eci = percentile_interval(eb) if enrich_on and method != "none" and enrich is not None else None
            cmp = None if spec["compare"] == "off" else ((None if value is None else 0) if ref_idx == i else cmp_of(value, ref_value))
            cci = percentile_interval(cb) if spec["compare"] != "off" and ref_idx != i and cmp is not None and method != "none" else None
            cells.append({"measure": d["id"], "group": g["id"], "value": value, "lo": lo, "hi": hi, "n": n,
                          "k": float(t[0]) if d["kind"] == "share" else None, "low": n < spec["minReads"], "method": method,
                          "enrich": enrich, "enrichLo": eci[0] if eci else None, "enrichHi": eci[1] if eci else None,
                          "cmp": cmp, "cmpLo": cci[0] if cci else None, "cmpHi": cci[1] if cci else None})
        if d["kind"] == "share" and spec["test"] != "off":
            rows = [{"k": T[i][0], "n": T[i][1]} for i in range(len(groups)) if n_of(by_group[i]) >= spec["minReads"]]
            t = equal_shares_test(rows, spec["test"])
            tests[d["id"]] = {**t, "q": None, "method": spec["test"]} if t else None
        else:
            tests[d["id"]] = None
    tested = [(k, t) for k, t in tests.items() if t is not None]
    if tested:
        ps = [t["p"] for _k, t in tested]
        q = benjamini_hochberg(ps) if spec["adjust"] == "bh" else ps
        for (k, t), qq in zip(tested, q):
            tests[k] = {**t, "q": qq}
    return {"cells": cells, "groups": [{"id": g["id"], "title": g["title"], "color": g.get("color"), "dataset": g["dataset"]} for g in groups],
            "measures": infos, "tests": tests, "reference": ref_id, "boundsBp": bounds_bp, "seed": seed, "resamples": B}


def _binned_measure(d, bd, spec, groups, assignments, seed, base, method, enrich_on, scale, ref_id, datasets, cells,
                    weights) -> int:
    """binnedMeasure (engine.ts): curve units."""
    W = np.asarray(bd["weights"], dtype=np.float64)
    nb = len(W)
    wsum = float(W.sum()) or 1.0
    members = [[] for _ in groups]
    by_ds = {ds: [] for ds in datasets}
    nnz = 0
    for key, u in bd["units"].items():
        ds, read = unit_parts(key)
        if ds in by_ds:
            by_ds[ds].append((key, u))
        for i, g in enumerate(groups):
            if is_member(g, ds, read, assignments):
                members[i].append((key, u))
                nnz += len(u["idx"])
    R = int(bd.get("res") or 0)
    view_base = R > 0 and base in ("flank", "dataset")
    flank = bd.get("flank") or []

    def full_sums(lst):
        S, C = np.zeros(R), np.zeros(R)
        for _k, u in lst:
            a = u.get("all")
            if a:
                np.add.at(S, a["idx"], a["sig"])
                np.add.at(C, a["idx"], a["cov"])
        return S, C

    def bins_mean(S, C, bins):
        idx = range(R) if bins is None else bins
        n = R if bins is None else len(bins)
        m, anyc = 0.0, False
        for b in idx:
            if C[b] > 0:
                anyc = True
                m += S[b] / C[b]
        return m / n if anyc and n else None

    nnz_view = 0
    if view_base:
        for lst in (members if base == "flank" else list(by_ds.values())):
            for _k, u in lst:
                nnz_view += len((u.get("all") or {}).get("idx") or [])
    Fg = [full_sums(lst) for lst in members] if view_base and base == "flank" else []
    Fd = {ds: full_sums(lst) for ds, lst in by_ds.items()} if view_base and base == "dataset" else {}

    def ds_full(i, F):
        S, C = np.zeros(R), np.zeros(R)
        for ds in dict.fromkeys(m["dataset"] for m in groups[i]["match"]):
            x = F(ds)
            if x is not None:
                S += x[0]
                C += x[1]
        return bins_mean(S, C, None)

    def sums(lst):
        S, C = np.zeros(nb), np.zeros(nb)
        for _k, u in lst:
            np.add.at(S, u["idx"], u["sig"])
            np.add.at(C, u["idx"], u["cov"])
        return S, C

    def mean_of(S, C):
        m, anyc = 0.0, False
        for b in range(nb):
            if C[b] > 0:
                anyc = True
                m += W[b] * (S[b] / C[b])
        return m / wsum if anyc else None

    T = [sums(lst) for lst in members]
    Td = {ds: sums(lst) for ds, lst in by_ds.items()}

    def add(xs):
        S, C = np.zeros(nb), np.zeros(nb)
        for x in xs:
            S += x[0]
            C += x[1]
        return S, C
    pooled = add(T)
    ref_idx = next((i for i, g in enumerate(groups) if g["id"] == ref_id), -1) if ref_id else -1

    def base_of(i, X, allv, D, V=None):
        if view_base and base == "flank":
            v = V["g"](i) if V else Fg[i]
            return bins_mean(v[0], v[1], flank)
        if view_base and base == "dataset":
            return ds_full(i, V["d"] if V else (lambda ds: Fd.get(ds)))
        own = X(i)
        if base == "pooled":
            return mean_of(allv[0], allv[1])
        if base == "rest":
            return mean_of(allv[0] - own[0], allv[1] - own[1])
        if base == "reference":
            if ref_idx < 0:
                return None
            r = X(ref_idx)
            return mean_of(r[0], r[1])
        if base == "region":
            S, C = np.zeros(nb), np.zeros(nb)
            for ds in dict.fromkeys(m["dataset"] for m in groups[i]["match"]):
                x = D(ds)
                if x is not None:
                    S += x[0]
                    C += x[1]
            return mean_of(S, C)
        return None

    values = [None if mean_of(*t) is None else mean_of(*t) * scale for t in T]
    ref_value = values[ref_idx] if ref_idx >= 0 else None

    def cmp_of(v, r):
        if v is None or r is None:
            return None
        if spec["compare"] == "diff":
            return v - r
        return math.log2(v / r) if v > 0 and r > 0 else None

    need_boot = method == "bootstrap"   # engine.ts: no resamples (and no intervals) under "Interval: none"
    B = min(spec["resamples"], max(200, math.floor(BINNED_BOOT_BUDGET / max(1, nnz + (nnz_view if enrich_on else 0))))) if need_boot else 0

    def draws(lst, size, part):
        S, C = np.zeros((B, size)), np.zeros((B, size))
        weights.prefetch(seed, [key for key, _u in lst], B)
        for key, u in lst:
            src = u if part == "win" else u.get("all")
            if not src or not len(src["idx"]):
                continue
            w = weights.get_draws(seed, key, B)
            nzb = np.nonzero(w)[0]
            if not len(nzb):
                continue
            # A unit's bins are distinct, so (resample, bin) pairs never repeat: plain fancy-index adds suffice.
            idx = np.asarray(src["idx"], dtype=np.int64)
            k = w[nzb][:, None]
            S[nzb[:, None], idx[None, :]] += k * np.asarray(src["sig"], dtype=np.float64)[None, :]
            C[nzb[:, None], idx[None, :]] += k * np.asarray(src["cov"], dtype=np.float64)[None, :]
        return S, C

    D = [draws(lst, nb, "win") for lst in members] if B else []
    Dd = {ds: draws(lst, nb, "win") for ds, lst in by_ds.items()} if B and base == "region" else {}
    Dall = (np.sum([x[0] for x in D], axis=0), np.sum([x[1] for x in D], axis=0)) if B and D else None
    VG = [draws(lst, R, "all") for lst in members] if B and enrich_on and view_base and base == "flank" else []
    VD = {ds: draws(lst, R, "all") for ds, lst in by_ds.items()} if B and enrich_on and view_base and base == "dataset" else {}
    for i, g in enumerate(groups):
        value = values[i]
        n = sum(1 for _k, u in members[i] if len(u["idx"]))
        enrich = None
        if enrich_on and value is not None:
            bv = base_of(i, lambda j: T[j], pooled, lambda ds: Td.get(ds))
            enrich = enrich_form(value / scale / bv, spec["form"]) if bv else None
        vb, eb, cb = [], [], []
        if Dall is not None:
            for b in range(B):
                m = mean_of(D[i][0][b], D[i][1][b])
                if m is None:
                    continue
                vb.append(m * scale)
                if enrich_on:
                    bv = base_of(i, lambda j: (D[j][0][b], D[j][1][b]), (Dall[0][b], Dall[1][b]),
                                 lambda ds: (Dd[ds][0][b], Dd[ds][1][b]) if ds in Dd else None,
                                 {"g": lambda j: (VG[j][0][b], VG[j][1][b]),
                                  "d": lambda ds: (VD[ds][0][b], VD[ds][1][b]) if ds in VD else None})
                    e = enrich_form(m / bv, spec["form"]) if bv else None
                    if e is not None:
                        eb.append(e)
                if spec["compare"] != "off" and ref_idx >= 0 and ref_idx != i:
                    r = mean_of(D[ref_idx][0][b], D[ref_idx][1][b])
                    c = cmp_of(m * scale, None if r is None else r * scale)
                    if c is not None:
                        cb.append(c)
        ci = percentile_interval(vb) if method == "bootstrap" and value is not None else None
        eci = percentile_interval(eb) if enrich_on and method != "none" and enrich is not None else None
        cmp = None if spec["compare"] == "off" else ((None if value is None else 0) if ref_idx == i else cmp_of(value, ref_value))
        cci = percentile_interval(cb) if spec["compare"] != "off" and ref_idx != i and cmp is not None and method != "none" else None
        cells.append({"measure": d["id"], "group": g["id"], "value": value, "lo": ci[0] if ci else None,
                      "hi": ci[1] if ci else None, "n": n, "k": None, "low": n < spec["minReads"], "method": method,
                      "enrich": enrich, "enrichLo": eci[0] if eci else None, "enrichHi": eci[1] if eci else None,
                      "cmp": cmp, "cmpLo": cci[0] if cci else None, "cmpHi": cci[1] if cci else None})
    return B


def _to_precision6(v: float) -> float:
    """Number(v.toPrecision(6)): six significant digits of the double's exact value, halves rounded up (away from
    zero), as JavaScript does (Python's format rounds halves to even)."""
    from decimal import ROUND_HALF_UP, Decimal
    d = Decimal(float(v))
    if d == 0:
        return 0.0
    return float(d.quantize(Decimal(1).scaleb(d.adjusted() - 5), rounding=ROUND_HALF_UP))


def _fmt(v) -> str:
    """String(+v.toPrecision(6)) for finite numbers, NA otherwise."""
    if v is None or not isinstance(v, (int, float)) or not math.isfinite(v):
        return "NA"
    x = _to_precision6(v)
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    s = repr(x)
    if "e" in s:
        mant, exp = s.split("e")
        exp_i = int(exp)
        if -7 < exp_i < 21:
            return f"{x:.{max(0, 6 - exp_i)}f}".rstrip("0").rstrip(".")
        return f"{mant}e{'+' if exp_i > 0 else '-'}{abs(exp_i)}"
    return s


TSV_COLUMNS = ["measure", "source", "unit", "group", "n_reads", "members", "value", "lo95", "hi95", "interval",
               "enrichment", "enrich_lo95", "enrich_hi95", "vs_reference", "vs_ref_lo95", "vs_ref_hi95", "few_reads",
               "test_p", "test_q"]


def quant_tsv(r: dict, header: list) -> str:
    """quantTsv (engine.ts)."""
    g = {x["id"]: x for x in r["groups"]}
    m = {x["id"]: x for x in r["measures"]}
    lines = [f"# {h}" for h in header]
    lines.append("\t".join(TSV_COLUMNS))
    for c in r["cells"]:
        mi, t = m[c["measure"]], r["tests"].get(c["measure"])
        k = c["k"]
        lines.append("\t".join(str(x) for x in [
            mi["label"], mi["source"], mi["unit"], (g.get(c["group"]) or {}).get("title", c["group"]),
            c["n"] if c["n"] is not None else "NA", _fmt(k) if k is not None else "NA", _fmt(c["value"]), _fmt(c["lo"]),
            _fmt(c["hi"]), c["method"], _fmt(c["enrich"]), _fmt(c["enrichLo"]), _fmt(c["enrichHi"]), _fmt(c["cmp"]),
            _fmt(c["cmpLo"]), _fmt(c["cmpHi"]), "yes" if c["low"] else "no", _fmt((t or {}).get("p")), _fmt((t or {}).get("q"))]))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------ measures

LAYER_LABELS = {"tf": "TF", "fire": "Accessibility", "msp": "Accessibility", "deam": "Deam", "m6a": "m6A", "m5c": "5mC"}


def layer_measure(key: str, has_tf: bool = True, label: Optional[str] = None) -> dict:
    """A layer measure (layerMeasures, sources.ts); ``label`` from the metaprofile source catalog when known."""
    marks = is_mark_layer(key)
    label = label or (("Nuc" if has_tf else "FP") if key in ("nuc", "footprint") else LAYER_LABELS.get(key, key))
    return {"id": f"layer:{key}", "label": label, "source": "layers", "kind": "rate" if marks else "fraction",
            "unit": "marks per kb of read" if marks else "fraction of covered bp", "enrichment": True, "windowed": True}


def size_band_measure() -> dict:
    return {"id": SIZE_BAND_MEASURE, "label": "Footprints in the size band", "source": "size-band", "kind": "ratio",
            "unit": "share of footprints in the size band", "enrichment": True, "windowed": True,
            "note": "footprints counted by their centre (one wider than the view, with no known centre, is left out); "
                    "the band is set in Options"}


def check_measures(ids: list) -> None:
    """Refuse measures the server cannot compute (browser-side runs), with what to do instead."""
    for mid in ids:
        source = mid.split(":", 1)[0]
        if mid == SIZE_BAND_MEASURE or source == "layer":
            continue
        if source in UNSUPPORTED_SOURCES or mid == "nuc:regularity":
            raise ValueError(f"Measure {mid!r}: {UNSUPPORTED_SOURCES.get(source, 'a browser-side measure')} is not "
                             "computed headlessly; quantify it in the browser (Quantify card) and Save its TSV, or "
                             "quantify layers (layer:nuc, layer:tf, layer:fire, layer:m6a, ...) and size:band here")
        raise ValueError(f"Unknown measure {mid!r}: use layer:<layer> (layer:nuc, layer:tf, layer:fire, layer:m6a, ...) "
                         "or size:band")
