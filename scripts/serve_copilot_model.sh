#!/usr/bin/env bash
# Fuse a trained Copilot LoRA adapter into a deployable model and serve it
# on an OpenAI-compatible endpoint via mlx_lm.server.
#
# Usage:
#   bash scripts/serve_copilot_model.sh             # defaults: qwen2.5-coder 7b v1
#   PORT=8081 bash scripts/serve_copilot_model.sh
#   SKIP_FUSE=1 bash scripts/serve_copilot_model.sh # already fused, just serve
#
# After this is up, point the FiberBrowser planner at it:
#   FIBERBROWSER_COPILOT_BACKEND=mlx \
#   FIBERBROWSER_COPILOT_MLX_URL=http://127.0.0.1:8080/v1/chat/completions \
#   python browser.py ...

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SIZE="${SIZE:-balanced}"
case "$SIZE" in
  tiny)      DEFAULT_BASE="Qwen/Qwen2.5-Coder-1.5B-Instruct"; TIER_DIR="copilot_1.5b_v1"; MODEL_ID_DEFAULT="fiberbrowser-copilot-1.5b-v1"; LABEL_DEFAULT="Copilot 1.5B (tiny)";  SIZE_B=1.5; MIN_RAM=8;  REC_RAM=16  ;;
  light)     DEFAULT_BASE="Qwen/Qwen2.5-Coder-3B-Instruct";   TIER_DIR="copilot_3b_v1";   MODEL_ID_DEFAULT="fiberbrowser-copilot-3b-v1";   LABEL_DEFAULT="Copilot 3B (light)";    SIZE_B=3.0; MIN_RAM=12; REC_RAM=24  ;;
  balanced)  DEFAULT_BASE="Qwen/Qwen2.5-Coder-7B-Instruct";   TIER_DIR="copilot_7b_v1";   MODEL_ID_DEFAULT="fiberbrowser-copilot-7b-v1";   LABEL_DEFAULT="Copilot 7B (balanced)"; SIZE_B=7.0; MIN_RAM=16; REC_RAM=32  ;;
  heavy)     DEFAULT_BASE="Qwen/Qwen2.5-Coder-14B-Instruct";  TIER_DIR="copilot_14b_v1";  MODEL_ID_DEFAULT="fiberbrowser-copilot-14b-v1";  LABEL_DEFAULT="Copilot 14B (heavy)";   SIZE_B=14.0; MIN_RAM=32; REC_RAM=64 ;;
  max)       DEFAULT_BASE="Qwen/Qwen2.5-Coder-32B-Instruct";  TIER_DIR="copilot_32b_v1";  MODEL_ID_DEFAULT="fiberbrowser-copilot-32b-v1"; LABEL_DEFAULT="Copilot 32B (max)";     SIZE_B=32.0; MIN_RAM=64; REC_RAM=128 ;;
  *) echo "Unknown SIZE=$SIZE (try tiny|light|balanced|heavy|max)" >&2; exit 1 ;;
esac

BASE="${BASE:-$DEFAULT_BASE}"
ADAPTER_DIR="${ADAPTER_DIR:-adapters/$TIER_DIR}"
FUSED_DIR="${FUSED_DIR:-fused_models/$TIER_DIR}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
MODEL_ID="${MODEL_ID:-$MODEL_ID_DEFAULT}"
MODEL_LABEL="${MODEL_LABEL:-$LABEL_DEFAULT}"
REGISTRY="${REGISTRY:-data/copilot_dataset/models.json}"
SKIP_FUSE="${SKIP_FUSE:-0}"

if ! python -c "import mlx_lm" >/dev/null 2>&1; then
  python -m pip install --upgrade "mlx-lm>=0.19.0"
fi

if [[ "$SKIP_FUSE" != "1" ]]; then
  if [[ ! -d "$ADAPTER_DIR" ]]; then
    echo "ADAPTER_DIR does not exist: $ADAPTER_DIR" >&2
    echo "Run scripts/train_copilot_lora.sh first." >&2
    exit 1
  fi
  echo "Fusing adapter into $FUSED_DIR ..."
  mkdir -p "$(dirname "$FUSED_DIR")"
  python -m mlx_lm fuse \
    --model "$BASE" \
    --adapter-path "$ADAPTER_DIR" \
    --save-path "$FUSED_DIR"
fi

# Register the fused model so the planner's capabilities endpoint can list it.
python - <<PY
import json, pathlib
registry = pathlib.Path("$REGISTRY")
registry.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(registry.read_text()) if registry.exists() else {"models": []}
new_entry = {
    "id": "$MODEL_ID",
    "label": "$MODEL_LABEL",
    "base": "$BASE",
    "size_b": float("$SIZE_B"),
    "min_ram_gb": int("$MIN_RAM"),
    "recommended_ram_gb": int("$REC_RAM"),
    "tier": "$SIZE",
    "fused_path": "$FUSED_DIR",
    "trained": True,
}
# Preserve description/etc. from any existing matching entry; flip "trained".
existing = {m["id"]: m for m in data.get("models", [])}
merged = {**existing.get(new_entry["id"], {}), **new_entry}
data["models"] = [m if m.get("id") != merged["id"] else merged for m in data.get("models", [])]
if merged["id"] not in existing:
    data["models"].append(merged)
registry.write_text(json.dumps(data, indent=2) + "\n")
print(f"Registered {merged['id']} -> {merged['fused_path']}")
PY

echo
echo "Starting mlx_lm.server on $HOST:$PORT serving $FUSED_DIR ..."
echo "Point the planner at it with:"
echo "  FIBERBROWSER_COPILOT_BACKEND=mlx \\"
echo "  FIBERBROWSER_COPILOT_MLX_URL=http://$HOST:$PORT/v1/chat/completions \\"
echo "  python browser.py ..."
echo

exec python -m mlx_lm server \
  --model "$FUSED_DIR" \
  --host "$HOST" \
  --port "$PORT"
