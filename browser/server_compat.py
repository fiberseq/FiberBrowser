"""Compatibility functions historically exposed from server.py.

The canonical implementations live in browser/services/*. server.py lazily
re-exports this module through __getattr__ so legacy notebooks and scripts can
keep importing server.<helper> without forcing the browser to eagerly import
every analysis dependency at startup.
"""
from __future__ import annotations

import sys
from typing import Dict, List, Optional

import numpy as np

from services.read_metrics import DEFAULT_SAMPLE_SEED
from state.runtime_state import get_browser_state
from state.runtime_state import get_dafc_runtime_state

_bigbed_format_cache = {}


def _contig_links(state, path):
    from services.plasmid_reconcile import contig_links
    return contig_links(state, path=path)


def _chrom_map():
    state = get_browser_state()
    return getattr(state, "chrom_map", None)


def _server_override(name: str, default):
    """Return a monkeypatched server export when present, without importing server."""
    module = sys.modules.get("server")
    return getattr(module, name, default) if module is not None else default


def render_reads_to_image(reads_df, cluster_assignments=None, sorted_indices=None,
                          max_width=2000, row_height=3):
    """Compatibility wrapper for server-side read image rendering."""
    from services.read_rendering import render_reads_to_image as _render_reads_to_image

    return _render_reads_to_image(
        reads_df,
        cluster_assignments=cluster_assignments,
        sorted_indices=sorted_indices,
        max_width=max_width,
        row_height=row_height,
    )


def build_rd_fast_signed(bed_df, chrom, region_start, region_end, spanning_only=True):
    """Compatibility wrapper for legacy dense BigBed read-table construction."""
    from services.bigbed_read_loader import build_rd_fast_signed as _build_rd_fast_signed

    return _build_rd_fast_signed(bed_df, chrom, region_start, region_end, spanning_only=spanning_only)


def get_bigbed_handle(filepath: str):
    """Compatibility wrapper for cached BigBed handles."""
    from services.bigbed_handles import get_bigbed_handle as _get_bigbed_handle

    return _get_bigbed_handle(filepath)


def close_all_bigbed_handles():
    """Compatibility wrapper for closing cached BigBed handles."""
    from services.bigbed_handles import close_all_bigbed_handles as _close_all_bigbed_handles

    return _close_all_bigbed_handles()


def get_bam_handle(filepath: str) -> Optional['pysam.AlignmentFile']:
    """Compatibility wrapper for cached BAM handles."""
    from services.bam_handles import get_bam_handle as _get_bam_handle

    return _get_bam_handle(filepath)


def close_all_bam_handles():
    """Compatibility wrapper for closing cached BAM handles."""
    from services.bam_handles import close_all_bam_handles as _close_all_bam_handles

    return _close_all_bam_handles()


def _detect_swapped_bed12_columns(df, sample_size=10) -> bool:
    """Compatibility wrapper for BigBed BED12 column-order detection."""
    from services.compact_read_loader import detect_swapped_bed12_columns

    return detect_swapped_bed12_columns(df, sample_size=sample_size)


def load_reads_from_bigbed(bigbed_path, chrom, start, end, spanning_only=True):
    """Compatibility wrapper for legacy dense BigBed read-table loading."""
    from services.bigbed_read_loader import load_reads_from_bigbed as _load_reads_from_bigbed

    return _load_reads_from_bigbed(
        bigbed_path,
        chrom,
        start,
        end,
        spanning_only=spanning_only,
        bigbed_handle_getter=_server_override("get_bigbed_handle", get_bigbed_handle),
        swapped_column_detector=_server_override("_detect_swapped_bed12_columns", _detect_swapped_bed12_columns),
        format_cache=_bigbed_format_cache,
    )


def diagnose_bam_tags(bam_path, chrom=None, limit=10):
    """Compatibility wrapper for BAM tag/layer diagnostics."""
    from services.bam_diagnostics import diagnose_bam_tags as _diagnose_bam_tags

    return _diagnose_bam_tags(bam_path, chrom=chrom, limit=limit)


def get_read_boundaries_from_bam(bam_path, chrom, start, end, max_reads=5000):
    """Compatibility wrapper for fast BAM boundary extraction."""
    from services.bam_boundaries import get_read_boundaries_from_bam as _get_boundaries

    return _get_boundaries(
        bam_path,
        chrom,
        start,
        end,
        max_reads=max_reads,
        chrom_map=_chrom_map(),
        contig_links=_contig_links(get_browser_state(), bam_path),
    )


def extract_cigar_events(read, region_start, region_end):
    """Compatibility wrapper for compact-read CIGAR event extraction."""
    from services.compact_read_loader import extract_cigar_events as _extract_cigar_events

    return _extract_cigar_events(read, region_start, region_end)


def build_cigar_coord_mapper(cigartuples, ref_start):
    """Compatibility wrapper for compact-read CIGAR coordinate mapping."""
    from services.compact_read_loader import build_cigar_coord_mapper as _build_mapper

    return _build_mapper(cigartuples, ref_start)


def check_bam_index(bam_path):
    """Check if a BAM index exists. Returns a warning message string if missing, or None if OK."""
    from services.bam_handles import check_bam_index as _check_bam_index

    return _check_bam_index(bam_path)


def load_reads_from_bam(bam_path, chrom, start, end, spanning_only=True):
    """Compatibility wrapper for legacy dense BAM DataFrame loading."""
    from services.dense_bam_loader import load_reads_from_bam as _load_reads_from_bam

    return _load_reads_from_bam(
        bam_path,
        chrom,
        start,
        end,
        spanning_only=spanning_only,
        chrom_map=_chrom_map(),
        contig_links=_contig_links(get_browser_state(), bam_path),
    )


def _parse_gtf_attrs(attrs_str):
    """Compatibility wrapper for the extracted GTF attribute parser."""
    from services.gene_annotations import _parse_gtf_attrs as _parse_gtf_attrs_service

    return _parse_gtf_attrs_service(attrs_str)


def _parse_gff3_attrs(attrs_str):
    """Compatibility wrapper for the extracted GFF3 attribute parser."""
    from services.gene_annotations import _parse_gff3_attrs as _parse_gff3_attrs_service

    return _parse_gff3_attrs_service(attrs_str)


def _clean_blast_name(raw_name: str) -> str:
    """Compatibility wrapper for the extracted BLAST hit name cleaner."""
    from services.gene_annotations import _clean_blast_name as _clean_blast_name_service

    return _clean_blast_name_service(raw_name)


def load_gtf(gtf_path):
    """Compatibility wrapper for GTF/GFF3 annotation loading."""
    from services.gene_annotations import load_gtf as _load_gtf

    return _load_gtf(gtf_path)


def load_fire_data(fire_dir):
    """Compatibility wrapper for FIRE BED loading."""
    from services.fire_tracks import load_fire_data as _load_fire_data

    return _load_fire_data(fire_dir)


def compute_fire_track(fire_df, chrom, start, end):
    """Compatibility wrapper for FIRE signal computation."""
    from services.fire_tracks import compute_fire_track as _compute_fire_track

    return _compute_fire_track(fire_df, chrom, start, end)


def scan_for_peaks(reads_df, start, end, n_clusters=8, min_width=80, random_state=42):
    """Compatibility wrapper for accessibility peak scanning."""
    from services.accessibility_tracks import scan_for_peaks as _scan_for_peaks

    return _scan_for_peaks(
        reads_df,
        start,
        end,
        n_clusters=n_clusters,
        min_width=min_width,
        random_state=random_state,
    )


def compute_accessibility_track(reads_df, start, end, window=30, random_state=42):
    """Compatibility wrapper for accessibility track computation."""
    from services.accessibility_tracks import compute_accessibility_track as _compute_accessibility_track

    return _compute_accessibility_track(
        reads_df,
        start,
        end,
        window=window,
        random_state=random_state,
    )


def meta_line_plot(reads_df, start, end, fp_min, fp_max):
    """Compatibility wrapper for metaprofile calculation."""
    from services.accessibility_tracks import meta_line_plot as _meta_line_plot

    return _meta_line_plot(reads_df, start, end, fp_min, fp_max)


def cluster_reads(reads_df, peak_regions, n_clusters, start, method='kmeans',
                  subnucleosomal_threshold=90, accessibility_threshold=0.5,
                  peak_modes=None, random_state=42):
    """Compatibility wrapper for legacy DataFrame cluster assignment."""
    from services.cluster_assignment import cluster_reads as _cluster_reads

    return _cluster_reads(
        reads_df,
        peak_regions,
        n_clusters,
        start,
        method=method,
        subnucleosomal_threshold=subnucleosomal_threshold,
        accessibility_threshold=accessibility_threshold,
        peak_modes=peak_modes,
        random_state=random_state,
    )


def cluster_compact_reads(compact_reads, peak_regions, region_start, n_clusters, method='kmeans',
                          subnucleosomal_threshold=90, accessibility_threshold=0.5,
                          peak_modes=None, random_state=42):
    """Compatibility wrapper for compact-read cluster assignment."""
    from services.cluster_assignment import cluster_compact_reads as _cluster_compact_reads

    return _cluster_compact_reads(
        compact_reads,
        peak_regions,
        region_start,
        n_clusters,
        method=method,
        subnucleosomal_threshold=subnucleosomal_threshold,
        accessibility_threshold=accessibility_threshold,
        peak_modes=peak_modes,
        random_state=random_state,
    )


def load_orthogonal_tracks(tracks_file):
    """Compatibility wrapper for orthogonal track file parsing."""
    from services.orthogonal_tracks import load_orthogonal_tracks as _load_orthogonal_tracks

    return _load_orthogonal_tracks(tracks_file)


def parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold=125):
    """Compatibility wrapper for MM/ML tag parsing."""
    from services.bam_tags import parse_mm_ml_tags_by_type as _parse_mm_ml_tags_by_type

    return _parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold)


def parse_mm_ml_tags(read, region_start, region_end, ml_threshold=125):
    """Compatibility wrapper returning m6A-only MM/ML positions."""
    from services.bam_tags import parse_mm_ml_tags as _parse_mm_ml_tags

    return _parse_mm_ml_tags(read, region_start, region_end, ml_threshold)


def parse_iupac_ry_positions(read, region_start, region_end):
    """Compatibility wrapper for IUPAC R/Y deamination parsing."""
    from services.bam_tags import parse_iupac_ry_positions as _parse_iupac_ry_positions

    return _parse_iupac_ry_positions(read, region_start, region_end)


def parse_daf_mismatches(read, region_start, region_end):
    """Compatibility wrapper for mismatch-based DAF deamination parsing."""
    from services.bam_tags import parse_daf_mismatches as _parse_daf_mismatches

    return _parse_daf_mismatches(read, region_start, region_end)


def parse_ma_aq_tags_into_layers(ma_str: str, aq_values, coord_mapper,
                                 region_start: int, region_end: int,
                                 include_qualities: bool = True,
                                 *,
                                 include_names=None,
                                 read_length: int = 0,
                                 is_reverse: bool = False,
                                 tags_are_molecular: bool = False) -> Dict[str, Dict]:
    """Compatibility wrapper for MA/AQ layer parsing."""
    from services.bam_tags import parse_ma_aq_tags_into_layers as _parse_ma_aq_tags_into_layers

    return _parse_ma_aq_tags_into_layers(
        ma_str,
        aq_values,
        coord_mapper,
        region_start,
        region_end,
        include_names=include_names,
        include_qualities=include_qualities,
        read_length=read_length,
        is_reverse=is_reverse,
        tags_are_molecular=tags_are_molecular,
    )


def generate_msp_from_nuc_gaps(intervals, min_nuc_size: int = 90) -> List:
    """Compatibility wrapper for MSP fallback interval generation."""
    from services.bam_tags import generate_msp_from_nuc_gaps as _generate_msp_from_nuc_gaps

    return _generate_msp_from_nuc_gaps(intervals, min_nuc_size=min_nuc_size)


def build_legacy_layers(intervals,
                        fp_quality_list, lq_quality_list, rq_quality_list,
                        fire_intervals,
                        region_start: int, region_end: int,
                        infer_layers: bool = True,
                        nuc_min_size: int = 90,
                        include_qualities: bool = True,
                        infer_tf: bool = True,
                        infer_nuc: bool = True,
                        infer_msp: bool = True) -> Dict[str, Dict]:
    """Compatibility wrapper for legacy BAM layer construction."""
    from services.bam_tags import build_legacy_layers as _build_legacy_layers

    return _build_legacy_layers(
        intervals,
        fp_quality_list,
        lq_quality_list,
        rq_quality_list,
        fire_intervals,
        region_start,
        region_end,
        infer_layers=infer_layers,
        nuc_min_size=nuc_min_size,
        include_qualities=include_qualities,
        infer_tf=infer_tf,
        infer_nuc=infer_nuc,
        infer_msp=infer_msp,
    )


def build_compact_reads_from_bam(
    bam_path,
    chrom,
    region_start,
    region_end,
    spanning_only=True,
    include_methylation=False,
    ml_threshold=125,
    min_fp_quality=0,
    include_cigar=False,
    hide_terminal_gaps=True,
    terminal_gap_threshold=500,
    include_layers=True,
    requested_layers=None,
    include_layer_qualities=True,
    infer_legacy_layers=True,
    legacy_nuc_min_size=90,
):
    """Compatibility wrapper for BAM compact-read loading."""
    from services.compact_read_loader import build_compact_reads_from_bam as _build_compact_reads_from_bam

    state = get_browser_state()
    return _build_compact_reads_from_bam(
        bam_path,
        chrom,
        region_start,
        region_end,
        spanning_only=spanning_only,
        include_methylation=include_methylation,
        ml_threshold=ml_threshold,
        min_fp_quality=min_fp_quality,
        include_cigar=include_cigar,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        include_layers=include_layers,
        requested_layers=requested_layers,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        bam_handle_getter=_server_override("get_bam_handle", get_bam_handle),
        chrom_map=getattr(state, "chrom_map", None),
        contig_links=_contig_links(state, bam_path),
        sv_reference=getattr(state, 'fasta_path', None),
    )


def fill_small_gaps_in_read(read: dict, min_gap_size: int) -> dict:
    """Compatibility wrapper for compact-read gap filling."""
    from services.read_metrics import fill_small_gaps_in_read as _fill_small_gaps

    return _fill_small_gaps(read, min_gap_size)


def extract_features_from_compact(compact_reads, peak_regions, region_start, step=10, subnucleosomal_threshold=90, peak_modes=None):
    """Compatibility wrapper for the extracted clustering feature service."""
    from services.clustering_features import extract_features_from_compact as _extract_features_from_compact

    return _extract_features_from_compact(
        compact_reads,
        peak_regions,
        region_start,
        step=step,
        subnucleosomal_threshold=subnucleosomal_threshold,
        peak_modes=peak_modes,
    )


def compact_reads_to_dataframe(compact_reads, region_start, region_end):
    """Compatibility wrapper for compact-read DataFrame conversion."""
    from services.read_metrics import compact_reads_to_dataframe as _compact_reads_to_dataframe

    return _compact_reads_to_dataframe(compact_reads, region_start, region_end)


def build_compact_reads(
    bigbed_path,
    chrom,
    region_start,
    region_end,
    spanning_only=True,
    include_methylation=False,
    ml_threshold=125,
    hide_terminal_gaps=True,
    terminal_gap_threshold=500,
    include_layers=True,
    requested_layers=None,
    include_layer_qualities=True,
    infer_legacy_layers=True,
    legacy_nuc_min_size=90,
):
    """Compatibility wrapper for compact BigBed read loading."""
    from services.compact_read_loader import build_compact_reads_from_bigbed as _build_compact_reads_from_bigbed

    return _build_compact_reads_from_bigbed(
        bigbed_path,
        chrom,
        region_start,
        region_end,
        spanning_only=spanning_only,
        include_methylation=include_methylation,
        ml_threshold=ml_threshold,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        include_layers=include_layers,
        requested_layers=requested_layers,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        bigbed_handle_getter=_server_override("get_bigbed_handle", get_bigbed_handle),
        overlay_type_detector=_server_override("detect_overlay_type", detect_overlay_type),
        swapped_column_detector=_server_override("_detect_swapped_bed12_columns", _detect_swapped_bed12_columns),
        format_cache=_bigbed_format_cache,
    )


def load_methyl_from_bigbed(bigbed_path: str, chrom: str, region_start: int, region_end: int,
                            layer_type: str = 'm6a') -> dict:
    """Compatibility wrapper for companion BigBed modification/deamination marks."""
    from services.bigbed_read_loader import load_methyl_from_bigbed as _load_methyl_from_bigbed

    return _load_methyl_from_bigbed(
        bigbed_path,
        chrom,
        region_start,
        region_end,
        layer_type=layer_type,
        bigbed_handle_getter=_server_override("get_bigbed_handle", get_bigbed_handle),
    )


def sample_by_coverage(reads: list, n: int, region_start: int, region_end: int) -> list:
    """Compatibility wrapper for compact-read sampling."""
    from services.read_metrics import sample_by_coverage as _sample_by_coverage

    return _sample_by_coverage(reads, n, region_start, region_end)


def sample_stable_by_id(reads: list, n: int, seed: str = DEFAULT_SAMPLE_SEED) -> list:
    """Compatibility wrapper for deterministic analysis sampling."""
    from services.read_metrics import sample_stable_by_id as _sample_stable_by_id

    return _sample_stable_by_id(reads, n, seed=seed)


def read_covers_regions(read: dict, regions: list) -> bool:
    """Compatibility wrapper for compact-read target coverage checks."""
    from services.read_metrics import read_covers_regions as _read_covers_regions

    return _read_covers_regions(read, regions)


def filter_reads_covering_regions(reads: list, regions: list) -> list:
    """Compatibility wrapper for target-covering compact-read filtering."""
    from services.read_metrics import filter_reads_covering_regions as _filter_reads_covering_regions

    return _filter_reads_covering_regions(reads, regions)


def compute_metaprofile_from_compact_reads(reads: list, region_width: int, min_size: int, max_size: int, layer: Optional[str] = None) -> np.ndarray:
    """Compatibility wrapper for compact-read metaprofile computation."""
    from services.read_metrics import compute_metaprofile_from_compact_reads as _compute_metaprofile

    return _compute_metaprofile(reads, region_width, min_size, max_size, layer=layer)


def _get_gene_region_records(chrom, start, end):
    """Get gene records from GTF overlapping the view."""
    from services.gene_annotations import get_gene_region_records

    state = get_browser_state()
    return get_gene_region_records(getattr(state, "gtf_data", None), chrom, start, end)


def _get_gene_regions(chrom, start, end):
    """Get gene regions from GTF overlapping the view."""
    return [(rec["start"], rec["end"]) for rec in _get_gene_region_records(chrom, start, end)]


def _midpoint_in_regions(abs_midpoint, regions):
    """Compatibility wrapper for read metric region checks."""
    from services.read_metrics import midpoint_in_regions as _midpoint_in_regions

    return _midpoint_in_regions(abs_midpoint, regions)


def _get_layer_intervals(read, layer: Optional[str]):
    """Compatibility wrapper for layer-aware interval resolution."""
    from services.read_metrics import get_layer_intervals as _get_layer_intervals

    return _get_layer_intervals(read, layer)


def _compute_rule_metric(
    read,
    region_start,
    rule,
    gene_regions,
    peak_regions,
    layer: Optional[str] = None,
    gene_regions_by_key: Optional[dict] = None,
    scope_windows: Optional[list] = None,
):
    """Compatibility wrapper for layer-aware rule metric computation."""
    from services.read_metrics import compute_rule_metric as _compute_rule_metric

    return _compute_rule_metric(
        read,
        region_start,
        rule,
        gene_regions,
        peak_regions,
        layer=layer,
        gene_regions_by_key=gene_regions_by_key,
        scope_windows=scope_windows,
    )


def _compute_fp_metrics(read, region_start, scope_windows=None, layer: Optional[str] = None):
    """Compatibility wrapper for layer-aware footprint metric computation."""
    from services.read_metrics import compute_fp_metrics as _compute_fp_metrics

    return _compute_fp_metrics(read, region_start, scope_windows=scope_windows, layer=layer)


def _sort_similarity_for_dataset(ds_id, chrom, start, end, spanning, sample_seed=DEFAULT_SAMPLE_SEED):
    """Sort clusters by similarity for a single dataset. Returns result dict."""
    from services.read_sorting import sort_similarity_for_dataset

    state = get_browser_state()
    if state is None:
        return {"cluster_order": [], "read_sort_order": []}
    return sort_similarity_for_dataset(
        state,
        ds_id,
        chrom,
        start,
        end,
        spanning,
        sample_seed=sample_seed,
    )


def run_autocull_on(features: np.ndarray,
                    assignments: np.ndarray,
                    min_fraction: float = 0.05,
                    max_cosine_similarity: float = 0.95,
                    min_remaining: int = 2,
                    max_iter: int = 50,
                    strategy: str = 'cosine',
                    threshold: Optional[float] = None,
                    alpha: float = 0.01):
    """Compatibility wrapper for clustering autocull post-processing."""
    from services.cluster_analysis import run_autocull_on as _run_autocull_on

    return _run_autocull_on(
        features,
        assignments,
        min_fraction=min_fraction,
        max_cosine_similarity=max_cosine_similarity,
        min_remaining=min_remaining,
        max_iter=max_iter,
        strategy=strategy,
        threshold=threshold,
        alpha=alpha,
    )


def compute_cluster_projection(features: np.ndarray,
                               method: str = 'pca',
                               n_components: int = 2,
                               random_state: int = 42):
    """Compatibility wrapper for clustering projection post-processing."""
    from services.cluster_analysis import compute_cluster_projection as _compute_cluster_projection

    return _compute_cluster_projection(
        features,
        method=method,
        n_components=n_components,
        random_state=random_state,
    )


def resolve_tf_source(read: dict) -> List:
    """Compatibility wrapper for transcription-state interval source logic."""
    from services.transcription_state import resolve_tf_source as _resolve_tf_source

    return _resolve_tf_source(read)


def resolve_nuc_source(read: dict) -> List:
    """Compatibility wrapper for transcription-state interval source logic."""
    from services.transcription_state import resolve_nuc_source as _resolve_nuc_source

    return _resolve_nuc_source(read)


def get_footprints_in_region(read_intervals: List, tss: int, offset_start: int, offset_end: int, strand: str, region_start: int) -> List[int]:
    """Compatibility wrapper for transcription-state footprint lookup."""
    from services.transcription_state import get_footprints_in_region as _get_footprints_in_region

    return _get_footprints_in_region(read_intervals, tss, offset_start, offset_end, strand, region_start)


def get_footprints_in_gene_body(read_intervals: List, tss: int, tes: int, strand: str, region_start: int) -> List[int]:
    """Compatibility wrapper for transcription-state footprint lookup."""
    from services.transcription_state import get_footprints_in_gene_body as _get_footprints_in_gene_body

    return _get_footprints_in_gene_body(read_intervals, tss, tes, strand, region_start)


def calc_nucleosome_coverage(read_intervals: List, gene_start: int, gene_end: int, region_start: int) -> float:
    """Compatibility wrapper for transcription-state nucleosome coverage."""
    from services.transcription_state import calc_nucleosome_coverage as _calc_nucleosome_coverage

    return _calc_nucleosome_coverage(read_intervals, gene_start, gene_end, region_start)


def evaluate_read_states(read, gene: dict, region_start: int) -> dict:
    """Compatibility wrapper for transcription-state evaluation."""
    from services.transcription_state import evaluate_read_states as _evaluate_read_states

    return _evaluate_read_states(read, gene, region_start)


def _parse_bed_file(path):
    """Compatibility wrapper for plain BED parsing."""
    from services.orthogonal_tracks import parse_bed_file

    return parse_bed_file(path)


def _get_default_initial_position():
    """Return a default initial position from browser or DAF-C chrom metadata."""
    from services.genome_registry import get_default_initial_position

    state = get_browser_state()
    dafc_state = get_dafc_runtime_state()
    return get_default_initial_position(
        state.chroms if state and state.chroms else None,
        dafc_state.chroms if dafc_state and dafc_state.chroms else None,
    )


def _load_genome_blocking(genome_id: str, info: dict) -> dict:
    """Blocking genome load (FASTA + GTF). Run in thread pool."""
    from services.genome_loading import load_genome_blocking

    return load_genome_blocking(get_browser_state(), genome_id, info)


def detect_bigbed_autosql_type(path: str) -> Optional[str]:
    """Compatibility wrapper for BigBed autoSQL layer detection."""
    from services.bigbed_detection import detect_bigbed_autosql_type as _detect

    return _detect(path)


def detect_bigbed_autosql_sample(path: str) -> Optional[str]:
    """Compatibility wrapper for BigBed autoSQL sample detection."""
    from services.bigbed_detection import detect_bigbed_autosql_sample as _detect

    return _detect(path)


def detect_overlay_type(path: str) -> str:
    """Compatibility wrapper for BigBed overlay type detection."""
    from services.bigbed_detection import detect_overlay_type as _detect

    return _detect(path)


def _find_companion_bigbed_files(primary_path: str, primary_layer_type: str) -> dict:
    """Compatibility wrapper for BigBed companion discovery."""
    from services.bigbed_detection import find_companion_bigbed_files

    return find_companion_bigbed_files(primary_path, primary_layer_type)


def is_annotation_bigbed(path: str) -> bool:
    """Compatibility wrapper for annotation BigBed detection."""
    from services.annotation_bigbed import is_annotation_bigbed as _is_annotation_bigbed

    return _is_annotation_bigbed(path)


def _find_annotation_bigbed_files(primary_path: str) -> list:
    """Compatibility wrapper for annotation BigBed discovery."""
    from services.annotation_bigbed import find_annotation_bigbed_files

    return find_annotation_bigbed_files(primary_path)


def _load_annotation_manifest(annotation_path: str):
    """Compatibility wrapper for annotation manifest loading."""
    from services.annotation_bigbed import load_annotation_manifest

    return load_annotation_manifest(annotation_path)


def load_annotations_from_bigbed(path, chrom, start, end, confidence_thresholds=None,
                                 read_names=None, max_entries=500000):
    """Compatibility wrapper for annotation BigBed loading."""
    from services.annotation_bigbed import load_annotations_from_bigbed as _load_annotations

    return _load_annotations(
        path,
        chrom,
        start,
        end,
        confidence_thresholds=confidence_thresholds,
        read_names=read_names,
        max_entries=max_entries,
    )


def discover_annotation_types(path, sample_size=1000):
    """Compatibility wrapper for annotation type discovery."""
    from services.annotation_bigbed import discover_annotation_types as _discover_annotation_types

    return _discover_annotation_types(path, sample_size=sample_size)


def join_annotations_to_reads(compact_reads, annotation_dict, region_start):
    """Compatibility wrapper for joining annotations to compact reads."""
    from services.annotation_bigbed import join_annotations_to_reads as _join_annotations

    return _join_annotations(compact_reads, annotation_dict, region_start)


from services.bigbed_detection import OVERLAY_COLORS
from services import motifs as _motif_service

GENOME_TO_JASPAR_SPECIES = _motif_service.GENOME_TO_JASPAR_SPECIES
HAS_PYJASPAR = _motif_service.HAS_PYJASPAR
_jaspar_cache = _motif_service._jaspar_cache
_jaspar_lock = _motif_service._jaspar_lock


def _check_pyjaspar():
    """Compatibility wrapper for motif service pyjaspar detection."""
    global HAS_PYJASPAR
    result = _motif_service.check_pyjaspar()
    HAS_PYJASPAR = _motif_service.HAS_PYJASPAR
    module = sys.modules.get("server")
    if module is not None:
        module.HAS_PYJASPAR = HAS_PYJASPAR
    return result


def get_jaspar_db(release: str = "JASPAR2024"):
    """Compatibility wrapper for motif service JASPAR access."""
    return _motif_service.get_jaspar_db(release=release)


def pwm_to_pssm(counts: Dict[str, List[float]], pseudocount: float = 0.1,
               background: Optional[Dict[str, float]] = None) -> np.ndarray:
    """Compatibility wrapper for motif PWM conversion."""
    return _motif_service.pwm_to_pssm(counts, pseudocount=pseudocount, background=background)


def scan_sequence(seq: str, pssm: np.ndarray, threshold: float) -> List[Dict]:
    """Compatibility wrapper for motif sequence scanning."""
    return _motif_service.scan_sequence(seq, pssm, threshold)


def scan_both_strands(seq: str, pssm: np.ndarray, threshold: float) -> List[Dict]:
    """Compatibility wrapper for motif sequence scanning."""
    return _motif_service.scan_both_strands(seq, pssm, threshold)


def consensus_to_pwm(sequence: str) -> Dict[str, List[float]]:
    """Compatibility wrapper for consensus motif conversion."""
    return _motif_service.consensus_to_pwm(sequence)


def parse_homer_file(file_path: str) -> Dict[str, Dict]:
    """Compatibility wrapper for HOMER motif parsing."""
    return _motif_service.parse_homer_file(file_path)


def parse_jaspar_file(file_path: str) -> Dict[str, Dict]:
    """Compatibility wrapper for JASPAR motif parsing."""
    return _motif_service.parse_jaspar_file(file_path)


def parse_meme_file(file_path: str) -> Dict[str, Dict]:
    """Compatibility wrapper for MEME motif parsing."""
    return _motif_service.parse_meme_file(file_path)


def _reverse_complement(seq: str) -> str:
    """Compatibility wrapper for motif reverse complement."""
    return _motif_service.reverse_complement(seq)
