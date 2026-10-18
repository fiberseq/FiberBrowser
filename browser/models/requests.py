"""Pydantic request models extracted from server.py.

All request/response models used by API endpoints. Organized by feature area.
"""

import math
from typing import Annotated, Any, Optional, List, Dict, Literal
from pydantic import BaseModel, BeforeValidator, Field


class PerformanceModeRequest(BaseModel):
    mode: Literal['auto', 'low', 'standard', 'high'] = 'auto'
    browser_tier: Optional[Literal['low', 'standard', 'high']] = None
    persist: bool = True


def _reject_removed_transcription_state(value: Any) -> Any:
    # The legacy "hyperburst" Pol II state was removed; old sessions/API
    # callers may still send it, so give a clear 422 instead of a bare
    # Literal mismatch.
    if isinstance(value, str) and value.strip().lower() == "hyperburst":
        raise ValueError(
            "The 'hyperburst' transcription state has been removed; "
            "use 'pause', 'pic' or 'elongating'"
        )
    return value


def _check_merge_strategy(value: Any) -> Any:
    # "Merge by" (services/cluster_analysis.MERGE_STRATEGIES): a plain 422 for an unknown one.
    allowed = ("cosine", "correlation", "difference", "js", "connectivity")
    if value is None:
        return "cosine"
    if isinstance(value, str) and value.strip().lower() in allowed:
        return value.strip().lower()
    raise ValueError(f"Unknown merge strategy {value!r}: use one of {', '.join(allowed)}")


MergeStrategy = Annotated[str, BeforeValidator(_check_merge_strategy)]


TranscriptionStateKind = Annotated[
    Literal["pause", "pic", "elongating"],
    BeforeValidator(_reject_removed_transcription_state),
]


# ── Dataset Management ──────────────────────────────────────────────────────

class AddDatasetRequest(BaseModel):
    path: Optional[str] = None
    paths: Optional[List[str]] = None
    label: Optional[str] = None
    url: Optional[str] = None

class MergeDatasetsRequest(BaseModel):
    dataset_ids: List[str]
    label: Optional[str] = None

class UnmergeDatasetsRequest(BaseModel):
    dataset_id: str

class DatasetChemistryRequest(BaseModel):
    persist: bool = False
    platform: Optional[Literal["pacbio", "nanopore", "illumina"]] = None
    chemistry: Literal['ddda', 'dddb', 'hia5-pacbio', 'hia5-nanopore']


# ── Peak Scanning & Clustering ──────────────────────────────────────────────

def _whole_base(value: Any, rounding, field: str) -> Any:
    # A footprint class's edges are medians of call edges and can fall on a
    # half base (47515967.5). Peak regions are whole bases: a fractional edge
    # is widened outward (floor start, ceil end) so the region covers the class.
    if isinstance(value, bool):
        raise ValueError(f"peak region {field} must be a genomic position (whole bases), not {value!r}")
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"peak region {field} must be a finite genomic position, not {value!r}")
        return int(rounding(value))
    return value


class PeakRegion(BaseModel):
    start: Annotated[int, BeforeValidator(lambda v: _whole_base(v, math.floor, 'start'))]
    end: Annotated[int, BeforeValidator(lambda v: _whole_base(v, math.ceil, 'end'))]
    mode: str = 'accessibility'  # 'accessibility', 'tf', 'modification', 'annotation', or 'off'

class ScanPeaksRequest(BaseModel):
    lift_hap: Optional[str] = None
    strand: Optional[Literal["CT", "GA"]] = None
    min_width: int = 80
    min_reads: int = 5
    smooth_width: int = 100
    threshold_strong: float = 0.50
    threshold_medium: float = 0.30
    threshold_weak: float = 0.15
    threshold_rare: float = 0.08
    # Widest call kept as a peak (bp); wider ones are the view's background
    # accessibility and come back under "broad_peaks". 0 = no limit.
    max_peak_width: int = Field(2000, ge=0)
    save_plot: bool = False
    downsample: Optional[int] = None
    read_ids: Optional[List[str]] = None
    read_ids_by_dataset: Optional[Dict[str, List[str]]] = None
    dataset_ids: Optional[List[str]] = None
    sample_seed: Optional[str] = None
    signal_source: str = 'accessibility'
    return_signal: bool = False
    signal_bins: int = 500

class ClusterRequest(BaseModel):
    peak_indices: List[int]
    k: int = 5
    filter_mode: str = "either"

class ClusterViewport(BaseModel):
    dataset_id: str
    result_key: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    read_ids: Optional[List[str]] = None
    lift_hap: Optional[str] = None
    strand: Optional[Literal["CT", "GA"]] = None  # DAF-seq panel showing one strand
    # This window's own peaks (absolute), matched one-to-one and equal in width
    # to every other window's, so reads at different loci cluster together.
    peak_regions: Optional[List[PeakRegion]] = None


class ClusterAllRequest(BaseModel):
    # A target in distinct BAM read names, selected before tag decoding.
    # None preserves the full-cohort API behavior.
    preparation_sample_count: Optional[int] = Field(None, ge=1, le=100000)
    viewports: Optional[List[ClusterViewport]] = None
    peak_regions: List[PeakRegion] = []
    peak_indices: List[int] = []
    k: int = 5
    method: str = 'combinatorial'
    dataset_ids: List[str] = []
    read_ids: Optional[Dict[str, List[str]]] = None
    max_reads: Optional[int] = None
    sample_seed: Optional[str] = None
    extra_chroms: Optional[List[str]] = None
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5
    cluster_feature_rules: List[Dict[str, Any]] = []
    # method="graph": communities of the t-SNE neighbourhood graph; higher
    # resolution gives more, smaller clusters.
    resolution: float = Field(1.0, gt=0, le=20)

class MatchedViewPanel(BaseModel):
    """One dataset panel of a comparison view; its results come back under result_key."""
    dataset_id: str
    result_key: str
    read_ids: Optional[List[str]] = None
    lift_hap: Optional[str] = None
    strand: Optional[Literal["CT", "GA"]] = None


class MatchedClusterView(BaseModel):
    """One side of a two-view comparison: a locus, its panels and its matched features."""
    id: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    panels: List[MatchedViewPanel]
    # Absolute features in genomic order; feature i of each view is matched.
    peak_regions: List[PeakRegion]
    # The view runs the other way (an inverted haplotype or locus): its features
    # are matched right to left and each is read in reverse.
    reverse: bool = False


class MatchedClusterRequest(BaseModel):
    views: List[MatchedClusterView]
    # joint: one model over both views (shared, comparable states).
    # separate: one model per view (each view's own states).
    mode: Literal["joint", "separate"] = "joint"
    k: int = Field(default=5, ge=1, le=200)
    method: str = "kmeans"
    bins_per_feature: int = Field(default=20, ge=2, le=200)
    balance_views: bool = True
    max_reads: Optional[int] = None
    sample_seed: Optional[str] = None
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5


class DissolveClusterRequest(BaseModel):
    lift_hap_by_dataset: Optional[Dict[str, str]] = None
    cluster_to_dissolve: int
    current_assignments: Dict[str, Dict[str, int]]
    peak_regions: List[PeakRegion] = []
    dataset_ids: List[str] = []
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5
    sample_seed: Optional[str] = None
    cluster_feature_rules: List[Dict[str, Any]] = []

class AutoCullRequest(BaseModel):
    lift_hap_by_dataset: Optional[Dict[str, str]] = None
    current_assignments: Dict[str, Dict[str, int]]
    peak_regions: List[PeakRegion] = []
    dataset_ids: List[str] = []
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5
    min_fraction: float = 0.05
    max_cosine_similarity: float = 0.95
    # "Merge by": how two clusters are judged alike (None threshold: the
    # strategy's default; for cosine, max_cosine_similarity as before).
    merge_strategy: MergeStrategy = 'cosine'
    merge_threshold: Optional[float] = None
    # Benjamini–Hochberg q cutoff of the "difference" strategy's per-position tests.
    merge_alpha: float = Field(0.01, gt=0, lt=1)
    sample_seed: Optional[str] = None
    cluster_feature_rules: List[Dict[str, Any]] = []

class AssignToClustersRequest(BaseModel):
    viewports: Optional[List[ClusterViewport]] = None
    lift_hap_by_dataset: Optional[Dict[str, str]] = None
    peak_regions: List[PeakRegion] = []
    # Combinatorial dynamic reassignment uses binary patterns. Non-combinatorial
    # methods (kmeans, etc.) supply per-cluster centroids + the feature-column
    # widths instead, and reassign reads to the nearest centroid.
    cluster_patterns: Dict[int, List[int]] = {}
    cluster_centroids: Optional[Dict[int, List[float]]] = None
    cluster_peak_widths: Optional[List[int]] = None
    overlap_mode: str = 'aggressive'  # 'aggressive' (assign if overlaps any peak) | 'conservative' (require all peaks)
    dataset_ids: List[str] = []
    read_ids: Optional[Dict[str, List[str]]] = None
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5
    sample_seed: Optional[str] = None
    cluster_feature_rules: List[Dict[str, Any]] = []

class ClusterExpandRequest(BaseModel):
    cluster_ids: List[int] = []
    max_reads: int = 500
    dataset_id: Optional[str] = None
    sample_seed: Optional[str] = None
    # Optional frontend assignment override (active cluster-tree branch). When
    # provided, takes precedence over the backend's stored dataset assignments.
    cluster_assignments: Optional[Dict[str, Dict[str, int]]] = None

class ClusterVPlotRequest(BaseModel):
    size_bin: int = 10
    pos_bin: int = 10
    size_min: int = 10
    size_max: int = 300
    log_norm: bool = True
    smooth: float = 1.0
    layer: Optional[str] = None
    normalize: str = "per_cluster"
    # "midpoint": the traditional V-plot (each footprint counted at its centre);
    # "span": "full footprint", each footprint adds to every position it covers.
    mode: str = "midpoint"
    # Each size row over its mean across the window: enrichment of footprints
    # of that size at a position over the window's expectation for that size.
    row_normalize: bool = False
    # With row_normalize: size rows drawn from fewer footprints than this are
    # left blank (a handful of footprints is all noise once divided by its mean).
    row_min_footprints: int = 20
    sample_seed: Optional[str] = None
    cluster_assignments: Optional[Dict[str, Dict[str, int]]] = None

class ProjectionRequest(BaseModel):
    lift_hap_by_dataset: Optional[Dict[str, str]] = None
    dataset_ids: List[str] = []
    peak_regions: List[PeakRegion] = []
    # t-SNE by default: it keeps each read's nearest neighbours together.
    method: str = 'tsne'
    # t-SNE embeds at most this many reads (a seeded subsample); the rest are
    # placed by their nearest embedded reads. None: the default cap.
    max_reads: Optional[int] = Field(None, ge=4)
    # Per-read DAF strand (CT/GA) for the export: loads the reads' deamination
    # marks, which takes seconds on large windows, so only when asked.
    include_strands: bool = False
    n_components: int = 2
    subnucleosomal_threshold: int = 90
    accessibility_threshold: float = 0.5
    simulate_autocull: bool = False
    min_fraction: float = 0.05
    max_cosine_similarity: float = 0.95
    # "Merge by": how two clusters are judged alike (None threshold: the
    # strategy's default; for cosine, max_cosine_similarity as before).
    merge_strategy: MergeStrategy = 'cosine'
    merge_threshold: Optional[float] = None
    # Benjamini–Hochberg q cutoff of the "difference" strategy's per-position tests.
    merge_alpha: float = Field(0.01, gt=0, lt=1)
    sample_seed: Optional[str] = None
    cluster_feature_rules: List[Dict[str, Any]] = []
    cluster_assignments: Optional[Dict[str, Dict[str, int]]] = None


# ── Filtering & Sorting ────────────────────────────────────────────────────

class FilterRequest(BaseModel):
    """Filter reads by accessibility peaks."""
    peak_regions: List[PeakRegion] = []
    peak_indices: List[int] = []
    filter_mode: str = "either"
    layer: Optional[str] = None
    sample_seed: Optional[str] = None

class ProjectionSortSettings(BaseModel):
    peak_regions: List[PeakRegion] = []
    cluster_feature_rules: List[Dict[str, Any]] = []
    subnucleosomal_threshold: int = 90
    max_reads: Optional[int] = Field(None, ge=4)
    # The whole clustering the Projection tab maps (dataset -> read -> cluster).
    # The request's cluster_assignments / read_ids may be a subset (selected or
    # focused clusters, a filter): only those reads are ordered, but along the
    # map of all of them, so the order matches the map on screen.
    cluster_assignments: Optional[Dict[str, Dict[str, int]]] = None


class SortReadsRequest(BaseModel):
    dataset_ids: List[str] = []
    sort_by: str = 'rule'
    rule: Optional[dict] = None
    descending: bool = True
    linked: bool = True
    read_ids: Optional[Dict[str, List[str]]] = None
    cluster_assignments: Optional[Dict[str, Dict[str, int]]] = None
    peak_regions: Optional[List[List[int]]] = None
    selected_peak_windows: Optional[List[List[int]]] = None
    layer: Optional[str] = None
    transcription_state: Optional[TranscriptionStateKind] = None
    gene_ids: List[str] = []
    sample_seed: Optional[str] = None
    # sort_by="projection": the features of the Projection tab's map (its
    # peaks, cluster rules and threshold); None uses the stored clustering's.
    projection: Optional[ProjectionSortSettings] = None


class AnalysisFilterRequest(BaseModel):
    dataset_ids: List[str] = []
    metric: Literal["count", "occupancy", "rate", "accessibility"] = "count"
    operator: Literal["gt", "gte", "lt", "lte", "eq"] = "gte"
    threshold: float = 1
    rule: Optional[dict] = None
    peak_regions: Optional[List[List[int]]] = None
    scope_windows: Optional[List[List[int]]] = None
    layer: Optional[str] = None
    transcription_state: Optional[TranscriptionStateKind] = None
    gene_ids: List[str] = []
    sample_seed: Optional[str] = None

class TranscriptionStateFilterRequest(BaseModel):
    """Filter reads by transcription state criteria."""
    dataset_ids: List[str] = []
    gene_ids: List[str]
    filters: dict
    sample_seed: Optional[str] = None

class Pol2COMRequest(BaseModel):
    dataset_ids: List[str] = []
    gene_ids: List[str] = []
    fp_size_min: int = 35
    fp_size_max: int = 65
    n_bins: int = 100
    smoothing_sigma: float = 2.0
    sample_seed: Optional[str] = None

class AutozoomRequest(BaseModel):
    distance: int = 1000
    dataset_ids: List[str] = []
    min_reads: int = 5
    primer_clip: int = 50
    cluster_window: int = Field(100, gt=0)  # bin width in bp; 0 would divide by zero

class ReadStatsRegion(BaseModel):
    """Reads selected in a panel at another locus, looked up there."""
    chrom: str
    start: int
    end: int
    read_ids_by_dataset: Dict[str, List[str]]


class ReadStatsRequest(BaseModel):
    read_ids_by_dataset: Dict[str, List[str]]
    sample_seed: Optional[str] = None
    extra_regions: List[ReadStatsRegion] = []

class LiveFigureState(BaseModel):
    """What an open browser tab currently shows (pushed by the frontend)."""
    viewport: Dict[str, Any]
    frontend_state: Dict[str, Any]
    layout: Optional[Dict[str, int]] = None


class FigureRequest(BaseModel):
    """Render a figure exactly as the browser's Export button would.

    ``source="current"`` uses the view last shown in the open browser tab;
    ``session``/``session_path`` use a saved session instead. Region fields
    override the source's viewport.
    """
    source: Literal["current", "session"] = "current"
    session: Optional[Dict[str, Any]] = None
    session_path: Optional[str] = None
    # Load the session's datasets into this server first when some are not
    # loaded. This replaces what the open browser tab shows.
    load_session: bool = False
    region: Optional[str] = None
    chrom: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None
    format: Literal["png", "svg", "pdf"] = "png"
    # Output pixels per CSS pixel for PNG (like the Export panel's 1x-4x).
    scale: float = 2.0
    # Track-area size in CSS pixels; defaults to the browser tab's size.
    width: Optional[int] = None
    height: Optional[int] = None
    include_title: bool = False
    title: Optional[str] = None
    include_coords: bool = False
    expand_read_tracks: bool = True
    match_read_counts: bool = False
    # Text, labels, row heights and strokes at the session's UI size (False: 100%).
    match_ui_size: bool = True
    show_nudges: bool = False
    timeout_ms: Optional[int] = None


class RenderRequest(BaseModel):
    # Optional for the headless engine with a session or the open tab.
    chrom: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None
    dataset_id: Optional[str] = None
    tracks: List[str] = ["axis", "meta", "peaks", "reads", "genes"]
    width: int = 2000
    row_height: int = 3
    max_reads: int = 500
    title: Optional[str] = None
    use_clusters: bool = False
    # Kept True for existing scripts; the browser (and /api/render/figure)
    # defaults to all overlapping reads.
    spanning_only: bool = True
    read_ids: Optional[List[str]] = None
    sort_by: Optional[str] = None
    n_clusters: int = 3
    cluster_order: Optional[Dict[str, List[int]]] = None
    read_sort_order: Optional[Dict[str, List[str]]] = None
    show_mods: bool = False
    show_deam_opportunities: bool = False
    show_fire: bool = False
    show_cigar: bool = False
    show_layers: bool = False
    tf_overlay: Optional[Dict[str, Any]] = None
    show_labels: bool = True
    colors: Optional[Dict[str, str]] = None
    quality_shading: bool = False
    format: str = "png"
    dpi: int = 150
    subnuc_threshold: int = 90
    dataset_ids: Optional[List[str]] = None
    sample_seed: Optional[str] = None
    # "numpy" = original PIL/numpy compositor with hard-coded 3-bin palette.
    # "playwright" = drive the live React app via headless Chromium so colors,
    # rules, layers, and cluster state match the on-screen browser exactly.
    # "headless" (default) = the browser's view drawn in Python (services/figure):
    #   same panels, tracks, labeling, clusters; no browser needed.
    # "numpy" = the original PIL compositor (legacy).
    # "playwright" = drive the live React app via headless Chromium.
    engine: Literal["headless", "numpy", "playwright"] = "headless"
    # Headless engine: where the view comes from. "auto" = session if given,
    # else the open browser tab if any, else the browser's defaults.
    source: Literal["auto", "session", "current", "defaults"] = "auto"
    session: Optional[Dict[str, Any]] = None
    session_path: Optional[str] = None
    load_session: bool = False  # headless: load the session's datasets when missing here
    region: Optional[str] = None  # headless: "chr1:1,000-2,000" instead of chrom/start/end
    scale: float = 2.0  # PNG output pixels per page pixel
    include_coords: bool = False  # headless: region coordinates under the figure
    # When True, render-mode CSS leaves the in-track overlay nudges visible
    # (read-filter-empty / span-empty / hints / aggressive-filter banner).
    # Default False keeps figure renders clean. Only meaningful when
    # engine="playwright".
    show_nudges: bool = False
    # Per-request Playwright render timeout in ms. Accept the frontend/JS-style
    # key used by the headless worker contract.
    timeout_ms: Optional[int] = Field(default=None, alias="timeoutMs")

class CompileRegion(BaseModel):
    chrom: str
    start: int
    end: int
    label: Optional[str] = None

class CompileRequest(BaseModel):
    regions: List[CompileRegion]
    dataset_ids: Optional[List[str]] = None
    spanning: bool = True
    max_reads_per_region: int = 200
    anchor: str = 'center'
    target_width: Optional[int] = None
    sample_seed: Optional[str] = None
    include_deam_opportunities: bool = False


# ── Session Management ──────────────────────────────────────────────────────

class SessionExportRequest(BaseModel):
    """Frontend sends viewport and UI state for session export."""
    chrom: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None
    frontend_state: Optional[dict] = None

class SessionImportRequest(BaseModel):
    """Import a session from JSON."""
    session: dict
    # Relinked file locations (saved path -> path on this computer).
    path_mapping: Optional[dict] = None


class SessionFileCheckRequest(BaseModel):
    """Check a session's input files, optionally relinking missing ones."""
    session: dict
    # Optional: the frontend sends explicit nulls.
    mapping: Optional[dict] = None
    anchor: Optional[dict] = None       # {"old": saved path, "new": located path}
    search_root: Optional[str] = None   # folder to search for the remaining files


# ── Primer Design ───────────────────────────────────────────────────────────

class PrimerDesignRequest(BaseModel):
    chrom: str
    start: int
    end: int
    min_product: int = 5000
    max_product: int = 50000
    min_tm: float = 55
    max_tm: float = 65
    max_tm_diff: float = 2.0
    min_len: int = 18
    max_len: int = 25
    max_g_count: int = 2
    max_run_length: int = 4
    max_gc_pct: float = 70.0
    tm_method: str = "primer3"
    check_tandem_repeats: bool = True
    check_three_prime_specificity: bool = True
    optimize_for: str = "closest"
    max_results: int = 5
    min_spacing: int = 50
    exclude_regions: Optional[List[List[int]]] = None

class DafcPrimerDesignRequest(BaseModel):
    chrom: str
    x_start: int
    x_end: int
    y_start: int
    y_end: int
    y_chrom: Optional[str] = None
    min_product: int = 5000
    max_product: int = 50000
    min_tm: float = 55
    max_tm: float = 65
    max_tm_diff: float = 2.0
    min_len: int = 18
    max_len: int = 25
    max_g_count: int = 2
    max_run_length: int = 4
    max_gc_pct: float = 70.0
    tm_method: str = "primer3"
    check_tandem_repeats: bool = True
    check_three_prime_specificity: bool = True
    optimize_for: str = "closest"
    max_results: int = 5
    min_spacing: int = 50
    exclude_regions: Optional[Dict[str, List[List[int]]]] = None
    sample_seed: Optional[str] = None

class FourCPrimerDesignRequest(BaseModel):
    chrom: str
    start: int
    end: int
    min_spacing: int = 50
    max_spacing: int = 500
    min_tm: float = 55
    max_tm: float = 65
    max_tm_diff: float = 2.0
    min_len: int = 18
    max_len: int = 25
    max_g_count: int = 2
    max_run_length: int = 4
    max_gc_pct: float = 70.0
    tm_method: str = "primer3"
    check_tandem_repeats: bool = True
    check_three_prime_specificity: bool = True
    max_results: int = 5
    exclude_regions: Optional[List[List[int]]] = None


# ── Jupyter Integration ─────────────────────────────────────────────────────

class GotoRequest(BaseModel):
    chrom: str
    start: int
    end: int

class BrowserActionsRequest(BaseModel):
    """Queue UI-equivalent browser actions for the active frontend to execute."""
    actions: List[Dict[str, Any]]
    label: str = "Jupyter"

class ReadOrderRequest(BaseModel):
    read_ids: List[str]
    dataset_id: Optional[str] = None

class HighlightRequest(BaseModel):
    type: str = "read"
    read_ids: Optional[List[str]] = None
    footprints: Optional[List[dict]] = None
    color: str = "#ff0000"
    label: Optional[str] = None
    dataset_id: Optional[str] = None

class PushReadsRequest(BaseModel):
    reads: List[dict]
    label: str = "Jupyter"

class GotoGeneRequest(BaseModel):
    gene: str
    padding: int = 2000

class PushReadsReplaceRequest(BaseModel):
    reads: List[dict]
    label: str = "Jupyter"

class JupyterFilterRequest(BaseModel):
    """Filter by read IDs (Jupyter). Renamed from duplicate FilterRequest."""
    read_ids: List[str]
    dataset_id: Optional[str] = None

class MarkerRequest(BaseModel):
    markers: List[dict]
    group: str = "default"

class FootprintColorRequest(BaseModel):
    footprint_colors: Dict[str, List[dict]]
    group: str = "default"


# ── Footprint Analysis ──────────────────────────────────────────────────────

class FootprintAnalysisRequest(BaseModel):
    footprints: List[Dict]
    dataset_ids: List[str]
    # DAF-seq panels showing one strand: dataset id -> 'CT' / 'GA'.
    strand_by_dataset: Optional[Dict[str, Literal["CT", "GA"]]] = None
    auto_motifs: bool = True
    custom_motif_names: Optional[List[str]] = None
    motif_track_indices: Optional[List[int]] = None
    custom_pwms: Optional[List[Dict[str, Any]]] = None
    motif_threshold: float = 0.8
    # Motif scoring (services/motif_scoring.py): 'p' (default; per-matrix p-value) or 'relative' (motif_threshold, the
    # older share of each matrix's score range). Omitted with motif_threshold set: relative (older clients).
    motif_mode: Optional[Literal["p", "relative"]] = None
    motif_p: float = 1e-4
    motif_background: Literal["genome", "uniform"] = "genome"
    # Report the species' default key factors (motif_scoring.PINNED_DEFAULTS) when custom_motif_names is not given.
    pinned_defaults: bool = False
    flank_bp: int = 20
    profile_window: int = 500
    groups: Optional[List[Dict]] = None
    read_ids_by_dataset: Optional[Dict[str, List[str]]] = None
    max_reads: Optional[int] = None
    sample_seed: Optional[str] = None
    include_read_analysis: bool = True
    include_sequences: bool = True
    include_motifs: bool = True
    include_overlap: bool = True
    include_overlap_sizes: bool = True
    include_profiles: bool = True
    include_vplot: bool = True
    include_coocc: bool = True
    vplot_size_bin: int = 10
    vplot_pos_bin: int = 10
    vplot_size_min: int = 10
    vplot_size_max: int = 300
    vplot_log: bool = True
    vplot_smooth: float = 1.0
    layer: Optional[str] = None
    layers: Optional[List[str]] = None


class DerivedLayerExportRequest(BaseModel):
    """Materialize Footprint Analysis cart entries as reusable layer sidecars."""
    dataset_ids: List[str]
    groups: List[Dict]
    output_dir: str
    bundle_name: Optional[str] = None
    include_disabled: bool = False
    read_ids_by_dataset: Optional[Dict[str, List[str]]] = None
    max_reads: Optional[int] = None
    sample_seed: Optional[str] = None


class DerivedLayerLoadRequest(BaseModel):
    """Attach an existing `.fiberlayers` bundle to loaded datasets."""
    path: str
    dataset_ids: Optional[List[str]] = None


class FootprintRuleSaveRequest(BaseModel):
    """Save portable Footprint Analysis cart rules."""
    groups: List[Dict]
    output_dir: str
    bundle_name: Optional[str] = None
    chrom: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None
    spanning: Optional[bool] = None
    dataset_ids: Optional[List[str]] = None
    sample_seed: Optional[str] = None


class FootprintRuleLoadRequest(BaseModel):
    """Load portable Footprint Analysis cart rules."""
    path: str


class SyncPeaksRequest(BaseModel):
    """Sync peaks from frontend."""
    chrom: str
    peaks: List[dict]


class ImportPeaksRequest(BaseModel):
    """Push a peak set from Python/Jupyter into the live browser."""
    peaks: List[dict]
    chrom: Optional[str] = None
    label: Optional[str] = None
    lock: bool = True
    select: bool = True
    replace_existing: bool = True


class JupyterPeakRulesRequest(BaseModel):
    """Push peak-rule settings from Python/Jupyter into the live browser."""
    rules: List[dict]
    lock: Optional[bool] = None
    clear_peaks: bool = True
    rescan: bool = False


class JupyterBrowserSettingsRequest(BaseModel):
    """Push reproducibility/display settings from Python/Jupyter."""
    analysis_sample_seed: Optional[str] = None
    analysis_sample_count: Optional[int] = None
    display_sample_count: Optional[int] = None
    read_display_mode: Optional[str] = None
    all_reads_display_cap: Optional[int] = None
    background_read_cap: Optional[int] = None
    profile_read_cap: Optional[int] = None
    spanning_only: Optional[bool] = None
    peaks_locked: Optional[bool] = None
    peak_rules: Optional[List[dict]] = None
    selected_peaks: Optional[List[int]] = None
    peak_modes: Optional[dict] = None
    peaks_by_rule: Optional[dict] = None
    cluster_feature_rules: Optional[List[dict]] = None
    analysis_sort_rules: Optional[List[dict]] = None
    analysis_filter_rules: Optional[List[dict]] = None
    active_colormap: Optional[dict] = None
    cluster_method: Optional[str] = None
    cluster_k: Optional[int] = None
    small_footprint_threshold_bp: Optional[int] = None
    accessibility_threshold: Optional[float] = None
    capture_regions: Optional[List[dict]] = None
    capture_padding: Optional[int] = None
    catalog: Optional[List[dict]] = None
    composite_tracks: Optional[List[dict]] = None
    saved_tracks: Optional[List[dict]] = None
    footprint_groups: Optional[List[dict]] = None
    selected_genes: Optional[List[dict]] = None
    transcription_state_filters: Optional[dict] = None
    primer_saved_primers: Optional[List[dict]] = None
    primer_mode: Optional[str] = None
    primer_cart_track_display: Optional[str] = None
    enabled_mod_types: Optional[dict] = None
    enabled_meta_profiles: Optional[dict] = None
    cached_layer_types: Optional[dict] = None
    legacy_layer_inference: Optional[bool] = None
    legacy_nuc_min_size: Optional[int] = None
    click_target_layer: Optional[str] = None
    footprint_analysis_layer: Optional[str] = None
    coacc_settings: Optional[dict] = None
    fill_read_height: Optional[bool] = None
    read_row_height: Optional[Any] = None
    show_coverage_histogram: Optional[bool] = None
    max_region_for_reads: Optional[int] = None
    show_genome_overview: Optional[bool] = None
    open_panel: Optional[str] = None
    close_panel: Optional[str] = None
    hidden_strip_panels: Optional[List[str]] = None


class JupyterBrowserSettingsSnapshotRequest(JupyterBrowserSettingsRequest):
    """Current browser-side settings mirrored back for notebooks."""
    selected_peak_count: Optional[int] = None
    selected_read_ids: Optional[dict] = None
    active_quality_filters: Optional[List[dict]] = None
    session_manifest: Optional[dict] = None
    active_panels: Optional[List[dict]] = None
    cluster_assignments: Optional[dict] = None
    cluster_order: Optional[dict] = None
    read_sort_order: Optional[dict] = None


# ── Motif Search ────────────────────────────────────────────────────────────

class SequenceRegion(BaseModel):
    """A genomic region for sequence extraction."""
    chrom: str
    start: int
    end: int
    name: Optional[str] = None

class SequenceRequest(BaseModel):
    """Extract sequences for regions."""
    regions: List[SequenceRegion]
    strand: str = "+"
    extend: int = 0

class MotifSearchRequest(BaseModel):
    """Search for TF motifs in sequences."""
    regions: Optional[List[SequenceRegion]] = None
    motifs: Optional[List[str]] = None
    motif_ids: Optional[List[str]] = None
    custom_motifs: Optional[List[str]] = None
    threshold: float = 0.8
    extend: int = 0
    both_strands: bool = True

class CustomMotifRequest(BaseModel):
    """Register a custom PWM."""
    name: str
    counts: Dict[str, List[float]]

class CustomMotifFileRequest(BaseModel):
    """Load motifs from a file."""
    file_path: str
    format: str = "auto"


# ── Generic Signal Peak Detection ──────────────────────────────────────────

class DetectPeaksRequest(BaseModel):
    """Detect peaks from an arbitrary signal array."""
    signal: List[float]
    chrom: str
    start: int
    end: int
    label: str = ""
    min_distance_bp: int = 100
    min_width_bp: int = 80
    threshold_percentile: int = 30
    threshold_value: Optional[float] = None


# ── Annotation Overlays ─────────────────────────────────────────────────────

class ActivateAnnotationRequest(BaseModel):
    file_id: str

class AddAnnotationRequest(BaseModel):
    path: str
    label: Optional[str] = None
    dataset_ids: List[str] = []

class AnnotationFilterRequest(BaseModel):
    annotation_types: List[str]
    filter_mode: str = "has_any"
    chrom: str
    start: int
    end: int
    dataset_ids: List[str] = []
    sample_seed: Optional[str] = None

class AnnotationClusterRequest(BaseModel):
    peak_regions: List[Dict] = []
    annotation_types: List[str] = []
    method: str = "combinatorial"
    k: int = 5
    dataset_ids: List[str] = []
    chrom: str = ""
    start: int = 0
    end: int = 0
    sample_seed: Optional[str] = None

class AnnotationThresholdRequest(BaseModel):
    type_name: str
    threshold: float


# ── Orthogonal Tracks ───────────────────────────────────────────────────────

class TracksExportBody(BaseModel):
    track_indices: List[int]
    labels: Optional[List[str]] = None
    chrom: str
    start: int
    end: int
    bins: int = 2000

class TracksBatchBody(BaseModel):
    track_indices: List[int]
    chrom: str
    start: int
    end: int
    bins: int = 500
    annotation_filters: Optional[Dict[int, List[str]]] = None

class MotifSequenceRequest(BaseModel):
    sequence: str
    label: Optional[str] = None
    threshold: float = 0.85

class MotifFileRequest(BaseModel):
    file_path: str
    format: Optional[str] = None
    threshold: float = 0.8

class MotifPwmTrackRequest(BaseModel):
    name: str
    counts: Dict[str, List[float]]
    label: Optional[str] = None
    threshold: float = 0.85


class MotifJasparTrackRequest(BaseModel):
    matrix_ids: List[str]
    threshold: float = 0.85


# ── Contact Matrix / DAF-C ──────────────────────────────────────────────────

class APAPeaks(BaseModel):
    """Peak coordinates for APA analysis."""
    peaks: List[dict]


class FrameBlock(BaseModel):
    feature: int = Field(0, ge=0)
    frame: tuple[int, int]
    genomic: tuple[int, int]
    reverse: Optional[bool] = None


class RegionViewport(ClusterViewport):
    genome: Optional[str] = None
    reverse: bool = False
    blocks: list[FrameBlock]
    region_label: Optional[str] = None


class RegionClusterRequest(ClusterAllRequest):
    viewports: list[RegionViewport]
    frame_id: Optional[str] = None
    digest: Optional[str] = None
    feature_geometry: Literal['crop'] = 'crop'
    balance_windows: bool = True
    member_specific_features: list[int] = Field(default_factory=list)


class CorrespondenceScanRequest(ScanPeaksRequest):
    viewports: list[RegionViewport]
    length: int = Field(gt=0, le=10_000_000)
