"""Agentic tool-calling loop for Copilot.

The non-agentic planner emits a single plan up-front. The agentic flow lets
the model take ONE action at a time, see the result, and decide the next —
which is the only way to handle exploratory queries ("find X, and if there
are none, widen to Y") without manual plan branching.

Architecture:
- Tools are OpenAI-style function definitions mirroring the existing action
  types. The LLM emits a tool call; the frontend executes it via the same
  browserActions executor; the result is fed back as a `tool` role message;
  loop until the model emits a final assistant message with no tool calls,
  or a step cap is hit.
- This module is server-side: it calls the configured backend (Ollama or
  mlx_lm.server) with the OpenAI Chat Completions tool-call shape and
  returns the assistant's response. The loop itself runs on the frontend
  so each tool call can execute against the live store / API.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Optional

from . import natural_language_commands as nlc
from .natural_language_commands import (
    COPILOT_OLLAMA_KEEP_ALIVE,
    COPILOT_OLLAMA_TIMEOUT,
    COPILOT_OLLAMA_URL,
)


COPILOT_AGENT_MAX_STEPS = int(os.environ.get("FIBERBROWSER_COPILOT_AGENT_MAX_STEPS", "8"))


def _scoped_param(prop_type: str, description: str, **extras: Any) -> dict[str, Any]:
    return {"type": prop_type, "description": description, **extras}


# Each entry mirrors a normalize-able action in natural_language_commands._normalize_action.
# Keep in sync with the action validator: any field added here must be accepted there.
COPILOT_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "navigate_gene",
            "description": "Navigate the browser viewport to a gene from the loaded GTF, with symmetric padding.",
            "parameters": {
                "type": "object",
                "properties": {
                    "gene": _scoped_param("string", "Exact gene symbol from the loaded GTF (e.g. 'eve')."),
                    "padding_bp": _scoped_param("integer", "Padding on each side of the gene in bp.", default=5000),
                },
                "required": ["gene"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "navigate_region",
            "description": "Navigate the viewport to an explicit genomic interval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chrom": _scoped_param("string", "Chromosome name as it appears in the loaded data (e.g. '2R', 'chr8')."),
                    "start": _scoped_param("integer", "Start coordinate, 0-based."),
                    "end": _scoped_param("integer", "End coordinate, exclusive, > start."),
                    "label": _scoped_param("string", "Optional human label."),
                },
                "required": ["chrom", "start", "end"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scan_peaks",
            "description": "Re-run the active peak rules against the current viewport.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_peaks_locked",
            "description": "Lock or unlock the current peak set for reproducibility.",
            "parameters": {
                "type": "object",
                "properties": {"locked": _scoped_param("boolean", "True to lock, False to unlock.")},
                "required": ["locked"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "select_peak_at",
            "description": "Select the nearest detected peak. Use either explicit chrom/position OR relative_to_gene/offset_bp.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chrom": _scoped_param("string", "Chromosome (explicit form)."),
                    "position": _scoped_param("integer", "Genomic position (explicit form)."),
                    "relative_to_gene": _scoped_param("string", "Gene symbol (relative form)."),
                    "offset_bp": _scoped_param("integer", "Strand-aware offset from TSS; positive = downstream, negative = upstream."),
                    "tolerance_bp": _scoped_param("integer", "Search radius in bp.", default=500),
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cluster_selected_peaks",
            "description": "Cluster reads on the currently selected peaks (reads cluster_k / cluster_method from settings).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cluster_peak_at_gene_tss",
            "description": "Navigate, select the peak at a gene's TSS, and cluster on it. Strand-aware.",
            "parameters": {
                "type": "object",
                "properties": {
                    "gene": _scoped_param("string", "Exact gene symbol."),
                    "padding_bp": _scoped_param("integer", "Viewport padding for the navigate step.", default=5000),
                    "tolerance_bp": _scoped_param("integer", "Peak search radius from the TSS.", default=500),
                },
                "required": ["gene"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_region_label_rule",
            "description": "Prepend a colormap rule recoloring footprints in a region. Use relative_to_gene + offset_bp for TSS-relative; otherwise chrom/start/end.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chrom": _scoped_param("string", "Chromosome (explicit form)."),
                    "start": _scoped_param("integer", "Genomic start (explicit form, must be >=0)."),
                    "end": _scoped_param("integer", "Genomic end (explicit form, must be > start)."),
                    "relative_to_gene": _scoped_param("string", "Gene symbol (relative form)."),
                    "offset_bp": _scoped_param("integer", "Strand-aware offset from TSS."),
                    "width_bp": _scoped_param("integer", "Width of the relative window.", default=80),
                    "layer": _scoped_param("string", "tf, nuc, fire, deam, m6a.", default="tf"),
                    "color": _scoped_param("string", "Hex color (#RRGGBB).", default="#22c55e"),
                    "size_min": _scoped_param("integer", "Min footprint size in bp.", default=1),
                    "size_max": _scoped_param("integer", "Max footprint size (inclusive). Use 89 for TF, 250 for nucleosomes."),
                    "region_label": _scoped_param("string", "Human label shown in the rule list."),
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_motif_overlaps",
            "description": "Report motif intervals overlapping a region. Use either explicit chrom/start/end or relative_to_gene/offset_bp.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chrom": _scoped_param("string", "Chromosome (explicit form)."),
                    "start": _scoped_param("integer", "Genomic start (explicit form)."),
                    "end": _scoped_param("integer", "Genomic end (explicit form)."),
                    "relative_to_gene": _scoped_param("string", "Gene symbol (relative form)."),
                    "offset_bp": _scoped_param("integer", "Strand-aware offset from TSS."),
                    "width_bp": _scoped_param("integer", "Width in bp.", default=80),
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "api_call",
            "description": "Call any safe same-origin /api/... route. The validator blocks unsafe routes (file pickers, uploads, S3, server lifecycle). Use this for settings, sort, filter, render, session export, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "method": _scoped_param("string", "GET, POST, or DELETE.", enum=["GET", "POST", "DELETE"]),
                    "path": _scoped_param("string", "Same-origin path beginning with /api/."),
                    "body": _scoped_param("object", "JSON body for POST/DELETE. Empty object for no body."),
                },
                "required": ["method", "path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "respond_to_user",
            "description": "Emit a final natural-language response when the user's request is fully handled. After this no more tool calls fire.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": _scoped_param("string", "What was done, in one sentence."),
                },
                "required": ["summary"],
            },
        },
    },
]


def _post(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def agent_step(
    *,
    model: str,
    messages: list[dict[str, Any]],
    timeout: Optional[float] = None,
) -> dict[str, Any]:
    """Send one chat completion with tools and return the assistant message.

    Returns the raw OpenAI/Ollama-shaped assistant message: it may contain
    `content` (final text) and/or `tool_calls` (list of {id, function: {name, arguments}}).
    The frontend dispatches each tool call through the existing browser-action
    executor and appends the result as a `tool` role message, then calls again.
    """
    timeout = timeout if timeout is not None else COPILOT_OLLAMA_TIMEOUT
    if nlc.COPILOT_BACKEND == "mlx":
        url = nlc._mlx_chat_url()
        payload = {
            # The model the server was started with (see nlc.MLX_SERVED_MODEL).
            "model": nlc.MLX_SERVED_MODEL,
            "messages": messages,
            "tools": COPILOT_TOOLS,
            "tool_choice": "auto",
            "stream": False,
            "temperature": 0.1,
        }
        response = _post(url, payload, timeout=timeout)
        choice = (response.get("choices") or [{}])[0]
        return choice.get("message") or {}
    # Ollama
    url = COPILOT_OLLAMA_URL
    payload = {
        "model": model,
        "messages": messages,
        "tools": COPILOT_TOOLS,
        "stream": False,
        "options": {"temperature": 0.1},
        "keep_alive": COPILOT_OLLAMA_KEEP_ALIVE,
    }
    response = _post(url, payload, timeout=timeout)
    return response.get("message") or {}
