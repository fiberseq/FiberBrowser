#!/usr/bin/env bash
# Fine-tune a Copilot LoRA adapter on the seed dataset using MLX-LM.
#
# Designed for an Apple Silicon Mac with 32+ GB unified memory. The default
# base model is qwen2.5-coder:7b-instruct because it handles structured JSON
# output better than the plain qwen2.5 instruct, but you can override BASE.
#
# Usage:
#   bash scripts/train_copilot_lora.sh                # default qwen2.5-coder
#   BASE=Qwen/Qwen2.5-7B-Instruct bash scripts/train_copilot_lora.sh
#   ITERS=600 BATCH=2 bash scripts/train_copilot_lora.sh
#
# Outputs:
#   adapters/copilot_lora_v1/        — adapter weights + adapter_config.json
#   adapters/copilot_lora_v1/0000XXX_adapters.safetensors  (per checkpoint)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# SIZE picks the model tier; override BASE/ADAPTER_DIR/MODEL_ID for ad-hoc runs.
SIZE="${SIZE:-balanced}"
case "$SIZE" in
  tiny)      DEFAULT_BASE="Qwen/Qwen2.5-Coder-1.5B-Instruct";  TIER_DIR="copilot_1.5b_v${VERSION:-1}" ;;
  light)     DEFAULT_BASE="Qwen/Qwen2.5-Coder-3B-Instruct";    TIER_DIR="copilot_3b_v${VERSION:-1}"   ;;
  balanced)  DEFAULT_BASE="Qwen/Qwen2.5-Coder-7B-Instruct";    TIER_DIR="copilot_7b_v${VERSION:-1}"   ;;
  heavy)     DEFAULT_BASE="Qwen/Qwen2.5-Coder-14B-Instruct";   TIER_DIR="copilot_14b_v1"  ;;
  max)       DEFAULT_BASE="Qwen/Qwen2.5-Coder-32B-Instruct";   TIER_DIR="copilot_32b_v1"  ;;
  *) echo "Unknown SIZE=$SIZE (try tiny|light|balanced|heavy|max)" >&2; exit 1 ;;
esac

BASE="${BASE:-$DEFAULT_BASE}"
DATA_DIR="${DATA_DIR:-data/copilot_dataset/mlx}"
ADAPTER_DIR="${ADAPTER_DIR:-adapters/$TIER_DIR}"
ITERS="${ITERS:-900}"             # ~3-4 epochs at batch 1 on 243 train rows
BATCH="${BATCH:-1}"
LR="${LR:-1e-4}"
LORA_LAYERS="${LORA_LAYERS:-16}"  # train top-N transformer layers
MAX_SEQ_LEN="${MAX_SEQ_LEN:-8192}"
STEPS_PER_EVAL="${STEPS_PER_EVAL:-100}"
VAL_BATCHES="${VAL_BATCHES:-25}"
GRAD_CHECKPOINT="${GRAD_CHECKPOINT:-true}"
# Loss on the assistant turn only: the system prompt is ~97% of every example
# and identical across them, so training on it only dilutes the signal.
MASK_PROMPT="${MASK_PROMPT:-true}"
SEED="${SEED:-42}"

if ! python -c "import mlx_lm" >/dev/null 2>&1; then
  echo "Installing mlx-lm into the active Python environment..."
  python -m pip install --upgrade "mlx-lm>=0.19.0"
fi

if [[ ! -f "$DATA_DIR/train.jsonl" ]] || [[ ! -f "$DATA_DIR/valid.jsonl" ]]; then
  echo "Splitting dataset into train/valid..."
  python scripts/prepare_copilot_dataset.py
fi

mkdir -p "$ADAPTER_DIR"

GRAD_FLAG=()
if [[ "$MASK_PROMPT" == "true" ]]; then
  GRAD_FLAG+=(--mask-prompt)
fi
if [[ "$GRAD_CHECKPOINT" == "true" ]]; then
  GRAD_FLAG+=(--grad-checkpoint)
fi

echo "Starting LoRA fine-tune"
echo "  size tier      : $SIZE"
echo "  base model     : $BASE"
echo "  data           : $DATA_DIR"
echo "  adapter out    : $ADAPTER_DIR"
echo "  iters / batch  : $ITERS / $BATCH"
echo "  lr / layers    : $LR / $LORA_LAYERS"
echo "  max seq len    : $MAX_SEQ_LEN"
echo

python -m mlx_lm lora \
  --model "$BASE" \
  --train \
  --data "$DATA_DIR" \
  --adapter-path "$ADAPTER_DIR" \
  --iters "$ITERS" \
  --batch-size "$BATCH" \
  --learning-rate "$LR" \
  --num-layers "$LORA_LAYERS" \
  --max-seq-length "$MAX_SEQ_LEN" \
  --steps-per-eval "$STEPS_PER_EVAL" \
  --val-batches "$VAL_BATCHES" \
  --seed "$SEED" \
  "${GRAD_FLAG[@]}"

echo
echo "Done. Adapter saved to $ADAPTER_DIR"
echo "Next: bash scripts/serve_copilot_model.sh"
