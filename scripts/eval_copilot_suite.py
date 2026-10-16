#!/usr/bin/env python3
"""Run the teach-only Copilot eval suite against local mlx_lm servers.

The Copilot is a tutor (navigate, open, point at controls, hand the user a turn,
diagnose). Each case in data/copilot_dataset/eval_suite.py is scored on the axes
it sets up:

  validity       the plan parses and passes the teach-only validator: nothing
                 dropped, no unknown anchor / milestone / condition
  no_operations  HARD: every emitted action is a teach action (no scan, cluster,
                 filter, load, api_call, ...)
  anchors        key anchors all present and in order, each alternative group hit,
                 and anchor precision >= 0.6 against the case's allowed set
  try_it         the expected milestones each appear as a try_it's wait_for
                 (or, for no_try_it cases, no try_it at all)
  gating         the expected skip_if / requires, and every anchor marked
                 [needs X] is preceded by X (state, requires, or a try_it producing it)
  diagnosis      the first pointing / navigation step targets the fix; no
                 invented problem (forbidden anchors) on healthy states
  navigation     a navigate step goes to the named gene / region
  panel          the walk shows the expected analysis panel (tutorial intent)
  types          required / allowed action types (boundary and off-topic cases)
  brevity        step count within bounds; each step <= 3 sentences, <= 320 chars

A run PASSES when every applicable axis passes. Coverage = canonical phrasing
per case; robustness = all phrasings.

Usage:
    python scripts/eval_copilot_suite.py --dry-run          # no model: validate cases, score reference plans
    python scripts/eval_copilot_suite.py --url http://127.0.0.1:8083/v1/chat/completions
    python scripts/eval_copilot_suite.py --tiers tiny light balanced
    python scripts/eval_copilot_suite.py --axis coverage
    python scripts/eval_copilot_suite.py --case-filter troubleshoot_diagnostics
    python scripts/eval_copilot_suite.py --case-ids wf_cluster_fresh td_zoomed_out

Outputs reports/eval_<timestamp>/{results.csv, raw.jsonl, summary.md}.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import signal
import socket
import string
import subprocess
import sys
import time
import traceback
from contextlib import contextmanager, redirect_stdout
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
for _p in (REPO_ROOT, REPO_ROOT / "browser"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from data.copilot_dataset.eval_suite import DIAGNOSTIC_CODES, EVAL_CASES, expanded_runs  # noqa: E402

AXES = ("validity", "no_operations", "anchors", "try_it", "gating", "diagnosis", "navigation", "panel",
        "types", "brevity")
NAV_TYPES = {"navigate_gene", "navigate_region", "zoom_view", "pan_view", "reset_view", "go_to_top_locus"}
POINTING_TYPES = {"explain", "try_it"}
ANCHOR_PRECISION_MIN = 0.6
DEFAULT_STEPS = (1, 12)
MAX_SENTENCES = 3
MAX_STEP_CHARS = 320

# The condition each milestone makes true (for anchors marked [needs X]).
MILESTONE_CONDITIONS = {
    "dataset_loaded": "has_dataset", "genome_loaded": "has_reference", "peaks_scanned": "has_peaks",
    "peak_selected": "has_selected_peak", "clustered": "has_clusters", "clusters_merged": "has_clusters",
    "cluster_focused": "has_clusters", "footprint_selected": "has_selected_footprint",
    "footprint_saved": "has_saved_footprints", "reads_selected": "has_selected_reads",
    "gene_selected": "has_selected_gene",
    "filter_applied": "has_filter", "panel_copy_made": "has_panel_copy", "strand_split": "has_strand_split",
    "track_added": "has_tracks", "primers_designed": "has_primers",
}
RAW_STATE_KEYS = ("viewport", "genome", "reference_loaded", "datasets", "panels", "settings", "clustering")


# ---------------------------------------------------------------------------
# Runtime helpers
# ---------------------------------------------------------------------------

def _tutorial():
    from services import copilot_tutorial
    return copilot_tutorial


def _nlc():
    from services import natural_language_commands as nlc
    return nlc


def _state_for(case: dict):
    from data.copilot_dataset.mock_state import make_mock_state
    return make_mock_state(dataset_count=case.get("dataset_count", 2), **(case.get("state_overrides") or {}))


def _gene_span(name: str) -> Optional[tuple[str, int, int]]:
    from data.copilot_dataset.mock_state import _GENES
    for gene_name, _gid, chrom, start, end, _strand in _GENES:
        if gene_name.lower() == name.lower():
            return chrom, start, end
    return None


def build_messages(case: dict, command: Optional[str] = None) -> list[dict]:
    """The system + user messages a live request sends for this case."""
    nlc = _nlc()
    system_prompt = _tutorial().build_teach_system_prompt()
    user_message = nlc._user_message(
        _state_for(case), command or case["command"], case["context"],
        previous_turns=case.get("previous_turns"),
        diagnostics=case.get("diagnostics"),
        raw_state=case.get("raw_state"),
    )
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _as_group(entry) -> list[str]:
    return list(entry) if isinstance(entry, (list, tuple)) else [entry]


def _is_subsequence(needles: list[str], haystack: list[str]) -> bool:
    it = iter(haystack)
    return all(any(h == n for h in it) for n in needles)


def _sentences(text: str) -> int:
    parts = [p for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    return len(parts)


def _expected_axes(expect: dict) -> list[str]:
    """The axes a case is scored on regardless of the plan (used when there is no plan at all)."""
    axes = ["validity", "no_operations", "brevity"]
    if expect.get("key_anchors") or expect.get("anchor_alts"):
        axes.append("anchors")
    if expect.get("try_it") or expect.get("no_try_it"):
        axes.append("try_it")
    if expect.get("gating"):
        axes.append("gating")
    if expect.get("diagnosis_fix") or expect.get("forbidden_anchors"):
        axes.append("diagnosis")
    if expect.get("navigate"):
        axes.append("navigation")
    if expect.get("panel"):
        axes.append("panel")
    if expect.get("action_types") or expect.get("only_types"):
        axes.append("types")
    return axes


def score_plan(case: dict, parsed: Any) -> dict:
    """Score one parsed model plan against a case. Returns per-axis booleans (None = not scored)."""
    tut = _tutorial()
    expect = case.get("expect") or {}
    axes: dict[str, Optional[bool]] = {axis: None for axis in AXES}
    details: dict[str, str] = {}
    metrics: dict[str, Any] = {}

    if not isinstance(parsed, (dict, list)):
        for axis in _expected_axes(expect):
            axes[axis] = False
        details["validity"] = "no JSON plan"
        return {"axes": axes, "details": details, "metrics": metrics, "types": [], "anchors": []}

    raw_actions = parsed if isinstance(parsed, list) else (parsed.get("actions") or [])
    raw_actions = [a for a in raw_actions if isinstance(a, dict)]
    raw_types = [str(a.get("type") or "") for a in raw_actions]
    validated = _nlc()._validate_plan(_state_for(case), parsed, context=case["context"])
    actions = validated.get("actions") or []
    warnings = validated.get("warnings") or []
    types = [str(a.get("type") or "") for a in actions]
    anchors = [a.get("anchor") for a in actions if a.get("type") in POINTING_TYPES and a.get("anchor")]
    catalog = tut.load_anchor_catalog()

    # (a) validity
    unknown = [w for w in warnings if str(w).startswith("Unknown")]
    dropped = len(actions) != len(raw_actions)
    axes["validity"] = bool(raw_actions) and not dropped and not unknown
    # The server adds navigation to a named gene that isn't in view (as the
    # browser would run it); score the rest on that.
    actions = _nlc().ensure_named_gene_navigation(
        _state_for(case), case["command"] if "command" in case else "", case["context"], {"actions": actions})["actions"]
    types = [str(a.get("type") or "") for a in actions]
    if not axes["validity"]:
        details["validity"] = ("empty plan" if not raw_actions else
                               "; ".join(filter(None, ["dropped actions" if dropped else "", *unknown[:2]])))

    # (b) no operations (hard)
    ops = [t for t in raw_types if t not in tut.COPILOT_TEACH_ACTIONS]
    axes["no_operations"] = not ops
    if ops:
        details["no_operations"] = ",".join(ops)

    # (c) anchors
    key = list(expect.get("key_anchors") or [])
    alts = [list(g) for g in expect.get("anchor_alts") or []]
    if key or alts:
        allowed = set(key) | {a for g in alts for a in g} | set(expect.get("allowed_anchors") or [])
        allowed |= {a for a in expect.get("diagnosis_fix") or [] if a != "navigate"}
        present = set(anchors)
        missing = [a for a in key if a not in present]
        in_order = _is_subsequence(key, anchors) if not missing else False
        alts_hit = all(present & set(g) for g in alts)
        precision = (sum(1 for a in anchors if a in allowed) / len(anchors)) if anchors else 0.0
        recall = (len(key) - len(missing)) / len(key) if key else 1.0
        metrics.update(anchor_recall=round(recall, 3), anchor_precision=round(precision, 3))
        axes["anchors"] = not missing and in_order and alts_hit and precision >= ANCHOR_PRECISION_MIN
        if not axes["anchors"]:
            parts = []
            if missing:
                parts.append("missing " + ",".join(missing))
            elif not in_order:
                parts.append("out of order")
            if not alts_hit:
                parts.append("no alt from " + " / ".join(",".join(g) for g in alts if not present & set(g)))
            if precision < ANCHOR_PRECISION_MIN:
                parts.append(f"precision {precision:.2f}")
            details["anchors"] = "; ".join(parts)

    # (d) try_it
    try_waits = [a.get("wait_for") for a in actions if a.get("type") == "try_it"]
    if expect.get("try_it") or expect.get("no_try_it"):
        ok = True
        parts = []
        for entry in expect.get("try_it") or []:
            group = _as_group(entry)
            if not any(w in group for w in try_waits):
                ok = False
                parts.append("missing " + "|".join(group))
        if expect.get("no_try_it") and try_waits:
            ok = False
            parts.append("unexpected try_it " + ",".join(map(str, try_waits)))
        axes["try_it"] = ok
        if parts:
            details["try_it"] = "; ".join(parts)

    # (e) gating: expected gates + every [needs X] anchor satisfied
    gate_parts = []
    gating_expected = expect.get("gating") or []
    gates_ok = True
    for gate in gating_expected:
        conds = set(_as_group(gate.get("cond")))
        kind = gate.get("kind", "any")
        keys = ("skip_if", "requires") if kind == "any" else (kind,)
        if not any(str(a.get(k) or "") in conds for a in actions for k in keys):
            gates_ok = False
            gate_parts.append(f"no {kind} {'|'.join(sorted(conds))}")
    state_true = set(expect.get("state_true") or [])
    produced: set[str] = set()
    needs_checked = False
    for action in actions:
        anchor = action.get("anchor")
        need = catalog.get(anchor, {}).get("needs") if anchor else None
        if need and action.get("type") in POINTING_TYPES:
            needs_checked = True
            if not (need in state_true or need in produced or action.get("requires") == need):
                gates_ok = False
                gate_parts.append(f"{anchor} needs {need}")
        if action.get("requires"):
            produced.add(str(action["requires"]))
        if action.get("type") == "try_it":
            cond = MILESTONE_CONDITIONS.get(str(action.get("wait_for")))
            if cond:
                produced.add(cond)
                if cond == "has_selected_peak":
                    produced.add("has_peaks")
    if gating_expected or needs_checked:
        axes["gating"] = gates_ok
        if gate_parts:
            details["gating"] = "; ".join(gate_parts)

    # (f) diagnosis
    fix = list(expect.get("diagnosis_fix") or [])
    forbidden = set(expect.get("forbidden_anchors") or [])
    if fix or forbidden:
        ok = True
        parts = []
        if fix:
            first = None
            for action in actions:
                if action.get("type") in NAV_TYPES:
                    first = "navigate"
                    break
                if action.get("type") in POINTING_TYPES and action.get("anchor"):
                    first = action["anchor"]
                    break
            if first not in fix:
                ok = False
                parts.append(f"first step {first!r}, expected {'|'.join(fix)}")
        hits = [a for a in anchors if a in forbidden]
        if hits:
            ok = False
            parts.append("invented " + ",".join(sorted(set(hits))))
        axes["diagnosis"] = ok
        if parts:
            details["diagnosis"] = "; ".join(parts)

    # (g) navigation
    target = expect.get("navigate")
    if target:
        span = _gene_span(target["gene"]) if target.get("gene") else (target["chrom"], target["start"], target["end"])
        ok = False
        for action in actions:  # the plan as the browser runs it (incl. added navigation)
            if action.get("type") == "navigate_gene" and target.get("gene") and \
                    str(action.get("gene") or "").lower() == target["gene"].lower():
                ok = True
            if action.get("type") == "navigate_region" and span:
                chrom, start, end = span
                if str(action.get("chrom")) == chrom and int(action.get("start", 0)) < end \
                        and int(action.get("end", 0)) > start:
                    ok = True
        axes["navigation"] = ok
        if not ok:
            details["navigation"] = f"no navigation to {target.get('gene') or target}"

    # tutorial intent: the expected panel is shown
    panel = expect.get("panel")
    if panel:
        shown = any(a.get("panel_type") == panel for a in actions) or any(
            catalog.get(a, {}).get("reveal", {}).get("panel") == panel for a in anchors)
        axes["panel"] = shown
        if not shown:
            details["panel"] = f"{panel} not shown"

    # action types
    need_types = [list(g) for g in expect.get("action_types") or []]
    only = expect.get("only_types")
    if need_types or only:
        ok = all(set(types) & set(g) for g in need_types)
        if only:
            extra = [t for t in types if t not in only]
            ok = ok and not extra
        axes["types"] = ok
        if not ok:
            details["types"] = f"types {','.join(types)}"

    # (h) brevity
    lo, hi = expect.get("steps") or DEFAULT_STEPS
    wordy = [i for i, a in enumerate(actions)
             if a.get("type") in POINTING_TYPES and (len(str(a.get("text") or "")) > MAX_STEP_CHARS
                                                     or _sentences(str(a.get("text") or "")) > MAX_SENTENCES)]
    axes["brevity"] = lo <= len(actions) <= hi and not wordy
    if not axes["brevity"]:
        details["brevity"] = (f"{len(actions)} steps (want {lo}-{hi})" if not lo <= len(actions) <= hi
                              else f"wordy steps {wordy}")

    return {"axes": axes, "details": details, "metrics": metrics, "types": types, "anchors": anchors}


def scorecard(run: dict, full_response: str) -> dict:
    parsed = _nlc()._extract_json_object(full_response)
    result = score_plan(run, parsed)
    applicable = {k: v for k, v in result["axes"].items() if v is not None}
    row = {
        "case_id": run["case_id"], "run_id": run["run_id"], "phrasing_index": run["phrasing_index"],
        "is_canonical": run["is_canonical"], "category": run["category"], "command": run["command"][:120],
        "json_ok": isinstance(parsed, (dict, list)),
        "passed": bool(applicable) and all(applicable.values()),
        "failed_axes": ",".join(k for k, v in applicable.items() if not v),
        "details": " | ".join(f"{k}: {v}" for k, v in result["details"].items()),
        "actions_emitted": ",".join(result["types"]),
        "anchors_emitted": ",".join(result["anchors"]),
        "n_actions": len(result["types"]),
    }
    for axis in AXES:
        row[f"ax_{axis}"] = result["axes"][axis]
    row.update(result["metrics"])
    return row


# scripts/rescore_eval.py re-scores a saved raw.jsonl with the current rubric.
score_one = scorecard


# ---------------------------------------------------------------------------
# Dry run: validate the cases, score the reference plans
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    return " ".join(text.lower().translate(str.maketrans("", "", string.punctuation)).split())


def validate_cases(cases: list[dict]) -> list[str]:
    """Problems with the cases' own data (catalog ids, formats, held-out phrasings)."""
    tut = _tutorial()
    anchors = tut.load_anchor_catalog()
    panel_types = set(tut.load_milestone_catalog()["panel_types"])
    errors: list[str] = []

    def anchor_ok(cid: str, where: str, anchor: str):
        if anchor not in anchors:
            errors.append(f"{cid}: unknown anchor {anchor!r} in {where}")

    try:
        from data.copilot_dataset.records import RECORDS
        training = {_norm(p) for r in RECORDS for p in [r["command"], *(r.get("phrasings") or [])]}
    except Exception as exc:  # the corpus is being edited elsewhere; report, don't crash
        errors.append(f"could not load the training corpus for the held-out check: {exc}")
        training = set()

    for case in cases:
        cid = case["id"]
        exp = case.get("expect") or {}
        for key in ("key_anchors", "allowed_anchors", "forbidden_anchors"):
            for a in exp.get(key) or []:
                anchor_ok(cid, key, a)
        for group in exp.get("anchor_alts") or []:
            for a in group:
                anchor_ok(cid, "anchor_alts", a)
        for a in exp.get("diagnosis_fix") or []:
            if a != "navigate":
                anchor_ok(cid, "diagnosis_fix", a)
        for entry in exp.get("try_it") or []:
            for m in _as_group(entry):
                if not tut.valid_milestone(m):
                    errors.append(f"{cid}: unknown milestone {m!r}")
        for gate in exp.get("gating") or []:
            if gate.get("kind", "any") not in ("any", "skip_if", "requires"):
                errors.append(f"{cid}: bad gating kind {gate.get('kind')!r}")
            for cnd in _as_group(gate.get("cond")):
                if not tut.valid_condition(cnd):
                    errors.append(f"{cid}: unknown condition {cnd!r}")
        for cnd in exp.get("state_true") or []:
            if not tut.valid_condition(cnd):
                errors.append(f"{cid}: unknown condition {cnd!r} in state_true")
        if exp.get("panel") and exp["panel"] not in panel_types:
            errors.append(f"{cid}: unknown panel {exp['panel']!r}")
        nav = exp.get("navigate")
        if nav and nav.get("gene") and not _gene_span(nav["gene"]):
            errors.append(f"{cid}: gene {nav['gene']!r} not in the mock GTF")
        steps = exp.get("steps")
        if steps is not None and not (isinstance(steps, (tuple, list)) and len(steps) == 2 and steps[0] <= steps[1]):
            errors.append(f"{cid}: bad steps {steps!r}")
        unknown_keys = set(exp) - {"key_anchors", "anchor_alts", "allowed_anchors", "try_it", "no_try_it", "gating",
                                   "state_true", "diagnosis_fix", "forbidden_anchors", "navigate", "panel",
                                   "action_types", "only_types", "steps"}
        if unknown_keys:
            errors.append(f"{cid}: unknown expect keys {sorted(unknown_keys)}")
        for diag in case.get("diagnostics") or []:
            if diag.get("code") not in DIAGNOSTIC_CODES:
                errors.append(f"{cid}: unknown diagnostic code {diag.get('code')!r}")
            if diag.get("severity") not in ("blocking", "warning", "info"):
                errors.append(f"{cid}: bad severity {diag.get('severity')!r}")
            if diag.get("fix_anchor"):
                anchor_ok(cid, "diagnostics.fix_anchor", diag["fix_anchor"])
        raw_state = case.get("raw_state")
        if not isinstance(raw_state, dict) or any(k not in raw_state for k in RAW_STATE_KEYS):
            errors.append(f"{cid}: raw_state is missing keys {[k for k in RAW_STATE_KEYS if k not in (raw_state or {})]}")
        for t in case.get("previous_turns") or []:
            if not isinstance(t, dict) or "text" not in t:
                errors.append(f"{cid}: previous_turns entries need text/summary/actions")
        for phrase in [case["command"], *case.get("phrasings", [])]:
            if _norm(phrase) in training:
                errors.append(f"{cid}: {phrase!r} is a training command/phrasing (not held out)")
        try:
            build_messages(case)
        except Exception as exc:
            errors.append(f"{cid}: user message failed to render: {type(exc).__name__}: {exc}")
    return errors


def dry_run(verbose: bool = True) -> tuple[bool, dict]:
    """Validate every case and score its reference plan; all reference plans must pass every axis."""
    errors = validate_cases(EVAL_CASES)
    per_axis: dict[str, list[bool]] = {axis: [] for axis in AXES}
    failures: list[str] = []
    for case in EVAL_CASES:
        response = f"<think>\nreference\n</think>\n{json.dumps(case['reference'])}"
        run = {**case, "case_id": case["id"], "run_id": f"{case['id']}__ref", "phrasing_index": 0,
               "is_canonical": True}
        row = scorecard(run, response)
        for axis in AXES:
            value = row[f"ax_{axis}"]
            if value is not None:
                per_axis[axis].append(bool(value))
        if not row["passed"]:
            failures.append(f"{case['id']}: {row['failed_axes']} — {row['details']}")
    report = {
        "cases": len(EVAL_CASES),
        "runs": len(expanded_runs()),
        "case_errors": errors,
        "reference_failures": failures,
        "axes": {axis: (sum(v), len(v)) for axis, v in per_axis.items()},
    }
    ok = not errors and not failures
    if verbose:
        from data.copilot_dataset.eval_suite import category_counts
        print(f"Eval suite: {report['cases']} cases, {report['runs']} phrasings")
        for cat, n in sorted(category_counts().items()):
            print(f"  {cat:26s} {n:3d}")
        print("\nReference plans, per axis (passed/scored):")
        for axis, (p, n) in report["axes"].items():
            print(f"  {axis:14s} {p:3d}/{n:<3d}")
        if errors:
            print(f"\n{len(errors)} case error(s):")
            for e in errors:
                print(f"  - {e}")
        if failures:
            print(f"\n{len(failures)} reference plan(s) failed:")
            for f in failures:
                print(f"  - {f}")
        print("\nDry run " + ("passed." if ok else "FAILED."))
    return ok, report


# ---------------------------------------------------------------------------
# Server lifecycle (when --tiers is used)
# ---------------------------------------------------------------------------

def _free_port(start: int = 8090) -> int:
    for port in range(start, start + 200):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port found")


@contextmanager
def _mlx_server(fused_path: str, log_handle):
    port = _free_port()
    cmd = ["python", "-m", "mlx_lm", "server", "--model", fused_path, "--host", "127.0.0.1", "--port", str(port)]
    proc = subprocess.Popen(cmd, stdout=log_handle, stderr=log_handle, start_new_session=True)
    url = f"http://127.0.0.1:{port}/v1/chat/completions"
    models_url = f"http://127.0.0.1:{port}/v1/models"
    deadline = time.time() + 90
    import urllib.request
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(models_url, timeout=1) as r:
                if r.status == 200:
                    break
        except Exception:
            time.sleep(1)
    else:
        proc.terminate()
        raise RuntimeError(f"server for {fused_path} did not come up")
    try:
        yield url, proc.pid
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(10):
            if proc.poll() is not None:
                break
            time.sleep(1)
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass


def _resolve_tiers(tier_names: list[str]) -> list[tuple[str, str]]:
    """Each tier's newest fp16 model with a local fused_path (FIBERBROWSER_PREFER_MODEL_VERSION=vN pins one)."""
    registry = json.loads((REPO_ROOT / "data" / "copilot_dataset" / "models.json").read_text())
    prefer = (os.environ.get("FIBERBROWSER_PREFER_MODEL_VERSION") or "").lower().lstrip("v")
    resolved: list[tuple[str, str]] = []
    for name in tier_names:
        candidates = [m for m in registry.get("models", []) if m.get("tier") == name
                      and not str(m.get("id", "")).endswith("-q4")]
        candidates.sort(key=lambda m: (str(m.get("version")) == prefer, m.get("version") or 0), reverse=True)
        chosen = None
        for m in candidates:
            fpath = m.get("fused_path") or ""
            if fpath and not Path(fpath).is_absolute():
                fpath = str(REPO_ROOT / fpath)
            if fpath and Path(fpath).exists():
                chosen = (m["id"], fpath)
                break
        if not chosen:
            print(f"warning: no local model for tier {name}", file=sys.stderr)
            continue
        resolved.append(chosen)
    return resolved


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run_one(run: dict, url: str, model: str) -> tuple[str, dict, float]:
    from scripts.eval_copilot_model import _stream_chat
    messages = build_messages(run, run["command"])
    t0 = time.perf_counter()
    try:
        with redirect_stdout(io.StringIO()):
            full, _ = _stream_chat(url, model, messages)
    except Exception as exc:
        elapsed = time.perf_counter() - t0
        row = scorecard(run, "")
        row["details"] = f"stream_error: {exc}"[:200]
        return f"<<stream_error: {exc}>>", row, elapsed
    elapsed = time.perf_counter() - t0
    return full, scorecard(run, full), elapsed


def run_against_server(url: str, model: Optional[str], runs: list[dict], progress_label: str):
    import urllib.request
    if model is None:
        with urllib.request.urlopen(url.replace("/chat/completions", "/models"), timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
        if not (data.get("data") or []):
            raise RuntimeError(f"no models loaded at {url}")
        # /v1/models lists every cached model, not the served one, and the
        # server loads whatever a request names: ask for the served model.
        model = "default_model"
    print(f"\n=== {progress_label} (model={Path(model).name}) — {len(runs)} runs")
    scorecards: list[dict] = []
    raw_records: list[dict] = []
    for i, run in enumerate(runs, 1):
        full, sc, elapsed = run_one(run, url, model)
        sc = {**sc, "model": model, "elapsed_s": round(elapsed, 2)}
        scorecards.append(sc)
        raw_records.append({"model": model, "case_id": run["case_id"], "run_id": run["run_id"],
                            "command": run["command"], "raw_response": full, "scorecard": sc})
        flag = "✓" if sc["passed"] else "✗"
        why = "" if sc["passed"] else f"{sc['failed_axes']} — {sc['details'][:90]}"
        print(f"  [{i:3d}/{len(runs)}] {flag} {run['run_id']:40s} {elapsed:5.1f}s  {why}")
    return scorecards, raw_records


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def write_csv(out_dir: Path, rows: list[dict]):
    if not rows:
        return
    keys: list[str] = []
    for row in rows:
        keys.extend(k for k in row if k not in keys)
    path = out_dir / "results.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {path}")


def write_raw(out_dir: Path, raw_records: list[dict]):
    path = out_dir / "raw.jsonl"
    with path.open("w") as f:
        for rec in raw_records:
            f.write(json.dumps(rec, default=str) + "\n")
    print(f"  wrote {path}")


def _rate(rows: list[dict], field: str) -> str:
    scored = [r for r in rows if r.get(field) is not None]
    if not scored:
        return "—"
    passed = sum(1 for r in scored if r[field])
    return f"{passed * 100 / len(scored):.0f}% ({passed}/{len(scored)})"


def write_summary(out_dir: Path, rows: list[dict], cases: list[dict]):
    from collections import defaultdict
    by_model: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_model[row["model"]].append(row)
    models = sorted(by_model)
    names = [f"`{Path(m).name}`" for m in models]
    lines = [f"# Copilot teaching eval — {datetime.now().isoformat(timespec='seconds')}\n",
             f"**Cases**: {len(cases)} · **Runs/model**: {len({r['run_id'] for r in rows})} · "
             f"**Models**: {len(models)}\n",
             "A run passes when every axis it's scored on passes. **no_operations** is a hard "
             "requirement: the Copilot must never run an operation.\n",
             "## Overall\n",
             "| Model | Coverage (canonical) | Robustness (all phrasings) | no_operations (hard) | JSON OK |",
             "|---|---|---|---|---|"]
    for m, name in zip(models, names):
        scs = by_model[m]
        cov = [r for r in scs if r["is_canonical"]]
        lines.append(f"| {name} | **{_rate(cov, 'passed')}** | **{_rate(scs, 'passed')}** | "
                     f"{_rate(scs, 'ax_no_operations')} | {_rate(scs, 'json_ok')} |")
    lines += ["", "## Per axis (all phrasings; scored runs only)\n",
              "| Axis | " + " | ".join(names) + " |", "|---|" + "|".join("---" for _ in models) + "|"]
    for axis in AXES:
        lines.append(f"| {axis} | " + " | ".join(_rate(by_model[m], f"ax_{axis}") for m in models) + " |")
    lines += ["", "## Coverage per category (canonical phrasing)\n",
              "| Category | n | " + " | ".join(names) + " |", "|---|---|" + "|".join("---" for _ in models) + "|"]
    for cat in sorted({c["category"] for c in cases}):
        n = sum(1 for c in cases if c["category"] == cat)
        cells = [_rate([r for r in by_model[m] if r["category"] == cat and r["is_canonical"]], "passed")
                 for m in models]
        lines.append(f"| {cat} | {n} | " + " | ".join(cells) + " |")
    lines += ["", "## Robustness — weakest cases (phrasing pass rate)\n",
              "| Case | Category | " + " | ".join(names) + " |", "|---|---|" + "|".join("---" for _ in models) + "|"]
    ranked = []
    for case in cases:
        cells = []
        worst = 1.0
        for m in models:
            scs = [r for r in by_model[m] if r["case_id"] == case["id"]]
            p = sum(1 for r in scs if r["passed"])
            cells.append(f"{p}/{len(scs)}")
            worst = min(worst, p / len(scs) if scs else 1.0)
        ranked.append((worst, case, cells))
    ranked.sort(key=lambda t: t[0])
    for _worst, case, cells in ranked[:25]:
        lines.append(f"| {case['id']} | {case['category']} | " + " | ".join(cells) + " |")
    lines += ["", "## Failure samples (first 12 per model)\n"]
    for m, name in zip(models, names):
        lines.append(f"### {name}\n")
        fails = [r for r in by_model[m] if not r["passed"]][:12]
        if not fails:
            lines.append("_no failures_\n")
            continue
        for r in fails:
            lines.append(f"- **{r['run_id']}** ({r['category']}) — failed: `{r['failed_axes']}`")
            lines.append(f"  - command: _{r['command']}_")
            lines.append(f"  - {r['details']}")
            lines.append(f"  - emitted: `{r['actions_emitted']}` · anchors: `{r['anchors_emitted']}`")
        lines.append("")
    path = out_dir / "summary.md"
    path.write_text("\n".join(lines))
    print(f"  wrote {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="No model: validate every case against the catalogs and score the reference plans.")
    parser.add_argument("--url", help="Eval against an already-running server.")
    parser.add_argument("--model", help="Model id when using --url.")
    parser.add_argument("--tiers", nargs="+",
                        help="Spawn each tier's mlx_lm.server in turn (models.json names, e.g. tiny light balanced).")
    parser.add_argument("--axis", choices=("coverage", "robustness", "both"), default="both",
                        help="coverage: canonical phrasing only; robustness: variant phrasings only; both (default).")
    parser.add_argument("--case-filter", help="Only run cases whose category or tag contains this string.")
    parser.add_argument("--case-ids", nargs="+", help="Only run cases with these ids.")
    parser.add_argument("--out-dir", default=None, help="Output directory (default reports/eval_<timestamp>).")
    args = parser.parse_args()

    if args.dry_run:
        ok, _ = dry_run(verbose=True)
        return 0 if ok else 1

    all_runs = expanded_runs()
    if args.axis == "coverage":
        all_runs = [r for r in all_runs if r["is_canonical"]]
    elif args.axis == "robustness":
        all_runs = [r for r in all_runs if not r["is_canonical"]]
    if args.case_filter:
        all_runs = [r for r in all_runs if args.case_filter in r["category"]
                    or any(args.case_filter in t for t in r.get("tags", []))]
    if args.case_ids:
        wanted = set(args.case_ids)
        all_runs = [r for r in all_runs if r["case_id"] in wanted]
    if not all_runs:
        print("no runs match filter", file=sys.stderr)
        return 2

    present = {r["case_id"] for r in all_runs}
    cases_present = [c for c in EVAL_CASES if c["id"] in present]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir) if args.out_dir else REPO_ROOT / "reports" / f"eval_{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"=== eval suite: axis={args.axis} · {len(cases_present)} cases · {len(all_runs)} runs/model "
          f"· output -> {out_dir}")

    rows: list[dict] = []
    raw: list[dict] = []
    if args.url:
        scs, rr = run_against_server(args.url, args.model, all_runs, progress_label=f"server {args.url}")
        rows.extend(scs)
        raw.extend(rr)
    else:
        targets = _resolve_tiers(args.tiers or ["tiny", "light", "balanced"])
        if not targets:
            print("no tiers resolved; check models.json", file=sys.stderr)
            return 2
        with (out_dir / "server.log").open("ab") as log_handle:
            for model_id, fused_path in targets:
                print(f"\n--- spawning {model_id} ({fused_path}) ---")
                try:
                    with _mlx_server(fused_path, log_handle) as (url, _pid):
                        scs, rr = run_against_server(url, None, all_runs, progress_label=f"tier {model_id}")
                        rows.extend(scs)
                        raw.extend(rr)
                except Exception as exc:
                    print(f"!!! {model_id} failed: {exc}", file=sys.stderr)
                    traceback.print_exc()

    print("\n=== writing reports ===")
    write_csv(out_dir, rows)
    write_raw(out_dir, raw)
    write_summary(out_dir, rows, cases_present)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
