"""File, folder, gene-search, and BAM diagnostic endpoint helpers."""
from __future__ import annotations

import os
import re

from services.bam_diagnostics import diagnose_bam_tags
from services.local_paths import normalize_local_path, path_access_error


def search_gene_payload(state, query: str, chrom: str | None = None) -> dict:
    if not state.gtf_data:
        return {"found": False, "message": "No GTF loaded"}

    tx_df = state.gtf_data["transcripts"]
    if tx_df.empty:
        return {"found": False, "message": "No transcripts"}

    q = query.strip().lower()
    names_lower = tx_df["gene_name"].str.lower()
    match = tx_df[names_lower == q]

    if match.empty:
        q_escaped = re.escape(q)
        partial = tx_df[names_lower.str.contains(q_escaped, na=False)]

        if partial.empty:
            q_alt = q.replace(" ", "-") if " " in q else q.replace("-", " ")
            q_alt_escaped = re.escape(q_alt)
            partial = tx_df[names_lower.str.contains(q_alt_escaped, na=False)]

        if partial.empty:
            words = q.split()
            if len(words) > 1:
                pattern = ".*".join(re.escape(word) for word in words)
                partial = tx_df[names_lower.str.contains(pattern, na=False)]

        if not partial.empty:
            suggestions = sorted(partial["gene_name"].unique().tolist(), key=len)[:10]
            return {"found": False, "suggestions": suggestions}
        return {"found": False, "message": f"Gene '{query}' not found"}

    if chrom:
        from utils.chrom import normalize_chrom_name
        local = match[match['chrom'].map(normalize_chrom_name) == normalize_chrom_name(chrom)]
        if not local.empty:
            match = local
    row = match.iloc[0]
    tss = int(row["start"]) if row["strand"] == "+" else int(row["end"]) - 1  # ends are exclusive
    return {
        "found": True,
        "chrom": str(row["chrom"]),
        "start": max(0, tss - 5000),
        "end": tss + 5000,
        "tss": tss,
        "gene_name": str(row["gene_name"]),
    }


def diagnose_bam_payload(state, *, bam_path=None, dataset_idx: int = 0, chrom=None, limit: int = 10) -> dict:
    if bam_path is None:
        dataset_ids = list(getattr(state, "dataset_order", []) or [])
        if not dataset_ids:
            datasets = getattr(state, "datasets", {})
            dataset_ids = list(datasets.keys()) if isinstance(datasets, dict) else list(range(len(datasets)))
        if dataset_idx < 0 or dataset_idx >= len(dataset_ids):
            return {"error": f"Dataset index {dataset_idx} out of range"}
        dataset_key = dataset_ids[dataset_idx]
        dataset = state.datasets[dataset_key] if isinstance(state.datasets, dict) else state.datasets[dataset_key]
        if dataset.data_type != "bam":
            return {"error": f"Dataset {dataset_key} is not a BAM file (type: {dataset.data_type})"}
        bam_path = dataset.path

    result = diagnose_bam_tags(bam_path, chrom, limit)
    from services.bam_tags import UNVERIFIABLE_FRAME_WARNING, bam_frame_unverifiable

    if "error" not in result:
        recommendations = []
        # Nucleosomes/MSPs may be in legacy ns/nl, as/al tags or only in an
        # MA/Ma annotation tag (current fibertools writes only Ma).
        # An MA/Ma group with no intervals means the calling ran and found none: not "run it".
        has_nucleosomes = bool(result.get("has_nucleosomes") or result.get("has_ma_nucleosomes")
                               or result.get("has_ma_nucleosome_calls"))
        has_msps = bool(result.get("has_msps") or result.get("has_ma_msps") or result.get("has_ma_msp_calls"))
        if not has_nucleosomes and not has_msps:
            recommendations.append(
                "No nucleosome (ns/nl) or FIRE/accessibility (as/al) tags found. "
                "Run 'ft add-nucleosomes' on your BAM file to add these tags."
            )
        if result.get("has_m6a") and not has_nucleosomes:
            recommendations.append(
                "BAM has m6A calls (MM/ML) but no nucleosome calls. "
                "Use 'ft add-nucleosomes' to derive nucleosome positions from m6A data."
            )
        if result.get("fiberseq_missing"):
            recommendations.append(
                f"Missing Fiber-seq tags: {', '.join(result['fiberseq_missing'])}"
            )
        frame = result.get("legacy_tag_frame") or {}
        if frame.get("ambiguous") and (result.get("has_nucleosomes") or result.get("has_msps")):
            votes = frame.get("votes") or {}
            recommendations.append(
                "The @PG history has branches whose last footprint writers disagree on the ns/nl/as/al "
                f"coordinate frame ({votes.get('molecular', 0)} molecular, {votes.get('seq', 0)} SEQ); "
                f"reverse-strand footprints are drawn in {frame.get('frame')} frame. Files merged from "
                "different producers can mix frames; re-call them with one tool if reverse reads look mirrored."
            )
        elif frame.get("source") == "default" and bam_frame_unverifiable(bam_path):
            # FiberHMM's rule (read_has_frame_dependent_annotations): legacy arrays or non-m5C MA groups.
            recommendations.append(
                UNVERIFIABLE_FRAME_WARNING + " "
                "The header does not say which coordinate frame the footprint tags use (no footprint writer in @PG "
                "and no coord=molecular line; a pipeline may have stripped them). ns/nl/as/al are read in "
                "SEQ frame, the FiberHMM v1.0 convention; reads whose MA has FiberHMM >= 2.13.2 footprint groups "
                "(nuc./msp./tf.) use molecular frame. If reverse-strand footprints look mirrored, keep the "
                "producer's @PG/@CO header lines."
            )
        from services.graph_lift import REPAIR_COMMAND, lift_summary_text
        lift = result.get("graph_lift") or {}
        if lift:
            result["graph_lift_text"] = lift_summary_text(lift)
        if lift.get("unrepaired"):
            recommendations.append(
                f"Lifted through a pangenome graph (@PG {', '.join(lift['unrepaired'])}) without fiberhmm-lift's "
                "repair: supplementary alignments lost 0x800 and show as extra reads (FiberBrowser hides only those "
                "that carry evidence of it: an MA/Ma read length longer than SEQ, or fiberhmm-lift stash tags), "
                "hard clips were dropped, MD/NM/SA still describe the source assembly and st:Z was not swapped on reads that "
                f"changed strand. Repair it: {REPAIR_COMMAND}."
            )
        conflicts = int(result.get("st_strand_conflicts") or 0)
        if conflicts:
            recommendations.append(
                f"{conflicts} of {result.get('st_strand_reads', 0)} sampled DAF reads have an st:Z strand tag that "
                "disagrees with the R/Y deamination marks in SEQ. FiberBrowser, like FiberHMM, takes the strand "
                "from st (these reads are flagged in the read tooltip)"
                + ("; the lift left st unswapped on reads that changed strand, which fiberhmm-lift's repair fixes."
                   if lift.get("unrepaired") else ".")
            )
        result["recommendations"] = recommendations

    return result


def load_folder_for_request(state, path: str) -> dict:
    from services.lab.paths import confine
    confine(path)  # a lab server's data roots
    original_path = path
    path = normalize_local_path(path)
    access_error = path_access_error(path, original_path=original_path, expected="directory")
    if access_error:
        return {"success": False, "message": access_error}
    if not os.path.isdir(path):
        return {"success": False, "message": f"Not a valid directory: {path}"}

    has_bigbed = any(
        filename.endswith((".bb", ".bigBed", ".bigbed"))
        for filename in os.listdir(path)
    )
    if not has_bigbed:
        return {"success": False, "message": "No BigBed file found in folder"}

    folder_name = os.path.basename(path)
    dataset_id = folder_name.replace(" ", "_").replace("-", "_").lower()
    dataset = state.add_dataset(dataset_id, path, folder_name)

    return {
        "success": True,
        "dataset_id": dataset.id,
        "label": dataset.label,
        "message": f"Loaded {folder_name}",
    }
