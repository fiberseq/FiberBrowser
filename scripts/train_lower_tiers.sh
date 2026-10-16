#!/usr/bin/env bash
# Train + fuse + register one or more LoRA tiers in sequence.
#
# Usage:
#   bash scripts/train_lower_tiers.sh tiny light
#   bash scripts/train_lower_tiers.sh tiny           # just tiny
#
# Reads the same SIZE -> base/tier mapping as train_copilot_lora.sh.
# Does NOT start mlx_lm.server (so it doesn't fight with one already running).
# Each tier's adapter lands at adapters/<tier_dir>/, the fused model at
# fused_models/<tier_dir>/, and the registry at data/copilot_dataset/models.json
# is updated to mark trained=true with the fused_path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <size> [size ...]    where size is tiny|light|balanced|heavy|max" >&2
  exit 1
fi

for SIZE in "$@"; do
  case "$SIZE" in
    tiny)     BASE="Qwen/Qwen2.5-Coder-1.5B-Instruct"; TIER_DIR="copilot_1.5b_v1";  ID="fiberbrowser-copilot-1.5b-v1";  LABEL="Copilot 1.5B (tiny)";    SIZE_B=1.5; MIN=8;  REC=16  ;;
    light)    BASE="Qwen/Qwen2.5-Coder-3B-Instruct";   TIER_DIR="copilot_3b_v1";    ID="fiberbrowser-copilot-3b-v1";    LABEL="Copilot 3B (light)";     SIZE_B=3.0; MIN=12; REC=24  ;;
    balanced) BASE="Qwen/Qwen2.5-Coder-7B-Instruct";   TIER_DIR="copilot_7b_v1";    ID="fiberbrowser-copilot-7b-v1";    LABEL="Copilot 7B (balanced)";  SIZE_B=7.0; MIN=16; REC=32  ;;
    heavy)    BASE="Qwen/Qwen2.5-Coder-14B-Instruct";  TIER_DIR="copilot_14b_v1";   ID="fiberbrowser-copilot-14b-v1";   LABEL="Copilot 14B (heavy)";    SIZE_B=14.0; MIN=32; REC=64 ;;
    max)      BASE="Qwen/Qwen2.5-Coder-32B-Instruct";  TIER_DIR="copilot_32b_v1";   ID="fiberbrowser-copilot-32b-v1";   LABEL="Copilot 32B (max)";      SIZE_B=32.0; MIN=64; REC=128 ;;
    *) echo "Unknown size: $SIZE" >&2; exit 1 ;;
  esac

  ADAPTER_DIR="adapters/$TIER_DIR"
  FUSED_DIR="fused_models/$TIER_DIR"

  echo
  echo "=========================================="
  echo "[$SIZE] training $BASE  ->  $ADAPTER_DIR"
  echo "=========================================="
  SIZE="$SIZE" bash scripts/train_copilot_lora.sh

  echo
  echo "[$SIZE] fusing -> $FUSED_DIR"
  mkdir -p "$(dirname "$FUSED_DIR")"
  python -m mlx_lm fuse \
    --model "$BASE" \
    --adapter-path "$ADAPTER_DIR" \
    --save-path "$FUSED_DIR"

  echo "[$SIZE] registering"
  python - <<PY
import json, pathlib
registry = pathlib.Path("data/copilot_dataset/models.json")
data = json.loads(registry.read_text()) if registry.exists() else {"models": []}
new_entry = {
    "id": "$ID",
    "label": "$LABEL",
    "base": "$BASE",
    "size_b": float("$SIZE_B"),
    "min_ram_gb": int("$MIN"),
    "recommended_ram_gb": int("$REC"),
    "tier": "$SIZE",
    "fused_path": "$FUSED_DIR",
    "trained": True,
}
existing = {m["id"]: m for m in data.get("models", [])}
merged = {**existing.get(new_entry["id"], {}), **new_entry}
if merged["id"] in existing:
    data["models"] = [m if m.get("id") != merged["id"] else merged for m in data.get("models", [])]
else:
    data.setdefault("models", []).append(merged)
registry.write_text(json.dumps(data, indent=2) + "\n")
print(f"registered {merged['id']} -> {merged['fused_path']}")
PY

  echo "[$SIZE] done."
done

echo
echo "All tiers complete. To swap which model mlx_lm.server is serving,"
echo "kill the existing server (lsof -ti:8080 | xargs kill) and run:"
echo "  SIZE=<tier> SKIP_FUSE=1 bash scripts/serve_copilot_model.sh"
