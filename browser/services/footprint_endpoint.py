"""Endpoint workflow helpers for footprint analysis."""
from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np

from models.requests import FootprintAnalysisRequest
from services import motifs as motif_service
from services.analysis_query import AnalysisReadQuery
from services.footprint_analysis import (
    FootprintLayerResolver,
    accumulate_profile,
    accumulate_profile_and_vplot,
    add_cooccupancy_fdr,
    bootstrap_profile_ci,
    cap_working_set_reads,
    compute_cooccupancy_result,
    compute_group_memberships,
    compute_overlap_stats,
    footprint_analysis_needs_layers,
    get_cached_interval_table,
    make_read_bootstrap_weights,
)
from services.read_metrics import get_layer_intervals
from services.supplemental_sequences import supplemental_sequence_for_chrom, supplemental_sequence_slice

_footprint_warning_lock = threading.Lock()
_footprint_warning_once_keys = set()

# Automatic JASPAR scans report this many best-matching motifs per footprint.
AUTO_JASPAR_TOP_MOTIFS = 10



def normalized_vplot_matrix(vp_matrix, smooth: float = 0, log: bool = False) -> list[list[float]]:
    """The V-plot matrix smoothed / logged as asked and scaled to its maximum.

    An empty size range gives a matrix with no rows: an empty matrix, not an error.
    """
    if vp_matrix.size == 0:
        return [[] for _ in range(vp_matrix.shape[0])]
    if smooth > 0:
        from scipy.ndimage import gaussian_filter
        vp_matrix = gaussian_filter(vp_matrix.astype(float), sigma=smooth)
    if log:
        vp_matrix = np.log1p(vp_matrix)
    vp_max = float(vp_matrix.max()) if vp_matrix.max() > 0 else 1
    return [[float(x / vp_max) for x in row] for row in vp_matrix]

def _whole_bases(start: Any, end: Any) -> tuple[int, int]:
    """The whole bases [lo, hi) covering a span whose edges may be fractional."""
    import math

    return int(math.floor(float(start))), int(math.ceil(float(end)))


def _print_footprint_warning_once(key: Any, message: str) -> bool:
    """Print repeated footprint-analysis warnings once while still returning them to the UI."""
    with _footprint_warning_lock:
        if key in _footprint_warning_once_keys:
            return False
        _footprint_warning_once_keys.add(key)
    print(message)
    return True


def _normalize_pwm_counts(counts: Any) -> dict[str, list[float]]:
    if not isinstance(counts, dict):
        raise ValueError("PWM counts must be an A/C/G/T dictionary")
    normalized: dict[str, list[float]] = {}
    lengths = set()
    for base in "ACGT":
        values = counts.get(base)
        if not isinstance(values, list) or len(values) == 0:
            raise ValueError(f"PWM counts must include a non-empty {base} array")
        clean = [float(value) for value in values]
        normalized[base] = clean
        lengths.add(len(clean))
    if len(lengths) != 1:
        raise ValueError("PWM A/C/G/T arrays must all have the same length")
    return normalized


def _motif_id_fragment(value: Any) -> str:
    text = str(value or "motif").strip() or "motif"
    return "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in text)


def analyze_footprints_payload(
    state,
    *,
    chrom: str,
    region_start: int,
    region_end: int,
    spanning: bool,
    request: FootprintAnalysisRequest | None,
):
    """Build the `/api/footprint/analyze` response payload."""
    if request is None:
        return {"success": False, "error": "No request body"}
    # Datasets on another assembly: sequences and motif species from their own reference.
    from services.panel_genomes import for_datasets, mixed_references
    # Datasets on different assemblies: no one reference has their sequences.
    mixed_reference = mixed_references(state, request.dataset_ids)
    state = for_datasets(state, request.dataset_ids)

    footprints = request.footprints
    flank_bp = request.flank_bp
    profile_window = request.profile_window
    timings = {}
    total_t0 = time.perf_counter()

    def _record_timing(name: str, started: float):
        timings[name] = round(time.perf_counter() - started, 4)

    include_overlap = request.include_read_analysis and request.include_overlap
    include_profiles = request.include_read_analysis and request.include_profiles
    include_vplot = request.include_read_analysis and request.include_vplot
    include_coocc = request.include_read_analysis and request.include_coocc
    include_motifs = request.include_motifs and not mixed_reference
    include_sequences = (request.include_sequences or include_motifs) and not mixed_reference

    # `fi`/`fq` exist only on the BAM-native tf_sr layer. A family cart rule
    # is therefore an unambiguous layer request even if an older session or
    # the global selector still says All/TF.
    has_family_groups = bool(
        include_coocc
        and request.groups
        and any(group.get("familyId", group.get("family_id")) is not None for group in request.groups)
    )
    family_layers=tuple(sorted({g.get('layer') or 'tf_sr' for g in request.groups})) if has_family_groups else ()
    target_layer = family_layers[0] if len(family_layers)==1 else 'all_fp' if family_layers else request.layer
    include_layers = footprint_analysis_needs_layers(target_layer, request.layers, include_profiles)
    if include_coocc and any(g.get('layer') for g in (request.groups or [])):
        include_layers = True
    layer_resolver = FootprintLayerResolver(target_layer,selected_layers=family_layers)
    query = AnalysisReadQuery.from_request(
        state,
        chrom=chrom,
        start=region_start,
        end=region_end,
        spanning=spanning,
        dataset_ids=request.dataset_ids,
        read_ids_by_dataset=request.read_ids_by_dataset,
        strand_by_dataset=getattr(request, "strand_by_dataset", None),
        max_reads=request.max_reads,
        sample_seed=request.sample_seed,
        include_methylation=False,
        include_layers=include_layers,
    )
    resolved_chrom = query.chrom
    dataset_ids = query.dataset_ids
    max_reads = query.max_reads
    sample_seed = query.sample_seed

    result_footprints = []
    motif_pwms = {}
    motif_sources = []
    motif_warnings = []
    if mixed_reference and (request.include_sequences or request.include_motifs):
        motif_warnings.append("These datasets are on different assemblies: analyse one assembly's datasets at a time "
                              "for footprint sequences and motifs.")
    jaspar_species = None  # which species the automatic JASPAR scan used

    def _cap_working_set(ds_id, ws, label):
        if not max_reads or len(ws.reads) <= max_reads:
            return ws
        pre_sample_count = len(ws.reads)
        capped = cap_working_set_reads(
            ws,
            max_reads,
            seed=f"{sample_seed}:footprint:{ds_id}:{resolved_chrom}:{label}",
        )
        print(
            f"  footprint {ds_id}: stable analysis read cap "
            f"{pre_sample_count} -> {len(capped.reads)} reads"
        )
        return capped

    def _get_interval_table(ws, cache_key, interval_getter, family_metadata_getter=None):
        # Family tags must come from the same layer as the intervals.
        return get_cached_interval_table(
            ws,
            cache_key,
            interval_getter,
            family_metadata_getter=family_metadata_getter or layer_resolver.family_metadata,
        )

    primary_table_key = layer_resolver.primary_table_key

    # --- Step 1: Sequences ---
    phase_t0 = time.perf_counter()
    # A loaded plasmid map supplies its own contig's sequence (it takes
    # precedence over the FASTA, as in /api/sequence).
    plasmid = supplemental_sequence_for_chrom(state, resolved_chrom)
    has_fasta = state.fasta is not None or plasmid is not None

    # Resolve chromosome name (with/without chr prefix) for FASTA lookup.
    fasta_chrom = None
    if include_sequences and plasmid is None and state.fasta is not None:
        for name in state.fasta.references:
            if name == resolved_chrom:
                fasta_chrom = name
                break
        if fasta_chrom is None:
            alt_chrom = resolved_chrom[3:] if resolved_chrom.startswith("chr") else "chr" + resolved_chrom
            for name in state.fasta.references:
                if name == alt_chrom:
                    fasta_chrom = name
                    break
        if fasta_chrom is None:
            warning = f"Chromosome {resolved_chrom} not found in FASTA references"
            motif_warnings.append(warning)
            _print_footprint_warning_once(
                ("fasta_missing_chrom", id(state.fasta), resolved_chrom),
                f"Warning: {warning}",
            )

    fasta_fetch_warning_added = False
    for fp in footprints:
        abs_start = fp.get("absStart", fp.get("abs_start", 0))
        abs_end = fp.get("absEnd", fp.get("abs_end", 0))
        size = fp.get("size", abs_end - abs_start)
        # A class's edges can fall on a half base: its sequence is the whole
        # bases covering it (pysam would truncate both edges toward zero).
        seq_lo, seq_hi = _whole_bases(abs_start, abs_end)

        seq = None
        seq_start = seq_lo - flank_bp
        if include_sequences and plasmid is not None:
            seq_start = max(0, seq_lo - flank_bp)
            seq = supplemental_sequence_slice(
                state, plasmid[0], plasmid[1], seq_start, seq_hi + flank_bp,
            ).upper() or None
        elif include_sequences and has_fasta and fasta_chrom is not None:
            try:
                seq_start = max(0, seq_lo - flank_bp)
                seq_end = seq_hi + flank_bp
                seq = state.fasta.fetch(fasta_chrom, seq_start, seq_end).upper()
            except Exception as e:
                if not fasta_fetch_warning_added:
                    warning = f"FASTA fetch failed for {fasta_chrom}: {type(e).__name__}: {e}"
                    motif_warnings.append(warning)
                    fasta_fetch_warning_added = True
                    _print_footprint_warning_once(
                        ("fasta_fetch_failed", id(state.fasta), fasta_chrom, type(e).__name__, str(e)),
                        f"Warning: {warning}",
                    )
                seq = None
                seq_start = seq_lo

        result_footprints.append({
            "absStart": abs_start,
            "absEnd": abs_end,
            "size": size,
            "sequence": seq,
            "seq_start": seq_start,
            "motif_hits": [],
        })
    _record_timing("sequences", phase_t0)

    # --- Step 2: Motifs ---
    phase_t0 = time.perf_counter()
    from services import motif_scoring
    fields_set = getattr(request, "model_fields_set", set())
    motif_mode = request.motif_mode or ("relative" if "motif_threshold" in fields_set else "p")
    if not 1e-10 <= float(request.motif_p) <= 0.05:
        motif_warnings.append("motif_p must be 1e-10 - 0.05; 1e-4 is used")
    motif_p_value = float(request.motif_p) if 1e-10 <= float(request.motif_p) <= 0.05 else motif_scoring.DEFAULT_P
    motif_bg = None
    pinned_used: list[str] = []
    pinned_unavailable: list[str] = []      # default factors JASPAR CORE lacks (said plainly, not as a warning)
    pssms = {}
    # Motifs from the automatic JASPAR scan: hundreds, so trimmed to the best.
    auto_jaspar_ids: set[str] = set()
    auto_jaspar_hit_ids: set[str] = set()
    selected_motif_tracks = (
        {int(idx) for idx in request.motif_track_indices}
        if request.motif_track_indices is not None
        else None
    )

    def _unique_motif_id(base: str) -> str:
        mid = base
        suffix = 2
        while mid in pssms:
            mid = f"{base}_{suffix}"
            suffix += 1
        return mid

    def _register_motif_pwm(mid_base: str, name: str, counts: dict, pssm, source: str, **metadata) -> str:
        mid = _unique_motif_id(mid_base)
        pssms[mid] = (pssm, name, counts)
        motif_pwms[mid] = {
            "A": [float(x) for x in counts.get("A", [])],
            "C": [float(x) for x in counts.get("C", [])],
            "G": [float(x) for x in counts.get("G", [])],
            "T": [float(x) for x in counts.get("T", [])],
            "name": name,
        }
        motif_sources.append({
            "id": mid,
            "name": name,
            "source": source,
            **{k: v for k, v in metadata.items() if v is not None},
        })
        return mid

    if include_sequences and not has_fasta:
        motif_warnings.append("No FASTA loaded — cannot extract sequences for motif scanning")
    if include_motifs and has_fasta:
        jaspar_genome, jaspar_inferred = motif_service.jaspar_genome(state)
        jaspar_basis = motif_service.reference_genome_basis(state)[1] if jaspar_genome and not jaspar_inferred else None
        if request.auto_motifs and jaspar_genome not in motif_service.GENOME_TO_JASPAR_SPECIES:
            if jaspar_genome is None:
                # A custom sequence nothing declares (a FASTA contig): the vertebrate matrices, said so.
                if not motif_service.check_pyjaspar():
                    motif_warnings.append("pyjaspar not installed — run 'pip install pyjaspar' for automatic JASPAR motif scanning")
                else:
                    jaspar_species = motif_service.fallback_species()
                    motif_warnings.append(motif_service.FALLBACK_NOTE)
                    try:
                        for m, pssm in motif_service.get_jaspar_taxon_pssms(motif_service.FALLBACK_TAX_GROUP):
                            auto_jaspar_ids.add(_register_motif_pwm(m.matrix_id, m.name, m.counts, pssm, "jaspar"))
                    except Exception as e:
                        motif_warnings.append(f"JASPAR motif fetch failed: {type(e).__name__}: {e}")
            else:
                motif_warnings.append(
                    f"Genome '{jaspar_genome}' not in JASPAR species map "
                    f"(supported: {', '.join(motif_service.GENOME_TO_JASPAR_SPECIES.keys())})"
                )
        if request.auto_motifs and jaspar_genome in motif_service.GENOME_TO_JASPAR_SPECIES:
            if not motif_service.check_pyjaspar():
                motif_warnings.append("pyjaspar not installed — run 'pip install pyjaspar' for automatic JASPAR motif scanning")
            else:
                species_id = motif_service.GENOME_TO_JASPAR_SPECIES[jaspar_genome]
                jaspar_species = {"genome": jaspar_genome, "taxid": species_id, "inferred": jaspar_inferred,
                                  "name": motif_service.JASPAR_SPECIES_NAMES.get(species_id)}
                if jaspar_basis in ("declared", "inherited"):
                    jaspar_species[jaspar_basis] = True
                try:
                    motifs = motif_service.get_jaspar_core_pssms(species_id)
                except Exception as e:
                    motifs = None
                    motif_warnings.append(f"JASPAR motif fetch failed for taxid {species_id}: {type(e).__name__}: {e}")
                if motifs is not None:
                    if not motifs:
                        motif_warnings.append(
                            f"JASPAR CORE returned 0 motifs for {jaspar_genome} (taxid {species_id}). "
                            f"Verify the JASPAR release contains motifs for this species or load a custom motif track."
                        )
                    else:
                        # Every CORE motif for the species; only the best matches
                        # per footprint are kept (below).
                        for m, pssm in motifs:
                            auto_jaspar_ids.add(_register_motif_pwm(m.matrix_id, m.name, m.counts, pssm, "jaspar"))

        pinned_names = list(request.custom_motif_names or [])
        if request.custom_motif_names is None and request.pinned_defaults and jaspar_species:
            pinned_names = motif_scoring.pinned_defaults(jaspar_species)
        pinned_used = list(pinned_names)
        # Pinned names resolve as in the other motif views (services/motif_scoring._resolve): the species' own matrices
        # first, else the assembly's JASPAR taxon group (reported as a substitution), else missing.
        species_records = [dict(matrix_id=mid, name=pssms[mid][1], counts=pssms[mid][2]) for mid in auto_jaspar_ids]
        if pinned_names and (species_records or motif_service.check_pyjaspar()):
            try:
                taxon = (jaspar_species.get("tax_group") or motif_service.genome_taxon(jaspar_species["genome"])) if jaspar_species else None
                missing, substituted = [], []
                for name in pinned_names:
                    if name in pssms:
                        continue
                    found, sub = motif_scoring._resolve(motif_service, name, species_records, taxon)
                    if not found:
                        missing.append(name)
                        continue
                    for r in found[:1]:
                        mid = r["matrix_id"]
                        if mid in auto_jaspar_ids:
                            # the species' matrix: always reported, all its hits (no longer best-matches-only)
                            auto_jaspar_ids.discard(mid)
                            continue
                        counts = {b: list(r["counts"][b]) for b in "ACGT" if b in r["counts"]}
                        if all(b in counts for b in "ACGT"):
                            _register_motif_pwm(mid, r["name"], counts, motif_service.pwm_to_pssm(counts), "jaspar_named")
                    if sub:
                        substituted.append(f"{name} ({sub})")
                if missing and request.custom_motif_names is not None:
                    # The species' (former) defaults that JASPAR CORE lacks are said plainly, not as an error of yours.
                    quiet = motif_scoring.default_like(jaspar_species, missing) if jaspar_species else []
                    own = [n for n in missing if n not in quiet]
                    if own:
                        motif_warnings.append(f"Pinned motif(s) not found in JASPAR CORE: {', '.join(own)}")
                    pinned_unavailable.extend(quiet)
                if substituted:
                    motif_warnings.append(f"No matrix of this species for {', '.join(substituted)}: the taxon group's is used")
            except Exception as e:
                motif_warnings.append(f"Custom motif fetch failed: {type(e).__name__}: {e}")

        for i, entry in enumerate(request.custom_pwms or []):
            try:
                if not isinstance(entry, dict):
                    raise ValueError("PWM entry must be a dictionary")
                name = str(entry.get("name") or entry.get("label") or f"PWM {i + 1}")
                raw_counts = entry.get("counts")
                if raw_counts is None:
                    raw_counts = {base: entry.get(base) for base in "ACGT"}
                counts = _normalize_pwm_counts(raw_counts)
                pssm = motif_service.pwm_to_pssm(counts)
                _register_motif_pwm(
                    f"request_pwm_{i}_{_motif_id_fragment(name)}",
                    name,
                    counts,
                    pssm,
                    "request_pwm",
                )
            except Exception as e:
                motif_warnings.append(f"Custom PWM {i + 1} skipped: {type(e).__name__}: {e}")

        for track_index, t in enumerate(state.orthogonal_tracks):
            if selected_motif_tracks is not None and track_index not in selected_motif_tracks:
                continue
            if t.get("format") == "custom_motif" and "pssm" in t:
                motif_name = t.get("motif_name", t["label"])
                counts = t.get("counts", {})
                _register_motif_pwm(
                    f"track_{track_index}_{_motif_id_fragment(motif_name)}",
                    motif_name,
                    counts,
                    t["pssm"],
                    "track",
                    track_index=track_index,
                    motif_type=t.get("motif_type"),
                    motif_source=t.get("motif_source"),
                )

        if motif_mode == "p":
            if request.motif_background == "genome" and getattr(state, "fasta", None) is not None:
                try:
                    motif_bg = motif_scoring.genome_composition(state.fasta)
                except Exception:  # noqa: BLE001 - an unreadable FASTA: uniform
                    motif_bg = None
            motif_bg = motif_service.normalize_background(motif_bg or motif_service.UNIFORM_BACKGROUND)
        scored = {}

        def _hits(mid, pssm, mname, counts, seq):
            """(hits, p mode used): p mode scores the counts with the shared scorer at p <= motif_p; relative mode
            (or a motif without counts) is the older relative-score scan, unchanged."""
            good = motif_mode == "p" and motif_scoring.normalize_counts(counts) is not None
            if not good:
                return [dict(h, p=None) for h in motif_service.scan_both_strands(seq, pssm, request.motif_threshold)], False
            if mid not in scored:
                sm = motif_scoring._scored(motif_service, mid, mname, motif_scoring.normalize_counts(counts), motif_bg)
                scored[mid] = (sm, sm.cutoff_for_p(motif_p_value))
            sm, cutoff = scored[mid]
            if cutoff is None:
                return [], True
            return [dict(start=h["start"], end=h["end"], strand=h["strand"], score=h["score"], rel_score=h["rel"], p=h["p"],
                         matched_seq=h["matched_seq"]) for h in motif_service.scan_scored(seq, sm, cutoff)], True

        def _hit_record(mid, mname, h, family=None):
            out = {"motif_id": mid, "motif_name": mname, "start": h["start"], "end": h["end"], "strand": h["strand"],
                   "rel_score": round(h["rel_score"], 3), "matched_seq": h.get("matched_seq", "")}
            if h.get("p") is not None:
                out["p"] = float(h["p"])
            if family:
                out["family"] = family
            return out

        for fp_info in result_footprints:
            seq = fp_info["sequence"]
            if not seq:
                continue
            best_auto: dict[str, dict] = {}
            for mid, (pssm, mname, counts) in pssms.items():
                hits, by_p = _hits(mid, pssm, mname, counts, seq)
                if mid in auto_jaspar_ids:
                    if hits:
                        best = min(hits, key=lambda h: (h["p"], -h["score"])) if by_p else max(hits, key=lambda h: h["score"])
                        best_auto[mid] = {**best, "motif_name": mname}
                    continue
                for h in hits:
                    fp_info["motif_hits"].append(_hit_record(mid, mname, h))
            # p mode: rank by p-value; a similar matrix hitting the same bases joins the better one's family.
            # relative mode: rank by log-odds (the older behaviour). Either way at most two motifs claim one site.
            if motif_mode == "p":
                order = sorted(best_auto.items(), key=lambda item: (item[1].get("p") if item[1].get("p") is not None else 1.0,
                                                                    -item[1]["score"]))
            else:
                order = sorted(best_auto.items(), key=lambda item: -item[1]["score"])
            top: list[list] = []
            sites: list[dict] = []  # distinct positions and how many motifs claim each
            for mid, h in order:
                overlap = lambda a, b: min(a["end"], b["end"]) - max(a["start"], b["start"]) >= 0.5 * min(a["end"] - a["start"], b["end"] - b["start"])  # noqa: E731
                if motif_mode == "p":
                    home = next((t for t in top if overlap(t[1], h) and motif_scoring.similarity(
                        motif_scoring.normalize_counts(pssms[t[0]][2]) or {}, motif_scoring.normalize_counts(pssms[mid][2]) or {})
                        >= motif_scoring.FAMILY_SIMILARITY), None) if motif_scoring.normalize_counts(pssms[mid][2]) else None
                    if home is not None:
                        home[2].append(h["motif_name"])
                        continue
                site = next((site for site in sites if overlap(site, h)), None)
                if site is None:
                    site = {"start": h["start"], "end": h["end"], "count": 0}
                    sites.append(site)
                if site["count"] >= 2:
                    continue
                site["count"] += 1
                top.append([mid, h, []])
                if len(top) >= AUTO_JASPAR_TOP_MOTIFS:
                    break
            for mid, h, family in top:
                auto_jaspar_hit_ids.add(mid)
                fp_info["motif_hits"].append(_hit_record(mid, h["motif_name"], h, family or None))
    # Logos and sources only for the JASPAR motifs that were kept.
    unused_auto = auto_jaspar_ids - auto_jaspar_hit_ids
    for mid in unused_auto:
        motif_pwms.pop(mid, None)
    if unused_auto:
        motif_sources[:] = [src for src in motif_sources if src.get("id") not in unused_auto]
    _record_timing("motifs", phase_t0)

    if not request.include_read_analysis:
        if motif_warnings:
            for w in motif_warnings:
                _print_footprint_warning_once(("motif_warning", w), f"  [Motif warning] {w}")
        timings["total"] = round(time.perf_counter() - total_t0, 4)
        return {
            "success": True,
            "footprints": result_footprints,
            "overlap_stats": {},
            "profiles": {},
            "vplot": {},
            "motif_pwms": motif_pwms,
            "motif_sources": motif_sources,
            "jaspar_species": jaspar_species,
            "motif_scoring": {"mode": motif_mode, "p": motif_p_value, "relative": request.motif_threshold, "background": None if motif_bg is None else request.motif_background, "pinned": pinned_used, "unavailable": pinned_unavailable},
            "co_occupancy": {},
            "warnings": motif_warnings if motif_warnings else None,
            "sample_seed": sample_seed if max_reads else None,
            "timings": timings,
        }

    # --- Step 3: Overlap stats ---
    ws_cache = {}
    table_cache = {}
    overlap_stats = {}
    if include_overlap:
        for ds_id in dataset_ids:
            try:
                phase_t0 = time.perf_counter()
                ws = query.build_working_set(state, ds_id)
                ws = _cap_working_set(ds_id, ws, f"overlap:{region_start}:{region_end}")
                timings["overlap_working_set"] = timings.get("overlap_working_set", 0) + round(time.perf_counter() - phase_t0, 4)
                ws_cache[ds_id] = ws

                phase_t0 = time.perf_counter()
                table = _get_interval_table(ws, primary_table_key, layer_resolver.intervals)
                timings["overlap_interval_table"] = timings.get("overlap_interval_table", 0) + round(time.perf_counter() - phase_t0, 4)
                table_cache[ds_id] = table

                total_reads = len(ws.reads)
                phase_t0 = time.perf_counter()
                per_footprint = compute_overlap_stats(
                    table,
                    footprints,
                    total_reads,
                    include_sizes=request.include_overlap_sizes,
                )
                timings["overlap_stats"] = timings.get("overlap_stats", 0) + round(time.perf_counter() - phase_t0, 4)
                overlap_stats[ds_id] = {
                    "total_reads": total_reads,
                    "per_footprint": per_footprint,
                }
            except Exception as e:
                overlap_stats[ds_id] = {"total_reads": 0, "per_footprint": [], "error": str(e)}

    # --- Step 4: Profiles + V-plot ---
    profiles = {}
    vplot = {}
    if include_profiles or include_vplot:
        for ds_id in dataset_ids:
            try:
                profile_start = max(0, region_start - profile_window)
                profile_end = region_end + profile_window
                phase_t0 = time.perf_counter()
                ws = query.build_working_set(
                    state,
                    ds_id,
                    start=profile_start,
                    end=profile_end,
                    spanning=False,
                )
                ws = _cap_working_set(ds_id, ws, f"profile:{profile_start}:{profile_end}")
                timings["profile_working_set"] = timings.get("profile_working_set", 0) + round(time.perf_counter() - phase_t0, 4)

                size_min, size_max = request.vplot_size_min, request.vplot_size_max
                size_bin, pos_bin = request.vplot_size_bin, request.vplot_pos_bin
                phase_t0 = time.perf_counter()
                table = _get_interval_table(ws, primary_table_key, layer_resolver.intervals)
                timings["profile_interval_table"] = timings.get("profile_interval_table", 0) + round(time.perf_counter() - phase_t0, 4)

                phase_t0 = time.perf_counter()
                if include_vplot:
                    agg, vp_matrix = accumulate_profile_and_vplot(
                        table,
                        footprints,
                        profile_window,
                        size_min,
                        size_max,
                        size_bin,
                        pos_bin,
                    )
                else:
                    agg = accumulate_profile(table, footprints, profile_window)
                    vp_matrix = None
                timings["profile_vplot_compute"] = timings.get("profile_vplot_compute", 0) + round(time.perf_counter() - phase_t0, 4)

                if include_profiles or include_vplot:
                    profiles[ds_id] = {
                        "aggregate": [float(x) for x in agg],
                        "window": profile_window,
                    }

                if include_profiles:
                    phase_t0 = time.perf_counter()
                    shared_bootstrap_weights = (
                        make_read_bootstrap_weights(
                            table.n_reads,
                            seed=f"{sample_seed}:footprint-profile:{ds_id}:{resolved_chrom}",
                            resamples=500,
                        )
                        if request.layers
                        else None
                    )
                    profiles[ds_id]["aggregate_ci"] = bootstrap_profile_ci(
                        table,
                        footprints,
                        profile_window,
                        seed=f"{sample_seed}:footprint-profile:{ds_id}:{resolved_chrom}:primary",
                        weights=shared_bootstrap_weights,
                    )
                    timings["profile_bootstrap"] = timings.get("profile_bootstrap", 0) + round(time.perf_counter() - phase_t0, 4)

                if include_profiles and request.layers:
                    phase_t0 = time.perf_counter()
                    by_layer = {}
                    by_layer_ci = {}
                    for layer_name in request.layers:
                        def _ints_for_layer(read, lname=layer_name):
                            if lname in (None, "", "_primary", "primary"):
                                return read.get("intervals") or []
                            return get_layer_intervals(read, lname)

                        layer_table = _get_interval_table(
                            ws,
                            ("footprint_analysis_layer", layer_name or "_primary"),
                            _ints_for_layer,
                            FootprintLayerResolver(
                                None if layer_name in (None, "", "_primary", "primary") else layer_name
                            ).family_metadata,
                        )
                        agg_l = accumulate_profile(layer_table, footprints, profile_window)
                        by_layer[layer_name] = [float(x) for x in agg_l]
                        by_layer_ci[layer_name] = bootstrap_profile_ci(
                            layer_table,
                            footprints,
                            profile_window,
                            seed=f"{sample_seed}:footprint-profile:{ds_id}:{resolved_chrom}:{layer_name}",
                            weights=shared_bootstrap_weights,
                        )
                    profiles[ds_id]["by_layer"] = by_layer
                    profiles[ds_id]["by_layer_ci"] = by_layer_ci
                    timings["extra_layer_profiles"] = timings.get("extra_layer_profiles", 0) + round(time.perf_counter() - phase_t0, 4)

                if include_vplot:
                    phase_t0 = time.perf_counter()
                    vplot[ds_id] = {
                        "matrix": normalized_vplot_matrix(vp_matrix, request.vplot_smooth, request.vplot_log),
                        "size_min": size_min,
                        "size_max": size_max,
                        "size_bin": size_bin,
                        "pos_bin": pos_bin,
                    }
                    timings["vplot_finalize"] = timings.get("vplot_finalize", 0) + round(time.perf_counter() - phase_t0, 4)
            except Exception as e:
                if include_profiles or include_vplot:
                    profiles[ds_id] = {"aggregate": [], "window": profile_window, "error": str(e)}
                if include_vplot:
                    vplot[ds_id] = {"matrix": [], "size_min": 10, "size_max": 300, "size_bin": 5, "pos_bin": 5, "error": str(e)}

    # --- Step 5: Co-occupancy (1+ groups) ---
    co_occupancy = {}
    if include_coocc and request.groups and len(request.groups) >= 1:
        groups = request.groups
        for ds_id in dataset_ids:
            try:
                ws = ws_cache.get(ds_id)
                if ws is None:
                    phase_t0 = time.perf_counter()
                    ws = query.build_working_set(state, ds_id)
                    ws = _cap_working_set(ds_id, ws, f"coocc:{region_start}:{region_end}")
                    timings["coocc_working_set"] = timings.get("coocc_working_set", 0) + round(time.perf_counter() - phase_t0, 4)
                table = table_cache.get(ds_id)
                if table is None:
                    phase_t0 = time.perf_counter()
                    table = _get_interval_table(ws, primary_table_key, layer_resolver.intervals)
                    timings["coocc_interval_table"] = timings.get("coocc_interval_table", 0) + round(time.perf_counter() - phase_t0, 4)
                phase_t0 = time.perf_counter()
                from services.consensus_occupancy import class_occupancy
                # A saved class whose run is gone (restart, session import) is marked unavailable and left out;
                # it must not take down co-occupancy for every other group of the dataset.
                class_not_evaluated, class_unavailable = {}, {}
                class_memberships, class_eligible = class_occupancy(
                    state, ds_id, resolved_chrom, ws.reads, groups,
                    not_evaluated_out=class_not_evaluated, unavailable_out=class_unavailable)
                class_ambiguous = {}
                for gi, group in enumerate(groups):
                    if group.get('consensusStateId') or not group.get('layer'):
                        continue
                    resolver = FootprintLayerResolver(group['layer'])
                    group_table = _get_interval_table(ws, resolver.primary_table_key, resolver.intervals, resolver.family_metadata)
                    ambiguous = {}
                    class_memberships[gi] = compute_group_memberships(
                        group_table, [group], footprints, ambiguous_out=ambiguous)[0]
                    if ambiguous.get(0):
                        class_ambiguous[gi] = ambiguous[0]
                coocc_result = compute_cooccupancy_result(
                    table,
                    groups,
                    footprints,
                    total_reads=len(ws.reads),
                    class_memberships=class_memberships,
                    class_eligible=class_eligible,
                    class_ambiguous=class_ambiguous,
                    class_not_evaluated=class_not_evaluated,
                    class_unavailable=class_unavailable,
                )
                timings["coocc_membership"] = timings.get("coocc_membership", 0) + round(time.perf_counter() - phase_t0, 4)
                co_occupancy[ds_id] = coocc_result
            except Exception as e:
                co_occupancy[ds_id] = {"pairs": [], "per_group": [], "total_reads": 0, "error": str(e)}
        add_cooccupancy_fdr(co_occupancy)

    if motif_warnings:
        for w in motif_warnings:
            _print_footprint_warning_once(("motif_warning", w), f"  [Motif warning] {w}")

    layer_warning = layer_resolver.missing_warning()
    if layer_warning:
        motif_warnings.append(layer_warning)

    timings["total"] = round(time.perf_counter() - total_t0, 4)
    return {
        "success": True,
        "footprints": result_footprints,
        "overlap_stats": overlap_stats,
        "profiles": profiles,
        "vplot": vplot,
        "motif_pwms": motif_pwms,
        "motif_sources": motif_sources,
            "jaspar_species": jaspar_species,
            "motif_scoring": {"mode": motif_mode, "p": motif_p_value, "relative": request.motif_threshold, "background": None if motif_bg is None else request.motif_background, "pinned": pinned_used, "unavailable": pinned_unavailable},
        "co_occupancy": co_occupancy,
        "warnings": motif_warnings if motif_warnings else None,
        "sample_seed": sample_seed if max_reads else None,
        "timings": timings,
    }
