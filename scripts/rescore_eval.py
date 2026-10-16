#!/usr/bin/env python3
"""Re-score an existing eval `raw.jsonl` against the current rubric.

Useful when the rubric is updated (e.g. switching tutorial_intent from
must_include-style to relevant_domain-style) and we want the new numbers
without rerunning the entire eval (which costs ~30-90min × n_tiers).

Reads `raw.jsonl` from the input report dir, re-scores each entry using
the current EVAL_CASES rubric + scorer, and emits a NEW
`results.csv` + `summary.md` alongside the original (preserved as
`results.original.csv` for diffing).

Usage:
    python scripts/rescore_eval.py reports/eval_v3_20260525_231947
    python scripts/rescore_eval.py reports/eval_v3_20260525_231947 --out reports/eval_v3_rescored
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "browser"))

from data.copilot_dataset.eval_suite import EVAL_CASES, expanded_runs  # noqa: E402
from scripts.eval_copilot_suite import score_one, write_csv, write_summary  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_dir", help="Directory containing raw.jsonl from a prior eval run.")
    parser.add_argument("--out", default=None,
                        help="Output directory (default: rescore in-place, preserving originals).")
    args = parser.parse_args()

    src = Path(args.report_dir)
    raw_path = src / "raw.jsonl"
    if not raw_path.exists():
        print(f"raw.jsonl not found in {src}", file=sys.stderr)
        return 1

    out = Path(args.out) if args.out else src
    out.mkdir(parents=True, exist_ok=True)

    # Preserve originals on in-place rescore.
    if out == src:
        for name in ("results.csv", "summary.md"):
            p = src / name
            if p.exists() and not (src / f"{p.stem}.original{p.suffix}").exists():
                shutil.copy(p, src / f"{p.stem}.original{p.suffix}")
                print(f"  preserved {p.name} -> {p.stem}.original{p.suffix}")

    # Index expanded runs by (case_id, command) so we can re-attach the
    # current rubric fields (relevant_domain, min_actions, must_include,
    # ...) to each cached response.
    runs_by_key: dict[tuple[str, str], dict] = {}
    for r in expanded_runs():
        runs_by_key[(r["case_id"], r["command"])] = r

    case_ids_used: set[str] = set()
    scorecards: list[dict] = []
    skipped = 0
    with raw_path.open() as fh:
        for line in fh:
            rec = json.loads(line)
            case_id = rec.get("case_id")
            command = rec.get("command")
            run = runs_by_key.get((case_id, command))
            if run is None:
                # Case may have been removed/renamed since the eval ran.
                skipped += 1
                continue
            sc = score_one(run, rec.get("raw_response", ""))
            sc["model"] = rec.get("model", "unknown")
            sc["elapsed_s"] = rec.get("scorecard", {}).get("elapsed_s", 0)
            scorecards.append(sc)
            case_ids_used.add(case_id)

    print(f"rescored {len(scorecards)} entries from {raw_path}")
    if skipped:
        print(f"  skipped {skipped} entries whose case_id/command no longer match the suite")

    cases_present = [c for c in EVAL_CASES if c["id"] in case_ids_used]
    write_csv(out, scorecards)
    write_summary(out, scorecards, cases_present)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
