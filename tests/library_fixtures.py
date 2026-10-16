"""Synthetic files for the Library tests: BAMs with FiberHMM-like headers, QC
JSON, fiberhmm-pipeline outputs.json, plasmid maps and a job registry."""
from __future__ import annotations

import hashlib
import json
import os
import random
import time

import pysam

DDDB_DECLARATION = "FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=dddb;platform=nanopore;mode=daf"


def seq(seed: int, length: int = 3000) -> str:
    rng = random.Random(seed)
    return "".join(rng.choice("ACGT") for _ in range(length))


def md5(sequence: str) -> str:
    return hashlib.md5(sequence.upper().encode()).hexdigest()


def make_bam(path, contigs=(("chr2L", 23_513_712), ("chrX", 23_542_271)), *, comments=(), programs=(),
             sample=None, date=None, n_reads=6, index=True, circular=(), m5=None) -> str:
    """A coordinate-sorted BAM of ``n_reads`` reads on the first contig."""
    path = str(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sq = []
    for name, length in contigs:
        row = {"SN": name, "LN": int(length)}
        if name in circular:
            row["TP"] = "circular"
        if m5 and name in m5:
            row["M5"] = m5[name]
        sq.append(row)
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": sq}
    if sample or date:
        rg = {"ID": "rg1"}
        if sample:
            rg["SM"] = sample
        if date:
            rg["DT"] = date
        header["RG"] = [rg]
    if programs:
        header["PG"] = [dict(p) for p in programs]
    if comments:
        header["CO"] = list(comments)
    unsorted = path + ".unsorted.bam"
    with pysam.AlignmentFile(unsorted, "wb", header=header) as out:
        for i in range(n_reads):
            read = pysam.AlignedSegment(out.header)
            read.query_name = f"r{i}"
            read.reference_id = 0
            read.reference_start = 100 + 10 * i
            read.mapping_quality = 60
            read.cigarstring = "50M"
            read.query_sequence = "A" * 50
            read.query_qualities = pysam.qualitystring_to_array("I" * 50)
            out.write(read)
    pysam.sort("-o", path, unsorted)
    os.remove(unsorted)
    if index:
        pysam.index(path)
    return path


def make_fiberhmm_bam(path, **kwargs) -> str:
    kwargs.setdefault("comments", [DDDB_DECLARATION])
    kwargs.setdefault("programs", [{"ID": "fiberhmm-call", "PN": "fiberhmm-call", "VN": "3.0.0",
                                    "CL": "fiberhmm-call -i in.bam -o out.bam"}])
    return make_bam(path, **kwargs)


def make_fibertools_bam(path, **kwargs) -> str:
    kwargs.setdefault("programs", [{"ID": "ft", "PN": "fibertools", "VN": "0.5", "CL": "ft predict-m6a"}])
    return make_bam(path, **kwargs)


def write_qc_json(path, overall="PASS", signal="PASS", periodicity="WARN", duplicate_fraction=0.02,
                  nrl=187.0, curves=True) -> str:
    path = str(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {
        "schema_version": 1,
        "input": "x.bam",
        "overall": {"status": overall, "score": 81.25},
        "signal": {"status": signal, "score": 90.0, "label": "deamination", "median_per_read_rate": 0.21},
        "periodicity": {"status": periodicity, "score": 55.0, "nrl_bp": nrl},
        "footprints": {"median_nucleosome_bp": 147.0},
        "sampling": {"sampled_reads": 5000},
        "deduplication": {"duplicate_fraction": duplicate_fraction},
    }
    with open(path, "w") as handle:
        json.dump(data, handle)
    if curves:
        with open(path[: -len(".qc.json")] + ".qc.curves.json", "w") as handle:
            json.dump({"schema": "fiberhmm.qc.curves.v1", "verdicts": {"overall": overall}}, handle)
    return path


def write_map(path, name: str, sequence: str) -> str:
    lines = [f"LOCUS       {name:<16}{len(sequence)} bp    DNA     circular SYN 01-JAN-2000",
             "FEATURES             Location/Qualifiers",
             "     misc_feature    1..400", '                     /label="ori"', "ORIGIN"]
    for i in range(0, len(sequence), 60):
        lines.append(f"{i + 1:>9} {sequence[i:i + 60].lower()}")
    lines.append("//")
    path = str(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def pipeline_settings(enzyme="dddb", **changed) -> dict:
    """outputs.json "settings" as fiberhmm-pipeline 3.0 writes them for its defaults
    (PipelineConfig.calling_settings), with ``changed`` over them."""
    ddda = enzyme == "ddda"
    daf = enzyme in ("ddda", "dddb")
    settings = {
        "enzyme": enzyme, "seq": "nanopore", "min_mapq": 20, "min_read_length": 1000, "dedup": "auto",
        "dedup_mode": "flag", "snp_screen": "auto", "snp_mask": None, "chimera_filter": True,
        "daf_unaligned_mask": True if daf else None, "daf_insert_consensus": "auto" if daf else None,
        "primary_only": False, "alignments": "primary-supplementary",
        "prob_threshold": "auto", "use_m5c": "auto" if ddda else None,
        "cpg_mask_policy": "unmethylated-only" if ddda else None, "hard_clip": "circular" if daf else "off",
        "origin_merge": True, "qc": True, "tracks": False, "call_args": [],
        "basecaller_override": None,  # FiberHMM 3.0: --basecaller-info / --modbase-model, when given
    }
    settings.update(changed)
    return settings


def legacy_pipeline_settings(enzyme="dddb", **changed) -> dict:
    """outputs.json "settings" as fiberhmm-pipeline wrote them before FiberHMM 3.0 called
    supplementary alignments (no alignments / daf_unaligned_mask / daf_insert_consensus;
    boolean hard_clip, true for DAF; primary_only true by default)."""
    settings = pipeline_settings(enzyme)
    for key in ("alignments", "daf_unaligned_mask", "daf_insert_consensus", "basecaller_override"):
        settings.pop(key)
    settings.update(primary_only=True, hard_clip=enzyme in ("ddda", "dddb"))
    settings.update(changed)
    return settings


def make_pipeline_run(outdir, sample="S1", enzyme="dddb", *, plasmid_seq=None, qc=True) -> dict:
    """What fiberhmm-pipeline leaves in OUTDIR (contract v1)."""
    outdir = str(outdir)
    os.makedirs(outdir, exist_ok=True)
    plasmid_map = None
    if plasmid_seq:
        plasmid_map = write_map(os.path.join(outdir, "pTest.gb"), "pTest", plasmid_seq)
        contigs = (("pTest", len(plasmid_seq)),)
        m5 = {"pTest": md5(plasmid_seq)}
        circular = ("pTest",)
        comments = [DDDB_DECLARATION.replace("dddb", enzyme),
                    f"FIBERHMM-REFERENCE:v1:contig=pTest;length={len(plasmid_seq)};md5={m5['pTest']};"
                    "topology=circular;source=pTest.gb;source_format=genbank"]
    else:
        contigs, m5, circular = (("chr2L", 23_513_712),), None, ()
        comments = [DDDB_DECLARATION.replace("dddb", enzyme)]
    aligned = make_bam(os.path.join(outdir, f"{sample}.aligned.bam"), contigs, m5=m5, circular=circular)
    called = make_fiberhmm_bam(os.path.join(outdir, f"{sample}.fiberhmm.bam"), contigs=contigs, m5=m5,
                               circular=circular, comments=comments)
    qc_block = None
    if qc:
        qc_json = write_qc_json(os.path.join(outdir, "qc", f"{sample}.fiberhmm.qc.json"))
        qc_block = {"json": qc_json, "report": None, "curves": qc_json.replace(".qc.json", ".qc.curves.json"),
                    "verdicts": {"overall": "PASS", "signal": "PASS", "periodicity": "WARN"}}
    outputs = {
        "schema": "fiberhmm.pipeline.outputs.v1", "version": "3.0.0", "sample": sample, "enzyme": enzyme,
        "aligned_bam": aligned, "called_bam": called, "qc_report": None, "qc": qc_block, "tracks": [],
        "reference_fasta": os.path.join(outdir, "reference.fa"), "plasmid_map": plasmid_map,
        "settings": pipeline_settings(enzyme),
        "contigs": [{"name": n, "length": l, "circular": bool(circular), "md5": (m5 or {}).get(n)} for n, l in contigs],
        "open": {"fasta": None, "datasets": [called], "plasmid_maps": [plasmid_map] if plasmid_map else [],
                 "region": None},
    }
    with open(os.path.join(outdir, "outputs.json"), "w") as handle:
        json.dump(outputs, handle)
    return outputs


def make_job(jobs_dir, job_id, outdir, *, status="done", sample="S1", enzyme="dddb", group="g1") -> str:
    folder = os.path.join(str(jobs_dir), job_id)
    os.makedirs(folder, exist_ok=True)
    spec = {"id": job_id, "sample": sample, "enzyme": enzyme, "outdir": str(outdir), "group": group,
            "argv": ["fiberhmm-pipeline"], "reference": {"path": "/ref.fa", "kind": "fasta", "label": "ref.fa"},
            "created": time.time() - 100}
    state = {"status": status, "finished_at": time.time() - 10}
    with open(os.path.join(folder, "spec.json"), "w") as handle:
        json.dump(spec, handle)
    with open(os.path.join(folder, "state.json"), "w") as handle:
        json.dump(state, handle)
    return folder


def tree_snapshot(root) -> dict:
    """Every path under ``root`` with its size and mtime (to prove a scan wrote nothing)."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(str(root)):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            st = os.lstat(path)
            out[path] = (st.st_size, st.st_mtime_ns)
    return out
