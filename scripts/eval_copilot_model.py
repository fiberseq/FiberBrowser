#!/usr/bin/env python3
"""Send a test prompt to the running mlx_lm.server, stream the response,
parse + validate the plan, and report whether it matches expectations.

Usage:
    python scripts/eval_copilot_model.py
    python scripts/eval_copilot_model.py --command "go to MYC and label the TSS green"
    python scripts/eval_copilot_model.py --model fused_models/copilot_3b_v1

This is the smallest end-to-end check that a trained tier actually works.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "browser"))
sys.path.insert(0, str(REPO_ROOT))


DEFAULT_PROMPT = (
    "navigate to eve +/- 5kb, scan peaks, label the TF footprint at -100 from the TSS "
    "green, and tell me what motifs it overlaps"
)


def _build_state(selected_gene: str | None = None,
                 cluster_k: int | None = None,
                 cluster_method: str | None = None):
    """Mock state with a synthetic GTF — same the dataset builder uses."""
    from data.copilot_dataset.mock_state import make_mock_state
    return make_mock_state(
        dataset_count=2,
        selected_gene=selected_gene,
        cluster_k=cluster_k,
        cluster_method=cluster_method,
    )


def _build_messages(command: str,
                    selected_gene: str | None = None,
                    cluster_k: int | None = None,
                    cluster_method: str | None = None,
                    previous_turns: list[dict] | None = None):
    from fastapi import FastAPI
    from routers.registry import register_api_routers
    from services.natural_language_commands import build_copilot_system_prompt, _user_message

    app = FastAPI()
    register_api_routers(app)
    state = _build_state(selected_gene=selected_gene,
                         cluster_k=cluster_k, cluster_method=cluster_method)
    system_prompt = build_copilot_system_prompt(app)
    user_message = _user_message(state, command, {
        "chrom": "2R", "start": 9_970_000, "end": 9_980_000, "currentGenome": "dm6",
    }, previous_turns=previous_turns)
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]


def _stream_chat(url: str, model: str, messages: list[dict]):
    """Stream tokens from an OpenAI-compatible /v1/chat/completions endpoint."""
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.1,
        "max_tokens": 2048,
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    full = ""
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=180) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            choice = (chunk.get("choices") or [{}])[0]
            delta = (choice.get("delta") or {}).get("content") or ""
            if delta:
                full += delta
                sys.stdout.write(delta)
                sys.stdout.flush()
    elapsed = time.perf_counter() - started
    sys.stdout.write("\n")
    sys.stdout.flush()
    return full, elapsed


def _validate(full_content: str, command: str):
    from services.natural_language_commands import _extract_json_object, _validate_plan
    state = _build_state()
    parsed = _extract_json_object(full_content)
    plan = _validate_plan(state, parsed, context={
        "chrom": "2R", "start": 9_970_000, "end": 9_980_000,
    })
    return parsed, plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8080/v1/chat/completions")
    parser.add_argument("--model", default=None,
                        help="Model id as listed by /v1/models. Defaults to first model returned.")
    parser.add_argument("--command", default=DEFAULT_PROMPT)
    parser.add_argument("--selected-gene", default=None,
                        help="Set the 'Selected gene' context field to this gene name.")
    parser.add_argument("--cluster-k", type=int, default=None)
    parser.add_argument("--cluster-method", default=None)
    parser.add_argument("--previous-turn", action="append", default=[],
                        help="JSON of one prior turn, e.g. '{\"text\":\"...\",\"summary\":\"...\"}'. May repeat.")
    parser.add_argument("--no-stream", action="store_true",
                        help="(Reserved.) Always streams for now.")
    args = parser.parse_args()

    # Resolve model id from /v1/models if not specified.
    if args.model is None:
        models_url = args.url.replace("/chat/completions", "/models")
        try:
            with urllib.request.urlopen(models_url, timeout=5) as r:
                data = json.loads(r.read().decode("utf-8"))
            ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
        except Exception as exc:
            print(f"could not query {models_url}: {exc}", file=sys.stderr)
            return 1
        if not ids:
            print("no models loaded by mlx_lm.server", file=sys.stderr)
            return 1
        # Prefer a fused copilot model; fall back to first.
        copilot = [m for m in ids if "copilot" in m.lower()]
        args.model = copilot[0] if copilot else ids[0]

    print(f"=== model: {args.model}")
    print(f"=== command: {args.command!r}")
    if args.selected_gene:
        print(f"=== selected gene: {args.selected_gene}")
    if args.cluster_k or args.cluster_method:
        print(f"=== clustering: k={args.cluster_k} method={args.cluster_method}")
    previous_turns = []
    for raw in args.previous_turn:
        try:
            previous_turns.append(json.loads(raw))
        except json.JSONDecodeError:
            print(f"  (ignored malformed previous-turn: {raw[:60]}...)", file=sys.stderr)
    if previous_turns:
        print(f"=== previous turns: {len(previous_turns)}")
    print()
    messages = _build_messages(
        args.command,
        selected_gene=args.selected_gene,
        cluster_k=args.cluster_k,
        cluster_method=args.cluster_method,
        previous_turns=previous_turns or None,
    )
    sys_chars = len(messages[0]["content"])
    user_chars = len(messages[1]["content"])
    print(f"=== prompt sizes: system {sys_chars:,} chars · user {user_chars:,} chars")
    print()
    print("--- model output (streaming) ---")
    try:
        full, elapsed = _stream_chat(args.url, args.model, messages)
    except Exception as exc:
        print(f"stream failed: {exc}", file=sys.stderr)
        return 1
    print(f"--- ({elapsed:.1f}s, {len(full):,} chars) ---")
    print()

    parsed, plan = _validate(full, args.command)
    print(f"=== parsed JSON: {'yes' if parsed else 'NO (model did not emit valid JSON)'}")
    print(f"=== validated actions: {len(plan['actions'])}")
    if plan["warnings"]:
        print("=== warnings:")
        for w in plan["warnings"]:
            print(f"   - {w}")
    print()
    print("=== plan ===")
    for i, action in enumerate(plan["actions"]):
        print(f"  {i+1}. {action.get('type')}")
        for k, v in action.items():
            if k == "type":
                continue
            text = json.dumps(v) if not isinstance(v, str) else v
            if len(text) > 80:
                text = text[:77] + "..."
            print(f"       {k}: {text}")
    return 0 if plan["actions"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
