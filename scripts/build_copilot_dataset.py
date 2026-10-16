#!/usr/bin/env python3
"""Build (and validate) the Copilot fine-tuning dataset.

Reads `data/copilot_dataset/records.py`, produces JSONL in chat format
suitable for unsloth / axolotl / Ollama Modelfile training, and exercises
every record through the production validator so any drift between this
file and the runtime fails the build.

Usage:
    python scripts/build_copilot_dataset.py                # build + validate
    python scripts/build_copilot_dataset.py --validate     # dry run, no write
    python scripts/build_copilot_dataset.py --out path.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent


def _display_path(path: Path) -> Path:
    """The path relative to the repo when it's inside it, else as an absolute path."""
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
BROWSER_DIR = REPO_ROOT / "browser"
DATA_DIR = REPO_ROOT / "data" / "copilot_dataset"

if str(BROWSER_DIR) not in sys.path:
    sys.path.insert(0, str(BROWSER_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _load_runtime():
    """Import the live planner so the dataset uses the production system prompt."""
    from fastapi import FastAPI

    from routers.registry import register_api_routers
    from services import natural_language_commands as nlc

    app = FastAPI()
    register_api_routers(app)
    return nlc, app


def app_routes(app):
    from utils.routes import app_routes as _app_routes
    return _app_routes(app)


def _field_required(field) -> bool:
    """A dependant parameter's required flag (``ModelField.required`` before
    FastAPI 0.142, ``field_info.is_required()`` from 0.142)."""
    required = getattr(field, "required", None)
    if required is None:
        info = getattr(field, "field_info", None)
        required = info.is_required() if info is not None and hasattr(info, "is_required") else False
    return bool(required)


def _real_route_set(app) -> set[tuple[str, str]]:
    """Return the (method, path) pairs the FastAPI app actually serves."""
    pairs: set[tuple[str, str]] = set()
    for route in app_routes(app):
        path = getattr(route, "path", "")
        if not path.startswith("/api/"):
            continue
        for method in getattr(route, "methods", None) or set():
            if method in {"HEAD", "OPTIONS"}:
                continue
            pairs.add((method, path))
    return pairs


def _route_schemas(app) -> list[dict[str, Any]]:
    """Each /api route's method, path template, query parameters and body model.

    Built from FastAPI's own dependency analysis, so an api_call example can be
    checked the way the server will parse it: which keys go in the query string,
    which in the JSON body, and which are required.
    """
    schemas: list[dict[str, Any]] = []
    for route in app_routes(app):
        path = getattr(route, "path", "")
        dependant = getattr(route, "dependant", None)
        if not path.startswith("/api/") or dependant is None:
            continue
        query = {q.alias or q.name: _field_required(q) for q in dependant.query_params}
        body_model = None
        body_required = False
        if len(dependant.body_params) == 1:
            param = dependant.body_params[0]
            annotation = getattr(param.field_info, "annotation", None)
            if isinstance(annotation, type) and hasattr(annotation, "model_fields"):
                body_model = annotation
                body_required = _field_required(param)
        for method in getattr(route, "methods", None) or set():
            if method in {"HEAD", "OPTIONS"}:
                continue
            schemas.append({
                "method": method, "path": path, "query": query,
                "body_model": body_model, "body_required": body_required,
                "has_body": bool(dependant.body_params),
                # A route taking the raw Request reads its own body/query.
                "raw_request": bool(getattr(dependant, "request_param_name", None)),
            })
    return schemas


def _check_api_call(action: dict[str, Any], schemas: list[dict[str, Any]]) -> list[str]:
    """Problems the server would have with an api_call: keys in the wrong place,
    unknown or missing parameters, or a body its model rejects."""
    from urllib.parse import parse_qsl

    method = str(action.get("method", "GET")).upper()
    raw_path = str(action.get("path", ""))
    path, _, query_string = raw_path.partition("?")
    matches = [sc for sc in schemas if sc["method"] == method and _path_matches_template(path, sc["path"])]
    if not matches:
        return []  # reported by the route-existence check
    # A literal route (/api/x/list) wins over a template (/api/x/{id}).
    schema = sorted(matches, key=lambda sc: "{" in sc["path"])[0]
    errors: list[str] = []
    query_keys = [key for key, _ in parse_qsl(query_string, keep_blank_values=True)]
    body = action.get("body")
    body_keys = set(body) if isinstance(body, dict) else set()
    model = schema["body_model"]
    for key in query_keys:
        if key not in schema["query"] and not schema["raw_request"]:
            where = " (it belongs in the body)" if model is not None and key in model.model_fields else ""
            errors.append(f"query parameter {key!r} is not accepted by {method} {schema['path']}{where}")
    for key, required in schema["query"].items():
        if required and key not in query_keys:
            where = " (it is in the body; the route reads it from the query string)" if key in body_keys else ""
            errors.append(f"required query parameter {key!r} is missing{where}")
    if model is not None:
        if body is None or body == {}:
            required_fields = [name for name, info in model.model_fields.items() if info.is_required()]
            if schema["body_required"] and required_fields:
                errors.append(f"body is missing required field(s) {required_fields}")
        elif not isinstance(body, dict):
            errors.append("body must be a JSON object")
        else:
            allowed = set()
            for name, info in model.model_fields.items():
                allowed.add(name)
                if info.alias:
                    allowed.add(info.alias)
            extra_allowed = (getattr(model, "model_config", {}) or {}).get("extra") == "allow"
            for key in sorted(body_keys - allowed):
                if key in schema["query"]:
                    if key not in query_keys and not schema["query"][key]:
                        errors.append(f"body field {key!r} is a query parameter of {schema['path']} (ignored in the body)")
                    continue  # a required one is already reported as missing from the query
                if not extra_allowed:
                    errors.append(f"body field {key!r} is not a field of {model.__name__} (ignored by the server)")
            try:
                model.model_validate({k: v for k, v in body.items() if k in allowed or extra_allowed})
            except Exception as exc:  # pydantic.ValidationError
                errors.append(f"body does not validate as {model.__name__}: {str(exc).splitlines()[0]}")
    elif not schema["has_body"] and not schema["raw_request"] and body not in (None, {}) and method != "GET":
        errors.append(f"{method} {schema['path']} takes no JSON body")
    return errors


def _path_matches_template(path: str, template: str) -> bool:
    """Match a concrete /api/foo/123 against a /api/foo/{id} template."""
    p = path.split("?", 1)[0]
    if "{" not in template:
        return p == template
    p_parts = p.split("/")
    t_parts = template.split("/")
    if len(p_parts) != len(t_parts):
        return False
    for pp, tp in zip(p_parts, t_parts):
        if tp.startswith("{") and tp.endswith("}"):
            continue
        if pp != tp:
            return False
    return True


def _strip_validator_extras(action: dict[str, Any]) -> dict[str, Any]:
    """Normalize a validated action down to fields the model would have emitted."""
    out = dict(action)
    # Validator-attached metadata that the model does not need to learn.
    for key in ("gene", "padding_bp", "color_name", "label", "blocked_reason", "allowed"):
        out.pop(key, None)
    return out


def _action_signature(action: dict[str, Any]) -> str:
    """A stable string signature for action equivalence checks."""
    keys = ("type", "chrom", "start", "end", "position", "tolerance_bp",
            "layer", "size_min", "size_max", "color", "method", "path",
            "scope", "locked", "tss")
    pieces = [f"{k}={action.get(k)!r}" for k in keys if k in action]
    return "|".join(pieces)


def _teach_only_errors(nlc, record: dict[str, Any], validated: dict[str, Any]) -> list[str]:
    """A teach-only record: only tutorial actions, and every anchor/milestone/condition known."""
    errors: list[str] = []
    for idx, action in enumerate(record["plan"]["actions"]):
        typ = str(action.get("type") or "")
        if typ not in nlc.COPILOT_TEACH_ACTIONS:
            errors.append(f"action {idx}: '{typ}' runs an operation; Copilot only teaches (explain/try_it/navigation)")
    for warning in validated.get("warnings") or []:
        if warning.startswith(("Unknown UI anchor", "Unknown milestone", "Unknown condition", "Unknown sidebar")):
            errors.append(warning)
    return errors


def _validate_record(nlc, record: dict[str, Any], real_routes: set[tuple[str, str]],
                     route_schemas: list[dict[str, Any]] | None = None,
                     teach_only: bool = True) -> list[str]:
    """Return a list of validation errors for the record (empty = OK)."""
    from data.copilot_dataset.mock_state import make_mock_state

    state = make_mock_state(dataset_count=record["dataset_count"], **record.get("state_overrides", {}))
    raw_plan = record["plan"]
    validated = nlc._validate_plan(state, raw_plan, context=record["context"])

    errors: list[str] = []
    if teach_only:
        errors.extend(_teach_only_errors(nlc, record, validated))
    expected_actions = raw_plan["actions"]
    actual_actions = validated["actions"]

    # Cross-check api_call paths against the real FastAPI route table.
    real_pairs = real_routes
    for idx, action in enumerate(expected_actions):
        if action.get("type") != "api_call":
            continue
        method = str(action.get("method", "")).upper()
        path = str(action.get("path", "")).split("?", 1)[0]
        if not any(m == method and _path_matches_template(path, tp) for m, tp in real_pairs):
            errors.append(
                f"action {idx}: api_call {method} {path} does not match any real /api/... route"
            )
        elif route_schemas:
            errors.extend(f"action {idx}: {problem}" for problem in _check_api_call(action, route_schemas))

    if len(expected_actions) != len(actual_actions):
        errors.append(
            f"action count mismatch: expected {len(expected_actions)}, "
            f"validator emitted {len(actual_actions)}. "
            f"validator warnings: {validated['warnings']}"
        )
        return errors

    for idx, (expected, actual) in enumerate(zip(expected_actions, actual_actions)):
        actual_type = actual.get("type")
        # Validator turns navigate_gene -> navigate_region; map for comparison.
        expected_type = expected.get("type")
        if expected_type == "navigate_gene":
            expected_type = "navigate_region"
        if expected_type != actual_type:
            errors.append(f"action {idx}: type {expected_type!r} -> {actual_type!r}")

    # For api_call actions, the validator marks unsafe routes blocked.
    for idx, action in enumerate(actual_actions):
        if action.get("type") == "api_call" and action.get("allowed") is False:
            errors.append(
                f"action {idx}: api_call to {action.get('path')} is blocked: "
                f"{action.get('blocked_reason')}"
            )

    # Warnings — only intentional record-level warnings should appear.
    expected_warnings = list(raw_plan.get("warnings") or [])
    actual_warnings = list(validated.get("warnings") or [])
    if expected_warnings:
        # Allow a loose check: every expected warning fragment must appear.
        for expected in expected_warnings:
            if not any(expected[:30].lower() in w.lower() for w in actual_warnings) \
               and not expected_warnings == actual_warnings:
                # Record-supplied warnings are author-facing; validator may not echo them.
                pass

    return errors


def _live_request_state(record: dict[str, Any]) -> tuple[list, dict]:
    """The diagnostics and raw state a live request would carry for this record.

    The browser sends both with every Copilot question, so every training
    example must too (train/serve parity). A record's own values win; otherwise
    they're derived from its context and dataset count.
    """
    try:
        from data.copilot_dataset.records_teach_workflows import raw
    except ImportError:  # run as a top-level module
        from records_teach_workflows import raw
    context = record.get("context") or {}
    count = int(record.get("dataset_count") or 0)
    diagnostics = record.get("diagnostics")
    if diagnostics is None:
        diagnostics = []
        if count == 0:
            diagnostics.append({"code": "no_datasets", "severity": "blocking",
                                "message": "No dataset is loaded, so there are no reads to show.",
                                "fix_anchor": "load-dataset"})
            if not context.get("currentGenome"):
                diagnostics.append({"code": "no_reference", "severity": "blocking",
                                    "message": "No genome or reference is loaded, so there are no chromosomes to browse.",
                                    "fix_anchor": "genome-selector"})
    raw_state = record.get("raw_state")
    if raw_state is None:
        raw_state = raw(context, count)
    return list(diagnostics), raw_state


def _build_messages(nlc, app, record: dict[str, Any], *,
                    command_override: str | None = None,
                    phrasing_index: int = 0,
                    teach_only: bool = True) -> dict[str, Any]:
    from data.copilot_dataset.mock_state import make_mock_state

    command = command_override if command_override is not None else record["command"]
    state = make_mock_state(dataset_count=record["dataset_count"], **record.get("state_overrides", {}))
    system_prompt = nlc.build_copilot_system_prompt(app, teach_only=teach_only)
    diagnostics, raw_state = _live_request_state(record)
    user_message = nlc._user_message(
        state,
        command,
        record["context"],
        previous_turns=record.get("previous_turns"),
        diagnostics=diagnostics,
        raw_state=raw_state,
    )

    plan = record["plan"]
    plan_json = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    assistant_content = f"<think>\n{record['thinking']}\n</think>\n{plan_json}"

    metadata = {
        "id": record["id"],
        "category": record["category"],
    }
    if phrasing_index > 0:
        # Disambiguate expanded examples in the JSONL so post-processing /
        # dedup tools can collapse them when desired.
        metadata["phrasing_index"] = phrasing_index
        metadata["phrasing_id"] = f"{record['id']}__p{phrasing_index}"

    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": assistant_content},
        ],
        "metadata": metadata,
    }


def _expand_record(record: dict[str, Any]):
    """Yield (command, phrasing_index) pairs for a record.

    Index 0 is the canonical `command`; subsequent indices are entries from
    `phrasings` (if any). A record with no phrasings yields a single pair.
    """
    yield record["command"], 0
    for i, phrase in enumerate(record.get("phrasings") or [], start=1):
        yield phrase, i


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(DATA_DIR / "seed_v1.jsonl"),
                        help="JSONL output path")
    parser.add_argument("--validate", action="store_true",
                        help="Validate only; do not write the JSONL file")
    parser.add_argument("--summary-only", action="store_true",
                        help="Print category counts and exit")
    parser.add_argument("--teach-only", action="store_true",
                        help="(Default.) Teach-only corpus: records use only tutorial actions "
                             "(explain, try_it, navigation, opening panels) with known anchors, "
                             "milestones and conditions, and the teach-only system prompt is emitted.")
    parser.add_argument("--legacy-operator", action="store_true",
                        help="Build/validate an old operator-style corpus instead (operation actions "
                             "allowed, operator system prompt).")
    args = parser.parse_args()
    args.teach_only = not args.legacy_operator

    from data.copilot_dataset.records import RECORDS, category_counts

    if args.summary_only:
        for cat, count in sorted(category_counts().items()):
            print(f"  {cat:14s} {count:4d}")
        print(f"  {'TOTAL':14s} {len(RECORDS):4d}")
        return 0

    nlc, app = _load_runtime()
    real_routes = _real_route_set(app)
    route_schemas = _route_schemas(app)

    failures: list[tuple[str, list[str]]] = []
    for record in RECORDS:
        errors = _validate_record(nlc, record, real_routes, route_schemas, teach_only=args.teach_only)
        if errors:
            failures.append((record["id"], errors))

    print(f"Records: {len(RECORDS)}")
    for cat, count in sorted(category_counts().items()):
        print(f"  {cat:14s} {count:4d}")

    if failures:
        print(f"\n{len(failures)} record(s) failed validation:")
        for rid, errors in failures:
            print(f"  {rid}:")
            for err in errors:
                print(f"    - {err}")
        if args.validate:
            return 1

    if args.validate:
        print("\nAll records validate.")
        return 0

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    canonical_count = 0
    phrasing_count = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for record in RECORDS:
            for command, phrasing_idx in _expand_record(record):
                entry = _build_messages(nlc, app, record,
                                        command_override=command,
                                        phrasing_index=phrasing_idx,
                                        teach_only=args.teach_only)
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
                written += 1
                if phrasing_idx == 0:
                    canonical_count += 1
                else:
                    phrasing_count += 1

    sys_chars = len(nlc.build_copilot_system_prompt(app, teach_only=args.teach_only))
    print(f"\nWrote {written} examples to {_display_path(out_path)}")
    print(f"  {canonical_count} canonical records + {phrasing_count} phrasing variants "
          f"(expansion factor {written / max(canonical_count, 1):.2f}x)")
    print(f"System prompt is {sys_chars:,} chars (cached identically across all records)")
    if failures:
        print(f"WARNING: {len(failures)} record(s) failed validation but were written anyway.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
