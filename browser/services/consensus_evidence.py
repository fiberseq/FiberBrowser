"""Regional evidence loading shared by the Browser consensus workflow.

Loads every regional observation for a dataset (BAM or a BigBed bundle that
preserves hard modification events) through the same FiberHMM inference
primitives used by ``fiberhmm-strand-rescue``, and provides the amplification
projection helpers that map retained representative molecules back to their
member reads. BAM and BigBed are capability peers: BigBed is accepted when its
companion bundle preserves the hard modification events, ordinary
TF/nucleosome/MSP calls, read span/strand, and a matching Browser reference.
Unsupported bundles fail with a list of missing evidence rather than a generic
file-format error.

Evidence loading for footprint-class (consensus) runs.
"""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds
from collections import Counter, defaultdict
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
from typing import Mapping, Optional, Sequence

import numpy as np

from services.bigbed_detection import (
    detect_bigbed_autosql_sample,
    detect_overlay_type,
)
from services.bigbed_handles import get_bigbed_handle
from services.bam_handles import get_bam_handle
from services.fiberhmm_runtime import configure_fiberhmm_runtime
from utils.chrom import get_chrom_variants, resolve_reference_name


class ConsensusEvidenceInputError(ValueError):
    """Actionable evidence/configuration error for regional evidence loading."""


def _runtime():
    configure_fiberhmm_runtime()
    from fiberhmm.core.bam_reader import encode_from_query_sequence
    from fiberhmm.core.model_io import load_model_with_metadata
    from fiberhmm.inference.strand_rescue import (
        PRESETS,
        IntervalCall,
        ReadEvidence,
        analyze_strand_rescue,
        calibrate_cohort_efficiency,
        collapse_amplified_reads,
        discover_sites,
        load_region_evidence,
        resolve_resource_path,
    )
    from fiberhmm.inference.tf_recaller import build_llr_tables

    return {
        "encode": encode_from_query_sequence,
        "load_model": load_model_with_metadata,
        "PRESETS": PRESETS,
        "IntervalCall": IntervalCall,
        "ReadEvidence": ReadEvidence,
        "analyze": analyze_strand_rescue,
        "calibrate": calibrate_cohort_efficiency,
        "collapse": collapse_amplified_reads,
        "discover": discover_sites,
        "load_bam": load_region_evidence,
        "resolve_resource": resolve_resource_path,
        "build_llr": build_llr_tables,
    }


def _flatten_paths(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (str, os.PathLike)):
        return [str(value)]
    result: list[str] = []
    for item in value:
        result.extend(_flatten_paths(item))
    return result


def _dataset_bigbed_layer_paths(dataset) -> dict[str, list[str]]:
    paths = _flatten_paths(getattr(dataset, "paths", ()))
    paths.extend(_flatten_paths(getattr(dataset, "path", None)))
    for companion_paths in (getattr(dataset, "companion_layers", {}) or {}).values():
        paths.extend(_flatten_paths(companion_paths))
    result: dict[str, list[str]] = defaultdict(list)
    seen: set[str] = set()
    for path in paths:
        if path in seen or not path.lower().endswith((".bb", ".bigbed")):
            continue
        seen.add(path)
        layer = detect_overlay_type(path)
        if layer == "fire":
            layer = "msp"
        if layer == "unknown":
            layer = "footprint"
        result[layer].append(path)
    return dict(result)


def _sample_key(path: str, layer: str) -> str:
    declared = detect_bigbed_autosql_sample(path)
    if declared:
        return declared
    stem = Path(path).stem
    lowered = stem.lower()
    for suffix in (f"_{layer}", f".{layer}"):
        if lowered.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def _bundle_key(path: str) -> str:
    """The folder a BigBed bundle's files live in (URLs without their query)."""
    return os.path.dirname(str(path).split("?", 1)[0])


def _matching_bigbed_chrom(handle, chrom: str) -> Optional[str]:
    available = handle.chroms() or {}
    for variant in get_chrom_variants(chrom):
        if variant in available:
            return variant
    return None


def _resolve_bam_fetch_region(
    path: str,
    chrom: str,
    start: int,
    end: int,
    links: Optional[Mapping[str, str]] = None,
) -> tuple[str, int, int, int]:
    """Resolve a Browser contig/window against one BAM header.

    ``links``: this file's plasmid links in the caller's workspace
    (``services.plasmid_reconcile.contig_links``): a contig linked to
    ``chrom`` is used whatever its name; one linked elsewhere never is.

    Browser datasets may mix ``chr1``/``1`` (and Drosophila/Roman-numeral)
    naming conventions. The ordinary compact-read loader resolves those
    aliases before fetching; targeted FiberHMM evidence must do the same.
    Clipping to the individual BAM's declared contig length also prevents
    htslib ``parse_region`` failures at assembly boundaries.
    """
    handle = get_bam_handle(path)
    label = os.path.basename(path) or path
    if handle is None:
        raise ConsensusEvidenceInputError(
            f"Could not open BAM evidence file {label!r}. Check that the path and "
            "BAM index are readable."
        )

    try:
        references = tuple(handle.references or ())
        reference_lengths = {
            name: int(length)
            for name, length in zip(references, tuple(handle.lengths or ()))
        }
    except Exception as error:
        raise ConsensusEvidenceInputError(
            f"Could not inspect the BAM header for {label!r}: {error}"
        ) from error

    candidates: list[str] = []
    for candidate in (chrom, *get_chrom_variants(chrom)):
        if candidate not in candidates:
            candidates.append(candidate)
    actual_chrom = resolve_reference_name(chrom, references, links=dict(links or {}))
    if actual_chrom is None:
        examples = ", ".join(references[:6]) or "none"
        raise ConsensusEvidenceInputError(
            f"BAM {label!r} has no contig matching {chrom!r} "
            f"(tried {', '.join(candidates)}; first BAM contigs: {examples})."
        )

    contig_length = reference_lengths[actual_chrom]
    requested_start = int(start)
    requested_end = int(end)
    fetch_start = max(0, min(requested_start, contig_length))
    fetch_end = max(0, min(requested_end, contig_length))
    if fetch_end <= fetch_start:
        raise ConsensusEvidenceInputError(
            f"The requested evidence window {chrom}:{requested_start}-{requested_end} "
            f"does not overlap BAM {label!r} contig {actual_chrom} "
            f"(length {contig_length:,} bp)."
        )
    return actual_chrom, fetch_start, fetch_end, contig_length


def _select_bam_evidence_read_names(
    path: str,
    chrom: str,
    start: int,
    end: int,
    *,
    selection_start: int,
    selection_end: int,
    maximum_reads: int,
    preferred_read_ids: Sequence[str] = (),
) -> tuple[list[str], dict]:
    """Choose a deterministic, viewport-relevant BAM evidence cohort.

    A coordinate-sorted ``fetch`` cap selects reads by alignment start. In a
    deep targeted amplicon that can be disjoint from every molecule displayed
    under Browser's spanning filter. Prefer the exact visible read IDs, then
    molecules spanning the analysis viewport, then a stable hash sample of the
    remaining regional molecules.
    """
    handle = get_bam_handle(path)
    label = os.path.basename(path) or path
    if handle is None:
        raise ConsensusEvidenceInputError(
            f"Could not open BAM evidence file {label!r}."
        )

    preferred_order: dict[str, int] = {}
    for read_id in preferred_read_ids:
        name = str(read_id or "")
        if name and name not in preferred_order:
            preferred_order[name] = len(preferred_order)

    candidates: dict[str, tuple] = {}
    spanning_names: set[str] = set()
    records_scanned = 0
    try:
        from services.signal_evidence import record_keeps_signal, signal_header
        provenance = signal_header(getattr(handle, "header", None))
        from services.graph_lift import lift_hidden_predicate
        lift_hidden = lift_hidden_predicate(getattr(handle, "header", None))
        iterator = handle.fetch(chrom, int(start), int(end))
        for ordinal, read in enumerate(iterator):
            records_scanned = ordinal + 1
            if read.is_unmapped or read.is_secondary or read.is_supplementary:
                continue
            if lift_hidden is not None and lift_hidden(read):
                continue
            if not record_keeps_signal(read, provenance):
                continue
            if int(read.mapping_quality) < 20:
                continue
            name = str(read.query_name or "")
            if not name:
                continue
            ref_start = int(read.reference_start)
            ref_end = int(read.reference_end or ref_start)
            spans = ref_start <= int(selection_start) and ref_end >= int(selection_end)
            if spans:
                spanning_names.add(name)
            stable_rank = hashlib.blake2b(
                f"{name}\0{ref_start}\0{ref_end}\0{int(read.flag)}".encode("utf-8"),
                digest_size=8,
            ).digest()
            if name in preferred_order:
                rank = (0, preferred_order[name], stable_rank, ordinal)
            elif spans:
                rank = (1, stable_rank, ordinal)
            else:
                rank = (2, stable_rank, ordinal)
            previous = candidates.get(name)
            if previous is None or rank < previous:
                candidates[name] = rank
    except (OSError, ValueError) as error:
        raise ConsensusEvidenceInputError(
            f"Could not select BAM evidence reads from {label!r} at "
            f"{chrom}:{start}-{end}: {error}"
        ) from error

    ordered = sorted(candidates, key=lambda name: candidates[name])
    selected = ordered[: max(0, int(maximum_reads))]
    selected_set = set(selected)
    diagnostics = {
        "selection_mode": "preferred_then_viewport_spanning_then_stable_sample",
        "selection_records_scanned": records_scanned,
        "selection_candidate_read_names": len(candidates),
        "selection_spanning_read_names": len(spanning_names),
        "selection_preferred_read_names_requested": len(preferred_order),
        "selection_preferred_read_names_found": sum(
            name in candidates for name in preferred_order
        ),
        "selection_preferred_read_names_selected": sum(
            name in selected_set for name in preferred_order
        ),
        "selection_spanning_read_names_selected": sum(
            name in selected_set for name in spanning_names
        ),
        "selection_read_names": len(selected),
    }
    return selected, diagnostics


def _parse_int_array(value: str) -> list[int]:
    value = value.rstrip(",").strip()
    if not value or value == ".":
        return []
    return [int(item) for item in value.split(",") if item]


@dataclass
class _BigBedRead:
    name: str
    sample: str
    alignment_strand: str
    ref_start: int
    ref_end: int
    calls: dict[str, list[tuple[int, int, tuple[int, ...]]]] = field(
        default_factory=lambda: defaultdict(list)
    )
    marks: dict[str, list[tuple[int, int, int]]] = field(
        default_factory=lambda: defaultdict(list)
    )


_CALL_QUALITY_COLUMNS = {
    "tf": 3,
    "footprint": 3,
    "msp": 1,
}


def _load_bigbed_rows(
    layer_paths: Mapping[str, Sequence[str]],
    *,
    chrom: str,
    start: int,
    end: int,
) -> tuple[list[_BigBedRead], dict]:
    records: dict[tuple, _BigBedRead] = {}
    samples_by_layer: dict[str, set[str]] = defaultdict(set)
    rows_by_layer: Counter = Counter()
    # Two bundles of one merged dataset (e.g. /A/sample_*.bb and /B/sample_*.bb)
    # hold different molecules even when their sample and read names agree:
    # the folder is part of a molecule's identity (as in the compact loader's
    # per-sample merge); a bundle's own companion layers still join.
    many_bundles = len({
        _bundle_key(path) for paths in layer_paths.values() for path in paths
    }) > 1

    for layer, paths in sorted(layer_paths.items()):
        for path in paths:
            sample = _sample_key(path, layer)
            if many_bundles:
                sample = f"{_bundle_key(path)}/{sample}"
            samples_by_layer[layer].add(sample)
            try:
                handle = get_bigbed_handle(path)
                matching_chrom = _matching_bigbed_chrom(handle, chrom) if handle else None
                entries = (
                    bigbed_entries_in_bounds(handle, matching_chrom, start, end)
                    if handle is not None and matching_chrom is not None
                    else None
                )
            except Exception as error:
                raise ConsensusEvidenceInputError(
                    f"Could not read {layer} BigBed {os.path.basename(path)}: {error}"
                ) from error
            for entry_start, entry_end, rest in entries or ():
                fields = str(rest).split("\t")
                if len(fields) < 9:
                    continue
                name = fields[0]
                alignment_strand = fields[2] if fields[2] in {"+", "-"} else "."
                try:
                    sizes = _parse_int_array(fields[7])
                    offsets = _parse_int_array(fields[8])
                except ValueError:
                    continue
                if not sizes or len(sizes) != len(offsets):
                    continue
                # Companion tracks from older extractors do not always retain
                # identical BED chromStart/chromEnd values: TF-only rows can be
                # bounded by the first/last TF while MSP/mod rows retain a much
                # broader molecule envelope.  The stable join contract is the
                # declared sample + read ID + alignment strand; take the union
                # span after joining instead of splitting one molecule.
                key = (sample, name, alignment_strand)
                record = records.get(key)
                if record is None:
                    record = _BigBedRead(
                        name=name,
                        sample=sample,
                        alignment_strand=alignment_strand,
                        ref_start=int(entry_start),
                        ref_end=int(entry_end),
                    )
                    records[key] = record
                else:
                    record.ref_start = min(record.ref_start, int(entry_start))
                    record.ref_end = max(record.ref_end, int(entry_end))
                extras = []
                for raw in fields[9:]:
                    try:
                        values = _parse_int_array(raw)
                    except ValueError:
                        values = []
                    extras.append(values if len(values) == len(sizes) else [])
                if layer in {"m6a", "m5c", "deam"}:
                    for index, (offset, size) in enumerate(zip(offsets, sizes)):
                        quality = (
                            extras[0][index]
                            if extras and extras[0]
                            else (1 if layer == "deam" else 255)
                        )
                        for position in range(
                            int(entry_start) + int(offset),
                            int(entry_start) + int(offset) + int(size),
                        ):
                            record.marks[layer].append((position, int(quality), index))
                else:
                    quality_count = _CALL_QUALITY_COLUMNS.get(layer, 0)
                    for index, (offset, size) in enumerate(zip(offsets, sizes)):
                        qualities = tuple(
                            int(extras[column][index])
                            if column < len(extras) and extras[column]
                            else 0
                            for column in range(quality_count)
                        )
                        record.calls[layer].append((
                            int(entry_start) + int(offset),
                            int(entry_start) + int(offset) + int(size),
                            qualities,
                        ))
                rows_by_layer[layer] += 1

    diagnostics = {
        "rows_by_layer": dict(sorted(rows_by_layer.items())),
        "samples_by_layer": {
            layer: sorted(samples) for layer, samples in sorted(samples_by_layer.items())
        },
    }
    return list(records.values()), diagnostics


def _fasta_chrom(state, chrom: str) -> str:
    fasta = getattr(state, "fasta", None)
    if fasta is None:
        raise ConsensusEvidenceInputError(
            "TF refinement needs the matching reference sequence. Load the genome/FASTA "
            "before refining this BigBed bundle."
        )
    references = set(getattr(fasta, "references", ()) or ())
    for variant in get_chrom_variants(chrom):
        if variant in references:
            return variant
    raise ConsensusEvidenceInputError(
        f"The loaded reference has no contig matching {chrom!r}; load the genome used "
        "to create these BigBeds."
    )


def _chemistry_runtime(
    runtime: Mapping[str, object], chemistry: str, *, allow_population: bool = False
):
    presets = runtime["PRESETS"]
    if chemistry in presets:
        preset = presets[chemistry]
    elif chemistry == "hia5-pacbio" and allow_population:
        # Footprint-class inference is population based for PacBio Fiber-seq;
        # alignment orientation is diagnostic rather than a biochemical
        # strand (Hia5 orientations are pooled), not a license for cross-strand
        # rescue.
        preset = {
            "model": "models/hia5_pacbio.json",
            "strand_mode": "alignment",
            "prob_threshold": 125,
        }
    else:
        if chemistry == "hia5-pacbio":
            raise ConsensusEvidenceInputError(
                "The current FiberHMM strand-refinement runtime intentionally has no "
                "Hia5 PacBio alignment-strand preset. Footprint classes are supported, but "
                "this runtime cannot label alignment orientation as a physical PacBio "
                "strand for rescue."
            )
        raise ConsensusEvidenceInputError(
            f"The current FiberHMM runtime has no refinement preset for {chemistry!r}."
        )
    model_path = runtime["resolve_resource"](preset["model"])
    model, context_size, mode = runtime["load_model"](model_path)
    if int(context_size) != 3:
        raise ConsensusEvidenceInputError(
            "Browser BigBed evidence reconstruction currently requires the 7-mer "
            f"FiberHMM models (observed context_size={context_size})."
        )
    llr_hit, llr_miss = runtime["build_llr"](model)
    return preset, model, int(context_size), str(mode), llr_hit, llr_miss


def _required_mod_layer(chemistry: str) -> str:
    return "deam" if chemistry in {"ddda", "dddb"} else "m6a"


def _bigbed_capability_error(
    layer_paths: Mapping[str, Sequence[str]], chemistry: str, *,
    require_nucleosomes: bool = True,
) -> Optional[str]:
    required_mod = _required_mod_layer(chemistry)
    missing = []
    if not layer_paths.get("tf"):
        missing.append("TF calls")
    if require_nucleosomes and not layer_paths.get("footprint"):
        missing.append("nucleosome/footprint calls")
    if not layer_paths.get("msp"):
        missing.append("FIRE/MSP calls")
    if not layer_paths.get(required_mod):
        missing.append(
            "deamination events" if required_mod == "deam" else "m6A events"
        )
    if not missing:
        return None
    available_mods = [name for name in ("m6a", "m5c", "deam") if layer_paths.get(name)]
    found = f" Found modification sidecars: {', '.join(available_mods)}." if available_mods else ""
    return (
        f"This BigBed bundle cannot run {chemistry} evidence-aware TF inference because it is "
        f"missing {', '.join(missing)}.{found} Inference is evidence-gated, not "
        "format-gated: load the matching companion BigBeds and try again."
    )


def _molecular_interval(
    start: int, end: int, read_start: int, read_end: int, reverse: bool
) -> tuple[int, int]:
    if reverse:
        return read_end - end, end - start
    return start - read_start, end - start


def _bigbed_read_evidence(
    state,
    dataset_id: str,
    records: Sequence[_BigBedRead],
    *,
    chemistry: str,
    chrom: str,
    evidence_start: int,
    evidence_end: int,
    model,
    context_size: int,
    mode: str,
    llr_hit: np.ndarray,
    llr_miss: np.ndarray,
    prob_threshold: Optional[int],
    maximum_reads: int,
    runtime: Mapping[str, object],
) -> tuple[list, dict]:
    fasta_chrom = _fasta_chrom(state, chrom)
    fasta = state.fasta
    required_mod = _required_mod_layer(chemistry)
    IntervalCall = runtime["IntervalCall"]
    ReadEvidence = runtime["ReadEvidence"]
    encode = runtime["encode"]
    n_contexts = 4 ** (2 * context_size)
    miss_offset = n_contexts + 1
    selected_records = sorted(
        records,
        key=lambda value: (
            value.sample,
            value.name,
            value.ref_start,
            value.ref_end,
            value.alignment_strand,
        ),
    )
    reads = []
    processed_records = 0
    skipped_no_daf_strand = 0
    skipped_no_opportunities = 0
    for ordinal, record in enumerate(selected_records):
        if maximum_reads and len(reads) >= maximum_reads:
            break
        processed_records += 1
        if record.ref_end <= record.ref_start:
            continue
        reverse = record.alignment_strand == "-"
        sequence = fasta.fetch(fasta_chrom, record.ref_start, record.ref_end).upper()
        if not sequence:
            continue
        marks = list(record.marks.get(required_mod, ()))
        mod_positions: set[int] = set()
        if chemistry in {"ddda", "dddb"}:
            # blockMod is 0 for R/GA and 1 for Y/CT in FiberHMM deam BigBeds.
            flavor_counts = Counter(1 if quality else 0 for _pos, quality, _i in marks)
            if not flavor_counts:
                skipped_no_daf_strand += 1
                continue
            physical_flavor = max(flavor_counts, key=lambda key: (flavor_counts[key], key))
            physical_strand = "CT" if physical_flavor == 1 else "GA"
            chars = list(sequence)
            for position, flavor, _index in marks:
                relative = int(position) - record.ref_start
                if not 0 <= relative < len(chars):
                    continue
                if bool(flavor):
                    if chars[relative] == "C":
                        chars[relative] = "T"
                        mod_positions.add(relative)
                elif chars[relative] == "G":
                    chars[relative] = "A"
                    mod_positions.add(relative)
            sequence = "".join(chars)
            strand_symbol = "+" if physical_strand == "CT" else "-"
            evidence_strand = physical_strand
        else:
            mod_positions = {
                int(position) - record.ref_start
                for position, quality, _index in marks
                if record.ref_start <= int(position) < record.ref_end
                and (
                    prob_threshold is None
                    or int(quality) >= int(prob_threshold)
                )
            }
            strand_symbol = "."
            evidence_strand = "REV" if reverse else "FWD"

        observations = np.asarray(
            encode(
                sequence,
                mod_positions,
                edge_trim=10,
                mode=mode,
                strand=strand_symbol,
                context_size=context_size,
                is_reverse=reverse,
            ),
            dtype=np.int64,
        )
        positions = np.arange(record.ref_start, record.ref_end, dtype=np.int64)
        usable = min(positions.size, observations.size)
        positions = positions[:usable]
        observations = observations[:usable]
        hit_codes = (observations >= 0) & (observations < n_contexts)
        miss_codes = (
            (observations >= miss_offset)
            & (observations < miss_offset + n_contexts)
        )
        keep = (
            (hit_codes | miss_codes)
            & (positions >= evidence_start)
            & (positions < evidence_end)
        )
        positions_array = positions[keep]
        regional_codes = observations[keep]
        hits = regional_codes < n_contexts
        contexts = np.where(hits, regional_codes, regional_codes - miss_offset).astype(np.int64)
        if not positions_array.size:
            skipped_no_opportunities += 1
            continue
        steps = np.where(hits, llr_hit[contexts], llr_miss[contexts]).astype(np.float64)

        def calls(layer: str):
            values = sorted(record.calls.get(layer, ()), key=lambda value: (value[0], value[1]))
            result = []
            for index, (call_start, call_end, qualities) in enumerate(values):
                molecular_start, molecular_length = _molecular_interval(
                    call_start, call_end, record.ref_start, record.ref_end, reverse
                )
                result.append(IntervalCall(
                    int(call_start),
                    int(call_end),
                    score=int(qualities[0]) if qualities else 0,
                    molecular_start=int(molecular_start),
                    molecular_length=int(molecular_length),
                    ordinal=index,
                ))
            return result, values

        tfs, raw_tfs = calls("tf")
        nucs, _raw_nucs = calls("footprint")
        msps, _raw_msps = calls("msp")
        molecular_tfs = tuple(
            _molecular_interval(value[0], value[1], record.ref_start, record.ref_end, reverse)
            for value in raw_tfs
        )
        molecular_nucs = tuple(
            (int(call.molecular_start), int(call.molecular_length)) for call in nucs
        )
        molecular_msps = tuple(
            (int(call.molecular_start), int(call.molecular_length)) for call in msps
        )
        library_id = f"bigbed:{dataset_id}:{record.sample}"
        read = ReadEvidence(
            name=record.name,
            strand=evidence_strand,
            ref_start=record.ref_start,
            ref_end=record.ref_end,
            positions=positions_array,
            steps=steps,
            hits=np.asarray(hits, dtype=bool),
            contexts=contexts,
            tfs=tfs,
            nucs=nucs,
            msps=msps,
            fingerprint_positions=np.asarray(
                [record.ref_start + value for value in sorted(mod_positions)],
                dtype=np.int64,
            ),
            library_id=library_id,
            alignment_flag=16 if reverse else 0,
            cigar=f"{record.ref_end-record.ref_start}M",
            alignment_blocks=((record.ref_start, record.ref_end),),
            input_index=0,
            input_record_ordinal=ordinal,
            query_length=record.ref_end - record.ref_start,
            cigar_tuples=((0, record.ref_end - record.ref_start),),
            molecular_tfs=molecular_tfs,
            molecular_nucs=molecular_nucs,
            molecular_msps=molecular_msps,
        )
        read._browser_tf_qualities = {
            (int(start), int(end)): tuple(int(value) for value in qualities)
            for start, end, qualities in raw_tfs
        }
        reads.append(read)

    return reads, {
        "candidate_rows": len(records),
        "selected_rows": processed_records,
        "evidence_reads": len(reads),
        "skipped_no_daf_strand": skipped_no_daf_strand,
        "skipped_no_opportunities": skipped_no_opportunities,
        "required_modification_layer": required_mod,
        "opportunity_projection": "matching_reference_contiguous_bigbed_span",
        "opportunity_projection_limit": (
            "BigBed does not preserve query sequence/CIGAR; reference-derived "
            "opportunities assume the declared outer read span is contiguous."
        ),
        "truncated_at_maximum_reads": bool(
            maximum_reads and len(reads) >= maximum_reads and processed_records < len(records)
        ),
    }


def _load_dataset_evidence(
    state,
    dataset_id: str,
    chemistry: str,
    *,
    chrom: str,
    evidence_start: int,
    evidence_end: int,
    maximum_reads: int,
    runtime: Mapping[str, object],
    allow_population: bool = False,
    require_nucleosomes: bool = True,
    selection_start: Optional[int] = None,
    selection_end: Optional[int] = None,
    preferred_read_ids: Sequence[str] = (),
    tf_layer: str = "tf",
    nuc_layer: str = "nuc",
    minimum_mapq: int = 0,
    legacy_annotation_frame: Optional[str] = None,
):
    # A dataset on another assembly reads its contexts from its own reference.
    from services.panel_genomes import for_datasets
    state = for_datasets(state, [dataset_id])
    dataset = state.get_dataset(dataset_id)
    if dataset is None:
        raise ConsensusEvidenceInputError(f"Unknown dataset {dataset_id!r}.")
    layer_paths = None
    if getattr(dataset, "data_type", None) != "bam":
        layer_paths = _dataset_bigbed_layer_paths(dataset)
        capability_error = _bigbed_capability_error(
            layer_paths,
            chemistry,
            require_nucleosomes=require_nucleosomes,
        )
        if capability_error:
            raise ConsensusEvidenceInputError(capability_error)
    preset, model, context_size, mode, llr_hit, llr_miss = _chemistry_runtime(
        runtime, chemistry, allow_population=allow_population
    )
    from services.signal_evidence import signal_keeps
    if getattr(dataset, "data_type", None) != "bam" and not signal_keeps(None):
        return [], model, preset, {"source_type": "bigbed", "signal_annotation": "unavailable", "evidence_reads": 0}
    if getattr(dataset, "data_type", None) == "bam":
        from services.plasmid_reconcile import contig_links
        reads = []
        per_file = []
        paths = _flatten_paths(
            getattr(dataset, "paths", ()) or getattr(dataset, "path", None)
        )
        for input_index, path in enumerate(paths):
            remaining = 0 if not maximum_reads else max(0, maximum_reads - len(reads))
            if maximum_reads and remaining == 0:
                break
            diagnostics = {}
            actual_chrom, fetch_start, fetch_end, contig_length = (
                _resolve_bam_fetch_region(
                    path,
                    chrom,
                    evidence_start,
                    evidence_end,
                    links=contig_links(state, dataset_id=dataset_id),
                )
            )
            diagnostics.update({
                "browser_chrom": chrom,
                "bam_chrom": actual_chrom,
                "requested_start": int(evidence_start),
                "requested_end": int(evidence_end),
                "fetch_start": fetch_start,
                "fetch_end": fetch_end,
                "bam_contig_length": contig_length,
            })
            required_read_names = None
            if (
                remaining
                and selection_start is not None
                and selection_end is not None
            ):
                required_read_names, selection_diagnostics = (
                    _select_bam_evidence_read_names(
                        path,
                        actual_chrom,
                        fetch_start,
                        fetch_end,
                        selection_start=max(fetch_start, int(selection_start)),
                        selection_end=min(fetch_end, int(selection_end)),
                        maximum_reads=remaining,
                        preferred_read_ids=preferred_read_ids,
                    )
                )
                diagnostics.update(selection_diagnostics)
            try:
                from services.signal_bam_input import load_signal_region_evidence
                loaded = load_signal_region_evidence(runtime["load_bam"],
                    path,
                    actual_chrom,
                    fetch_start,
                    fetch_end,
                    strand_mode=preset["strand_mode"],
                    mode=mode,
                    context_size=context_size,
                    prob_threshold=preset.get("prob_threshold"),
                    llr_hit=llr_hit,
                    llr_miss=llr_miss,
                    min_mapq=minimum_mapq,
                    tf_layer=tf_layer,
                    nuc_layer=nuc_layer,
                    max_reads=remaining,
                    input_index=input_index,
                    load_diagnostics=diagnostics,
                    ma_annotation_frame='auto',
                    required_read_names=required_read_names,
                    **({'legacy_annotation_frame':legacy_annotation_frame} if legacy_annotation_frame is not None else {}),
                )
            except (KeyError, OSError, ValueError) as error:
                label = os.path.basename(path) or path
                raise ConsensusEvidenceInputError(
                    f"Could not load BAM evidence from {label!r} at "
                    f"{actual_chrom}:{fetch_start}-{fetch_end}: {error}"
                ) from error
            reads.extend(loaded)
            per_file.append(diagnostics)
        diagnostics = {
            "source_type": "bam",
            "evidence_reads": len(reads),
            "files": per_file,
        }
    else:
        records, row_diagnostics = _load_bigbed_rows(
            layer_paths or {},
            chrom=chrom,
            start=evidence_start,
            end=evidence_end,
        )
        reads, evidence_diagnostics = _bigbed_read_evidence(
            state,
            dataset_id,
            records,
            chemistry=chemistry,
            chrom=chrom,
            evidence_start=evidence_start,
            evidence_end=evidence_end,
            model=model,
            context_size=context_size,
            mode=mode,
            llr_hit=llr_hit,
            llr_miss=llr_miss,
            prob_threshold=preset.get("prob_threshold"),
            maximum_reads=maximum_reads,
            runtime=runtime,
        )
        diagnostics = {
            "source_type": "bigbed",
            **row_diagnostics,
            **evidence_diagnostics,
        }
    return reads, model, preset, diagnostics



def _prefix_library(read, dataset_id: str) -> None:
    original = str(read.library_id or "")
    read.library_id = f"browser:{dataset_id}:{original}"
    read._browser_dataset_id = dataset_id
    read._browser_original_library_id = original


def _projection_member_key(read) -> tuple:
    """A retained alignment is not identified by QNAME/strand alone."""
    return (*read.molecule_id, str(getattr(read, 'record_sha256', '') or ''),
        int(getattr(read, 'alignment_occurrence', 0)), int(getattr(read, 'input_index', 0)),
        int(read.ref_start), int(read.ref_end))


def _projection_members(raw_reads: Sequence, retained_reads: Sequence, *, exact_records=False) -> dict[tuple, list[dict]]:
    clusters: dict[str, list] = defaultdict(list)
    for read in raw_reads:
        cluster = getattr(read, "amplification_family_id", None)
        if cluster:
            clusters[str(cluster)].append(read)
    result = {}
    for read in retained_reads:
        cluster = getattr(read, "amplification_family_id", None)
        members = clusters.get(str(cluster), ()) if cluster else (read,)
        key = _projection_member_key(read) if exact_records else read.molecule_id
        result[key] = [
            {
                "dataset_id": str(getattr(member, "_browser_dataset_id", "")),
                "read_name": str(member.name),
                "strand": str(member.strand),
            }
            for member in members
        ]
        if exact_records:
            for output, member in zip(result[key], members):
                output.update(library_id=str(getattr(member, '_browser_original_library_id', member.library_id) or ''),
                    reference_start=int(member.ref_start), reference_end=int(member.ref_end))
                if getattr(member, 'record_sha256', None):
                    output.update(record_sha256=str(member.record_sha256),
                        alignment_occurrence=int(member.alignment_occurrence),
                        alignment_orientation='reverse' if int(member.alignment_flag) & 16 else 'forward')
    return result
