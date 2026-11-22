"""What a headless figure drew, per panel: read counts, cluster sizes, optional read ids, annotation statistics.

Built from the figure's own data (the reads each panel drew, cached during the render), so it always
describes the file it comes with. Returned with ``manifest=true`` and written into scripted-figure receipts.
"""
from __future__ import annotations

from collections import Counter
from typing import Optional


def _json_safe(value):
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    if isinstance(value, float) and value != value:
        return None
    return value


def build_manifest(spec, state, data, page: dict, *, read_ids: bool = False) -> dict:
    from services.figure.tracks import TrackContext
    from services.figure.tracks.reads import DEFAULT_SEED, _panel_state, cluster_for

    fe = spec.fe
    panels = []
    for panel in spec.panels:
        ctx = TrackContext(state, spec, panel, data, spec.width)
        entry = {
            "panel_id": panel.id, "dataset_id": panel.dataset_id, "label": panel.label,
            "state_key": panel.state_key, "strand": panel.strand,
            "region": {"chrom": ctx.chrom, "start": ctx.start, "end": ctx.end},
            "tracks": [t.type for t in panel.tracks],
            "max_reads": spec.panel_max_reads(panel),
        }
        view = data._cache.get(("reads-view", panel.id, panel.strand) + ctx.region)
        if view is None:
            entry["reads_drawn"] = None  # no read track drawn
        else:
            reads = view.get("reads") or []
            entry["reads_drawn"] = len(reads)
            entry["reads_loaded"] = int(view.get("server_count") or 0)
            entry["zoomed_out"] = bool(view.get("zoomed_out"))
            assignments = _panel_state(fe, panel.state_key)["assignments"]
            if assignments:
                counts = Counter(cluster_for(assignments, r["id"]) for r in reads)
                entry["clusters"] = {("unclustered" if c is None else str(c)): n for c, n in sorted(
                    counts.items(), key=lambda kv: (kv[0] is None, kv[0] if kv[0] is not None else 0))}
            if read_ids:
                entry["read_ids"] = [r["id"] for r in reads]
        stats = data._cache.get(("annotation-stats", panel.id))
        if stats is not None:
            entry["annotation"] = stats
        panels.append(entry)
    opts = {k: v for k, v in (spec.options or {}).items()}
    extra = {"meta_locus": spec.meta} if getattr(spec, "meta", None) else {}
    return _json_safe({**extra,
        "region": {"chrom": spec.chrom, "start": spec.start, "end": spec.end},
        "source": spec.source,
        "sample_seed": fe.get("analysisSampleSeed") or DEFAULT_SEED,
        "spanning_only": bool(fe.get("spanningOnly")),
        "reversed": bool(fe.get("isReversed")),
        "page": page,
        "options": opts,
        "panels": panels,
    })


def total_reads(manifest: Optional[dict]) -> int:
    return sum(int(p.get("reads_drawn") or 0) for p in (manifest or {}).get("panels") or [])
