"""Teach-only Copilot: tutorial actions, UI anchors, milestones and conditions.

Copilot teaches. It navigates and opens panels, tabs and sidebar sections for
the user and points at the controls (named UI anchors), but leaves the clicks
that run something (scan, cluster, filter, load, export, ...) to the user. A
``try_it`` step asks the user to do one and waits until they have.

The anchor, milestone and condition catalogs live in the frontend
(``frontend/src/data/tutorial*.json``) so both sides read one source.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

# Copilot plans hold only teach actions (see COPILOT_TEACH_ACTIONS). The typed
# operation actions stay available to the guided tour, the headless API and
# the notebook bridge, which don't go through the Copilot planner.
COPILOT_TEACH_ONLY = True

# The one place to adjust what Copilot may do: navigation, opening things,
# and pointing at controls. Everything else is left to the user.
COPILOT_TEACH_ACTIONS = frozenset({
    "explain",
    "try_it",
    "open_panel",
    "open_sidebar",
    "close_panel",
    "navigate_gene",
    "navigate_region",
    "zoom_view",
    "pan_view",
    "reset_view",
    "go_to_top_locus",
})

SIDEBAR_SECTIONS = ("file", "genome", "view", "analysis")

TRY_IT_DEFAULT_TIMEOUT_S = 120

_DATA_DIR = Path(__file__).resolve().parents[1] / "frontend" / "src" / "data"


@lru_cache(maxsize=1)
def load_anchor_catalog() -> dict[str, dict[str, Any]]:
    """Tutorial UI anchors by id (empty when the frontend sources aren't shipped)."""
    try:
        data = json.loads((_DATA_DIR / "tutorialAnchors.json").read_text())
    except (OSError, ValueError):
        return {}
    return {entry["id"]: entry for entry in data.get("anchors", []) if entry.get("id")}


@lru_cache(maxsize=1)
def load_milestone_catalog() -> dict[str, Any]:
    try:
        data = json.loads((_DATA_DIR / "tutorialMilestones.json").read_text())
    except (OSError, ValueError):
        data = {}
    return {
        "panel_types": list(data.get("panel_types", [])),
        "milestones": list(data.get("milestones", [])),
        "conditions": list(data.get("conditions", [])),
    }


def _subsections() -> set[str]:
    return {
        entry["reveal"]["subsection"]
        for entry in load_anchor_catalog().values()
        if entry.get("reveal", {}).get("subsection")
    }


def _valid_catalog_id(value: str, entries: list[dict[str, Any]]) -> bool:
    """`clustered`, or a parameterised id like `panel_opened:footprint-analysis`."""
    base, _, param = value.partition(":")
    panel_types = load_milestone_catalog()["panel_types"]
    for entry in entries:
        entry_base, _, entry_param = str(entry.get("id", "")).partition(":")
        if entry_base != base:
            continue
        if entry_param:
            return param in panel_types
        return not param
    return False


def valid_milestone(value: str) -> bool:
    return _valid_catalog_id(value, load_milestone_catalog()["milestones"])


def valid_condition(value: str) -> bool:
    return _valid_catalog_id(value, load_milestone_catalog()["conditions"])


def _text(action: dict[str, Any]) -> str:
    return str(action.get("text") or action.get("label") or "").strip()


def _anchor(action: dict[str, Any], warnings: list[str]) -> Optional[str]:
    anchor = str(action.get("anchor") or "").strip()
    if not anchor:
        return None
    if anchor not in load_anchor_catalog():
        warnings.append(f"Unknown UI anchor '{anchor}'; the step keeps its text without pointing at a control.")
        return None
    return anchor


def _panel(action: dict[str, Any]) -> Optional[str]:
    return str(action.get("panel_type") or action.get("panelType") or "").strip() or None


# Sentinel: the action isn't a tutorial action; the caller handles it.
NOT_TEACH = object()


def normalize_teach_action(action_type: str, action: dict[str, Any]):
    """Normalize the tutorial-only actions; returns NOT_TEACH for any other type."""
    warnings: list[str] = []

    if action_type == "explain":
        text = _text(action)
        if not text:
            return None, ["explain action needs `text` (the message to show the user)."]
        return {
            "type": "explain",
            "text": text,
            "anchor": _anchor(action, warnings),
            "panel_type": _panel(action),
            "tab": str(action.get("tab") or "").strip() or None,
            "label": text,
        }, warnings

    if action_type == "try_it":
        text = _text(action)
        if not text:
            return None, ["try_it needs `text` (what the user should do)."]
        anchor = _anchor(action, warnings)
        wait_for = str(action.get("wait_for") or "").strip()
        if wait_for and not valid_milestone(wait_for):
            warnings.append(f"Unknown milestone '{wait_for}'; the step became a plain explanation.")
            wait_for = ""
        if not wait_for:
            return {"type": "explain", "text": text, "anchor": anchor, "panel_type": _panel(action),
                    "tab": str(action.get("tab") or "").strip() or None, "label": text}, warnings
        timeout = action.get("timeout_s")
        try:
            timeout_s = int(timeout) if timeout is not None else TRY_IT_DEFAULT_TIMEOUT_S
        except (TypeError, ValueError):
            timeout_s = TRY_IT_DEFAULT_TIMEOUT_S
        return {
            "type": "try_it",
            "text": text,
            "anchor": anchor,
            "wait_for": wait_for,
            "timeout_s": max(5, min(900, timeout_s)),
            "panel_type": _panel(action),
            "tab": str(action.get("tab") or "").strip() or None,
            "label": text,
        }, warnings

    if action_type == "open_sidebar":
        section = str(action.get("section") or "").strip()
        if section not in SIDEBAR_SECTIONS:
            return None, [f"open_sidebar needs a section: one of {', '.join(SIDEBAR_SECTIONS)}."]
        subsection = str(action.get("subsection") or "").strip() or None
        if subsection and subsection not in _subsections():
            warnings.append(f"Unknown sidebar subsection '{subsection}'; opening the section only.")
            subsection = None
        return {"type": "open_sidebar", "section": section, "subsection": subsection,
                "label": str(action.get("label") or f"Open the {section} sidebar section")}, warnings

    if action_type == "close_panel":
        panel = _panel(action)
        if not panel or panel == "dataset":
            return None, ["close_panel needs the panel_type of an analysis panel."]
        return {"type": "close_panel", "panel_type": panel,
                "label": str(action.get("label") or f"Close the {panel} panel")}, warnings

    if action_type == "zoom_view":
        direction = str(action.get("direction") or "out").strip().lower()
        if direction not in ("in", "out"):
            return None, ["zoom_view direction must be 'in' or 'out'."]
        try:
            steps = int(action.get("steps") or 1)
        except (TypeError, ValueError):
            steps = 1
        return {"type": "zoom_view", "direction": direction, "steps": max(1, min(10, steps)),
                "label": str(action.get("label") or f"Zoom {direction}")}, warnings

    if action_type == "pan_view":
        direction = str(action.get("direction") or "").strip().lower()
        if direction not in ("left", "right"):
            return None, ["pan_view direction must be 'left' or 'right'."]
        return {"type": "pan_view", "direction": direction,
                "label": str(action.get("label") or f"Pan {direction}")}, warnings

    return NOT_TEACH


def apply_gating(normalized: dict[str, Any], raw: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    """Carry a step's validated skip_if / requires conditions (tutorial steps only)."""
    if normalized.get("type") not in COPILOT_TEACH_ACTIONS:
        return normalized
    for key in ("skip_if", "requires"):
        value = str(raw.get(key) or "").strip()
        if not value:
            continue
        if valid_condition(value):
            normalized[key] = value
        else:
            warnings.append(f"Unknown condition '{value}' in {key}; ignored.")
    return normalized


# Where the user does each operation Copilot won't run (for its warning).
_ACTION_ANCHORS = {
    "scan_peaks": "scan-peaks-button", "set_peaks_locked": "peaks-lock", "select_peak_at": "peaks-track",
    "cluster_selected_peaks": "cluster-button", "cluster_peak_at_gene_tss": "cluster-button",
    "set_cluster_method": "cluster-method", "set_cluster_k": "cluster-k", "auto_cull_clusters": "merge-similar",
    "merge_clusters": "clusters-overview", "focus_cluster": "clusters-overview", "hide_cluster": "clusters-overview",
    "dissolve_cluster": "clusters-overview", "subcluster_clusters": "clusters-overview",
    "apply_sort_rule": "sort-button", "apply_filter_rule": "filter-button", "clear_filter": "clear-filter",
    "add_cluster_rule": "add-cluster-rule", "add_sort_rule": "add-sort-rule", "add_filter_rule": "add-filter-rule",
    "add_region_label_rule": "add-label-rule", "toggle_layer": "layer-toggles", "set_quality_filter": "quality-filters",
    "set_spanning_only": "spanning-toggle", "set_read_row_height": "row-height",
    "design_primers_for_region": "primers-design-button", "add_track_from_url": "tracks-add-file",
    "remove_track": "tracks-add-file", "load_jaspar_motifs": "tracks-browse-hubs",
    "open_panel_copy": "panel-add-copy", "set_panel_linked": "panel-link", "split_panel_by_strand": "strand-chip",
    "set_panel_strand": "strand-chip", "add_footprint_group": "save-footprints",
    "analyze_footprints": "footprints-classes", "cluster_by_saved_footprints": "footprints-cooccupancy",
    "add_capture_region": "capture-add-region", "link_datasets": "layout-link", "merge_datasets": "layout-merge",
}


def teach_only_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Drop every step that would run an operation; say where the user does it."""
    if not COPILOT_TEACH_ONLY:
        return plan
    kept: list[dict[str, Any]] = []
    warnings = list(plan.get("warnings") or [])
    anchors = load_anchor_catalog()
    for action in plan.get("actions") or []:
        typ = str(action.get("type") or "")
        if typ in COPILOT_TEACH_ACTIONS:
            kept.append(action)
            continue
        anchor = anchors.get(_ACTION_ANCHORS.get(typ, ""))
        where = f" from {anchor['label']} ({anchor['where']})" if anchor else " yourself"
        warnings.append(f"Copilot teaches; do '{typ}'{where}.")
    return {**plan, "actions": kept, "warnings": warnings}


# ─────────────────────────────────────────────────────────────────────
# System prompt (teach-only)
# ─────────────────────────────────────────────────────────────────────

TEACH_PROMPT_HEADER = """You are FiberBrowser Copilot, a tutor for a genome browser of single-molecule fiber-seq / DAF-seq footprint data.

Users ask how to do things ("how do I cluster reads?", "how do I change genomes?", "how do I look at a haplotype?") or why something looks wrong ("why are no reads visible?"). You answer with a short step-by-step walkthrough. You navigate and open panels, tabs and sidebar sections for the user and point at the exact controls, but you never click the controls that run something (scan, cluster, filter, sort, merge, load or remove files, rules, primers, export): the user clicks those.

Output protocol:
1. Think inside <think>...</think>: which workflow, which controls, what the user must do themselves.
2. After </think>, emit exactly one JSON object: {"summary": "...", "actions": [ ... ], "warnings": [ ... ]}.

Actions (the only ones allowed):
  explain       {"type":"explain","text":"...","anchor":"<anchor id>"}      point at a control and explain it; the user clicks Next.
                optional "panel_type" (+ "tab") to open that panel/tab first.
  try_it        {"type":"try_it","text":"Click Cluster.","anchor":"cluster-button","wait_for":"clustered"}
                the user's turn: spotlight the control, wait until the milestone happens (or they Skip; "timeout_s", default 120),
                then continue. Use it when the next steps need the result (a panel is empty until they act).
  open_panel    {"type":"open_panel","panel_type":"cluster-detail","tab":"overview"}
  close_panel   {"type":"close_panel","panel_type":"cluster-detail"}
  open_sidebar  {"type":"open_sidebar","section":"genome","subsection":"genome.reference"}   sections: file, genome, view, analysis
  navigate_gene {"type":"navigate_gene","gene":"eve","padding_bp":5000}
  navigate_region {"type":"navigate_region","chrom":"2R","start":9970000,"end":9980000}
  zoom_view     {"type":"zoom_view","direction":"out","steps":2}      pan_view {"type":"pan_view","direction":"left"}
  reset_view    {"type":"reset_view"}      go_to_top_locus {"type":"go_to_top_locus"}   (next best-covered window)

Step gating (any action): "skip_if":"<condition>" drops the step when the condition already holds (the user did that layer
already); "requires":"<condition>" first shows a short note pointing at the prerequisite and waits for it.
Conditions are evaluated when the step is reached, so later steps see what earlier try_it steps changed.

How to answer:
- How-to: 3-12 steps. Open what is needed, then walk the controls in the order the user would use them: the main button,
  the "controls" toggle that reveals more options, the key settings, then the panel that shows results and its key tabs.
- Put a try_it before any step that explains results the user has to produce first; chain layers (select, save, move,
  reuse) and use skip_if so layers already done are skipped. You may navigate between steps.
- Troubleshooting: the user message's "Diagnostics:" lists concrete causes, each with a fix anchor. Explain the first
  blocking one and point at its anchor (try_it with the matching milestone when the user must act). If there are no
  diagnostics, reason from "State details:".
- An anchor marked [needs X] exists only while condition X holds: before pointing at it, make sure X holds
  (a try_it that produces it, or "requires":"X"). [only when ...] anchors exist only in that situation.
- Only use anchor ids, milestones and conditions from the lists below. Never invent numbers or results.

"""


def _catalog_lines() -> list[str]:
    lines = ["UI anchors (id — label (where)):"]
    for entry in load_anchor_catalog().values():
        only = f" [needs {entry['needs']}]" if entry.get("needs") else (
            f" [only when {entry['shows_when']}]" if entry.get("shows_when") else "")
        lines.append(f"  {entry['id']} — {entry['label']} ({entry['where']}){only}")
    catalog = load_milestone_catalog()
    lines.append("")
    lines.append("Milestones for try_it.wait_for (things the user does):")
    for entry in catalog["milestones"]:
        lines.append(f"  {entry['id']} — {entry['description']}")
    lines.append("")
    lines.append("Conditions for skip_if / requires (facts about the current state):")
    for entry in catalog["conditions"]:
        lines.append(f"  {entry['id']} — {entry['description']}")
    lines.append("")
    lines.append("Panel types: " + ", ".join(catalog["panel_types"]))
    return lines


TEACH_PROMPT_FOOTER = """
Output reminder: <think>...</think> first, then a single JSON object."""


def _compact_catalog_lines() -> list[str]:
    """The catalogs as ids only, grouped by where each anchor lives.

    The fine-tuned model learns what each control is from its training
    examples; the prompt only has to say which ids exist (and which need a
    condition), which keeps every request ~2.5x shorter than the full
    listing. The validator still drops any id not in the catalog.
    """
    groups: dict[str, list[str]] = {}
    for entry in load_anchor_catalog().values():
        mark = f"[needs {entry['needs']}]" if entry.get("needs") else (
            f"[only when {entry['shows_when']}]" if entry.get("shows_when") else "")
        groups.setdefault(entry.get("where") or "browser", []).append(entry["id"] + mark)
    lines = ["UI anchors by location:"]
    for where, ids in groups.items():
        lines.append(f"  {where}: {', '.join(ids)}")
    catalog = load_milestone_catalog()
    lines.append("")
    lines.append("Milestones (try_it.wait_for): " + ", ".join(e["id"] for e in catalog["milestones"]))
    lines.append("Conditions (skip_if / requires): " + ", ".join(e["id"] for e in catalog["conditions"]))
    lines.append("Panel types: " + ", ".join(catalog["panel_types"]))
    return lines


# The compact catalog is what the fine-tuned tiers are trained and served with.
COMPACT_TEACH_PROMPT = True


def build_teach_system_prompt(compact: Optional[bool] = None) -> str:
    use_compact = COMPACT_TEACH_PROMPT if compact is None else compact
    lines = _compact_catalog_lines() if use_compact else _catalog_lines()
    return TEACH_PROMPT_HEADER + "\n".join(lines) + "\n" + TEACH_PROMPT_FOOTER

