#!/usr/bin/env python3
"""
FiberBrowser Backend

FastAPI server that serves Fiber-seq data from BigBed files.
Renders heatmaps server-side as PNG for fast display.
"""

import os

# Single-threaded BLAS before numpy loads anywhere in this process. The FiberHMM
# consensus kernel's frozen reference was produced with OPENBLAS_NUM_THREADS=1; a
# multi-threaded pool here oversubscribes the kernel's own single-threaded workers
# (measured ~4,000x slower dot products on a 32-thread host) and changes last-ulp
# results, so run digests stop reproducing. setdefault keeps an explicit operator
# override. OMP_NUM_THREADS is deliberately left alone so Numba's parallel layer
# and the copilot subprocess are unaffected.
for _name in ('OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
    os.environ.setdefault(_name, '1')
del _name
# BLAST+ (bundled with the app, or the user's) reports usage to NCBI unless told
# not to; FiberBrowser opts out. An explicit setting is kept.
os.environ.setdefault('BLAST_USAGE_REPORT', 'false')

from contextlib import asynccontextmanager
from importlib.util import find_spec
from typing import Dict
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from services.offloop_gzip import OffloopGZipMiddleware
import pyBigWig
import uvicorn

# Resolve the FiberHMM source paired with this Browser before any service can
# accidentally import an older site-package installation. The resolver is
# path-relative and therefore works in both the macOS and Linux checkouts.
from services.fiberhmm_runtime import configure_fiberhmm_runtime
FIBERHMM_RUNTIME_ROOT = configure_fiberhmm_runtime()

HAS_COOLER = find_spec("cooler") is not None and find_spec("h5py") is not None

# ============================================================================
# REMOTE URL SUPPORT (implementations in utils/)
# ============================================================================

# Re-export from utils so routers using `server.is_url()` etc. still work
from utils.validation import (
    is_url, is_s3_url, detect_data_format, detect_path_type,
    validate_remote_url, validate_remote_bam, validate_s3_url, validate_s3_bam,
    get_remote_bam_index_url,
)
from models.domain import ChromInfo, DAFCState, JupyterState
from services.cli_args import parse_browser_args
from services.frontend_mount import mount_frontend
from services.public_mode_guard import install_public_mode_guard
from services.server_startup import (
    _check_optional_deps,
    _resolve_port,
    schedule_browser_open,
    should_open_browser,
)
from services.startup_datasets import add_cli_datasets, resolve_primary_data_source
from state.runtime_state import (
    set_browser_state,
    set_dafc_state,
    set_jupyter_state,
    set_session_manager,
)

# Cache for remote file metadata
_remote_file_cache: Dict[str, dict] = {}
LEGACY_PRIMARY_DATASET_ID = "primary"

# Compatibility wrappers historically exposed from server.py. Keep this as a
# lazy barrel so importing/running the browser does not eagerly load every
# analysis helper, but old notebooks can still use `from server import ...`.
_COMPAT_EXPORTS = frozenset({
    "GENOME_TO_JASPAR_SPECIES",
    "HAS_PYJASPAR",
    "OVERLAY_COLORS",
    "_clean_blast_name",
    "_bigbed_format_cache",
    "_detect_swapped_bed12_columns",
    "_find_annotation_bigbed_files",
    "_find_companion_bigbed_files",
    "_get_default_initial_position",
    "_get_gene_region_records",
    "_get_gene_regions",
    "_get_layer_intervals",
    "_jaspar_cache",
    "_jaspar_lock",
    "_load_annotation_manifest",
    "_load_genome_blocking",
    "_midpoint_in_regions",
    "_parse_bed_file",
    "_parse_gff3_attrs",
    "_parse_gtf_attrs",
    "_compute_fp_metrics",
    "_compute_rule_metric",
    "_reverse_complement",
    "_sort_similarity_for_dataset",
    "_check_pyjaspar",
    "build_cigar_coord_mapper",
    "build_compact_reads",
    "build_compact_reads_from_bam",
    "build_legacy_layers",
    "build_rd_fast_signed",
    "calc_nucleosome_coverage",
    "check_bam_index",
    "close_all_bam_handles",
    "close_all_bigbed_handles",
    "cluster_compact_reads",
    "cluster_reads",
    "compact_reads_to_dataframe",
    "compute_accessibility_track",
    "compute_cluster_projection",
    "compute_fire_track",
    "compute_metaprofile_from_compact_reads",
    "consensus_to_pwm",
    "detect_bigbed_autosql_sample",
    "detect_bigbed_autosql_type",
    "detect_overlay_type",
    "diagnose_bam_tags",
    "discover_annotation_types",
    "evaluate_read_states",
    "extract_cigar_events",
    "extract_features_from_compact",
    "fill_small_gaps_in_read",
    "filter_reads_covering_regions",
    "generate_msp_from_nuc_gaps",
    "get_bam_handle",
    "get_bigbed_handle",
    "get_footprints_in_gene_body",
    "get_footprints_in_region",
    "get_jaspar_db",
    "get_read_boundaries_from_bam",
    "is_annotation_bigbed",
    "join_annotations_to_reads",
    "load_annotations_from_bigbed",
    "load_fire_data",
    "load_gtf",
    "load_methyl_from_bigbed",
    "load_orthogonal_tracks",
    "load_reads_from_bam",
    "load_reads_from_bigbed",
    "meta_line_plot",
    "parse_daf_mismatches",
    "parse_homer_file",
    "parse_iupac_ry_positions",
    "parse_jaspar_file",
    "parse_ma_aq_tags_into_layers",
    "parse_meme_file",
    "parse_mm_ml_tags",
    "parse_mm_ml_tags_by_type",
    "pwm_to_pssm",
    "read_covers_regions",
    "render_reads_to_image",
    "resolve_nuc_source",
    "resolve_tf_source",
    "run_autocull_on",
    "sample_by_coverage",
    "sample_stable_by_id",
    "scan_for_peaks",
    "scan_both_strands",
    "scan_sequence",
})

_SERVER_EXPORTS = frozenset({
    "app",
    "main",
    "state",
    "PUBLIC_MODE",
    "session_manager",
    "BrowserState",
    "detect_chroms_from_bam",
    "ChromInfo",
    "DAFCState",
    "JupyterState",
    "HAS_COOLER",
    "is_url",
    "is_s3_url",
    "detect_data_format",
    "detect_path_type",
    "validate_remote_url",
    "validate_remote_bam",
    "validate_s3_url",
    "validate_s3_bam",
    "get_remote_bam_index_url",
    "_remote_file_cache",
    "LEGACY_PRIMARY_DATASET_ID",
})

_S3_EXPORTS = frozenset({
    "HAS_S3",
    "S3Manager",
    "get_s3_aware_path",
    "s3_manager",
    "setup_s3_environment",
})

__all__ = sorted(_SERVER_EXPORTS | _S3_EXPORTS | _COMPAT_EXPORTS)


def _load_cooler_modules():
    try:
        import cooler as cooler_module
        import h5py as h5py_module
    except ImportError:
        return None, None
    return cooler_module, h5py_module


def _load_s3_exports():
    try:
        from s3_utils import s3_manager as manager
        from s3_utils import S3Manager, get_s3_aware_path, setup_s3_environment
    except ImportError:
        return {
            "HAS_S3": False,
            "S3Manager": None,
            "get_s3_aware_path": None,
            "s3_manager": None,
            "setup_s3_environment": None,
        }
    return {
        "HAS_S3": manager.is_available,
        "S3Manager": S3Manager,
        "get_s3_aware_path": get_s3_aware_path,
        "s3_manager": manager,
        "setup_s3_environment": setup_s3_environment,
    }


def __getattr__(name: str):
    if name in _COMPAT_EXPORTS:
        import server_compat

        value = getattr(server_compat, name)
        globals()[name] = value
        return value
    if name in _S3_EXPORTS:
        globals().update(_load_s3_exports())
        return globals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(set(globals()) | _COMPAT_EXPORTS)

# BrowserState implementation lives outside server.py; re-export here for
# compatibility with existing tests/scripts that still import server.BrowserState.
from state.browser_state import BrowserState, detect_chroms_from_bam


state: BrowserState = None
PUBLIC_MODE = False
# Per-session state manager. Constructed in main() after the template state
# is built. In non-public mode stays None so get_state() always returns the
# template (single-user behavior, zero overhead).
session_manager = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Prune stale uploads; kick off the idle-session GC task in public mode."""
    from services.server_startup import raise_file_limit
    raise_file_limit()
    from services.upload_store import startup_upload_maintenance
    startup_upload_maintenance(state, dafc_state)
    if session_manager is not None and session_manager.enabled:
        session_manager.start_gc()
        print(f"  [session-gc] started (ttl={session_manager.idle_ttl}s, "
              f"interval={session_manager.gc_interval}s)")
    from state.sandbox import get_sandbox_manager
    from state.workspace import get_workspace_manager
    from services.lab.members import get_member_manager
    tab_managers = [m for m in (get_sandbox_manager(), get_workspace_manager(), get_member_manager())
                    if m is not None]
    for manager in tab_managers:
        manager.start_gc()
    yield
    for manager in tab_managers:
        manager.stop_gc()
    from services.file_handles import handles
    handles.discard()
    # Cluster connections: stop the remote helpers and local forwards (a
    # ControlMaster FiberBrowser opened lives on until its ControlPersist).
    from services.remote_endpoint import shutdown_remote_sources
    shutdown_remote_sources()
    from services.local_auth import forget_recorded_server
    forget_recorded_server()
    # A normal quit: the next launch offers to reopen this session (services/launch_state.py).
    from services.launch_state import record_clean_exit
    record_clean_exit()


class _NanSafeJSONResponse(JSONResponse):
    """JSONResponse that survives NaN/Inf in floats by emitting them as null.

    NumPy means/scores frequently produce NaN/Inf for empty bins or undefined
    log-ratios. Python's default json.dumps raises ValueError on those values,
    which 500s the request. Setting allow_nan=True (the default for stdlib
    json) is the obvious fix, but FastAPI's renderer disables it; we restore
    it here and round-trip through a sentinel so the wire stays standard JSON
    (NaN/Infinity → null).
    """
    def render(self, content):
        import math
        def _clean(value):
            if isinstance(value, float):
                return None if (math.isnan(value) or math.isinf(value)) else value
            if isinstance(value, dict):
                return {k: _clean(v) for k, v in value.items()}
            if isinstance(value, (list, tuple)):
                return [_clean(v) for v in value]
            return value
        return super().render(_clean(content))


app = FastAPI(title="FiberBrowser API", lifespan=lifespan, default_response_class=_NanSafeJSONResponse)

from services.validation_errors import install_validation_error_handler

# A 422 also says which field was wrong in one readable line ("message").
install_validation_error_handler(app)

from services.remote_sources.base import RemoteReadError as _RemoteReadError


from services.lift.capability import LiveLiftUnsupported as _LiveLiftUnsupported
from services.lift.live_lift import LiftRefused as _LiftRefused
from services.lift.registration import LiveLiftDisabled as _LiveLiftDisabled


@app.exception_handler(_LiveLiftUnsupported)
async def _live_lift_unsupported(_request, exc):
    """An analysis that does not support live-lift datasets (services/lift/capability.py): 409 and one notice."""
    return _NanSafeJSONResponse({"detail": str(exc), "error": str(exc), "notice": str(exc),
                                 "live_lift_unsupported": exc.feature}, status_code=409)


@app.exception_handler(_LiftRefused)
async def _live_lift_refused(_request, exc):
    """A lifted view that cannot be served whole (too many source windows or bp: zoom in)."""
    return _NanSafeJSONResponse({"detail": str(exc), "error": str(exc), "notice": str(exc)}, status_code=exc.status)


@app.exception_handler(_LiveLiftDisabled)
async def _live_lift_disabled(_request, exc):
    return _NanSafeJSONResponse({"detail": str(exc), "error": str(exc)}, status_code=404)


@app.exception_handler(_RemoteReadError)
async def _remote_read_error(_request, exc):
    """A remote file's connection broke mid-read: 502 with the reason (the
    browser shows it), never a bare 500."""
    return _NanSafeJSONResponse({"detail": str(exc), "error": str(exc)}, status_code=502)

from services.wsl_interop import install_windows_path_translation

# Innermost, in WSL only (the Windows app): Windows paths sent anywhere a path
# is accepted (C:\..., \\wsl.localhost\...) reach the endpoints as WSL paths.
install_windows_path_translation(app)
from services.request_origin_guard import allowed_hosts_for_bind, install_request_origin_guard, set_allowed_hosts

install_request_origin_guard(app)
from state.dependencies import install_session_cookie_middleware

install_session_cookie_middleware(app)
from services.signal_evidence import SignalFilterMiddleware
app.add_middleware(SignalFilterMiddleware)
from services.public_redaction import install_public_redaction, install_security_headers
from services.runtime import get_host_public_mode

# Inside gzip: rewrites uncompressed JSON (no host paths on a public server).
from services.runtime import get_visitor_public_mode

install_public_redaction(app, get_visitor_public_mode)
from services.signed_urls import install_log_redaction, install_signed_url_redaction

# Inside gzip too: pre-signed URLs (session links) leave as their display form.
install_signed_url_redaction(app)
install_log_redaction()
from services.request_log import install_request_log

# Innermost: a stuck, slow or failing handler leaves a timestamped line in the
# output (the app's server log), without the query string.
install_request_log(app)
# Starlette's GZipMiddleware compressed every body on the event loop, at
# level 9 (63 ms per MB of read JSON; a 50 kb view of 1,000 reads is ~1 MB
# per panel): most of the loop's busy time while browsing. Large bodies are
# now compressed in a worker thread, at level 6 (27 ms per MB, 2% larger).
GZIP_COMPRESSLEVEL = 6
app.add_middleware(OffloopGZipMiddleware, minimum_size=1000, compresslevel=GZIP_COMPRESSLEVEL,
                   # A 9 MB read response takes ~260 ms at level 6, ~41 ms at
                   # level 1. The extra 0.5 MB is cheap across desktop loopback.
                   # Remote requests retain level 6, including desktop shares.
                   loopback_compresslevel=1 if os.environ.get("FIBERBROWSER_EXIT_WITH_PARENT") else None)

from services.runtime import get_public_mode

install_public_mode_guard(app, get_public_mode)
from services.remote_access import install_remote_access_guard

# A personal server: requests from other devices (or through a proxy on this
# computer) get the read-only route set; the owner's direct requests get all.
# Inside local_auth, so a request without the token still gets its 401.
install_remote_access_guard(app)
from services.public_limits import install_public_request_limits

from services.lab.limits import request_limits_apply

# --public visitors, a lab server's anonymous catalog visitors, and lab
# members when the lab config sets [limits] max_span_bp / max_reads.
install_public_request_limits(app, request_limits_apply)
from state.sandbox import install_sandbox_middleware, set_sandbox_manager

# After the public-mode guard (so outermost): a sandbox (tour tab) request is
# marked before the guard runs, and the guard treats it as a public visitor.
# The same middleware runs an independent workspace's requests in it.
install_sandbox_middleware(app)
from services.lab.auth import install_lab_auth

# A lab server (profile "lab"): who the member is, or an anonymous catalog
# visitor (public-mode rules), before the sandbox and public-mode checks run.
install_lab_auth(app)
from services.local_auth import install_local_auth

# Outside the sandbox/workspace middleware: every request of a local server
# proves it comes from the owner (per-launch token, see services/local_auth.py).
install_local_auth(app, get_host_public_mode)
from services.public_protection import install_public_protection

# --public: rate limits, analysis slots, body limits, generic errors
# (services/public_protection.py); inside the security headers so its
# refusals carry them too.
install_public_protection(app, get_host_public_mode)
# Outermost: every response, the guards' refusals included, gets them.
install_security_headers(app, get_host_public_mode)
from services.client_disconnect import RawReceiveMiddleware

# Outside the @app.middleware("http") layers: a long route (read-name lookup)
# can notice its client going away (services/client_disconnect.py).
app.add_middleware(RawReceiveMiddleware)
from services.root_path import install_root_path

# Outermost of all: a proxy that forwards its URL prefix (server.root_path)
# has it removed before any other middleware sees the path.
install_root_path(app)

from routers.registry import register_api_routers, set_catalog

register_api_routers(app)


# Primer Design endpoints extracted to routers/primers.py

jupyter_state = JupyterState()


# ============================================================================
# DAF-C STATE
# ============================================================================

dafc_state = DAFCState()


# Jupyter CRUD endpoints extracted to routers/jupyter.py


def main():
    from services.server_startup import raise_file_limit
    raise_file_limit()
    args = parse_browser_args()
    from services.gc_tuning import configure_gc
    configure_gc()  # read caches: keep full GC pauses rare (services/gc_tuning.py)
    import sys as _sys

    # fiberbrowser serve --config fiberbrowser-server.toml (services/server_config.py);
    # flags given on the command line win over the file.
    server_config = None
    config_path = getattr(args, "config", None) or os.environ.get("FIBERBROWSER_CONFIG")
    if config_path:
        from services.server_config import (ConfigError, apply_to_args, describe, load_config,
                                            prepare_state_dir, state_environment)
        try:
            server_config = load_config(config_path)
            apply_to_args(server_config, args, _sys.argv[1:])
            os.environ.update(state_environment(server_config))
            prepare_state_dir(server_config)
        except (ConfigError, OSError) as exc:
            print(f"FiberBrowser: {exc}", file=_sys.stderr)
            raise SystemExit(2) from exc
        for line in describe(server_config):
            print(f"  {line}")
    from services.root_path import get_root_path, set_root_path
    set_root_path(getattr(args, "root_path", None))
    LAB_MODE = server_config is not None and server_config.is_lab
    from services import lab as lab_profile
    lab_profile.configure(server_config if LAB_MODE else None)
    if LAB_MODE:
        from services.lab.limits import configure_lab_limits
        configure_lab_limits(server_config)
    # One list of trusted reverse proxies for every profile: --trusted-proxy and
    # the config file's auth.trusted_proxies (services/public_protection.py).
    if getattr(args, "trusted_proxy", None):
        from services.public_protection import configure_trusted_proxies
        configure_trusted_proxies(args.trusted_proxy)

    # Public mode — disable mutation endpoints for review deployments
    global PUBLIC_MODE
    from services.runtime import set_public_mode
    PUBLIC_MODE = bool(args.public)
    set_public_mode(PUBLIC_MODE)
    if args.catalog:
        # Catalog on its own just loads the JSON — users on their own
        # workstation keep full edit/upload/session-management ability.
        # The read-only lock-down (endpoint blocking + per-session
        # isolation) is behind the separate `--public` flag, which
        # catalog + public-deployment authors opt into explicitly.
        import json as _json
        with open(args.catalog) as _f:
            catalog = _json.load(_f)
        set_catalog(catalog, base_dir=os.path.dirname(os.path.abspath(args.catalog)))
        print(f"  Catalog: {args.catalog} ({len(catalog.get('groups', []))} groups)")
        if catalog.get('genome') and not args.fasta:
            print(f"  Catalog genome: {catalog['genome']} (will auto-load on first visit)")
        if catalog.get('tracks'):
            print(f"  Catalog tracks: {len(catalog['tracks'])} reference BigWig/BigBed files")
    if PUBLIC_MODE:
        print("  Public mode: session isolation + read-only endpoint gating enabled")
        from services.public_limits import apply_public_cli
        from services.public_protection import remove_api_docs
        limits = apply_public_cli(args)
        remove_api_docs(app)
        print(f"  Public limits: reads within {limits.max_span_bp:,} bp, max_reads {limits.max_reads:,}, "
              f"working set {args.max_working_reads:,} reads; footprint classes <= "
              f"{limits.consensus_region_bp:,} bp on {limits.consensus_cores} core(s), "
              f"{limits.consensus_queue} run(s) at once")

    # Local-only unless asked: the API can browse and read files on this machine.
    host = getattr(args, "host", None) or ("0.0.0.0" if PUBLIC_MODE else "127.0.0.1")
    # Per-launch access token (services/local_auth.py). Public visitors are
    # anonymous by design, so a --public server needs none. A personal server
    # never listens on the network with it off (services/remote_access.py).
    from services.remote_access import bind_is_loopback, bind_refusal, personal_token_required
    token_required, token_note = personal_token_required(host, no_token_flag=bool(getattr(args, "no_token", False)))
    if PUBLIC_MODE:
        token_required = False
    elif token_note and not LAB_MODE:
        print(f"  {token_note}")
    if LAB_MODE:
        # Members sign in instead; with auth = "none" (behind OnDemand) the
        # launch token keeps other users of the cluster out.
        auth = server_config.auth
        token_required = auth.mode == "none" and auth.access_token is not False \
            and not getattr(args, "no_token", False)
    refusal = bind_refusal(host, token_required=token_required, public_mode=PUBLIC_MODE, lab_mode=LAB_MODE)
    if refusal:
        print(refusal, file=_sys.stderr)
        raise SystemExit(2)

    # Check port availability before doing expensive setup
    args.port = _resolve_port(args.port, force_port=getattr(args, 'force_port', False), host=host)

    # Tell the headless Playwright render worker which URL is our own. The
    # worker reads this env var when navigating to inject state + screenshot.
    os.environ.setdefault(
        "FIBERBROWSER_RENDER_SELF_URL",
        f"http://127.0.0.1:{args.port}",
    )

    # Copilot lifecycle (auto-download + auto-launch mlx_lm.server) before any
    # request is served. Reads --copilot/--copilot-model/--copilot-port flags
    # and sets the FIBERBROWSER_COPILOT_* env vars the planner picks up.
    from services.copilot_lifecycle import setup_copilot_safely
    from services.runtime import apply_copilot_inclusion
    if PUBLIC_MODE:
        # A local LLM is the host's own compute; never offered to visitors.
        args.copilot = "off"
    # FiberBrowser.app (--no-copilot / FIBERBROWSER_COPILOT=off) leaves the
    # Copilot out: its backend is off, so nothing is checked, downloaded or
    # started, and no hint is printed about installing its packages.
    apply_copilot_inclusion(args)
    setup_copilot_safely(args)

    # Check optional dependencies and inform the user
    _check_optional_deps()
    # Which FiberHMM footprint classes, chemistry detection and BAM export
    # will use (warns when it is missing or older than 3.0).
    from services.fiberhmm_runtime import log_fiberhmm_runtime
    log_fiberhmm_runtime()

    global state, dafc_state, session_manager
    
    data_source = resolve_primary_data_source(args.bam, args.bigbed_dir)
    from services.startup_datasets import split_remote_primary
    data_source, remote_primary = split_remote_primary(data_source)
    cli_datasets = [*remote_primary, *(args.dataset or [])]

    # Standalone mode - no data required at startup
    if args.standalone or (data_source is None and not cli_datasets):
        print("\n=== FiberHMM Browser ===")
        print("No data loaded. Use 'Add Dataset' buttons to load data.")
        print("  Supported formats: BigBed files/folders, BAM files with ns/nl tags")
        state = BrowserState(None, args.gtf, args.fire, args.tracks, max_working_reads=args.max_working_reads, fasta_path=args.fasta)
    else:
        # Initialize with primary data source (or None if using --dataset)
        state = BrowserState(data_source, args.gtf, args.fire, args.tracks, max_working_reads=args.max_working_reads, fasta_path=args.fasta)
        
        add_cli_datasets(state, cli_datasets)
        
        print(f"\nFiberHMM Browser")
        if args.bam and not remote_primary:
            if isinstance(data_source, list):
                print(f"  BAM files: {len(data_source)} combined")
                for p in data_source:
                    print(f"    - {p}")
            elif args.bam.endswith(('.bb', '.bigbed', '.bigBed')):
                print(f"  BigBed: {args.bam}")
            else:
                print(f"  BAM: {args.bam}")
        elif args.bigbed_dir:
            print(f"  BigBed dir: {args.bigbed_dir}")
        if args.gtf:
            print(f"  GTF: {args.gtf}")
        if args.fire:
            print(f"  FIRE: {args.fire}")
        if args.tracks:
            print(f"  Tracks: {len(state.orthogonal_tracks)} loaded")
        print(f"  Chroms: {[c.name for c in state.chroms[:5]]}...")
    
    # Load DAF-C data if provided
    if args.cool and HAS_COOLER:
        try:
            cooler_module, h5py_module = _load_cooler_modules()
            if cooler_module is None or h5py_module is None:
                raise ImportError("cooler or h5py not installed")

            from services.cooler_open import mcool_resolutions, open_cooler
            is_mcool = args.cool.endswith('.mcool')
            if is_mcool:
                dafc_state.resolutions = mcool_resolutions(args.cool, h5py_module)
                res = dafc_state.resolutions[-1]
                dafc_state.clr = open_cooler(cooler_module, args.cool, res, h5py_module)
                dafc_state.current_resolution = res
            else:
                dafc_state.clr = open_cooler(cooler_module, args.cool, None, h5py_module)
                dafc_state.resolutions = [int(dafc_state.clr.binsize)]
                dafc_state.current_resolution = dafc_state.resolutions[0]
            
            dafc_state.cool_file = args.cool
            dafc_state.chroms = [
                ChromInfo(name=n, size=int(s)) 
                for n, s in dafc_state.clr.chromsizes.items()
            ]
            print(f"  DAF-C Cool: {args.cool}")
            print(f"  DAF-C Resolution: {dafc_state.current_resolution:,} bp")
            print(f"  DAF-C Resolutions: {dafc_state.resolutions}")
            
            # Use main bigbed for DAF-C if no separate one specified
            dafc_bb = args.dafc_bigbed or args.bam
            if dafc_bb and dafc_bb.endswith(('.bb', '.bigbed', '.bigBed')):
                dafc_state.bigbed_file = dafc_bb
                from services.bigbed_handles import get_bigbed_handle
                dafc_state.bb = get_bigbed_handle(dafc_bb)
                print(f"  DAF-C BigBed: {dafc_bb}")
        except Exception as e:
            print(f"  Warning: Failed to load DAF-C data: {e}")
    elif args.cool and not HAS_COOLER:
        print(f"  Warning: --cool specified but cooler not installed")
    
    # Set runtime config from command line
    if args.prefetch != 10 and state.performance['effective'] != 'low':
        state.config['prefetch_multiplier'] = args.prefetch
        state.performance['prefetch_multiplier'] = args.prefetch
    if args.prefetch != 10:  # Only show if non-default
        print(f"  Prefetch: {state.config['prefetch_multiplier']}x viewport")
    if args.max_working_reads > 0:
        print(f"  Max working reads: {args.max_working_reads:,} per viewport (backend-wide cap)")
    set_browser_state(state)
    set_dafc_state(dafc_state)
    set_jupyter_state(jupyter_state)

    # Catalog tracks are loaded on-demand via /api/catalog/tracks/load, not at startup.

    # Per-session state manager. Enabled only in public mode: each HTTP client
    # gets its own forked BrowserState at first request, template is the
    # object we've just built. Non-public runs keep the single-state singleton.
    from state.session_manager import SessionManager
    # Lab servers: anonymous visitors of the public catalog get these sessions;
    # members get their own states (services/lab/members.py).
    session_manager = SessionManager(template=state, enabled=PUBLIC_MODE or (
        LAB_MODE and server_config.public_catalog.enabled))
    set_session_manager(session_manager)
    if LAB_MODE:
        from services.lab.members import MemberStateManager, set_member_manager
        set_member_manager(MemberStateManager(template=state, max_members=server_config.limits.max_users))
    if PUBLIC_MODE:
        print(f"  Session isolation: ON (idle TTL {session_manager.idle_ttl}s)")
    else:
        # Tour tabs: separate sessions that can never change this one.
        from state.sandbox import SandboxManager
        set_sandbox_manager(SandboxManager(template=state))
        # Independent workspaces (/?workspace=new): more isolated sessions
        # from this one launch, sharing its loaded reference.
        from state.workspace import WorkspaceManager, set_workspace_manager
        set_workspace_manager(WorkspaceManager(template=state))
        # The Library rescans the user's watched folders once, in the background.
        from services.library_scan import start_startup_scan
        start_startup_scan()

    # Initialize plugin system
    from plugins import init_context, get_registered_plugins
    from plugins.loader import load_plugins
    init_context(state)

    # Load external plugins from --plugin and --plugin-dir
    plugin_paths = list(args.plugin or [])
    if args.plugin_dir:
        plugin_paths.append(args.plugin_dir)
    if plugin_paths:
        load_plugins(plugin_paths)

    # Mount all plugin routers (builtin + external)
    for name, router in get_registered_plugins().items():
        app.include_router(router, prefix=f"/api/plugins/{name}")

    script_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = mount_frontend(app, script_dir, PUBLIC_MODE)
    if frontend_dir:
        print(f"  Frontend: {frontend_dir}")
    else:
        print("  WARNING: No frontend build found - API only mode")
        print("  Run 'cd browser/frontend && npm install && npm run build'")
    
    local_url = f"http://localhost:{args.port}{get_root_path()}"
    # token_required: decided with the bind, before the port check (above).
    from services.local_auth import configure_local_auth, record_running_server, tokened_url
    configure_local_auth(enabled=token_required, port=args.port)
    open_url = tokened_url(local_url + "/") if token_required else local_url
    auto_open = bool(frontend_dir) and should_open_browser(args)
    if auto_open:
        schedule_browser_open(open_url)

    if PUBLIC_MODE:
        print(f"\n  === PUBLIC MODE ===")
        print(f"  Mutation endpoints disabled (file upload, primer design, session save, shutdown).")
        print(f"  Datasets are read-only from CLI-loaded files. Each visitor gets independent state.")
    if LAB_MODE and token_required:
        # Behind Open OnDemand: the token is the session password, which the
        # portal's Connect button hands over; it never goes to the job's log.
        print(f"\n  Serving {local_url}/ (open it with the portal's Connect button; "
              "the access token is in FIBERBROWSER_TOKEN)")
    else:
        print(f"\n  Open {open_url} in your browser")
    if LAB_MODE and token_required:
        pass
    elif token_required:
        print("  (the link carries this launch's access token; scripts and browser_client find it in "
              "~/.fiberhmm/browser_runtime.json)")
        print(f"  Another independent workspace: {local_url}/?workspace=new (from a browser that opened the link)")
    elif LAB_MODE:
        print(f"  Lab server: members sign in ({server_config.auth.mode}); "
              f"admins manage accounts with `fiberbrowser users ... --config {server_config.source}`.")
    elif not PUBLIC_MODE:
        print("  WARNING: access token off (--no-token, FIBERBROWSER_NO_TOKEN or require_token=false in "
              "~/.fiberhmm/browser_settings.json): any program or user that can reach this port can use it.")
    if auto_open:
        print("  Opening your default web browser...")
    elif frontend_dir and not PUBLIC_MODE:
        print("  Auto-open disabled; pass --open-browser to force it.")
    print("  Press Ctrl+C to stop\n")
    
    # Store port so drop_window endpoint can use it
    state.port = args.port
    
    if LAB_MODE:
        from services.lab.audit import audit
        audit("server_start", host=host, port=args.port, auth=server_config.auth.mode,
              root_path=get_root_path() or "/", jobs=server_config.jobs.enabled)
    set_allowed_hosts(allowed_hosts_for_bind(host))
    if not bind_is_loopback(host):
        who = ("signed-in lab members" if LAB_MODE and not token_required else
               "whoever has the access token" if token_required else "other machines on the network")
        print(f"  Listening on {host}:{args.port}: {who} can use this browser.")
        if not (PUBLIC_MODE or LAB_MODE):
            print("  Other devices get a read-only view (no files, jobs, settings or shutdown); "
                  "the full app is for browsers on this computer.")
    if not PUBLIC_MODE and (not LAB_MODE or token_required):
        import atexit
        from services.local_auth import forget_recorded_server
        try:
            record_running_server(args.port, open_url, host=host)
            atexit.register(forget_recorded_server)
        except OSError as exc:
            print(f"  Warning: could not write ~/.fiberhmm/browser_runtime.json: {exc}")
        if not LAB_MODE:
            # How the last run on this port ended: the page offers to reopen
            # its session after a normal quit, crash recovery after a crash.
            from services.launch_state import record_clean_exit, record_launch
            record_launch(args.port)
            atexit.register(record_clean_exit)
    # Public and lab servers read X-Forwarded-For themselves, from their trusted
    # proxies only (services/public_protection.py); uvicorn's own rewrite would
    # trust loopback, and would hide the proxy from the lab's proxy sign-in.
    uvicorn.run(app, host=host, port=args.port, log_level="warning",
                proxy_headers=not (PUBLIC_MODE or LAB_MODE))


if __name__ == "__main__":
    main()
