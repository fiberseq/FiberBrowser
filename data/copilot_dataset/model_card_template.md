---
license: apache-2.0
base_model: {base_model}
tags:
- mlx
- fiber-seq
- daf-seq
- genome-browser
- function-calling
- structured-output
- qwen2.5-coder
language:
- en
pipeline_tag: text-generation
---

# {model_label}

LoRA-fine-tuned (and {fuse_status}) `{base_model}` for the [FiberBrowser](https://github.com/fiberseq/FiberBrowser) Copilot — a local genome-browser planner that turns natural-language analysis requests into structured JSON action plans.

**Tier:** `{tier}` ({size_b}B params, {fuse_status}). Recommended for Macs with **{recommended_ram_gb}+ GB unified memory** ({min_ram_gb} GB minimum).

## Use

This is a Copilot tier — a single `mlx_lm.server` instance loads it and the FiberBrowser frontend talks to it via OpenAI-compatible chat completions. The browser handles the system prompt, viewport context, dataset metadata, and previous-turn history; the model emits a JSON action plan inside `<think>...</think>` tags.

```bash
# Install
pip install mlx-lm fiberbrowser   # or your preferred install

# Serve
python -m mlx_lm server --model {hf_repo} --port 8080

# Point the browser at it
FIBERBROWSER_COPILOT_BACKEND=mlx \
FIBERBROWSER_COPILOT_MLX_URL=http://127.0.0.1:8080/v1/chat/completions \
python browser.py
```

Or simply: `python browser.py --copilot mlx` — the launcher auto-detects RAM, downloads the right tier, starts the server, and shuts it down with the browser.

## Training

Supervised fine-tuning via LoRA distillation:
- **Teacher:** Claude (Anthropic) generated structured (request → plan) demonstrations.
- **Dataset:** {dataset_size} hand-curated and LLM-distilled examples across 24 workflow categories — navigation, peak detection, clustering, footprint analysis, motif overlaps, primer design, contact maps, annotations, capture regions, multi-step composites, and edge cases.
- **Method:** LoRA, rank 16, top 16 layers, 900 iters, lr 1e-4, batch size 1, grad checkpointing. Final val loss `{val_loss}`.
- **Hardware:** Apple Silicon Mac (MLX framework).

Output protocol:
```
<think>
{{reasoning about which actions to chain}}
</think>
{{"summary": "...", "actions": [{{"type": "...", ...}}], "warnings": []}}
```

The browser validates every plan through the same Python validator that produced the training data — any action with malformed coordinates, unsafe API paths, or unknown gene names is dropped before execution.

## Action vocabulary

11 action types in the trained vocabulary:

- `navigate_gene`, `navigate_region` — viewport
- `scan_peaks`, `set_peaks_locked`, `select_peak_at` — peaks
- `cluster_selected_peaks`, `cluster_peak_at_gene_tss` — clustering
- `add_region_label_rule` — colormap rules (TSS-relative form for strand-aware coords)
- `query_motif_overlaps` — motif intersections
- `api_call` — escape hatch to any safe `/api/...` route (settings, render, sort, filter, footprint analyze, primer design, etc.)
- `respond_to_user` — terminator for the agentic loop

## Known limitations

- Trained on synthetic + Claude-distilled demonstrations; real organic-usage data is being collected via opt-in session logging in the browser.
- Multi-step plans of >5 actions sometimes drop tail actions; can be partially mitigated with multi-turn conversation context.
- Tool-call (agentic) form is supported by the underlying base model but the LoRA was trained on single-shot plans, not tool-call traces — agentic accuracy may be lower.

## Other tiers

| tier | base | size | min RAM | repo |
|---|---|---|---|---|
| tiny | Qwen2.5-Coder-1.5B-Instruct | 1.5B | 8 GB | `{org}/fiberbrowser-copilot-1.5b-v1` |
| light | Qwen2.5-Coder-3B-Instruct | 3B | 12 GB | `{org}/fiberbrowser-copilot-3b-v1` |
| balanced | Qwen2.5-Coder-7B-Instruct | 7B | 16 GB | `{org}/fiberbrowser-copilot-7b-v1` |
| balanced (q4) | Qwen2.5-Coder-7B-Instruct | 7B int4 | 8 GB | `{org}/fiberbrowser-copilot-7b-v1-q4` |

## Citation

If this model is useful in your work, please cite the FiberBrowser repository.

## License

Apache 2.0 (matching the Qwen2.5-Coder base model license).
