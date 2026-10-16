#!/usr/bin/env python3
"""Benchmark DAF-seq backend hot paths on local daf_timecourse data.

This is intentionally a lightweight developer harness, not a pytest. It skips
cleanly when the local DAF data are absent and prints stable summaries for
read display, clustering, and direct BAM loader timing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BROWSER_DIR = REPO_ROOT / "browser"
sys.path.insert(0, str(BROWSER_DIR))

import server  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


DEFAULT_BAM_NAMES = [
    "stage_b_recalled.bam",
    "stage_c_recalled.bam",
    "stage_d_recalled.bam",
    "stage_e_recalled.bam",
]
DEFAULT_CHROM = "chr2L"
DEFAULT_START = 15474000
DEFAULT_END = 15490000
DEFAULT_PEAK_OFFSETS = [
    (1500, 1800),
    (3000, 3300),
    (12000, 12300),
    (14000, 14300),
]


def default_bam_dir() -> Path:
    return (
        REPO_ROOT.parents[2]
        / "fly_lab_data"
        / "Datasets"
        / "DAF-seq"
        / "daf_timecourse"
        / "fp"
    )


def elapsed_call(fn):
    started = time.perf_counter()
    result = fn()
    return time.perf_counter() - started, result


def resolve_bams(bam_dir: Path, bam_count: int) -> list[Path]:
    bams = [bam_dir / name for name in DEFAULT_BAM_NAMES[:bam_count]]
    missing = [str(path) for path in bams if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing benchmark BAMs: " + ", ".join(missing))
    return bams


def reset_state(bams: list[Path]) -> TestClient:
    server.state = server.BrowserState([str(path) for path in bams], None, None, None)
    return TestClient(server.app)


def cluster_peaks(start: int) -> list[dict[str, Any]]:
    return [
        {"start": start + left, "end": start + right, "mode": "accessibility"}
        for left, right in DEFAULT_PEAK_OFFSETS
    ]


def summarize_read_response(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "count": data.get("count"),
        "total": data.get("total"),
        "working_count": data.get("working_count"),
        "has_methylation": data.get("has_methylation"),
        "available_layers": data.get("available_layers"),
    }


def summarize_cluster_response(data: dict[str, Any]) -> dict[str, Any]:
    primary = data.get("results", {}).get("primary", {})
    return {
        "timings": data.get("timings"),
        "eligible_read_count": primary.get("eligible_read_count"),
        "peak_covering_read_count": primary.get("peak_covering_read_count"),
        "analysis_read_count": primary.get("analysis_read_count"),
        "cluster_counts": primary.get("cluster_counts"),
    }


def summarize_footprint_response(data: dict[str, Any]) -> dict[str, Any]:
    primary = data.get("overlap_stats", {}).get("primary", {})
    first = (primary.get("per_footprint") or [{}])[0]
    return {
        "timings": data.get("timings"),
        "total_reads": primary.get("total_reads"),
        "overlap_count": first.get("overlap_count"),
        "overlap_fraction": first.get("overlap_fraction"),
    }


def run_read_benchmark(args, bams: list[Path]) -> list[dict[str, Any]]:
    client = reset_state(bams)
    rows = []
    for label in ("read_cold", "read_warm"):
        elapsed, response = elapsed_call(
            lambda: client.get(
                "/api/reads/compact",
                params={
                    "chrom": args.chrom,
                    "start": args.start,
                    "end": args.end,
                    "spanning": "false",
                    "dataset_id": "primary",
                    "max_reads": args.max_reads,
                    "include_methylation": str(args.include_marks).lower(),
                    "include_layers": str(args.include_layers).lower(),
                    **({"layer_names": args.layer_names} if args.layer_names else {}),
                },
            )
        )
        response.raise_for_status()
        rows.append({
            "case": label,
            "seconds": round(elapsed, 4),
            **summarize_read_response(response.json()),
        })
    return rows


def run_cluster_benchmark(args, bams: list[Path]) -> list[dict[str, Any]]:
    client = reset_state(bams)
    rows = []
    peaks = cluster_peaks(args.start)
    for label in ("cluster_cold", "cluster_warm"):
        elapsed, response = elapsed_call(
            lambda: client.post(
                "/api/cluster_all",
                params={
                    "chrom": args.chrom,
                    "start": args.start,
                    "end": args.end,
                    "spanning": "false",
                },
                json={
                    "peak_regions": peaks,
                    "k": 0,
                    "method": "combinatorial",
                    "dataset_ids": ["primary"],
                },
            )
        )
        response.raise_for_status()
        rows.append({
            "case": label,
            "seconds": round(elapsed, 4),
            **summarize_cluster_response(response.json()),
        })
    return rows


def run_footprint_benchmark(args, bams: list[Path]) -> list[dict[str, Any]]:
    client = reset_state(bams)
    rows = []
    fp_left, fp_right = DEFAULT_PEAK_OFFSETS[0]
    footprints = [{
        "absStart": args.start + fp_left,
        "absEnd": args.start + fp_right,
        "size": fp_right - fp_left,
        "readId": "benchmark_fp_1",
        "datasetId": "primary",
    }]
    body = {
        "footprints": footprints,
        "dataset_ids": ["primary"],
        "auto_motifs": False,
        "include_sequences": False,
        "include_motifs": False,
        "include_overlap": True,
        "include_profiles": False,
        "include_vplot": False,
        "include_coocc": False,
        "max_reads": None,
    }
    for label in ("footprint_overlap_cold", "footprint_overlap_warm"):
        elapsed, response = elapsed_call(
            lambda: client.post(
                "/api/footprint/analyze",
                params={
                    "chrom": args.chrom,
                    "region_start": args.start,
                    "region_end": args.end,
                    "spanning": "false",
                },
                json=body,
            )
        )
        response.raise_for_status()
        rows.append({
            "case": label,
            "seconds": round(elapsed, 4),
            **summarize_footprint_response(response.json()),
        })
    return rows


def run_loader_benchmark(args, bams: list[Path]) -> list[dict[str, Any]]:
    # Initialize state so chromosome aliases and BAM handles are available.
    reset_state([bams[0]])
    broad_width = (args.end - args.start) * 10
    broad_start = max(0, args.start - (broad_width - (args.end - args.start)) // 2)
    broad_end = broad_start + broad_width
    rows = []
    cases = (
        ("loader_analysis_intervals", False, False),
        ("loader_display_intervals", False, True),
        ("loader_display_with_marks", True, True),
    )
    for case_name, include_marks, include_layers in cases:
        elapsed, reads = elapsed_call(
            lambda include_marks=include_marks, include_layers=include_layers: server.build_compact_reads_from_bam(
                str(bams[0]),
                args.chrom,
                broad_start,
                broad_end,
                spanning_only=False,
                include_methylation=include_marks,
                ml_threshold=125,
                min_fp_quality=0,
                include_layers=include_layers,
            )
        )
        rows.append({
            "case": case_name,
            "seconds": round(elapsed, 4),
            "reads": len(reads),
            "reads_with_marks": sum(1 for read in reads if read.get("methyl") or read.get("deam")),
            "reads_with_layers": sum(1 for read in reads if read.get("layers")),
        })
    return rows


def print_rows(rows: list[dict[str, Any]], as_json: bool) -> None:
    if as_json:
        print(json.dumps(rows, indent=2, sort_keys=True))
        return
    for row in rows:
        print(json.dumps(row, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark DAF backend cold/warm paths")
    parser.add_argument("--bam-dir", type=Path, default=default_bam_dir())
    parser.add_argument("--bam-count", type=int, default=4, choices=range(1, len(DEFAULT_BAM_NAMES) + 1))
    parser.add_argument("--chrom", default=DEFAULT_CHROM)
    parser.add_argument("--start", type=int, default=DEFAULT_START)
    parser.add_argument("--end", type=int, default=DEFAULT_END)
    parser.add_argument("--max-reads", type=int, default=500)
    parser.add_argument("--mode", choices=("all", "read", "cluster", "loader", "footprint"), default="all")
    parser.add_argument("--include-marks", action="store_true", help="Request methyl/deam payloads for read display")
    parser.add_argument("--include-layers", action="store_true", help="Request annotation layer payloads for read display")
    parser.add_argument("--layer-names", default="", help="Comma-separated annotation layers to request, e.g. tf")
    parser.add_argument("--profile-bam", action="store_true", help="Enable FIBERBROWSER_PROFILE_BAM phase logs")
    parser.add_argument("--json", action="store_true", help="Print a single JSON array")
    args = parser.parse_args()

    if args.profile_bam:
        os.environ["FIBERBROWSER_PROFILE_BAM"] = "1"

    try:
        bams = resolve_bams(args.bam_dir, args.bam_count)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    rows: list[dict[str, Any]] = []
    if args.mode in ("all", "loader"):
        rows.extend(run_loader_benchmark(args, bams))
    if args.mode in ("all", "read"):
        rows.extend(run_read_benchmark(args, bams))
    if args.mode in ("all", "cluster"):
        rows.extend(run_cluster_benchmark(args, bams))
    if args.mode in ("all", "footprint"):
        rows.extend(run_footprint_benchmark(args, bams))

    print_rows(rows, args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
