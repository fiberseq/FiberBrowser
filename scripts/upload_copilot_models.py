#!/usr/bin/env python3
"""Push trained Copilot fused models to the Hugging Face Hub.

Run after `huggingface-cli login` (or having HF_TOKEN in env). Each tier in
data/copilot_dataset/models.json with `trained: true` and a local fused_path
gets pushed to `<org>/<id>` along with a generated model card. The registry
is then updated with the resulting `hf_repo` so the browser's auto-download
flow can fetch it.

Usage:
    python scripts/upload_copilot_models.py --org my-org
    python scripts/upload_copilot_models.py --org my-username --tiers 7b 7b-q4
    python scripts/upload_copilot_models.py --dry-run

The script does NOT run unless --org is specified (or already known per tier).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY = REPO_ROOT / "data" / "copilot_dataset" / "models.json"
TEMPLATE = REPO_ROOT / "data" / "copilot_dataset" / "model_card_template.md"


def _whoami() -> str | None:
    """Best-effort: return the logged-in HF username via the CLI.

    Newer CLIs (`hf auth whoami`) print `user=<name> orgs=<csv>`; older ones
    (`huggingface-cli whoami`) print just the username on the first line.
    """
    for cmd in (["hf", "auth", "whoami"], ["huggingface-cli", "whoami"]):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        except FileNotFoundError:
            continue
        if result.returncode != 0:
            continue
        out = result.stdout.strip()
        if not out:
            continue
        if out.startswith("user="):
            for token in out.split():
                if token.startswith("user="):
                    return token.split("=", 1)[1] or None
        first = out.splitlines()[0].strip()
        if first and not first.startswith(("Warning:", "Hint:")):
            return first
    return None


def _build_card(entry: dict, *, org: str, dataset_size: int, val_loss: str) -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    fuse_status = ("int4 quantized" if entry["id"].endswith("-q4")
                   else "int8 quantized" if entry["id"].endswith("-q8") else "fp16")
    repo = f"{org}/{entry['id']}"
    return template.format(
        model_label=entry["label"],
        base_model=entry["base"],
        tier=entry["tier"],
        size_b=entry["size_b"],
        fuse_status=fuse_status,
        recommended_ram_gb=entry["recommended_ram_gb"],
        min_ram_gb=entry["min_ram_gb"],
        hf_repo=repo,
        dataset_size=dataset_size,
        val_loss=val_loss,
        org=org,
    )


def _upload_one(entry: dict, *, org: str, dataset_size: int, val_loss: str,
                dry_run: bool) -> str | None:
    """Upload one tier; return the resulting hf_repo on success, else None."""
    from huggingface_hub import HfApi, create_repo, upload_folder

    fused_path = REPO_ROOT / entry.get("fused_path", "")
    if not fused_path.is_dir():
        print(f"  [skip] {entry['id']}: fused_path missing ({fused_path})")
        return None
    repo_id = f"{org}/{entry['id']}"
    print(f"  → {repo_id}  ({fused_path.relative_to(REPO_ROOT)})")
    if dry_run:
        return repo_id

    # Generate the README/model card next to the model files.
    card = _build_card(entry, org=org, dataset_size=dataset_size, val_loss=val_loss)
    (fused_path / "README.md").write_text(card, encoding="utf-8")

    api = HfApi()
    create_repo(repo_id=repo_id, repo_type="model", exist_ok=True, private=False)
    upload_folder(
        repo_id=repo_id,
        folder_path=str(fused_path),
        commit_message=f"Upload {entry['label']} ({fused_path.name})",
        ignore_patterns=["*.tmp", "*.pyc", "__pycache__/*"],
    )
    return repo_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", default=None,
                        help="HF org or username. Defaults to `huggingface-cli whoami`.")
    parser.add_argument("--tiers", nargs="+", default=None,
                        help="Tier names to upload (e.g. tiny light balanced). Default: all trained tiers.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be uploaded; do not push.")
    parser.add_argument("--val-loss", default="0.016",
                        help="Final validation loss to embed in model cards.")
    parser.add_argument("--dataset-size", type=int, default=319)
    args = parser.parse_args()

    org = args.org or _whoami()
    if not org:
        print("could not determine HF org/username — pass --org or run `huggingface-cli login`", file=sys.stderr)
        return 1
    if not re.fullmatch(r"[A-Za-z0-9-]+", org):
        print(f"invalid org name: {org!r}", file=sys.stderr)
        return 1

    if not REGISTRY.exists():
        print(f"registry not found: {REGISTRY}", file=sys.stderr)
        return 1

    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    candidates = [m for m in data.get("models", []) if m.get("trained") and m.get("fused_path")]
    if args.tiers:
        wanted = {t.lstrip("-").lower() for t in args.tiers}
        # Accept either tier name (tiny|light|balanced|heavy|max) or model id substring.
        candidates = [m for m in candidates if m["tier"] in wanted
                      or any(t in m["id"].lower() for t in wanted)]
    if not candidates:
        print("no trained models match", file=sys.stderr)
        return 1

    print(f"Uploading to org {org!r} ({len(candidates)} models, dry_run={args.dry_run}):")
    updated = 0
    failed: list[str] = []
    for entry in candidates:
        try:
            repo_id = _upload_one(entry, org=org, dataset_size=args.dataset_size,
                                  val_loss=args.val_loss, dry_run=args.dry_run)
        except Exception as exc:
            print(f"  [error] {entry['id']}: {type(exc).__name__}: {exc}")
            failed.append(entry["id"])
            continue
        if repo_id:
            entry["hf_repo"] = repo_id
            updated += 1
        elif not args.dry_run:
            failed.append(entry["id"])

    if not args.dry_run and updated:
        # Persist hf_repo back into the registry so the browser can auto-download.
        REGISTRY.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"\nUpdated registry: {REGISTRY.relative_to(REPO_ROOT)}  ({updated} entries got hf_repo)")
    if failed:
        # Non-zero, so a release run stops before retiring working versions.
        print(f"\nFAILED uploads: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
