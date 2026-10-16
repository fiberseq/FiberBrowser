#!/usr/bin/env python3
"""A stand-in for ``fiberhmm-pipeline`` that follows the FiberBrowser contract (v1).

Used by tests/test_pipeline_jobs.py and the Playwright spec daf-run.spec.ts
(``FIBERBROWSER_PIPELINE_COMMAND="python tests/fake_fiberhmm_pipeline.py"``).
It parses the contract's arguments, writes JSON-lines progress, and on
success an outputs.json whose dataset is a copy of the tracked demo BAM plus a
synthetic fiberhmm-qc JSON and curves file. It records its argv in
OUTDIR/fake_argv.json.

Raw Nanopore input (a .pod5 file or a folder holding one) adds the FiberHMM 3.0
"basecall" step first: running events with only a message, then done with a read
count; outputs.json then has basecalled_bam, basecall and settings.basecaller
(dorado 2.0.1, sup v5.2.0, 6mA v1 for hia5, no modbase model for DAF).

Environment:
  FAKE_PIPELINE_MODE    ok (default) | fail | noaligner | crash | nodorado
  FAKE_PIPELINE_STEP_S  seconds per step (default 0.2)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO_BAM = os.path.join(os.path.dirname(HERE), "browser", "data", "demo", "napa_ddda.bam")
STEPS = ["prepare_reference", "index", "align", "call", "qc"]


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fiberhmm-pipeline")
    p.add_argument("reads", nargs="+")
    p.add_argument("--reference", required=True)
    p.add_argument("--enzyme", required=True, choices=["ddda", "dddb", "hia5"])
    p.add_argument("-o", "--outdir", required=True)
    p.add_argument("--sample", default=None)
    p.add_argument("-c", "--cores", type=int, default=4)
    p.add_argument("--progress-json", default=None)
    p.add_argument("--region", action="append", default=[])
    p.add_argument("--dedup", choices=["auto", "on", "off"], default="auto")
    p.add_argument("--dedup-mode", choices=["flag", "collapse"], default="flag")
    p.add_argument("--snp-screen", choices=["auto", "on", "off"], default="auto")
    p.add_argument("--snp-mask", default=None)
    p.add_argument("--chimera-filter", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--primary", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--prob-threshold", type=int, default=None)
    p.add_argument("--use-m5c", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--cpg-mask-policy", choices=["unmethylated-only", "methylated-only"],
                   default="unmethylated-only")
    p.add_argument("--alignments", default=None)
    p.add_argument("--basecaller-info", default=None)
    p.add_argument("--modbase-model", action="append", default=[])
    p.add_argument("--dorado", default=None)
    p.add_argument("--dorado-model", default=None)
    p.add_argument("--dorado-modified-bases", default=None)
    p.add_argument("--dorado-modbase-models", default=None)
    p.add_argument("--dorado-device", default="auto")
    p.add_argument("--dorado-batchsize", type=int, default=None)
    p.add_argument("--dorado-models-dir", default=None)
    p.add_argument("--dorado-args", default=None)
    p.add_argument("--redo", default=None)
    return p


MODEL = "dna_r10.4.1_e8.2_400bps_sup@v5.2.0"


def is_raw(path: str) -> bool:
    if os.path.isdir(path):
        return any(name.endswith(".pod5") for _root, _dirs, files in os.walk(path) for name in files)
    return path.lower().endswith((".pod5", ".fast5"))


class Progress:
    def __init__(self, path):
        self.handle = open(path, "a", encoding="utf-8") if path else None

    def emit(self, **event):
        event.setdefault("time", round(time.time(), 3))
        if self.handle:
            self.handle.write(json.dumps(event) + "\n")
            self.handle.flush()


QUANTILE_P = [0.05, 0.25, 0.5, 0.75, 0.95]


def synthetic_qc(outdir: str, sample: str, enzyme: str) -> str:
    qc_dir = os.path.join(outdir, "qc")
    os.makedirs(qc_dir, exist_ok=True)
    prefix = os.path.join(qc_dir, f"{sample}.fiberhmm")
    rates = sorted(0.02 + 0.03 * (i / 199) ** 1.3 for i in range(200))
    msp_rates = sorted(0.34 + 0.16 * (i / 199) for i in range(200))
    outside_rates = sorted(0.05 + 0.06 * (i / 199) for i in range(200))
    lags = list(range(1001))
    curve = [1.0 + (0.08 * math.cos(2 * math.pi * lag / 190) * math.exp(-lag / 700) if lag >= 60 else 0) for lag in lags]
    edges = list(range(0, 2010, 10))
    nuc = [max(0.0, math.exp(-((e - 150) / 40) ** 2)) for e in edges[:-1]]
    total = sum(nuc) or 1
    nuc_frac = [v / total for v in nuc]
    curves = {
        "schema": "fiberhmm.qc.curves.v1",
        "assay": {"mode": "daf", "enzyme": enzyme, "reference_profile": enzyme},
        "verdicts": {"overall": "PASS", "overall_score": 82.0, "signal": "PASS", "signal_score": 85.0,
                     "periodicity": "PASS", "periodicity_score": 79.0, "efficiency": "PASS",
                     "efficiency_score": 84.0, "background": "PASS", "background_score": 88.0,
                     "verdict_basis": "state-aware"},
        # fiberhmm-qc 3.0: per-read in-MSP / outside-MSP rates and the reference quantiles.
        "state_rates": {"source": "tags", "min_msp_bp": 85,
                        "msp_per_read_rates": msp_rates, "outside_msp_per_read_rates": outside_rates,
                        "reference": {"msp": {"probabilities": QUANTILE_P, "quantiles": [0.33, 0.38, 0.42, 0.46, 0.51]},
                                      "outside_msp": {"probabilities": QUANTILE_P,
                                                      "quantiles": [0.05, 0.07, 0.085, 0.10, 0.12]}}},
        "signal_rate": {"label": "deamination", "per_read_rates": rates,
                        "ecdf": [(i + 1) / len(rates) for i in range(len(rates))],
                        "reference_ecdf": {"rates": [0.015 + 0.04 * p / 100 for p in range(1, 100)],
                                           "probabilities": [p / 100 for p in range(1, 100)],
                                           "source": "packaged control curve"},
                        "warn_interval": [0.01, 0.07], "reference_iqr": [0.02, 0.041]},
        "phasogram": {"lags_bp": lags, "detrended_pair_frequency": curve, "nrl_bp": 190,
                      "reference": {"lags_bp": list(range(60, 801)),
                                    "detrended_pair_frequency": [1 + 0.1 * math.cos(2 * math.pi * lag / 188)
                                                                 for lag in range(60, 801)]}},
        "footprint_sizes": {
            "nucleosome": {"bin_edges_bp": edges, "sample_fraction_per_bin": nuc_frac, "sample_n": 5000,
                           "sample_count_per_bin": [round(v * 5000) for v in nuc_frac], "sample_overflow": 0,
                           "reference_fraction_per_bin": nuc_frac},
            "tf": {"bin_edges_bp": list(range(0, 505, 5)), "sample_fraction_per_bin": [0.01] * 100,
                   "sample_n": 800, "sample_count_per_bin": [8] * 100, "sample_overflow": 0,
                   "reference_fraction_per_bin": None},
        },
        "duplicates": {"duplicate_fraction": 0.12, "molecule_cluster_size_histogram": {"1": 3000, "2": 200}},
    }
    with open(prefix + ".qc.curves.json", "w", encoding="utf-8") as handle:
        json.dump(curves, handle)
    qc = {
        "schema_version": 1,
        "assay": {"mode": "daf", "enzyme": enzyme, "reference_profile": enzyme,
                  "reference_label": "Drosophila embryo DddB DAF-seq control"},
        "overall": {"status": "PASS", "score": 82.0, "components": ["efficiency", "background", "periodicity"],
                    "verdict_basis": "state-aware"},
        "efficiency": {"metric": "median per-read in-MSP rate", "value": 0.42, "score": 84.0, "status": "PASS",
                       "note": "", "n_rate_reads": 200, "pass_min": 0.38, "warn_min": 0.33,
                       "reference_median": 0.42, "reference_source": "tags"},
        "background": {"metric": "median per-read outside-MSP rate", "value": 0.08, "score": 88.0,
                       "status": "PASS", "note": "", "n_rate_reads": 200, "pass_max": 0.10, "warn_max": 0.12,
                       "reference_median": 0.085, "reference_source": "tags"},
        "state_rates": {
            "available": True, "source": "tags", "definition": {"min_msp_bp": 85},
            "msp": {"median_per_read_rate": 0.42, "aggregate_rate": 0.418, "n_events": 41800,
                    "n_opportunities": 100000, "n_rate_reads": 200},
            "outside_msp": {"median_per_read_rate": 0.08, "aggregate_rate": 0.081, "n_events": 16200,
                            "n_opportunities": 200000, "n_rate_reads": 200},
            "all_states": {"aggregate_rate": 0.194, "n_events": 58000, "n_opportunities": 300000},
            "msp_to_outside_ratio": 5.16, "msp_length_fraction": 0.22,
            "median_per_read_msp_length_fraction": 0.21,
            "reads": {"reads_considered": 1000, "reads_with_calls": 1000, "reads_used": 1000},
            "tag_producer": {"program": "fiberhmm-call", "version": "3.0.0"},
            "reference": {"msp_to_outside_ratio": 4.9, "all_states_rate": 0.18,
                          "median_per_read_msp_length_fraction": 0.2},
        },
        "signal": {"label": "deamination", "status": "PASS", "score": 85.0, "median_per_read_rate": 0.031,
                   "q25_per_read_rate": 0.024, "q75_per_read_rate": 0.04, "n_rate_reads": 200},
        "periodicity": {"status": "PASS", "score": 79.0, "nrl_bp": 190, "autocorrelation_strength": 0.21,
                        "reference_curve_correlation": 0.93, "reference_pattern_amplitude_ratio": 0.9},
        "footprints": {"n_tagged_reads": 1000, "n_nucleosomes": 5000, "n_tf_footprints": 800,
                       "median_nucleosome_bp": 150.0, "median_tf_footprint_bp": 25.0,
                       "fraction_nucleosome_85_250_bp": 0.8},
        "deduplication": {"duplicate_fraction": 0.12, "mode": "flag", "detected": True, "full_run": True},
        "variant_masking": {"applied": False, "n_masked_sites": 0, "note": "not run"},
        "sampling": {"sampled_reads": 1000},
        "outputs": {"json": prefix + ".qc.json", "curves": prefix + ".qc.curves.json", "plot": None, "pdf": None},
    }
    with open(prefix + ".qc.json", "w", encoding="utf-8") as handle:
        json.dump(qc, handle)
    return prefix + ".qc.json"


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    mode = os.environ.get("FAKE_PIPELINE_MODE", "ok")
    step_s = float(os.environ.get("FAKE_PIPELINE_STEP_S", "0.2"))
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    sample = args.sample or "sample"
    with open(os.path.join(outdir, "fake_argv.json"), "w", encoding="utf-8") as handle:
        json.dump(sys.argv, handle)
    progress = Progress(args.progress_json)

    def cancelled(signum, frame):
        progress.emit(event="done", status="error", error="cancelled")
        sys.exit(130)

    signal.signal(signal.SIGTERM, cancelled)
    raw = any(is_raw(path) for path in args.reads)
    steps = (["basecall"] if raw else []) + STEPS
    progress.emit(event="start", version="3.0.0-fake", sample=sample, steps=steps, outdir=outdir,
                  settings={"dedup": args.dedup, "snp_screen": args.snp_screen, "primary": args.primary})
    basecall = None
    basecalled = None
    if raw:
        progress.emit(event="step", step="basecall", status="running", message="looking for dorado")
        if mode == "nodorado":
            progress.emit(event="done", status="error", error="dorado was not found",
                          hint="The input contains raw Nanopore signal (POD5), which must be basecalled with\n"
                               "Oxford Nanopore's dorado first, and dorado was not found. Install it:\n"
                               "  https://github.com/nanoporetech/dorado")
            print("fiberhmm-pipeline: error: dorado was not found", file=sys.stderr)
            return 2
        marker = os.path.join(outdir, ".fiberhmm-pipeline", "basecall.done")
        mods = args.dorado_modified_bases or ("6mA" if args.enzyme == "hia5" else None)
        mods = None if mods == "none" else mods
        model = args.dorado_model or "sup"
        basecalled = os.path.join(outdir, f"{sample}.basecalled.bam")
        if os.path.exists(marker):
            progress.emit(event="step", step="basecall", status="skipped", message="already complete")
        else:
            progress.emit(event="step", step="basecall", status="running", message=f"dorado 2.0.1, model {model}")
            time.sleep(step_s / 2)
            progress.emit(event="step", step="basecall", status="running", message="dorado 2.0.1: 12 MB written, 1 s")
            time.sleep(step_s / 2)
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            open(marker, "w").close()
            shutil.copyfile(DEMO_BAM, basecalled)
            progress.emit(event="step", step="basecall", status="done", done=40, unit="reads",
                          message=f"40 reads basecalled with dorado 2.0.1 ({model}"
                                  + (f", modified bases {mods}" if mods else ", no modification model") + ") in 1 s")
        basecall = {"reads": 40, "message": "40 reads basecalled", "dorado": args.dorado or "/usr/local/bin/dorado",
                    "dorado_version": "2.0.1", "command": f"dorado basecaller {model} {args.reads[0]}"
                    + (f" --modified-bases {mods}" if mods else ""), "model": model,
                    "modified_bases": mods.split() if mods else None, "modbase_models": None,
                    "device": args.dorado_device, "batchsize": args.dorado_batchsize, "resumed": False,
                    "log": os.path.join(outdir, "logs", "dorado.log")}
    if mode == "crash":
        os._exit(3)
    if mode == "noaligner":
        progress.emit(event="step", step="prepare_reference", status="running")
        progress.emit(event="done", status="error", error="minimap2 not found",
                      hint="brew install minimap2")
        return 2
    for step in STEPS:
        if step == "basecall":
            continue
        marker = os.path.join(outdir, ".fiberhmm-pipeline", f"{step}.done")
        if os.path.exists(marker):
            progress.emit(event="step", step=step, status="skipped", message="complete")
            continue
        total = 4000 if step == "align" else None
        progress.emit(event="step", step=step, status="running", done=0 if total else None, total=total,
                      unit="reads" if total else None)
        for i in range(1, 5):
            time.sleep(step_s / 4)
            if total:
                progress.emit(event="step", step=step, status="running", done=i * total // 4, total=total,
                              unit="reads", rate=1000.0, eta_s=round(step_s * (4 - i) / 4, 2))
        if mode == "fail" and step == "call":
            progress.emit(event="log", level="warning", message="fiberhmm-call failed")
            progress.emit(event="done", status="error", error="fiberhmm-call failed (exit 1)")
            print("fiberhmm-call: error: something broke", file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        open(marker, "w").close()
        progress.emit(event="step", step=step, status="done")
    called = os.path.join(outdir, f"{sample}.fiberhmm.bam")
    aligned = os.path.join(outdir, f"{sample}.aligned.bam")
    for target in (called, aligned):
        if not os.path.exists(target):
            shutil.copyfile(DEMO_BAM, target)
            shutil.copyfile(DEMO_BAM + ".bai", target + ".bai")
    qc_json = synthetic_qc(outdir, sample, args.enzyme)
    override = {}
    for pair in (args.basecaller_info or "").split():
        key, _, value = pair.partition("=")
        override[{"model": "basecall_model"}.get(key, key)] = value
    if args.modbase_model:
        override["modbase_models"] = [] if args.modbase_model == ["none"] else ",".join(args.modbase_model).split(",")
    provenance = {"available": False, "program": None, "version": None, "basecall_model": None,
                  "modbase_models": None, "sources": {}, "inputs": []}
    if raw:
        mods = basecall["modified_bases"]
        provenance = {"available": True, "platform": "nanopore", "program": "dorado", "version": "2.0.1",
                      "basecall_model": MODEL, "modbase_models": [f"{MODEL}_{m}@v1" for m in mods] if mods else [],
                      "sources": {"program": "pg", "version": "pg", "basecall_model": "rg_ds",
                                  "modbase_models": "rg_ds"}, "mixed": [], "notes": [], "inputs": []}
    for key, value in override.items():
        provenance[key] = value
        provenance["available"] = True
        provenance.setdefault("sources", {})[key] = "override"
    outputs = {
        "schema": "fiberhmm.pipeline.outputs.v1", "sample": sample, "enzyme": args.enzyme,
        "aligned_bam": aligned, "called_bam": called, "qc_report": None,
        "qc": {"json": qc_json, "report": None, "plots": {}, "verdicts": {
            "overall": "PASS", "efficiency": "PASS", "background": "PASS", "verdict_basis": "state-aware",
            "state_rates": {"source": "tags", "overall_rate": 0.194, "msp_rate": 0.42, "outside_msp_rate": 0.08,
                            "msp_to_outside_ratio": 5.16, "msp_length_fraction": 0.22, "min_msp_bp": 85}}},
        "tracks": [], "reference_fasta": None, "plasmid_map": None, "contigs": [],
        "open": {"fasta": None, "datasets": [called], "plasmid_maps": [],
                 "region": args.region[0] if args.region else "chr19:47514000-47518000"},
        "settings": {"enzyme": args.enzyme, "basecaller": provenance, "basecaller_override": override or None},
        "basecalled_bam": basecalled, "basecall": basecall, "stats": {"basecall": basecall},
    }
    with open(os.path.join(outdir, "outputs.json"), "w", encoding="utf-8") as handle:
        json.dump(outputs, handle, indent=2)
    progress.emit(event="done", status="ok", outputs=outputs)
    print(f"done: {called}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
