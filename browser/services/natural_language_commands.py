"""Natural-language browser command planning powered by a local Ollama model.

Design contract:
- The planner is LLM-only. There is no rule-based / regex fallback. If the
  local model is unavailable we surface that as a hard error so the user can
  start Ollama or pick another tag.
- The system prompt is **stable**: it contains the action schema and the full
  safe `/api/...` catalog generated once per FastAPI app, with no per-request
  state. This lets Ollama reuse the prefix KV-cache across calls (combined
  with `keep_alive`) so we do not "prompt-inject" the API every turn.
- Per-request state (viewport, datasets, command) goes in the user message.
- The streaming planner yields events: start / thinking / token / plan /
  warning / error / done. Thinking is surfaced verbatim so users can debug.
- Every model action goes through the same safety/normalization layer; the
  frontend executes only the validated plan after user confirmation.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.request
from typing import Any, Iterable, Iterator, Optional
from urllib.parse import parse_qsl, urlsplit

from services import copilot_tutorial
from services.copilot_tutorial import COPILOT_TEACH_ACTIONS, COPILOT_TEACH_ONLY  # noqa: F401 (re-exported)


# Authoritative blocklist for Copilot api_call. Keep in parity with the
# client-side mirror COPILOT_API_BLOCKED in
# browser/frontend/src/actions/browserActions.ts — the backend builds the safe
# catalog from this, and the frontend re-checks it as defense-in-depth.
COPILOT_API_UNSAFE_PATTERNS: tuple[str, ...] = (
    r"^/api/nl/",
    r"^/api/shutdown$",
    r"^/api/quit$",
    r"^/api/cancel_shutdown$",
    r"^/api/new-window$",
    r"^/api/pick_",
    r"^/api/pick-file$",
    r"^/api/load_",
    r"^/api/diagnose_bam$",
    r"^/api/datasets/add$",
    r"^/api/datasets/add_url$",
    r"^/api/datasets/drop_window$",
    r"^/api/files/upload$",
    r"^/api/s3/",
    r"^/api/add_track$",
    r"^/api/tracks/add_motif_file$",
    r"^/api/bigbed/names$",
    r"^/api/annotations/add$",
    r"^/api/annotations/browse$",
    r"^/api/overlays/add$",
    r"^/api/primer_blast_db/build$",
    r"^/api/footprint/derived_layers/(load|export)$",
    r"^/api/footprint/rules/(load|save)$",
    r"^/api/motifs/load",
    # Routes that take server file paths or change the loaded reference.
    # (/api/primer_config stays: its fasta_path/blast_db_path parameters are
    # caught by the key rules below, its Tm/length settings are harmless.)
    r"^/api/dafc/load$",
    r"^/api/files/",
    r"^/api/gtf$",
    r"^/api/jupyter/motifs/load_file$",
    r"^/api/session/(read|check_files|import)$",
    r"^/api/datasets/add_grouped$",
    # New DAF-seq run: starts host processes on host files (routers/pipeline.py).
    r"^/api/pipeline/",
    r"^/api/qc/",
)

# Method-specific blocks: the other methods of these routes only read.
COPILOT_API_UNSAFE_METHOD_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/api/reference_pairs"),  # takes FASTA/annotation paths, replaces the reference
})

# Keys ending like this name files, folders or remote locations (cool_file,
# blast_db_path, ...) whatever the route; blocked like COPILOT_API_BLOCKED_KEYS.
COPILOT_API_BLOCKED_KEY_SUFFIXES: tuple[str, ...] = (
    "_path", "_paths", "_file", "_files", "_dir", "_folder", "_url", "_urls",
)

# One URL path segment ('.' and '..' are refused separately): no
# percent-encoding, backslashes or other characters a server could rewrite.
# Braces are for the catalog's route templates ({param}).
_API_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9_.:~{}-]+$")

COPILOT_API_METHODS: frozenset[str] = frozenset({"GET", "POST", "DELETE"})
COPILOT_API_BLOCKED_KEYS: frozenset[str] = frozenset({
    "path", "paths", "file", "files", "file_path", "filepath",
    "folder", "dir", "directory", "output", "output_dir", "output_folder",
    "bam_path", "fasta_path", "gtf_path", "bundle_path",
    "url", "urls", "s3_url", "bucket", "prefix", "profile", "endpoint_url",
    "fasta", "annotation", "gtf", "bam", "bigbed", "cool",
})

COPILOT_DEFAULT_MODEL = os.environ.get("FIBERBROWSER_COPILOT_MODEL", "qwen2.5")
COPILOT_OLLAMA_URL = os.environ.get("FIBERBROWSER_COPILOT_OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
COPILOT_OLLAMA_TAGS_URL = os.environ.get("FIBERBROWSER_COPILOT_OLLAMA_TAGS_URL", "http://127.0.0.1:11434/api/tags")
COPILOT_OLLAMA_TIMEOUT = float(os.environ.get("FIBERBROWSER_COPILOT_TIMEOUT", "120"))
COPILOT_OLLAMA_KEEP_ALIVE = os.environ.get("FIBERBROWSER_COPILOT_KEEP_ALIVE", "60m")
COPILOT_DATASET_CONTEXT_LIMIT = int(os.environ.get("FIBERBROWSER_COPILOT_DATASET_LIMIT", "12"))
COPILOT_LABEL_MAX_CHARS = int(os.environ.get("FIBERBROWSER_COPILOT_LABEL_CHARS", "96"))

# MLX (mlx_lm.server) is an alternative backend for Apple Silicon. It exposes
# an OpenAI-compatible streaming API, so the same UI / safety pipeline works
# unchanged after the streaming chunks are normalized to Ollama's shape.
COPILOT_MLX_URL = os.environ.get(
    "FIBERBROWSER_COPILOT_MLX_URL", "http://127.0.0.1:8080/v1/chat/completions"
)
COPILOT_MLX_MODELS_URL = os.environ.get(
    "FIBERBROWSER_COPILOT_MLX_MODELS_URL", "http://127.0.0.1:8080/v1/models"
)


def _mlx_chat_url() -> str:
    return os.environ.get("FIBERBROWSER_COPILOT_MLX_URL", COPILOT_MLX_URL)


# mlx_lm.server's name for the model it was launched with (--model).
MLX_SERVED_MODEL = "default_model"


def _mlx_models_url() -> str:
    return os.environ.get("FIBERBROWSER_COPILOT_MLX_MODELS_URL", COPILOT_MLX_MODELS_URL)


def _model_names_from_openai_models_payload(payload: Any) -> list[str]:
    """Normalize common /v1/models response shapes to model id strings."""
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("data") or payload.get("models") or []
        direct = payload.get("id") or payload.get("model") or payload.get("name")
        if isinstance(direct, str) and direct:
            items = [direct, *list(items if isinstance(items, list) else [])]
    else:
        items = []

    out: list[str] = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str) and item:
            out.append(item)
            continue
        if not isinstance(item, dict):
            continue
        name = item.get("id") or item.get("model") or item.get("name")
        if isinstance(name, str) and name:
            out.append(name)
    return sorted(set(out))


_PROBE_CACHE: dict[str, Any] = {"url": None, "at": 0.0, "result": None}
_PROBE_CACHE_TTL_S = 2.0
_PROBE_CACHE_LOCK = threading.Lock()


def probe_mlx_server(*, timeout: float = 1.0) -> dict[str, Any]:
    """Probe mlx_lm.server without conflating reachability with model parsing.

    Cached for ~2s keyed on the current `_mlx_models_url()` so back-to-back
    calls (capabilities → planner → agent_step → frontend poll) don't each
    pay the network probe cost. Cache invalidates when the URL changes —
    e.g. when the user switches backend and `_mlx_models_url()` rolls over
    to a different host.
    """
    url = _mlx_models_url()
    now = time.time()
    with _PROBE_CACHE_LOCK:
        cached = dict(_PROBE_CACHE)
    if (
        cached["url"] == url
        and cached["result"] is not None
        and (now - cached["at"]) < _PROBE_CACHE_TTL_S
    ):
        return dict(cached["result"])

    try:
        request = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except Exception as exc:
        result = {"reachable": False, "models": [], "error": f"{type(exc).__name__}: {exc}"}
    else:
        try:
            payload = json.loads(raw)
        except Exception as exc:
            result = {"reachable": True, "models": [], "error": f"invalid JSON from /v1/models: {exc}"}
        else:
            result = {
                "reachable": True,
                "models": _model_names_from_openai_models_payload(payload),
                "error": None,
            }
    # All three fields together, so a concurrent reader never pairs one URL
    # with another's result.
    with _PROBE_CACHE_LOCK:
        _PROBE_CACHE.update(url=url, at=now, result=result)
    return dict(result)


def _reset_probe_cache_for_tests() -> None:
    """Clear the in-memory probe cache so tests can assert clean state."""
    with _PROBE_CACHE_LOCK:
        _PROBE_CACHE.update(url=None, at=0.0, result=None)


def _autodetect_backend() -> str:
    """If the user didn't explicitly choose a backend, prefer MLX when
    mlx_lm.server is already reachable; otherwise fall back to Ollama."""
    explicit = os.environ.get("FIBERBROWSER_COPILOT_BACKEND", "").strip().lower()
    if explicit:
        return explicit
    return "mlx" if probe_mlx_server(timeout=1.5)["reachable"] else "ollama"


# Read once at import. The lifecycle module sets FIBERBROWSER_COPILOT_BACKEND
# before server.py imports any planner code, so by the time we get here the
# user's intent is already reflected. set_backend() lets the panel switch at
# runtime without a process restart.
COPILOT_BACKEND = _autodetect_backend()
_BACKEND_LOCK = threading.Lock()


def set_backend(backend: str) -> None:
    """Runtime override for the active planner backend ('mlx' | 'ollama')."""
    global COPILOT_BACKEND
    with _BACKEND_LOCK:
        COPILOT_BACKEND = backend.strip().lower() or "ollama"
        os.environ["FIBERBROWSER_COPILOT_BACKEND"] = COPILOT_BACKEND
        _clear_mlx_probe_cache()


COPILOT_MODEL_REGISTRY_PATH = os.environ.get(
    "FIBERBROWSER_COPILOT_REGISTRY",
    str((__import__("pathlib").Path(__file__).resolve().parents[2]
         / "data" / "copilot_dataset" / "models.json")),
)


SYSTEM_PROMPT_HEADER = """You are FiberBrowser Copilot, a local genome-browser planner for fiber-seq, DAF-seq, BigBed, BAM, contact-map, motif, and annotation analysis.

You translate the user's natural-language request into a JSON plan. The browser executes the plan after the user reviews it.

Output protocol:
1. First, think out loud inside <think>...</think>. Use this to reason about which gene the user means, which actions to chain, and any edge cases. The user sees this and uses it to debug.
2. After </think>, emit exactly one JSON object on the remaining lines. Nothing else.

The JSON object has this shape:
{
  "summary": "one short sentence describing the plan",
  "actions": [ ... ordered list of typed actions ... ],
  "warnings": [ ... optional strings for ambiguities ... ]
}

Rules:
- Emit typed actions only. Prose belongs inside <think>...</think>, never outside the JSON.
- Preserve gene symbols exactly. Do not substitute partial matches. If a gene cannot be resolved, return a warning instead of guessing coordinates.
- Never guess numeric scientific results (read counts, motif scores, cluster IDs). Request actions; the browser computes them.
- Never use file pickers, file/upload routes, S3 credentials, local paths, output folders, process spawn, or shutdown routes. The safe API catalog below is exhaustive.
- Decompose multi-step requests into ordered actions. It is fine to chain several api_call actions when no high-level action fits.
- The viewport, dataset list, and GTF status come in the user message. Use them, but do not echo them back.

High-level browser actions (preferred when they fit):

  navigate_gene
    {"type":"navigate_gene","gene":"eve","padding_bp":5000}
    Resolves the gene against the loaded GTF, sets the viewport to gene +/- padding,
    and pins the relative-coordinate TSS.

  navigate_region
    {"type":"navigate_region","chrom":"2R","start":9970000,"end":9980000,"label":"..."}
    Sets the viewport to an explicit interval.

  scan_peaks
    {"type":"scan_peaks","scope":"enabled_rules"}
    Re-runs the active peak rules in the current viewport.

  set_peaks_locked
    {"type":"set_peaks_locked","locked":true}
    Locks/unlocks current peaks for reproducibility.

  select_peak_at
    {"type":"select_peak_at","chrom":"2R","position":9974000,"tolerance_bp":500}
    Selects the nearest detected peak to a position.

  cluster_selected_peaks
    {"type":"cluster_selected_peaks"}
    Runs clustering on currently selected peaks.

  cluster_peak_at_gene_tss
    {"type":"cluster_peak_at_gene_tss","gene":"eve","padding_bp":5000,"tolerance_bp":500}
    Navigates if needed, scans, selects the nearest peak to the gene TSS,
    and runs clustering.

  set_cluster_method  (change the clustering algorithm)
    {"type":"set_cluster_method","method":"kmeans"}
    Valid method values: kmeans, minibatch (KMeans++), agglom (Hierarchical),
    hdbscan, combinatorial. Natural-language aliases like "k-means" → kmeans,
    "hierarchical" → agglom, "density" → hdbscan are accepted. Use BEFORE
    cluster_selected_peaks / cluster_peak_at_gene_tss so the method is set
    when clustering fires.

  set_cluster_k  (number of clusters for kmeans / minibatch)
    {"type":"set_cluster_k","k":5}
    k must be an integer in [2, 20]. Only affects methods that take a k
    (kmeans, minibatch). Ignored otherwise. Synonyms accepted in payload:
    "n_clusters", "num_clusters", "number_of_clusters".

  set_sample_seed  (reproducibility — pin sampling RNG for clustering / metaprofiles)
    {"type":"set_sample_seed","seed":"my-analysis-2026"}

  Clustering scope note: the "accessibility" / "FIRE" rule is the DEFAULT
  cluster rule. When the user says "cluster on accessibility" / "cluster by
  FIRE" / "cluster on the default rule", emit cluster_selected_peaks (or
  cluster_peak_at_gene_tss) directly — no add_cluster_rule needed. Only
  add a new cluster rule when the user explicitly names a non-default
  feature (e.g. "cluster on TF binding at TSS-100").

  add_region_label_rule (explicit form, when you already know genomic coords)
    {"type":"add_region_label_rule","chrom":"2R","start":9973900,"end":9973980,
     "layer":"tf","color":"#22c55e","size_min":1,"size_max":89,"label":"...","region_label":"..."}

  add_region_label_rule (TSS-relative form — use this for "at +/-N from the TSS")
    {"type":"add_region_label_rule","relative_to_gene":"eve","offset_bp":-100,"width_bp":80,
     "layer":"tf","color":"#22c55e","size_min":1,"size_max":89,"region_label":"eve TSS -100"}
    The browser resolves the gene from the GTF and computes the strand-aware
    genomic coordinates (positive offset = downstream of TSS in the direction
    of transcription, negative = upstream). NEVER pass negative chrom coords.

  query_motif_overlaps
    Explicit: {"type":"query_motif_overlaps","chrom":"2R","start":9973900,"end":9973980}
    TSS-relative: {"type":"query_motif_overlaps","relative_to_gene":"eve","offset_bp":-100,"width_bp":80}

  Analysis Rules panel actions (preferred when the user wants reusable
  Cluster/Sort/Filter dropdown entries):
    {"type":"open_panel","panel_type":"cluster-features","tab":"sort"}
    {"type":"add_cluster_rule","name":"TF at selected peaks",
     "scope":{"kind":"selectedPeaks"},
     "terms":[{"id":"t1","source":"layer","layer":"tf","sizeMin":1,"sizeMax":89}]}
    {"type":"add_sort_rule","name":"Paused Pol II first",
     "scope":{"kind":"gene","geneName":"eve","genePart":"tss"},
     "terms":[{"id":"t1","source":"transcription_state","transcriptionState":"pause"}],
     "metric":"count","descending":true}
    {"type":"add_filter_rule","name":"Nuc occupancy >= 0.5",
     "scope":{"kind":"currentWindow"},
     "terms":[{"id":"t1","source":"layer","layer":"nuc","sizeMin":90,"sizeMax":250}],
     "metric":"occupancy","operator":"gte","threshold":0.5}
    Term sources: "layer", "label_rule", "footprint_group", "transcription_state".
    Pol II pause/PIC/elongating rules MUST use
    source="transcription_state" with transcriptionState in
    {"pause","pic","elongating"} and a gene/current-window scope.

  Saved rule execution:
    {"type":"apply_cluster_rule","rule_name":"TF footprints"}
    {"type":"apply_sort_rule","rule_name":"Paused Pol II first"}
    {"type":"apply_filter_rule","rule_name":"Pol II pause","pin":true}

  Cluster/UI actions:
    {"type":"focus_cluster","cluster_id":2}
    {"type":"hide_cluster","cluster_id":2}
    {"type":"dissolve_cluster","cluster_id":2}
    {"type":"select_cluster_reads","cluster_id":2}
    {"type":"auto_cull_clusters","min_fraction":0.03,"max_cosine_similarity":0.95}
    {"type":"clear_selected_peaks"} / {"type":"clear_selected_reads"} / {"type":"clear_filter"}

  Cluster selection + merge (select clusters, then combine them into one):
    {"type":"toggle_cluster_selection","cluster_id":2}   (add/remove one cluster from the selection)
    {"type":"set_cluster_selection","cluster_ids":[1,3,4]}
    {"type":"clear_cluster_selection"}
    {"type":"merge_clusters"}   (merges the CURRENTLY SELECTED clusters — select first)
    {"type":"set_cluster_order_lock","locked":true}   (freeze cluster order so re-sorting won't reshuffle)
    To merge clusters, emit selection steps first, then merge_clusters, e.g.
    [{"type":"toggle_cluster_selection","cluster_id":1},{"type":"toggle_cluster_selection","cluster_id":2},{"type":"merge_clusters"}]

  Cluster trees + dynamic reassignment (drill into clusters; branches are saved snapshots):
    {"type":"subcluster_clusters","cluster_ids":[2]}   (re-cluster only the reads in cluster 2 — creates a child branch)
    {"type":"set_dynamic_clustering","enabled":true}   (reassign reads to nearest cluster as the viewport moves)
    {"type":"set_dynamic_overlap_mode","mode":"aggressive"}   (aggressive = overlap ANY peak; conservative = ALL peaks, else Unassigned)
    {"type":"capture_cluster_branch","name":"baseline"}   (save the current clustering as a named branch)
    {"type":"switch_cluster_branch","name":"C2"}   (jump back to a saved branch by name)
    {"type":"rename_cluster_branch","new_name":"paused Pol II"}   (rename the active branch; pass "name" to target another)
    {"type":"delete_cluster_branch","name":"old branch"}
    Subclustering branches the cluster tree: the parent stays intact, reads outside the
    drilled-into clusters fold into an "Unassigned" bucket. Use switch_cluster_branch to
    backtrack. "subcluster cluster 2" / "drill into cluster 2" -> subcluster_clusters.

  Display/track/primer/footprint actions:
    {"type":"toggle_layer","layer":"nuc","enabled":false}
    {"type":"set_quality_filter","value":200}
    {"type":"set_min_footprints","value":3}
    {"type":"set_spanning_only","enabled":false}
    {"type":"add_track_from_url","path":"https://example.org/signal.bw","track_label":"ATAC"}
    {"type":"remove_track","track_index":0}
    {"type":"set_track_filter","track_index":2,"filter_names":["MA0007","MA0050"]}
    {"type":"design_primers_for_region","mode":"standard"}
    {"type":"add_footprint_group","name":"Pol II","layer":"tf","size_min":35,"size_max":65}
    {"type":"add_capture_region","chrom":"2R","start":9970000,"end":9980000}
    {"type":"toggle_annotation_visibility","name":"5mC","enabled":false}

  Read display controls (how the read track is drawn):
    {"type":"set_read_row_height","value":12}        (pixels per read row, or "auto" to fit)
    {"type":"set_fill_read_height","enabled":true}   (sparse reads expand to fill the track)
    {"type":"set_read_separator_mode","mode":"auto"} (gaps between reads: auto | fixed | off)
    {"type":"set_read_separator_min_height","value":2}
    {"type":"set_read_separator_width","value":1}
    {"type":"set_layer_background_opacity","layer":"nuc","opacity":0.3}

  Motif tools:
    {"type":"set_motif_threshold","value":0.85}       (global motif score cutoff, 0.5-1.0)
    {"type":"load_jaspar_motifs","names":["CTCF","GATA1"]}  (load JASPAR motif tracks by TF name or ID)
    Add a custom motif via api_call (these routes are safe):
    {"type":"api_call","method":"POST","path":"/api/tracks/add_motif_sequence","body":{"sequence":"TGASTCA","threshold":0.85}}
    {"type":"api_call","method":"POST","path":"/api/tracks/add_motif_pwm","body":{"name":"myPWM","counts":{"A":[1,0],"C":[0,1],"G":[0,0],"T":[0,0]},"threshold":0.85}}

  Panels: DAF-seq strands, copies at other loci, best-covered loci:
    {"type":"set_panel_strand","strand":"CT"}   (DAF-seq panels show only CT-strand reads; "GA", or "both" to undo)
    {"type":"split_panel_by_strand"}            (CT and GA reads in two panels side by side)
    {"type":"open_panel_copy"}                  (the header "+": a copy linked to the main view)
    {"type":"open_panel_copy","gene":"eve"}     (an unlinked copy at a gene; or "chrom","start","end")
    {"type":"set_panel_linked","linked":false}  (unlink panel copies so they navigate on their own; true re-links)
    {"type":"go_to_top_locus"}                  ("go to reads": next best-covered window at this zoom, deepest first)
    {"type":"cluster_by_saved_footprints"}      (Footprints > Co-occupancy: cluster reads by which saved footprints they carry)
    A copy at another locus/haplotype is clustered together with the main view:
    select or draw peaks in either panel, then cluster_selected_peaks.

  Layout panel actions (arrange / combine loaded datasets):
    {"type":"open_panel","panel_type":"dataset-layout"}
    {"type":"set_dataset_label","dataset_id":"ds1","label_text":"WT rep1"}  (rename a dataset)
    {"type":"merge_datasets"}    (merge the SELECTED dataset panels into one view)
    {"type":"unmerge_dataset"}   (split a merged dataset back apart)
    {"type":"link_datasets","panel_ids":["ds1","ds2"]}   (sync viewport/visibility across panels)
    {"type":"unlink_dataset","panel_id":"ds2"}

  api_call
    {"type":"api_call","method":"GET|POST|DELETE","path":"/api/...","body":{...}}
    Direct same-origin call to a safe API route. Use this for any safe route
    not covered by a high-level action.

  explain  (explanatory tutorial mode — no side effect)
    {"type":"explain","text":"...","panel_type":"footprint-analysis"}
    Use this when the user asks "how do I X" or "what does Y do" instead of
    asking the browser to do something. The runner shows the text in a popover
    over the panel (if panel_type set) without touching state. Chain multiple
    `explain` steps to walk the user through a workflow, with optional
    `open_panel` steps in between to actually surface the relevant UI.

  Tutorial-walk pattern (when the user asks a "how do I X" question):
    [{"type":"open_panel","panel_type":"footprint-analysis","label":"Open the Footprints panel"},
     {"type":"explain","panel_type":"footprint-analysis","text":"This panel runs against the current viewport. The Sizes tab lets you define footprint classes by size range."},
     {"type":"explain","panel_type":"footprint-analysis","text":"Pick a footprint by clicking it in any read track — its size goes into the Custom min/max boxes."},
     {"type":"explain","panel_type":"footprint-analysis","text":"Click Add to save the group, then the Analyze button at the top runs the analysis."}]
    Each `label` (or each `explain.text`) becomes the popover content for that
    step; the user clicks Next to advance. The browser never mutates state.

For any action that addresses "the TSS" or "+/-N from the TSS" or "at -100 bp",
ALWAYS use the TSS-relative form. Do not invent genomic numbers. The validator
rejects negative or inverted genomic coordinates.

select_peak_at can also use the relative form:
  {"type":"select_peak_at","relative_to_gene":"eve","offset_bp":0,"tolerance_bp":500}
  (offset_bp=0 means the TSS itself.)

For "footprints smaller than N bp" use size_min=1, size_max=N-1. For nucleosomes
use size_min=90 and a high size_max (e.g. 250).

The user message includes the **selected gene** when one is set. When the user
says "this gene", "the TSS", "do that again", "use k=5 instead", etc., resolve
those references against:
- the "Selected gene:" line (current gene focus)
- the "Recent commands" section at the bottom (last 1-3 turns of history)
Do not ask the user to restate. If neither selected gene nor recent commands
clarify the reference, return a warning instead of guessing.

Tunable analysis settings (set via api_call to POST /api/jupyter/settings):
- cluster_k (int, e.g. 3-8), cluster_method ("kmeans" | "combinatorial" | "hierarchical")
- analysis_sample_count (int), analysis_sample_seed (string) — for reproducibility
- small_footprint_threshold_bp (int, default 90; the subnucleosomal threshold),
  accessibility_threshold (float 0-1)
- spanning_only (bool), peaks_locked (bool)
- click_target_layer ("tf" | "nuc" | "fire" | ...)
- cluster_feature_rules, analysis_sort_rules, analysis_filter_rules — reusable
  Analysis Rules definitions that populate the Cluster/Sort/Filter dropdowns.
  Pol II rules should use source="transcription_state" and a selected/scope gene.
Example: "use k=5 for clustering" -> {"type":"api_call","method":"POST",
"path":"/api/jupyter/settings","body":{"cluster_k":5}}.

Analysis Rules execution endpoints (use when the user names a saved rule or
asks to filter/sort/cluster by a metric the rule encodes):
- POST /api/filter_by_analysis_rule — body: {dataset_ids, metric, operator,
  threshold, rule?, peak_regions?, scope_windows?, transcription_state?,
  gene_ids?, layer?}. metric in {count, occupancy, rate, accessibility},
  operator in {gt, gte, lt, lte, eq}. transcription_state in
  {pause, pic, elongating} routes through the Pol II metric.
- POST /api/sort_reads — same body augmented with sort_by (rule, occupancy,
  fp_count, fp_rate, accessibility, similarity, transcription_state) and
  transcription_state + gene_ids for Pol II sorts.
- GET  /api/jupyter/analysis_state — the response's analysis_rules key holds
  the current {cluster_feature_rules, analysis_sort_rules, analysis_filter_rules}
  definitions. POST /api/jupyter/settings with any of those same keys to
  replace them in the live browser state.
- POST /api/tracks/batch — body: {track_indices, chrom, start, end, bins,
  annotation_filters?}. Fetch many signal/annotation tracks in one round-trip.
- GET  /api/dafc/select?chrom=&x_start=&x_end=&y_start=&y_end= — query
  contacts and linked reads for a selected contact-map rectangle.

When peak_regions entries use mode "cluster_rule:<id>", include the matching
rule in the cluster_feature_rules body field on /api/cluster_all,
/api/assign_to_clusters, /api/dissolve_cluster, /api/auto_cull_clusters, and
/api/cluster_projection.
"""


SYSTEM_PROMPT_FOOTER = """All other /api/... routes are intentionally blocked from Copilot because they
can read/write local files, upload, configure credentials, or change server
lifecycle. The validator drops anything outside this catalog.

Output reminder: <think>...</think> first, then a single JSON object.
"""


_PROMPT_LOCK = threading.Lock()
_PROMPT_CACHE: dict[Any, str] = {}
_CAPABILITIES_CACHE: dict[int, dict[str, Any]] = {}
_MLX_PROBE_CACHE_LOCK = threading.Lock()
_MLX_PROBE_CACHE_TTL_SECONDS = 2.0
_MLX_PROBE_CACHE: dict[tuple[int, str, float], tuple[float, dict[str, Any]]] = {}


def _clear_mlx_probe_cache() -> None:
    with _MLX_PROBE_CACHE_LOCK:
        _MLX_PROBE_CACHE.clear()


def _cached_probe_mlx_server(*, timeout: float = 4.0) -> dict[str, Any]:
    """Memoize short-lived /v1/models probes so UI polling cannot stack them."""
    key = (id(probe_mlx_server), _mlx_models_url(), float(timeout))
    now = time.monotonic()
    with _MLX_PROBE_CACHE_LOCK:
        cached = _MLX_PROBE_CACHE.get(key)
        if cached is not None and now - cached[0] <= _MLX_PROBE_CACHE_TTL_SECONDS:
            return dict(cached[1])

    probe = probe_mlx_server(timeout=timeout)
    with _MLX_PROBE_CACHE_LOCK:
        _MLX_PROBE_CACHE[key] = (time.monotonic(), dict(probe))
    return probe


# ─────────────────────────────────────────────────────────────────────
# Safety
# ─────────────────────────────────────────────────────────────────────

def _blocked_key(key: Any) -> bool:
    key_norm = str(key).lower().replace("-", "_")
    return key_norm in COPILOT_API_BLOCKED_KEYS or key_norm.endswith(COPILOT_API_BLOCKED_KEY_SUFFIXES)


def canonical_copilot_api_path(path: str) -> Optional[str]:
    """The /api path a Copilot call targets, or None when it is ambiguous.

    The blocklist must see the route the server will actually run, so a path
    the server or browser could rewrite (dot segments, percent-encoding,
    backslashes, empty segments, fragments) is refused rather than normalized.
    """
    text = path or ""
    raw = text.split("?", 1)[0]
    if "#" in text or not raw.startswith("/api/"):
        return None
    for segment in raw.split("/")[1:]:
        if segment in ("", ".", "..") or not _API_PATH_SEGMENT.match(segment):
            return None
    return raw


def _contains_blocked_key(value: Any, *, depth: int = 0) -> Optional[str]:
    if depth > 6:
        return None
    if isinstance(value, dict):
        for key, child in value.items():
            if _blocked_key(key):
                return str(key)
            hit = _contains_blocked_key(child, depth=depth + 1)
            if hit:
                return hit
    elif isinstance(value, list):
        for child in value:
            hit = _contains_blocked_key(child, depth=depth + 1)
            if hit:
                return hit
    return None


def _blocked_query_key(path: str) -> Optional[str]:
    try:
        query = urlsplit(path).query
    except Exception:
        return None
    for key, _value in parse_qsl(query, keep_blank_values=True):
        if _blocked_key(key):
            return str(key)
    return None


def is_copilot_api_call_allowed(method: str, path: str, body: Any = None) -> tuple[bool, Optional[str]]:
    method_norm = (method or "").upper()
    if method_norm not in COPILOT_API_METHODS:
        return False, f"Method {method_norm or '<empty>'} is not allowed from Copilot."
    path_norm = canonical_copilot_api_path(path or "")
    if path_norm is None:
        return False, "Copilot API calls must target a plain same-origin /api route (no '.' or '..' segments, encoded characters or fragments)."
    if (method_norm, path_norm) in COPILOT_API_UNSAFE_METHOD_ROUTES or any(
            re.search(pattern, path_norm) for pattern in COPILOT_API_UNSAFE_PATTERNS):
        return False, "This route is intentionally blocked from Copilot because it can access local files, spawn processes, reconfigure credentials, or control server lifecycle."
    query_key = _blocked_query_key(path or "")
    if query_key:
        return False, f"This API call is blocked from Copilot because query parameter '{query_key}' can reference local/remote files or credentials."
    body_key = _contains_blocked_key(body)
    if body_key:
        return False, f"This API call is blocked from Copilot because body field '{body_key}' can reference local/remote files or credentials."
    return True, None


# ─────────────────────────────────────────────────────────────────────
# Ollama discovery
# ─────────────────────────────────────────────────────────────────────

def detect_system_memory_gb() -> Optional[float]:
    """Return total system RAM in GB, or None if it can't be determined.

    Uses POSIX sysconf — works on macOS and Linux without third-party deps.
    """
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page_size > 0:
            return round(pages * page_size / (1024 ** 3), 1)
    except (ValueError, OSError, AttributeError):
        pass
    return None


def load_model_registry() -> dict[str, Any]:
    """Read the trained-model registry from disk; tolerate missing/bad files."""
    try:
        from pathlib import Path
        path = Path(COPILOT_MODEL_REGISTRY_PATH)
        if not path.exists():
            return {"models": []}
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"models": []}


def recommend_models_for_host(*, ram_gb: Optional[float] = None) -> dict[str, Any]:
    """Filter the registry to models that fit on this host and pick a default.

    Returns shape understood by CopilotCommandPanel:
      models               — full list, every entry annotated with `fit`
      recommended_id       — best-fit non-deprecated trained model
      trained_count        — count of trained models
      latest_per_tier      — id of the newest non-deprecated entry per
                             (tier, quantized) bucket; used by the frontend
                             to collapse the dropdown to current versions
      update_available     — { from_id: to_id } mapping that tells the
                             frontend which loaded models have a newer
                             version available, so it can show an "update
                             available" banner without recomputing client-side
    """
    registry = load_model_registry()
    models = list(registry.get("models") or [])
    available_ram = ram_gb if ram_gb is not None else detect_system_memory_gb()

    annotated: list[dict[str, Any]] = []
    for model in models:
        min_ram = float(model.get("min_ram_gb") or 0)
        rec_ram = float(model.get("recommended_ram_gb") or min_ram)
        fit = "unknown" if available_ram is None else (
            "comfortable" if available_ram >= rec_ram
            else "minimum" if available_ram >= min_ram
            else "insufficient"
        )
        # Approx on-disk download size for the picker's size labels (no network).
        size_b = float(model.get("size_b") or 0)
        per_param = 0.55 if model.get("quantized") else 2.0
        download_gb = round(size_b * per_param, 1) if size_b else None
        annotated.append({**model, "fit": fit, "download_gb": download_gb})

    # Recommend among CURRENT (non-deprecated) trained models only; falling
    # back to deprecated ones would push the user backward.
    # Same order as copilot_lifecycle._pick_model (newest version, then the
    # larger model; ties keep registry order), so what's recommended here is
    # what the browser starts.
    def _best(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ranked = sorted(models, key=lambda m: (int(m.get("version") or 1), float(m.get("size_b") or 0)),
                        reverse=True)
        return ranked[:1]

    current = [m for m in annotated if m.get("trained") and not m.get("deprecated")]
    comfortable = _best([m for m in current if m["fit"] == "comfortable"])
    minimum = _best([m for m in current if m["fit"] == "minimum"])
    any_trained = _best([m for m in annotated if m.get("trained")])
    recommended = (comfortable or minimum or any_trained or [None])[0]

    # latest_per_tier: id of the newest non-deprecated trained entry per
    # (tier, quantized) bucket. Used by the frontend to filter the dropdown
    # to current versions only (with a "Show older versions" toggle).
    from collections import defaultdict as _dd
    by_bucket: dict[tuple[str, bool], dict[str, Any]] = {}
    for m in annotated:
        if not m.get("trained") or m.get("deprecated"):
            continue
        key = (m.get("tier") or "", bool(m.get("quantized")))
        existing = by_bucket.get(key)
        if existing is None or (m.get("version") or 1) > (existing.get("version") or 1):
            by_bucket[key] = m
    latest_per_tier = [m["id"] for m in by_bucket.values()]

    # update_available: for each DEPRECATED trained model, find the newest
    # non-deprecated entry in the same (tier, quantized) bucket. Empty dict
    # if there are no upgrade paths.
    update_available: dict[str, str] = {}
    for m in annotated:
        if not m.get("trained") or not m.get("deprecated"):
            continue
        replacement = by_bucket.get((m.get("tier") or "", bool(m.get("quantized"))))
        if replacement and replacement["id"] != m["id"]:
            update_available[m["id"]] = replacement["id"]

    return {
        "system_ram_gb": available_ram,
        "models": annotated,
        "recommended_id": recommended.get("id") if recommended else None,
        "trained_count": sum(1 for m in annotated if m.get("trained")),
        "latest_per_tier": latest_per_tier,
        "update_available": update_available,
    }


def list_mlx_models(*, timeout: float = 1.0) -> list[str]:
    """Query the running mlx_lm.server for currently loaded model IDs."""
    return list(probe_mlx_server(timeout=timeout)["models"])


def list_ollama_models(*, timeout: float = 1.0) -> list[str]:
    try:
        request = urllib.request.Request(COPILOT_OLLAMA_TAGS_URL, method="GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []
    models: list[str] = []
    for item in payload.get("models", []) if isinstance(payload, dict) else []:
        name = item.get("name") or item.get("model")
        if isinstance(name, str) and name:
            models.append(name)
    return sorted(set(models))


def resolve_ollama_model(requested: Optional[str], available_models: Optional[list[str]] = None) -> tuple[str, Optional[str]]:
    """Map shorthand names like 'qwen2.5' to the exact installed tag."""
    model = (requested or COPILOT_DEFAULT_MODEL).strip() or COPILOT_DEFAULT_MODEL
    available = available_models if available_models is not None else list_ollama_models()
    if not available or model in available:
        return model, None
    if ":" not in model:
        latest = f"{model}:latest"
        if latest in available:
            return latest, f"Resolved '{model}' to installed tag '{latest}'."
        prefix = f"{model}:"
        matches = [candidate for candidate in available if candidate.startswith(prefix)]
        if matches:
            return matches[0], f"Resolved '{model}' to installed tag '{matches[0]}'."
    return model, None


# ─────────────────────────────────────────────────────────────────────
# System prompt: built once per app, cached for KV-prefix reuse
# ─────────────────────────────────────────────────────────────────────

def _route_doc(route) -> str:
    endpoint = getattr(route, "endpoint", None)
    doc = (getattr(endpoint, "__doc__", None) or "").strip().splitlines()
    if doc:
        return doc[0].strip()
    return (getattr(route, "summary", None) or getattr(route, "name", "") or "").strip()


def _safe_routes(app) -> list[dict[str, Any]]:
    from utils.routes import app_routes
    routes: list[dict[str, Any]] = []
    for route in app_routes(app):
        path = getattr(route, "path", "")
        if not isinstance(path, str) or not path.startswith("/api/"):
            continue
        methods = sorted(
            method for method in (getattr(route, "methods", None) or [])
            if method not in {"HEAD", "OPTIONS"}
        )
        if not methods:
            continue
        allowed = []
        blocked: dict[str, str] = {}
        for method in methods:
            ok, reason = is_copilot_api_call_allowed(method, path)
            if ok:
                allowed.append(method)
            elif reason:
                blocked[method] = reason
        routes.append({
            "path": path,
            "methods": methods,
            "allowed_methods": allowed,
            "copilot_allowed": bool(allowed),
            "blocked_methods": blocked,
            "name": getattr(route, "name", path),
            "description": _route_doc(route),
        })
    routes.sort(key=lambda r: (r["path"], ",".join(r["methods"])))
    return routes


def build_copilot_system_prompt(app, teach_only: Optional[bool] = None) -> str:
    """Stable prompt built once per FastAPI app. KV cache survives across calls.

    Teach-only (the default, COPILOT_TEACH_ONLY) lists the tutorial actions,
    UI anchors, milestones and conditions; the operator prompt with the safe
    /api catalog is kept for the legacy training corpus (teach_only=False).
    """
    if teach_only is None:
        teach_only = copilot_tutorial.COPILOT_TEACH_ONLY
    key = (id(app), bool(teach_only))
    cached = _PROMPT_CACHE.get(key)
    if cached is not None:
        return cached
    with _PROMPT_LOCK:
        cached = _PROMPT_CACHE.get(key)
        if cached is not None:
            return cached
        if teach_only:
            prompt = copilot_tutorial.build_teach_system_prompt()
            _PROMPT_CACHE[key] = prompt
            return prompt
        routes = _safe_routes(app)
        lines = [SYSTEM_PROMPT_HEADER, "", "Safe /api/... catalog (use via api_call):"]
        for route in routes:
            if not route["copilot_allowed"]:
                continue
            method_str = "|".join(route["allowed_methods"])
            description = (route["description"] or "").strip()
            if description:
                lines.append(f"  {method_str:<10} {route['path']} — {description}")
            else:
                lines.append(f"  {method_str:<10} {route['path']}")
        lines.append("")
        lines.append(SYSTEM_PROMPT_FOOTER.rstrip())
        prompt = "\n".join(lines)
        _PROMPT_CACHE[key] = prompt
        return prompt


def _dynamic_backend_status() -> dict[str, Any]:
    """Backend-aware default-model + available-models, refreshed on every call."""
    if COPILOT_BACKEND == "mlx":
        # 1s is too tight under load — mlx_lm.server can briefly stall when
        # generating, which caused the panel to flicker into "no models loaded"
        # state and re-fire the setup wizard. 4s is still well under the UI's
        # capabilities poll cadence.
        probe = _cached_probe_mlx_server(timeout=4.0)
        available = list(probe["models"])
        default = available[0] if available else COPILOT_DEFAULT_MODEL
        if not probe["reachable"]:
            from services.copilot_lifecycle import copilot_setup_message
            warning = copilot_setup_message(COPILOT_BACKEND)
        elif not available:
            warning = "mlx_lm.server is reachable but has not reported a loaded model yet."
        else:
            warning = None
        return {
            "default_model": default,
            "available_models": available,
            "model_warning": warning,
            "mlx_reachable": bool(probe["reachable"]),
            "mlx_probe_error": probe.get("error"),
            # copilot_ready=true means "this client can fire a chat request
            # right now and expect tokens back". The tutorial flow uses this
            # to decide whether to show an install modal or just start.
            "copilot_ready": len(available) > 0,
        }
    available = list_ollama_models(timeout=1.0)
    default, warning = resolve_ollama_model(COPILOT_DEFAULT_MODEL, available)
    return {
        "default_model": default,
        "available_models": available,
        "model_warning": warning,
        "copilot_ready": len(available) > 0,
    }


_LOCAL_COPILOT_PROBLEM: list = []


def local_copilot_problem() -> Optional[str]:
    """Why this machine can't run the local (MLX) Copilot model, or None.

    Fixed for the life of the process (the OS, CPU and Python don't change),
    so it's computed once; the capabilities poll stays cheap.
    """
    if not _LOCAL_COPILOT_PROBLEM:
        try:
            from services.copilot_lifecycle import mlx_host_problem
            _LOCAL_COPILOT_PROBLEM.append(mlx_host_problem())
        except Exception:
            _LOCAL_COPILOT_PROBLEM.append(None)
    return _LOCAL_COPILOT_PROBLEM[0]


def build_copilot_api_capabilities(app) -> dict[str, Any]:
    """Capabilities snapshot for the UI: route table, available models, system prompt."""
    key = id(app)
    cached = _CAPABILITIES_CACHE.get(key)
    if cached is not None:
        # Refresh dynamic backend bits + model recommendations without rebuilding routes.
        # IMPORTANT: re-emit `backend` on every call because set_backend() can flip
        # COPILOT_BACKEND at runtime — the cached snapshot was frozen at first call.
        return {
            **cached,
            "backend": COPILOT_BACKEND,
            "mlx_url": _mlx_chat_url(),
            "mlx_models_url": _mlx_models_url(),
            **_dynamic_backend_status(),
            "model_registry": recommend_models_for_host(),
            "local_copilot_problem": local_copilot_problem(),
        }
    routes = _safe_routes(app)
    notes = [
        "Copilot can call any same-origin /api route in the safe catalog after user review.",
        "File picker, upload, S3, process-spawn, and shutdown routes are intentionally blocked.",
    ]
    snapshot = {
        "success": True,
        "safe_methods": sorted(COPILOT_API_METHODS),
        "routes": routes,
        "allowed_count": sum(1 for r in routes if r["copilot_allowed"]),
        "blocked_count": sum(1 for r in routes if not r["copilot_allowed"]),
        "notes": notes,
        "system_prompt": build_copilot_system_prompt(app),
        "backend": COPILOT_BACKEND,
        "ollama_url": COPILOT_OLLAMA_URL,
        "ollama_tags_url": COPILOT_OLLAMA_TAGS_URL,
        "mlx_url": _mlx_chat_url(),
        "mlx_models_url": _mlx_models_url(),
        "keep_alive": COPILOT_OLLAMA_KEEP_ALIVE,
    }
    _CAPABILITIES_CACHE[key] = snapshot
    return {
        **snapshot,
        **_dynamic_backend_status(),
        "model_registry": recommend_models_for_host(),
        "local_copilot_problem": local_copilot_problem(),
    }


# ─────────────────────────────────────────────────────────────────────
# Validation / normalization
# ─────────────────────────────────────────────────────────────────────

def _safe_int(value: Any, fallback: Optional[int] = None) -> Optional[int]:
    try:
        if value is None:
            return fallback
        return int(round(float(str(value).replace(",", ""))))
    except Exception:
        return fallback


def _truncate_label(value: Any, max_chars: Optional[int] = None) -> str:
    text = str(value or "")
    limit = max_chars or COPILOT_LABEL_MAX_CHARS
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 18)].rstrip() + f"... (+{len(text) - limit} chars)"


# A gene named as a place ("at eve", "to hb", "the Pax6 TSS"); bare words like
# "run" or "en" (also Drosophila genes) don't count.
_GENE_PLACE_BEFORE = re.compile(r"\b(?:at|near|around|to|on|in|for|over|of|go\s+to|show\s+me|zoom\s+(?:in\s+)?(?:to|on))\s+(?:the\s+)?([A-Za-z][\w.\-]{1,24})\b", re.I)
_GENE_PLACE_AFTER = re.compile(r"\b([A-Za-z][\w.\-]{1,24})\s+(?:gene|locus|tss|promoter|enhancer|region)\b", re.I)
_NOT_GENES = {"the", "this", "that", "here", "there", "it", "them", "my", "a", "an", "all", "each", "every", "view",
              "reads", "read", "peaks", "peak", "panel", "clusters", "cluster", "top", "once", "first", "next", "same",
              "run", "en", "me", "you", "which", "what", "one", "two", "both", "order", "time", "detail", "sample"}


def ensure_named_gene_navigation(state, text: str, context: Optional[dict[str, Any]],
                                 plan: dict[str, Any]) -> dict[str, Any]:
    """Go to a gene the user names as a place when it isn't in view and the plan doesn't navigate.

    Small models often answer "how do I cluster reads at Pax6?" with the right
    walk but no navigation; the gene is resolved against the loaded GTF, so a
    word that isn't a gene there never triggers it.
    """
    actions = list(plan.get("actions") or [])
    if any(a.get("type") in ("navigate_gene", "navigate_region") for a in actions):
        return plan
    candidates = [m.group(1) for m in _GENE_PLACE_BEFORE.finditer(text or "")]
    candidates += [m.group(1) for m in _GENE_PLACE_AFTER.finditer(text or "")]
    for word in candidates:
        if word.lower() in _NOT_GENES:
            continue
        gene = _resolve_gene(state, word)
        if not gene:
            continue
        ctx = context or {}
        chrom, start, end = ctx.get("chrom"), ctx.get("start"), ctx.get("end")
        from utils.chrom import normalize_chrom_name
        in_view = (chrom and normalize_chrom_name(str(chrom)) == normalize_chrom_name(gene["chrom"])
                   and isinstance(start, (int, float)) and isinstance(end, (int, float))
                   and gene["start"] < end and gene["end"] > start)
        if in_view:
            return plan
        nav = {"type": "navigate_gene", "gene": gene["name"], "padding_bp": 5000}
        return {**plan, "actions": [nav, *actions]}
    return plan


def _resolve_gene(state, query: str) -> Optional[dict[str, Any]]:
    """Look up a gene symbol exactly in the loaded GTF. Returns None on miss."""
    if not query or not getattr(state, "gtf_data", None):
        return None
    tx_df = state.gtf_data.get("transcripts")
    if tx_df is None or tx_df.empty or "gene_name" not in tx_df.columns:
        return None
    name = str(query).strip()
    if not name:
        return None
    matches = tx_df[tx_df["gene_name"].astype(str) == name]
    if matches.empty and "gene_id" in tx_df.columns:
        matches = tx_df[tx_df["gene_id"].astype(str) == name]
    if matches.empty:
        lower = name.lower()
        ci = tx_df[tx_df["gene_name"].astype(str).str.lower() == lower]
        if ci.empty:
            return None
        matches = ci
    row = matches.iloc[0]
    start = int(row["start"])
    end = int(row["end"])
    strand = str(row.get("strand", "+") or "+")
    tss = start if strand == "+" else end - 1  # ends are exclusive
    gene_name = str(row.get("gene_name", name) or name)
    gene_id = str(row.get("gene_id", gene_name) or gene_name)
    return {
        "id": gene_id,
        "name": gene_name,
        "chrom": str(row["chrom"]),
        "start": min(start, end),
        "end": max(start, end),
        "strand": strand,
        "tss": int(tss),
    }


def _resolve_tss_relative(
    state,
    action: dict[str, Any],
    *,
    default_width_bp: int = 80,
) -> tuple[Optional[dict[str, Any]], list[str]]:
    """If action specifies relative_to_gene + offset_bp, compute strand-aware coords.

    Returns (resolved, warnings). resolved is None when the action does not use
    the relative form. If the relative form is requested but the gene cannot be
    resolved, returns ({}, [warning]) so the caller skips the action.
    """
    gene_query = action.get("relative_to_gene") or action.get("gene_name")
    offset_raw = action.get("offset_bp")
    if not gene_query or offset_raw is None:
        return None, []
    offset = _safe_int(offset_raw)
    if offset is None:
        return {}, [f"offset_bp '{offset_raw}' is not an integer."]
    gene = _resolve_gene(state, str(gene_query))
    if not gene:
        return {}, [f"Gene '{gene_query}' was not found in the loaded GTF."]
    tss = int(gene["tss"])
    strand = gene.get("strand") or "+"
    # Transcription-oriented: + = downstream of TSS in the read direction.
    pos = tss + offset if strand != "-" else tss - offset
    width = max(1, _safe_int(action.get("width_bp"), default_width_bp) or default_width_bp)
    # A half-open window of exactly `width` bases centred on pos (odd widths
    # included); only the contig start clips it.
    start = int(pos) - width // 2
    end = start + width
    return {
        "gene": gene,
        "chrom": gene["chrom"],
        "position": int(pos),
        "start": max(0, start),
        "end": end,
        "offset_bp": int(offset),
        "width_bp": int(width),
    }, []


def _explicit_region(action: dict[str, Any], context: Optional[dict[str, Any]], *, allow_context: bool = True) -> tuple[Optional[dict[str, Any]], list[str]]:
    """Read explicit chrom/start/end and validate they look like genomic coords."""
    chrom = str(action.get("chrom") or action.get("chromosome") or "").strip()
    if not chrom and allow_context:
        chrom = str((context or {}).get("chrom") or "").strip()
    start = _safe_int(action.get("start"))
    end = _safe_int(action.get("end"))
    if start is None and allow_context:
        start = _safe_int((context or {}).get("start"))
    if end is None and allow_context:
        end = _safe_int((context or {}).get("end"))
    if not chrom or start is None or end is None:
        return None, []
    if start < 0 or end < 0:
        return None, [
            f"Rejected coordinates {chrom}:{start}-{end}: genomic coordinates must be non-negative. "
            "For TSS-relative targets use relative_to_gene + offset_bp instead of negative coords."
        ]
    if end <= start:
        return None, [f"Rejected coordinates {chrom}:{start}-{end}: end must be greater than start."]
    return {
        "chrom": chrom,
        "start": int(start),
        "end": int(end),
        "position": _safe_int(action.get("position"), (start + end) // 2),
    }, []


_HTTP_METHODS = ("get", "post", "put", "delete", "patch")


def _rewrite_raw_http_action(action: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Detect free-form 'POST /api/foo' shapes the model sometimes emits as
    a step and rewrite them to the typed `api_call` action.

    Three common malformed shapes we've seen in eval logs:
      {type: "POST", path: "/api/foo", body: {...}}
      {type: "POST /api/foo", body: {...}}
      {action: "POST /api/foo"}  / {step: "POST /api/foo"}

    Returns the rewritten dict, or None if the action doesn't look like
    a raw HTTP step. The caller then routes the rewritten action through
    the existing `api_call` validator (which enforces the safe-route
    allowlist) so we get the safety check for free.
    """
    type_raw = str(action.get("type") or action.get("action") or action.get("step") or "").strip()
    if not type_raw:
        return None
    lower = type_raw.lower()

    # Case 1: type is just a verb ("POST"), path lives in the path field.
    if lower in _HTTP_METHODS:
        path = str(action.get("path") or "").strip()
        if path.startswith("/api/"):
            return {
                "type": "api_call",
                "method": lower.upper(),
                "path": path,
                "body": action.get("body"),
                "label": action.get("label") or f"{lower.upper()} {path}",
            }

    # Case 2: type contains both verb + path ("POST /api/foo").
    parts = type_raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() in _HTTP_METHODS and parts[1].startswith("/api/"):
        return {
            "type": "api_call",
            "method": parts[0].upper(),
            "path": parts[1].strip(),
            "body": action.get("body"),
            "label": action.get("label") or type_raw,
        }

    return None


def _normalize_action(state, action: Any, *, context: Optional[dict[str, Any]]) -> tuple[Optional[dict[str, Any]], list[str]]:
    if not isinstance(action, dict):
        return None, ["Model emitted a non-object action; skipped it."]
    # Rewrite raw "POST /api/..." steps to the typed api_call shape BEFORE
    # type-dispatch so the safe-route allowlist applies. The model
    # frequently emits these as substitutes for typed actions and they
    # otherwise fall through to "unsupported action type" and get dropped
    # silently. After this rewrite they either run (allowed routes) or
    # surface a clear "blocked: <reason>" warning.
    rewritten = _rewrite_raw_http_action(action)
    if rewritten is not None:
        action = rewritten
    action_type = str(action.get("type") or action.get("action") or "").strip().lower()
    aliases = {
        "goto": "navigate_region",
        "goto_region": "navigate_region",
        "go_to_region": "navigate_region",
        "goto_gene": "navigate_gene",
        "go_to_gene": "navigate_gene",
        "lock_peaks": "set_peaks_locked",
        "unlock_peaks": "set_peaks_locked",
        "motif_overlaps": "query_motif_overlaps",
        "query_motifs": "query_motif_overlaps",
        "cluster_peaks": "cluster_selected_peaks",
        "cluster_selected": "cluster_selected_peaks",
        "cluster_gene_tss": "cluster_peak_at_gene_tss",
        "cluster_tss_peak": "cluster_peak_at_gene_tss",
        "cluster_peak_at_tss": "cluster_peak_at_gene_tss",
        "show_strand": "set_panel_strand",
        "filter_strand": "set_panel_strand",
        "split_by_strand": "split_panel_by_strand",
        "split_strands": "split_panel_by_strand",
        "copy_panel": "open_panel_copy",
        "duplicate_panel": "open_panel_copy",
        "add_panel_copy": "open_panel_copy",
        "link_panel": "set_panel_linked",
        "unlink_panel": "set_panel_linked",
        "go_to_reads": "go_to_top_locus",
        "next_top_locus": "go_to_top_locus",
        "zoom": "zoom_view",
        "pan": "pan_view",
        "open_sidebar_section": "open_sidebar",
        "your_turn": "try_it",
    }
    raw_type = action_type
    action_type = aliases.get(action_type, action_type)
    warnings: list[str] = []

    # Tutorial actions (explain, try_it, open_sidebar, close_panel, zoom/pan).
    teach = copilot_tutorial.normalize_teach_action(action_type, action)
    if teach is not copilot_tutorial.NOT_TEACH:
        return teach

    if action_type == "navigate_gene":
        gene_name = str(action.get("gene") or action.get("name") or "").strip()
        if not gene_name:
            return None, ["Model requested gene navigation without a gene name; skipped."]
        gene = _resolve_gene(state, gene_name)
        if not gene:
            return None, [f"Gene '{gene_name}' was not found in the loaded GTF."]
        padding = max(1, _safe_int(action.get("padding_bp", action.get("padding")), 5000) or 5000)
        return {
            "type": "navigate_region",
            "chrom": gene["chrom"],
            "start": max(0, gene["start"] - padding),
            "end": gene["end"] + padding,
            "label": str(action.get("label") or f"{gene['name']} +/- {padding:,} bp"),
            "gene": gene,
            "padding_bp": padding,
        }, warnings

    if action_type == "navigate_region":
        chrom = str(action.get("chrom") or action.get("chromosome") or "").strip()
        start = _safe_int(action.get("start"))
        end = _safe_int(action.get("end"))
        if not chrom or start is None or end is None:
            return None, ["Model requested region navigation without chrom/start/end; skipped."]
        if end < start:
            start, end = end, start
        return {
            "type": "navigate_region",
            "chrom": chrom,
            "start": max(0, start),
            "end": max(start + 1, end),
            "label": str(action.get("label") or f"{chrom}:{start}-{end}"),
        }, warnings

    if action_type == "scan_peaks":
        return {"type": "scan_peaks", "scope": str(action.get("scope") or "enabled_rules")}, warnings

    if action_type == "set_peaks_locked":
        return {"type": "set_peaks_locked", "locked": bool(action.get("locked"))}, warnings

    if action_type == "add_region_label_rule":
        relative, rel_warnings = _resolve_tss_relative(state, action, default_width_bp=80)
        if rel_warnings:
            return None, rel_warnings
        if relative:
            chrom = relative["chrom"]
            start = relative["start"]
            end = relative["end"]
            position = relative["position"]
            gene = relative["gene"]
            offset = relative["offset_bp"]
            default_region_label = f"{gene['name']} TSS {offset:+d}"
            default_label = str(action.get("label") or f"{gene['name']} TSS {offset:+d} bp")
        else:
            explicit, exp_warnings = _explicit_region(action, context)
            if exp_warnings:
                return None, exp_warnings
            if explicit is None:
                return None, [
                    "Model requested a label rule without resolvable coordinates; "
                    "use relative_to_gene + offset_bp for TSS-relative labels."
                ]
            chrom = explicit["chrom"]
            start = explicit["start"]
            end = explicit["end"]
            position = explicit["position"] or (start + end) // 2
            default_region_label = f"{chrom}:{start}-{end}"
            default_label = str(action.get("label") or "Copilot label")
        size_max_raw = action.get("size_max")
        size_max = _safe_int(size_max_raw) if size_max_raw is not None else None
        return {
            "type": "add_region_label_rule",
            "chrom": chrom,
            "start": start,
            "end": end,
            "position": position,
            "color": str(action.get("color") or "#22c55e"),
            "color_name": str(action.get("color_name") or action.get("color") or "custom"),
            "layer": str(action.get("layer") or "tf"),
            "size_min": _safe_int(action.get("size_min"), 1) or 1,
            "size_max": size_max,
            "label": default_label,
            "region_label": str(action.get("region_label") or default_label or default_region_label),
            # Kept so a follow-up turn ("make that label red") still knows the gene.
            **({"relative_to_gene": gene["name"], "offset_bp": offset} if relative else {}),
        }, warnings

    if action_type == "select_peak_at":
        relative, rel_warnings = _resolve_tss_relative(state, action, default_width_bp=2)
        if rel_warnings:
            return None, rel_warnings
        if relative:
            chrom = relative["chrom"]
            position = relative["position"]
            label = str(action.get("label") or f"{relative['gene']['name']} TSS {relative['offset_bp']:+d} bp")
        else:
            chrom = str(action.get("chrom") or action.get("chromosome") or (context or {}).get("chrom") or "").strip()
            position = _safe_int(action.get("position"))
            if not chrom or position is None:
                return None, ["Model requested peak selection without chrom/position; skipped."]
            if position < 0:
                return None, [
                    f"Rejected position {chrom}:{position}: genomic coordinates must be non-negative. "
                    "Use relative_to_gene + offset_bp for TSS-relative selection."
                ]
            label = str(action.get("label") or "nearest peak")
        return {
            "type": "select_peak_at",
            "chrom": chrom,
            "position": int(position),
            "tolerance_bp": _safe_int(action.get("tolerance_bp"), 500) or 500,
            "label": label,
        }, warnings

    if action_type == "cluster_selected_peaks":
        return {
            "type": "cluster_selected_peaks",
            "label": str(action.get("label") or "selected peak(s)"),
        }, warnings

    if action_type == "cluster_peak_at_gene_tss":
        gene_name = str(action.get("gene") or action.get("gene_name") or "").strip()
        gene: Optional[dict[str, Any]] = None
        if gene_name:
            gene = _resolve_gene(state, gene_name)
            if not gene:
                return None, [f"Gene '{gene_name}' was not found in the loaded GTF."]
        chrom = str(action.get("chrom") or action.get("chromosome") or (gene or {}).get("chrom") or (context or {}).get("chrom") or "").strip()
        tss = _safe_int(action.get("tss"), _safe_int((gene or {}).get("tss")))
        if not chrom or tss is None:
            return None, ["Model requested TSS-peak clustering without a resolved chrom/TSS; skipped."]
        return {
            "type": "cluster_peak_at_gene_tss",
            "gene": gene,
            "gene_name": (gene or {}).get("name") or gene_name,
            "chrom": chrom,
            "tss": tss,
            "padding_bp": _safe_int(action.get("padding_bp", action.get("padding")), 5000) or 5000,
            "tolerance_bp": _safe_int(action.get("tolerance_bp"), 500) or 500,
        }, warnings

    if action_type == "query_motif_overlaps":
        relative, rel_warnings = _resolve_tss_relative(state, action, default_width_bp=80)
        if rel_warnings:
            return None, rel_warnings
        if relative:
            return {
                "type": "query_motif_overlaps",
                "chrom": relative["chrom"],
                "start": relative["start"],
                "end": relative["end"],
                "label": str(action.get("label") or f"{relative['gene']['name']} TSS {relative['offset_bp']:+d} bp"),
            }, warnings
        explicit, exp_warnings = _explicit_region(action, context)
        if exp_warnings:
            return None, exp_warnings
        if explicit is None:
            return None, ["Model requested motif overlaps without a target region; skipped."]
        return {
            "type": "query_motif_overlaps",
            "chrom": explicit["chrom"],
            "start": explicit["start"],
            "end": explicit["end"],
            "label": str(action.get("label") or "target region"),
        }, warnings

    if action_type == "api_call":
        method = str(action.get("method") or "GET").upper()
        path = str(action.get("path") or "").strip()
        body = action.get("body")
        allowed, reason = is_copilot_api_call_allowed(method, path, body)
        normalized = {
            "type": "api_call",
            "method": method,
            "path": path,
            "body": body,
            "allowed": allowed,
            "blocked_reason": reason,
            "label": str(action.get("label") or f"{method} {path}"),
        }
        if not allowed and reason:
            warnings.append(reason)
        return normalized, warnings

    # Tutorial-friendly UI actions — these run frontend-side (opening panels,
    # synthesizing rule edits) and let the spotlight find the right control.
    # They're additive to api_call: anything that needs raw HTTP can still use
    # api_call, but these are preferred so the user actually sees what changed.
    if action_type == "open_panel":
        panel_type = str(action.get("panel_type") or action.get("panelType") or "").strip()
        if not panel_type:
            return None, ["open_panel requires a panel_type (e.g. cluster-features, primer-design, peak-detection)."]
        return {
            "type": "open_panel",
            "panel_type": panel_type,
            "tab": str(action.get("tab") or "").strip() or None,
            "label": str(action.get("label") or f"Open {panel_type} panel"),
        }, warnings

    if action_type == "add_cluster_rule":
        name = str(action.get("name") or "New cluster rule").strip()
        terms = action.get("terms") or []
        scope = action.get("scope") or {"kind": "selectedPeaks"}
        if not isinstance(terms, list) or not terms:
            return None, ["add_cluster_rule requires at least one term in terms."]
        return {
            "type": "add_cluster_rule",
            "name": name,
            "scope": scope,
            "terms": terms,
            "label": str(action.get("label") or f"Add cluster rule \"{name}\""),
        }, warnings

    if action_type == "add_sort_rule":
        name = str(action.get("name") or "New sort rule").strip()
        terms = action.get("terms") or []
        scope = action.get("scope") or {"kind": "selectedPeaks"}
        metric = str(action.get("metric") or "count").strip().lower()
        descending = bool(action.get("descending", True))
        if not isinstance(terms, list) or not terms:
            return None, ["add_sort_rule requires at least one term in terms."]
        if metric not in {"count", "occupancy", "rate", "accessibility"}:
            return None, [f"add_sort_rule metric must be count/occupancy/rate/accessibility (got '{metric}')."]
        return {
            "type": "add_sort_rule",
            "name": name, "scope": scope, "terms": terms,
            "metric": metric, "descending": descending,
            "label": str(action.get("label") or f"Add sort rule \"{name}\""),
        }, warnings

    if action_type == "add_filter_rule":
        name = str(action.get("name") or "New filter rule").strip()
        terms = action.get("terms") or []
        scope = action.get("scope") or {"kind": "selectedPeaks"}
        metric = str(action.get("metric") or "count").strip().lower()
        operator = str(action.get("operator") or "gte").strip().lower()
        threshold = action.get("threshold", 1)
        if not isinstance(terms, list) or not terms:
            return None, ["add_filter_rule requires at least one term in terms."]
        if metric not in {"count", "occupancy", "rate", "accessibility"}:
            return None, [f"add_filter_rule metric must be count/occupancy/rate/accessibility (got '{metric}')."]
        if operator not in {"gt", "gte", "lt", "lte", "eq"}:
            return None, [f"add_filter_rule operator must be gt/gte/lt/lte/eq (got '{operator}')."]
        try:
            threshold_f = float(threshold)
        except (TypeError, ValueError):
            return None, [f"add_filter_rule threshold must be numeric (got '{threshold}')."]
        return {
            "type": "add_filter_rule",
            "name": name, "scope": scope, "terms": terms,
            "metric": metric, "operator": operator, "threshold": threshold_f,
            "label": str(action.get("label") or f"Add filter rule \"{name}\""),
        }, warnings

    if action_type in {"hide_cluster", "focus_cluster", "dissolve_cluster"}:
        cluster_id_raw = action.get("cluster_id", action.get("clusterId"))
        try:
            cluster_id = int(cluster_id_raw)
        except (TypeError, ValueError):
            return None, [f"{action_type} requires a numeric cluster_id."]
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": action_type,
            "cluster_id": cluster_id,
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or f"{action_type.replace('_', ' ').title()} {cluster_id}"),
        }, warnings

    # ── Layer / display toggles ──────────────────────────────────────
    if action_type == "toggle_layer":
        layer = str(action.get("layer") or "").strip()
        if not layer:
            return None, ["toggle_layer requires a layer name (e.g. nuc, tf, fire)."]
        enabled = action.get("enabled")
        if enabled is None:
            enabled = action.get("visible")
        return {
            "type": "toggle_layer",
            "layer": layer,
            "enabled": bool(enabled) if enabled is not None else True,
            "label": str(action.get("label") or f"{'Show' if enabled is not False else 'Hide'} {layer} layer"),
        }, warnings

    if action_type in {"set_quality_filter", "set_min_footprints"}:
        try:
            value = float(action.get("value", action.get("threshold", 0)))
        except (TypeError, ValueError):
            return None, [f"{action_type} requires a numeric value."]
        return {
            "type": action_type,
            "value": value,
            "label": str(action.get("label") or f"{action_type.replace('_', ' ').title()} = {value}"),
        }, warnings

    if action_type == "set_spanning_only":
        return {
            "type": "set_spanning_only",
            "enabled": bool(action.get("enabled", action.get("spanning", True))),
            "label": str(action.get("label") or "Toggle spanning-only filter"),
        }, warnings

    # ── Color rules ─────────────────────────────────────────────────
    if action_type in {"remove_color_rule", "toggle_color_rule"}:
        rule_id = action.get("rule_id") or action.get("ruleId") or action.get("id")
        rule_name = action.get("rule_name") or action.get("ruleName") or action.get("name")
        if not rule_id and not rule_name:
            return None, [f"{action_type} needs a rule_id or rule_name."]
        normalized = {
            "type": action_type,
            "rule_id": str(rule_id) if rule_id else None,
            "rule_name": str(rule_name) if rule_name else None,
            "label": str(action.get("label") or f"{action_type.replace('_', ' ').title()} \"{rule_name or rule_id}\""),
        }
        if action_type == "toggle_color_rule":
            normalized["enabled"] = bool(action.get("enabled", True))
        return normalized, warnings

    if action_type == "clear_color_rules":
        return {"type": "clear_color_rules",
                "label": str(action.get("label") or "Clear all color rules")}, warnings

    # ── Tracks ──────────────────────────────────────────────────────
    if action_type == "add_track_from_url":
        path = str(action.get("path") or action.get("url") or "").strip()
        if not path:
            return None, ["add_track_from_url needs path or url."]
        scheme = urlsplit(path).scheme.lower()
        if scheme not in {"http", "https", "s3", "ucsc"}:
            return None, ["add_track_from_url only accepts remote http(s), s3, or ucsc URLs."]
        return {
            "type": "add_track_from_url",
            "path": path,
            "label": str(action.get("label") or f"Add track from {path}"),
            "track_label": str(action.get("track_label") or action.get("trackLabel") or "") or None,
            "render_mode": str(action.get("render_mode") or action.get("renderMode") or "") or None,
        }, warnings

    if action_type == "remove_track":
        idx = action.get("track_index", action.get("trackIndex"))
        try:
            idx_int = int(idx)
        except (TypeError, ValueError):
            return None, ["remove_track needs a numeric track_index."]
        return {
            "type": "remove_track",
            "track_index": idx_int,
            "label": str(action.get("label") or f"Remove track #{idx_int}"),
        }, warnings

    if action_type == "set_track_filter":
        idx = action.get("track_index", action.get("trackIndex"))
        names = action.get("filter_names") or action.get("filterNames") or []
        try:
            idx_int = int(idx)
        except (TypeError, ValueError):
            return None, ["set_track_filter needs a numeric track_index."]
        if not isinstance(names, list):
            return None, ["set_track_filter filter_names must be a list of strings."]
        return {
            "type": "set_track_filter",
            "track_index": idx_int,
            "filter_names": [str(n) for n in names],
            "label": str(action.get("label") or f"Filter track #{idx_int} to {len(names)} name(s)"),
        }, warnings

    # ── Apply saved rules / cluster ops ──────────────────────────────
    if action_type in {"apply_cluster_rule", "apply_sort_rule", "apply_filter_rule"}:
        rule_id = action.get("rule_id") or action.get("ruleId") or action.get("id")
        rule_name = action.get("rule_name") or action.get("ruleName") or action.get("name")
        if not rule_id and not rule_name:
            return None, [f"{action_type} needs a rule_id or rule_name."]
        normalized = {
            "type": action_type,
            "rule_id": str(rule_id) if rule_id else None,
            "rule_name": str(rule_name) if rule_name else None,
            "label": str(action.get("label") or f"Apply {action_type.replace('apply_', '').replace('_', ' ')} \"{rule_name or rule_id}\""),
        }
        if action_type == "apply_filter_rule":
            normalized["pin"] = bool(action.get("pin", True))
        return normalized, warnings

    if action_type == "select_cluster_reads":
        try:
            cluster_id = int(action.get("cluster_id", action.get("clusterId")))
        except (TypeError, ValueError):
            return None, ["select_cluster_reads needs a numeric cluster_id."]
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "select_cluster_reads",
            "cluster_id": cluster_id,
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or f"Select all reads in cluster {cluster_id}"),
        }, warnings

    if action_type == "auto_cull_clusters":
        # Thresholds only when asked for: otherwise the browser's own Merge
        # settings (Clusters -> Projection) apply.
        normalized = {"type": "auto_cull_clusters",
                      "label": str(action.get("label") or "Merge similar clusters")}
        for key, alias, low, high in (("min_fraction", "minFraction", 0.0, 0.5),
                                      ("max_cosine_similarity", "maxCosineSimilarity", 0.5, 1.0)):
            value = action.get(key, action.get(alias))
            if value is not None:
                try:
                    normalized[key] = min(high, max(low, float(value)))
                except (TypeError, ValueError):
                    warnings.append(f"Ignored {key}={value!r}: not a number")
        return normalized, warnings

    # ── Annotations / Capture ───────────────────────────────────────
    if action_type == "toggle_annotation_visibility":
        name = str(action.get("name") or action.get("annotation_type") or "").strip()
        if not name:
            return None, ["toggle_annotation_visibility needs an annotation type name."]
        return {
            "type": "toggle_annotation_visibility",
            "name": name,
            "enabled": bool(action.get("enabled", True)),
            "label": str(action.get("label") or f"Toggle {name} annotations"),
        }, warnings

    if action_type == "add_capture_region":
        chrom = str(action.get("chrom") or "").strip()
        start_val = _safe_int(action.get("start"), None)
        end_val = _safe_int(action.get("end"), None)
        if not chrom or start_val is None or end_val is None:
            return None, ["add_capture_region needs chrom + start + end."]
        return {
            "type": "add_capture_region",
            "chrom": chrom, "start": start_val, "end": end_val,
            "region_label": str(action.get("region_label") or action.get("label_text") or ""),
            "label": str(action.get("label") or f"Capture {chrom}:{start_val}-{end_val}"),
        }, warnings

    if action_type == "clear_capture_regions":
        return {"type": "clear_capture_regions",
                "label": str(action.get("label") or "Clear all capture regions")}, warnings

    # ── Footprint Analysis ──────────────────────────────────────────
    if action_type == "analyze_footprints":
        return {
            "type": "analyze_footprints",
            "label": str(action.get("label") or "Run Footprint Analysis"),
        }, warnings

    if action_type == "add_footprint_group":
        name = str(action.get("name") or "Footprint class").strip()
        layer = str(action.get("layer") or "tf").strip() or "tf"
        return {
            "type": "add_footprint_group",
            "name": name, "layer": layer,
            "size_min": _safe_int(action.get("size_min"), 1),
            "size_max": _safe_int(action.get("size_max"), 89),
            "color": str(action.get("color") or "#22c55e"),
            "label": str(action.get("label") or f"Add footprint class \"{name}\""),
        }, warnings

    if action_type == "remove_footprint_group":
        group_id = action.get("group_id") or action.get("groupId") or action.get("id")
        group_name = action.get("name") or action.get("group_name")
        if not group_id and not group_name:
            return None, ["remove_footprint_group needs a group_id or name."]
        return {
            "type": "remove_footprint_group",
            "group_id": str(group_id) if group_id else None,
            "group_name": str(group_name) if group_name else None,
            "label": str(action.get("label") or f"Remove footprint class \"{group_name or group_id}\""),
        }, warnings

    # ── Reproducibility settings ────────────────────────────────────
    if action_type == "set_cluster_method":
        method_raw = str(action.get("method") or "").strip().lower()
        # Normalize the natural-language variants the model emits to the
        # actual store IDs the frontend uses. Without aliasing, "k-means"
        # / "hierarchical" / "kmeans++" all hit the validator's strict
        # check and get rejected, even though they map to real cluster
        # methods.
        method_aliases = {
            "k-means": "kmeans",
            "k_means": "kmeans",
            "kmeans": "kmeans",
            "kmeans++": "minibatch",
            "k-means++": "minibatch",
            "minibatch": "minibatch",
            "minibatch_kmeans": "minibatch",
            "hierarchical": "agglom",
            "hierarchical_clustering": "agglom",
            "agglomerative": "agglom",
            "agglomerative_clustering": "agglom",
            "agglom": "agglom",
            "hdbscan": "hdbscan",
            "density": "hdbscan",
            "density_based": "hdbscan",
            "combinatorial": "combinatorial",
        }
        method = method_aliases.get(method_raw, method_raw)
        valid_methods = {"kmeans", "minibatch", "agglom", "hdbscan", "combinatorial"}
        if method not in valid_methods:
            return None, [
                f"set_cluster_method requires one of {sorted(valid_methods)} "
                f"(got '{method_raw}'). Aliases like 'k-means' → 'kmeans' and "
                "'hierarchical' → 'agglom' are accepted."
            ]
        return {
            "type": "set_cluster_method", "method": method,
            "label": str(action.get("label") or f"Cluster method = {method}"),
        }, warnings

    if action_type == "set_cluster_k":
        # Accept either "k" or natural-language variants the model uses
        # ("n_clusters", "num_clusters"). The frontend setter is just
        # setClusterK(integer) so as long as we parse an int in range
        # we're good.
        k_raw = action.get("k")
        if k_raw is None:
            k_raw = action.get("n_clusters") or action.get("num_clusters") or action.get("number_of_clusters")
        k = _safe_int(k_raw, None)
        if k is None or k < 2 or k > 20:
            return None, [f"set_cluster_k requires k in [2, 20] (got {action.get('k')})."]
        return {
            "type": "set_cluster_k", "k": k,
            "label": str(action.get("label") or f"k = {k}"),
        }, warnings

    if action_type == "set_accessibility_threshold":
        # Stored 0-100 in the UI's input, normalized to 0-1 by the executor.
        # Accept either form here so the model can emit "60" or "0.6".
        raw = action.get("value")
        if raw is None:
            raw = action.get("threshold") or action.get("percent")
        # A fraction (0.6) is a share, not 1%: convert before rounding to an int.
        try:
            as_float = float(str(raw).replace("%", "").strip()) if raw is not None else None
        except (TypeError, ValueError):
            as_float = None
        if as_float is not None and 0 < as_float <= 1 and "%" not in str(raw):
            val = int(round(as_float * 100))
        else:
            val = _safe_int(str(raw).replace("%", "") if raw is not None else None, None)
        if val is None or val < 5 or val > 95:
            return None, [f"set_accessibility_threshold requires value in [5, 95]% (got {raw!r})."]
        return {
            "type": "set_accessibility_threshold", "value": val,
            "label": str(action.get("label") or f"Accessibility threshold = {val}%"),
        }, warnings

    if action_type == "set_subnucleosomal_threshold":
        raw = action.get("value")
        if raw is None:
            raw = action.get("threshold") or action.get("bp")
        val = _safe_int(raw, None)
        if val is None or val < 50 or val > 150:
            return None, [f"set_subnucleosomal_threshold requires value in [50, 150] bp (got {raw!r})."]
        return {
            "type": "set_subnucleosomal_threshold", "value": val,
            "label": str(action.get("label") or f"Subnucleosomal threshold = {val} bp"),
        }, warnings

    if action_type == "set_sample_seed":
        seed = str(action.get("seed") or "").strip()
        if not seed:
            return None, ["set_sample_seed needs a seed string."]
        return {
            "type": "set_sample_seed", "seed": seed,
            "label": str(action.get("label") or f"Seed = {seed}"),
        }, warnings

    # ── Selection / reset ───────────────────────────────────────────
    if action_type == "clear_selected_peaks":
        return {"type": "clear_selected_peaks",
                "label": str(action.get("label") or "Clear selected peaks")}, warnings

    if action_type == "clear_selected_reads":
        return {"type": "clear_selected_reads",
                "label": str(action.get("label") or "Clear selected reads")}, warnings

    if action_type == "reset_view":
        return {"type": "reset_view",
                "label": str(action.get("label") or "Reset viewport to default")}, warnings

    if action_type in {"remove_cluster_rule", "remove_sort_rule", "remove_filter_rule"}:
        rule_id = action.get("rule_id") or action.get("ruleId")
        rule_name = action.get("rule_name") or action.get("ruleName") or action.get("name")
        if not rule_id and not rule_name:
            return None, [f"{action_type} needs a rule_id or rule_name."]
        return {
            "type": action_type,
            "rule_id": str(rule_id) if rule_id else None,
            "rule_name": str(rule_name) if rule_name else None,
            "label": str(action.get("label") or f"{action_type.replace('_', ' ').title()} \"{rule_name or rule_id}\""),
        }, warnings

    if action_type == "clear_filter":
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "clear_filter",
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or ("Clear filter" if not dataset_id else f"Clear filter on {dataset_id}")),
        }, warnings

    if action_type == "design_primers_for_region":
        chrom_raw = action.get("chrom")
        start_raw = action.get("start")
        end_raw = action.get("end")
        # Either all three coordinates or none (then default to viewport).
        provided = sum(1 for v in (chrom_raw, start_raw, end_raw) if v not in (None, ""))
        if 0 < provided < 3:
            return None, ["design_primers_for_region needs all of chrom/start/end or none (then defaults to viewport)."]
        mode = str(action.get("mode") or "standard").strip().lower()
        if mode not in {"standard", "dafc", "4c"}:
            return None, [f"design_primers_for_region mode must be standard/dafc/4c (got '{mode}')."]
        return {
            "type": "design_primers_for_region",
            "chrom": str(chrom_raw) if chrom_raw else None,
            "start": _safe_int(start_raw, None),
            "end": _safe_int(end_raw, None),
            "mode": mode,
            "label": str(action.get("label") or f"Design {mode} primers"),
        }, warnings

    # ── Dataset Layout panel (v2.11 merge) ──────────────────────────
    if action_type == "set_dataset_label":
        dataset_id = str(action.get("dataset_id") or action.get("datasetId") or "").strip()
        label_text = str(
            action.get("label_text") or action.get("new_label")
            or action.get("newLabel") or action.get("name") or ""
        ).strip()
        if not dataset_id or not label_text:
            return None, ["set_dataset_label needs dataset_id and a non-empty label_text."]
        return {
            "type": "set_dataset_label", "dataset_id": dataset_id, "label_text": label_text,
            "label": str(action.get("label") or f"Rename dataset to \"{label_text}\""),
        }, warnings

    if action_type == "merge_datasets":
        return {"type": "merge_datasets",
                "label": str(action.get("label") or "Merge selected datasets")}, warnings

    if action_type == "unmerge_dataset":
        return {"type": "unmerge_dataset",
                "label": str(action.get("label") or "Unmerge selected dataset")}, warnings

    if action_type == "link_datasets":
        ids = action.get("panel_ids") or action.get("panelIds") or action.get("dataset_ids") or []
        if not isinstance(ids, list) or len(ids) < 2:
            return None, ["link_datasets needs a list of at least two panel_ids."]
        return {
            "type": "link_datasets", "panel_ids": [str(i) for i in ids],
            "label": str(action.get("label") or f"Link {len(ids)} datasets"),
        }, warnings

    if action_type == "unlink_dataset":
        panel_id = str(
            action.get("panel_id") or action.get("panelId") or action.get("dataset_id") or ""
        ).strip()
        if not panel_id:
            return None, ["unlink_dataset needs a panel_id."]
        return {
            "type": "unlink_dataset", "panel_id": panel_id,
            "label": str(action.get("label") or f"Unlink dataset {panel_id}"),
        }, warnings

    # ── Cluster selection + merge (v2.11 merge) ─────────────────────
    if action_type == "toggle_cluster_selection":
        try:
            cluster_id = int(action.get("cluster_id", action.get("clusterId")))
        except (TypeError, ValueError):
            return None, ["toggle_cluster_selection needs a numeric cluster_id."]
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "toggle_cluster_selection", "cluster_id": cluster_id,
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or f"Toggle selection of cluster {cluster_id}"),
        }, warnings

    if action_type == "set_cluster_selection":
        ids = action.get("cluster_ids") or action.get("clusterIds") or []
        if not isinstance(ids, list) or not ids:
            return None, ["set_cluster_selection needs a non-empty cluster_ids list."]
        try:
            cluster_ids = [int(c) for c in ids]
        except (TypeError, ValueError):
            return None, ["set_cluster_selection cluster_ids must be integers."]
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "set_cluster_selection", "cluster_ids": cluster_ids,
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or f"Select {len(cluster_ids)} cluster(s)"),
        }, warnings

    if action_type == "clear_cluster_selection":
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "clear_cluster_selection",
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or "Clear cluster selection"),
        }, warnings

    if action_type == "merge_clusters":
        ids = action.get("dataset_ids") or action.get("datasetIds")
        dataset_ids = [str(i) for i in ids] if isinstance(ids, list) else None
        return {
            "type": "merge_clusters", "dataset_ids": dataset_ids,
            "label": str(action.get("label") or "Merge selected clusters"),
        }, warnings

    # ── Panels: DAF-seq strands, copies at other loci, best-covered loci ──
    if action_type == "set_panel_strand":
        raw = str(action.get("strand") or "both").strip().upper()
        strand = raw if raw in ("CT", "GA") else None
        if raw not in ("CT", "GA", "BOTH", "NONE", "ALL", ""):
            return None, [f"set_panel_strand needs strand CT, GA or both (got {action.get('strand')!r})."]
        return {
            "type": "set_panel_strand",
            "strand": strand or "both",
            "label": str(action.get("label") or (f"Show {strand}-strand reads only" if strand else "Show both strands")),
        }, warnings

    if action_type == "split_panel_by_strand":
        return {"type": "split_panel_by_strand",
                "label": str(action.get("label") or "Split the DAF-seq panel into CT | GA")}, warnings

    if action_type == "open_panel_copy":
        # No location: a linked copy that follows the main view. A gene or
        # explicit region: an unlinked copy there (another locus / haplotype).
        gene_name = str(action.get("gene") or "").strip()
        if gene_name:
            gene = _resolve_gene(state, gene_name)
            if not gene:
                return None, [f"Gene '{gene_name}' was not found in the loaded GTF."]
            padding = max(1, _safe_int(action.get("padding_bp", action.get("padding")), 5000) or 5000)
            return {"type": "open_panel_copy", "chrom": gene["chrom"], "start": max(0, gene["start"] - padding),
                    "end": gene["end"] + padding,
                    "label": str(action.get("label") or f"Copy of the panel at {gene['name']}")}, warnings
        if action.get("chrom") or action.get("chromosome"):
            region, region_warnings = _explicit_region(action, context, allow_context=False)
            if region is None:
                return None, region_warnings or ["open_panel_copy with a location needs chrom, start and end."]
            return {"type": "open_panel_copy", "chrom": region["chrom"], "start": region["start"], "end": region["end"],
                    "label": str(action.get("label") or f"Copy of the panel at {region['chrom']}:{region['start']:,}")}, warnings
        return {"type": "open_panel_copy",
                "label": str(action.get("label") or "Linked copy of the panel")}, warnings

    if action_type == "set_panel_linked":
        linked = action.get("linked", action.get("enabled"))
        if linked is None:
            linked = raw_type != "unlink_panel"
        return {"type": "set_panel_linked", "linked": bool(linked),
                "label": str(action.get("label") or ("Link the panel copy" if linked else "Unlink the panel copy"))}, warnings

    if action_type == "go_to_top_locus":
        return {"type": "go_to_top_locus",
                "label": str(action.get("label") or "Go to the next best-covered locus")}, warnings

    if action_type == "cluster_by_saved_footprints":
        return {"type": "cluster_by_saved_footprints",
                "label": str(action.get("label") or "Cluster reads by the saved footprints they carry")}, warnings

    if action_type == "set_cluster_order_lock":
        return {
            "type": "set_cluster_order_lock",
            "locked": bool(action.get("locked", action.get("enabled", True))),
            "label": str(action.get("label") or "Toggle cluster order lock"),
        }, warnings

    # ── Cluster trees / branches + dynamic reassignment (v2.12) ─────
    if action_type == "subcluster_clusters":
        ids = action.get("cluster_ids") or action.get("clusterIds") or []
        if isinstance(ids, (int, str)):
            ids = [ids]
        if not isinstance(ids, list) or not ids:
            return None, ["subcluster_clusters needs a non-empty cluster_ids list (the clusters to drill into)."]
        try:
            cluster_ids = [int(c) for c in ids]
        except (TypeError, ValueError):
            return None, ["subcluster_clusters cluster_ids must be integers."]
        dataset_id = action.get("dataset_id") or action.get("datasetId")
        return {
            "type": "subcluster_clusters", "cluster_ids": cluster_ids,
            "dataset_id": str(dataset_id) if dataset_id else None,
            "label": str(action.get("label") or f"Subcluster {len(cluster_ids)} cluster(s)"),
        }, warnings

    if action_type == "set_dynamic_clustering":
        return {
            "type": "set_dynamic_clustering",
            "enabled": bool(action.get("enabled", action.get("value", True))),
            "label": str(action.get("label") or "Toggle dynamic cluster reassignment"),
        }, warnings

    if action_type == "set_dynamic_overlap_mode":
        mode = str(action.get("mode") or "").strip().lower()
        valid_modes = {"conservative", "aggressive"}
        if mode not in valid_modes:
            return None, [f"set_dynamic_overlap_mode requires one of {sorted(valid_modes)} (got '{mode}')."]
        return {
            "type": "set_dynamic_overlap_mode", "mode": mode,
            "label": str(action.get("label") or f"Dynamic overlap: {mode}"),
        }, warnings

    if action_type == "switch_cluster_branch":
        name = str(action.get("name") or action.get("branch") or action.get("branch_name") or "").strip()
        if not name:
            return None, ["switch_cluster_branch needs the branch name to switch to."]
        return {
            "type": "switch_cluster_branch", "name": name,
            "label": str(action.get("label") or f"Switch to cluster branch \"{name}\""),
        }, warnings

    if action_type == "capture_cluster_branch":
        name = str(action.get("name") or action.get("branch_name") or "").strip()
        return {
            "type": "capture_cluster_branch",
            "name": name or None,
            "label": str(action.get("label") or (f"Save cluster branch \"{name}\"" if name else "Save current clustering as a branch")),
        }, warnings

    if action_type == "rename_cluster_branch":
        new_name = str(action.get("new_name") or action.get("newName") or action.get("to") or "").strip()
        if not new_name:
            return None, ["rename_cluster_branch needs new_name."]
        target = str(action.get("name") or action.get("branch_name") or "").strip()
        return {
            "type": "rename_cluster_branch",
            "name": target or None,  # None => rename the active branch
            "new_name": new_name,
            "label": str(action.get("label") or f"Rename cluster branch to \"{new_name}\""),
        }, warnings

    if action_type == "delete_cluster_branch":
        name = str(action.get("name") or action.get("branch_name") or "").strip()
        if not name:
            return None, ["delete_cluster_branch needs the branch name to delete."]
        return {
            "type": "delete_cluster_branch", "name": name,
            "label": str(action.get("label") or f"Delete cluster branch \"{name}\""),
        }, warnings

    # ── Read display controls (v2.11 merge) ─────────────────────────
    if action_type == "set_read_separator_mode":
        mode = str(action.get("mode") or "").strip().lower()
        valid_modes = {"auto", "fixed", "off"}
        if mode not in valid_modes:
            return None, [f"set_read_separator_mode requires one of {sorted(valid_modes)} (got '{mode}')."]
        return {
            "type": "set_read_separator_mode", "mode": mode,
            "label": str(action.get("label") or f"Read separators: {mode}"),
        }, warnings

    if action_type == "set_read_separator_min_height":
        val = _safe_int(action.get("value", action.get("height")), None)
        if val is None or val < 0 or val > 100:
            return None, ["set_read_separator_min_height needs a pixel value in [0, 100]."]
        return {
            "type": "set_read_separator_min_height", "value": val,
            "label": str(action.get("label") or f"Separator min height = {val}px"),
        }, warnings

    if action_type == "set_read_separator_width":
        val = _safe_int(action.get("value", action.get("width")), None)
        if val is None or val < 0 or val > 20:
            return None, ["set_read_separator_width needs a pixel value in [0, 20]."]
        return {
            "type": "set_read_separator_width", "value": val,
            "label": str(action.get("label") or f"Separator width = {val}px"),
        }, warnings

    if action_type == "set_fill_read_height":
        return {
            "type": "set_fill_read_height",
            "enabled": bool(action.get("enabled", action.get("value", True))),
            "label": str(action.get("label") or "Toggle fill read height"),
        }, warnings

    if action_type == "set_read_row_height":
        raw = action.get("value", action.get("height"))
        if isinstance(raw, str) and raw.strip().lower() == "auto":
            height: Any = "auto"
        else:
            height = _safe_int(raw, None)
            if height is None or height < 1 or height > 200:
                return None, ["set_read_row_height needs a pixel height in [1, 200] or \"auto\"."]
        return {
            "type": "set_read_row_height", "value": height,
            "label": str(action.get("label") or f"Read row height = {height}"),
        }, warnings

    if action_type == "set_layer_background_opacity":
        layer = str(action.get("layer") or "").strip()
        if not layer:
            return None, ["set_layer_background_opacity needs a layer name."]
        try:
            opacity = float(action.get("opacity", action.get("value")))
        except (TypeError, ValueError):
            return None, ["set_layer_background_opacity needs a numeric opacity in [0, 1]."]
        opacity = max(0.0, min(1.0, opacity))
        return {
            "type": "set_layer_background_opacity", "layer": layer, "opacity": opacity,
            "label": str(action.get("label") or f"{layer} background opacity = {opacity:.2f}"),
        }, warnings

    # ── Motif tools (v2.11 merge) ───────────────────────────────────
    if action_type == "set_motif_threshold":
        raw = action.get("value", action.get("threshold"))
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None, ["set_motif_threshold needs a number in [0.5, 1.0]."]
        val = max(0.5, min(1.0, val))
        return {
            "type": "set_motif_threshold", "value": val,
            "label": str(action.get("label") or f"Motif score threshold = {val:.2f}"),
        }, warnings

    if action_type == "load_jaspar_motifs":
        names = action.get("names") or action.get("motifs") or action.get("ids") or []
        if isinstance(names, str):
            names = [n.strip() for n in names.split(",") if n.strip()]
        if not isinstance(names, list) or not names:
            return None, ["load_jaspar_motifs needs a list of TF names or JASPAR IDs."]
        names = [str(n) for n in names]
        return {
            "type": "load_jaspar_motifs", "names": names,
            "label": str(action.get("label") or f"Load JASPAR motifs: {', '.join(names[:3])}"),
        }, warnings

    return None, [f"Model emitted unsupported action type '{action_type or '<missing>'}'; skipped."]


def _summarize_actions(actions: list[dict[str, Any]]) -> str:
    labels: list[str] = []
    for action in actions:
        typ = action.get("type")
        if typ == "navigate_region":
            labels.append(f"navigate to {action.get('label')}")
        elif typ == "scan_peaks":
            labels.append("scan peaks")
        elif typ == "set_peaks_locked":
            labels.append("lock peaks" if action.get("locked") else "unlock peaks")
        elif typ == "add_region_label_rule":
            labels.append(f"add {action.get('color_name', action.get('color'))} label rule for {action.get('region_label')}")
        elif typ == "select_peak_at":
            labels.append(f"select {action.get('label', 'nearest peak')}")
        elif typ == "cluster_selected_peaks":
            labels.append("cluster selected peaks")
        elif typ == "cluster_peak_at_gene_tss":
            labels.append(f"cluster peak at {action.get('gene_name') or 'gene'} TSS")
        elif typ == "query_motif_overlaps":
            labels.append(f"query motif overlaps for {action.get('label', 'target region')}")
        elif typ == "api_call":
            labels.append(f"{action.get('method')} {action.get('path')}")
        else:
            labels.append(str(typ))
    return "; ".join(labels)


def _validate_plan(state, raw: Any, *, context: Optional[dict[str, Any]]) -> dict[str, Any]:
    if isinstance(raw, list):
        raw_actions: Iterable[Any] = raw
        summary = ""
        raw_warnings: list[Any] = []
    elif isinstance(raw, dict):
        if raw.get("actions") is None and (raw.get("type") or raw.get("action")):
            raw_actions = [raw]
        else:
            raw_actions = raw.get("actions") or []
        summary = str(raw.get("summary") or "")
        raw_warnings = list(raw.get("warnings") or [])
    else:
        return {"actions": [], "summary": "", "warnings": ["Model output was not a JSON object."]}
    actions: list[dict[str, Any]] = []
    warnings: list[str] = [str(w) for w in raw_warnings if w]
    for raw_action in raw_actions:
        normalized, action_warnings = _normalize_action(state, raw_action, context=context)
        if normalized is not None and isinstance(raw_action, dict):
            normalized = copilot_tutorial.apply_gating(normalized, raw_action, action_warnings)
        warnings.extend(action_warnings)
        if normalized is not None:
            actions.append(normalized)
    return {"actions": actions, "summary": summary or _summarize_actions(actions), "warnings": warnings}


# ─────────────────────────────────────────────────────────────────────
# Prompt assembly
# ─────────────────────────────────────────────────────────────────────

def _format_previous_turn(turn: dict[str, Any]) -> str:
    """Render one prior conversation turn as a compact reference for the model."""
    text = str(turn.get("text") or "").strip().replace("\n", " ")
    if len(text) > 220:
        text = text[:217] + "..."
    summary = str(turn.get("summary") or "").strip().replace("\n", " ")
    if len(summary) > 200:
        summary = summary[:197] + "..."
    actions = turn.get("actions") or []
    action_types = []
    for action in actions[:8]:
        if isinstance(action, dict):
            t = action.get("type") or action.get("type_") or "?"
            if t == "navigate_region":
                gene = (action.get("gene") or {}).get("name") if isinstance(action.get("gene"), dict) else None
                action_types.append(f"navigate({gene})" if gene else "navigate")
            elif t == "add_region_label_rule":
                gene = action.get("relative_to_gene") or "?"
                offset = action.get("offset_bp")
                action_types.append(f"label({gene}{f' {offset:+d}' if isinstance(offset, int) else ''})")
            elif t == "cluster_peak_at_gene_tss":
                action_types.append(f"cluster({action.get('gene_name') or '?'})")
            else:
                action_types.append(str(t))
    line = f"  - You said: {text!r}"
    if summary:
        line += f"  → planned: {summary}"
    if action_types:
        line += f"  [{', '.join(action_types)}]"
    return line


# ─────────────────────────────────────────────────────────────────────
# Troubleshooting context ("why are no reads visible?")
# ─────────────────────────────────────────────────────────────────────

_DIAGNOSTIC_SEVERITIES = ("blocking", "warning", "info")
_DIAGNOSTIC_LIMIT = 16
_STATE_DETAILS_CHAR_LIMIT = 1800
_REMOTE_PREFIXES = ("http://", "https://", "s3://", "ftp://", "ssh://")


def _dataset_chrom_names(dataset) -> Optional[list[str]]:
    """Chromosome names in a dataset's primary local files (None when unknown)."""
    paths = list(getattr(dataset, "paths", None) or [getattr(dataset, "path", None)])
    companions = {p for group in (getattr(dataset, "companion_layers", None) or {}).values()
                  for p in (group if isinstance(group, (list, tuple)) else [group])}
    paths = [p for p in paths if isinstance(p, str) and p and p not in companions]
    if not paths or any(p.lower().startswith(_REMOTE_PREFIXES) for p in paths):
        return None
    cache_key = tuple(paths)
    cached = getattr(dataset, "_copilot_chrom_names", None)
    if cached and cached[0] == cache_key:
        return cached[1]
    names: set[str] = set()
    try:
        for path in paths:
            lower = path.lower()
            if lower.endswith((".bam", ".cram")):
                from services.bam_handles import get_bam_handle
                handle = get_bam_handle(path)
                if handle is None:
                    return None
                names.update(str(n) for n in handle.references)
            elif lower.endswith((".bb", ".bigbed")):
                from services.bigbed_handles import get_bigbed_handle
                handle = get_bigbed_handle(path)
                if handle is None:
                    return None
                names.update(str(n) for n in (handle.chroms() or {}))
            else:
                return None
    except Exception:
        return None
    result = sorted(names)
    try:
        dataset._copilot_chrom_names = (cache_key, result)
    except Exception:
        pass
    return result


def _server_diagnostics(state, chrom: Optional[str], has_gtf: bool,
                        reported: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Causes only the server can see: no GTF, a dataset without this chromosome."""
    from utils.chrom import same_chrom

    out: list[dict[str, Any]] = []
    codes = {(d.get("code"), d.get("dataset_id")) for d in reported}
    if not has_gtf and not any(code == "no_gtf" for code, _ in codes):
        out.append({"code": "no_gtf", "severity": "info",
                    "message": "No gene annotation (GTF) is loaded, so genes can't be searched or drawn.",
                    "fix_anchor": "load-gtf"})
    if chrom:
        for dataset_id in list(getattr(state, "dataset_order", []) or [])[:COPILOT_DATASET_CONTEXT_LIMIT]:
            if ("chrom_missing_in_dataset", dataset_id) in codes:
                continue
            dataset = getattr(state, "datasets", {}).get(dataset_id)
            names = _dataset_chrom_names(dataset) if dataset is not None else None
            if names and not any(same_chrom(name, str(chrom)) for name in names):
                label = _truncate_label(getattr(dataset, "label", dataset_id))
                out.append({"code": "chrom_missing_in_dataset", "severity": "blocking",
                            "message": f'"{label}" has no reads on {chrom} (its files don\'t contain that chromosome).',
                            "dataset_id": dataset_id, "fix_anchor": "search-bar"})
    # A dataset aligned to another assembly than the loaded genome (services/genome_check.py).
    try:
        from services.genome_check import dataset_genome_summaries
        summaries = dataset_genome_summaries(state)
    except Exception:
        summaries = {}
    for dataset_id in list(getattr(state, "dataset_order", []) or [])[:COPILOT_DATASET_CONTEXT_LIMIT]:
        summary = summaries.get(dataset_id) or {}
        if summary.get("severity") == "error" and summary.get("message") \
                and ("genome_mismatch", dataset_id) not in codes:
            out.append({"code": "genome_mismatch", "severity": "blocking", "message": summary["message"],
                        "dataset_id": dataset_id, "fix_anchor": "genome-selector"})
    return out


def _clean_diagnostics(diagnostics: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in diagnostics if isinstance(diagnostics, list) else []:
        if not isinstance(item, dict):
            continue
        code = re.sub(r"[^a-z0-9_]", "", str(item.get("code") or "").lower())[:48]
        message = " ".join(str(item.get("message") or "").split())[:240]
        if not code or not message:
            continue
        severity = str(item.get("severity") or "info").lower()
        anchor = re.sub(r"[^a-z0-9-]", "", str(item.get("fix_anchor") or "").lower())[:48]
        cleaned: dict[str, Any] = {
            "code": code,
            "severity": severity if severity in _DIAGNOSTIC_SEVERITIES else "info",
            "message": message,
        }
        if anchor:
            cleaned["fix_anchor"] = anchor
        if item.get("dataset_id"):
            cleaned["dataset_id"] = str(item["dataset_id"])
        out.append(cleaned)
    return out


def _format_state_value(value: Any) -> str:
    if isinstance(value, dict) and set(value) == {"chrom", "start", "end"}:
        try:
            return f"{value['chrom']}:{int(value['start']):,}-{int(value['end']):,}"
        except (TypeError, ValueError):
            pass
    return json.dumps(value, separators=(",", ":"), default=str)


def troubleshooting_lines(state, chrom: Optional[str], has_gtf: bool,
                          diagnostics: Any, raw_state: Any) -> list[str]:
    """The Diagnostics block, and the raw state when no diagnostic explains a problem.

    Nothing at all when the caller sent neither (older clients, most training
    records), so those user messages are unchanged.
    """
    if diagnostics is None and raw_state is None:
        return []
    reported = _clean_diagnostics(diagnostics)
    found = reported + _server_diagnostics(state, chrom, has_gtf, reported)
    rank = {sev: i for i, sev in enumerate(_DIAGNOSTIC_SEVERITIES)}
    found = [d for _, d in sorted(enumerate(found), key=lambda item: (rank[item[1]["severity"]], item[0]))]
    found = found[:_DIAGNOSTIC_LIMIT]
    lines: list[str] = []
    if found:
        lines.append("Diagnostics:")
        for d in found:
            fix = f" (fix: {d['fix_anchor']})" if d.get("fix_anchor") else ""
            lines.append(f"- [{d['severity']}] {d['code']}: {d['message']}{fix}")
    serious = any(d["severity"] in ("blocking", "warning") for d in found)
    if not serious and isinstance(raw_state, dict) and raw_state:
        lines.append("State details:")
        used = 0
        for key, value in raw_state.items():
            line = f"  {key}: {_format_state_value(value)}"
            if len(line) > 400:
                line = line[:397] + "..."
            if used + len(line) > _STATE_DETAILS_CHAR_LIMIT:
                lines.append("  ...")
                break
            lines.append(line)
            used += len(line)
    return lines


def _user_message(
    state,
    command: str,
    context: Optional[dict[str, Any]],
    *,
    previous_turns: Optional[list[dict[str, Any]]] = None,
    diagnostics: Optional[list[dict[str, Any]]] = None,
    raw_state: Optional[dict[str, Any]] = None,
) -> str:
    ctx = context or {}
    lines: list[str] = []
    chrom = ctx.get("chrom")
    start = ctx.get("start")
    end = ctx.get("end")
    genome = ctx.get("currentGenome") or "unknown genome"
    if chrom and start is not None and end is not None:
        lines.append(f"Viewport: {genome} {chrom}:{int(start):,}-{int(end):,}")
    else:
        lines.append(f"Viewport: {genome} (none set)")

    # Gene context — what the user is currently focused on. Sourced from store
    # state passed through `context` (selectedGenes / relativeGene / relativeTSS)
    # so the model can resolve "the gene" / "this TSS" without restatement.
    selected_genes = ctx.get("selectedGenes") or getattr(state, "selectedGenes", None) or []
    relative_gene = ctx.get("relativeGene") or getattr(state, "relativeGene", None)
    relative_tss = ctx.get("relativeTSS") or getattr(state, "relativeTSS", None)
    if relative_gene and isinstance(relative_gene, dict):
        name = relative_gene.get("name") or "?"
        chrom_g = relative_gene.get("chrom") or "?"
        strand = relative_gene.get("strand") or "+"
        lines.append(
            f"Selected gene: {name} ({chrom_g}, {strand} strand"
            + (f", TSS={int(relative_tss):,}" if isinstance(relative_tss, (int, float)) else "")
            + ") — refer to it as 'this gene' / 'the TSS' without restating."
        )
    elif selected_genes:
        names = []
        for g in selected_genes[:5]:
            if isinstance(g, dict) and g.get("name"):
                names.append(str(g["name"]))
        if names:
            lines.append(f"Selected genes: {', '.join(names)}")

    # Analysis settings the user might want to tune.
    cluster_method = ctx.get("clusterMethod") or getattr(state, "cluster_method", None) or getattr(state, "clusterMethod", None)
    cluster_k = ctx.get("clusterK") or getattr(state, "cluster_k", None) or getattr(state, "clusterK", None)
    if cluster_method or cluster_k:
        parts = []
        if cluster_method:
            parts.append(f"method={cluster_method}")
        if cluster_k:
            parts.append(f"k={cluster_k}")
        lines.append(f"Clustering: {', '.join(parts)}")

    sample_seed = ctx.get("analysisSampleSeed") or getattr(state, "analysis_sample_seed", None)
    sample_count = ctx.get("analysisSampleCount") or getattr(state, "analysis_sample_count", None)
    if sample_seed is not None or sample_count is not None:
        parts = []
        if sample_count is not None:
            parts.append(f"sample_count={sample_count}")
        if sample_seed is not None:
            parts.append(f"sample_seed={sample_seed}")
        lines.append(f"Analysis sampling: {', '.join(parts)}")

    subnuc = ctx.get("subnucleosomalThreshold") or getattr(state, "subnucleosomal_threshold", None)
    access = ctx.get("accessibilityThreshold") or getattr(state, "accessibility_threshold", None)
    if subnuc is not None or access is not None:
        parts = []
        if subnuc is not None:
            parts.append(f"subnucleosomal_threshold={subnuc}")
        if access is not None:
            parts.append(f"accessibility_threshold={access}")
        lines.append(f"Thresholds: {', '.join(parts)}")

    spanning = ctx.get("spanningOnly")
    peaks_locked = ctx.get("peaksLocked") or getattr(state, "peaks_locked", None)
    if spanning is not None or peaks_locked is not None:
        flags = []
        if spanning is not None:
            flags.append(f"spanning_only={'on' if spanning else 'off'}")
        if peaks_locked is not None:
            flags.append(f"peaks_locked={'on' if peaks_locked else 'off'}")
        lines.append(f"Filters: {', '.join(flags)}")

    datasets = []
    dataset_order = list(getattr(state, "dataset_order", []) or [])
    for dataset_id in dataset_order[:COPILOT_DATASET_CONTEXT_LIMIT]:
        dataset = getattr(state, "datasets", {}).get(dataset_id)
        if not dataset:
            continue
        label = _truncate_label(getattr(dataset, "label", dataset_id))
        layer_type = getattr(dataset, "layer_type", "") or getattr(dataset, "data_type", "")
        layers = getattr(dataset, "available_layers", None) or {}
        layer_names = ",".join(sorted(layers.keys())) if isinstance(layers, dict) else str(layers)
        datasets.append(f"  - {dataset_id} ({layer_type}): {label} [layers: {layer_names or 'n/a'}]")
    if datasets:
        lines.append(f"Datasets ({len(dataset_order)} total):")
        lines.extend(datasets)
        if len(dataset_order) > COPILOT_DATASET_CONTEXT_LIMIT:
            lines.append(f"  ... +{len(dataset_order) - COPILOT_DATASET_CONTEXT_LIMIT} more")
    else:
        lines.append("Datasets: none loaded")

    has_gtf = False
    gtf = getattr(state, "gtf_data", None)
    if isinstance(gtf, dict):
        tx_df = gtf.get("transcripts")
        has_gtf = tx_df is not None and not getattr(tx_df, "empty", True)
    lines.append(f"GTF loaded: {'yes' if has_gtf else 'no'}")

    motif_tracks = getattr(state, "motif_tracks", None) or []
    if motif_tracks:
        lines.append(f"Motif tracks: {len(motif_tracks)}")

    lines.extend(troubleshooting_lines(state, chrom, has_gtf, diagnostics, raw_state))

    if previous_turns:
        lines.append("")
        lines.append("Recent commands (use them to resolve 'that gene' / 'do it again' references):")
        for turn in previous_turns[-3:]:
            lines.append(_format_previous_turn(turn))

    lines.append("")
    lines.append(f"User request: {command}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────
# Streaming planner
# ─────────────────────────────────────────────────────────────────────

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


def _split_think_chunk(buffer: str, in_thinking: bool) -> tuple[list[tuple[str, str]], str, bool]:
    """Split a streamed buffer into (kind, text) pairs and return the residue.

    Recognizes <think>...</think> blocks. Returns a list of ('thinking'|'text', chunk)
    pairs, the unprocessed tail to keep buffering, and the new in_thinking state.
    """
    out: list[tuple[str, str]] = []
    pos = 0
    while pos < len(buffer):
        if in_thinking:
            close = buffer.find(THINK_CLOSE, pos)
            if close < 0:
                # Hold the last few chars so a partial </think> at the end isn't emitted.
                safe = max(pos, len(buffer) - len(THINK_CLOSE) + 1)
                if safe > pos:
                    out.append(("thinking", buffer[pos:safe]))
                return out, buffer[safe:], in_thinking
            if close > pos:
                out.append(("thinking", buffer[pos:close]))
            pos = close + len(THINK_CLOSE)
            in_thinking = False
        else:
            open_idx = buffer.find(THINK_OPEN, pos)
            if open_idx < 0:
                safe = max(pos, len(buffer) - len(THINK_OPEN) + 1)
                if safe > pos:
                    out.append(("text", buffer[pos:safe]))
                return out, buffer[safe:], in_thinking
            if open_idx > pos:
                out.append(("text", buffer[pos:open_idx]))
            pos = open_idx + len(THINK_OPEN)
            in_thinking = True
    return out, "", in_thinking


def _extract_json_object(text: str) -> Optional[Any]:
    if not text:
        return None
    # Skip past any thinking blocks first.
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    if not cleaned:
        return None
    starts = [idx for idx in (cleaned.find("{"), cleaned.find("[")) if idx >= 0]
    if not starts:
        return None
    start = min(starts)
    fragment = cleaned[start:].strip()
    # The first complete JSON value; whatever the model adds after it (a note,
    # a bracketed reference) doesn't make the plan unreadable.
    try:
        value, _end = json.JSONDecoder().raw_decode(fragment)
        return value
    except ValueError:
        pass
    end_chars = ("}", "]")
    last = max(fragment.rfind(ch) for ch in end_chars)
    if last < 0:
        return None
    try:
        return json.loads(fragment[:last + 1])
    except Exception:
        return None


def _mlx_chat_stream(messages: list[dict[str, str]], *, model: str, timeout: float) -> Iterator[dict[str, Any]]:
    """Stream chunks from an OpenAI-compatible mlx_lm.server, normalized to Ollama shape.

    The downstream code expects {"message": {"content": "..."}} per chunk and
    {"done": true, ...stats} on the last chunk; this adapter rewrites the
    OpenAI SSE protocol into that shape so dispatch in stream_natural_language_command
    stays uniform.
    """
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.1,
        # Token counts arrive in a usage chunk after the finish chunk.
        "stream_options": {"include_usage": True},
    }
    request = urllib.request.Request(
        _mlx_chat_url(),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    def _counts(usage: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if "prompt_tokens" in usage:
            out["prompt_eval_count"] = usage["prompt_tokens"]
        if "completion_tokens" in usage:
            out["eval_count"] = usage["completion_tokens"]
        return out

    # The final chunk carries finish_reason; with include_usage the token
    # counts follow in their own chunk, so "done" waits for them (or [DONE]).
    finished = False
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                yield {"done": True}
                return
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            usage = chunk.get("usage") or {}
            choices = chunk.get("choices") or []
            if not choices:
                if usage:
                    yield {"message": {"content": ""}, "done": True, **_counts(usage)}
                    return
                continue
            choice = choices[0]
            delta = (choice.get("delta") or {}).get("content") or ""
            if choice.get("finish_reason"):
                finished = True
                if usage:
                    yield {"message": {"content": delta}, "done": True, **_counts(usage)}
                    return
            yield {"message": {"content": delta}}
    if finished:
        yield {"done": True}


def _ollama_chat_stream(messages: list[dict[str, str]], *, model: str, timeout: float) -> Iterator[dict[str, Any]]:
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.1},
        "keep_alive": COPILOT_OLLAMA_KEEP_ALIVE,
    }
    request = urllib.request.Request(
        COPILOT_OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _event(event: str, **payload: Any) -> str:
    return json.dumps({"event": event, **payload}, ensure_ascii=False) + "\n"


def stream_natural_language_command(
    state,
    text: str,
    context: Optional[dict[str, Any]] = None,
    *,
    app,
    model: Optional[str] = None,
    previous_turns: Optional[list[dict[str, Any]]] = None,
    diagnostics: Optional[list[dict[str, Any]]] = None,
    raw_state: Optional[dict[str, Any]] = None,
) -> Iterator[str]:
    """Yield NDJSON events that the frontend renders live.

    Events: start, thinking, token, raw, plan, warning, error, done.
    """
    command = (text or "").strip()
    if not command:
        yield _event("error", message="Command text is empty.")
        yield _event("done")
        return

    backend = COPILOT_BACKEND
    if backend == "mlx":
        mlx_probe = _cached_probe_mlx_server(timeout=4.0)
        available_models = list(mlx_probe["models"])
        if not available_models:
            if mlx_probe["reachable"]:
                message = "The Copilot model is still loading. Try again in a moment."
            else:
                from services.copilot_lifecycle import copilot_setup_message
                message = copilot_setup_message(backend)
            yield _event("error", message=message, setup_needed=not mlx_probe["reachable"])
            yield _event("done")
            return
        # mlx_lm.server's /v1/models lists every model in the Hugging Face cache,
        # not the one it serves, and it loads whatever a request names. Asking
        # for a listed model can silently swap the trained Copilot for an
        # unrelated cached one, so a request names a model only when the user
        # picked one that is listed; otherwise "default_model", which is the
        # model the server was started with.
        requested = (model or "").strip()
        resolved_model = requested if requested and requested in available_models else MLX_SERVED_MODEL
        model_warning = (
            None if not requested or resolved_model == requested
            else f"'{requested}' isn't available; using the model the Copilot server was started with."
        )
        chat_stream = _mlx_chat_stream
    else:
        available_models = list_ollama_models(timeout=1.0)
        if not available_models:
            from services.copilot_lifecycle import copilot_setup_message, mlx_host_problem, mlx_import_problem
            if mlx_host_problem() is None and mlx_import_problem() is None:
                # A Mac that can run the trained MLX model: offer that, not Ollama.
                message = copilot_setup_message("mlx")
            else:
                message = copilot_setup_message("ollama")
            yield _event("error", message=message, setup_needed=True)
            yield _event("done")
            return
        requested = (model or COPILOT_DEFAULT_MODEL).strip() or COPILOT_DEFAULT_MODEL
        resolved_model, model_warning = resolve_ollama_model(requested, available_models)
        chat_stream = _ollama_chat_stream

    system_prompt = build_copilot_system_prompt(app)
    user_message = _user_message(state, command, context, previous_turns=previous_turns,
                                 diagnostics=diagnostics, raw_state=raw_state)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]

    yield _event(
        "start",
        backend=backend,
        model=resolved_model,
        requested_model=requested,
        prompt_chars=sum(len(m["content"]) for m in messages),
        system_chars=len(system_prompt),
        keep_alive=COPILOT_OLLAMA_KEEP_ALIVE if backend == "ollama" else None,
        viewport=context or {},
    )
    if model_warning:
        yield _event("warning", message=model_warning)

    started = time.perf_counter()
    full_content = ""
    buffer = ""
    in_thinking = False
    eval_counts: dict[str, Any] = {}

    try:
        for chunk in chat_stream(messages, model=resolved_model, timeout=COPILOT_OLLAMA_TIMEOUT):
            if "error" in chunk and chunk.get("error"):
                yield _event("error", message=str(chunk["error"]))
                yield _event("done")
                return
            message = chunk.get("message") or {}
            delta = message.get("content") or chunk.get("response") or ""
            if delta:
                full_content += delta
                buffer += delta
                pieces, residue, in_thinking = _split_think_chunk(buffer, in_thinking)
                buffer = residue
                for kind, piece in pieces:
                    if not piece:
                        continue
                    if kind == "thinking":
                        yield _event("thinking", delta=piece)
                    else:
                        yield _event("token", delta=piece)
            if chunk.get("done"):
                eval_counts = {
                    k: chunk[k] for k in (
                        "total_duration", "load_duration",
                        "prompt_eval_count", "prompt_eval_duration",
                        "eval_count", "eval_duration",
                    ) if k in chunk
                }
                break
        # Flush any residue
        if buffer:
            kind = "thinking" if in_thinking else "token"
            yield _event(kind, delta=buffer)
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        yield _event(
            "error",
            message=f"Local model call failed ({type(exc).__name__}): {exc}",
            elapsed_ms=elapsed_ms,
        )
        yield _event("done")
        return

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    parsed = _extract_json_object(full_content)
    plan = _validate_plan(state, parsed, context=context)
    # Copilot teaches: steps that would run an operation are dropped here.
    plan = copilot_tutorial.teach_only_plan(plan)
    plan = ensure_named_gene_navigation(state, text, context, plan)
    actions = plan["actions"]
    warnings = plan["warnings"]
    summary = plan["summary"]

    yield _event(
        "raw",
        content=full_content,
        parsed=parsed,
    )
    planner_id = f"{backend}:{resolved_model}"
    if not actions:
        yield _event(
            "plan",
            success=False,
            planner=planner_id,
            actions=[],
            warnings=warnings or ["Model did not produce any executable actions."],
            summary=summary,
            elapsed_ms=elapsed_ms,
            stats=eval_counts,
        )
    else:
        for w in warnings:
            yield _event("warning", message=w)
        yield _event(
            "plan",
            success=True,
            planner=planner_id,
            actions=actions,
            warnings=warnings,
            summary=summary,
            needs_confirmation=True,
            elapsed_ms=elapsed_ms,
            stats=eval_counts,
            original_text=command,
        )
    yield _event("done")


# ─────────────────────────────────────────────────────────────────────
# Non-streaming convenience wrapper (used by the legacy /api/nl/plan route)
# ─────────────────────────────────────────────────────────────────────

def plan_natural_language_command(
    state,
    text: str,
    context: Optional[dict[str, Any]] = None,
    *,
    app,
    model: Optional[str] = None,
    previous_turns: Optional[list[dict[str, Any]]] = None,
    diagnostics: Optional[list[dict[str, Any]]] = None,
    raw_state: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Run the streaming planner to completion and return a single plan dict.

    Kept for clients (Jupyter, tests) that don't want SSE/NDJSON.
    """
    summary = ""
    actions: list[dict[str, Any]] = []
    warnings: list[str] = []
    planner = f"{COPILOT_BACKEND}:{(model or COPILOT_DEFAULT_MODEL)}"
    success = False
    error: Optional[str] = None
    elapsed_ms = 0
    stats: dict[str, Any] = {}
    raw_content = ""
    thinking = ""
    setup_needed = False
    for line in stream_natural_language_command(state, text, context, app=app, model=model,
                                                previous_turns=previous_turns,
                                                diagnostics=diagnostics, raw_state=raw_state):
        evt = json.loads(line)
        kind = evt.get("event")
        if kind == "thinking":
            thinking += str(evt.get("delta") or "")
        elif kind == "raw":
            raw_content = str(evt.get("content") or "")
        elif kind == "warning":
            warnings.append(str(evt.get("message") or ""))
        elif kind == "error":
            error = str(evt.get("message") or "Local model failed.")
            setup_needed = setup_needed or bool(evt.get("setup_needed"))
        elif kind == "plan":
            success = bool(evt.get("success"))
            actions = list(evt.get("actions") or [])
            warnings = list(evt.get("warnings") or warnings)
            summary = str(evt.get("summary") or "")
            planner = str(evt.get("planner") or planner)
            elapsed_ms = int(evt.get("elapsed_ms") or 0)
            stats = dict(evt.get("stats") or {})

    if error and not actions:
        return {
            "success": False,
            "planner": planner,
            "original_text": text,
            "error": error,
            "setup_needed": setup_needed,
            "actions": [],
            "warnings": warnings or [error],
            "needs_confirmation": True,
            "debug": {
                "thinking": thinking,
                "raw_content": raw_content,
                "elapsed_ms": elapsed_ms,
                "stats": stats,
            },
        }
    return {
        "success": success,
        "planner": planner,
        "original_text": text,
        "summary": summary,
        "actions": actions,
        "warnings": warnings,
        "needs_confirmation": True,
        "debug": {
            "thinking": thinking,
            "raw_content": raw_content,
            "elapsed_ms": elapsed_ms,
            "stats": stats,
        },
    }
