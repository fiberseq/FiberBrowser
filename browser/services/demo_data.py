"""The bundled demo datasets the guided tour runs on (browser/data/demo).

The tour's main demo is the NAPA DddA-seq amplicon (``DEMO``, the default of
every function here, so callers that know only one demo keep working). The
Variants section of the tour loads a second one, an H1 PacBio Fiber-seq region
around a heterozygous insertion (``"sv"``)."""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Optional

DEMO_DIR = Path(__file__).resolve().parents[1] / "data" / "demo"

DEFAULT_DEMO = "napa"

# Every bundled demo, by id. Each is a BAM (with its index) in DEMO_DIR, on a
# registry genome, with the region the tour opens it at.
DEMOS: dict[str, dict[str, Any]] = {
    # NAPA promoter region, DddA-seq (DAF) reads on hg38.
    "napa": {
        "file": "napa_ddda.bam",
        "label": "NAPA demo (DddA-seq)",
        "genome": "hg38",
        "region": {"chrom": "chr19", "start": 47_514_000, "end": 47_518_000},
    },
    # H1 PacBio Fiber-seq (Hia5, FiberHMM 3.0 calls, HP-tagged) around a
    # heterozygous +7,471 bp insertion at chr1:23,277,272 whose inserted
    # sequence carries a nucleosome-free region with a central CTCF footprint.
    "sv": {
        "file": "h1_chr1_insertion.bam",
        "label": "H1 insertion demo (Fiber-seq)",
        "genome": "hg38",
        "region": {"chrom": "chr1", "start": 23_273_500, "end": 23_281_000},
        "insertion": {"chrom": "chr1", "ref": 23_277_272, "len": 7_471},
    },
}

# The default demo (kept under its old name for the callers that use it).
DEMO = DEMOS[DEFAULT_DEMO]


def demo_spec(demo_id: Optional[str] = None) -> dict[str, Any]:
    """The demo's definition; KeyError for an unknown id."""
    return DEMOS[demo_id or DEFAULT_DEMO]


def demo_genomes() -> set[str]:
    """The genomes the demos are on (a tour tab may load these)."""
    return {spec["genome"] for spec in DEMOS.values()}


def demo_path(demo_id: Optional[str] = None) -> Path:
    return DEMO_DIR / demo_spec(demo_id)["file"]


def _loaded_demo_id(state, demo_id: Optional[str] = None) -> Optional[str]:
    path = str(demo_path(demo_id))
    for dataset_id, dataset in (getattr(state, "datasets", {}) or {}).items():
        if path in [str(Path(p).resolve()) for p in (getattr(dataset, "paths", None) or [])]:
            return dataset_id
    return None


def is_bundled_demo_dataset(state, dataset_id: Optional[str]) -> bool:
    """The dataset is one of the bundled demos (every file of it in DEMO_DIR)."""
    if not dataset_id:
        return False
    try:
        from services.query_params import resolve_dataset_id
        dataset = state.get_dataset(resolve_dataset_id(state, dataset_id))
    except Exception:
        return False
    paths = [str(p) for p in (getattr(dataset, "paths", None) or [getattr(dataset, "path", None)]) if p]
    demo_dir = DEMO_DIR.resolve()
    demo_files = {str((DEMO_DIR / spec["file"]).resolve()) for spec in DEMOS.values()}
    return bool(paths) and all("://" not in p and Path(p).resolve().parent == demo_dir
                               and str(Path(p).resolve()) in demo_files for p in paths)


def _demo_entry(state, demo_id: str, public: bool) -> dict[str, Any]:
    spec = DEMOS[demo_id]
    entry = {
        "id": demo_id,
        "available": demo_path(demo_id).exists() and not public,
        "label": spec["label"],
        "genome": spec["genome"],
        "region": spec["region"],
        "dataset_id": _loaded_demo_id(state, demo_id),
    }
    if spec.get("insertion"):
        entry["insertion"] = spec["insertion"]
    return entry


def demo_info(state, demo_id: Optional[str] = None) -> dict[str, Any]:
    """Whether the demo can be loaded here, and its dataset id if it is (the
    default demo's, unless ``demo_id`` names another), with every demo listed
    under ``demos``."""
    from services.runtime import get_host_public_mode
    public = get_host_public_mode()
    entry = _demo_entry(state, demo_id or DEFAULT_DEMO, public)
    entry["demos"] = [_demo_entry(state, key, public) for key in DEMOS]
    return entry


def _registry_genome_on_disk(genome_id: str) -> bool:
    """The genome's sequence (with its index) and annotation are in the local
    cache, so loading it needs no download."""
    try:
        from services.genome_registry import GENOME_REGISTRY
        from state.browser_state import cached_fasta_path
        info = GENOME_REGISTRY[genome_id]
    except Exception:
        return False
    cache = os.path.join(os.path.expanduser("~"), ".fiberhmm", "genomes")
    urls = list(info.get("fasta_urls") or ([info["fasta_url"]] if info.get("fasta_url") else []))
    if urls:
        fasta = cached_fasta_path(cache, urls)
        if not (os.path.exists(fasta) and os.path.exists(fasta + ".fai")):
            return False
    if info.get("gtf_url") and not os.path.exists(os.path.join(cache, f"{genome_id}.gtf")):
        return False
    return bool(urls or info.get("gtf_url"))


def _clear_reference(state) -> None:
    from services.genome_loading import state_lock
    with state_lock(state):
        _clear_reference_locked(state)


def _clear_reference_locked(state) -> None:
    """No reference at all (a sandbox's copy-on-write fields only)."""
    from services.genome_loading import _close_fasta
    _close_fasta(state)
    state.chroms = []
    state.chrom_map = {}
    state.gtf_data = None
    state.gtf_path = None
    state.current_genome = None
    state.circular_chroms = {}
    state.reference_pairs = None
    state.plasmid_sequences = {}
    state.plasmid_metadata = {}


def ensure_demo_reference(state, *, sandbox: Optional[bool] = None,
                          demo_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    """In a tour tab, the demo is shown on its own genome, whatever the main
    tab has loaded (the sandbox owns copies of the reference, so this never
    changes the user's). The genome loads from the local cache only; when it
    isn't on this computer, the tab gets no reference rather than another
    genome's (no mismatch banner, no wrong chromosome list). None when nothing
    changed, else what the tab's reference now is. ``sandbox``: whether
    ``state`` is a sandbox's (default: the current request's); ``demo_id``:
    which demo (default: the tour's main one)."""
    if sandbox is None:
        from services.runtime import current_sandbox_id
        sandbox = current_sandbox_id() is not None
    if not sandbox:
        return None
    want = demo_spec(demo_id)["genome"]
    has_reference = getattr(state, "fasta", None) is not None or bool(getattr(state, "chroms", None))
    if getattr(state, "current_genome", None) == want and has_reference:
        return None
    if _registry_genome_on_disk(want):
        from services.genome_loading import load_genome_blocking
        from services.genome_registry import GENOME_REGISTRY
        try:
            result = load_genome_blocking(state, want, GENOME_REGISTRY[want])
        except Exception as exc:  # the tour still runs, on no reference
            result = {"success": False, "error": str(exc)}
        if result.get("success"):
            return {"genome": want, "has_fasta": getattr(state, "fasta", None) is not None}
    if not has_reference and getattr(state, "current_genome", None) is None:
        return None
    _clear_reference(state)
    return {"genome": None, "has_fasta": False}


from services.lock_order import OPERATION as _OPERATION, OrderedLock as _OrderedLock
_DEMO_LOCK = _OrderedLock(_OPERATION, "demo_data._DEMO_LOCK")  # level 0 (services/lock_order)


def load_demo(state, demo_id: Optional[str] = None) -> dict[str, Any]:
    """Load a demo dataset (once; the default demo unless ``demo_id`` names
    another); one load at a time, so two requests can't both find it missing
    and register it twice."""
    if (demo_id or DEFAULT_DEMO) not in DEMOS:
        return {"success": False, "error": f"No demo dataset called {demo_id!r}"}
    with _DEMO_LOCK:
        return _load_demo(state, demo_id or DEFAULT_DEMO)


def _load_demo(state, demo_id: str) -> dict[str, Any]:
    """Load the demo dataset (once) and say where to look.

    In a tour tab its genome comes with it (``ensure_demo_reference``);
    ``reference`` in the answer says what the tab's reference became."""
    from models.requests import AddDatasetRequest
    from services.dataset_endpoint import add_dataset_for_request
    from services.runtime import get_host_public_mode
    if get_host_public_mode():
        return {"success": False, "error": "The demo dataset can't be loaded on a public server"}
    spec = DEMOS[demo_id]
    if not demo_path(demo_id).exists():
        return {"success": False, "error": "The demo dataset isn't installed (browser/data/demo)"}
    reference = ensure_demo_reference(state, demo_id=demo_id)
    extra = {"reference": reference} if reference is not None else {}
    extra["demo"] = demo_id
    existing = _loaded_demo_id(state, demo_id)
    if existing:
        # With the dataset, so a page that doesn't know it yet (reloaded) can show it.
        dataset = state.datasets.get(existing)
        payload = dataset.to_dict() if hasattr(dataset, "to_dict") else None
        return {"success": True, "dataset_id": existing, "region": spec["region"], "already_loaded": True,
                **({"dataset": payload} if payload else {}), **extra}
    result = add_dataset_for_request(state, AddDatasetRequest(path=str(demo_path(demo_id)), label=spec["label"]))
    if not result.get("success"):
        return result
    dataset = result.get("dataset") or {}
    return {**result, "dataset_id": dataset.get("id") or _loaded_demo_id(state, demo_id), "region": spec["region"], **extra}
