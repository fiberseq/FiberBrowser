#!/usr/bin/env python3
"""Split seed_v1.jsonl into train/valid (and optional test) for MLX-LM.

MLX-LM's `mlx_lm lora --data DIR` expects a directory containing `train.jsonl`
and `valid.jsonl` (and an optional `test.jsonl`). Each line must have one of:
- {"text": "..."}                      (raw, chat template already applied)
- {"prompt": "...", "completion": "..."}
- {"messages": [{"role": ..., "content": ...}, ...]}  (chat — applied via tokenizer)

Our seed dataset is already in the chat shape, so we just strip the `metadata`
field MLX-LM doesn't need and copy the rest into the split files.

The split is 90/10 by default and stratified by category — every category that
has >= 2 records contributes at least one validation example, so single-shot
behaviors don't disappear from the eval set.
"""
from __future__ import annotations

import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _display_path(path: Path) -> Path:
    """The path relative to the repo when it's inside it, else as an absolute path."""
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
DEFAULT_INPUT = REPO_ROOT / "data" / "copilot_dataset" / "seed_v1.jsonl"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "copilot_dataset" / "mlx"


def _load_records(path: Path) -> list[dict]:
    records = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def _stratified_split(records: list[dict], val_frac: float, seed: int) -> tuple[list[dict], list[dict]]:
    """Split by source record: every phrasing variant of a record (same
    metadata.id, same answer) goes to the same side, so validation measures
    generalization rather than recall of a rephrased training example."""
    rng = random.Random(seed)
    by_category: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for index, record in enumerate(records):
        meta = record.get("metadata") or {}
        category = meta.get("category", "unknown")
        record_id = str(meta.get("id") or f"#{index}")
        by_category[category][record_id].append(record)

    train: list[dict] = []
    valid: list[dict] = []
    for category in sorted(by_category):
        groups = by_category[category]
        ids = sorted(groups)
        rng.shuffle(ids)
        if len(ids) <= 1:
            for record_id in ids:
                train.extend(groups[record_id])
            continue
        # Whole groups until the category's validation share is reached (at
        # least one group, never all of them).
        total = sum(len(groups[record_id]) for record_id in ids)
        target = max(1, round(total * val_frac))
        taken = 0
        for n, record_id in enumerate(ids):
            if (taken >= target and n > 0) or n == len(ids) - 1:
                train.extend(groups[record_id])
            else:
                valid.extend(groups[record_id])
                taken += len(groups[record_id])

    rng.shuffle(train)
    rng.shuffle(valid)
    return train, valid


def _write_split(records: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            # MLX-LM ignores extras but stripping keeps the file slim.
            payload = {"messages": record["messages"]}
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="Input JSONL")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Output dir (gets train.jsonl + valid.jsonl)")
    parser.add_argument("--val-fraction", type=float, default=0.10)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    in_path = Path(args.input)
    out_dir = Path(args.output_dir)
    if not in_path.exists():
        print(f"input not found: {in_path}\n"
              "The seed set is generated, not tracked: run "
              "`python scripts/build_copilot_dataset.py` first.", file=__import__("sys").stderr)
        return 1

    records = _load_records(in_path)
    train, valid = _stratified_split(records, args.val_fraction, args.seed)

    train_path = out_dir / "train.jsonl"
    valid_path = out_dir / "valid.jsonl"
    _write_split(train, train_path)
    _write_split(valid, valid_path)

    cat_counts: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))
    for record in train:
        category = (record.get("metadata") or {}).get("category", "unknown")
        t, v = cat_counts[category]
        cat_counts[category] = (t + 1, v)
    for record in valid:
        category = (record.get("metadata") or {}).get("category", "unknown")
        t, v = cat_counts[category]
        cat_counts[category] = (t, v + 1)

    print(f"Wrote {len(train)} train, {len(valid)} valid to {_display_path(out_dir)}")
    print()
    print(f"  {'category':22s}  train  valid")
    for category in sorted(cat_counts):
        t, v = cat_counts[category]
        print(f"  {category:22s}  {t:5d}  {v:5d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
