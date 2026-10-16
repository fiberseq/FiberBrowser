#!/usr/bin/env python3
"""Recover an approximate PWM from a published sequence-logo image.

This is a best-effort rescue tool for papers that show a motif logo but do not
publish the underlying PWM. Prefer the original PWM whenever it exists.

Two extraction modes are available:
  - color: deterministic segmentation of standard A/C/G/T logo colors.
  - ollama: sends the image to a local vision model and expects JSON PWM output.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image


BASES = ("A", "C", "G", "T")
DEFAULT_BASE_COLORS = {
    "A": (34, 165, 89),
    "C": (37, 99, 235),
    "G": (217, 119, 6),
    "T": (220, 38, 38),
}


@dataclass
class Motif:
    name: str
    pwm: dict[str, list[float]]
    notes: str | None = None


def parse_crop(value: str | None) -> tuple[int, int, int, int] | None:
    if not value:
        return None
    parts = [int(float(p.strip())) for p in value.split(",")]
    if len(parts) != 4:
        raise ValueError("--crop must be X,Y,W,H")
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        raise ValueError("--crop width/height must be positive")
    return x, y, w, h


def load_image(path: str, *, page: int = 1, dpi: int = 240) -> Image.Image:
    suffix = Path(path).suffix.lower()
    if suffix == ".pdf":
        try:
            import fitz  # type: ignore
        except Exception as exc:
            raise RuntimeError("PDF input requires optional dependency PyMuPDF: pip install pymupdf") from exc
        doc = fitz.open(path)
        if page < 1 or page > len(doc):
            raise ValueError(f"PDF page {page} out of range 1..{len(doc)}")
        pdf_page = doc[page - 1]
        pix = pdf_page.get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
        return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    return Image.open(path).convert("RGB")


def crop_image(image: Image.Image, crop: tuple[int, int, int, int] | None) -> Image.Image:
    if not crop:
        return image
    x, y, w, h = crop
    return image.crop((x, y, x + w, y + h))


def _rgb_dist(a: np.ndarray, b: tuple[int, int, int]) -> np.ndarray:
    ref = np.asarray(b, dtype=np.float32)
    return np.sqrt(np.sum((a.astype(np.float32) - ref) ** 2, axis=-1)) / math.sqrt(3 * 255 * 255)


def classify_logo_pixels(image: Image.Image, *, max_color_distance: float = 0.42) -> dict[str, np.ndarray]:
    arr = np.asarray(image.convert("RGB"), dtype=np.uint8)
    arr_f = arr.astype(np.float32) / 255.0
    rgb_max = arr_f.max(axis=-1)
    rgb_min = arr_f.min(axis=-1)
    saturation = np.divide(rgb_max - rgb_min, np.maximum(rgb_max, 1e-6))
    eligible = (saturation >= 0.22) & (rgb_max >= 0.18)

    distances = {base: _rgb_dist(arr, color) for base, color in DEFAULT_BASE_COLORS.items()}
    stacked = np.stack([distances[base] for base in BASES], axis=-1)
    nearest = np.argmin(stacked, axis=-1)
    nearest_dist = np.min(stacked, axis=-1)

    masks: dict[str, np.ndarray] = {}
    for i, base in enumerate(BASES):
        masks[base] = eligible & (nearest == i) & (nearest_dist <= max_color_distance)
    return masks


def _active_groups(active: np.ndarray, *, merge_gap: int = 3, min_width: int = 2) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    start: int | None = None
    for i, value in enumerate(active):
        if value and start is None:
            start = i
        elif not value and start is not None:
            groups.append((start, i))
            start = None
    if start is not None:
        groups.append((start, len(active)))

    merged: list[tuple[int, int]] = []
    for group in groups:
        if not merged or group[0] - merged[-1][1] > merge_gap:
            merged.append(group)
        else:
            merged[-1] = (merged[-1][0], group[1])
    return [(s, e) for s, e in merged if e - s >= min_width]


def infer_logo_columns(
    masks: dict[str, np.ndarray],
    *,
    positions: int | None = None,
    min_column_pixels: int | None = None,
) -> list[tuple[int, int]]:
    combined = np.zeros_like(next(iter(masks.values())), dtype=bool)
    for mask in masks.values():
        combined |= mask
    projection = combined.sum(axis=0).astype(float)
    if projection.size == 0 or projection.max() == 0:
        raise ValueError("No colored A/C/G/T logo pixels detected. Try --crop or --method ollama.")

    window = np.ones(5) / 5.0
    smooth = np.convolve(projection, window, mode="same")
    threshold = min_column_pixels if min_column_pixels is not None else max(1.0, smooth.max() * 0.04)
    active = smooth >= threshold
    groups = _active_groups(active)
    if not groups:
        raise ValueError("No logo columns detected. Try --crop or lower --min-column-pixels.")

    x0 = min(s for s, _e in groups)
    x1 = max(e for _s, e in groups)
    if positions:
        edges = np.linspace(x0, x1, positions + 1)
        return [(int(round(edges[i])), int(round(edges[i + 1]))) for i in range(positions)]
    return groups


def extract_pwm_color(
    image: Image.Image,
    *,
    positions: int | None = None,
    crop: tuple[int, int, int, int] | None = None,
    min_column_pixels: int | None = None,
    max_color_distance: float = 0.42,
) -> Motif:
    image = crop_image(image, crop)
    masks = classify_logo_pixels(image, max_color_distance=max_color_distance)
    columns = infer_logo_columns(masks, positions=positions, min_column_pixels=min_column_pixels)

    pwm = {base: [] for base in BASES}
    for x0, x1 in columns:
        heights: dict[str, float] = {}
        for base in BASES:
            ys = np.where(masks[base][:, max(0, x0):max(x0 + 1, x1)])[0]
            heights[base] = float(ys.max() - ys.min() + 1) if ys.size else 0.0
        total = sum(heights.values())
        if total <= 0:
            probs = {base: 0.25 for base in BASES}
        else:
            probs = {base: heights[base] / total for base in BASES}
        for base in BASES:
            pwm[base].append(probs[base])

    return Motif(
        name="motif_from_logo",
        pwm=normalize_pwm(pwm),
        notes=f"Recovered from {len(columns)} color-segmented logo columns; approximate.",
    )


def _image_to_base64_png(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _extract_json_object(text: str) -> dict[str, Any]:
    clean = text.strip()
    clean = re.sub(r"^```(?:json)?", "", clean).strip()
    clean = re.sub(r"```$", "", clean).strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", clean, flags=re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def extract_pwm_ollama(
    image: Image.Image,
    *,
    model: str,
    host: str = "http://127.0.0.1:11434",
    crop: tuple[int, int, int, int] | None = None,
    prompt_extra: str | None = None,
) -> list[Motif]:
    image = crop_image(image, crop)
    prompt = (
        "You are recovering an approximate PWM from a published DNA sequence logo image. "
        "Read the stacked A/C/G/T letter heights column by column. Return strict JSON only, "
        "with this schema: {\"motifs\":[{\"name\":\"motif_name\","
        "\"pwm\":{\"A\":[...],\"C\":[...],\"G\":[...],\"T\":[...]},"
        "\"notes\":\"brief uncertainty notes\"}]}. Values must be probabilities, "
        "one value per base per position, and each position must sum to 1. "
        "If there is one logo, return one motif. Do not return markdown."
    )
    if prompt_extra:
        prompt += "\nAdditional context: " + prompt_extra

    payload = {
        "model": model,
        "prompt": prompt,
        "images": [_image_to_base64_png(image)],
        "stream": False,
        "format": "json",
    }
    request = urllib.request.Request(
        f"{host.rstrip('/')}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Ollama request failed. Is Ollama running at {host}? {exc}") from exc

    parsed = _extract_json_object(result.get("response", ""))
    entries = parsed.get("motifs") or [parsed]
    motifs: list[Motif] = []
    for i, entry in enumerate(entries):
        pwm = entry.get("pwm") or entry.get("counts")
        if not pwm:
            continue
        motifs.append(Motif(
            name=str(entry.get("name") or f"motif_{i + 1}"),
            pwm=normalize_pwm(pwm),
            notes=entry.get("notes"),
        ))
    if not motifs:
        raise ValueError("Local LLM did not return any parseable motifs")
    return motifs


def normalize_pwm(pwm: dict[str, Iterable[Any]]) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    lengths = set()
    for base in BASES:
        values = list(pwm.get(base, []))
        if not values:
            raise ValueError(f"PWM is missing non-empty {base} values")
        clean = [max(0.0, float(v)) for v in values]
        out[base] = clean
        lengths.add(len(clean))
    if len(lengths) != 1:
        raise ValueError("PWM A/C/G/T arrays must have identical lengths")

    width = len(out["A"])
    for i in range(width):
        total = sum(out[base][i] for base in BASES)
        if total <= 0:
            for base in BASES:
                out[base][i] = 0.25
        else:
            for base in BASES:
                out[base][i] /= total
    return out


def pwm_to_counts(pwm: dict[str, list[float]], *, scale: int = 100) -> dict[str, list[int]]:
    counts = {base: [] for base in BASES}
    width = len(pwm["A"])
    for i in range(width):
        raw = np.asarray([pwm[base][i] for base in BASES], dtype=float) * scale
        floors = np.floor(raw).astype(int)
        remainder = scale - int(floors.sum())
        if remainder > 0:
            order = np.argsort(-(raw - floors))
            for idx in order[:remainder]:
                floors[idx] += 1
        for base, value in zip(BASES, floors):
            counts[base].append(int(value))
    return counts


def format_jaspar(motifs: list[Motif], *, counts_scale: int = 100) -> str:
    lines: list[str] = []
    for motif in motifs:
        counts = pwm_to_counts(motif.pwm, scale=counts_scale)
        lines.append(f">{motif.name}")
        for base in BASES:
            lines.append(f"{base} [ {' '.join(str(v) for v in counts[base])} ]")
    return "\n".join(lines) + "\n"


def format_meme(motifs: list[Motif], *, nsites: int = 100) -> str:
    lines = [
        "MEME version 4",
        "",
        "ALPHABET= ACGT",
        "",
        "strands: + -",
        "",
        "Background letter frequencies",
        "A 0.25 C 0.25 G 0.25 T 0.25",
        "",
    ]
    for motif in motifs:
        width = len(motif.pwm["A"])
        lines.extend([
            f"MOTIF {motif.name}",
            f"letter-probability matrix: alength= 4 w= {width} nsites= {nsites} E= 0",
        ])
        for i in range(width):
            lines.append(" ".join(f"{motif.pwm[base][i]:.6f}" for base in BASES))
        lines.append("")
    return "\n".join(lines)


def format_json(motifs: list[Motif]) -> str:
    return json.dumps({
        "motifs": [
            {"name": motif.name, "pwm": motif.pwm, "notes": motif.notes}
            for motif in motifs
        ],
    }, indent=2) + "\n"


def write_output(text: str, output: str | None) -> None:
    if output:
        Path(output).write_text(text)
    else:
        sys.stdout.write(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Approximate a DNA PWM from a sequence-logo screenshot or PDF crop.",
    )
    parser.add_argument("input", help="Input PNG/JPEG/TIFF image or PDF")
    parser.add_argument("--method", choices=("color", "ollama"), default="color")
    parser.add_argument("--name", default=None, help="Override motif name for color mode or single LLM result")
    parser.add_argument("--positions", type=int, default=None, help="Expected motif width. Recommended for color mode.")
    parser.add_argument("--crop", default=None, help="Crop before parsing as X,Y,W,H in image pixels")
    parser.add_argument("--page", type=int, default=1, help="PDF page number, 1-based")
    parser.add_argument("--dpi", type=int, default=240, help="PDF rasterization DPI")
    parser.add_argument("--min-column-pixels", type=int, default=None, help="Active x-column threshold for color mode")
    parser.add_argument("--max-color-distance", type=float, default=0.42, help="RGB distance tolerance for color mode")
    parser.add_argument("--ollama-model", default=os.environ.get("OLLAMA_MODEL", "llava:latest"))
    parser.add_argument("--ollama-host", default=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
    parser.add_argument("--prompt-extra", default=None, help="Extra context for the local LLM")
    parser.add_argument("--format", choices=("json", "jaspar", "meme"), default="jaspar")
    parser.add_argument("--counts-scale", type=int, default=100, help="Counts per column for JASPAR output")
    parser.add_argument("--out", default=None, help="Output path. Defaults to stdout.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    crop = parse_crop(args.crop)
    image = load_image(args.input, page=args.page, dpi=args.dpi)

    if args.method == "color":
        motif = extract_pwm_color(
            image,
            positions=args.positions,
            crop=crop,
            min_column_pixels=args.min_column_pixels,
            max_color_distance=args.max_color_distance,
        )
        if args.name:
            motif.name = args.name
        motifs = [motif]
    else:
        motifs = extract_pwm_ollama(
            image,
            model=args.ollama_model,
            host=args.ollama_host,
            crop=crop,
            prompt_extra=args.prompt_extra,
        )
        if args.name and len(motifs) == 1:
            motifs[0].name = args.name

    if args.format == "json":
        text = format_json(motifs)
    elif args.format == "meme":
        text = format_meme(motifs, nsites=args.counts_scale)
    else:
        text = format_jaspar(motifs, counts_scale=args.counts_scale)
    write_output(text, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
