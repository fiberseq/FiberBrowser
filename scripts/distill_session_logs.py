#!/usr/bin/env python3
"""Distill raw session logs into structured transitions ready for review.

Raw logs in `data/copilot_dataset/usage_logs/` capture the full snapshot stack
plus Copilot command history. This script walks each session, diffs adjacent
snapshots, and emits one row per detected user action — viewport change, peak
scan, cluster run, color rule added, sort change, etc.

The output is `data/copilot_dataset/transitions/transitions_<session>.jsonl`,
gitignored. Each row is a self-contained record you can later feed to a teacher
model (Claude) to synthesize a (request, plan) training pair, or curate by hand.

Usage:
    python scripts/distill_session_logs.py
    python scripts/distill_session_logs.py --since 2025-12-01
    python scripts/distill_session_logs.py --input some_session.json
"""
from __future__ import annotations

import argparse
import os
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
# Session logs now live in the per-user cache (FIBERBROWSER_USAGE_LOG_DIR
# overrides); the in-repo location is kept for logs written before 1.0.
_LOG_DIR_CANDIDATES = [
    Path(os.environ["FIBERBROWSER_USAGE_LOG_DIR"]) if os.environ.get("FIBERBROWSER_USAGE_LOG_DIR") else None,
    Path.home() / ".fiberhmm" / "usage_logs",
    REPO_ROOT / "data" / "copilot_dataset" / "usage_logs",
]
LOG_DIR = next((path for path in _LOG_DIR_CANDIDATES if path and path.exists()), _LOG_DIR_CANDIDATES[1])
OUT_DIR = REPO_ROOT / "data" / "copilot_dataset" / "transitions"


def _load_sessions(log_dir: Path, since: datetime | None) -> Iterable[Path]:
    if not log_dir.exists():
        return []
    paths = sorted(log_dir.glob("session_*.json"))
    if since is None:
        return paths
    out: list[Path] = []
    for path in paths:
        try:
            stamp = int(path.stem.split("_")[1])
        except (IndexError, ValueError):
            continue
        if datetime.fromtimestamp(stamp, tz=timezone.utc) >= since:
            out.append(path)
    return out


def _viewport_diff(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any] | None:
    keys = ("chrom", "start", "end")
    if not all(k in a and k in b for k in keys):
        return None
    if any(a.get(k) != b.get(k) for k in keys):
        return {
            "before": {k: a.get(k) for k in keys},
            "after": {k: b.get(k) for k in keys},
        }
    return None


def _set_diff(before: Any, after: Any) -> tuple[list, list] | None:
    """Return (added, removed) for list/set-shaped state fields. None if unchanged."""
    a = before if isinstance(before, list) else (sorted(before) if isinstance(before, (set, tuple)) else [])
    b = after if isinstance(after, list) else (sorted(after) if isinstance(after, (set, tuple)) else [])
    if a == b:
        return None
    a_set = set(map(_hashable, a))
    b_set = set(map(_hashable, b))
    return ([x for x in b if _hashable(x) not in a_set],
            [x for x in a if _hashable(x) not in b_set])


def _hashable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _json_changed(before: Any, after: Any) -> bool:
    """Stable deep comparison for JSON-like snapshot fields."""
    return json.dumps(before, sort_keys=True, ensure_ascii=False) \
        != json.dumps(after, sort_keys=True, ensure_ascii=False)


def _classify_transition(prev_state: dict[str, Any], next_state: dict[str, Any], label: str) -> dict[str, Any]:
    """Build a transition row describing what changed between two snapshots."""
    diffs: dict[str, Any] = {}

    vp_diff = _viewport_diff(prev_state, next_state)
    if vp_diff:
        diffs["viewport"] = vp_diff

    for field in ("clusterAssignments", "clusterPatterns", "clusterPeakRegions"):
        if _json_changed(prev_state.get(field) or {}, next_state.get(field) or {}):
            diffs.setdefault("clustering", {})[field] = "changed"

    for field in ("peaksByRule", "peakRules", "peaksLocked", "selectedPeaks", "peakModes"):
        if _json_changed(prev_state.get(field), next_state.get(field)):
            diffs.setdefault("peaks", {})[field] = "changed"

    # Analysis Rules panel — Cluster / Sort / Filter rule lists are first-class
    # transitions for the Copilot training corpus. Track set-shaped diffs so
    # the teacher can see exactly which rules were added/removed.
    for field in ("clusterFeatureRules", "analysisSortRules", "analysisFilterRules"):
        diff = _set_diff(prev_state.get(field) or [], next_state.get(field) or [])
        if diff is not None:
            added, removed = diff
            if added or removed:
                diffs.setdefault("analysis_rules", {})[field] = {"added": added, "removed": removed}

    # Cluster mode (which feature rule is active) is a scalar but worth flagging
    # because switching cluster modes routes through different backend feature
    # extraction paths.
    if prev_state.get("clusterPeakMode") != next_state.get("clusterPeakMode"):
        diffs.setdefault("analysis_rules", {})["clusterPeakMode"] = {
            "before": prev_state.get("clusterPeakMode"),
            "after": next_state.get("clusterPeakMode"),
        }

    for field in ("readSortOrder", "filteredReadIds", "clusterFocus", "selectedReadIds"):
        if _json_changed(prev_state.get(field) or {}, next_state.get(field) or {}):
            diffs.setdefault("reads", {})[field] = "changed"

    color_before = prev_state.get("activeColormap") or {}
    color_after = next_state.get("activeColormap") or {}
    rules_before = color_before.get("rules") or []
    rules_after = color_after.get("rules") or []
    rule_diff = _set_diff(rules_before, rules_after)
    if rule_diff is not None:
        added, removed = rule_diff
        if added or removed:
            diffs["color_rules"] = {"added": added, "removed": removed}

    for field in ("qualityFilters", "qualityShading", "displaySmoothing",
                  "layerOpacities", "tfOverlay"):
        if _json_changed(color_before.get(field), color_after.get(field)):
            diffs.setdefault("color_settings", {})[field] = "changed"

    for field in ("clusterK", "clusterMethod", "analysisSampleCount",
                  "analysisSampleSeed", "spanningOnly", "minFootprints",
                  "minFpQuality", "subnucleosomalThreshold",
                  "accessibilityThreshold"):
        if prev_state.get(field) != next_state.get(field):
            diffs.setdefault("analysis_settings", {})[field] = {
                "before": prev_state.get(field),
                "after": next_state.get(field),
            }

    # Primer cart — additions/removals are user-facing actions ("save these
    # primers", "remove that pair") worth labeling separately from track lists.
    primer_diff = _set_diff(prev_state.get("primerSavedPrimers") or [], next_state.get("primerSavedPrimers") or [])
    if primer_diff is not None:
        added, removed = primer_diff
        if added or removed:
            diffs["primer_cart"] = {"added": added, "removed": removed}

    # Track changes can arrive as saved tracks (cart), composite tracks, or the
    # live orthogonal track list populated from remote/catalog loads.
    for field in ("captureRegions", "savedTracks", "compositeTracks", "orthogonalTracks", "selectedGenes",
                  "transcriptionStateFilters", "footprintGroups"):
        diff = _set_diff(prev_state.get(field) or [], next_state.get(field) or [])
        if diff is not None:
            added, removed = diff
            if added or removed:
                diffs[field] = {"added": added, "removed": removed}

    if _json_changed(prev_state.get("enabledAnnotationTypes") or {},
                     next_state.get("enabledAnnotationTypes") or {}):
        diffs["enabledAnnotationTypes"] = {
            "before": prev_state.get("enabledAnnotationTypes") or {},
            "after": next_state.get("enabledAnnotationTypes") or {},
        }

    return {
        "label": label,
        "diffs": diffs,
        "viewport_after": {k: next_state.get(k) for k in ("chrom", "start", "end", "currentGenome")},
    }


# Patterns that mark interesting API calls between snapshots. The transition
# row gets an `api_calls` field with whitelisted call summaries so the teacher
# (or hand-curation) has the concrete endpoint + body shape that produced the
# state change.
_INTERESTING_API_PATTERNS: tuple[str, ...] = (
    "/api/cluster_all", "/api/cluster_projection", "/api/assign_to_clusters",
    "/api/dissolve_cluster", "/api/auto_cull_clusters",
    "/api/sort_reads", "/api/filter_by_analysis_rule", "/api/filter",
    "/api/filter_by_transcription_state", "/api/pol2_com",
    "/api/analysis_rules",
    "/api/jupyter/",
    "/api/scan_peaks", "/api/detect_peaks",
    "/api/design_primers", "/api/design_dafc_primers", "/api/design_4c_primers",
    "/api/primer_config", "/api/primers", "/api/primer_progress",
    "/api/dafc/", "/api/microc/", "/api/coacc/",
    "/api/add_track", "/api/tracks", "/api/catalog/tracks",
    "/api/catalog/load", "/api/catalog/unload",
    "/api/quality_filters",
    "/api/colormap", "/api/footprint",
    "/api/annotations/",
    "/api/reads/", "/api/coverage", "/api/meta", "/api/meta_all",
    "/api/render", "/api/session/export", "/api/session/import",
    "/api/overlays",
)


def _extract_command_history_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Each completed Copilot turn (NL request -> planned actions) becomes a
    self-contained record. This is the highest-value training signal: real
    user phrasings paired with the validated plan the model emitted, including
    success/error status so the teacher can weight or filter accordingly.

    The frontend caps commandHistory at 100 entries and includes earlier turns
    first, so we replay in chronological order.
    """
    out: list[dict[str, Any]] = []
    session_id = payload.get("session_id")
    session_started = payload.get("started_at")
    history = payload.get("command_history") or []
    if not isinstance(history, list):
        return out
    # Frontend prepends new entries, so reverse to get chronological order.
    for entry in reversed(history):
        if not isinstance(entry, dict):
            continue
        text = entry.get("text")
        actions = entry.get("actions")
        if not text or not isinstance(actions, list):
            continue
        out.append({
            "session_id": session_id,
            "session_started_at": session_started,
            "row_type": "command",
            "command_id": entry.get("id"),
            "status": entry.get("status"),
            "planner": entry.get("planner"),
            "text": text,
            "summary": entry.get("summary"),
            "warnings": entry.get("warnings") or [],
            "actions": actions,
        })
    return out


def _summarize_api_calls(activity_log: list[dict[str, Any]],
                         start_ms: int, end_ms: int) -> list[dict[str, Any]]:
    """Whitelisted API calls between two snapshot timestamps, body shape kept."""
    out: list[dict[str, Any]] = []
    for entry in activity_log:
        if entry.get("kind") != "api":
            continue
        ts = entry.get("timestamp") or 0
        if ts < start_ms or ts > end_ms:
            continue
        path = entry.get("path") or ""
        if not any(p in path for p in _INTERESTING_API_PATTERNS):
            continue
        out.append({
            "method": entry.get("method"),
            "path": path,
            "body": entry.get("body"),
        })
    return out


def distill_session(payload: dict[str, Any]) -> list[dict[str, Any]]:
    snapshots = payload.get("snapshots") or []
    activity_log = payload.get("activity_log") or []
    out: list[dict[str, Any]] = []
    for i in range(1, len(snapshots)):
        prev = snapshots[i - 1] or {}
        nxt = snapshots[i] or {}
        prev_state = prev.get("state") or {}
        next_state = nxt.get("state") or {}
        label = nxt.get("label") or "(unlabeled)"
        timestamp = nxt.get("timestamp") or 0
        prev_ts = prev.get("timestamp") or 0
        kind = nxt.get("kind")
        transition = _classify_transition(prev_state, next_state, label)
        if not transition["diffs"]:
            # Pure no-op (e.g. coalesced) — skip noise.
            continue
        api_calls = _summarize_api_calls(activity_log, prev_ts, timestamp)
        if api_calls:
            transition["api_calls"] = api_calls
        out.append({
            "session_id": payload.get("session_id"),
            "session_started_at": payload.get("started_at"),
            "snapshot_index": i,
            "snapshot_timestamp": timestamp,
            "snapshot_kind": kind,
            **transition,
        })

    # Copilot NL turns: each completed plan is a row. These ride alongside
    # the snapshot rows so a single session file carries both the
    # state-change signal and the natural-language → plan demonstrations.
    out.extend(_extract_command_history_records(payload))

    # Many sessions only have one snapshot (the export) but rich activity logs.
    # Emit a single "activity-only" row for those so the teacher can still see
    # the user's API trail and surface the new-feature endpoints.
    if not out and len(snapshots) <= 1 and activity_log:
        api_calls = _summarize_api_calls(activity_log,
                                         start_ms=0,
                                         end_ms=10 ** 13)
        if api_calls:
            base_state = (snapshots[0].get("state") if snapshots else {}) or {}
            out.append({
                "session_id": payload.get("session_id"),
                "session_started_at": payload.get("started_at"),
                "snapshot_index": 0,
                "snapshot_timestamp": 0,
                "snapshot_kind": "activity_only",
                "label": "(activity log)",
                "diffs": {},
                "viewport_after": {k: base_state.get(k) for k in ("chrom", "start", "end", "currentGenome")},
                "api_calls": api_calls,
            })

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Single session JSON to distill")
    parser.add_argument("--log-dir", default=str(LOG_DIR))
    parser.add_argument("--out-dir", default=str(OUT_DIR))
    parser.add_argument("--since", help="ISO date; only sessions on or after this date")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    sources: list[Path] = []
    if args.input:
        sources = [Path(args.input)]
    else:
        since = (datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
                 if args.since else None)
        sources = list(_load_sessions(Path(args.log_dir), since))

    if not sources:
        print("No session logs found.", file=sys.stderr)
        return 0

    total_transitions = 0
    for path in sources:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  skipping {path.name}: {exc}", file=sys.stderr)
            continue
        transitions = distill_session(payload)
        if not transitions:
            print(f"  {path.name}: 0 transitions")
            continue
        out_path = out_dir / f"transitions_{path.stem}.jsonl"
        with out_path.open("w", encoding="utf-8") as fh:
            for transition in transitions:
                fh.write(json.dumps(transition, ensure_ascii=False) + "\n")
        total_transitions += len(transitions)
        print(f"  {path.name}: {len(transitions)} transitions -> {out_path.relative_to(REPO_ROOT)}")

    print()
    print(f"Wrote {total_transitions} transitions across {len(sources)} session(s)")
    print(f"Next: feed {out_dir.relative_to(REPO_ROOT)}/transitions_*.jsonl to a teacher (Claude) "
          "to synthesize (request, plan) training records.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
