"""Domain classes extracted from server.py.

Core data structures: ChromInfo, CigarCoordMapper, Dataset, WorkingSet,
JupyterState, DAFCState, and DAF-C models.
"""

import os
import bisect
import urllib.parse
from typing import Optional, List, Dict, Any
from enum import Enum
from pydantic import BaseModel
from dataclasses import dataclass, field as dataclass_field

import numpy as np
from services.byte_cache import shared_cache


# ── Chromosome Info ─────────────────────────────────────────────────────────

class ChromInfo(BaseModel):
    name: str
    size: int
    circular: bool = False
    circular_source: Optional[str] = None


# ── DAF-C Models ────────────────────────────────────────────────────────────

class LinkedRegion(BaseModel):
    """A pair of genomic regions from a contact."""
    chrom: str
    x_start: int
    x_end: int
    y_start: int
    y_end: int
    x_chrom: Optional[str] = None
    y_chrom: Optional[str] = None


class ContactMode(str, Enum):
    """Contact data type - determines split view behavior."""
    DAFC = "dafc"
    MICROC = "microc"


class ContactSelection(BaseModel):
    """Result of selecting a region on the contact matrix."""
    chrom: str
    x_start: int
    x_end: int
    y_start: int
    y_end: int
    contacts: int
    n_ligated_reads: int
    read_ids: List[str]
    contact_mode: str = "dafc"


class SendToLinkedRequest(BaseModel):
    """Request to send linked reads to a session."""
    regions: LinkedRegion
    read_ids: List[str] = []
    contact_mode: Optional[str] = "dafc"
    split_view_mode: Optional[str] = None


# ── CIGAR Coordinate Mapper ─────────────────────────────────────────────────

class CigarCoordMapper:
    """Efficient query-to-reference coordinate mapping using CIGAR ranges."""

    __slots__ = (
        '_query_starts',
        '_query_ends',
        '_ref_starts',
        '_ref_offsets',
        '_insertions',
        '_simple_offset',
        '_simple_query_start',
        '_simple_query_end',
        '_aligned_starts',
        '_aligned_ends',
        '_aligned_offsets',
        'large_indels',
    )

    def __init__(self, cigartuples, ref_start):
        query_ends = []
        query_starts = []
        ref_starts = []
        ref_offsets = []
        insertions = []
        # Indel ops of >= 10 bp (and N skips), (op, ref_pos, length, query_pos):
        # what services/sv_events.py needs for SV events, gathered on this walk
        # instead of a second one (D/I ops that long are rare).
        large = []

        ref_pos = ref_start
        query_pos = 0
        mapped_range_count = 0
        mapped_range_idx = -1

        for op, length in cigartuples or []:
            if op in (0, 7, 8):  # M, =, X
                offset = ref_pos - query_pos
                query_starts.append(query_pos)
                query_ends.append(query_pos + length)
                ref_starts.append(ref_pos)
                ref_offsets.append(offset)
                mapped_range_count += 1
                mapped_range_idx = len(query_ends) - 1
                ref_pos += length
                query_pos += length
            elif op == 1:  # I - insertion
                if length >= 10:
                    large.append((1, ref_pos, length, query_pos))
                query_starts.append(query_pos)
                query_ends.append(query_pos + length)
                ref_starts.append(ref_pos)
                ref_offsets.append(0)
                insertions.append(len(query_ends) - 1)
                query_pos += length
            elif op == 2:  # D - deletion
                if length >= 10:
                    large.append((2, ref_pos, length, query_pos))
                ref_pos += length
            elif op == 3:  # N - skipped region
                large.append((3, ref_pos, length, query_pos))
                ref_pos += length
            elif op == 4:  # S - soft clip
                query_starts.append(query_pos)
                query_ends.append(query_pos + length)
                ref_starts.append(-1)
                ref_offsets.append(0)
                query_pos += length
            elif op == 5:  # H - hard clip
                pass

        if mapped_range_count == 1:
            mapped_idx = mapped_range_idx
            self._simple_offset = ref_offsets[mapped_idx]
            self._simple_query_start = query_starts[mapped_idx]
            self._simple_query_end = query_ends[mapped_idx]
        else:
            self._simple_offset = None
            self._simple_query_start = 0
            self._simple_query_end = 0

        self._query_starts = query_starts
        self._query_ends = query_ends
        self._ref_starts = ref_starts
        self._ref_offsets = ref_offsets
        self._insertions = set(insertions)
        aligned = [i for i, start in enumerate(ref_starts)
                   if start >= 0 and i not in self._insertions and query_starts[i] < query_ends[i]]
        self._aligned_starts = [query_starts[i] for i in aligned]
        self._aligned_ends = [query_ends[i] for i in aligned]
        self._aligned_offsets = [ref_offsets[i] for i in aligned]
        self.large_indels = large

    def query_to_ref(self, query_pos):
        """Map query position to reference position. Returns None if unmapped."""
        if not self._query_ends:
            return None

        simple_offset = self._simple_offset
        if simple_offset is not None:
            if self._simple_query_start <= query_pos < self._simple_query_end:
                return query_pos + simple_offset
            return None

        idx = bisect.bisect_right(self._query_ends, query_pos)

        if idx >= len(self._query_ends):
            return None

        ref_start = self._ref_starts[idx]
        if ref_start == -1:
            return None

        if idx in self._insertions:
            return ref_start

        return query_pos + self._ref_offsets[idx]

    def aligned_query_interval_to_ref(self, query_start, query_end):
        """Inclusive query span projected through aligned bases only.

        Match inference's min/max mapped-base rule: inserted and soft-clipped
        endpoints cannot contribute an extra reference base to a footprint.
        """
        if query_end < query_start:
            return None, None
        first = bisect.bisect_right(self._aligned_ends, query_start)
        last = bisect.bisect_right(self._aligned_starts, query_end) - 1
        if first > last:
            return None, None
        # CIGAR reference positions are monotonic. Only the first and last
        # aligned pieces determine the span; internal gaps need no scan.
        left = max(query_start, self._aligned_starts[first]) + self._aligned_offsets[first]
        right = min(query_end + 1, self._aligned_ends[last]) + self._aligned_offsets[last]
        return left, right

    def footprint_to_ref(self, query_start, query_end):
        """A footprint's inclusive query span in half-open reference coordinates.

        As query_interval_to_ref; a footprint starting in a soft clip or an
        insertion keeps its aligned part (instead of being dropped, which would
        read as an accessible gap).
        """
        ref_start, ref_end = self.query_interval_to_ref(query_start, query_end)
        if ref_start is None or ref_end is None:
            ref_start, ref_end = self.aligned_query_interval_to_ref(query_start, query_end)
        return ref_start, ref_end

    def query_interval_to_ref(self, query_start, query_end):
        """Map an inclusive query interval to half-open reference coordinates."""
        if not self._query_ends:
            return None, None

        simple_offset = self._simple_offset
        if simple_offset is not None:
            simple_start = self._simple_query_start
            simple_end = self._simple_query_end
            if not (simple_start <= query_start < simple_end):
                return None, None
            mapped_end_query = min(query_end, simple_end - 1)
            return query_start + simple_offset, mapped_end_query + simple_offset + 1

        query_ends = self._query_ends
        ref_starts = self._ref_starts
        ref_offsets = self._ref_offsets
        insertions = self._insertions

        start_idx = bisect.bisect_right(query_ends, query_start)
        if start_idx >= len(query_ends):
            return None, None

        ref_start = ref_starts[start_idx]
        if ref_start == -1:
            return None, None
        if start_idx not in insertions:
            ref_start = query_start + ref_offsets[start_idx]

        end_ref = None
        end_idx = bisect.bisect_right(query_ends, query_end)
        if end_idx < len(query_ends):
            end_ref_start = ref_starts[end_idx]
            if end_ref_start != -1:
                if end_idx in insertions:
                    end_ref = end_ref_start + 1
                else:
                    end_ref = query_end + ref_offsets[end_idx] + 1

        if end_ref is None:
            search_idx = min(end_idx, len(query_ends) - 1)
            query_starts = self._query_starts
            while search_idx >= start_idx:
                candidate_ref_start = ref_starts[search_idx]
                candidate_query_pos = min(query_end, query_ends[search_idx] - 1)
                if (
                    candidate_ref_start != -1
                    and candidate_query_pos > query_start
                    and candidate_query_pos >= query_starts[search_idx]
                ):
                    if search_idx in insertions:
                        end_ref = candidate_ref_start + 1
                    else:
                        end_ref = candidate_query_pos + ref_offsets[search_idx] + 1
                    break
                search_idx -= 1

        if end_ref is None:
            end_ref = ref_start + 1
        if end_ref <= ref_start:
            end_ref = ref_start + 1
        return ref_start, end_ref

    def query_to_ref_many(self, query_positions):
        """Map many query positions by scanning CIGAR ranges once."""
        if not self._query_ends:
            return [None for _ in query_positions]

        simple_offset = self._simple_offset
        if simple_offset is not None:
            simple_start = self._simple_query_start
            simple_end = self._simple_query_end
            return [
                query_pos + simple_offset
                if simple_start <= query_pos < simple_end
                else None
                for query_pos in query_positions
            ]

        results = [None] * len(query_positions)
        ordered = sorted(enumerate(query_positions), key=lambda item: item[1])
        idx = 0
        query_ends = self._query_ends
        ref_starts = self._ref_starts
        ref_offsets = self._ref_offsets
        insertions = self._insertions

        for original_idx, query_pos in ordered:
            while idx < len(query_ends) and query_ends[idx] <= query_pos:
                idx += 1
            if idx >= len(query_ends):
                continue

            ref_start = ref_starts[idx]
            if ref_start == -1:
                continue
            if idx in insertions:
                results[original_idx] = ref_start
            else:
                results[original_idx] = query_pos + ref_offsets[idx]

        return results


# ── Dataset ─────────────────────────────────────────────────────────────────

class Dataset:
    """Represents a single Fiber-seq/DAF-seq dataset.

    Can be backed by BAM, BigBed, or directory of BigBed files.
    Remote URLs (HTTP/HTTPS/S3) are supported.
    """
    def __init__(self, dataset_id: str, path, label: str = None, data_type: str = None):
        from utils.validation import is_url, detect_data_format

        self.id = dataset_id
        self.molecule_groups = []
        self.joint_dedup = "off"
        self.cluster_assignments = {}
        self.cluster_element_info = None
        self.cluster_peak_regions = None
        # How the stored clustering's features were built (feature rules,
        # subnucleosomal threshold), so later passes can rebuild them the same way.
        self.cluster_feature_settings = None
        self.cluster_preparation_sampling = None
        self.sorted_indices = None
        self.color = None
        self.is_remote = False
        self.layer_type = None
        self.available_layers = {}
        self.companion_layers = {}
        self.derived_layers = {}
        self.has_circular_annotations = False
        self.consensus_chemistry = None
        self.chemistry_metadata = {
            "chemistry": None,
            "source": "none",
            "status": "unknown",
            "message": "chemistry has not been inspected",
            "files": [],
        }

        if isinstance(path, list):
            self.paths = path
            self.path = path[0] if path else ''
            self.label = label or f"{len(path)} files"
        else:
            self.paths = [path]
            self.path = path
            if is_url(path):
                self.is_remote = True
                parsed = urllib.parse.urlparse(path)
                filename = os.path.basename(parsed.path)
                self.label = label or filename or 'Remote file'
            else:
                self.label = label or os.path.basename(path.rstrip('/'))

        if any(is_url(p) for p in self.paths):
            self.is_remote = True

        if data_type:
            self.data_type = data_type
        elif len(self.paths) == 1:
            p = self.paths[0]
            data_format = detect_data_format(p)
            if data_format == 'bam':
                self.data_type = 'bam'
            elif data_format == 'bigbed':
                self.data_type = 'bigbed'
            elif not is_url(p) and os.path.isdir(p):
                self.data_type = 'bigbed'
            else:
                self.data_type = 'unknown'
        else:
            if all(detect_data_format(p) == 'bam' for p in self.paths):
                self.data_type = 'bam'
            else:
                self.data_type = 'bigbed'

    def get_reads(self, chrom, start, end, spanning=True, chrom_map=None, contig_links=None):
        """Load reads from BAM/BigBed files. Returns DataFrame.

        ``contig_links``: this dataset's plasmid links in its workspace
        (``services.plasmid_reconcile.contig_links``)."""
        import pandas as pd
        from services.bigbed_read_loader import load_reads_from_bigbed
        from services.dense_bam_loader import load_reads_from_bam

        if self.data_type == 'bam_livelift':
            # Dense read tables read the source BAM with target coordinates: refused (services/lift/capability).
            from services.lift.capability import LiveLiftUnsupported
            raise LiveLiftUnsupported("dense_reads", self.label)
        if self.data_type == 'bam':
            all_reads = []
            for bam_path in self.paths:
                reads = load_reads_from_bam(
                    bam_path,
                    chrom,
                    start,
                    end,
                    spanning_only=spanning,
                    chrom_map=chrom_map,
                    contig_links=contig_links,
                )
                if isinstance(reads, pd.DataFrame) and not reads.empty:
                    all_reads.append(reads)
            return pd.concat(all_reads, ignore_index=True) if all_reads else pd.DataFrame()
        else:
            # Companion layer files (TF, MSP, m6A, …) describe the same molecules
            # as the primary files: rows from them are not extra reads.
            companions = {
                str(p) for paths in (self.companion_layers or {}).values()
                for p in (paths if isinstance(paths, (list, tuple)) else [paths])
            }
            sources = [p for p in self.paths if str(p) not in companions] or list(self.paths[:1])
            return load_reads_from_bigbed(sources, chrom, start, end, spanning_only=spanning)


    @property
    def family_scan_chemistry(self):
        """Legacy name of ``consensus_chemistry`` (the datatype footprint-class runs use)."""
        return self.consensus_chemistry

    @family_scan_chemistry.setter
    def family_scan_chemistry(self, value):
        self.consensus_chemistry = value

    def to_dict(self):
        from services.background_work import file_identity
        from services.lift.reads import lift_identity
        from services.read_group_samples import sample_keys
        import hashlib
        return {
            # A live-lift dataset's settings are part of what its reads are (lift_key): client caches follow them.
            "source_identity": hashlib.sha256(repr((file_identity(self.paths),
                                                    tuple(tuple(p) for p in getattr(self, "molecule_groups", [])),
                                getattr(self, "joint_dedup", "off"), *(lift_identity(self)))).encode()).hexdigest(),
            "id": self.id,
            "label": self.label,
            "path": self.path,
            "paths": self.paths,
            "color": self.color,
            "data_type": self.data_type,
            "molecule_groups": getattr(self, "molecule_groups", []),
            "joint_dedup": getattr(self, "joint_dedup", "off"),
            "is_remote": self.is_remote,
            "layer_type": self.layer_type,
            "available_layers": self.available_layers,
            "companion_layers": self.companion_layers,
            "derived_layers": self.derived_layers,
            "has_circular_annotations": self.has_circular_annotations,
            "consensus_chemistry": self.consensus_chemistry,
            # Legacy name of consensus_chemistry (older frontends and sessions).
            "family_scan_chemistry": self.consensus_chemistry,
            "chemistry_metadata": self.chemistry_metadata,
            # Its BAM read groups' samples as opaque keys: a native dataset is matched with the lifted dataset of its
            # sample (the names stay on the server).
            "sample_keys": sample_keys(self),
            # Plasmid maps linked to this BAM's contigs (and what did not match).
            **({"plasmid": self.plasmid_report} if getattr(self, "plasmid_report", None) else {}),
            # A live-lift dataset's map, haplotypes and settings (services/lift/dataset.py).
            **({"live_lift": self.live_lift.to_dict()} if getattr(self, "live_lift", None) is not None else {}),
            # Fields a plugin pack attaches to a dataset of its own (plugins/packs.py): name -> value.
            **{k: v for k, v in (getattr(self, "pack_fields", None) or {}).items() if v},
        }


# ── WorkingSet ──────────────────────────────────────────────────────────────

class WorkingSet:
    """Reads for a viewport region — computed on-demand from broad cache.

    Transient object, not independently cached.
    """
    def __init__(self, reads: list, total_overlapping: int, total_spanning: int,
                 chrom: str, start: int, end: int, profile_metaprofile=None,
                 profile_read_count: int = 0):
        self.reads = reads
        self.total_overlapping = total_overlapping
        self.total_spanning = total_spanning
        self.chrom = chrom
        self.start = start
        self.end = end
        self.region_width = end - start
        self.profile_metaprofile = profile_metaprofile
        self.profile_read_count = int(profile_read_count or 0)
        # A sampled display load (services/read_sampling.py): kept and total counts.
        self.sampling = None
        self._read_by_id = None
        from services.byte_cache import shared_cache
        self._interval_table_cache = shared_cache()

    @property
    def read_by_id(self):
        if self._read_by_id is None:
            self._read_by_id = {r['id']: r for r in self.reads}
        return self._read_by_id

    def get_read_ids(self) -> list:
        return [r['id'] for r in self.reads]

    def sample_for_display(self, max_display: int, cluster_assignments: dict = None,
                           cluster_focus: set = None) -> list:
        from services.read_metrics import sample_by_coverage

        reads_to_sample = self.reads
        if cluster_focus and cluster_assignments:
            reads_to_sample = [r for r in self.reads
                              if cluster_assignments.get(r['id']) in cluster_focus]
        if len(reads_to_sample) <= max_display:
            return reads_to_sample
        return sample_by_coverage(reads_to_sample, max_display, 0, self.region_width)

    def sample_from_clusters(self, cluster_ids: set, cluster_assignments: dict,
                             max_per_cluster: int = None) -> list:
        from services.read_metrics import sample_by_coverage

        if not cluster_assignments:
            return []
        result = []
        for cluster_id in cluster_ids:
            cluster_reads = [r for r in self.reads
                           if cluster_assignments.get(r['id']) == cluster_id]
            if max_per_cluster and len(cluster_reads) > max_per_cluster:
                cluster_reads = sample_by_coverage(cluster_reads, max_per_cluster, 0, self.region_width)
            result.extend(cluster_reads)
        return result


# ── JupyterState ────────────────────────────────────────────────────────────

class JupyterState:
    """State managed by Jupyter client."""
    def __init__(self):
        self.custom_reads: Dict[str, List[dict]] = {}
        self.read_order: Dict[str, List[str]] = {}
        self.browser_read_order: Dict[str, List[str]] = {}
        self.read_filter: Dict[str, List[str]] = {}
        self.highlights: Dict[str, dict] = {}
        self.markers: Dict[str, dict] = {}
        self.footprint_colors: Dict[str, dict] = {}
        self.selected_reads: List[str] = []
        self.selected_read_ids_by_dataset: Dict[str, List[str]] = {}
        # The notebook's selection has reached the browser (a poll carried it);
        # from the browser's next sync its own selection is the current one.
        self.selection_delivered: bool = False
        self.target_region: Optional[dict] = None
        self.refresh_requested: bool = False
        self.version: int = 0
        self.peaks: List[dict] = []
        self.pending_peak_import: Optional[dict] = None
        self.pending_peak_rules_update: Optional[dict] = None
        self.pending_settings_update: Optional[dict] = None
        self.pending_browser_actions: List[dict] = []
        self.browser_settings: Dict[str, Any] = {}
        self.custom_motifs: Dict[str, dict] = {}

    def clear_all(self):
        self.custom_reads.clear()
        self.read_order.clear()
        self.browser_read_order.clear()
        self.read_filter.clear()
        self.highlights.clear()
        self.markers.clear()
        self.footprint_colors.clear()
        self.selected_reads.clear()
        self.selected_read_ids_by_dataset.clear()
        self.selection_delivered = False
        self.peaks.clear()
        self.pending_peak_import = None
        self.pending_peak_rules_update = None
        self.pending_settings_update = None
        self.pending_browser_actions.clear()
        self.browser_settings.clear()
        self.custom_motifs.clear()
        self.target_region = None
        self.refresh_requested = False
        self.version += 1


# ── DAFCState ───────────────────────────────────────────────────────────────

@dataclass
class DAFCState:
    """State for DAF-C contact matrix integration."""
    cool_file: Optional[str] = None
    bigbed_file: Optional[str] = None
    clr: Any = None
    resolutions: List[int] = dataclass_field(default_factory=list)
    current_resolution: int = 0
    chroms: List[ChromInfo] = dataclass_field(default_factory=list)
    bb: Any = None
    linked_sessions: Dict[str, Dict] = dataclass_field(default_factory=dict)
    chrom_expected_cache: Dict[tuple, np.ndarray] = dataclass_field(default_factory=lambda: shared_cache('profiles'))
    chrom_expected_computing: set = dataclass_field(default_factory=set)


# ── AnnotationState ────────────────────────────────────────────────────────

class DerivedLayerDefinition:
    """Metadata for one user-defined layer class loaded from a fiberlayers bundle."""
    def __init__(self, layer_id, label=None, source_layer='', kind='derived_layer',
                 color=None, rules=None, bundle_path=None, manifest_path=None,
                 source_dataset=None, provenance=None, version=None):
        self.id = layer_id
        self.label = label or layer_id
        self.source_layer = source_layer or ''
        self.kind = kind or 'derived_layer'
        self.color = color
        self.rules = rules or {}
        self.bundle_path = bundle_path
        self.manifest_path = manifest_path
        self.source_dataset = source_dataset or {}
        self.provenance = provenance or {}
        self.version = version

    def to_dict(self):
        return {
            'id': self.id,
            'label': self.label,
            'source_layer': self.source_layer,
            'kind': self.kind,
            'color': self.color,
            'rules': self.rules,
            'bundle_path': self.bundle_path,
            'manifest_path': self.manifest_path,
            'source_dataset': self.source_dataset,
            'provenance': self.provenance,
            'version': self.version,
        }

class AnnotationType:
    """Metadata for one annotation type discovered in a BigBed file."""
    def __init__(self, name, category='', description='', color=None):
        self.name = name
        self.category = category
        self.description = description
        self.color = color  # auto-assigned if None

class AnnotationFile:
    """A discovered/loaded annotation BigBed file."""
    def __init__(self, file_id, path, label=None):
        self.id = file_id
        self.path = path
        self.label = label or os.path.basename(path)
        self.active = False  # Lazy: must be activated by user
        self.annotation_types = {}  # name -> AnnotationType
        self.dataset_ids = []  # Associated datasets (empty = shared/global)
        self.manifest = None

    def to_dict(self):
        return {
            'id': self.id,
            'path': self.path,
            'label': self.label,
            'active': self.active,
            'dataset_ids': self.dataset_ids,
            'annotation_types': [
                {'name': t.name, 'category': t.category, 'description': t.description, 'color': t.color}
                for t in self.annotation_types.values()
            ],
        }

class AnnotationState:
    """Global annotation overlay state, lives on BrowserState."""
    def __init__(self):
        self.files = {}  # file_id -> AnnotationFile
        self.enabled_types = {}  # type_name -> bool
        self.confidence_thresholds = {}  # type_name -> float (0-1)
        self.type_colors = {}  # type_name -> hex
        self._cache = shared_cache('tracks')  # (file_id, chrom, start, end) -> annotations

    def clear_cache(self):
        self._cache.clear()

    def get_cached(self, key):
        value = self._cache.get(key)
        if value is not None:
            self._cache.move_to_end(key)
        return value

    def set_cached(self, key, value):
        self._cache[key] = value
        self._cache.move_to_end(key)
