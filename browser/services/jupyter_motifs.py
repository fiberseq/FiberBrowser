"""Custom motif helpers for Jupyter API endpoints."""
from __future__ import annotations

import os
from typing import Optional

from services import motifs as motif_service
from services.jupyter_sequences import extract_sequence_regions, resolve_fasta_chrom  # noqa: F401 (re-exported)
from services.lab.paths import open_local_text  # a lab server: motif files confined, by descriptor

REQUIRED_BASES = ("A", "C", "G", "T")


def format_jaspar_motif(motif) -> dict:
    """Format a pyJASPAR motif object for API responses."""
    return {
        "matrix_id": motif.matrix_id,
        "name": motif.name,
        "species": motif.species if hasattr(motif, "species") else None,
        "tf_family": motif.tf_family if hasattr(motif, "tf_family") else None,
        "length": len(motif.counts["A"]) if hasattr(motif, "counts") else motif.length,
    }


def list_available_jaspar_motifs(
    *,
    species: Optional[int] = None,
    tax_group: Optional[str] = None,
    tf_family: Optional[str] = None,
    name_contains: Optional[str] = None,
) -> dict:
    """List available JASPAR motifs with API-compatible error handling."""
    if not motif_service.check_pyjaspar():
        return {
            "success": False,
            "error": "pyjaspar not installed. Run: pip install pyjaspar",
            "motifs": [],
        }

    try:
        jdb = motif_service.get_jaspar_db()
        kwargs = {}
        if species:
            kwargs["species"] = species
        if tax_group:
            kwargs["tax_group"] = [tax_group.lower()]
        if tf_family:
            kwargs["tf_family"] = [tf_family]

        motifs = jdb.fetch_motifs(**kwargs) if kwargs else jdb.fetch_motifs()
        if name_contains:
            name_lower = name_contains.lower()
            motifs = [motif for motif in motifs if name_lower in motif.name.lower()]

        results = [format_jaspar_motif(motif) for motif in motifs]
        return {"success": True, "motifs": results, "count": len(results)}
    except Exception as exc:
        return {"success": False, "error": str(exc), "motifs": []}


def collect_motifs_to_search(req, custom_motifs: dict, logger=print) -> tuple[list, Optional[dict]]:
    """Resolve JASPAR/custom motif requests into searchable PSSMs."""
    motifs_to_search = []

    if req.motifs or req.motif_ids:
        if not motif_service.check_pyjaspar():
            return [], {
                "success": False,
                "error": "pyjaspar not installed. Run: pip install pyjaspar",
                "hits": [],
            }

        jdb = motif_service.get_jaspar_db()
        if req.motifs:
            for name in req.motifs:
                try:
                    matches = jdb.fetch_motifs(name=name)
                    for motif in matches:
                        counts = {base: list(motif.counts[base]) for base in REQUIRED_BASES}
                        motifs_to_search.append((
                            motif.matrix_id,
                            motif.name,
                            motif_service.pwm_to_pssm(counts),
                        ))
                except Exception as exc:
                    logger(f"Warning: Could not find motif '{name}': {exc}")

        if req.motif_ids:
            for motif_id in req.motif_ids:
                try:
                    motif = jdb.fetch_motif_by_id(motif_id)
                    if motif:
                        counts = {base: list(motif.counts[base]) for base in REQUIRED_BASES}
                        motifs_to_search.append((
                            motif.matrix_id,
                            motif.name,
                            motif_service.pwm_to_pssm(counts),
                        ))
                except Exception as exc:
                    logger(f"Warning: Could not find motif ID '{motif_id}': {exc}")

    if req.custom_motifs:
        for name in req.custom_motifs:
            clean_name = name[7:] if name.startswith("custom:") else name
            if clean_name in custom_motifs:
                motif_data = custom_motifs[clean_name]
                pssm = motif_data.get("pssm")
                if pssm is None:
                    pssm = motif_service.pwm_to_pssm(motif_data["counts"])
                    custom_motifs[clean_name]["pssm"] = pssm
                motifs_to_search.append((f"custom:{clean_name}", clean_name, pssm))
            else:
                logger(f"Warning: Custom motif '{clean_name}' not found")

    if not motifs_to_search:
        return [], {
            "success": False,
            "error": "No valid motifs found. Provide motif names, IDs, or custom motifs.",
            "hits": [],
        }

    return motifs_to_search, None


def search_motifs_in_regions(
    regions,
    fa: dict,
    motifs_to_search: list,
    *,
    extend: int,
    threshold: float,
    both_strands: bool,
    circular_chrom_sizes: Optional[dict[str, int]] = None,
) -> list[dict]:
    """Search resolved motifs over resolved sequence regions.

    Sequences come from the same extraction as /api/jupyter/sequences, so a
    region on a circular contig reads across the origin; hits are reported in
    that region's coordinates.
    """
    all_hits = []
    for region in regions:
        extracted = extract_sequence_regions(
            [region], fa, extend=extend, include_missing=False,
            circular_chrom_sizes=circular_chrom_sizes,
        )
        if not extracted or not extracted[0].get("sequence"):
            continue
        chrom = region.chrom
        start, end, seq = extracted[0]["start"], extracted[0]["end"], extracted[0]["sequence"]
        name = region.name or f"{chrom}:{start}-{end}"

        for motif_id, motif_name, pssm in motifs_to_search:
            if both_strands:
                hits = motif_service.scan_both_strands(seq, pssm, threshold)
            else:
                hits = motif_service.scan_sequence(seq, pssm, threshold)
                for hit in hits:
                    hit["strand"] = "+"

            for hit in hits:
                all_hits.append({
                    "region": name,
                    "chrom": chrom,
                    "region_start": start,
                    "region_end": end,
                    "motif_id": motif_id,
                    "motif_name": motif_name,
                    "start": start + hit["start"],
                    "end": start + hit["end"],
                    "strand": hit["strand"],
                    "score": hit["score"],
                    "rel_score": hit["rel_score"],
                    "matched_seq": hit["matched_seq"],
                })

    return all_hits


def validate_custom_motif_counts(counts: dict) -> tuple[bool, Optional[str], int]:
    """Validate a custom PWM count dictionary."""
    for base in REQUIRED_BASES:
        if base not in counts:
            return False, f"Missing counts for base '{base}'", 0

    lengths = [len(counts[base]) for base in REQUIRED_BASES]
    if len(set(lengths)) != 1:
        return (
            False,
            "All base count lists must have same length. "
            f"Got: A={lengths[0]}, C={lengths[1]}, G={lengths[2]}, T={lengths[3]}",
            0,
        )

    if lengths[0] == 0:
        return False, "PWM cannot be empty", 0

    return True, None, lengths[0]


def register_custom_motif(jupyter_state, name: str, counts: dict) -> dict:
    """Validate and store a custom motif on the Jupyter state."""
    valid, error, length = validate_custom_motif_counts(counts)
    if not valid:
        return {"success": False, "error": error}

    jupyter_state.custom_motifs[name] = {
        "counts": counts,
        "pssm": motif_service.pwm_to_pssm(counts),
        "length": length,
    }
    jupyter_state.version += 1

    return {
        "success": True,
        "name": name,
        "length": length,
        "message": f"Custom motif '{name}' registered",
    }


def delete_custom_motif(jupyter_state, name: str) -> dict:
    """Remove a custom motif from Jupyter state."""
    if name not in jupyter_state.custom_motifs:
        return {"success": False, "error": f"Custom motif '{name}' not found"}

    del jupyter_state.custom_motifs[name]
    jupyter_state.version += 1
    return {"success": True, "message": f"Custom motif '{name}' removed"}


def list_custom_motifs(custom_motifs: dict) -> dict:
    """Return custom motifs in the API list shape."""
    motifs = [
        {"name": name, "length": data.get("length", len(data["counts"]["A"]))}
        for name, data in custom_motifs.items()
    ]
    return {"success": True, "motifs": motifs, "count": len(motifs)}


def detect_motif_file_format(file_path: str, requested_format: str = "auto") -> str:
    """Resolve auto/JASPAR/MEME motif file format."""
    fmt = requested_format.lower()
    if fmt != "auto":
        return fmt

    ext = os.path.splitext(file_path)[1].lower()
    if ext in [".jaspar", ".pfm", ".txt"]:
        return "jaspar"
    if ext == ".meme":
        return "meme"

    with open_local_text(file_path) as handle:
        first_line = handle.readline()
    if first_line.startswith(">"):
        return "jaspar"
    if "MEME" in first_line:
        return "meme"
    return "jaspar"


def load_custom_motif_file(jupyter_state, file_path: str, requested_format: str) -> dict:
    """Parse and register custom motifs from a motif file."""
    if not os.path.exists(file_path):
        return {"success": False, "error": f"File not found: {file_path}"}

    fmt = detect_motif_file_format(file_path, requested_format)
    try:
        if fmt == "jaspar":
            motifs = motif_service.parse_jaspar_file(file_path)
        elif fmt == "meme":
            motifs = motif_service.parse_meme_file(file_path)
        else:
            return {"success": False, "error": f"Unsupported format: {fmt}"}

        loaded = []
        for name, data in motifs.items():
            jupyter_state.custom_motifs[name] = {
                "counts": data["counts"],
                "pssm": motif_service.pwm_to_pssm(data["counts"]),
                "length": len(data["counts"]["A"]),
            }
            loaded.append(name)

        jupyter_state.version += 1
        return {"success": True, "loaded": loaded, "count": len(loaded), "format": fmt}

    except Exception as exc:
        return {"success": False, "error": f"Failed to parse file: {str(exc)}"}
