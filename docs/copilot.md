# Local Copilot

[← Docs index](index.md) · [← README](../README.md)

The Copilot is an optional assistant that runs on your own computer. Ask it how
to do something ("how do I cluster the reads at the TSS?", "why are no reads
visible?"). It opens the right panels, tabs and sidebar sections, navigates if
needed, and points at each control with a short explanation, step by step. You
click the controls that run analyses (scan, cluster, filter, load, export)
yourself; the Copilot does not run them for you.

It uses a small language model fine-tuned on FiberBrowser. No API key is needed
and no data leaves the machine. The rest of FiberBrowser works the same with or
without it.

## Where it is

Open **Tutorial** from its tile in the rail at the right edge (**Tools** group) and choose the
**Copilot** tab. The tab is hidden on `--public` servers and in guided-tour tabs.
The **Guided tour** button in the Copilot tab starts the scripted tour, which
needs no model (see the [user guide](guide.md#starting-the-tour)).

## Requirements

| Backend | Runs on | Notes |
|---------|---------|-------|
| **MLX** (recommended) | Apple Silicon Mac (M1 or later), macOS 13.5 or later, native arm64 Python | Uses the FiberBrowser-trained model. One-click download and start from the panel. |
| **Ollama** | Wherever Ollama runs | Uses a general base model you pull yourself, so it makes more mistakes. |

On Linux, Windows, Intel Macs, or with an Intel Python running under Rosetta,
the panel and `--copilot-doctor` say why MLX is unavailable, and nothing is
downloaded or started.

## Set up (Apple Silicon)

```bash
bash scripts/install.sh          # or double-click "Install FiberBrowser.command"
./"Launch Browser.command"       # or: .venv/bin/python browser.py
```

`scripts/install.sh` picks a native arm64 Python 3.10+, creates `./.venv`,
installs everything including the Copilot runtime, and runs the setup check.

Then open **Tutorial → Copilot**. If no model is available the panel shows
**Set up Copilot** / **Enable the local AI assistant**. It detects your memory
and suggests the largest model tier that fits; **Download & start** downloads it
(with progress; you can keep working) and starts `mlx_lm.server` as a child
process that stops with the browser.

Models are cached in `~/.fiberhmm/copilot_models/`. Set
`FIBERBROWSER_COPILOT_HOME` to keep them elsewhere, for example on a larger
disk.

### Command-line control

| Flag | Effect |
|------|--------|
| `--copilot auto` | Default. Use a running `mlx_lm.server` on port 8080, else start one from a downloaded model, else use a running Ollama, else stay off until set up in the panel. |
| `--copilot mlx` | Force MLX; downloads the model if needed. |
| `--copilot ollama` | Force Ollama. |
| `--copilot off` | Disable the Copilot. |
| `--no-copilot` | Leave the Copilot out entirely: the page hides it, its routes refuse, and nothing is downloaded or started. Same as `FIBERBROWSER_COPILOT=off`. FiberBrowser.app (the app window) runs this way; the Copilot is available in the pip install, in a web browser. |
| `--copilot-model ID` | Use a specific model instead of the automatic choice. |
| `--copilot-port N` | Port for the managed model server (default 8080; the next free port if taken). |

### Ollama

```bash
ollama pull qwen2.5
ollama serve                          # in another terminal
python browser.py --copilot ollama
```

The setup card in the panel detects a missing `ollama serve` or an empty model
list and says how to fix it.

## Check setup

```bash
python browser.py --copilot-doctor            # add --offline to skip the network check
```

The panel's **Check setup** button runs the same checks (also available as
`GET /api/nl/doctor`). It checks the Python version, core packages, Apple
Silicon vs Intel vs Rosetta, the macOS version, `mlx-lm`, the recommended model,
free disk, the download server, the model-server port and Ollama, and prints the
fix for each problem.

| Problem | Fix |
|---------|-----|
| Python is running under Rosetta (Intel) | Install an arm64 Python (for example Miniforge arm64), then `bash scripts/install.sh`. |
| Python too old (macOS's `/usr/bin/python3` is 3.9) | Install Python 3.10+ (`brew install python@3.12` or python.org), then `bash scripts/install.sh`. |
| mlx-lm isn't usable | `python -m pip install 'mlx-lm>=0.19' huggingface_hub` with the Python that runs the browser. |
| Can't reach the model download server | Check the network; set `HTTPS_PROXY`, or `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` for a corporate CA. |
| Low disk space | A smaller tier is chosen automatically, or set `FIBERBROWSER_COPILOT_HOME`. |
| Port 8080 used by another program | The model server moves to the next free port, or pass `--copilot-port`. |

## Use it

1. Type a question in the box and click **Plan** (Cmd/Ctrl+Enter). The model's
   reasoning streams while it plans; **Stop** cancels.
2. The plan appears as a list of steps. Click **Run plan** to start the
   walkthrough. Each step spotlights a control in one popover ("2 of 5") with
   an explanation. Click through the steps and do the highlighted actions
   yourself.

The browser also sends the Copilot a short description of what it is showing
(view, loaded datasets, selected gene, cluster settings, and problems such as a
filter that matched no reads), so questions like "why are no reads visible?"
get an answer about your current state.

## Sharing usage (optional)

Off by default. In the Copilot tab, tick **Share anonymized usage with the
FiberBrowser team** to keep an anonymized log of how you use the browser in a
local file. Gene, motif and dataset names are hashed, coordinates are bucketed,
typed labels are redacted and file paths removed. **Share full details** keeps
them in cleartext instead.

Nothing is sent automatically. **Save now** writes the log immediately;
**Reveal in Finder** and **Copy path** locate the file so you can send it;
**Clear file** empties it. If a maintainer has configured an upload receiver,
**Send to maintainer** uploads the file.

### Collecting usage logs (maintainers)

To collect testers' logs in one place, run the small receiver in
`scripts/copilot_collect_endpoint.py` on a machine you control:

```bash
pip install 'fastapi[standard]' uvicorn
python scripts/copilot_collect_endpoint.py --generate-token alice   # one per tester; prints the settings to send
python scripts/copilot_collect_endpoint.py --serve                  # port 8090
```

Put it behind HTTPS (for example a Cloudflare Tunnel, or Caddy with a domain).
Each tester then starts FiberBrowser with

```bash
export FIBERBROWSER_USAGE_UPLOAD_URL="https://your-collector/upload"
export FIBERBROWSER_USAGE_UPLOAD_TOKEN="tk_<their token>"
```

and gets **Send to maintainer** in the Copilot tab. Uploads land in
`~/.fiberhmm/copilot_collector/<tester>/` on the receiver.
`--revoke <tester>` and `--rotate <tester>` manage tokens; the token list,
`~/.fiberhmm/copilot_collector/tokens.json`, is the only secret.

## From Python

`browser_client.py` exposes the planner: `plan_natural_language_command(text, ...)`,
`stream_natural_language_command(text, ...)`, `setup_copilot(model_id=None)`,
`probe_copilot_backends()` and `set_copilot_backend(backend)`. See the
[Jupyter / Python API](jupyter-api.md#copilot).

## Training your own model

The training corpus is `data/copilot_dataset/records.py`: records validated
through the same safety checks the runtime uses. Add records there, rebuild the
dataset and retrain (MLX, Apple silicon):

```bash
python scripts/build_copilot_dataset.py           # build the dataset, checked against the live API
python scripts/prepare_copilot_dataset.py
SIZE=balanced bash scripts/train_copilot_lora.sh  # LoRA fine-tune; SIZE=tiny|light|balanced|heavy|max
bash scripts/serve_copilot_model.sh               # fuse and serve
```

`scripts/eval_copilot_suite.py` evaluates a model, and
`scripts/release_copilot.py` / `scripts/upload_copilot_models.py` quantize and
publish tiers to the Hugging Face Hub. The tiers the panel offers are listed
in `data/copilot_dataset/models.json`.
