"""Site sorts on authoritative node columns, independent of the displayed layout."""
from __future__ import annotations

import asyncio

from services.graph_panel import analysis, columns as gc
from services.read_selection import cohort_read_id, read_body_spans, read_matches_id_filter, with_graph_record_keys


def resolve_site(site, target, tiles):
    """Verify the selected visit and return a node-forward offset plus a unique target alias, if any."""
    results = [r for per in tiles.values() for r in per.values()]
    binding = str(site.get("binding") or "")
    occs = gc.merge_occurrences(results, binding)
    occ = occs.get(site.get("occurrence"))
    offset = site.get("offset")
    if occ is None or occ.node != site.get("node") or not isinstance(offset, int) or isinstance(offset, bool) \
            or not occ.carries(offset):
        raise analysis.GraphRunError("The sort site is no longer a carried graph column; choose it again")
    target_visits = gc.visits(gc.merge_occurrences(results, target)).get(occ.node, [])
    own_visits = gc.visits(occs).get(occ.node, [])
    # A repeated visit has no inferred cross-path correspondence. The target's own visit is an exact alias.
    alias = occ.pos(offset) if binding == target else (
        target_visits[0].pos(offset) if len(own_visits) == len(target_visits) == 1
        and target_visits[0].carries(offset) else None)
    return {"binding": binding, "occurrence": occ.id, "node": occ.node, "offset": offset,
            "target_position": alias, "repeated": len(own_visits) > 1 or len(target_visits) > 1}


def position_on_path(site, binding, tiles):
    results = [r for per in tiles.values() for r in per.values()]
    occs = gc.merge_occurrences(results, binding)
    hits = gc.visits(occs).get(site["node"], [])
    if binding == site["binding"]:
        hit = occs.get(site["occurrence"])
    else:
        hit = hits[0] if len(hits) == 1 and not site["repeated"] else None
    return hit.pos(site["offset"]) if hit and hit.carries(site["offset"]) else None


def site_value(row, pos, origin, sort_by, layer=None, rule=None):
    """Missing coverage/calls stay missing; a measured accessible base has footprint size zero."""
    from services.read_metrics import get_layer_intervals, compute_rule_metric
    p = pos - origin
    if not any(a <= p < b for a, b in read_body_spans(row)):
        return None
    intervals = [iv for iv in get_layer_intervals(row, layer) if iv[0] <= p < iv[1]]
    if not intervals:
        return None
    if sort_by == "footprint":
        return max(max(0, iv[2]) for iv in intervals)
    if sort_by == "accessibility":
        return int(not any(iv[2] > 0 for iv in intervals))
    # Reuse the rule matcher with original sizes and quality bytes, selecting intervals that contain the site.
    selected = {**row, "intervals": [iv for iv in row.get("intervals", []) if iv[0] <= p < iv[1]]}
    positives = [iv for iv in row.get("intervals", []) if iv[2] > 0]
    selected["qualities"] = [q for iv, q in zip(positives, row.get("qualities") or []) if iv[0] <= p < iv[1]]
    if row.get("fire") is not None:
        selected["fire"] = [iv for iv in row["fire"] if iv[0] <= p < iv[1]]
    selected["layers"] = {}
    for name, raw in (row.get("layers") or {}).items():
        idx = [i for i, iv in enumerate(raw.get("intervals") or []) if iv[0] <= p < iv[1]]
        selected["layers"][name] = {**raw, "intervals": [raw["intervals"][i] for i in idx],
                                   "qualities": [[q[i] for i in idx] if q is not None else None
                                                 for q in raw.get("qualities") or []]}
    return compute_rule_metric(selected, origin, rule, [], [], layer=layer)


def sort_rows(rows, pos, origin, sort_by, *, layer=None, rule=None, descending=True):
    values = [(cohort_read_id(r), site_value(r, pos, origin, sort_by, layer, rule)) for r in rows]
    values.sort(key=lambda item: (item[1] is None, (-item[1] if descending else item[1])
                                 if item[1] is not None else 0, item[0]))
    return [rid for rid, _ in values]


def run(state, spec, tiles, site, body):
    from services.analysis_query import AnalysisReadQuery
    from services.read_strand import filter_reads_by_strand, strand_calls
    results, cache = {}, {}
    for ob in spec["observations"]:
        binding = ob["binding"] or spec["target"]
        pos = position_on_path(site, binding, tiles)
        if pos is None:
            results[ob["id"]] = {"read_sort_order": [], "availability": "unresolved"}
            continue
        a, b = max(0, pos - analysis.WINDOW_PAD_BP), pos + analysis.WINDOW_PAD_BP + 1
        if ob["kind"] == "graph":
            rows, _ = analysis.graph_window_rows(state, analysis.GraphSource(ob["dataset_id"], binding, ob["contig"]), a, b, cache)
        else:
            query = AnalysisReadQuery.from_request(state, chrom=ob["chrom"], start=a, end=b,
                                                   dataset_ids=[ob["dataset_id"]], include_layers=True,
                                                   capability="sort", include_methylation=False,
                                                   **({"lift_hap_by_dataset": {ob["dataset_id"]: ob["lift_hap"]}}
                                                      if ob.get("lift_hap") else {}))
            rows = query.build_working_set(state, ob["dataset_id"]).reads
        if ob.get("read_ids") is not None:
            wanted = with_graph_record_keys(ob["read_ids"])
            rows = [r for r in rows if read_matches_id_filter(r, wanted)]
        if ob.get("strand"):
            rows = filter_reads_by_strand(rows, ob["strand"], strand_calls(state, ob["dataset_id"]))
        results[ob["id"]] = {"read_sort_order": sort_rows(rows, pos, a, body.get("sort_by", "footprint"),
            layer=body.get("layer"), rule=body.get("rule"), descending=body.get("descending", True)), "availability": "carried",
            "qnames": {cohort_read_id(r): r["id"] for r in rows}}
    return {"site": site, "results": results}


async def handle(state, reg, body):
    spec = analysis.parse(state, reg, body)
    if not isinstance(body.get("site"), dict):
        raise analysis.GraphRunError("site must name a graph node, occurrence and offset")
    if body.get("sort_by", "footprint") not in ("footprint", "accessibility", "rule"):
        raise analysis.GraphRunError("Graph site sort must be footprint, accessibility or rule")
    rule = body.get("rule")
    if body.get("sort_by") == "rule" and (not isinstance(rule, dict) or rule.get("conditions")):
        raise analysis.GraphRunError("Graph site rule sorts require a rule without coordinate-dependent conditions")
    sources, cells = analysis.needed_tiles(spec)
    tiles = await analysis.fetch_tiles(reg, spec["target"], sources, cells)
    site = resolve_site(body.get("site") or {}, spec["target"], tiles)
    return await asyncio.to_thread(run, state, spec, tiles, site, body)
