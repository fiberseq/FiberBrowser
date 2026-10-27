"""BrowserState runtime container for FiberBrowser."""
from __future__ import annotations

import os
import math
import time
from collections import OrderedDict
from typing import Dict, List, Optional

from models.domain import AnnotationState, ChromInfo, Dataset, WorkingSet
from services.external_ucsc import _UCSC_GETDATA_TTL, _ucsc_getdata_cache
from services.dataset_registration import (
    add_dataset_to_state,
    dataset_id_from_source,
    invalidate_dataset_caches,
)
from services.filter_diagnostics import log_filtering_diagnostic
from services.circular_genome import (
    chrom_circular_metadata,
    circular_query_segments_for_region,
    is_mitochondrial_chrom,
    is_short_circular_candidate,
)
from services.genome_registry import GENOME_REGISTRY
from services.query_params import LEGACY_PRIMARY_DATASET_ID
from utils.chrom import build_chrom_map, normalize_chrom_name, translate_chrom
from utils.validation import is_source_ref, is_url


def detect_chroms_from_bam(bam_path):
    """Detect chromosomes from BAM header."""
    from services.remote_sources.opening import open_alignment_file

    try:
        with open_alignment_file(bam_path, "rb") as bam:
            return [ChromInfo(name=ref["SN"], size=ref["LN"]) for ref in bam.header["SQ"]]
    except Exception as exc:
        print(f"Error reading BAM header: {exc}")
        return []


def _source_identity(url):
    """A remote FASTA's source as written to disk: never a signed query (see signed_urls)."""
    from services.signed_urls import source_identity
    return source_identity(url)


def _plain_fasta_basename(fasta_url: str) -> str:
    import hashlib
    fasta_url = _source_identity(fasta_url)
    name = os.path.basename(fasta_url.split('?')[0])
    if name.endswith('.gz'):
        name = name[:-3]
    if not name.endswith(('.fa', '.fasta', '.fna')):
        name = hashlib.md5(fasta_url.encode()).hexdigest()[:12] + '.fa'
    return name


def _read_fasta_source(local_fa: str):
    try:
        with open(local_fa + '.source', 'r', encoding='utf-8') as fh:
            recorded = fh.read().strip() or None
    except OSError:
        return None
    from services.signed_urls import display_url, looks_signed
    if recorded and looks_signed(recorded):
        # Written by an older FiberBrowser with the signature: scrub it now.
        recorded = display_url(recorded)
        record_fasta_source(local_fa, recorded)
    return recorded


def cached_fasta_path(cache_dir: str, fasta_urls) -> str:
    """Where a remote FASTA (given with its mirror URLs) is cached.

    Named after the file, e.g. reference.fa, unless another source already
    cached a file of that name (recorded in reference.fa.source): then a
    name with this source's hash, so two different references never share
    one cache file. Caches from before sources were recorded are kept.
    """
    import hashlib
    urls = [_source_identity(u) for u in (fasta_urls or []) if u]
    plain = os.path.join(cache_dir, _plain_fasta_basename(urls[0]))
    recorded = _read_fasta_source(plain)
    if recorded is None or recorded in urls:
        return plain
    stem, ext = os.path.splitext(os.path.basename(plain))
    return os.path.join(cache_dir, f"{stem}.{hashlib.md5(urls[0].encode()).hexdigest()[:10]}{ext}")


def record_fasta_source(local_fa: str, url: str) -> None:
    """Note which source a cached FASTA came from (see cached_fasta_path).

    A pre-signed URL is recorded without its query: the signature is a
    credential and never goes to disk."""
    try:
        with open(local_fa + '.source', 'w', encoding='utf-8') as fh:
            fh.write(_source_identity(url))
    except OSError:
        pass


def _reopen_fasta(template):
    """An own handle on the template's FASTA, so closing it never closes the template's."""
    handle = getattr(template, 'fasta', None)
    filename = getattr(handle, 'filename', None)
    if isinstance(filename, bytes):
        filename = filename.decode('utf-8', 'replace')
    if not filename or not os.path.exists(str(filename)):
        return None
    try:
        from services.fasta_handles import ThreadLocalFasta
        return ThreadLocalFasta(str(filename))
    except Exception:
        return None


class BrowserState:
    # Fields that represent a single shared reference (FASTA handle, GTF,
    # current genome, chromosome info). When a session forks from the
    # template, it does NOT own its own copy of these — reads and writes
    # route through `_template` so /api/load_genome updates one place and
    # every session sees the new value. Per-session fields (`datasets`,
    # caches, etc.) stay per-instance and are not in this set.
    _SHARED_MUTABLE = frozenset({
        'gtf_data', 'gtf_path', 'fasta', 'fasta_path', 'fasta_error', 'reference_pairs',
        'chroms', 'chrom_map', 'current_genome', 'circular_chroms',
        'plasmid_sequences', 'plasmid_metadata', '_gtf_reference_lengths',
        # The registry genome whose download is the FASTA (services/genome_loading): shared with it.
        'registry_fasta',
    })

    def __setattr__(self, name, value):
        tmpl = self.__dict__.get('_template')
        # A copy-on-write session (a sandbox) owns its copies of the shared
        # reference: its writes stay local and never reach the template.
        if tmpl is not None and name in BrowserState._SHARED_MUTABLE and not self.__dict__.get('_cow_shared'):
            from services.runtime import shared_write_allowed
            if not shared_write_allowed(getattr(tmpl, name, None)):
                raise PermissionError(f"The shared reference ({name}) is read-only on a public server")
            setattr(tmpl, name, value)
        else:
            object.__setattr__(self, name, value)
            if name == 'gtf_data':
                # The assembly these annotations were loaded against: a later
                # FASTA of another assembly drops them even when contig names match.
                object.__setattr__(self, '_gtf_reference_lengths', self._reference_lengths())

    def _reference_lengths(self) -> dict:
        """Contig lengths of the current reference (plasmid maps aside); {} when none."""
        chroms = self.__dict__.get('chroms') or []
        plasmids = self.__dict__.get('plasmid_sequences') or {}
        lengths = {}
        for chrom in chroms:
            name = chrom.get('name') if isinstance(chrom, dict) else getattr(chrom, 'name', None)
            size = chrom.get('size') if isinstance(chrom, dict) else getattr(chrom, 'size', None)
            if name is None or size is None or name in plasmids:
                continue
            lengths[normalize_chrom_name(name)] = int(size)
        return lengths

    def __getattr__(self, name):
        # __getattr__ runs only when normal lookup has already failed — so
        # the template's own attributes (set via __init__) still win for it.
        # Sessions never set _SHARED_MUTABLE fields, so lookup falls through
        # here and delegates to the template.
        if name in BrowserState._SHARED_MUTABLE:
            tmpl = self.__dict__.get('_template')
            if tmpl is not None:
                return getattr(tmpl, name)
        raise AttributeError(name)

    def __init__(self, bigbed_dir, gtf_path=None, fire_dir=None, tracks_file=None, max_working_reads=0, fasta_path=None,
                 *, reference_only=False):
        if gtf_path:
            from services.gene_annotations import load_gtf

            self.gtf_data = load_gtf(gtf_path)
        else:
            self.gtf_data = None
        self.gtf_path = gtf_path  # Track GTF path for session save/restore
        if fire_dir:
            from services.fire_tracks import load_fire_data

            self.fire_df = load_fire_data(fire_dir)
        else:
            self.fire_df = None
        if tracks_file:
            from services.orthogonal_tracks import load_orthogonal_tracks

            self.orthogonal_tracks = load_orthogonal_tracks(tracks_file)
        else:
            self.orthogonal_tracks = []
        self.peak_regions = []
        self.chroms = []
        self.chrom_map = {}  # Maps normalized chrom names to actual dataset names
        self.current_genome = None  # Track which genome is loaded (e.g. 'hg38', 'dm6')
        self.circular_chroms: dict[str, dict] = {}
        self.plasmid_sequences: dict[str, str] = {}
        self.plasmid_metadata: dict[str, dict] = {}
        # References besides the main one, for datasets on another assembly
        # (services/panel_genomes.py): key -> context, dataset id -> key.
        self.genome_contexts: dict = {}
        self.dataset_genomes: dict[str, str] = {}

        # Reference sequence FASTA
        self.fasta = None
        self.fasta_path = None
        self.fasta_error = None  # Store error for UI feedback
        if fasta_path:
            err = self._load_fasta(fasta_path)
            if err:
                self.fasta_error = err
                print(f"\n  *** FASTA LOAD ERROR: {err} ***\n")

        # Runtime configuration
        # Optional backend safety valve for very small machines. Default 0
        # keeps working sets complete; user-facing analysis sampling is carried
        # on explicit API requests instead of silently changing every analysis.
        self.max_working_reads = max_working_reads
        self.config = {
            'prefetch_multiplier': 10,  # How much to prefetch (e.g., 10 = 10x viewport)
        }

        # Per-layer quality filters: applied at working-set construction time so all
        # downstream analytics (metaprofiles, clustering, peak scanning) see the
        # filtered state — not just rendering.  Each filter is a dict:
        #   {'layer': 'nuc'|'tf'|'msp'|'*', 'quality_name': 'mq'|'tq'|..., 'min_value': 0-255}
        self.quality_filters: List[Dict] = []
        # Legacy BAM/BigBed files carry one footprint stream. By default we
        # materialize canonical layers from that stream at cache-build time:
        # TF < cutoff, nuc >= cutoff, MSP/FIRE = gaps between adjacent nucs.
        self.infer_legacy_layers = True
        self.legacy_nuc_min_size = 90
        # A read's first or last footprint call at the read end (within
        # SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP of it) is cut off there;
        # shorter than the cutoff it is dropped at load time, for display and
        # every analysis alike (services.compact_read_loader).
        self.drop_short_terminal_footprints = True
        self.short_terminal_footprint_bp = 90
        
        # Multi-dataset support
        self.datasets: dict[str, Dataset] = {}
        self.dataset_order: list[str] = []  # Maintain order
        
        # Modification overlays (m6A/m5C bigBed files)
        self.modification_overlays: dict[str, dict] = {}

        # THREE-TIER CACHE ARCHITECTURE:
        # Broad cache: all overlapping reads (from BAM/BigBed) for large regions
        # This is the primary BAM read cache - loads 10x viewport and persists
        # Working sets are computed on-demand from this cache (NOT cached separately)
        self._broad_cache: OrderedDict[tuple, tuple] = OrderedDict()  # LRU cache: (ds_id, chrom, start, end) -> (reads, timestamp)
        self._broad_cache_schema_version = 4
        self._broad_cache_max = 20  # Conservative limit (each entry can be large)
        # Completed local reads stay useful across navigation. Byte budgets and
        # dataset/settings invalidation govern retention, not elapsed time.
        self._broad_cache_timeout = None

        # Working-set cache: viewport-adjusted compact reads built from broad cache.
        # This is short-lived because it duplicates read dictionaries and must track
        # quality filters / sampling caps exactly.
        self._working_set_cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._working_set_cache_max = 12
        self._working_set_cache_timeout = None

        # Meta profile cache - LRU cache for computed meta profiles
        # Key: (dataset_id, chrom, start, end)
        # Value: (nuc_profile, subnuc_profile, timestamp)
        self._meta_profile_cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._meta_profile_cache_max = 100  # Cache many regions
        self._meta_profile_cache_timeout = 60  # 1 minute (profiles change with filtering)

        # Orthogonal track signal cache. These arrays are viewport-sized and
        # cheap to evict, but avoiding repeated pyBigWig stats/open work helps
        # sessions with many visible tracks, especially on network mounts.
        self._track_data_cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._track_data_cache_max = 128
        self._track_data_cache_timeout = 30
        self._track_region_cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._track_region_cache_max = 64
        self._track_region_cache_timeout = 45

        # Annotation overlay state
        self.annotation_state = AnnotationState()

        # Catalog load/unload tracking (per-session in public mode via fork).
        # routers.catalog holds the parsed JSON (read-only); these fields track
        # which groups/tracks THIS state has currently loaded.
        self._catalog_loaded: dict = {}               # group_index -> list of dataset_ids
        self._catalog_loaded_tracks: set = set()      # set of track_index

        # Primer config — per-session in public mode (each visitor picks their
        # own BLAST DB). Set here so BrowserState is authoritative.
        self.primer_blast_db = None
        self.primer_fasta = None

        if not reference_only:
            from services.performance import initialize
            initialize(self)

        # Add startup dataset if provided (can be BigBed dir, single BigBed file, BAM file, or list of BAMs)
        if bigbed_dir:
            dataset_id = dataset_id_from_source(bigbed_dir, "dataset_1")
            # Handle list of BAM files (for comma-separated --bam argument)
            if isinstance(bigbed_dir, list):
                # Multiple BAM files as single combined dataset
                label = f"Combined ({len(bigbed_dir)} files)"
                self.add_dataset(dataset_id, bigbed_dir, label)
            elif bigbed_dir.endswith('.bam') and os.path.isfile(bigbed_dir):
                self.add_dataset(dataset_id, bigbed_dir, os.path.basename(bigbed_dir).rsplit('.', 1)[0])
            elif bigbed_dir.endswith(('.bb', '.bigbed', '.bigBed')) and os.path.isfile(bigbed_dir):
                self.add_dataset(dataset_id, bigbed_dir, os.path.basename(bigbed_dir).rsplit('.', 1)[0])
            elif os.path.isdir(bigbed_dir):
                self.add_dataset(dataset_id, bigbed_dir, os.path.basename(bigbed_dir.rstrip('/')))

    @classmethod
    def fork_for_session(cls, template: 'BrowserState', *, copy_shared: bool = False,
                         include_data: bool = True) -> 'BrowserState':
        """Create a per-session BrowserState forked from ``template``.

        Heavy read-only resources (FASTA handle, GTF, chrom info, catalog-
        preloaded tracks, CLI-loaded datasets) are aliased from the template so
        the fork is cheap and shares memory. Mutable dicts/lists/caches are
        fresh per session so visitor actions don't leak across users.

        The template is the normal BrowserState built by ``main()`` at startup.
        Sessions never mutate the template; every write path touches the
        session-local copy.

        ``copy_shared`` (sandbox tabs): the session owns shallow copies of the
        shared reference (GTF, chroms, genome, plasmids, its own FASTA handle)
        instead of routing them through the template, so loading or clearing a
        reference in the sandbox never changes the main tab's. ``include_data``
        False starts with no datasets or tracks (a clean tour).
        """
        import copy
        self = object.__new__(cls)

        # Set the template backref FIRST so __setattr__ can route shared
        # fields correctly. Everything in `_SHARED_MUTABLE` now lives on the
        # template only — reads/writes to `self.gtf_data` etc. transparently
        # go through the template. Writes from /api/load_genome update one
        # place; all sessions see the new value on next read.
        object.__setattr__(self, '_template', template)
        if copy_shared:
            object.__setattr__(self, '_cow_shared', True)
            for name in cls._SHARED_MUTABLE:
                value = getattr(template, name, None)
                if name == 'fasta' and value is not None:
                    value = _reopen_fasta(template) or value
                elif isinstance(value, (list, dict, set)):
                    value = type(value)(value)
                object.__setattr__(self, name, value)

        # --- Shared / read-only refs that never change after startup.
        # These are safe to alias directly — no re-read via template needed.
        self.fire_df = template.fire_df
        self.config = dict(template.config)
        self.max_working_reads = template.max_working_reads
        self.infer_legacy_layers = template.infer_legacy_layers
        self.legacy_nuc_min_size = template.legacy_nuc_min_size
        self.drop_short_terminal_footprints = getattr(template, "drop_short_terminal_footprints", True)
        self.short_terminal_footprint_bp = getattr(template, "short_terminal_footprint_bp", 90)

        # --- Fresh per-session copies ---
        # Datasets + orthogonal tracks start as shallow copies of the template
        # so catalog-preloaded tracks and CLI-supplied datasets flow through
        # to every new visitor, but per-session add/remove diverges.
        self.datasets = {}
        for dataset_id, source_dataset in (template.datasets.items() if include_data else ()):
            dataset = copy.copy(source_dataset)
            # Dataset objects contain mutable analysis/capability state. Keep
            # paths and other heavy immutable values shared, but detach every
            # mapping a session can mutate so a family scan (or clustering)
            # cannot leak into another visitor's layer selector.
            for attribute in (
                "available_layers",
                "companion_layers",
                "derived_layers",
                "cluster_assignments",
            ):
                value = getattr(source_dataset, attribute, None)
                if isinstance(value, dict):
                    setattr(dataset, attribute, dict(value))
            self.datasets[dataset_id] = dataset
        self.dataset_order = list(template.dataset_order) if include_data else []
        # Copy each track's settings: a visitor's track filter must not
        # change the template's (every other visitor's) track.
        self.orthogonal_tracks = ([dict(t) if isinstance(t, dict) else t for t in template.orthogonal_tracks]
                                  if include_data else [])

        self.modification_overlays = {}
        self.quality_filters = []
        self.peak_regions = []
        self.annotation_state = AnnotationState()
        # A dataset's own reference is the session's (never the template's).
        self.genome_contexts = {}
        self.dataset_genomes = {}

        # All caches must be session-local: cache keys include dataset_id,
        # and datasets are now per-session.
        self._broad_cache = OrderedDict()
        self._broad_cache_schema_version = getattr(template, "_broad_cache_schema_version", 4)
        self._broad_cache_max = template._broad_cache_max
        self._broad_cache_timeout = template._broad_cache_timeout
        self._working_set_cache = OrderedDict()
        self._working_set_cache_max = template._working_set_cache_max
        self._working_set_cache_timeout = template._working_set_cache_timeout
        self._meta_profile_cache = OrderedDict()
        self._meta_profile_cache_max = template._meta_profile_cache_max
        self._meta_profile_cache_timeout = template._meta_profile_cache_timeout
        self._track_data_cache = OrderedDict()
        self._track_data_cache_max = template._track_data_cache_max
        self._track_data_cache_timeout = template._track_data_cache_timeout
        self._track_region_cache = OrderedDict()
        self._track_region_cache_max = template._track_region_cache_max
        self._track_region_cache_timeout = template._track_region_cache_timeout
        from services.performance import apply_mode
        self._configured_max_working_reads = getattr(template, '_configured_max_working_reads', template.max_working_reads)
        performance = getattr(template, 'performance', {})
        apply_mode(self, performance.get('mode', 'auto'),
                   browser_tier='low' if performance.get('effective') == 'low' else None,
                   invalidate=False)

        # Catalog-loaded tracking must also be per-session.
        self._catalog_loaded = {}
        self._catalog_loaded_tracks = set()

        # Primer config is per-session (each visitor picks their own BLAST DB).
        self.primer_blast_db = None
        self.primer_fasta = None

        # Suppress unused-import warning when copy isn't hit.
        _ = copy
        return self

    def _load_fasta(self, path, fai_url=None, fasta_urls=None, fai_urls=None):
        """Load a reference FASTA file for sequence display.

        Supports local paths and HTTP URLs with fallback URL lists.
        Remote URLs are downloaded to ~/.fiberhmm/genomes/ cache.
        Requires .fai index (downloaded or generated via samtools faidx).

        Also updates state.chroms and state.chrom_map from FASTA references
        so the chromosome list reflects the loaded genome.

        Returns:
            None on success, or an error string on failure.
        """
        # One handle per thread (services/fasta_handles.py): the reference is
        # read from the event loop, request threads and consensus jobs at once.
        from services.fasta_handles import ThreadLocalFasta
        try:
            # Open the new reference first; the current one (and any plasmids)
            # stays until it has opened, so a failed load changes nothing.
            if path.startswith('http://') or path.startswith('https://'):
                # Remote FASTA - download to cache (pysam remote support is unreliable)
                local_path = self._download_fasta_to_cache(
                    path, fai_url=fai_url, fasta_urls=fasta_urls, fai_urls=fai_urls)
                if local_path is None:
                    return f"Failed to download remote FASTA: {path}"
                handle = ThreadLocalFasta(local_path)
                print(f"  Loaded remote FASTA: {path} ({handle.nreferences} sequences)")
            elif is_url(path) and is_source_ref(path):
                # A FASTA on a connected cluster: read by range through its .fai.
                from services.local_paths import source_ref_access_error
                missing = source_ref_access_error(path) or (
                    None if source_ref_access_error(path + '.fai') is None
                    else f"Index not found: {path}.fai. Run samtools faidx on the cluster.")
                if missing:
                    return missing
                handle = ThreadLocalFasta(path)
                print(f"  Loaded cluster FASTA: {path} ({handle.nreferences} sequences)")
            else:
                # Local file
                if not os.path.exists(path):
                    print(f"  WARNING: FASTA file not found: {path}")
                    return f"File not found: {path}"
                fai_path = path + '.fai'
                if not os.path.exists(fai_path):
                    print(f"  WARNING: FASTA index not found: {fai_path}")
                    print(f"  Create with: samtools faidx {path}")
                    return f"Index not found: {fai_path}. Create with: samtools faidx {path}"
                handle = ThreadLocalFasta(path)
                print(f"  Loaded FASTA: {path} ({handle.nreferences} sequences)")

            previous_lengths = {
                normalize_chrom_name(chrom.name): int(chrom.size)
                for chrom in (self.chroms or [])
                if chrom.name not in (self.plasmid_sequences or {})
            }
            self.fasta = handle
            self.fasta_path = path
            # One FASTA replaces a paired reference collection: its pairs would
            # otherwise be saved (and restored) instead of this reference.
            self.reference_pairs = None
            self.plasmid_sequences = {}
            self.plasmid_metadata = {}
            self._forget_previous_assembly(previous_lengths, handle, path)

            # Update chroms from FASTA references so chromosome list reflects loaded genome
            if self.fasta is not None:
                self._reset_circular_chroms_for_reference(self.fasta)
                fasta_chroms = [
                    self._chrom_info_with_circular_flags(
                        ref,
                        self.fasta.get_reference_length(ref),
                    )
                    for ref in self.fasta.references
                ]
                self.chroms = fasta_chroms
                self.chrom_map = build_chrom_map(fasta_chroms)
                print(f"  Updated chroms from FASTA: {len(fasta_chroms)} sequences")

            # Infer genome id from FASTA basename so JASPAR auto-scanning and
            # other genome-gated features work for users who load a local
            # reference (e.g. hg38.fa) without going through the Online
            # registry picker. Only set when the stem exactly matches a
            # known id — avoids surprises on user-renamed files.
            if self.current_genome is None and self.fasta_path:
                stem = os.path.basename(self.fasta_path)
                for ext in ('.fa.gz', '.fasta.gz', '.fa', '.fasta', '.fna'):
                    if stem.lower().endswith(ext):
                        stem = stem[: -len(ext)]
                        break
                if stem in GENOME_REGISTRY:
                    self.current_genome = stem
                    print(f"  Inferred genome id from filename: {stem}")
                    # Pair the FASTA load with the matching cached GTF when
                    # one exists. Registry loads (Online picker) already do
                    # both, but persisted-FASTA startup paths used to skip
                    # the GTF entirely — user saw chroms but no genes.
                    # Only load if cached locally (don't download here;
                    # download is the registry path's job).
                    if self.gtf_data is None or not self.gtf_path:
                        cache_dir = os.path.join(
                            os.path.expanduser("~"), ".fiberhmm", "genomes"
                        )
                        cached_gtf = os.path.join(cache_dir, f"{stem}.gtf")
                        if os.path.exists(cached_gtf):
                            try:
                                from services.gene_annotations import load_gtf

                                self.gtf_data = load_gtf(cached_gtf)
                                self.gtf_path = cached_gtf
                                gene_count = len(
                                    (self.gtf_data or {}).get('transcripts', [])
                                )
                                print(f"  Loaded cached GTF: {cached_gtf} ({gene_count} transcripts)")
                            except Exception as e:
                                print(f"  WARNING: Failed to load cached GTF {cached_gtf}: {e}")

            return None
        except Exception as e:
            print(f"  ERROR loading FASTA: {e}")
            # The current reference is untouched unless the new one opened.
            return f"Error loading FASTA: {e}"

    def _forget_previous_assembly(self, previous_lengths: dict, reference, path: str) -> None:
        """A FASTA of another assembly replaces the genome's identity, and the
        annotations go unless they were loaded against that assembly, or with
        no reference at all and they fit its contigs.

        Same assembly: every contig both have is the same length. With no
        previous reference contigs (startup), nothing is assumed.
        """
        if not previous_lengths:
            return
        new_lengths = {
            normalize_chrom_name(ref): int(reference.get_reference_length(ref))
            for ref in reference.references
        }
        shared = set(previous_lengths) & set(new_lengths)
        if shared and all(previous_lengths[name] == new_lengths[name] for name in shared):
            return
        # Unknown now; the filename inference that follows sets it (and loads
        # that genome's cached annotations) when the file is a known genome.
        self.current_genome = None
        transcripts = (self.gtf_data or {}).get('transcripts') if self.gtf_data else None
        annotation_chroms = set()
        if transcripts is not None and len(transcripts) and 'chrom' in transcripts:
            annotation_chroms = {normalize_chrom_name(str(c)) for c in transcripts['chrom'].unique()}
        loaded_against = getattr(self, '_gtf_reference_lengths', None) or {}
        if loaded_against:
            # Contig names alone don't tell hg19 from hg38: the lengths must match.
            common = set(loaded_against) & set(new_lengths)
            fits = bool(common) and all(loaded_against[name] == new_lengths[name] for name in common)
        else:
            fits = bool(annotation_chroms) and annotation_chroms <= set(new_lengths)
        if self.gtf_data is not None and not fits:
            self.gtf_data = None
            self.gtf_path = None

    def _reset_circular_chroms_for_reference(self, reference) -> None:
        """Circular flags belong to the active reference: keep the ones for
        contigs it has (at its lengths), drop the rest (the previous genome's
        chrM, plasmids), and flag its mitochondrial contig."""
        lengths = {ref: int(reference.get_reference_length(ref)) for ref in reference.references}
        circular = {
            name: {**meta, "size": lengths[name]}
            for name, meta in (self.circular_chroms or {}).items()
            if name in lengths and (meta or {}).get("source") != "plasmid_map"
        }
        for ref, length in lengths.items():
            if ref not in circular and is_mitochondrial_chrom(ref):
                circular[ref] = {"source": "mitochondrial_reference", "size": length}
        self.circular_chroms = circular

    def _chrom_info_with_circular_flags(self, name: str, size: int) -> ChromInfo:
        meta = chrom_circular_metadata(self, name)
        return ChromInfo(
            name=name,
            size=int(size),
            circular=bool(meta),
            circular_source=str(meta.get("source", "")) if meta else None,
        )

    def refresh_circular_chrom_flags(self) -> None:
        """Rebuild ChromInfo objects so `/api/chroms` exposes circular status."""
        if not self.chroms:
            return
        self.chroms = [
            self._chrom_info_with_circular_flags(chrom.name, chrom.size)
            for chrom in self.chroms
        ]
        self.chrom_map = build_chrom_map(self.chroms)

    def set_circular_chrom(
        self,
        chrom: str,
        *,
        source: str = "user",
        size: int | None = None,
        label: str | None = None,
    ) -> None:
        resolved_chrom = self.translate_chrom(chrom)
        chrom_size = int(size) if size else self._chrom_size_for(resolved_chrom)
        # Copy, change, assign: the assignment is what the shared-reference
        # guard checks, so a refused write must not have mutated in place.
        circular = dict(self.circular_chroms or {})
        circular[resolved_chrom] = {
            "source": source,
            "size": chrom_size,
            **({"label": label} if label else {}),
        }
        self.circular_chroms = circular
        self.refresh_circular_chrom_flags()

    def add_supplemental_plasmid_reference(
        self,
        name: str,
        sequence: str,
        *,
        source: str = "plasmid_map",
        path: str | None = None,
        label: str | None = None,
        circular: bool = True,
    ) -> None:
        """Add a small plasmid/reference sequence without replacing the genome FASTA."""
        cleaned_name = str(name or "").strip()
        if not cleaned_name:
            raise ValueError("Supplemental reference name is required")
        sequence = str(sequence or "").upper()
        if not sequence:
            raise ValueError(f"Supplemental reference {cleaned_name} has no sequence")

        # Copy, change, assign (see set_circular_chrom).
        sequences = dict(self.plasmid_sequences or {})
        sequences[cleaned_name] = sequence
        metadata = dict(self.plasmid_metadata or {})
        metadata[cleaned_name] = {
            "source": source,
            "path": path,
            "label": label or cleaned_name,
            "size": len(sequence),
            "circular": bool(circular),
        }
        circular_chroms = dict(self.circular_chroms or {})
        if circular:
            circular_chroms[cleaned_name] = {
                "source": source,
                "size": len(sequence),
                **({"label": label} if label else {}),
                **({"path": path} if path else {}),
            }
        else:
            circular_chroms.pop(cleaned_name, None)
        self.plasmid_sequences = sequences
        self.plasmid_metadata = metadata
        self.circular_chroms = circular_chroms
        if source == "plasmid_map" and path:
            from services.library_hooks import note_plasmid_map_opened
            note_plasmid_map_opened(path)

        chroms = [chrom for chrom in (self.chroms or []) if chrom.name != cleaned_name]
        chroms.append(self._chrom_info_with_circular_flags(cleaned_name, len(sequence)))
        self.chroms = chroms
        self.chrom_map = build_chrom_map(chroms)

    def clear_circular_chroms(self, *, source: str | None = None) -> None:
        if source is None:
            self.circular_chroms = {}
        else:
            self.circular_chroms = {
                chrom: meta
                for chrom, meta in (self.circular_chroms or {}).items()
                if meta.get("source") != source
            }
        self.refresh_circular_chrom_flags()

    def infer_circular_chroms_from_dataset(self, dataset) -> None:
        """Mark contigs circular when the dataset says so: ``@SQ TP:circular``
        in its BAM header, or (short mitochondrial/plasmid-like contigs) AN tags."""
        declared = dict(getattr(dataset, "circular_contigs", None) or {})
        by_annotation = bool(getattr(dataset, "has_circular_annotations", False))
        if not declared and not by_annotation:
            return
        circular = dict(self.circular_chroms or {})
        updated = False
        for chrom in self.chroms or []:
            if chrom.name in circular:
                continue
            length = declared.get(chrom.name)
            if length is None:
                for contig, contig_length in declared.items():
                    if self.translate_chrom(contig) == chrom.name:
                        length = contig_length
                        break
            if length is not None and int(length) == int(chrom.size):
                circular[chrom.name] = {
                    "source": "bam_topology",
                    "size": int(chrom.size),
                    "dataset_id": getattr(dataset, "id", None),
                }
                updated = True
                continue
            if by_annotation and is_short_circular_candidate(chrom.name, chrom.size):
                circular[chrom.name] = {
                    "source": "fiberhmm_tags",
                    "size": int(chrom.size),
                    "dataset_id": getattr(dataset, "id", None),
                }
                updated = True
        if not updated:
            return
        # The shared reference (chroms, circular flags) is read-only on a
        # public server: the dataset still loads, without circular flags.
        # Check both fields first; the guard lets an empty field be filled, so
        # the first write could succeed and the second be refused, leaving
        # the shared reference half changed.
        template = self.__dict__.get('_template')
        if template is not None:
            from services.runtime import shared_write_allowed
            if not (shared_write_allowed(template.circular_chroms) and shared_write_allowed(template.chroms)):
                return
        self.circular_chroms = circular
        self.refresh_circular_chrom_flags()

    @staticmethod
    def _download_fasta_to_cache(url, fai_url=None, fasta_urls=None, fai_urls=None):
        """Download a remote FASTA and its .fai index to the cache directory, one download at a time per
        cache file name (services/download_locks.py): a second request for it waits and then finds the cached
        file, or (another source of that name) takes a source-hashed name."""
        from services.download_locks import holding
        first = (list(fasta_urls or []) or [url])[0] or url
        # Keyed on the cache file the source's name maps to, not the URL: two sources with one file name
        # (https://a/ref.fa, https://b/ref.fa) pick their cache file (cached_fasta_path: the plain name, or a
        # source-hashed one when the plain file is another source's) and download one after the other, never
        # into the same .download.tmp. Existing caches keep their names.
        cache_dir = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
        plain = os.path.abspath(os.path.join(cache_dir, _plain_fasta_basename(first)))
        with holding(f"fasta-cache:{plain}"):
            return BrowserState._download_fasta_to_cache_unlocked(
                url, fai_url=fai_url, fasta_urls=fasta_urls, fai_urls=fai_urls)

    @staticmethod
    def _download_fasta_to_cache_unlocked(url, fai_url=None, fasta_urls=None, fai_urls=None):
        """Download a remote FASTA to the cache directory and index it there (ensure_verified_index).

        Supports fallback URL lists: tries each URL in order until one succeeds.

        Args:
            url: Primary URL to the .fa file (legacy single-URL).
            fai_url: Accepted for compatibility; the index is built locally.
            fasta_urls: List of FASTA URLs to try in order.
            fai_urls: Accepted for compatibility; the index is built locally.

        Returns the local path to the cached .fa file, or None on failure.
        """
        import urllib.request
        import hashlib
        import subprocess
        import shutil
        import gzip

        cache_dir = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
        os.makedirs(cache_dir, exist_ok=True)

        _ensure_plain_fasta = _ensure_plain_cached_fasta

        # Build URL lists
        fa_urls = list(fasta_urls or [])
        if url and url not in fa_urls:
            fa_urls.insert(0, url)
        # fai_url/fai_urls are accepted for compatibility and not downloaded: the index is built from the
        # FASTA itself (a mirror's index can describe another file).

        if not fa_urls:
            print("  ERROR: No FASTA URLs provided")
            return None

        # Use a plain FASTA cache filename so pysam/samtools never index gzip
        # bytes, one per source (another reference with the same file name
        # gets its own).
        local_fa = cached_fasta_path(cache_dir, fa_urls)
        local_fai = local_fa + '.fai'

        if os.path.exists(local_fa):
            _ensure_plain_fasta(local_fa)
            if _read_fasta_source(local_fa) is None:
                record_fasta_source(local_fa, fa_urls[0])

        # Download .fa (can be large - show progress)
        if not os.path.exists(local_fa):
            downloaded = False
            for fa_url in fa_urls:
                print(f"  Downloading FASTA: {fa_url}")
                try:
                    def _progress(block_num, block_size, total_size):
                        downloaded_bytes = block_num * block_size
                        if total_size > 0:
                            pct = min(100, downloaded_bytes * 100 // total_size)
                            mb = downloaded_bytes / (1024 * 1024)
                            total_mb = total_size / (1024 * 1024)
                            if block_num % 500 == 0:
                                print(f"    {mb:.0f}/{total_mb:.0f} MB ({pct}%)")
                        elif block_num % 2000 == 0:
                            mb = downloaded_bytes / (1024 * 1024)
                            print(f"    {mb:.0f} MB downloaded...")

                    download_tmp = local_fa + '.download.tmp'
                    _http_fetch(fa_url, download_tmp, _progress)
                    if fa_url.split('?')[0].endswith('.gz'):
                        print(f"  Decompressing FASTA: {os.path.basename(fa_url)}")
                        with gzip.open(download_tmp, 'rb') as src, open(local_fa + '.tmp', 'wb') as dst:
                            shutil.copyfileobj(src, dst)
                        os.remove(download_tmp)
                    else:
                        os.rename(download_tmp, local_fa + '.tmp')
                    if not _ensure_plain_fasta(local_fa + '.tmp'):
                        raise RuntimeError("Downloaded file is not a plain FASTA")
                    os.rename(local_fa + '.tmp', local_fa)
                    record_fasta_source(local_fa, fa_url)
                    size_mb = os.path.getsize(local_fa) / (1024 * 1024)
                    print(f"  FASTA saved: {local_fa} ({size_mb:.0f} MB)")
                    downloaded = True
                    break
                except Exception as e:
                    print(f"  Failed: {e}")
                    if os.path.exists(local_fa + '.tmp'):
                        os.remove(local_fa + '.tmp')
                    if os.path.exists(local_fa + '.download.tmp'):
                        os.remove(local_fa + '.download.tmp')

            if not downloaded:
                print(f"  ERROR: All FASTA download URLs failed")
                return None
        else:
            size_mb = os.path.getsize(local_fa) / (1024 * 1024)
            print(f"  FASTA cached: {local_fa} ({size_mb:.0f} MB)")

        # The index is always built from the FASTA itself (a mirror's .fai can describe another file), once:
        # a verification stamp next to it lets later loads of the unchanged pair skip the work. A wrong index
        # that cannot be replaced (read-only cache) refuses the load.
        ensure_verified_index(local_fa)
        return local_fa

    def build_working_set(self, dataset_id: str, chrom: str, start: int, end: int,
                          spanning: bool = False, min_footprints: int = 0,
                          read_ids: list = None, include_methylation: bool = True,
                          include_layers: bool = True,
                          requested_layers=None,
                          include_layer_qualities: bool = True,
                          quality_filters=None,
                          sample_seed: str = "fiberbrowser-analysis",
                          infer_legacy_layers: bool = None,
                          legacy_nuc_min_size: int = None,
                          broad_prefetch_multiplier: Optional[int] = None,
                          force_reload: bool = False) -> WorkingSet:
        """
        Build a working set for a viewport region from the broad cache.
        
        Architecture:
        - Broad cache: Large region from BAM (``--prefetch`` x viewport, default 10x),
          persists across requests
        - Working set: Filtered view computed on-demand from broad cache (NOT cached)
        - Display sample: Sampled from working set for rendering
        
        Args:
            min_footprints: Minimum number of footprints (intervals with size > 0) required.
            include_methylation: Include methylation/deamination fields in BAM/BigBed
                reads. Leave True for display compatibility; analysis callers that
                only need interval layers can set False to avoid expensive mark parsing.
            include_layers: Include display-oriented annotation layer payloads
                (`layers`, FIRE/MSP overlays). Analysis callers that only need
                primary intervals can set False to avoid per-read layer assembly.
            include_layer_qualities: Include per-layer quality arrays. Disable for
                faster display when interval geometry is enough.
        """
        from services.working_sets import build_working_set as _build_working_set
        from services.bam_handles import get_bam_handle as _get_bam_handle
        from services.bigbed_detection import detect_overlay_type as _detect_overlay_type
        from services.bigbed_handles import get_bigbed_handle as _get_bigbed_handle
        from services.bigbed_read_loader import load_methyl_from_bigbed as _load_methyl_from_bigbed
        from services.compact_read_loader import (
            build_compact_reads_from_bigbed as _build_compact_reads_from_bigbed,
            short_terminal_footprint_bp_for as _short_terminal_footprint_bp_for,
        )
        from services.read_route_helpers import build_direct_bam_reads as _build_direct_bam_reads
        from services.read_metrics import sample_stable_by_id

        def _load_bam_reads(*args, **kwargs):
            kwargs.setdefault("bam_handle_getter", _get_bam_handle)
            kwargs.setdefault("chrom_map", self.chrom_map)
            # Use the same loader as the display endpoints so every analysis
            # consumer (clustering, co-occurrence, Footprint Analysis) sees the
            # same reads as the read renderer.
            return _build_direct_bam_reads(self, *args, **kwargs)

        # Analyses need the complete cohort on their first run in a region.
        # Decode pooled sources together instead of opening a separate worker
        # pool for each large file (or decoding smaller files serially).
        from services.read_route_helpers import display_bam_loader
        _load_bam_reads.load_many = display_bam_loader(self).load_many

        def _load_bigbed_reads(*args, **kwargs):
            kwargs.setdefault("bigbed_handle_getter", _get_bigbed_handle)
            kwargs.setdefault("overlay_type_detector", _detect_overlay_type)
            kwargs.setdefault("short_terminal_footprint_bp", _short_terminal_footprint_bp_for(self))
            return _build_compact_reads_from_bigbed(*args, **kwargs)

        def _load_bigbed_marks(*args, **kwargs):
            kwargs.setdefault("bigbed_handle_getter", _get_bigbed_handle)
            return _load_methyl_from_bigbed(*args, **kwargs)

        effective_requested_layers = requested_layers

        if self.__dict__.get('consensus_workflow_active'):
            from services.consensus_workflow import active,source_layers
            if active(self,dataset_id,chrom,start,end):
                effective_requested_layers=source_layers(effective_requested_layers)
        working_set = _build_working_set(
            self,
            dataset_id,
            chrom,
            start,
            end,
            spanning=spanning,
            min_footprints=min_footprints,
            read_ids=read_ids,
            include_methylation=include_methylation,
            include_layers=include_layers,
            requested_layers=effective_requested_layers,
            include_layer_qualities=include_layer_qualities,
            quality_filters=quality_filters,
            infer_legacy_layers=self.infer_legacy_layers if infer_legacy_layers is None else infer_legacy_layers,
            legacy_nuc_min_size=self.legacy_nuc_min_size if legacy_nuc_min_size is None else legacy_nuc_min_size,
            sample_seed=sample_seed,
            broad_prefetch_multiplier=broad_prefetch_multiplier,
            force_reload=force_reload,
            build_bam_reads=_load_bam_reads,
            build_bigbed_reads=_load_bigbed_reads,
            load_bigbed_marks=_load_bigbed_marks,
            stable_sampler=sample_stable_by_id,
        )
        if self.__dict__.get('scan_registry'):
            # fiberhmm-scan states as layers (tables-mode scans bound to this dataset), before the consensus
            # projection so its receipt names the rows it returns. Rows the working set overlaid before its quality
            # filters carry the overlay's receipt and are returned as they are (a filtered mark never comes back).
            from services.scan.overlay import apply_to_working_set
            working_set = apply_to_working_set(self, dataset_id, chrom, start, end, working_set)
        if self.__dict__.get('consensus_workflow_active'):
            from services.consensus_workflow import apply_overlays
            working_set = apply_overlays(self, dataset_id, chrom, start, end, working_set)
        return working_set

    def _apply_quality_filters(self, read: dict) -> Optional[dict]:
        """Apply configured per-layer quality filters to a compact read."""
        from services.read_quality_filters import apply_quality_filters

        return apply_quality_filters(read, self.quality_filters)

    def set_quality_filters(self, filters: List[Dict]):
        """Set the per-layer quality filters. Clears meta profile cache."""
        if self.quality_filters == filters:
            return False
        self.quality_filters = filters
        # Clear meta profile cache since filter state changed
        self._meta_profile_cache.clear()
        self._working_set_cache.clear()
        log_filtering_diagnostic(f"Quality filters updated: {len(filters)} active")
        for f in filters:
            log_filtering_diagnostic(f"  {f.get('layer','*')}.{f.get('quality_name','?')} >= {f.get('min_value',0)}")
        return True

    def set_legacy_layer_inference(self, enabled: bool = True, nuc_min_size: int = 90):
        """Set legacy layer inference policy and clear read caches."""
        if self.infer_legacy_layers == bool(enabled) and self.legacy_nuc_min_size == max(1, int(nuc_min_size or 90)):
            return
        self.infer_legacy_layers = bool(enabled)
        self.legacy_nuc_min_size = max(1, int(nuc_min_size or 90))
        self.clear_cache()

    def set_short_terminal_footprints(self, enabled: bool) -> bool:
        """Drop (or keep) read-end footprints under the cutoff; clears the read
        caches when that changes. Returns whether it changed."""
        enabled = bool(enabled)
        if enabled == bool(getattr(self, "drop_short_terminal_footprints", True)):
            return False
        self.drop_short_terminal_footprints = enabled
        self.clear_cache()
        return True

    def clear_cache(self):
        """Clear all read caches."""
        self._broad_cache.clear()
        self._working_set_cache.clear()
        if hasattr(self, '_track_data_cache'):
            self._track_data_cache.clear()
        if hasattr(self, '_track_region_cache'):
            self._track_region_cache.clear()
        if hasattr(self, '_methylation_cache'):
            self._methylation_cache.clear()
        if hasattr(self, '_read_strand_calls'):
            self._read_strand_calls.clear()

    def translate_chrom(self, chrom: str) -> str:
        """Translate chromosome name to dataset's actual name."""
        return translate_chrom(chrom, self.chrom_map)
    
    def add_dataset(self, dataset_id: str, path, label: str = None, *, data_type: str = None,
                    configure=None, detect_chroms=None) -> Dataset:
        """Add a new dataset.
        
        Args:
            dataset_id: Unique identifier for the dataset
            path: Single path (str) or list of paths (list)
            label: Optional display label
            data_type, configure, detect_chroms: a dataset type set rather than detected, a hook run before it
                is published, and where an empty state's chromosomes come from instead of the BAM header (a
                live-lift dataset: services/lift/registration.py)
        """
        # Loading a cached drag-and-drop upload counts as using it, and so do
        # the companion/derived-layer files found next to it.
        from services.upload_store import dataset_file_paths, mark_uploads_used
        from services.tracks_endpoint import _held_url
        # A pre-signed URL's display form (a restored session) opens as the full
        # URL this server still holds (services/signed_urls.py).
        path = [_held_url(p) for p in path] if isinstance(path, (list, tuple)) else _held_url(path)
        mark_uploads_used(path if isinstance(path, (list, tuple)) else [path])
        dataset = add_dataset_to_state(
            self,
            dataset_id,
            path,
            label,
            detect_bam_chroms=detect_chroms or detect_chroms_from_bam,
            detect_bigbed_chroms=self._detect_chroms_from_bigbed,
            data_type=data_type,
            configure=configure,
        )
        mark_uploads_used(dataset_file_paths(dataset))
        # A plasmid BAM: load the map its header names, and link its contigs to
        # the loaded maps whose sequence they are (renamed or rotated references).
        from services.plasmid_reconcile import after_dataset_added
        after_dataset_added(self, dataset)
        # Plugin packs see it (a dataset they built knows its definition again).
        from plugins.packs import run_hooks
        run_hooks("dataset_opened", self, dataset)
        # The user's Library remembers the files they open (background; local only).
        from services.library_hooks import note_dataset_opened
        note_dataset_opened(dataset)
        return dataset
    
    def remove_dataset(self, dataset_id: str):
        """Remove a dataset (under the state lock: services/genome_loading lock order)."""
        from services.genome_loading import state_lock
        with state_lock(self):
            self._remove_dataset_locked(dataset_id)

    def remove_dataset_if(self, dataset_id: str, dataset) -> bool:
        """Remove ``dataset_id`` only if it is still this very dataset object (not one loaded under its id since)."""
        from services.genome_loading import state_lock
        with state_lock(self):
            if self.datasets.get(dataset_id) is not dataset:
                return False
            self._remove_dataset_locked(dataset_id)
            return True

    def _remove_dataset_locked(self, dataset_id: str):
        if dataset_id in self.datasets:
            dataset = self.datasets.pop(dataset_id)
            self.dataset_order.remove(dataset_id)
            invalidate_dataset_caches(self, dataset_id)
            from services.file_handles import handles
            from services.upload_store import dataset_file_paths
            retained = {path for other in self.datasets.values() for path in dataset_file_paths(other)}
            for path in dataset_file_paths(dataset):
                if path not in retained:
                    handles.discard(path)
            # Its own reference goes with it once no other dataset uses it.
            from services.panel_genomes import prune
            prune(self)

    def first_dataset_id(self) -> Optional[str]:
        """Return the first loaded dataset id, if any."""
        for dataset_id in self.dataset_order:
            if dataset_id in self.datasets:
                return dataset_id
        return None

    def resolve_dataset_id(self, dataset_id: Optional[str] = None) -> Optional[str]:
        """Resolve missing/legacy dataset ids at API boundaries."""
        if dataset_id:
            dataset_id = str(dataset_id).strip()
        if dataset_id and dataset_id != LEGACY_PRIMARY_DATASET_ID:
            return dataset_id
        return self.first_dataset_id()
    
    def get_dataset(self, dataset_id: str) -> Dataset:
        """Get a dataset by explicit ID. Use resolve_dataset_id at API boundaries."""
        return self.datasets.get(dataset_id)
    
    def get_initial_position(self, window_size: int = 10000, dataset_ids: Optional[list] = None) -> dict:
        """Where the browser opens: a read-dense window of the loaded data, or
        else a random TSS from the GTF (None if neither is available).

        Opening on a random gene usually showed an empty view, since sequencing
        data rarely covers an arbitrary locus. `dataset_ids` limits the data to
        those datasets (the ones shown on the loaded genome; default: all).
        """
        data_position = self._initial_data_position(dataset_ids)
        if data_position:
            return data_position
        if self.gtf_data is None or len(self.gtf_data.get('transcripts', [])) == 0:
            return None
        
        tx_df = self.gtf_data['transcripts']
        
        # Filter to valid chromosomes using pre-computed normalized names
        if self.chroms:
            valid_normalized = {normalize_chrom_name(c.name) for c in self.chroms}
            if 'norm_chrom' in tx_df.columns:
                mask = tx_df['norm_chrom'].isin(valid_normalized)
            else:
                mask = tx_df['chrom'].apply(lambda c: normalize_chrom_name(c) in valid_normalized)
            tx_df = tx_df[mask]
        
        if len(tx_df) == 0:
            return None
        
        # Pick a random transcript
        tx = tx_df.sample(n=1).iloc[0]
        
        # TSS base: start on +, end - 1 on - (ends are exclusive)
        if tx['strand'] == '+':
            tss = int(tx['start'])
        else:
            tss = int(tx['end']) - 1
        
        # Center window on TSS
        half_window = window_size // 2
        start = max(0, tss - half_window)
        end = tss + half_window
        
        # Use the actual BAM chrom name if possible (via chrom_map), else the loaded
        # FASTA's name for it: an Ensembl GTF says '2L' where the FASTA (and the
        # chromosome menu) say 'chr2L' (usability round 3, R15).
        gtf_chrom = str(tx['chrom'])
        if self.chrom_map and gtf_chrom in self.chrom_map:
            actual_chrom = self.chrom_map[gtf_chrom]
        else:
            by_norm = {normalize_chrom_name(c.name): c.name for c in (self.chroms or [])}
            actual_chrom = by_norm.get(normalize_chrom_name(gtf_chrom), gtf_chrom)
        
        # Convert all values to native Python types
        gene_name = tx.get('gene_name', '') if 'gene_name' in tx.index else ''
        return {
            'chrom': actual_chrom,
            'start': int(start),
            'end': int(end),
            'gene_name': str(gene_name) if gene_name else ''
        }
    
    INITIAL_DATA_WINDOW_BP = 2000
    INITIAL_DATA_SAMPLES = 6

    def _initial_data_position(self, dataset_ids: Optional[list] = None) -> Optional[dict]:
        """Densest of a few sampled read-covered windows, cached per dataset set.

        The window is short enough that long reads span it, so the first view
        shows reads even with "full-length reads only" on.
        """
        ids = tuple(d for d in self.dataset_order if dataset_ids is None or d in set(dataset_ids))
        if not ids:
            return None
        key = self._initial_data_position_key(ids)
        cached = self.__dict__.get('_initial_data_position_cache')
        if cached and cached[0] == key:
            return cached[1]
        best = None
        try:
            from services.random_window import random_covered_window

            for seed in range(self.INITIAL_DATA_SAMPLES):
                window = random_covered_window(self, span=self.INITIAL_DATA_WINDOW_BP, seed=seed, max_attempts=10,
                                               dataset_ids=list(ids))
                if window.get('success') and (best is None or window['max_coverage'] > best['max_coverage']):
                    best = window
        except Exception as exc:  # never block startup on this
            print(f"  Warning: could not pick a read-covered start position: {exc}")
        position = None
        if best:
            position = {'chrom': best['chrom'], 'start': int(best['start']), 'end': int(best['end']), 'gene_name': ''}
        # Kept only if nothing it depends on changed meanwhile (it runs off the event loop).
        if self._initial_data_position_key(ids) == key:
            self._initial_data_position_cache = (key, position)
        return position

    def _initial_data_position_key(self, ids: tuple) -> tuple:
        """What the sampled start position depends on: the datasets (and their
        files) and the reference whose contigs and lengths bound the search."""
        datasets = getattr(self, 'datasets', {}) or {}
        files = tuple((d, tuple(getattr(datasets.get(d), 'paths', None) or ())) for d in ids)
        chroms = tuple((getattr(c, 'name', None), getattr(c, 'size', None)) for c in (getattr(self, 'chroms', None) or []))
        plasmids = tuple(sorted((getattr(self, 'plasmid_metadata', None) or {}).keys()))
        return (files, id(getattr(self, 'fasta', None)), getattr(self, 'fasta_path', None),
                getattr(self, 'current_genome', None), chroms, plasmids)

    def _detect_chroms_from_bigbed(self, bigbed_path):
        """Detect chromosomes from bigBed file(s). Accepts directory or single file."""
        from utils.validation import is_url

        # A URL (HTTP or S3) or a single file, else a directory of BigBeds.
        if is_url(bigbed_path) or os.path.isfile(bigbed_path):
            bb_files = [bigbed_path]
        elif os.path.isdir(bigbed_path):
            bb_files = [os.path.join(bigbed_path, f) for f in os.listdir(bigbed_path)
                        if f.endswith(('.bb', '.bigbed', '.bigBed'))]
        else:
            bb_files = []

        for filepath in bb_files:
            try:
                if is_url(filepath):
                    # Presigns S3 URLs; the handle stays cached for the reads.
                    from services.bigbed_handles import get_bigbed_handle

                    bw = get_bigbed_handle(filepath)
                    if bw is None:
                        continue
                    return [ChromInfo(name=k, size=v) for k, v in bw.chroms().items()]
                from services.remote_sources.opening import open_bigwig

                with open_bigwig(filepath) as bw:  # a lab server: confined
                    return [ChromInfo(name=k, size=v) for k, v in bw.chroms().items()]
            except Exception as e:
                print(f"  Warning: Failed to read chroms from {os.path.basename(filepath)}: {e}")
        if bb_files:
            print(f"  Warning: No chromosome info found in any of {len(bb_files)} BigBed files")
        return []
    
    def get_reads(self, chrom, start, end, spanning=True, dataset_id=None):
        """Get reads from a specific dataset."""
        # Translate chrom name to dataset's actual name
        chrom = self.translate_chrom(chrom)
        
        dataset_id = self.resolve_dataset_id(dataset_id)
        dataset = self.datasets.get(dataset_id) if dataset_id else None
        if not dataset:
            import pandas as pd

            return pd.DataFrame()
        from services.plasmid_reconcile import contig_links
        return dataset.get_reads(chrom, start, end, spanning, chrom_map=getattr(self, "chrom_map", None),
                                 contig_links=contig_links(self, dataset_id=dataset.id))
    
    def _chrom_size_for(self, chrom: str) -> Optional[int]:
        def chrom_entry_name(entry) -> Optional[str]:
            if isinstance(entry, dict):
                name = entry.get("name")
            else:
                name = getattr(entry, "name", None)
            return str(name) if name is not None else None

        def chrom_entry_size(entry) -> Optional[int]:
            if isinstance(entry, dict):
                size = entry.get("size") or entry.get("length")
            else:
                size = getattr(entry, "size", getattr(entry, "length", None))
            return int(size) if size else None

        for c in self.chroms or []:
            if chrom_entry_name(c) == chrom:
                return chrom_entry_size(c)
        translated = self.translate_chrom(chrom)
        for c in self.chroms or []:
            if chrom_entry_name(c) == translated:
                return chrom_entry_size(c)
        plasmids = getattr(self, "plasmid_sequences", {}) or {}
        if chrom in plasmids:
            return len(plasmids[chrom])
        if translated in plasmids:
            return len(plasmids[translated])
        return None

    @staticmethod
    def _resample_track_values(
        values: list,
        source_start: int,
        source_end: int,
        target_start: int,
        target_end: int,
        bins: int,
    ) -> list[float]:
        if bins <= 0:
            return []
        if not values or source_end <= source_start or target_end <= target_start:
            return [0.0] * bins
        cleaned: list[float] = []
        prefix: list[float] = [0.0]
        for raw in values:
            value = float(raw or 0.0)
            cleaned.append(value)
            prefix.append(prefix[-1] + value)
        source_bin = (source_end - source_start) / len(values)
        target_bin = (target_end - target_start) / bins
        result: list[float] = []
        for i in range(bins):
            bin_start = target_start + i * target_bin
            bin_end = target_start + (i + 1) * target_bin
            s_idx = max(0, int(math.floor((bin_start - source_start) / source_bin)))
            e_idx = min(len(values), int(math.ceil((bin_end - source_start) / source_bin)))
            if e_idx <= s_idx:
                idx = min(len(values) - 1, max(0, int((bin_start + bin_end) * 0.5 - source_start) // max(1, int(source_bin))))
                result.append(cleaned[idx])
                continue
            result.append((prefix[e_idx] - prefix[s_idx]) / (e_idx - s_idx))
        return result

    def _get_cached_track_region(self, track_key: tuple, chrom: str, start: int, end: int, bins: int, now: float) -> Optional[list[float]]:
        if not hasattr(self, '_track_region_cache'):
            return None
        requested_bin = (end - start) / max(1, bins)
        for key in reversed(list(self._track_region_cache.keys())):
            cached_values, cached_at = self._track_region_cache[key]
            if now - cached_at >= self._track_region_cache_timeout:
                self._track_region_cache.pop(key, None)
                continue
            path, fmt, cached_chrom, cached_start, cached_end, _cached_bins = key
            if (path, fmt) != track_key or cached_chrom != chrom:
                continue
            if cached_start > start or cached_end < end:
                continue
            cached_bin = (cached_end - cached_start) / max(1, len(cached_values))
            if cached_bin > requested_bin * 1.25:
                continue
            self._track_region_cache.move_to_end(key)
            return self._resample_track_values(cached_values, cached_start, cached_end, start, end, bins)
        return None

    def _get_padded_track_region(self, track, chrom: str, start: int, end: int, bins: int, fetcher) -> Optional[list[float]]:
        width = max(1, end - start)
        pad = max(1, width // 2)
        padded_start = max(0, start - pad)
        padded_end = end + pad
        chrom_size = self._chrom_size_for(chrom)
        if chrom_size is not None:
            padded_end = min(chrom_size, padded_end)
        if padded_end <= padded_start:
            return None

        target_bin = width / max(1, bins)
        padded_bins = max(bins, int(math.ceil((padded_end - padded_start) / max(target_bin, 1e-9))))
        if padded_bins > 6000:
            # The padded window can't be fetched at the requested resolution
            # within the bin cap: the caller fetches the requested interval
            # directly instead of upsampling coarser bins.
            return None
        padded_bins = max(1, padded_bins)
        values = fetcher(
            track,
            chrom,
            padded_start,
            padded_end,
            padded_bins,
            ucsc_signal_getter=self._get_ucsc_api_signal,
        )
        if values is None:
            return None

        now = time.time()
        key = (
            track.get("path"),
            track.get("format", "bigWig"),
            chrom,
            int(padded_start),
            int(padded_end),
            int(padded_bins),
        )
        self._track_region_cache[key] = (list(values), now)
        self._track_region_cache.move_to_end(key)
        from services.byte_cache import ByteCache
        while not isinstance(self._track_region_cache, ByteCache) and len(self._track_region_cache) > self._track_region_cache_max:
            self._track_region_cache.popitem(last=False)
        return self._resample_track_values(values, padded_start, padded_end, start, end, bins)

    def get_track_data(self, track_idx, chrom, start, end, bins=500):
        """Get signal data from an orthogonal track (bigWig, bigBed, or UCSC API)."""
        if track_idx < 0 or track_idx >= len(self.orthogonal_tracks):
            return None

        track = self.orthogonal_tracks[track_idx]
        from services.orthogonal_tracks import get_track_data as _get_track_data

        start = int(start)
        end = int(end)
        bins = int(bins or 0)
        query_segments = circular_query_segments_for_region(self, chrom, start, end)
        cache_key = (
            track.get("path"),
            track.get("format", "bigWig"),
            chrom,
            start,
            end,
            bins,
            tuple(query_segments or ()),
        )
        now = time.time()
        cached = self._track_data_cache.get(cache_key)
        if cached is not None:
            cached_values, cached_at = cached
            if now - cached_at < self._track_data_cache_timeout:
                self._track_data_cache.move_to_end(cache_key)
                return list(cached_values)
            self._track_data_cache.pop(cache_key, None)

        track_format = str(track.get("format", "bigWig")).lower()
        use_region_cache = (
            track.get("render_mode", "signal") != "annotation"
            and track_format in {"bigwig", "bw"}
            and bins > 0
            and end > start
            and query_segments is None
        )
        values = None
        if use_region_cache:
            track_key = (track.get("path"), track.get("format", "bigWig"))
            values = self._get_cached_track_region(track_key, chrom, start, end, bins, now)
            if values is None:
                values = self._get_padded_track_region(track, chrom, start, end, bins, _get_track_data)
            if values is None:
                # Padded fetch can fail when a translated chrom name overshoots
                # the real chrom size; fall back to the unpadded request so a
                # narrow viewport doesn't silently render blank.
                values = _get_track_data(
                    track,
                    chrom,
                    start,
                    end,
                    bins,
                    ucsc_signal_getter=self._get_ucsc_api_signal,
                    query_segments=query_segments,
                )
        else:
            values = _get_track_data(
                track,
                chrom,
                start,
                end,
                bins,
                ucsc_signal_getter=self._get_ucsc_api_signal,
                query_segments=query_segments,
            )
        if values is not None:
            self._track_data_cache[cache_key] = (list(values), now)
            self._track_data_cache.move_to_end(cache_key)
            from services.byte_cache import ByteCache
            while not isinstance(self._track_data_cache, ByteCache) and len(self._track_data_cache) > self._track_data_cache_max:
                self._track_data_cache.popitem(last=False)
        return values

    def _get_ucsc_api_signal(self, track, chrom, start, end, bins=500, query_segments=None):
        """Fetch data from UCSC getData API and convert to binned signal."""
        from services.orthogonal_tracks import get_ucsc_api_signal

        return get_ucsc_api_signal(
            track,
            chrom,
            start,
            end,
            bins,
            interval_fetcher=self._fetch_ucsc_api_intervals,
            query_segments=query_segments,
        )

    def _fetch_ucsc_api_intervals(self, track, chrom, start, end):
        """Fetch intervals from UCSC getData REST API with caching."""
        from services.orthogonal_tracks import fetch_ucsc_api_intervals

        return fetch_ucsc_api_intervals(
            track,
            chrom,
            start,
            end,
            cache=_ucsc_getdata_cache,
            ttl=_UCSC_GETDATA_TTL,
        )

    @staticmethod
    def _normalize_ucsc_interval(item, track_type='bed'):
        """Normalize field names across UCSC track types to {start, end, name, strand, score, blocks}."""
        from services.orthogonal_tracks import normalize_ucsc_interval

        return normalize_ucsc_interval(item, track_type)

    def get_track_annotations(self, track_idx, chrom, start, end, filter_names=None):
        """Get annotation intervals for an orthogonal track."""
        if track_idx < 0 or track_idx >= len(self.orthogonal_tracks):
            return None

        track = self.orthogonal_tracks[track_idx]
        from services.orthogonal_tracks import get_track_annotations
        from services.motifs import scan_both_strands

        return get_track_annotations(
            track,
            chrom,
            start,
            end,
            filter_names=filter_names,
            ucsc_interval_fetcher=self._fetch_ucsc_api_intervals,
            fasta=self.fasta,
            motif_scanner=scan_both_strands,
        )


def _http_fetch(*args, **kwargs):
    """A download with finite deadlines (services/http_download.fetch; tests replace it there)."""
    from services import http_download
    return http_download.fetch(*args, **kwargs)


class ReferenceIndexError(RuntimeError):
    """A cached FASTA has no index that describes it, and none can be written: the load is refused."""


_STAMP_VERSION = 2


def _fai_records(fai_path: str):
    """The index's records as (name, length, offset, bases, width) tuples; None when it is not a valid .fai."""
    try:
        records = []
        with open(fai_path, encoding="ascii") as fh:
            for line in fh:
                if not line.strip():
                    continue
                fields = line.rstrip("\r\n").split("\t")
                if len(fields) < 5 or not fields[0]:
                    return None
                records.append((fields[0], *(int(x) for x in fields[1:5])))
        return records or None
    except (OSError, ValueError, UnicodeDecodeError):
        return None


_FAIDX_CHILD = (
    "import sys, pysam\n"
    "pysam.faidx(sys.argv[1], '--fai-idx', sys.argv[2])\n"
)


def _build_index(fasta_path: str, out_fai: str) -> bool:
    """Index ``fasta_path`` into ``out_fai`` in a child process (HTSlib's faidx through pysam in a child Python,
    samtools if that fails): streaming, bounded memory, and this process's GIL stays free, so the event loop
    and other sessions keep running during a first verification of a large reference."""
    import subprocess
    import sys
    try:
        subprocess.run([sys.executable, "-c", _FAIDX_CHILD, fasta_path, out_fai],
                       check=True, capture_output=True, timeout=3600)
        if os.path.exists(out_fai):
            return True
    except Exception as exc:   # noqa: BLE001
        detail = getattr(exc, "stderr", b"") or b""
        print(f"  faidx (pysam) failed: {exc} {detail.decode('utf-8', 'replace')[-300:]}")
    from services.external_tools import tool_path
    samtools = tool_path('samtools')
    if not samtools:
        return False
    try:
        subprocess.run([samtools, 'faidx', fasta_path, '--fai-idx', out_fai],
                       check=True, capture_output=True, timeout=3600)
        return os.path.exists(out_fai)
    except Exception as exc:   # noqa: BLE001
        print(f"  samtools faidx failed: {exc}")
        return False


def _is_compressed(fasta_path: str) -> bool:
    try:
        with open(fasta_path, "rb") as fh:
            return fh.read(2) == b"\x1f\x8b"
    except OSError:
        return False


class _BuiltIndex:
    """A fresh index of a plain FASTA in a private temporary directory (never next to the FASTA).

    Only plain FASTA: the download cache always holds decompressed references (_ensure_plain_cached_fasta), and for
    a BGZF file faidx would also write a .gzi beside the source, which this verification does not cover."""

    def __init__(self, fasta_path: str):
        import tempfile
        self._dir = tempfile.mkdtemp(prefix="fb-faidx-")
        self.path = os.path.join(self._dir, "index.fai")
        self.ok = not _is_compressed(fasta_path) and _build_index(fasta_path, self.path)
        self.records = _fai_records(self.path) if self.ok else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        import shutil
        shutil.rmtree(self._dir, ignore_errors=True)


def _fai_matches_fasta(fai_path: str, fasta_path: str) -> bool:
    """True only when the .fai has exactly the records (names, lengths, offsets, line geometry) of an index
    built from this FASTA now: complete, not sampled."""
    records = _fai_records(fai_path)
    if records is None:
        return False
    with _BuiltIndex(fasta_path) as built:
        return built.records is not None and built.records == records


def _download_cache_dir() -> str:
    return os.path.realpath(os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes"))


def _in_download_cache(path: str) -> bool:
    """Stamps are trusted only for FiberBrowser's own download cache, whose files are written once (a file
    edited in place elsewhere can keep its size and times)."""
    cache = _download_cache_dir()
    real = os.path.realpath(path)
    return os.path.dirname(real) == cache


def _stamp_path(fai_path: str) -> str:
    return fai_path + ".verified"


def _fasta_identity(fasta_path: str) -> dict:
    st = os.stat(fasta_path)
    return {"fasta_device": st.st_dev, "fasta_inode": st.st_ino, "fasta_size": st.st_size,
            "fasta_mtime_ns": st.st_mtime_ns, "fasta_ctime_ns": st.st_ctime_ns}


def _stamp(fasta_path: str, fai_path: str) -> dict:
    import hashlib
    with open(fai_path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    return {"version": _STAMP_VERSION, **_fasta_identity(fasta_path), "fai_sha256": digest}


def _stamp_matches(fasta_path: str, fai_path: str) -> bool:
    import json
    try:
        with open(_stamp_path(fai_path), encoding="utf-8") as fh:
            return json.load(fh) == _stamp(fasta_path, fai_path)
    except (OSError, ValueError):
        return False


def _publish(path: str, write) -> None:
    """Write ``path`` through a unique temporary sibling and an atomic rename (two verifiers, even in two
    processes sharing the cache, never share a temporary file)."""
    import tempfile
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_stamp(fasta_path: str, fai_path: str, identity: dict) -> None:
    """Record that this FASTA/index pair was verified (download cache only; best effort: a read-only cache
    verifies on every load). Not written when the FASTA changed while it was being verified."""
    import json
    if not _in_download_cache(fasta_path):
        return
    try:
        stamp = _stamp(fasta_path, fai_path)
        if {k: stamp[k] for k in identity} != identity:
            return
        _publish(_stamp_path(fai_path), lambda fh: fh.write(json.dumps(stamp).encode("utf-8")))
    except OSError:
        pass


def ensure_verified_index(fasta_path: str) -> None:
    """Make ``fasta_path``.fai an index of exactly this (plain) FASTA, or raise ReferenceIndexError.

    In the download cache, a pair stamped as verified (FASTA device, inode, size, mtime and ctime, and the
    index's hash unchanged) is used as it is. Otherwise the FASTA is indexed afresh into a temporary file (in a
    child process): an existing index with the same records is kept and stamped; a missing or different one
    is replaced by the fresh one. When it cannot be replaced (read-only cache) the load is refused rather than
    read through a wrong index. A FASTA that changes while it is indexed is refused too."""
    fai = fasta_path + ".fai"
    if os.path.exists(fai) and _in_download_cache(fasta_path) and _stamp_matches(fasta_path, fai):
        return
    if _is_compressed(fasta_path):
        raise ReferenceIndexError(f"{fasta_path} is compressed; cached references are kept as plain FASTA.")
    before = _fasta_identity(fasta_path)
    with _BuiltIndex(fasta_path) as built:
        if built.records is None:
            raise ReferenceIndexError(f"Could not index {fasta_path} (is it a valid FASTA?).")
        if _fasta_identity(fasta_path) != before:
            raise ReferenceIndexError(f"{fasta_path} changed while it was being indexed; load the genome again.")
        existing = _fai_records(fai) if os.path.exists(fai) else None
        if existing == built.records:
            _write_stamp(fasta_path, fai, before)
            return
        if os.path.exists(fai):
            print(f"  WARNING: cached index does not match {fasta_path}; rebuilding it")
        try:
            with open(built.path, "rb") as src:
                data = src.read()
            _publish(fai, lambda fh: fh.write(data))
        except OSError as exc:
            folder = os.path.dirname(fasta_path) or "."
            if existing is not None or os.path.exists(fai):
                raise ReferenceIndexError(
                    f"The cached index {fai} does not match its FASTA and cannot be replaced ({exc}). "
                    f"Delete it, or make {folder} writable, and load the genome again.") from exc
            raise ReferenceIndexError(
                f"No index for {fasta_path} can be written ({exc}). Make {folder} writable and load the genome "
                f"again.") from exc
    _write_stamp(fasta_path, fai, before)
    print(f"  Index built: {fai}")


def _ensure_plain_cached_fasta(path: str) -> bool:
    """True when the cache file ``path`` is a usable plain FASTA. A gzip/BGZF one (an older cache, or a mirror
    that served compressed bytes under a plain name) is decompressed in place, atomically (a unique temporary
    sibling, then a rename), and its old index and stamp dropped; an HTML page or other non-FASTA is removed."""
    import gzip
    import shutil
    import tempfile
    if not os.path.exists(path):
        return False
    try:
        with open(path, 'rb') as fh:
            head = fh.read(4)
    except OSError:
        return False

    def drop_index():
        for stale in (path + '.fai', path + '.fai.verified', path + '.gzi'):
            try:
                os.remove(stale)
            except OSError:
                pass

    if head.startswith(b'\x1f\x8b'):
        print(f"  Decompressing cached FASTA: {path}")
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path) or ".",
                                            prefix=os.path.basename(path) + ".", suffix=".decompressed.tmp")
            with gzip.open(path, 'rb') as src, os.fdopen(fd, 'wb') as dst:
                shutil.copyfileobj(src, dst)
            os.replace(tmp_path, path)
            drop_index()
            return True
        except Exception as e:   # noqa: BLE001
            print(f"  WARNING: Failed to decompress cached FASTA {path}: {e}")
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
            return False
    if head.lstrip().startswith(b'<') or not head.startswith(b'>'):
        print(f"  WARNING: Removing invalid cached FASTA: {path}")
        try:
            os.remove(path)
        except OSError:
            pass
        drop_index()
        return False
    return True


def verified_cached_fasta(fasta_urls) -> Optional[str]:
    """The download cache's FASTA for these URLs with an index verified to describe it (the same lock as the
    download; a compressed cache decompressed first), or None when it is not downloaded (or was not a FASTA). Raises ReferenceIndexError when no matching index can be
    had. Every path that opens a cached registry reference goes through here or the download."""
    from services.download_locks import holding
    urls = [u for u in (fasta_urls or []) if u]
    if not urls:
        return None
    cache_dir = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
    plain = os.path.abspath(os.path.join(cache_dir, _plain_fasta_basename(urls[0])))
    with holding(f"fasta-cache:{plain}"):
        local = cached_fasta_path(cache_dir, urls)
        # A compressed cache is made plain first (the downloader's normalisation); the verifier is plain-only.
        if not os.path.isfile(local) or not _ensure_plain_cached_fasta(local):
            return None
        ensure_verified_index(local)
        return local
