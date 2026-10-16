"""Shared test fixtures for FiberBrowser tests."""

import sys
import os
from pathlib import Path

import pytest

# Tests may spawn `python browser.py`; keep the production default of opening
# the browser UI from launching a GUI during automated runs.
os.environ.setdefault("FIBERBROWSER_NO_OPEN", "1")
# Every test (and every server a test starts) checks the lock hierarchy (services/lock_order).
os.environ["FIBERBROWSER_LOCK_ORDER_CHECK"] = "1"
# Tests never read the developer's ~/.fiberhmm/browser_settings.json (it can turn
# the access token off or pick a FiberHMM source tree).
os.environ["FIBERBROWSER_SETTINGS"] = os.path.join(os.path.dirname(__file__), "__no_user_settings__.json")
os.environ.pop("FIBERBROWSER_NO_TOKEN", None)
# Nor the app's own settings (~/.fiberhmm/app_settings.json: the FiberHMM choice, update settings), and no test
# checks for updates over the network (tests of the update check mock it).
import tempfile as _tempfile
os.environ["FIBERBROWSER_APP_SETTINGS"] = os.path.join(_tempfile.mkdtemp(prefix="fiberbrowser-test-app-settings-"),
                                                       "app_settings.json")
os.environ["FIBERBROWSER_NO_UPDATE_CHECK"] = "1"
# Servers started by tests list themselves (with their access token) in a
# scratch runtime file, never the user's ~/.fiberhmm/browser_runtime.json.
if "FIBERBROWSER_RUNTIME_FILE" not in os.environ:
    import tempfile as _tempfile
    os.environ["FIBERBROWSER_RUNTIME_FILE"] = os.path.join(
        _tempfile.mkdtemp(prefix="fiberbrowser-test-runtime-"), "browser_runtime.json")
# Every dataset a test opens would be recorded in the user's Library
# (~/.fiberhmm/library.json) and a server would rescan its watched folders:
# tests use a scratch library and an empty job registry, and never scan.
if "FIBERBROWSER_LIBRARY" not in os.environ:
    import tempfile as _tempfile
    _library_dir = _tempfile.mkdtemp(prefix="fiberbrowser-test-library-")
    os.environ["FIBERBROWSER_LIBRARY"] = os.path.join(_library_dir, "library.json")
    os.environ.setdefault("FIBERBROWSER_JOBS_DIR", os.path.join(_library_dir, "jobs"))
os.environ.setdefault("FIBERBROWSER_LIBRARY_NO_STARTUP_SCAN", "1")
# The analysis preferences (ChIP-Atlas choice, pinned and custom motifs) go to a scratch file, never
# ~/.fiberhmm/analysis_preferences.json.
if "FIBERBROWSER_PREFERENCES" not in os.environ:
    import tempfile as _tempfile
    os.environ["FIBERBROWSER_PREFERENCES"] = os.path.join(_tempfile.mkdtemp(prefix="fiberbrowser-test-prefs-"), "analysis_preferences.json")
# Saved regions (the Regions panel's catalog) go to a scratch folder, never ~/.fiberhmm/regions.
if "FIBERBROWSER_REGION_CATALOG_DIR" not in os.environ:
    import tempfile as _tempfile
    os.environ["FIBERBROWSER_REGION_CATALOG_DIR"] = _tempfile.mkdtemp(prefix="fiberbrowser-test-regions-")

# TestClient requests are the owner's own browser on this computer: a loopback
# peer and a loopback Host (services/remote_access.py treats Starlette's default
# "testclient" peer and "testserver" Host as another device). Tests about other
# devices pass client=/base_url= (or headers) explicitly.
def _owner_test_clients():
    import functools
    import starlette.testclient as _tc

    original = _tc.TestClient.__init__
    if getattr(original, "_fiberbrowser_owner_defaults", False):
        return

    @functools.wraps(original)
    def __init__(self, app, base_url="http://localhost", *args, client=("127.0.0.1", 50000), **kwargs):
        original(self, app, base_url, *args, client=client, **kwargs)

    __init__._fiberbrowser_owner_defaults = True
    _tc.TestClient.__init__ = __init__


_owner_test_clients()

# Built alt alleles (services/alt_allele.py) go to a scratch folder, never ~/.fiberhmm/uploads.
if "FIBERBROWSER_ALT_ALLELE_DIR" not in os.environ:
    import tempfile as _tempfile
    os.environ["FIBERBROWSER_ALT_ALLELE_DIR"] = _tempfile.mkdtemp(prefix="fiberbrowser-test-alt-allele-")

# Add browser directory to path (same as browser.py does)
browser_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'browser')
if browser_dir not in sys.path:
    sys.path.insert(0, browser_dir)


@pytest.fixture
def capable_mac(monkeypatch):
    """Copilot lifecycle tests run as if on an Apple Silicon Mac with mlx-lm and
    room on the disk, whatever machine (Linux CI, a full laptop disk) runs them."""
    import services.copilot_lifecycle as cl
    monkeypatch.setattr(cl, "mlx_host_problem", lambda info=None: None)
    monkeypatch.setattr(cl, "mlx_import_problem", lambda: None)
    monkeypatch.setattr(cl, "free_disk_bytes", lambda path: None)
    return cl


@pytest.fixture(autouse=True)
def _restore_browser_state():
    """Each test leaves the server's state as it found it: both the server
    module's ``state`` and the runtime one (``set_browser_state``). Several
    fixtures swap in a fresh state and put back ``srv.state`` as the runtime
    value; the runtime state then outlived them, and the session-scoped
    ``loaded_app`` (integration tier) served that empty state instead of its
    own (test_workflow_api failed in a full run with the data dir set)."""
    import sys
    from state import runtime_state
    srv = sys.modules.get("server")
    saved_runtime = runtime_state._state
    saved_server = getattr(srv, "state", None) if srv is not None else None
    yield
    runtime_state._state = saved_runtime
    if srv is not None and saved_server is not None:
        srv.state = saved_server


import hardware_floor as _hardware_floor  # noqa: E402  (tests/ is on sys.path: pytest.ini)

_hardware_floor.install()  # at import, before session fixtures build any state


@pytest.fixture(autouse=True)
def _real_hardware_when_marked(request):
    """``@pytest.mark.real_hardware``: this machine's real cores/RAM (tests/hardware_floor.py)."""
    if request.node.get_closest_marker("real_hardware") is None:
        yield
        return
    _hardware_floor.REAL["on"] = True
    try:
        yield
    finally:
        _hardware_floor.REAL["on"] = False


@pytest.fixture(autouse=True)
def _tour_genome_not_on_disk(monkeypatch):
    """A new tour sandbox loads the demo's genome (hg38) when it is in
    ~/.fiberhmm/genomes. Tests don't read hg38 or depend on what this machine
    has cached; the ones about it say what is on disk (test_sandbox.py)."""
    import services.demo_data as demo_data
    monkeypatch.setattr(demo_data, "_registry_genome_on_disk", lambda genome_id: False)


@pytest.fixture(autouse=True)
def _restore_copilot_backend():
    """A test that runs Copilot setup switches the active backend (env vars and
    the planner's module global); put both back so later tests see the default."""
    saved_env = {k: v for k, v in os.environ.items() if k.startswith("FIBERBROWSER_COPILOT_")}
    planner = sys.modules.get("services.natural_language_commands")
    saved_backend = getattr(planner, "COPILOT_BACKEND", None)
    yield
    for key in [k for k in os.environ if k.startswith("FIBERBROWSER_COPILOT_")]:
        if key not in saved_env:
            del os.environ[key]
    os.environ.update(saved_env)
    if planner is not None and saved_backend is not None:
        planner.COPILOT_BACKEND = saved_backend
    else:
        # First imported during this test: back to what the environment says.
        planner = sys.modules.get("services.natural_language_commands")
        if planner is not None:
            planner.COPILOT_BACKEND = planner._autodetect_backend()


# ============================================================================
# Synthetic Data Helpers
# ============================================================================

def make_compact_read(read_id, intervals, methyl=None):
    """Create a synthetic compact read.

    Args:
        read_id: Read identifier string
        intervals: List of [start, end, size] tuples (region-relative coordinates)
                   size > 0 = footprint, size < 0 = gap, size = 0 = no tag
        methyl: Optional list of m6A positions (region-relative)

    Returns:
        Dict matching compact read format: {id, intervals, methyl?}
    """
    read = {'id': read_id, 'intervals': intervals}
    if methyl is not None:
        read['methyl'] = methyl
    return read


def make_reads_with_footprints(n, region_width, footprint_positions=None, footprint_size=50, gap_size=-150):
    """Generate n reads with predictable footprint patterns.

    Args:
        n: Number of reads to generate
        region_width: Width of the viewing region
        footprint_positions: List of (start, end) positions for footprints.
                            If None, creates one footprint at the center.
        footprint_size: Size value for footprints (positive)
        gap_size: Size value for gaps (negative)

    Returns:
        List of compact read dicts
    """
    if footprint_positions is None:
        mid = region_width // 2
        footprint_positions = [(mid - 25, mid + 25)]

    reads = []
    for i in range(n):
        intervals = []
        pos = 0
        for fp_start, fp_end in sorted(footprint_positions):
            if pos < fp_start:
                intervals.append([pos, fp_start, gap_size])
            intervals.append([fp_start, fp_end, footprint_size])
            pos = fp_end
        if pos < region_width:
            intervals.append([pos, region_width, gap_size])
        reads.append(make_compact_read(f'read_{i}', intervals))
    return reads


def make_reads_spanning_region(n, region_width):
    """Generate reads that fully span the region (single gap interval)."""
    reads = []
    for i in range(n):
        reads.append(make_compact_read(f'read_{i}', [[0, region_width, -150]]))
    return reads


def make_reads_with_nucleosomes(n, region_width, nuc_positions=None, nuc_size=150):
    """Generate reads with nucleosome-sized footprints (>=90bp).

    Args:
        n: Number of reads
        region_width: Region width
        nuc_positions: List of (start, end) for nucleosomes. If None, tiles the region.
        nuc_size: Size tag for nucleosome footprints (default 150)
    """
    if nuc_positions is None:
        nuc_positions = []
        pos = 0
        while pos + 150 <= region_width:
            nuc_positions.append((pos, pos + 150))
            pos += 200  # 150bp nuc + 50bp linker

    reads = []
    for i in range(n):
        intervals = []
        pos = 0
        for nuc_start, nuc_end in sorted(nuc_positions):
            if pos < nuc_start:
                intervals.append([pos, nuc_start, -50])  # linker gap
            intervals.append([nuc_start, nuc_end, nuc_size])
            pos = nuc_end
        if pos < region_width:
            intervals.append([pos, region_width, -50])
        reads.append(make_compact_read(f'read_{i}', intervals))
    return reads


# ============================================================================
# App Fixtures
# ============================================================================

@pytest.fixture(scope="session")
def standalone_app():
    """Create a FiberBrowser FastAPI app in standalone mode (no data files needed)."""
    import server as srv

    # Initialize state in standalone mode
    srv.state = srv.BrowserState(None, None, None, None)
    # Initialize DAF-C state (already global)
    # Initialize plugin context
    from plugins import init_context
    init_context(srv.state)

    return srv.app


def auth_headers():
    """The server's per-launch access token (services/local_auth.py) as a header."""
    from services.local_auth import auth_headers as _headers
    return _headers()


@pytest.fixture(scope="session")
def client(standalone_app):
    """Create a test client for the standalone app, carrying the access token."""
    from starlette.testclient import TestClient
    return TestClient(standalone_app, headers=auth_headers())


# ============================================================================
# Integration Test Fixtures (real data)
# ============================================================================

# The integration tier reads the lab's Drosophila data. Point
# FIBERBROWSER_TEST_DATA_DIR at a directory with the ``fly_lab_data``
# layout (or at its parent); FIBERHMM_INTEGRATION_DATA_DIR is accepted as an
# older alias. There is no machine-specific default: without it every
# integration fixture skips and says which variable to set. The tracked demo
# BAM (browser/data/demo/napa_ddda.bam) covers the default suite instead.
DATA_DIR_ENV = "FIBERBROWSER_TEST_DATA_DIR"


def _integration_data_dir():
    raw = (os.environ.get(DATA_DIR_ENV) or os.environ.get("FIBERHMM_INTEGRATION_DATA_DIR") or "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser()
    nested = root / "fly_lab_data"
    return nested if nested.is_dir() else root


INTEGRATION_DATA_DIR = _integration_data_dir()
# Unset: a path that never exists, so module-level ``.exists()`` checks skip.
DROSOPHILA_DIR = INTEGRATION_DATA_DIR or Path(__file__).parent / "__set_FIBERBROWSER_TEST_DATA_DIR__"
DAF_TIMECOURSE_DIR = DROSOPHILA_DIR / "Datasets" / "DAF-seq" / "daf_timecourse"
RECALLED_BAM_DIR = DAF_TIMECOURSE_DIR / "fp_update"
UPDATED_BIGBED_DIR = DAF_TIMECOURSE_DIR / "bigbed_update"
STANDARD_FIBER_BIGBED_DIR = DROSOPHILA_DIR / "Datasets" / "Fiber-seq" / "recall_v3seg" / "2-4"
# The current equivalents of the old per-stage files (footprints BAM, m6A BAM, footprint BigBed) for one stage:
FP_BAM = RECALLED_BAM_DIR / "stage_a_recalled.bam"                           # footprint-called DAF BAM
M6A_BAM = DAF_TIMECOURSE_DIR / "combined_bam" / "stage_a.sorted.bam"      # the same reads, no footprint tags
FP_BIGBED = UPDATED_BIGBED_DIR / "stage_a_recalled_footprint.bb"             # footprint BigBed (+ _tf/_msp companions)
RICH_DAF_BAM = RECALLED_BAM_DIR / "stage_d_recalled.bam"
STANDARD_FIBER_BIGBED = STANDARD_FIBER_BIGBED_DIR / "sample_10_nucleosome.bb"  # + _tf/_msp/_m5c companions
GTF_PATH = DROSOPHILA_DIR / "Reference" / "dm6_chr.gtf"
FASTA_PATH = DROSOPHILA_DIR / "Reference" / "dm6_chr.fa"


def data_file_available(path) -> bool:
    """A real file (Dropbox leaves 0-byte placeholders for files not downloaded)."""
    path = Path(path)
    return path.is_file() and path.stat().st_size > 0


def require_data_file(path, what: str) -> str:
    """Return ``path`` as a string, or skip saying what is missing and how to provide it."""
    if INTEGRATION_DATA_DIR is None:
        pytest.skip(f"{what}: set {DATA_DIR_ENV} to a directory with the fly_lab_data "
                    f"layout to run the integration tier")
    if not data_file_available(path):
        pytest.skip(f"{what} not found (or a 0-byte Dropbox placeholder) at {path}")
    return str(path)


# Active region in the Drosophila first-stage DAF-seq dataset (chr3R).
DROSOPHILA_CHROM = "chr3R"
DROSOPHILA_START = 6858000
DROSOPHILA_END = 6868000
DROSOPHILA_REGION_WIDTH = DROSOPHILA_END - DROSOPHILA_START

# High-signal DAF-seq region used by e2e/API parity tests.
RICH_DAF_CHROM = "chr2R"
RICH_DAF_START = 9929319
RICH_DAF_END = 10029319
RICH_DAF_CLUSTER_START = 9974319
RICH_DAF_CLUSTER_END = 9984319


@pytest.fixture(scope="session")
def real_bam_path():
    """Path to real footprint BAM file, skips if not available."""
    return require_data_file(FP_BAM, "Footprint-called DAF BAM")


@pytest.fixture(scope="session")
def real_m6a_bam_path():
    """Path to a BAM of the same reads without footprint tags, skips if not available."""
    return require_data_file(M6A_BAM, "Untagged DAF BAM")


@pytest.fixture(scope="session")
def real_bigbed_path():
    """Path to real BigBed file, skips if not available."""
    return require_data_file(FP_BIGBED, "Footprint BigBed")


@pytest.fixture(scope="session")
def rich_daf_bam_path():
    """Path to a recalled DAF BAM with explicit nuc/TF/MSP/deam layers."""
    return require_data_file(RICH_DAF_BAM, "Rich DAF BAM")


@pytest.fixture(scope="session")
def standard_fiber_bigbed_path():
    """Path to a standard Fiber-seq BigBed with companion/inferred layers."""
    return require_data_file(STANDARD_FIBER_BIGBED, "Standard Fiber BigBed")


@pytest.fixture(scope="session")
def rich_daf_region():
    """Known high-coverage DAF window with useful TF/nuc/MSP signal."""
    return {
        "chrom": RICH_DAF_CHROM,
        "start": RICH_DAF_START,
        "end": RICH_DAF_END,
        "cluster_start": RICH_DAF_CLUSTER_START,
        "cluster_end": RICH_DAF_CLUSTER_END,
    }


@pytest.fixture(scope="session")
def real_gtf_path():
    """Path to real GTF file, skips if not available."""
    return require_data_file(GTF_PATH, "GTF")


@pytest.fixture(scope="session")
def real_fasta_path():
    """Path to real FASTA file, skips if not available."""
    return require_data_file(FASTA_PATH, "FASTA")


@pytest.fixture(scope="session")
def loaded_app():
    """Create a FiberBrowser FastAPI app with BigBed + GTF + FASTA loaded."""
    require_data_file(FP_BIGBED, "Footprint BigBed")

    import server as srv

    # Initialize with BigBed
    srv.state = srv.BrowserState(str(FP_BIGBED), None, None, None)

    # Load GTF if available
    if data_file_available(GTF_PATH):
        srv.state.gtf_data = srv.load_gtf(str(GTF_PATH))
        srv.state.gtf_path = str(GTF_PATH)

    # Load FASTA if available
    if data_file_available(FASTA_PATH):
        srv.state._load_fasta(str(FASTA_PATH))

    # Initialize plugin context
    from plugins import init_context
    init_context(srv.state)

    return srv.app


@pytest.fixture(scope="session")
def loaded_client(loaded_app):
    """TestClient backed by the loaded app (BigBed + GTF + FASTA)."""
    from starlette.testclient import TestClient
    return TestClient(loaded_app, headers=auth_headers())


# (In port_list.py, so a test can import them whichever conftest module is loaded: lab_tests has its own.)
from port_list import bind_test_port, free_test_port  # noqa: E402,F401
