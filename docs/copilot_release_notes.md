# Local Copilot — natural-language command panel (v2.8, historical)

> **Historical.** These are the release notes of the Copilot's first version
> (FiberBrowser 2.8), kept for reference. Its model tiers, commands and test
> counts are out of date. For the Copilot in 3.0 (a tutor that opens panels and
> points at controls), see [Local Copilot](copilot.md).

Adds a **local LLM Copilot** to FiberBrowser. A small instruction-tuned
model (Qwen2.5-Coder-* + LoRA distilled from a 319-record corpus) turns
natural-language analysis requests into validated browser action plans. Runs
entirely on-device via MLX (recommended on Mac) or Ollama. No API keys, no
data leaves the host.

## What's in this PR

### Core planner & UI

- **Streaming planner** (`browser/services/natural_language_commands.py`):
  cached system prompt embeds the safe `/api/...` catalog + action schema, so
  the model sees the full API in context. NDJSON streaming endpoint
  (`POST /api/nl/stream`) yields `start / thinking / token / raw / plan / warning`
  events; the panel renders thinking + JSON live. Every action is validated
  through the same Python validator the dataset is built against.
- **Copilot panel** (`browser/frontend/src/components/controls/CopilotCommandPanel.tsx`):
  free-form input, streaming thinking trace, plan review, **Run plan**, command
  history, share-usage toggle, first-run setup wizard.
- **Model chooser** keyed off host RAM. Auto-picks the largest trained tier
  that fits comfortably; user can override.

### Trained models (distillation pipeline)

- Five fine-tuned tiers, all distilled via supervised fine-tuning from
  Anthropic Claude-generated demonstrations:

| tier | base | size | min RAM | HF repo |
|---|---|---|---|---|
| tiny | Qwen2.5-Coder-1.5B-Instruct | 2.9 GB | 8 GB | `mtcicero26/fiberbrowser-copilot-1.5b-v1` |
| light | Qwen2.5-Coder-3B-Instruct | 5.8 GB | 12 GB | `mtcicero26/fiberbrowser-copilot-3b-v1` |
| light (q4) | Qwen2.5-Coder-3B-Instruct | 1.7 GB | 6 GB | `mtcicero26/fiberbrowser-copilot-3b-v1-q4` |
| balanced | Qwen2.5-Coder-7B-Instruct | 15 GB | 16 GB | `mtcicero26/fiberbrowser-copilot-7b-v1` |
| balanced (q4) | Qwen2.5-Coder-7B-Instruct | 4.1 GB | 8 GB | `mtcicero26/fiberbrowser-copilot-7b-v1-q4` |

Final val loss 0.016 (down from 1.755 at iter 1). All five tiers produce
correct, validated plans on the canonical TSS-relative test prompt that
motivated training. Latency ranges from 5 s (1.5B) to 12 s (7B fp16).

### Ergonomics for testers

- `python browser.py --copilot mlx` — one-command setup. Lifecycle module
  detects RAM, picks tier, downloads from HF Hub on first run (cached at
  `~/.fiberhmm/copilot_models/`), launches `mlx_lm.server` as managed child,
  shuts it down with the browser.
- **First-run wizard** in the panel: zero-state card with detected RAM,
  recommended tier, one-click download & start. Other tiers exposed in an
  expandable list.
- **Port handling**: if the requested port (default 8000) is busy, the server
  uses the next free port, up to 99 above it. It never stops another process;
  `--force-port` is kept as a no-op for compatibility.

### Safety

- Same allowlist as the original Copilot scaffold: file pickers, uploads, S3,
  process spawn, server lifecycle routes are blocked. New: validator
  cross-checks every `api_call` path against the live FastAPI route table at
  dataset-build time, so broken routes can't ship in training data.
- `NaN`/`Inf` floats in any response are scrubbed to `null` (a global
  `_NanSafeJSONResponse` class), preventing 500s from numpy means in analysis
  endpoints.

### Usage data collection (opt-in)

- `useSessionLog` hook captures the full session — snapshot stack, command
  history, and a 2000-entry **activity log** (every API call + every change to
  ~25 watched store keys: panels, peak rules, cluster k/method, thresholds,
  filters, etc.).
- **Anonymizer** redacts paths/URLs/identifiers; keeps gene names + action
  types so the data is useful for distillation.
- **Share toggle** (off by default) appends each session to a single
  reviewable JSONL file the user can drop into Slack/email. Privacy banner
  + reveal-in-Finder + clear-file controls in the panel.
- Distillation script `scripts/distill_session_logs.py` walks the raw logs and
  emits structured state-transition records ready for the next training round.

### Agentic scaffold (incomplete — frontend loop pending)

Backend is in place: `services/copilot_agent.py` defines 11 tools in OpenAI
function-call format, `/api/nl/agent_step` runs one iteration of a tool-use
loop. Frontend agent UI is not wired in this PR — the v1 release uses the
single-shot streaming planner. Tool-trace training data + frontend loop will
ship in a follow-up.

## Files

- **New backend**: `browser/services/natural_language_commands.py`,
  `browser/services/copilot_agent.py`, `browser/services/copilot_lifecycle.py`,
  `browser/routers/natural_language.py`.
- **New frontend**: `browser/frontend/src/components/controls/CopilotCommandPanel.tsx`,
  `browser/frontend/src/api/naturalLanguage.ts`,
  `browser/frontend/src/hooks/useSessionLog.ts`,
  `browser/frontend/src/utils/activityLog.ts`,
  `browser/frontend/src/actions/browserActions.ts`.
- **Dataset & training**: `data/copilot_dataset/{records.py, mock_state.py, models.json, model_card_template.md}`,
  `scripts/{build,prepare,train,serve,distill,upload,eval}_copilot*.{py,sh}`.
- **Tests**: `tests/test_natural_language_commands.py` (27 tests).
- **Docs**: README "Local Copilot" section,
  `docs/browser_api_guide.md`.

## Test plan

- [ ] `pytest tests/test_natural_language_commands.py` — 27 tests pass
- [ ] `python scripts/build_copilot_dataset.py --validate` — all 319 records
      validate against live API route table
- [ ] `cd browser/frontend && npm run build` — clean build
- [ ] `cd browser/frontend && npm run test:run` — 391 frontend tests pass
- [ ] Manual: `python browser.py --copilot mlx` — auto-download + start +
      first-run wizard works end-to-end
- [ ] Manual: canonical TSS-relative prompt produces correct plan in the panel
