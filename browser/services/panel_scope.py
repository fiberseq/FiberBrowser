"""Which panels and which view a chart reads: a port of the browser's targeting and chart scope.

- ``target_state_keys``: useFocusedReadIds' targetStateKeys (stores/browserStore.ts getTargetDatasetIds +
  getStateKeyMap): with panels selected, those panels and every panel in one of their link groups; else every dataset
  panel. Keys in target-dataset order, each dataset's targeted panels in panel order.
- ``chart_scope``: clusterChartScope (components/controls/cluster-detail/clusterChartScope.ts) with
  utils/panelScope.ts (visibleDatasetPanels, panelView, activePanelId): the active panel's view (the selected visible
  panel; in per-panel navigation the latest move still on screen; else the first panel following the main view) when a
  key shows it, else the first key's first view; the keys whose panel shows that view. A view is identified by its
  reference and locus, so the same coordinates on two references are two views.

Panels come from the saved frontend state (``fe["panels"]``); ``loaded`` limits them to loaded datasets. Without saved
panels, each loaded dataset is one panel following the main view (the browser's defaults).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class View:
    chrom: str
    start: int
    end: int
    genome: Optional[str]      # the panel's own reference (None: the main one)
    genome_key: str

    @property
    def id(self) -> str:
        return f"{self.genome_key}|{self.chrom}:{self.start}-{self.end}"


def _as_set(v) -> set:
    if isinstance(v, (list, tuple, set)):
        return set(v)
    if isinstance(v, dict):
        return {k for k, on in v.items() if on}
    return set()


def dataset_panels(fe: dict, loaded: list[str], only: Optional[set] = None) -> list[dict]:
    """The dataset panels in arrangement order (contentType dataset with a loaded datasetId); ``only``: just these
    panel ids (the panels a headless reader can read)."""
    ok = set(loaded)
    panels = [p for p in fe.get("panels") or [] if isinstance(p, dict)
              and (p.get("contentType") or "dataset") == "dataset" and p.get("datasetId") in ok]
    if not panels:
        panels = [{"id": d, "datasetId": d} for d in loaded]
    if only is not None:
        panels = [p for p in panels if str(p.get("id")) in only]
    return panels


def _is_host(p) -> bool:
    return bool(p and (p.get("contentType") or "dataset") == "dataset" and p.get("viewMode")
                and (p.get("graphView") or {}).get("role") == "host")


def folded_in_shown_graph(p: dict, panels: list[dict]) -> Optional[dict]:
    """foldedInShownGraph (stores/graphMembership.ts): the shown graph host a collapsed member is folded into."""
    group = p.get("collapsedByGraphGroup")
    if not group or p.get("graphMemberOf") != group:
        return None
    host = next((q for q in panels if q.get("id") == group), None)
    if not _is_host(host) or host.get("viewMode") != "graph" or host.get("collapsed") \
            or ((host.get("graphView") or {}).get("handoff") or {}).get("shown") == "linear":
        return None
    return host


def _selected_with_host(p: dict, panels: list[dict], selected: set) -> bool:
    host = folded_in_shown_graph(p, panels) if p.get("collapsed") else None
    return bool(host and host.get("id") in selected)


def main_genome_key(fe: dict) -> str:
    return str(fe.get("currentGenome") or (os.path.basename(str(fe["fastaPath"])) if fe.get("fastaPath") else "") or "none")


def _main(fe: dict, main: tuple) -> View:
    return View(str(main[0]), int(main[1]), int(main[2]), None, main_genome_key(fe))


def panel_view(fe: dict, p: dict, main: tuple) -> View:
    v = p.get("viewportOverride") if isinstance(p.get("viewportOverride"), dict) else None
    chrom, start, end = (v["chrom"], v["start"], v["end"]) if v and v.get("chrom") is not None else main
    return View(str(chrom), int(start), int(end), p.get("genome") or None, str(p.get("genome") or main_genome_key(fe)))


def visible_dataset_panels(fe: dict, panels: list[dict]) -> list[dict]:
    full = fe.get("fullViewPanelId")
    if full:
        hit = next((p for p in fe.get("panels") or [] if isinstance(p, dict) and p.get("id") == full), None)
        if hit is not None:
            return [p for p in panels if p.get("id") == full]
    rows = _as_set(fe.get("collapsedRows"))
    return [p for p in panels if not p.get("collapsed") and int(p.get("layoutRow") or 0) not in rows]


def _same_locus(a, b) -> bool:
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    return (a.get("chrom"), a.get("start"), a.get("end")) == (b.get("chrom"), b.get("start"), b.get("end"))


def active_panel_id(fe: dict, panels: list[dict]) -> Optional[str]:
    visible = visible_dataset_panels(fe, panels)
    if not visible:
        return None
    selected = _as_set(fe.get("selectedDatasets"))
    hit = next((p for p in visible if p.get("id") in selected), None)
    if hit is not None:
        return hit["id"]
    if fe.get("navigationMode") == "perPanel":
        moves = [m for ms in (fe.get("lastMovedPanels") or {}).values() if isinstance(ms, list)
                 for m in ms if isinstance(m, dict)]
        moves.sort(key=lambda m: m.get("at") or 0)
        for m in reversed(moves):
            p = next((q for q in visible if q.get("id") == m.get("panelId")), None)
            if p is not None and _same_locus(p.get("viewportOverride"), m.get("locus")):
                return p["id"]
        return visible[0]["id"]
    return next((p for p in visible if not p.get("genome") and not p.get("viewportOverride")), visible[0])["id"]


def target_state_keys(fe: dict, loaded: list[str], only: Optional[set] = None) -> list[str]:
    """targetStateKeys (useFocusedReadIds): for each target dataset (getTargetDatasetIds), its targeted panels' state
    keys (getStateKeyMap), else the dataset id itself. ``only`` then keeps the keys a headless reader has a panel for
    (selection and link groups are judged on every saved panel first, as the browser does)."""
    every = dataset_panels(fe, loaded)
    selected = _as_set(fe.get("selectedDatasets"))
    order = list(dict.fromkeys([p["datasetId"] for p in every] + list(loaded)))
    if selected:
        # getTargetDatasetIds: selected panels (and members folded into a selected host), widened to their link groups.
        chosen = [p for p in every if p.get("id") in selected or _selected_with_host(p, every, selected)]
        ds = {p["datasetId"] for p in chosen}
        groups_ds = {p.get("linkGroup") for p in chosen if p.get("linkGroup")}
        ds |= {p["datasetId"] for p in every if p.get("linkGroup") and p.get("linkGroup") in groups_ds}
        order = [d for d in order if d in ds]
    # getStateKeyMap: the link groups of the directly selected panels only.
    groups = {p.get("linkGroup") for p in every if p.get("id") in selected and p.get("linkGroup")}

    def targeted(p):
        return (not selected or p.get("id") in selected or (p.get("linkGroup") is not None and p.get("linkGroup") in groups)
                or _selected_with_host(p, every, selected))
    by_ds: dict = {}
    for p in every:
        if p["datasetId"] in order and targeted(p):
            key = p.get("stateKey") or p["datasetId"]
            by_ds.setdefault(p["datasetId"], [])
            if key not in by_ds[p["datasetId"]]:
                by_ds[p["datasetId"]].append(key)
    keys: list = []
    for d in order:
        for k in by_ds.get(d) or [d]:  # useFocusedReadIds: stateKeyMap[ds] ?? [ds]
            if k not in keys:
                keys.append(k)
    if only is not None:
        readable = {p.get("stateKey") or p["datasetId"] for p in every if str(p.get("id")) in only}
        keys = [k for k in keys if k in readable]
    return keys


def chart_scope(fe: dict, loaded: list[str], keys: list[str], main: tuple, only: Optional[set] = None) -> tuple[View, list[str]]:
    panels = dataset_panels(fe, loaded, only)
    visible = {p.get("id") for p in visible_dataset_panels(fe, dataset_panels(fe, loaded))}
    main_view = _main(fe, main)
    views = {}
    for k in keys:
        mine = [p for p in panels if (p.get("stateKey") or p["datasetId"]) == k]
        mine.sort(key=lambda p: 0 if p.get("id") in visible else 1)
        views[k] = [panel_view(fe, p, main) for p in mine] or [main_view]
    every = dataset_panels(fe, loaded)
    aid = active_panel_id(fe, every)
    ap = next((p for p in every if p.get("id") == aid), None) if aid else None
    active = panel_view(fe, ap, main) if ap is not None else main_view
    shows = lambda k, vid: any(v.id == vid for v in views.get(k, []))  # noqa: E731
    view = active if any(shows(k, active.id) for k in keys) else (views[keys[0]][0] if keys else active)
    return view, [k for k in keys if shows(k, view.id)]


def panel_for(fe: dict, loaded: list[str], key: str, view: View, main: tuple, only: Optional[set] = None) -> Optional[dict]:
    """The panel of ``key`` that shows ``view`` (None when none does)."""
    for p in dataset_panels(fe, loaded, only):
        if (p.get("stateKey") or p["datasetId"]) == key and panel_view(fe, p, main).id == view.id:
            return p
    return None
