"""Footprint-class track (ConsensusFamilyTrack.tsx): population classes of a consensus job.

Shown only for a dataset carrying a consensus (footprint-class) job, as in the
browser. Draws the frozen catalog the browser loads (same server function as
/api/footprint/consensus/jobs/{id}/catalog): lanes packed over the whole
catalog, class colours from the catalog palette, 95% edge-uncertainty bands.
Interactive selection/linked outlines live in the browser's consensus store,
which is not part of the saved view, so they are not drawn.
"""
from __future__ import annotations

import json

from services.figure.tracks import register
from services.figure.tracks._util import cluster_sidebar_width, rounded_rect_points
from utils.chrom import normalize_chrom_name

DEFAULT_HEIGHT = 60
HEADER_HEIGHT = 20
LANE = 20
COLORS = ["#d88724", "#497fc5", "#9566bb", "#28a88f", "#c35b93", "#6b9b2c", "#b26345", "#5da6bd",
          "#cbb12a", "#7362b9", "#dc7168", "#428d73", "#a767a0", "#707da6", "#b48c55", "#729e9e"]


def consensus_job_id(dataset: dict | None) -> str | None:
    """consensusJobId (ConsensusFamilyTrack.tsx): recaller runs register only their class layer (tf_rc); other
    engines the labelled native one (tf_cr). Same precedence as the browser: tf_cr, then tf_rc."""
    layers = (dataset or {}).get("derived_layers") or {}
    for name in ("tf_cr", "tf_rc"):
        job = (layers.get(name) or {}).get("consensus_job_id")
        if job is not None:
            return job
    return None


def load_catalog(ctx, job_id: str):
    """(catalog, error) for the job, like useConsensusViewStore.load."""
    def load():
        try:
            from routers.footprint import _consensus_catalog_payload
            catalog = _consensus_catalog_payload(job_id, ctx.state)
            return _normalize(json.loads(json.dumps(catalog, default=str))), None
        except Exception as exc:  # HTTPException 404 etc.
            detail = getattr(exc, "detail", None) or str(exc)
            return None, f"Error: {detail}"

    return ctx.data.get(("consensus.catalog", job_id), load)


def _normalize(catalog: dict) -> dict:
    """normalizeConsensusCatalog: native link edges -> left/right aliases."""
    edges = []
    for edge in catalog.get("edges") or []:
        if "link_id" in edge:
            ds = edge.get("datasets") or []
            if len(ds) == 2:
                left, right = ds
                edge = {**edge, "left_dataset": left, "right_dataset": right,
                        "left_family": (edge.get("families") or {}).get(left),
                        "right_family": (edge.get("families") or {}).get(right),
                        "comparability_mask": edge.get("comparable")}
        edges.append(edge)
    return {**catalog, "edges": edges}


def display_families(dataset: dict | None) -> list[dict]:
    rows = {f["family"]: f for f in (dataset or {}).get("catalog") or []}
    for f in (dataset or {}).get("curated_display_families") or []:
        start = f.get("display_start") if f.get("manual") else f.get("consensus_start")
        end = f.get("display_end") if f.get("manual") else f.get("consensus_end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        rows[f["family"]] = {**f, "consensus_start": start, "consensus_end": end}
    return [f for f in rows.values() if not f.get("superseded_by_manual")]


def family_count(f: dict) -> int:
    if f.get("manual"):
        return len(f.get("effective_call_ids") or [])
    counts = f.get("classification_counts")
    if counts:
        key = "compatible_calls" if f.get("stage") else "primary_calls"
        return sum(int(r.get(key) or 0) for r in counts.values())
    return sum(int(r.get("after_sr_assignments") or 0) for r in (f.get("rates_by_strand") or {}).values())


def pack_families(families: list[dict]) -> list[dict]:
    ends: list[float] = []
    out = []
    for f in sorted(families, key=lambda f: (f["consensus_start"], -f["consensus_end"], f["family"])):
        lane = next((i for i, e in enumerate(ends) if e <= f["consensus_start"]), -1)
        if lane < 0:
            lane = len(ends)
            ends.append(f["consensus_end"])
        else:
            ends[lane] = f["consensus_end"]
        out.append({**f, "lane": lane})
    return out


def palette(catalog: dict) -> dict[str, str]:
    """setConsensusPalette over the whole catalog (not the viewport)."""
    ids = sorted({f["family"] for ds in (catalog.get("datasets") or {}).values()
                  for f in list(ds.get("catalog") or []) + list(ds.get("curated_display_families") or [])
                  if not f.get("superseded_by_manual")})
    out = {}
    for i, fid in enumerate(ids):
        if i < len(COLORS):
            out[fid] = COLORS[i]
        else:
            j = i - len(COLORS)
            out[fid] = f"hsl({(j * 137.508) % 360} 62% {42 + (j % 3) * 8}%)"
    return out


def family_color(fid: str, colors: dict[str, str]) -> str:
    if fid in colors:
        return colors[fid]
    h = 2166136261
    for ch in fid.encode("utf-16-le").decode("utf-16-le"):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return COLORS[h % len(COLORS)]


def _comparable(catalog: dict, dataset_id: str) -> set[str]:
    out = set()
    for e in catalog.get("edges") or []:
        if not e.get("comparability_mask") and not (catalog.get("cr_mode") == "staged_native_families"
                                                    and e.get("shared_hypothesis")):
            continue
        for side in ("left", "right"):
            ds = e.get(f"{side}_dataset")
            fam = e.get(f"{side}_family")
            if ds is None:
                owners = [k for k, v in (catalog.get("datasets") or {}).items()
                          if any(f.get("family") == fam for f in v.get("catalog") or [])]
                ds = owners[0] if len(owners) == 1 else None
            if ds == dataset_id and fam:
                out.add(fam)
    return out


def measure(ctx, track) -> float:
    if not consensus_job_id(ctx.panel.dataset):
        return 0.0
    return float(track.height or DEFAULT_HEIGHT)


def draw(surface, ctx, track, height: float) -> None:
    width = ctx.width
    sidebar = cluster_sidebar_width(ctx)
    ds_id = ctx.panel.dataset_id
    job_id = consensus_job_id(ctx.panel.dataset)
    catalog, error = load_catalog(ctx, job_id)

    surface.rect(0, 0, width, height, fill="#f8fafc")
    surface.line(0, 0.5, width, 0.5, "#e2e8f0", 1)
    surface.line(0, height - 0.5, width, height - 0.5, "#e2e8f0", 1)

    visible: list[dict] = []
    ds = None
    if catalog:
        ds = (catalog.get("datasets") or {}).get(ds_id)
        minimum = int(ctx.fe.get("consensusTrackMinimumCount") or 0)
        packed = pack_families([f for f in display_families(ds) if family_count(f) >= minimum])
        region = catalog.get("region")
        # sameChrom (chromAliases.ts): '2L' and 'chr2L' are one chromosome.
        if not region or normalize_chrom_name(str(region.get("chrom"))) == normalize_chrom_name(str(ctx.chrom)):
            visible = [f for f in packed if f["consensus_start"] < ctx.end and f["consensus_end"] > ctx.start]

    surface.text(4, 12, f"Footprint classes ({len(visible)})", size=10, color="#111827")
    if ctx.fe.get("showAnalysisDetails"):
        surface.text(width - 4, 12, "all-molecule catalog", size=10, color="#111827", anchor="end")

    body_top = HEADER_HEIGHT + 1
    surface.save()
    surface.clip_rect(0, body_top, width, max(20, height - HEADER_HEIGHT) - 1)
    if error:
        surface.text(0, body_top + 12, error, size=12, color="#b91c1c")
    elif not visible:
        surface.text(0, body_top + 12, "No population classes in this view.", size=12, color="#6b7280")
    else:
        _draw_families(surface, ctx, catalog, ds, ds_id, visible, width, sidebar, body_top)
    surface.restore()


def _draw_families(surface, ctx, catalog, ds, ds_id, visible, width, sidebar, top) -> None:
    colors = palette(catalog)
    comparable = _comparable(catalog, ds_id)
    lanes = sorted({f["lane"] for f in visible})
    lane_index = {lane: i for i, lane in enumerate(lanes)}
    start, end, rev = ctx.start, ctx.end, ctx.reversed

    def tx(pos: float) -> float:
        frac = (pos - start) / max(1, end - start)
        return sidebar + ((1 - frac) if rev else frac) * max(0.0, width - sidebar)

    for f in visible:  # uncertainty bands under every core
        if f.get("manual"):
            continue
        y = top + lane_index.get(f["lane"], 0) * LANE + 3
        unc = f.get("edge_uncertainty") or {}
        for rng in ([unc.get("left"), unc.get("right")] if unc else []):
            if not rng or not (rng[0] < end and rng[1] > start):
                continue
            p, q = tx(max(start, rng[0])), tx(min(end, rng[1]))
            surface.rect(min(p, q), y - 1, max(1, abs(q - p)), 15, fill=family_color(f["family"], colors), opacity=0.2)

    labels = bool(ctx.fe.get("consensusTrackLabels"))
    ignored_by_curation = set(((catalog.get("curation") or {}).get("ignored_families") or {}).get(ds_id) or [])
    ordered_rows = sorted(display_families(ds), key=lambda r: (r["consensus_start"], r["consensus_end"], r["family"]))
    for f in visible:
        a, b = tx(max(start, f["consensus_start"])), tx(min(end, f["consensus_end"]))
        x, w = min(a, b), max(3, abs(b - a))
        y = top + lane_index.get(f["lane"], 0) * LANE + 3
        ignored = f.get("ignored") or f["family"] in ignored_by_curation
        stroke = "#7c3aed" if f.get("manual") else "#0891b2" if f["family"] in comparable else "#ffffff"
        pts = rounded_rect_points(x, y, w, 13, 2)
        surface.polygon(pts, fill=family_color(f["family"], colors), opacity=0.35 if ignored else 1.0)
        if f.get("manual"):
            closed = pts + pts[:1]
            for p1, p2 in zip(closed, closed[1:]):
                surface.line(*p1, *p2, color=stroke, width=1, dash=(3, 2))
        else:
            surface.polygon(pts, fill=None, stroke=stroke, stroke_width=1, opacity=0.35 if ignored else 1.0)
        if labels and w > 32:
            name = f.get("label") or next((f"Class {i + 1}" for i, r in enumerate(ordered_rows)
                                           if r["family"] == f["family"]), "Class")
            text = f"{name} · {family_count(f)}" if w > 68 else name.replace("Class ", "#")
            surface.text(x + 3, y + 10, ("M · " if f.get("manual") else "") + text, size=9, color="#ffffff")


register("consensus", measure, draw)
