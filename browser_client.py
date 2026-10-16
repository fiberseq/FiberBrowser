"""
FiberBrowser Client for Jupyter Integration

Connect to a running FiberBrowser instance and interact with it from Jupyter.
Provides full scripting access to navigation, datasets, sessions, tracks,
clustering, peak scanning, sorting, overlays, and more.

Example usage:
    from browser_client import BrowserClient

    # Connect to running browser. A local FiberBrowser requires its per-launch
    # access token; the client finds it in ~/.fiberhmm/browser_runtime.json
    # (written by the server), or pass the printed link or token=...
    client = BrowserClient("http://localhost:8000")
    # client = BrowserClient("http://localhost:8000/?token=...")

    # Get current view
    region = client.get_region()
    reads_df = client.get_reads()

    # Analyze and highlight
    interesting = reads_df[reads_df['n_footprints'] > 5]['read_id'].tolist()
    client.highlight_reads(interesting, color='red', label='High FP count')

    # Custom ordering
    client.set_read_order(interesting)  # Put these at top

    # Navigate
    client.goto('chr1', 10000, 20000)

    # Dataset & session management
    client.add_dataset(path='/path/to/data.bb')
    client.save_session('my_session.json')
    client.load_session('my_session.json')

    # Analysis
    peaks = client.scan_peaks()
    result = client.cluster(peak_indices=[0, 1, 2], k=3)
"""
from __future__ import annotations

import json
import math
import uuid
import requests
from typing import List, Dict, Optional, Union, Any, Tuple, TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    import pandas as pd
    import numpy as np
    from PIL import Image as PILImage

TOKEN_HEADER = "X-FiberBrowser-Token"


def _split_token(url: str) -> Tuple[str, Optional[str]]:
    """(base URL without query, token from its ?token= parameter)."""
    from urllib.parse import parse_qs, urlsplit
    parts = urlsplit(url)
    token = (parse_qs(parts.query).get("token") or [None])[0]
    base = f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.scheme else url.split("?", 1)[0]
    return base.rstrip("/"), token


def _token_from_runtime_file(url: str) -> Optional[str]:
    """The token a local server on this URL's port recorded for this user
    (~/.fiberhmm/browser_runtime.json, or FIBERBROWSER_RUNTIME_FILE)."""
    import os
    from urllib.parse import urlsplit
    try:
        port = urlsplit(url).port or 80
    except ValueError:
        return None
    path = os.path.expanduser(os.environ.get(
        "FIBERBROWSER_RUNTIME_FILE", os.path.join("~", ".fiberhmm", "browser_runtime.json")))
    try:
        with open(path) as handle:
            entry = (json.load(handle).get("servers") or {}).get(str(port)) or {}
    except (OSError, ValueError, AttributeError):
        return None
    if not _pid_alive(entry.get("pid")):
        return None  # a server that has exited left a stale entry
    return entry.get("token") or None


def _pid_alive(pid) -> bool:
    """Whether a process exists, without signalling it (os.kill(pid, 0) would
    terminate it on Windows)."""
    import os
    import sys
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# Lazy imports - only load when needed
_pd = None
_np = None

PEAK_BED_COLUMNS = [
    "chrom",
    "start",
    "end",
    "name",
    "bed_score",
    "strand",
    "rule_id",
    "rule_name",
    "source",
    "layer",
    "signal_score",
    "threshold",
    "selected",
    "mode",
    "is_custom",
    "color",
]

READ_STATS_TSV_COLUMNS = [
    "read_id",
    "dataset_id",
    "aligned_span",
    "footprint_count",
    "avg_footprint_size",
    "accessibility_pct",
    "methyl_count",
    "methyl_pct",
    "mapq",
    "strand",
    "viewer_order",
]

LEGACY_PRIMARY_DATASET_ID = "primary"

PRIMER_ORDER_FORMATS = {
    "idt": {
        "filename": "primer_order_idt.csv",
        "mime_type": "text/csv",
    },
    "genewiz": {
        "filename": "primer_order_genewiz.csv",
        "mime_type": "text/csv",
    },
    "eurofins": {
        "filename": "primer_order_eurofins_plate.csv",
        "mime_type": "text/csv",
    },
    "sigma": {
        "filename": "primer_order_sigma.csv",
        "mime_type": "text/csv",
    },
    "generic": {
        "filename": "primer_order_generic.csv",
        "mime_type": "text/csv",
    },
    "fasta": {
        "filename": "primer_order.fasta",
        "mime_type": "text/plain",
    },
}

ANALYSIS_PANEL_TYPES: Tuple[str, ...] = (
    "cluster-detail",
    "cluster-features",
    "co-accessibility",
    "footprint-analysis",
    "peak-detection",
    "transcription-state",
    "colormap",
    "read-stats",
    "track-browser",
    "annotations",
    "contact-map",
    "primer-design",
    "capture",
    "history",
    "circular-genome",
)

ANALYSIS_PANEL_ALIASES = {
    "cluster": "cluster-detail",
    "clusters": "cluster-detail",
    "cluster-detail": "cluster-detail",
    "cluster-features": "cluster-features",
    "analysis-rules": "cluster-features",
    "rules": "cluster-features",
    "coacc": "co-accessibility",
    "co-access": "co-accessibility",
    "co-accessibility": "co-accessibility",
    "footprint": "footprint-analysis",
    "footprints": "footprint-analysis",
    "footprint-analysis": "footprint-analysis",
    "peak": "peak-detection",
    "peaks": "peak-detection",
    "peak-detection": "peak-detection",
    "transcription": "transcription-state",
    "transcription-state": "transcription-state",
    "labeling": "colormap",
    "labels": "colormap",
    "quality": "colormap",
    "labeling-quality": "colormap",
    "colormap": "colormap",
    "read-stats": "read-stats",
    "reads": "read-stats",
    "stats": "read-stats",
    "tracks": "track-browser",
    "track-browser": "track-browser",
    "annotation": "annotations",
    "annotations": "annotations",
    "contact": "contact-map",
    "contact-map": "contact-map",
    "dafc": "contact-map",
    "microc": "contact-map",
    "primer": "primer-design",
    "primers": "primer-design",
    "primer-design": "primer-design",
    "capture": "capture",
    "history": "history",
    "genome": "circular-genome",
    "genome-navigator": "circular-genome",
    "navigator": "circular-genome",
    "circular": "circular-genome",
    "circular-genome": "circular-genome",
    "plasmid": "circular-genome",
    "plasmids": "circular-genome",
}

def _ensure_pandas():
    global _pd
    if _pd is None:
        try:
            import pandas
            _pd = pandas
        except ImportError:
            raise ImportError(
                "pandas is required for this function. "
                "Install it with: pip install pandas"
            )
    return _pd

# Columns of the per-read projection table (the Projection tab's Export
# writes the same ones; the x/y columns are named after the method).
PROJECTION_TABLE_COLUMNS = ("read_name", "dataset", "strand", "alignment_strand", "cluster",
                            "{method}_x", "{method}_y", "embedded")


def projection_table_from_response(response: dict):
    """A /api/cluster_projection response as a per-read DataFrame.

    Columns: read_name, dataset, strand (DAF CT/GA, '' when unknown),
    alignment_strand (+/-), cluster, <method>_x, <method>_y, embedded (False
    for reads placed by their nearest embedded reads above the t-SNE cap).
    The map's parameters (method, seed, perplexity, neighbours, feature
    digest, region, ...) are in ``df.attrs["projection"]``.
    """
    pd = _ensure_pandas()
    method = str(response.get("method") or "projection")
    n = len(response.get("read_ids") or [])
    strands = response.get("strands") or [""] * n
    alignment = response.get("alignment_strands") or [""] * n
    embedded = response.get("embedded")
    columns = [c.format(method=method) for c in PROJECTION_TABLE_COLUMNS]
    df = pd.DataFrame({
        columns[0]: list(response.get("read_ids") or []),
        columns[1]: list(response.get("dataset_ids") or []),
        columns[2]: list(strands),
        columns[3]: list(alignment),
        columns[4]: list(response.get("labels_before") or []),
        columns[5]: list(response.get("coords_x") or []),
        columns[6]: list(response.get("coords_y") or []),
        columns[7]: list(embedded) if embedded is not None else [True] * n,
    }, columns=columns)
    params = dict(response.get("projection_params") or {})
    params.setdefault("method", method)
    params.setdefault("random_state", response.get("projection_random_state"))
    params.setdefault("sample_seed", response.get("sample_seed"))
    if response.get("skipped_datasets"):
        params["skipped_datasets"] = list(response["skipped_datasets"])
    df.attrs["projection"] = params
    return df


def write_projection_table(df, path: str) -> str:
    """Write a projection table as TSV with its parameters as '# key: value' header lines."""
    params = dict(getattr(df, "attrs", {}).get("projection") or {})
    lines = ["# fiberbrowser_export: read_projection"]
    for key in sorted(params):
        value = params[key]
        # As the browser's Export writes them.
        if value is None:
            value = ""
        elif isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            value = json.dumps(value, sort_keys=True)
        lines.append(f"# {key}: {value}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
        df.to_csv(handle, sep="\t", index=False, lineterminator="\n")
    return path


def read_projection_table(path: str):
    """Read a projection table written by FiberBrowser (Export or write_projection_table)."""
    pd = _ensure_pandas()
    params = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.startswith("#"):
                break
            key, _, value = line[1:].strip().partition(": ")
            params[key] = value
    df = pd.read_csv(path, sep="\t", comment="#", keep_default_na=False)
    df.attrs["projection"] = params
    return df


def _ensure_numpy():
    global _np
    if _np is None:
        try:
            import numpy
            _np = numpy
        except ImportError:
            raise ImportError(
                "numpy is required for this function. "
                "Install it with: pip install numpy"
            )
    return _np


class BrowserClient:
    """Client for interacting with a running FiberBrowser instance."""
    ANALYSIS_PANEL_TYPES = ANALYSIS_PANEL_TYPES
    ANALYSIS_PANEL_ALIASES = ANALYSIS_PANEL_ALIASES
    
    def __init__(self, url: str = "http://localhost:8000", token: Optional[str] = None):
        """
        Connect to a FiberBrowser instance.
        
        Args:
            url: Base URL of the running browser server. The link the server
                prints (``http://localhost:8000/?token=...``) works too.
            token: The server's access token. Default: the ``?token=`` of
                ``url``, else ``FIBERBROWSER_TOKEN``, else the token the local
                server on that port recorded in ``~/.fiberhmm/browser_runtime.json``.
        """
        import os
        self.url, url_token = _split_token(url)
        self.token = token or url_token or os.environ.get("FIBERBROWSER_TOKEN") or _token_from_runtime_file(self.url)
        self._session = None
        self._http_session()
        self._check_connection()
    
    def _check_connection(self):
        """Verify connection to browser."""
        try:
            r = self._session.get(f"{self.url}/api/status", timeout=5)
            if r.status_code == 401:
                raise ConnectionError(
                    f"FiberBrowser at {self.url} needs its access token. Pass the link it printed "
                    f"(BrowserClient('{self.url}/?token=...')) or token=..., or run the client as the "
                    f"same user as the server (it reads ~/.fiberhmm/browser_runtime.json)."
                )
            r.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise ConnectionError(
                f"Cannot connect to FiberBrowser at {self.url}. "
                f"Make sure the browser is running (python browser.py ...)\n"
                f"Error: {e}"
            )

    def _http_session(self):
        """Return the persistent HTTP session, recreating it after close() if needed."""
        session = getattr(self, "_session", None)
        if session is None:
            session = requests.Session()
            token = getattr(self, "token", None)
            if token:
                session.headers[TOKEN_HEADER] = token
            self._session = session
        return session

    def _get_response(self, endpoint: str, params: dict = None, timeout: int = 60):
        """Make a GET request and return the raw response object."""
        r = self._http_session().get(f"{self.url}{endpoint}", params=params, timeout=timeout)
        r.raise_for_status()
        return r

    def _post_response(
        self,
        endpoint: str,
        data: dict = None,
        params: dict = None,
        timeout: int = 60,
        files: dict = None,
    ):
        """Make a POST request and return the raw response object."""
        kwargs = {"params": params, "timeout": timeout}
        if files is not None:
            kwargs["files"] = files
        else:
            kwargs["json"] = data
        r = self._http_session().post(f"{self.url}{endpoint}", **kwargs)
        r.raise_for_status()
        return r
    
    def _get(self, endpoint: str, params: dict = None) -> dict:
        """Make GET request to browser API."""
        return self._get_response(endpoint, params=params, timeout=30).json()
    
    def _post(self, endpoint: str, data: dict = None, params: dict = None) -> dict:
        """Make POST request to browser API."""
        return self._post_response(endpoint, data=data, params=params, timeout=30).json()
    
    def _delete(self, endpoint: str, params: dict = None) -> dict:
        """Make DELETE request to browser API."""
        r = self._http_session().delete(f"{self.url}{endpoint}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    def _get_bytes(self, endpoint: str, params: dict = None, timeout: int = 60) -> bytes:
        """Make GET request to a binary browser API endpoint."""
        return self._get_response(endpoint, params=params, timeout=timeout).content

    def _post_bytes(self, endpoint: str, data: dict = None, params: dict = None, timeout: int = 60) -> bytes:
        """Make POST request to a binary browser API endpoint."""
        return self._post_response(endpoint, data=data, params=params, timeout=timeout).content

    @staticmethod
    def _comma_param(values: Optional[Union[str, Sequence[str]]]) -> Optional[str]:
        """Normalize list-like API params to the comma format used by FastAPI routes."""
        if values is None:
            return None
        if isinstance(values, str):
            return values
        return ",".join(str(v) for v in values)

    @staticmethod
    def _read_ids_by_dataset_param(values: Optional[Dict[str, Sequence[str]]]) -> Optional[str]:
        """Normalize dataset-scoped read IDs to the JSON query-param format."""
        if not values:
            return None
        scoped = {
            str(dataset_id): [str(read_id) for read_id in read_ids if str(read_id)]
            for dataset_id, read_ids in values.items()
        }
        return json.dumps(scoped) if scoped else None

    def _add_read_scope_params(
        self,
        params: dict,
        read_ids: Optional[Sequence[str]] = None,
        read_ids_by_dataset: Optional[Dict[str, Sequence[str]]] = None,
    ) -> None:
        # An explicit empty selection (read_ids=[]) means no reads, not every
        # read: a query string can't carry an empty list, so it goes as an empty
        # scope per targeted dataset (all loaded datasets when none is named).
        if read_ids is not None and not isinstance(read_ids, str) and len(read_ids) == 0 \
                and read_ids_by_dataset is None:
            targets = [d for d in str(params.get('dataset_ids') or '').split(',') if d]
            if not targets:
                targets = [str(d.get('id')) for d in self.get_datasets() if d.get('id')]
            if targets:
                read_ids_by_dataset = {dataset_id: [] for dataset_id in targets}
            read_ids = None
        read_ids_param = self._comma_param(read_ids)
        if read_ids_param:
            params['read_ids'] = read_ids_param
        read_ids_by_dataset_param = self._read_ids_by_dataset_param(read_ids_by_dataset)
        if read_ids_by_dataset_param:
            params['read_ids_by_dataset'] = read_ids_by_dataset_param

    @staticmethod
    def _list_param(values: Optional[Union[str, Sequence[str]]]) -> Optional[List[str]]:
        """Normalize list-like request-body values to a JSON list."""
        if values is None:
            return None
        if isinstance(values, str):
            return [values]
        return [str(v) for v in values]

    @classmethod
    def _layer_names_param(cls, values: Optional[Union[str, Sequence[str]]]) -> Optional[str]:
        """Normalize layer-name params through user-facing annotation aliases."""
        if values is None:
            return None
        raw_values: Sequence[Any]
        if isinstance(values, str):
            raw_values = values.split(",")
        else:
            raw_values = values
        names: List[str] = []
        seen = set()
        for value in raw_values:
            normalized = cls._normalize_annotation_layer(value)
            if normalized and normalized not in seen:
                names.append(normalized)
                seen.add(normalized)
        return ",".join(names) if names else None

    @classmethod
    def _layer_names_list(cls, values: Optional[Union[str, Sequence[str]]]) -> Optional[List[str]]:
        """Normalize layer-name lists for JSON bodies."""
        param = cls._layer_names_param(values)
        return param.split(",") if param else None
    
    # =========================================================================
    # Query Methods
    # =========================================================================
    
    def get_region(self) -> Dict[str, Any]:
        """
        Get the current viewport region.
        
        Returns:
            dict with 'chrom', 'start', 'end' keys
        """
        return self._get("/api/jupyter/region")
    
    def get_reads(self, dataset_id: str = None, spanning: bool = True,
                  min_footprints: int = 0, as_dataframe: bool = True,
                  sample_seed: str = None) -> Union[pd.DataFrame, List[dict]]:
        """
        Get reads from the browser's WORKING SET (same reads used for analysis).
        
        This returns the reads that the browser uses for clustering, peak detection,
        and other analysis - ensuring consistency between what you see and analyze.
        
        Note: Returns the full working set unless the browser was launched
        with an explicit --max-working-reads safety cap.
        
        Args:
            dataset_id: Specific dataset ID (default: browser's first/current dataset)
            spanning: Only return reads that span the entire region (default: True)
            min_footprints: Minimum footprints per read (default: 0, no filter).
                           Set to 5 to filter out reads with <5 footprints.
            as_dataframe: Return as pandas DataFrame (default: True)
            sample_seed: Optional seed for reproducible backend working-set caps
        
        Returns:
            DataFrame with columns:
                - id: Read name
                - intervals: List of [start, end, size] 
                - chrom, region_start, region_end: Region info
                - n_footprints: Number of footprints
                - footprint_bases: Total footprint bases
            Or list of dicts if as_dataframe=False
            
        Additional response fields (when as_dataframe=False):
            - total_spanning: Total spanning reads before any optional safety cap
            - total_overlapping: Total overlapping reads
            - working_count: Number of reads in working set
        """
        params = {'spanning': str(spanning).lower()}
        if dataset_id:
            params['dataset_id'] = dataset_id
        if min_footprints > 0:
            params['min_footprints'] = min_footprints
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        
        result = self._get("/api/jupyter/reads", params)
        reads = result.get('reads', [])
        
        if as_dataframe:
            pd = _ensure_pandas()
            if not reads:
                return pd.DataFrame(columns=['id', 'intervals', 'chrom', 'region_start', 'region_end', 'n_footprints', 'footprint_bases'])
            return pd.DataFrame(reads)
        return reads

    def get_jupyter_reads(self, dataset_id: str, chrom: str = None,
                          start: int = None, end: int = None,
                          sample_seed: str = None) -> dict:
        """Frontend-name wrapper for `/api/jupyter/reads`."""
        params = {'dataset_id': dataset_id}
        if chrom:
            params['chrom'] = chrom
        if start is not None:
            params['start'] = int(start)
        if end is not None:
            params['end'] = int(end)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._get("/api/jupyter/reads", params=params)
    
    def get_datasets(self) -> List[Dict[str, str]]:
        """
        Get list of loaded datasets.
        
        Returns:
            List of dicts with 'id', 'label', 'path', 'color' keys
        """
        result = self._get("/api/datasets")
        return result.get('datasets', [])

    def get_default_dataset_id(self) -> Optional[str]:
        """Return the first loaded dataset ID, or None when no dataset is loaded."""
        for dataset in self.get_datasets():
            dataset_id = dataset.get("id") if isinstance(dataset, dict) else None
            if dataset_id:
                return str(dataset_id)
        return None

    def resolve_dataset_id(self, dataset_id: str = None) -> Optional[str]:
        """Resolve omitted or legacy ``primary`` aliases to the first loaded dataset.

        Newer browser sessions use stable file-derived dataset IDs. This helper
        keeps older notebooks that pass ``dataset_id="primary"`` working
        without exposing that legacy name in new examples.
        """
        if dataset_id is not None:
            cleaned = str(dataset_id).strip()
            if cleaned and cleaned != LEGACY_PRIMARY_DATASET_ID:
                return cleaned
        return self.get_default_dataset_id() or (
            LEGACY_PRIMARY_DATASET_ID if dataset_id is not None else None
        )

    def _default_dataset_id_or_legacy(self) -> str:
        """Resolve a required dataset field without teaching new users `primary`."""
        return self.resolve_dataset_id() or LEGACY_PRIMARY_DATASET_ID

    def add_dataset(self, path: str = None, paths: List[str] = None,
                    url: str = None, label: str = None) -> dict:
        """
        Add a new dataset (BAM, BigBed file(s), or remote URL).

        Args:
            path: Local file path
            paths: List of local file paths
            url: Remote HTTP/HTTPS URL for BAM or BigBed
            label: Display label for the dataset

        Returns:
            dict with dataset info on success
        """
        data = {}
        if path:
            data['path'] = path
        if paths:
            data['paths'] = paths
        if url:
            data['url'] = url
        if label:
            data['label'] = label
        return self._post("/api/datasets/add", data)

    def add_dataset_url(self, url: str, label: str = None) -> dict:
        """Add a remote BAM/BigBed dataset via the URL convenience endpoint."""
        params = {'url': url}
        if label:
            params['label'] = label
        return self._post("/api/datasets/add_url", params=params)

    def remove_dataset(self, dataset_id: str) -> dict:
        """
        Remove a dataset.

        Args:
            dataset_id: ID of the dataset to remove
        """
        return self._delete(f"/api/datasets/{dataset_id}")

    def refresh_dataset_capabilities(self, dataset_id: str = None) -> dict:
        """
        Re-detect a loaded dataset's available layers and clear stale read caches.

        Useful after loading older saved sessions or when BAM/BigBed companion
        layer metadata looks stale in the browser.
        """
        target_id = dataset_id or self.get_default_dataset_id()
        if not target_id:
            return {"success": False, "error": "No loaded dataset to refresh"}
        return self._post(f"/api/datasets/{target_id}/refresh_capabilities", {})

    # =========================================================================
    # Session Management
    # =========================================================================

    def save_session(self, filepath: str, chrom: str = None,
                     start: int = None, end: int = None,
                     include_frontend_state: bool = True) -> dict:
        """
        Export the current browser session to a JSON file.

        Args:
            filepath: Path to write the session JSON file
            chrom: Chromosome (auto-detected from current view if omitted)
            start: Start position
            end: End position
            include_frontend_state: Include the browser-synced UI/settings
                snapshot so Python-saved sessions preserve seeds, locked peaks,
                footprint rules, quality filters, panel layout, and carts.

        Returns:
            dict with session data
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        data = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        if include_frontend_state:
            # The open browser's full state (clusters, panels, colors...) when
            # it has reported one; otherwise the Python-synced settings.
            try:
                live = self._get("/api/render/live_state", {"full": "true"})
            except requests.HTTPError:  # e.g. public mode
                live = {}
            data['frontend_state'] = live.get('frontend_state') or self.get_browser_settings()
        result = self._post("/api/session/export", data)
        with open(filepath, 'w') as f:
            json.dump(result, f, indent=2)
        return result

    def check_session_files(self, filepath: str, search_root: str = None,
                            mapping: dict = None) -> dict:
        """List a session's input files and whether each exists on this computer.

        Pass ``search_root`` to look for missing files under a folder (e.g.
        where the data now lives). The returned ``mapping`` (saved path →
        found path) can be given to :meth:`load_session`.
        """
        with open(filepath) as f:
            session = json.load(f)
        body = {'session': session}
        if search_root:
            body['search_root'] = search_root
        if mapping:
            body['mapping'] = mapping
        return self._post("/api/session/check_files", body)

    def load_session(self, filepath: str, path_mapping: dict = None,
                     search_root: str = None) -> dict:
        """
        Import a browser session from a JSON file.

        Args:
            filepath: Path to a session JSON file
            path_mapping: Saved path → path on this computer, for files that
                moved (see :meth:`check_session_files`).
            search_root: Find moved files under this folder automatically.

        Returns:
            dict with import results
        """
        with open(filepath) as f:
            session = json.load(f)
        if search_root:
            checked = self.check_session_files(filepath, search_root=search_root, mapping=path_mapping)
            path_mapping = checked.get('mapping') or path_mapping
        body = {'session': session}
        if path_mapping:
            body['path_mapping'] = path_mapping
        return self._post("/api/session/import", body)

    def get_status(self) -> dict:
        """Get browser status info."""
        return self._get("/api/status")
    
    def get_clusters(self, dataset_id: str = None) -> Dict[str, Any]:
        """
        Get cluster assignments (if clustering was performed in browser).
        
        Args:
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Returns:
            dict with:
                - assignments: {read_id: cluster_num}
                - cluster_counts: {cluster_num: count}
                - n_reads: total reads clustered
                - n_clusters: number of clusters
                
            For combinatorial clustering, also includes:
                - n_elements: number of elements/peaks used
                - element_regions: list of {start, end} for each element
                - cluster_patterns: {cluster_id: [0,1,1,0,...]} - accessibility pattern per cluster
                - element_read_ids: {element_idx: [read_ids...]} - reads where element is accessible
                - method: 'combinatorial' or other clustering method
        """
        params = {'dataset_id': dataset_id} if dataset_id else {}
        return self._get("/api/jupyter/clusters", params)

    @staticmethod
    def _tsv_cell(value: Any) -> str:
        if value is None:
            return ""
        return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")

    @classmethod
    def _provenance_value(cls, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            text = value
        elif isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, (int, float)):
            text = str(value)
        else:
            try:
                text = json.dumps(value, separators=(",", ":"))
            except TypeError:
                text = str(value)
        return cls._tsv_cell(text)

    @classmethod
    def _format_provenance_comments(cls, provenance: Optional[Dict[str, Any]]) -> str:
        if not provenance:
            return ""
        lines = [("fiberbrowser_export", "cluster_assignments")]
        lines.extend(sorted(provenance.items(), key=lambda item: item[0]))
        return "".join(
            f"# {key}: {cls._provenance_value(value)}\n"
            for key, value in lines
        )

    @staticmethod
    def _ordered_assignment_ids(assignments: Dict[str, int], read_order: List[str] = None) -> List[str]:
        ids = list(assignments.keys())
        if not read_order:
            return ids
        rank = {rid: i for i, rid in enumerate(read_order)}
        fallback = len(rank)
        input_rank = {rid: i for i, rid in enumerate(ids)}
        return sorted(ids, key=lambda rid: (rank.get(rid, fallback), input_rank.get(rid, fallback)))

    def _normalize_read_ids_by_dataset(
        self,
        read_ids_by_dataset: Union[Dict[str, Sequence[str]], Sequence[str]],
        dataset_id: str = None,
    ) -> Dict[str, List[str]]:
        if isinstance(read_ids_by_dataset, dict):
            return {
                str(ds_id): [str(read_id) for read_id in read_ids]
                for ds_id, read_ids in read_ids_by_dataset.items()
            }
        target_dataset_id = dataset_id or self._default_dataset_id_or_legacy()
        if isinstance(read_ids_by_dataset, str):
            return {str(target_dataset_id): [read_ids_by_dataset]}
        return {str(target_dataset_id): [str(read_id) for read_id in read_ids_by_dataset]}

    @staticmethod
    def _viewer_order_map(read_ids_by_dataset: Dict[str, Sequence[str]]) -> Dict[Tuple[str, str], int]:
        order: Dict[Tuple[str, str], int] = {}
        next_order = 1
        for ds_id, read_ids in read_ids_by_dataset.items():
            for read_id in read_ids:
                key = (str(ds_id), str(read_id))
                if key in order:
                    continue
                order[key] = next_order
                next_order += 1
        return order

    def _read_stats_with_viewer_order(
        self,
        response: dict,
        read_ids_by_dataset: Dict[str, Sequence[str]],
    ) -> dict:
        """Attach browser/table-style viewer_order and sort per-read stats by it."""
        if not isinstance(response, dict):
            return response
        order = self._viewer_order_map(read_ids_by_dataset)
        fallback_order = len(order) + 1
        rows = []
        for idx, row in enumerate(response.get("per_read", []) or []):
            if not isinstance(row, dict):
                continue
            ds_id = str(row.get("dataset_id", ""))
            read_id = str(row.get("read_id", ""))
            out = dict(row)
            out["viewer_order"] = order.get((ds_id, read_id), fallback_order + idx)
            rows.append(out)
        rows.sort(key=lambda row: row.get("viewer_order", fallback_order))
        out_response = dict(response)
        out_response["per_read"] = rows
        return out_response

    def _cluster_export_provenance(
        self,
        dataset_ids: Sequence[str],
        labels: Dict[str, str],
    ) -> Dict[str, Any]:
        settings = self.get_browser_settings()
        region = self.get_region()
        active_colormap = settings.get("active_colormap") if isinstance(settings, dict) else {}
        if not isinstance(active_colormap, dict):
            active_colormap = {}

        provenance: Dict[str, Any] = {
            "dataset_ids": list(dataset_ids),
            "dataset_labels": [labels.get(ds_id, ds_id) for ds_id in dataset_ids],
        }
        for key in ("chrom", "start", "end"):
            if isinstance(region, dict) and key in region:
                provenance[key] = region.get(key)
        for key in (
            "analysis_sample_seed",
            "analysis_sample_count",
            "spanning_only",
            "peaks_locked",
            "cluster_method",
            "cluster_k",
            "small_footprint_threshold_bp",
            "accessibility_threshold",
            "selected_peak_count",
        ):
            if isinstance(settings, dict) and key in settings:
                provenance[key] = settings.get(key)
        if "qualityFilters" in active_colormap:
            provenance["quality_filters"] = active_colormap.get("qualityFilters")
        elif isinstance(settings, dict) and "quality_filters" in settings:
            provenance["quality_filters"] = settings.get("quality_filters")
        return provenance

    def get_clusters_tsv(self, dataset_ids: Union[str, Sequence[str]] = None,
                         include_patterns: bool = True,
                         include_provenance: bool = False,
                         provenance: Optional[Dict[str, Any]] = None) -> str:
        """
        Export cluster assignments as the same ordered TSV schema used by the UI.

        Rows are ordered by the browser's latest top-to-bottom read order when
        available, with unlisted reads preserving backend assignment order.

        Args:
            dataset_ids: Dataset ID or IDs. Defaults to all loaded datasets
                if available, otherwise the backend's legacy dataset alias.
            include_patterns: Include combinatorial cluster pattern column
                when pattern metadata is available.
            include_provenance: Prefix reproducibility comments from the live
                browser settings/region before the TSV header.
            provenance: Optional extra comment metadata to merge into the
                provenance block. Passing this also enables the comment block.

        Returns:
            TSV text with columns ``read_id``, ``dataset``, ``cluster``,
            optional ``pattern``, and ``viewer_order``.
        """
        if dataset_ids is None:
            datasets = self.get_datasets()
            dataset_ids_list = [d.get("id") for d in datasets if d.get("id")] or [LEGACY_PRIMARY_DATASET_ID]
        elif isinstance(dataset_ids, str):
            dataset_ids_list = [dataset_ids]
            datasets = self.get_datasets()
        else:
            dataset_ids_list = [str(d) for d in dataset_ids]
            datasets = self.get_datasets()

        labels = {d.get("id"): d.get("label") or d.get("id") for d in datasets}
        cluster_payloads = []
        has_patterns = False
        for ds_id in dataset_ids_list:
            clusters = self.get_clusters(ds_id)
            assignments = clusters.get("assignments") or {}
            patterns = clusters.get("cluster_patterns") or {}
            if include_patterns and patterns:
                has_patterns = True
            cluster_payloads.append((ds_id, assignments, patterns))

        header = ["read_id", "dataset", "cluster"]
        if has_patterns:
            header.append("pattern")
        header.append("viewer_order")

        lines = ["\t".join(header)]
        viewer_order = 1
        for ds_id, assignments, patterns in cluster_payloads:
            read_order = self.get_browser_read_order(ds_id)
            for read_id in self._ordered_assignment_ids(assignments, read_order):
                cluster = assignments[read_id]
                row = [read_id, labels.get(ds_id, ds_id), cluster]
                if has_patterns:
                    pattern = patterns.get(str(cluster), patterns.get(cluster))
                    row.append("".join(str(x) for x in pattern) if pattern is not None else "")
                row.append(viewer_order)
                lines.append("\t".join(self._tsv_cell(v) for v in row))
                viewer_order += 1

        prefix = ""
        if include_provenance or provenance is not None:
            merged_provenance = (
                self._cluster_export_provenance(dataset_ids_list, labels)
                if include_provenance else {}
            )
            if provenance:
                merged_provenance.update(provenance)
            prefix = self._format_provenance_comments(merged_provenance)
        return prefix + "\n".join(lines) + "\n"

    def save_clusters_tsv(self, filepath: str, dataset_ids: Union[str, Sequence[str]] = None,
                          include_patterns: bool = True,
                          include_provenance: bool = False,
                          provenance: Optional[Dict[str, Any]] = None) -> str:
        """Write ``get_clusters_tsv()`` output to ``filepath`` and return the path."""
        text = self.get_clusters_tsv(
            dataset_ids=dataset_ids,
            include_patterns=include_patterns,
            include_provenance=include_provenance,
            provenance=provenance,
        )
        with open(filepath, "w", encoding="utf-8") as handle:
            handle.write(text)
        return filepath

    # Backward-readable alias with the UI wording.
    def save_cluster_assignments_tsv(self, filepath: str, dataset_ids: Union[str, Sequence[str]] = None,
                                     include_patterns: bool = True,
                                     include_provenance: bool = False,
                                     provenance: Optional[Dict[str, Any]] = None) -> str:
        """Alias for ``save_clusters_tsv``."""
        return self.save_clusters_tsv(
            filepath,
            dataset_ids=dataset_ids,
            include_patterns=include_patterns,
            include_provenance=include_provenance,
            provenance=provenance,
        )
    
    def get_element_info(self, dataset_id: str = None) -> Dict[str, Any]:
        """
        Get element/peak information from combinatorial clustering.
        
        Args:
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Returns:
            dict with:
                - n_elements: number of elements
                - element_regions: list of {start, end} for each element
                - cluster_patterns: {cluster_id: [0,1,1,0,...]}
                - element_read_ids: {element_idx: [read_ids...]}
            
            Returns empty dict if no combinatorial clustering was performed.
        """
        clusters = self.get_clusters(dataset_id)
        
        if clusters.get('method') != 'combinatorial':
            return {}
        
        return {
            'n_elements': clusters.get('n_elements', 0),
            'element_regions': clusters.get('element_regions', []),
            'cluster_patterns': clusters.get('cluster_patterns', {}),
            'element_read_ids': clusters.get('element_read_ids', {})
        }
    
    def decode_cluster(self, cluster_id: int, dataset_id: str = None) -> Dict[str, bool]:
        """
        Decode a cluster ID to show which elements are accessible.
        
        Args:
            cluster_id: The cluster number to decode
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Returns:
            dict mapping element names (E1, E2, ...) to accessibility (True/False)
            
        Example:
            >>> client.decode_cluster(5)
            {'E1': True, 'E2': False, 'E3': True}  # cluster 5 = binary 101
        """
        clusters = self.get_clusters(dataset_id)
        patterns = clusters.get('cluster_patterns', {})
        n_elements = clusters.get('n_elements', 0)
        
        # Get pattern for this cluster
        pattern = patterns.get(str(cluster_id)) or patterns.get(cluster_id)
        
        if pattern is None:
            # Fallback: decode from binary if patterns not available
            cluster_id = int(cluster_id)
            if n_elements == 0:
                n_elements = cluster_id.bit_length() or 1
            return {
                f'E{i+1}': bool(cluster_id & (1 << (n_elements - 1 - i)))
                for i in range(n_elements)
            }
        
        return {f'E{i+1}': bool(b) for i, b in enumerate(pattern)}
    
    def get_reads_for_element(self, element_idx: int, dataset_id: str = None) -> List[str]:
        """
        Get read IDs where a specific element is accessible.
        
        Args:
            element_idx: Element index (0-based) or element number (1-based if prefixed with 'E')
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Returns:
            List of read IDs where this element is accessible
        """
        clusters = self.get_clusters(dataset_id)
        element_read_ids = clusters.get('element_read_ids', {})
        
        # Handle both int index and string like 'E1'
        if isinstance(element_idx, str) and element_idx.startswith('E'):
            element_idx = int(element_idx[1:]) - 1
        
        return element_read_ids.get(str(element_idx)) or element_read_ids.get(element_idx, [])
    
    def get_reads_with_clusters(self, dataset_id: str = None, spanning: bool = True) -> pd.DataFrame:
        """
        Get reads with cluster assignments merged in.
        
        Args:
            dataset_id: Dataset ID (default: browser's first/current dataset)
            spanning: Only return reads that span the entire region (default: True)
        
        Returns:
            DataFrame with reads and 'cluster' column
        """
        reads_df = self.get_reads(dataset_id, spanning=spanning)
        clusters = self.get_clusters(dataset_id)
        
        if clusters.get('assignments'):
            reads_df['cluster'] = reads_df['id'].map(clusters['assignments'])
        else:
            reads_df['cluster'] = None
        
        return reads_df
    
    def filter_reads(self, read_ids: List[str], dataset_id: str = None):
        """
        Filter browser view to show only specified reads.
        
        Args:
            read_ids: List of read IDs to show (all others hidden)
            dataset_id: Dataset ID (default: browser's first/current dataset)
        """
        return self._post("/api/jupyter/filter", {
            'read_ids': list(read_ids),
            'dataset_id': dataset_id
        })

    def set_read_filter(self, read_ids: List[str], dataset_id: str = None):
        """Explicit alias for ``filter_reads`` used by notebook workflows."""
        return self.filter_reads(read_ids, dataset_id=dataset_id)

    def get_read_filter(self, dataset_id: str = None) -> List[str]:
        """Get the active Jupyter-controlled read filter for a dataset."""
        params = {'dataset_id': dataset_id} if dataset_id else {}
        result = self._get("/api/jupyter/filter", params)
        return result.get('read_ids', [])
    
    def clear_filter(self, dataset_id: str = None):
        """Clear read filter, show all reads."""
        params = {'dataset_id': dataset_id} if dataset_id else None
        return self._delete("/api/jupyter/filter", params=params)

    def clear_read_filter(self, dataset_id: str = None):
        """Explicit alias for ``clear_filter``."""
        return self.clear_filter(dataset_id=dataset_id)
    
    def push_reads(self, matrix: np.ndarray = None, index_df: pd.DataFrame = None, 
                   reads_df: pd.DataFrame = None, label: str = "Jupyter") -> dict:
        """
        Push custom reads to display in browser.
        
        Can provide either:
        - matrix + index_df (from to_matrix)
        - reads_df with 'id' and 'intervals' columns
        
        Args:
            matrix: Position matrix from to_matrix()
            index_df: Index DataFrame from to_matrix()
            reads_df: Alternative - DataFrame with intervals already
            label: Label for the dataset in browser
        
        Returns:
            dict with 'dataset_id' of the created dataset
        
        Example:
            # Filter matrix and push back
            mask = matrix[:, 1150] < 150
            result = client.push_reads(matrix[mask], index_df[mask], label="Filtered")
        """
        if reads_df is not None:
            df = reads_df
        elif matrix is not None and index_df is not None:
            df = self.from_matrix(matrix, index_df)
        else:
            raise ValueError("Provide either reads_df or both matrix and index_df")
        
        # Convert to list of dicts for API
        reads = []
        for _, row in df.iterrows():
            read = {'id': row['id'], 'intervals': row['intervals']}
            # Include other metadata if present
            for col in ['n_footprints', 'footprint_bases', 'chrom', 'region_start', 'region_end']:
                if col in row:
                    read[col] = row[col]
            reads.append(read)
        
        return self._post("/api/jupyter/push_reads", {
            'reads': reads,
            'label': label
        })
    
    def clear_pushed_reads(self):
        """Clear all pushed custom reads."""
        return self._delete("/api/jupyter/push_reads")

    def get_custom_reads(self, dataset_id: str) -> List[Dict[str, Any]]:
        """
        Get reads previously pushed from Python/Jupyter for a custom dataset.

        Args:
            dataset_id: ID returned by ``push_reads()``

        Returns:
            List of compact read dictionaries stored in the browser bridge
        """
        result = self._get(f"/api/jupyter/custom_reads/{dataset_id}")
        return result.get('reads', [])
    
    # =========================================================================
    # Matrix Conversion Methods
    # =========================================================================
    
    @staticmethod
    def to_matrix(reads_df: pd.DataFrame, region_width: int = None) -> Tuple[np.ndarray, pd.DataFrame]:
        """
        Convert interval-based reads DataFrame to position matrix.
        
        Args:
            reads_df: DataFrame from get_reads() with 'id' and 'intervals' columns
            region_width: Width of region (auto-detected if None)
        
        Returns:
            Tuple of:
                - matrix: np.ndarray of shape (n_reads, region_width) where values are:
                    - positive: footprint size
                    - negative: gap size  
                    - 0: no coverage
                - index_df: DataFrame with read metadata (id, n_footprints, etc.)
                           Use this to map back from matrix rows to read info
        
        Example:
            matrix, index_df = client.to_matrix(reads_df)
            # Analyze matrix...
            # Get info for row 5:
            read_info = index_df.iloc[5]
        """
        np = _ensure_numpy()
        
        if reads_df.empty:
            return np.array([]).reshape(0, 0), reads_df
        
        # Auto-detect region width from intervals
        if region_width is None:
            max_end = 0
            for intervals in reads_df['intervals']:
                for iv in intervals:
                    max_end = max(max_end, iv[1])
            region_width = max_end
        
        n_reads = len(reads_df)
        matrix = np.zeros((n_reads, region_width), dtype=np.int32)
        
        for i, row in enumerate(reads_df.itertuples()):
            for start, end, size in row.intervals:
                start = max(0, int(start))
                end = min(region_width, int(end))
                if end > start:
                    matrix[i, start:end] = int(size)
        
        # Create index DataFrame (drop intervals column for cleaner output)
        index_df = reads_df.drop(columns=['intervals']).reset_index(drop=True)
        
        return matrix, index_df
    
    @staticmethod
    def from_matrix(matrix: np.ndarray, index_df: pd.DataFrame = None) -> pd.DataFrame:
        """
        Convert position matrix back to interval-based DataFrame.
        
        Args:
            matrix: np.ndarray of shape (n_reads, region_width)
            index_df: Optional DataFrame with read metadata to merge back
        
        Returns:
            DataFrame with 'intervals' column (and merged metadata if index_df provided)
        
        Example:
            # Reorder matrix rows
            new_order = [5, 3, 1, 0, 2, 4]
            reordered_matrix = matrix[new_order]
            reordered_index = index_df.iloc[new_order].reset_index(drop=True)
            
            # Convert back
            new_df = client.from_matrix(reordered_matrix, reordered_index)
        """
        pd = _ensure_pandas()
        
        reads_data = []
        
        for i in range(matrix.shape[0]):
            row = matrix[i]
            intervals = []
            
            # Find runs of same value
            if len(row) == 0:
                reads_data.append({'intervals': []})
                continue
            
            start = 0
            current_val = row[0]
            
            for j in range(1, len(row)):
                if row[j] != current_val:
                    if current_val != 0:
                        intervals.append([start, j, int(current_val)])
                    start = j
                    current_val = row[j]
            
            # Handle last run
            if current_val != 0:
                intervals.append([start, len(row), int(current_val)])
            
            reads_data.append({'intervals': intervals})
        
        result_df = pd.DataFrame(reads_data)
        
        # Merge with index_df if provided
        if index_df is not None:
            for col in index_df.columns:
                if col != 'intervals':
                    result_df[col] = index_df[col].values
        
        return result_df
    
    @staticmethod 
    def reorder_reads(reads_df: pd.DataFrame, new_order: List[int]) -> pd.DataFrame:
        """
        Reorder reads DataFrame by row indices.
        
        Args:
            reads_df: Original DataFrame
            new_order: List of row indices in desired order
        
        Returns:
            Reordered DataFrame
        """
        return reads_df.iloc[new_order].reset_index(drop=True)
    
    # =========================================================================
    # Navigation Methods  
    # =========================================================================
    
    def goto(self, chrom: str, start: int, end: int):
        """
        Navigate the browser to a specific region.
        
        Args:
            chrom: Chromosome name
            start: Start position
            end: End position
        """
        return self._post("/api/jupyter/goto", {
            'chrom': chrom,
            'start': int(start),
            'end': int(end)
        })
    
    def goto_gene(self, gene_name: str, padding: int = 2000):
        """
        Navigate to a gene by name.
        
        Args:
            gene_name: Gene name to search for
            padding: Base pairs to add around gene (default: 2000)
        """
        return self._post("/api/jupyter/goto_gene", {
            'gene': gene_name,
            'padding': int(padding)
        })

    def queue_browser_actions(self, actions: List[dict], label: str = "Python") -> dict:
        """
        Queue UI-equivalent actions for the active browser frontend to execute.

        These actions mimic browser button/workflow behavior and are applied by
        the live browser during its normal Jupyter polling loop. Use this for
        operations that must update frontend state, not just compute backend
        results.
        """
        return self._post("/api/jupyter/actions", {
            "actions": actions,
            "label": label,
        })

    def cluster_by_saved_footprints_in_browser(self, label: str = "Python") -> dict:
        """Ask the live browser to cluster reads by which saved footprints they carry.

        Same as Binding > Co-occupancy > "Cluster reads by these footprints":
        one cluster per membership pattern (e.g. +A +B, +A -B, neither).
        """
        return self.queue_browser_actions([
            {"type": "cluster_by_saved_footprints"},
        ], label=label)

    def cluster_by_footprints(self, groups: Sequence[dict] = None, chrom: str = None,
                              start: int = None, end: int = None,
                              dataset_ids: Sequence[str] = None) -> dict:
        """Cluster reads by which footprint definitions they carry, without the browser.

        ``groups`` are saved footprint definitions (default: the browser's
        enabled saved entries, ``get_footprint_rules()``). Only reads evaluated
        for every definition are assigned. Returns
        ``{"assignments": {dataset: {read: cluster}}, "legend": [{id, pattern, label, count}]}``,
        most common pattern first.
        """
        groups = [g for g in (self.get_footprint_rules() if groups is None else groups) if g.get("enabled", True)]
        if not groups:
            raise ValueError("No footprint definitions to cluster by")
        result = self.analyze_footprints(
            chrom=chrom, start=start, end=end, dataset_ids=list(dataset_ids) if dataset_ids else None,
            footprints=[], groups=groups, include_read_analysis=True, auto_motifs=False,
            include_sequences=False, include_motifs=False, include_overlap=False,
            include_profiles=False, include_vplot=False, include_coocc=True,
        )
        counts: Dict[str, int] = {}
        patterns: Dict[str, Dict[str, str]] = {}
        for dataset_id, occupancy in (result.get("co_occupancy") or {}).items():
            per_group = occupancy.get("per_group") or []
            if len(per_group) != len(groups):
                continue
            with_sets = [set(g.get("ids_with") or []) for g in per_group]
            eligible = [set(g.get("ids_with") or []) | set(g.get("ids_without") or []) for g in per_group]
            reads = set.intersection(*eligible) if eligible else set()
            patterns[dataset_id] = {}
            for read_id in reads:
                pattern = "".join("1" if read_id in s_ else "0" for s_ in with_sets)
                patterns[dataset_id][read_id] = pattern
                counts[pattern] = counts.get(pattern, 0) + 1
        ordered = sorted(counts, key=lambda p: -counts[p])
        ids = {pattern: index for index, pattern in enumerate(ordered)}
        names = [str(g.get("name") or f"fp{i + 1}") for i, g in enumerate(groups)]
        return {
            "assignments": {ds: {r: ids[p] for r, p in by_read.items()} for ds, by_read in patterns.items()},
            "legend": [{"id": ids[p], "pattern": p, "count": counts[p],
                        "label": "  ".join(("+" if bit == "1" else "-") + names[i] for i, bit in enumerate(p))}
                       for p in ordered],
        }

    def cluster_selected_peaks_in_browser(self, label: str = "Python") -> dict:
        """Ask the live browser to run its normal Cluster button workflow."""
        return self.queue_browser_actions([
            {"type": "cluster_selected_peaks"},
        ], label=label)

    def cluster_peak_at_gene_tss_in_browser(
        self,
        gene_name: str,
        padding: int = 5000,
        tolerance_bp: int = 500,
        label: str = "Python",
    ) -> dict:
        """Ask the live browser to cluster on the peak overlapping a gene TSS."""
        return self.queue_browser_actions([
            {
                "type": "cluster_peak_at_gene_tss",
                "gene": gene_name,
                "padding_bp": int(padding),
                "tolerance_bp": int(tolerance_bp),
            }
        ], label=label)

    # =========================================================================
    # Copilot / Natural Language Methods
    # =========================================================================

    def get_copilot_capabilities(self) -> dict:
        """Return Copilot-safe API routes, backend status, and model metadata."""
        return self._get("/api/nl/capabilities")

    def plan_natural_language_command(self, text: str, context: dict = None,
                                      model: str = None,
                                      previous_turns: Sequence[dict] = None) -> dict:
        """Plan a browser workflow from natural language without executing it."""
        return self._post("/api/nl/plan", {
            "text": text,
            "context": context,
            "model": model,
            "previous_turns": list(previous_turns) if previous_turns is not None else None,
        })

    def plan_copilot_command(self, *args, **kwargs) -> dict:
        """Alias for ``plan_natural_language_command``."""
        return self.plan_natural_language_command(*args, **kwargs)

    def stream_natural_language_command(self, text: str, context: dict = None,
                                        model: str = None,
                                        previous_turns: Sequence[dict] = None,
                                        timeout: int = 120):
        """Yield NDJSON Copilot planning events from ``/api/nl/stream``."""
        body = {
            "text": text,
            "context": context,
            "model": model,
            "previous_turns": list(previous_turns) if previous_turns is not None else None,
        }
        response = self._http_session().post(
            f"{self.url}/api/nl/stream",
            json=body,
            stream=True,
            timeout=timeout,
        )
        response.raise_for_status()
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            yield json.loads(line)

    def stream_copilot_command(self, *args, **kwargs):
        """Alias for ``stream_natural_language_command``."""
        return self.stream_natural_language_command(*args, **kwargs)

    def get_copilot_agent_tools(self) -> dict:
        """Return the tool schema used by the experimental Copilot agent loop."""
        return self._get("/api/nl/agent_tools")

    def copilot_agent_step(self, messages: Sequence[dict] = None, text: str = None,
                           context: dict = None, model: str = None,
                           previous_turns: Sequence[dict] = None) -> dict:
        """Run one backend Copilot agent iteration."""
        return self._post("/api/nl/agent_step", {
            "messages": list(messages or []),
            "text": text,
            "context": context,
            "model": model,
            "previous_turns": list(previous_turns) if previous_turns is not None else None,
        })

    def setup_copilot(self, model_id: str = None) -> dict:
        """Install/start the configured local Copilot model backend."""
        return self._post("/api/nl/setup", {"model_id": model_id})

    def probe_copilot_backends(self) -> dict:
        """Report whether MLX and Ollama Copilot backends are reachable."""
        return self._get("/api/nl/probe_backends")

    def set_copilot_backend(self, backend: str) -> dict:
        """Switch the active Copilot backend to ``'mlx'`` or ``'ollama'``."""
        return self._post("/api/nl/set_backend", {"backend": backend})

    def log_copilot_session(self, session_id: str = None,
                            started_at: float = None,
                            snapshots: Sequence[dict] = None,
                            command_history: Sequence[dict] = None,
                            activity_log: Sequence[dict] = None,
                            metadata: dict = None,
                            share: bool = False,
                            share_full_details: bool = False) -> dict:
        """Persist a browser session log for Copilot evaluation/training."""
        return self._post("/api/nl/log_session", {
            "session_id": session_id,
            "started_at": started_at,
            "snapshots": list(snapshots or []),
            "command_history": list(command_history or []),
            "activity_log": list(activity_log or []),
            "metadata": metadata or {},
            "share": bool(share),
            "share_full_details": bool(share_full_details),
            "explicit": True,
        })

    def get_copilot_share_status(self) -> dict:
        """Return local shared-usage file status."""
        return self._get("/api/nl/share_status")

    def clear_copilot_shared_usage(self) -> dict:
        """Clear the local shared-usage file."""
        return self._post("/api/nl/share_clear")

    def reveal_copilot_shared_usage(self) -> dict:
        """Open the local shared-usage file/folder from the backend process."""
        return self._post("/api/nl/share_reveal")

    def get_copilot_share_upload_status(self) -> dict:
        """Return whether a usage upload receiver is configured."""
        return self._get("/api/nl/share_upload_status")

    def send_copilot_shared_usage(self) -> dict:
        """Upload the local shared-usage file to the configured receiver."""
        return self._post("/api/nl/share_send")

    # =========================================================================
    # Highlight/Overlay Methods
    # =========================================================================
    
    def highlight_reads(self, read_ids: List[str], color: str = '#ff0000', 
                        label: str = None, dataset_id: str = None):
        """
        Highlight specific reads with a color.
        
        Args:
            read_ids: List of read IDs to highlight
            color: CSS color string (default: red)
            label: Label for this highlight group
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Returns:
            dict with 'highlight_id' that can be used to remove this highlight
        
        Example:
            result = client.highlight_reads(['read1', 'read2'], color='blue', label='Cluster A')
            # Later: client.remove_highlight(result['highlight_id'])
        """
        return self._post("/api/jupyter/highlights", {
            'type': 'read',
            'read_ids': list(read_ids),
            'color': color,
            'label': label or f"Highlight ({len(read_ids)} reads)",
            'dataset_id': dataset_id
        })
    
    def highlight_footprints(self, footprints: List[Dict], color: str = '#ff0000',
                             label: str = None, dataset_id: str = None):
        """
        Highlight specific footprints.
        
        Args:
            footprints: List of {read_id, start, end} or {read_id, footprint_idx} dicts
            color: CSS color string
            label: Label for this highlight group
            dataset_id: Dataset ID (default: browser's first/current dataset)
        
        Example:
            client.highlight_footprints([
                {'read_id': 'read1', 'start': 1000, 'end': 1150},
                {'read_id': 'read2', 'footprint_idx': 3}
            ], color='green')
        """
        return self._post("/api/jupyter/highlights", {
            'type': 'footprint',
            'footprints': footprints,
            'color': color,
            'label': label or f"Highlight ({len(footprints)} footprints)",
            'dataset_id': dataset_id
        })
    
    def get_highlights(self) -> List[Dict]:
        """Get all current highlights."""
        result = self._get("/api/jupyter/highlights")
        return result.get('highlights', [])
    
    def remove_highlight(self, highlight_id: str):
        """Remove a specific highlight by ID."""
        return self._delete(f"/api/jupyter/highlights/{highlight_id}")
    
    def clear_highlights(self, group: str = None):
        """
        Clear read highlights.
        
        Args:
            group: Not used (kept for API compatibility). Clears all highlights.
        """
        return self._delete("/api/jupyter/highlights")
    
    def color_footprints(self, footprint_colors: Dict[str, List[Dict]], group: str = 'default'):
        """
        Color specific footprints on specific reads.
        
        Args:
            footprint_colors: Dict mapping read_id -> list of {start, end, color}
            group: Group name for managing multiple colorings
        
        Example:
            client.color_footprints({
                'read1': [
                    {'start': 1000, 'end': 1100, 'color': 'red'},
                    {'start': 1500, 'end': 1600, 'color': 'blue'}
                ],
                'read2': [
                    {'start': 2000, 'end': 2200, 'color': 'green'}
                ]
            })
        """
        return self._post("/api/jupyter/footprint_colors", {
            'footprint_colors': footprint_colors,
            'group': group
        })

    def get_footprint_colors(self) -> List[Dict]:
        """Get all current Jupyter-controlled footprint color groups."""
        result = self._get("/api/jupyter/footprint_colors")
        return result.get('footprint_colors', [])

    def remove_footprint_colors(self, color_id: str):
        """Remove a specific footprint color group by ID."""
        return self._delete(f"/api/jupyter/footprint_colors/{color_id}")

    def remove_footprint_color(self, color_id: str):
        """Alias for ``remove_footprint_colors``."""
        return self.remove_footprint_colors(color_id)
    
    def clear_footprint_colors(self, group: str = None):
        """Clear footprint colorings."""
        params = {'group': group} if group else None
        return self._delete("/api/jupyter/footprint_colors", params=params)
    
    def add_markers(self, positions: List[Dict], group: str = 'default'):
        """
        Add position markers (vertical lines) to the view.
        
        Args:
            positions: List of {position, color, label} dicts
            group: Group name
        
        Example:
            client.add_markers([
                {'position': 5000, 'color': 'red', 'label': 'TSS'},
                {'position': 6000, 'color': 'blue', 'label': 'Peak'}
            ])
        """
        return self._post("/api/jupyter/markers", {
            'markers': positions,
            'group': group
        })

    def get_markers(self) -> List[Dict]:
        """Get all current Jupyter-controlled marker groups."""
        result = self._get("/api/jupyter/markers")
        return result.get('markers', [])

    def remove_marker(self, marker_id: str):
        """Remove a specific marker group by ID."""
        return self._delete(f"/api/jupyter/markers/{marker_id}")
    
    def clear_markers(self, group: str = None):
        """Clear position markers."""
        params = {'group': group} if group else None
        return self._delete("/api/jupyter/markers", params=params)
    
    # =========================================================================
    # Read Ordering Methods
    # =========================================================================
    
    def set_read_order(self, read_ids: List[str], dataset_id: str = None):
        """
        Set custom read ordering. Reads in the list appear first (in order),
        followed by any remaining reads.
        
        Args:
            read_ids: Ordered list of read IDs
            dataset_id: Dataset to apply ordering to (default: browser's first/current dataset)
        """
        return self._post("/api/jupyter/order", {
            'read_ids': list(read_ids),
            'dataset_id': dataset_id
        })
    
    def get_read_order(self, dataset_id: str = None) -> List[str]:
        """Get current custom read ordering."""
        params = {'dataset_id': dataset_id} if dataset_id else {}
        result = self._get("/api/jupyter/order", params)
        return result.get('read_ids', [])

    def get_browser_read_order(self, dataset_id: str = None) -> List[str]:
        """
        Get the latest top-to-bottom read order reported by the browser.

        This is browser state for reproducibility/export, not the custom order
        set by set_read_order().
        """
        params = {'dataset_id': dataset_id} if dataset_id else {}
        result = self._get("/api/jupyter/browser_order", params)
        return result.get('read_ids', [])

    def get_browser_order(self, dataset_id: str = None) -> List[str]:
        """Alias for ``get_browser_read_order``."""
        return self.get_browser_read_order(dataset_id)
    
    def clear_read_order(self, dataset_id: str = None):
        """Reset to default read ordering."""
        params = {'dataset_id': dataset_id} if dataset_id else None
        return self._delete("/api/jupyter/order", params=params)
    
    # =========================================================================
    # Utility Methods
    # =========================================================================
    
    def clear_all(self):
        """Clear all Jupyter-controlled state (highlights, ordering, markers, etc.)."""
        return self._delete("/api/jupyter/clear")

    def refresh(self):
        """Force browser to refresh the current view."""
        return self._post("/api/jupyter/refresh", {})

    def set_reproducibility(self, seed: str = None, analysis_cap: int = None,
                            display_cap: int = None, spanning: bool = None,
                            display_mode: str = None,
                            all_reads_display_cap: int = None,
                            background_read_cap: int = None,
                            profile_read_cap: int = None) -> dict:
        """
        Push global browser reproducibility/display controls from a notebook.

        Args:
            seed: Shared sampling/KMeans seed shown in Settings → Performance.
            analysis_cap: Optional analysis read cap. Use 0 to turn off.
            display_cap: Optional representative sample cap. Use 0 for the
                browser default one-read-per-pixel sampling.
            spanning: Optional global Span toggle value.
            display_mode: ``sample`` for representative display sampling, or
                ``all`` for scrollable all-row display up to the safety cap.
            all_reads_display_cap: Display row cap used by ``display_mode='all'``.
            background_read_cap: Backward-compatible name for
                ``profile_read_cap``.
            profile_read_cap: Optional browser-side profile/metaprofile pool
                cap. Use 0 to turn the cap off.
        """
        data = {}
        if seed is not None:
            data["analysis_sample_seed"] = str(seed)
        if analysis_cap is not None:
            cap = int(analysis_cap)
            data["analysis_sample_count"] = cap if cap > 0 else None
        if display_cap is not None:
            cap = int(display_cap)
            data["display_sample_count"] = cap if cap > 0 else None
        if display_mode is not None:
            data["read_display_mode"] = str(display_mode)
        if all_reads_display_cap is not None:
            data["all_reads_display_cap"] = int(all_reads_display_cap)
        if profile_read_cap is not None:
            background_read_cap = profile_read_cap
        if background_read_cap is not None:
            cap = int(background_read_cap)
            data["background_read_cap"] = cap if cap > 0 else None
        if spanning is not None:
            data["spanning_only"] = bool(spanning)
        return self._post("/api/jupyter/settings", data)

    def set_cluster_settings(self, method: str = None, k: int = None,
                             small_footprint_threshold_bp: int = None,
                             accessibility_threshold: float = None,
                             subnucleosomal_threshold: int = None) -> dict:
        """
        Push browser clustering controls from a notebook.

        Args:
            method: Cluster method shown in the browser, e.g. ``kmeans``.
            k: K value for methods that use a fixed cluster count.
            small_footprint_threshold_bp: Footprints below this size are treated
                as accessible by size-based clustering features.
            accessibility_threshold: Fraction of a peak that must be accessible
                to call that read/peak open.
            subnucleosomal_threshold: Backward-readable alias for
                ``small_footprint_threshold_bp``.
        """
        data = {}
        if method is not None:
            data["cluster_method"] = str(method)
        if k is not None:
            data["cluster_k"] = int(k)
        if small_footprint_threshold_bp is None and subnucleosomal_threshold is not None:
            small_footprint_threshold_bp = subnucleosomal_threshold
        if small_footprint_threshold_bp is not None:
            data["small_footprint_threshold_bp"] = int(small_footprint_threshold_bp)
        if accessibility_threshold is not None:
            data["accessibility_threshold"] = float(accessibility_threshold)
        return self._post("/api/jupyter/settings", data)

    def set_display_settings(self, enabled_mod_types: dict = None,
                             enabled_meta_profiles: dict = None,
                             cached_layer_types: dict = None,
                             legacy_layer_inference: bool = None,
                             legacy_nuc_min_size: int = None,
                             click_target_layer: str = None,
                             footprint_analysis_layer: str = None,
                             fill_read_height: bool = None,
                             read_row_height: Union[int, str] = None,
                             read_display_mode: str = None,
                             all_reads_display_cap: int = None,
                             background_read_cap: int = None,
                             profile_read_cap: int = None,
                             show_coverage_histogram: bool = None,
                             max_region_for_reads: int = None,
                             show_genome_overview: bool = None) -> dict:
        """
        Push browser display/layer controls from a notebook.

        These settings mirror the View/Track/Labeling controls that affect what
        layers are visible or prefetched, without changing backend datasets.
        """
        data = {}
        if enabled_mod_types is not None:
            data["enabled_mod_types"] = dict(enabled_mod_types)
        if enabled_meta_profiles is not None:
            data["enabled_meta_profiles"] = dict(enabled_meta_profiles)
        if cached_layer_types is not None:
            data["cached_layer_types"] = dict(cached_layer_types)
        if legacy_layer_inference is not None:
            data["legacy_layer_inference"] = bool(legacy_layer_inference)
        if legacy_nuc_min_size is not None:
            data["legacy_nuc_min_size"] = int(legacy_nuc_min_size)
        if click_target_layer is not None:
            data["click_target_layer"] = self._normalize_annotation_layer(click_target_layer)
        if footprint_analysis_layer is not None:
            data["footprint_analysis_layer"] = self._normalize_annotation_layer(footprint_analysis_layer)
        if fill_read_height is not None:
            data["fill_read_height"] = bool(fill_read_height)
        if read_row_height is not None:
            data["read_row_height"] = read_row_height
        if read_display_mode is not None:
            data["read_display_mode"] = str(read_display_mode)
        if all_reads_display_cap is not None:
            data["all_reads_display_cap"] = int(all_reads_display_cap)
        if profile_read_cap is not None:
            background_read_cap = profile_read_cap
        if background_read_cap is not None:
            cap = int(background_read_cap)
            data["background_read_cap"] = cap if cap > 0 else None
        if show_coverage_histogram is not None:
            data["show_coverage_histogram"] = bool(show_coverage_histogram)
        if max_region_for_reads is not None:
            data["max_region_for_reads"] = int(max_region_for_reads)
        if show_genome_overview is not None:
            data["show_genome_overview"] = bool(show_genome_overview)
        return self._post("/api/jupyter/settings", data)

    def set_legacy_layer_inference(self, enabled: bool = True, nuc_min_size: int = 90) -> dict:
        """Configure inferred TF/nuc/FIRE layers for legacy footprint-only files."""
        return self.set_display_settings(
            legacy_layer_inference=bool(enabled),
            legacy_nuc_min_size=int(nuc_min_size),
        )

    @staticmethod
    def _normalize_layer_toggle_key(layer: Any) -> str:
        """Normalize common UI/API aliases while preserving custom layer IDs."""
        raw = str(layer).strip()
        lookup = raw.lower().replace("-", "_")
        aliases = {
            "tf_layer": "tf",
            "nuc_layer": "nuc",
            "nucleosome": "nuc",
            "nucleosomes": "nuc",
            "msp": "fire",
            "msp_layer": "fire",
            "methyl_m6a": "m6a",
            "methyl_m5c": "m5c",
        }
        return aliases.get(lookup, raw)

    @classmethod
    def _normalize_annotation_layer(cls, layer: Any) -> Optional[str]:
        """Normalize a single analysis layer name while preserving custom layers."""
        if layer is None:
            return None
        raw = str(layer).strip()
        if not raw or raw.lower() in {"none", "null", "default", "all"}:
            return None
        return cls._normalize_layer_toggle_key(raw)

    @classmethod
    def _add_layer_param(cls, params: Dict[str, Any], layer: Any, key: str = "layer") -> None:
        normalized = cls._normalize_annotation_layer(layer)
        if normalized:
            params[key] = normalized

    @classmethod
    def _layer_toggle_map(
        cls,
        layers: Optional[Union[Dict[str, bool], str, Sequence[str]]] = None,
        layer_states: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, bool]:
        toggles: Dict[str, bool] = {}
        if isinstance(layers, dict):
            for layer, enabled in layers.items():
                toggles[cls._normalize_layer_toggle_key(layer)] = bool(enabled)
        elif layers is not None:
            for layer in cls._list_param(layers) or []:
                toggles[cls._normalize_layer_toggle_key(layer)] = True
        for layer, enabled in (layer_states or {}).items():
            if enabled is not None:
                toggles[cls._normalize_layer_toggle_key(layer)] = bool(enabled)
        return toggles

    def set_visible_layers(
        self,
        layers: Optional[Union[Dict[str, bool], str, Sequence[str]]] = None,
        **layer_states,
    ) -> dict:
        """
        Toggle read-level layer visibility from Python/Jupyter.

        Examples::

            client.set_visible_layers(tf=True, nuc=True, fire=False)
            client.set_visible_layers(["tf", "nuc"])
            client.set_visible_layers({"tf": True, "deam": False})

        ``msp`` is accepted as a legacy alias and is sent as ``fire``.
        """
        return self.set_display_settings(
            enabled_mod_types=self._layer_toggle_map(layers, layer_states)
        )

    def set_metaprofile_layers(
        self,
        layers: Optional[Union[Dict[str, bool], str, Sequence[str]]] = None,
        **layer_states,
    ) -> dict:
        """
        Toggle metaprofile rows from Python/Jupyter.

        The browser merges these partial updates with current metaprofile
        settings, matching the Track Settings UI.
        """
        return self.set_display_settings(
            enabled_meta_profiles=self._layer_toggle_map(layers, layer_states)
        )

    def set_layer_cache(
        self,
        layers: Optional[Union[Dict[str, bool], str, Sequence[str]]] = None,
        **layer_states,
    ) -> dict:
        """
        Toggle which optional layers are prefetched into read-window caches.

        Use this when scripting high-coverage datasets from notebooks, e.g.
        ``client.set_layer_cache(fire=False, deam=False, m6a=True)``.
        """
        return self.set_display_settings(
            cached_layer_types=self._layer_toggle_map(layers, layer_states)
        )

    def set_coacc_settings(self, track_mode: str = None,
                           signal_type: str = None,
                           layer: str = None,
                           normalization: str = None,
                           scaling: str = None,
                           colormap: str = None,
                           min_coverage: int = None,
                           bin_size: int = None,
                           arc_threshold: float = None,
                           arc_max_arcs: int = None,
                           arc_min_distance: int = None,
                           v4c_viewpoint: dict = None,
                           **raw_settings) -> dict:
        """Push co-accessibility panel/track settings from Python/Jupyter.

        Pythonic argument names are converted to the browser's session keys.
        ``raw_settings`` can include already-serialized keys such as
        ``coaccTrackMode`` when replaying a saved snapshot.
        """
        settings = dict(raw_settings)
        if track_mode is not None:
            settings["coaccTrackMode"] = track_mode
        if signal_type is not None:
            settings["coaccSignalType"] = signal_type
        if layer is not None:
            settings["coaccLayer"] = self._normalize_annotation_layer(layer)
        if normalization is not None:
            settings["coaccNormalization"] = normalization
        if scaling is not None:
            settings["coaccScaling"] = scaling
        if colormap is not None:
            settings["coaccColormap"] = colormap
        if min_coverage is not None:
            settings["coaccMinCoverage"] = int(min_coverage)
        if bin_size is not None:
            settings["coaccBinSize"] = int(bin_size)
        if arc_threshold is not None:
            settings["coaccArcThreshold"] = float(arc_threshold)
        if arc_max_arcs is not None:
            settings["coaccArcMaxArcs"] = int(arc_max_arcs)
        if arc_min_distance is not None:
            settings["coaccArcMinDistance"] = int(arc_min_distance)
        if v4c_viewpoint is not None:
            viewpoint = dict(v4c_viewpoint)
            # The browser uses a viewpoint only on its own chromosome; one given
            # without it is the current view's.
            if viewpoint.get("chrom") is None:
                try:
                    chrom = (self.get_region() or {}).get("chrom")
                except Exception:
                    chrom = None
                if chrom:
                    viewpoint["chrom"] = chrom
            settings["coaccV4cViewpoint"] = viewpoint
        return self._post("/api/jupyter/settings", {"coacc_settings": settings})

    set_coaccessibility_settings = set_coacc_settings

    def set_browser_settings(self, **kwargs) -> dict:
        """Push browser settings using either aliases or raw snapshot keys."""
        raw_keys = {
            "analysis_sample_seed",
            "analysis_sample_count",
            "display_sample_count",
            "read_display_mode",
            "all_reads_display_cap",
            "background_read_cap",
            "spanning_only",
            "peaks_locked",
            "peak_rules",
            "selected_peaks",
            "peak_modes",
            "selected_read_ids",
            "peaks_by_rule",
            "cluster_feature_rules",
            "analysis_sort_rules",
            "analysis_filter_rules",
            "active_colormap",
            "cluster_method",
            "cluster_k",
            "small_footprint_threshold_bp",
            "accessibility_threshold",
            "capture_regions",
            "capture_padding",
            "catalog",
            "composite_tracks",
            "saved_tracks",
            "footprint_groups",
            "selected_genes",
            "transcription_state_filters",
            "primer_saved_primers",
            "primer_mode",
            "primer_cart_track_display",
            "enabled_mod_types",
            "enabled_meta_profiles",
            "cached_layer_types",
            "legacy_layer_inference",
            "legacy_nuc_min_size",
            "click_target_layer",
            "footprint_analysis_layer",
            "coacc_settings",
            "fill_read_height",
            "read_row_height",
            "show_coverage_histogram",
            "max_region_for_reads",
            "show_genome_overview",
            "open_panel",
            "close_panel",
            "hidden_strip_panels",
        }
        if any(key in kwargs for key in raw_keys):
            return self.apply_browser_settings(kwargs)
        return self.set_reproducibility(**kwargs)

    def get_browser_settings(self) -> dict:
        """Return the latest browser-synced reproducibility/peak settings."""
        result = self._get("/api/jupyter/settings")
        return result.get("settings", result)

    def get_analysis_state(self) -> dict:
        """Return browser-synced peaks, filters, capture regions, and track cart."""
        return self._get("/api/jupyter/analysis_state")

    def get_coacc_settings(self) -> dict:
        """Return browser-synced co-accessibility panel/track settings."""
        state = self.get_analysis_state()
        return state.get("coaccessibility", {})

    def get_session_manifest(self) -> dict:
        """Return the latest browser-synced reproducibility/session manifest."""
        result = self._get("/api/jupyter/session_manifest")
        return result.get("manifest", result)

    def save_session_manifest(self, filepath: str, text: bool = False) -> str:
        """Save the latest session manifest as JSON or a simple text report."""
        manifest = self.get_session_manifest()
        with open(filepath, "w", encoding="utf-8") as handle:
            if text:
                handle.write(self.format_session_manifest(manifest))
                handle.write("\n")
            else:
                json.dump(manifest, handle, indent=2)
                handle.write("\n")
        return filepath

    @staticmethod
    def format_session_manifest(manifest: dict) -> str:
        """Format a browser session manifest for lab notes or methods sections."""
        repro = manifest.get("reproducibility", {}) if isinstance(manifest, dict) else {}
        reference = manifest.get("reference", {}) if isinstance(manifest, dict) else {}
        viewport = manifest.get("viewport", {}) if isinstance(manifest, dict) else {}
        datasets = manifest.get("datasets", []) if isinstance(manifest, dict) else []
        labeling = manifest.get("labeling", {}) if isinstance(manifest, dict) else {}
        warnings = manifest.get("warnings", []) if isinstance(manifest, dict) else []
        footprint_rules = repro.get("footprintRules", {}) if isinstance(repro, dict) else {}
        if not isinstance(footprint_rules, dict):
            footprint_rules = {}
        footprint_layers = footprint_rules.get("layers", [])
        if not isinstance(footprint_layers, list):
            footprint_layers = []
        lines = [
            f"FiberBrowser session: {manifest.get('sessionName', 'Untitled session') if isinstance(manifest, dict) else 'Untitled session'}",
            f"Generated: {manifest.get('generatedAt', '') if isinstance(manifest, dict) else ''}",
            f"Viewport: {viewport.get('chrom', 'unknown')}:{viewport.get('start', 0)}-{viewport.get('end', 0)}",
            f"Reference: {reference.get('genome') or 'none'}" + (f" ({reference.get('fastaPath')})" if reference.get("fastaPath") else ""),
            f"Datasets: {len(datasets)}",
        ]
        for dataset in datasets:
            paths = "; ".join(dataset.get("paths", []) or ["no path"])
            layers = ",".join(dataset.get("layers", []) or [])
            lines.append(f"  - {dataset.get('label', dataset.get('id', 'dataset'))}: {paths}" + (f"; layers={layers}" if layers else ""))
        if isinstance(labeling, dict) and labeling:
            smoothing = labeling.get("displaySmoothing", {}) or {}
            opacities = labeling.get("layerOpacities", {}) or {}
            opacity_text = ", ".join(f"{layer}={opacity}" for layer, opacity in sorted(opacities.items())) or "none"
            smoothing_text = (
                f"on (x={smoothing.get('sigmaX', 0)}, y={smoothing.get('sigmaY', 0)})"
                if smoothing.get("enabled")
                else "off"
            )
            lines.extend([
                f"Labeling: {labeling.get('presetName', 'Default')}, "
                f"{labeling.get('rules', 0)} rules ({labeling.get('enabledRules', 0)} enabled)",
                f"Layer opacity: {opacity_text}",
                f"Display smoothing: {smoothing_text}",
                "Read backgrounds: "
                f"read={labeling.get('readBackgroundColor') or 'default'}, "
                f"no-read={labeling.get('noReadBackgroundColor') or 'default'}",
            ])
        lines.extend([
            f"Seed: {repro.get('seed')}",
            f"Analysis cap: {repro.get('analysisCap', 'off')}",
            f"Display cap: {repro.get('displayCap', 'off')}",
            f"Peaks: {repro.get('selectedPeaks', 0)} selected, locked={repro.get('peaksLocked')}",
            f"Clustering: {repro.get('clusterMethod')}, k={repro.get('clusterK')}",
            "Footprint rules: "
            f"{footprint_rules.get('total', 0)} total, "
            f"{footprint_rules.get('enabled', 0)} enabled, "
            f"{footprint_rules.get('pinned', 0)} pinned"
            + (f", layers={','.join(str(layer) for layer in footprint_layers)}" if footprint_layers else ""),
        ])
        if warnings:
            lines.append("Warnings:")
            lines.extend(f"  - {w}" for w in warnings)
        else:
            lines.append("Warnings: none")
        return "\n".join(lines)

    def get_peak_state(self) -> dict:
        """Return browser-synced peak rules, locked peaks, and selected peaks."""
        state = self.get_analysis_state()
        return {
            "peaks_locked": state.get("peaks_locked"),
            "peak_rules": state.get("peak_rules", []),
            "selected_peaks": state.get("selected_peaks", []),
            "selected_peak_count": state.get("selected_peak_count", 0),
            "peaks_by_rule": state.get("peaks_by_rule", {}),
            "peak_modes": state.get("peak_modes", {}),
        }

    def get_capture_regions(self) -> List[dict]:
        """Return browser-synced capture cart regions."""
        return self.get_analysis_state().get("capture_regions", [])

    def get_footprint_rules(self) -> List[dict]:
        """Return browser-synced saved footprint list (Binding > Saved) rules."""
        return self.get_analysis_state().get("footprint_groups", [])

    def get_analysis_rules(self) -> dict:
        """Return browser-synced Analysis Rules panel definitions."""
        state = self.get_analysis_state()
        rules = state.get("analysis_rules") or {}
        return {
            "cluster_feature_rules": rules.get("cluster_feature_rules", state.get("cluster_feature_rules", [])) or [],
            "analysis_sort_rules": rules.get("analysis_sort_rules", state.get("analysis_sort_rules", [])) or [],
            "analysis_filter_rules": rules.get("analysis_filter_rules", state.get("analysis_filter_rules", [])) or [],
        }

    def get_primer_cart(self) -> dict:
        """Return browser-synced primer cart state from the Primer Design panel."""
        primers = self.get_analysis_state().get("primers") or {}
        return {
            "saved_primers": primers.get("saved_primers", []),
            "mode": primers.get("mode"),
            "cart_track_display": primers.get("cart_track_display"),
        }

    def set_primer_cart(self, saved_primers: Sequence[dict] = None,
                        mode: str = None,
                        cart_track_display: str = None) -> dict:
        """Replace Primer Design cart state in the live browser."""
        data = {}
        if saved_primers is not None:
            data["primer_saved_primers"] = list(saved_primers)
        if mode is not None:
            data["primer_mode"] = mode
        if cart_track_display is not None:
            data["primer_cart_track_display"] = cart_track_display
        return self._post("/api/jupyter/settings", data)

    def set_analysis_rules(self, cluster_feature_rules: Sequence[dict] = None,
                           analysis_sort_rules: Sequence[dict] = None,
                           analysis_filter_rules: Sequence[dict] = None) -> dict:
        """Replace Analysis Rules panel definitions from Python/Jupyter."""
        data = {}
        if cluster_feature_rules is not None:
            data["cluster_feature_rules"] = list(cluster_feature_rules)
        if analysis_sort_rules is not None:
            data["analysis_sort_rules"] = list(analysis_sort_rules)
        if analysis_filter_rules is not None:
            data["analysis_filter_rules"] = list(analysis_filter_rules)
        return self._post("/api/jupyter/settings", data)

    def set_cluster_feature_rules(self, rules: Sequence[dict]) -> dict:
        """Replace Cluster-tab feature rules in the Analysis Rules panel."""
        return self.set_analysis_rules(cluster_feature_rules=rules)

    def set_analysis_sort_rules(self, rules: Sequence[dict]) -> dict:
        """Replace Sort-tab rules in the Analysis Rules panel."""
        return self.set_analysis_rules(analysis_sort_rules=rules)

    def set_analysis_filter_rules(self, rules: Sequence[dict]) -> dict:
        """Replace Filter-tab rules in the Analysis Rules panel."""
        return self.set_analysis_rules(analysis_filter_rules=rules)

    def save_analysis_rules_json(self, filepath: str) -> str:
        """Save browser-synced cluster/sort/filter analysis rules as JSON."""
        with open(filepath, "w", encoding="utf-8") as handle:
            json.dump(self.get_analysis_rules(), handle, indent=2)
            handle.write("\n")
        return filepath

    def load_analysis_rules_json(self, filepath: str) -> dict:
        """Load a JSON file written by ``save_analysis_rules_json`` or the UI."""
        with open(filepath, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, list):
            return self.set_analysis_rules(cluster_feature_rules=payload)
        return self.set_analysis_rules(
            cluster_feature_rules=payload.get("cluster_feature_rules", payload.get("clusterFeatureRules")),
            analysis_sort_rules=payload.get("analysis_sort_rules", payload.get("analysisSortRules")),
            analysis_filter_rules=payload.get("analysis_filter_rules", payload.get("analysisFilterRules")),
        )

    def get_footprint_rule_summary(self) -> dict:
        """Return the session-manifest summary of saved footprint list (Binding > Saved) rules."""
        manifest = self.get_session_manifest()
        repro = manifest.get("reproducibility", {}) if isinstance(manifest, dict) else {}
        summary = repro.get("footprintRules", {}) if isinstance(repro, dict) else {}
        if isinstance(summary, dict) and summary:
            return summary

        groups = self.get_footprint_rules()
        layer_labels = {"tf": "TF", "fire": "FIRE", "msp": "FIRE", "nuc": "Nuc"}
        layers = sorted({
            layer_labels.get(group.get("layer"), group.get("layer") or "Base intervals")
            for group in groups
        })
        return {
            "total": len(groups),
            "enabled": sum(1 for group in groups if group.get("enabled", True)),
            "pinned": sum(
                1 for group in groups
                if group.get("referenceAbsStart") is not None and group.get("referenceAbsEnd") is not None
            ),
            "layers": layers,
            "rules": groups,
        }

    def set_footprint_rules(self, groups: Sequence[dict]) -> dict:
        """Replace the live browser saved footprint list (Binding > Saved) from Python."""
        return self._post("/api/jupyter/settings", {"footprint_groups": list(groups)})

    def set_capture_regions(self, regions: List[dict], padding: int = None) -> dict:
        """Replace the browser capture cart from Python."""
        data = {"capture_regions": list(regions)}
        if padding is not None:
            data["capture_padding"] = int(padding)
        return self._post("/api/jupyter/settings", data)

    def get_transcription_state_selection(self) -> dict:
        """Return selected genes and filter settings synced from the browser."""
        state = self.get_analysis_state()
        return {
            "selected_genes": state.get("selected_genes", []),
            "transcription_state_filters": state.get("transcription_state_filters", {}),
        }

    def set_selected_genes(self, genes: Sequence[dict]) -> dict:
        """Replace the live browser's selected genes used by Pol II analyses."""
        return self._post("/api/jupyter/settings", {"selected_genes": list(genes)})

    def set_transcription_state_filters(self, filters: dict) -> dict:
        """Replace the Transcription State panel filter settings."""
        return self._post("/api/jupyter/settings", {"transcription_state_filters": dict(filters or {})})

    def get_active_filters(self) -> dict:
        """Return active Labeling preset and analysis quality filters."""
        state = self.get_analysis_state()
        return {
            "active_colormap": state.get("active_colormap"),
            "active_quality_filters": state.get("active_quality_filters", []),
        }

    def get_track_cart(self) -> dict:
        """Return browser-synced track catalog/cart/saved-presets state."""
        state = self.get_analysis_state()
        return {
            "catalog": state.get("catalog", []),
            "composite_tracks": state.get("composite_tracks", []),
            "saved_tracks": state.get("saved_tracks", []),
        }

    def set_track_cart(self, catalog: List[dict] = None,
                       composite_tracks: List[dict] = None,
                       saved_tracks: List[dict] = None) -> dict:
        """Replace browser track catalog/cart pieces from Python."""
        data = {}
        if catalog is not None:
            data["catalog"] = list(catalog)
        if composite_tracks is not None:
            data["composite_tracks"] = list(composite_tracks)
        if saved_tracks is not None:
            data["saved_tracks"] = list(saved_tracks)
        return self._post("/api/jupyter/settings", data)

    def get_cluster_state(self) -> dict:
        """Return browser-synced cluster assignments, cluster order, and read order."""
        return self.get_analysis_state().get("clusters", {})

    @classmethod
    def normalize_panel_type(cls, panel_type: str) -> str:
        """Return the canonical browser panel id for a user-facing alias."""
        panel = str(panel_type).strip()
        key = panel.lower().replace("_", "-").replace(" ", "-")
        return cls.ANALYSIS_PANEL_ALIASES.get(key, panel)

    @classmethod
    def _panel_type_sequence(cls, panel_types: Sequence[str]) -> List[str]:
        if isinstance(panel_types, str):
            return [panel_types]
        return list(panel_types)

    @classmethod
    def known_panel_types(cls) -> List[str]:
        """Return canonical built-in panel ids accepted by the browser strip."""
        return list(cls.ANALYSIS_PANEL_TYPES)

    def get_panel_state(self) -> dict:
        """Return active panels, hidden strip panels, and known built-in ids."""
        state = self.get_analysis_state()
        return {
            "active_panels": state.get("active_panels", []),
            "hidden_strip_panels": state.get("hidden_strip_panels", []),
            "known_panel_types": self.known_panel_types(),
            "aliases": dict(self.ANALYSIS_PANEL_ALIASES),
        }

    def open_panel(self, panel_type: str) -> dict:
        """Open an analysis panel in the live browser from Python/Jupyter."""
        return self._post("/api/jupyter/settings", {"open_panel": self.normalize_panel_type(panel_type)})

    def close_panel(self, panel_type: str) -> dict:
        """Close an analysis panel in the live browser from Python/Jupyter."""
        return self._post("/api/jupyter/settings", {"close_panel": self.normalize_panel_type(panel_type)})

    def set_hidden_panels(self, panel_types: Sequence[str]) -> dict:
        """Replace analysis-strip hidden panel settings."""
        hidden = []
        seen = set()
        for panel_type in self._panel_type_sequence(panel_types):
            panel = self.normalize_panel_type(panel_type)
            if panel in seen:
                continue
            seen.add(panel)
            hidden.append(panel)
        return self._post("/api/jupyter/settings", {"hidden_strip_panels": hidden})

    def show_strip_panels(self, panel_types: Sequence[str] = ()) -> dict:
        """Unhide selected strip panels, or show all panels when omitted."""
        if not panel_types:
            return self.set_hidden_panels([])
        current_hidden = [
            self.normalize_panel_type(panel)
            for panel in self.get_panel_state().get("hidden_strip_panels", [])
        ]
        show = {self.normalize_panel_type(panel) for panel in self._panel_type_sequence(panel_types)}
        return self.set_hidden_panels([panel for panel in current_hidden if panel not in show])

    def hide_strip_panels(self, panel_types: Sequence[str]) -> dict:
        """Hide selected panels from the analysis strip without closing them."""
        current_hidden = [
            self.normalize_panel_type(panel)
            for panel in self.get_panel_state().get("hidden_strip_panels", [])
        ]
        return self.set_hidden_panels([*current_hidden, *self._panel_type_sequence(panel_types)])

    def drive_browser(self, *, session: str = None, seed: str = None,
                      analysis_cap: int = None, display_cap: int = None,
                      spanning: bool = None, peaks: Sequence[dict] = None,
                      peak_rules: Sequence[dict] = None,
                      footprint_rules: Sequence[dict] = None,
                      capture_regions: Sequence[dict] = None,
                      track_cart: dict = None,
                      panels: Sequence[str] = None) -> dict:
        """Apply a reproducible browser state bundle from a notebook.

        This is a convenience orchestrator over the explicit methods: load a
        session, push reproducibility controls, reload peaks/rules, restore
        capture/cart state, and open requested panels.
        """
        result = {"success": True}
        if session:
            result["session"] = self.load_session(session)
        if any(v is not None for v in (seed, analysis_cap, display_cap, spanning)):
            result["reproducibility"] = self.set_reproducibility(
                seed=seed,
                analysis_cap=analysis_cap,
                display_cap=display_cap,
                spanning=spanning,
            )
        if peaks is not None:
            result["peaks"] = self.set_peaks(list(peaks), lock=True, select=True, replace_existing=True)
        if peak_rules is not None:
            result["peak_rules"] = self.set_peak_rules(list(peak_rules), lock=True, clear_peaks=False)
        if footprint_rules is not None:
            result["footprint_rules"] = self.set_footprint_rules(list(footprint_rules))
        if capture_regions is not None:
            result["capture_regions"] = self.set_capture_regions(list(capture_regions))
        if track_cart is not None:
            result["track_cart"] = self.set_track_cart(
                catalog=track_cart.get("catalog"),
                composite_tracks=track_cart.get("composite_tracks"),
                saved_tracks=track_cart.get("saved_tracks"),
            )
        if panels is not None:
            result["panels"] = [self.open_panel(panel) for panel in panels]
        return result

    def cluster_synced_peaks(self, chrom: str = None, start: int = None,
                             end: int = None, dataset_ids: List[str] = None,
                             method: str = None, k: int = None,
                             spanning: bool = None, max_reads: int = None,
                             sample_seed: str = None,
                             cluster_feature_rules: Sequence[dict] = None) -> dict:
        """Run ``cluster_all`` using the browser-synced locked/selected peaks."""
        state = self.get_analysis_state()
        repro = state.get("reproducibility", {})
        if chrom is None or start is None or end is None:
            region = self.get_region()
            chrom = chrom or region["chrom"]
            start = int(start if start is not None else region["start"])
            end = int(end if end is not None else region["end"])
        selected = set(state.get("selected_peaks", []) or [])
        # The browser keeps each selected peak's feature mode in peak_modes
        # (JSON keys are strings); unset means accessibility, as in the browser.
        peak_modes = {str(k): v for k, v in (state.get("peak_modes") or {}).items() if v}
        peak_regions = []
        for peaks in (state.get("peaks_by_rule", {}) or {}).values():
            for peak in peaks or []:
                if selected and peak.get("index") not in selected:
                    continue
                if "start" in peak and "end" in peak:
                    peak_regions.append({
                        "start": int(peak["start"]),
                        "end": int(peak["end"]),
                        "mode": peak_modes.get(str(peak.get("index")), "accessibility"),
                    })
        if not peak_regions:
            peak_regions = [
                {"start": int(p["start"]), "end": int(p["end"]), "mode": p.get("mode", "accessibility")}
                for p in self.get_peaks(selected_only=True, as_dataframe=False)
                if "start" in p and "end" in p
            ]
        if not peak_regions:
            return {"results": {}, "error": "No synced selected peaks available"}
        kwargs = {}
        if max_reads is not None:
            kwargs["max_reads"] = int(max_reads)
        if sample_seed or repro.get("analysis_sample_seed"):
            kwargs["sample_seed"] = sample_seed or repro.get("analysis_sample_seed")
        if cluster_feature_rules is None:
            cluster_feature_rules = (state.get("analysis_rules") or {}).get("cluster_feature_rules") or state.get("cluster_feature_rules")
        if cluster_feature_rules:
            kwargs["cluster_feature_rules"] = list(cluster_feature_rules)
        return self.cluster_all(
            peak_regions=peak_regions,
            k=int(k if k is not None else (repro.get("cluster_k") or 10)),
            method=method or repro.get("cluster_method") or "kmeans",
            dataset_ids=dataset_ids,
            chrom=chrom,
            start=start,
            end=end,
            spanning=bool(spanning if spanning is not None else repro.get("spanning_only", False)),
            **kwargs,
        )

    def sync_jupyter_browser_settings(self, settings: dict) -> dict:
        """Store a browser settings snapshot using the same endpoint as the UI."""
        return self._post("/api/jupyter/settings/sync", dict(settings))

    def sync_browser_settings(self, settings: dict) -> dict:
        """Alias for ``sync_jupyter_browser_settings``."""
        return self.sync_jupyter_browser_settings(settings)

    def save_browser_settings_json(self, filepath: str) -> str:
        """Save current browser settings snapshot as JSON and return filepath."""
        with open(filepath, "w", encoding="utf-8") as handle:
            json.dump({"settings": self.get_browser_settings()}, handle, indent=2)
            handle.write("\n")
        return filepath

    def apply_browser_settings(self, settings: dict, apply_peak_rules: bool = True,
                               clear_peaks: bool = True, rescan: bool = False) -> dict:
        """Apply a settings snapshot captured with ``get_browser_settings``."""
        settings = dict(settings.get("settings", settings))
        result = {"success": True}

        update = {
            key: settings[key]
            for key in (
                "analysis_sample_seed",
                "analysis_sample_count",
                "display_sample_count",
                "read_display_mode",
                "all_reads_display_cap",
                "background_read_cap",
                "spanning_only",
                "active_colormap",
                "selected_peaks",
                "peak_modes",
                "peaks_by_rule",
                "cluster_feature_rules",
                "analysis_sort_rules",
                "analysis_filter_rules",
                "cluster_method",
                "cluster_k",
                "small_footprint_threshold_bp",
                "accessibility_threshold",
                "capture_regions",
                "capture_padding",
                "catalog",
                "composite_tracks",
                "saved_tracks",
                "footprint_groups",
                "selected_genes",
                "transcription_state_filters",
                "primer_saved_primers",
                "primer_mode",
                "primer_cart_track_display",
                "enabled_mod_types",
                "enabled_meta_profiles",
                "cached_layer_types",
                "legacy_layer_inference",
                "legacy_nuc_min_size",
                "click_target_layer",
                "footprint_analysis_layer",
                "coacc_settings",
                "fill_read_height",
                "read_row_height",
                "show_coverage_histogram",
                "max_region_for_reads",
                "show_genome_overview",
                "hidden_strip_panels",
                "open_panel",
                "close_panel",
            )
            if key in settings
        }
        if update:
            result["settings"] = self._post("/api/jupyter/settings", update)

        peak_rules = settings.get("peak_rules")
        if apply_peak_rules and isinstance(peak_rules, list):
            result["peak_rules"] = self.set_peak_rules(
                peak_rules,
                lock=settings.get("peaks_locked"),
                clear_peaks=clear_peaks,
                rescan=rescan,
            )
        elif "peaks_locked" in settings:
            result["peak_lock"] = self.set_peak_lock(bool(settings["peaks_locked"]))

        selected_read_ids = settings.get("selected_read_ids")
        if isinstance(selected_read_ids, dict):
            result["selected_read_ids"] = {
                str(dataset_id): self.set_jupyter_selection(list(read_ids or []), dataset_id=str(dataset_id))
                for dataset_id, read_ids in selected_read_ids.items()
            }

        return result

    def load_browser_settings_json(self, filepath: str, **kwargs) -> dict:
        """Load and apply a JSON settings snapshot saved from the browser."""
        with open(filepath, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return self.apply_browser_settings(payload, **kwargs)

    def set_labeling_preset(self, colormap: dict, apply_quality_filters: bool = True) -> dict:
        """
        Push the active Labeling preset into the live browser.

        ``colormap`` is the JSON object exported by the browser's
        Labeling panel. The key is kept for session/API
        compatibility, but user-facing docs call this a labeling preset. It
        includes labeling rules, quality gates,
        analysis quality filters, display quality shading, and TF overlay
        settings.
        """
        preset = self._json_safe(dict(colormap))
        if isinstance(preset, dict):
            for filt in preset.get("qualityFilters") or []:
                if not isinstance(filt, dict):
                    continue
                layer = filt.get("layer", "*")
                filt["layer"] = (
                    "*" if str(layer or "*").strip() == "*"
                    else (self._normalize_annotation_layer(layer) or "*")
                )
            for rule in preset.get("rules") or []:
                if not isinstance(rule, dict):
                    continue
                if isinstance(rule.get("targetLayers"), list):
                    normalized_layers = []
                    for layer in rule["targetLayers"]:
                        normalized = self._normalize_annotation_layer(layer)
                        if normalized and normalized not in normalized_layers:
                            normalized_layers.append(normalized)
                    rule["targetLayers"] = normalized_layers
        result = self._post("/api/jupyter/settings", {
            "active_colormap": preset,
        })
        if apply_quality_filters and isinstance(preset, dict) and "qualityFilters" in preset:
            result = dict(result or {})
            result["quality_filters"] = self.set_quality_filters(preset.get("qualityFilters") or [])
        return result

    def load_labeling_json(self, filepath: str, apply_quality_filters: bool = True) -> dict:
        """Load a Labeling JSON export into the live browser."""
        with open(filepath, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict) or not isinstance(payload.get("rules"), list):
            raise ValueError("Labeling JSON must be a preset object with a `rules` list")
        return self.set_labeling_preset(payload, apply_quality_filters=apply_quality_filters)

    def save_labeling_json(self, filepath: str) -> str:
        """Save the currently synced browser Labeling preset as JSON."""
        colormap = self.get_browser_settings().get("active_colormap")
        if not colormap:
            raise ValueError("No active Labeling preset has been synced from the browser yet")
        with open(filepath, "w", encoding="utf-8") as handle:
            json.dump(colormap, handle, indent=2)
            handle.write("\n")
        return filepath

    def set_colormap(self, colormap: dict, **kwargs) -> dict:
        """Backward-compatible alias for ``set_labeling_preset``."""
        return self.set_labeling_preset(colormap, **kwargs)

    def load_colormap_json(self, filepath: str, **kwargs) -> dict:
        """Backward-compatible alias for ``load_labeling_json``."""
        return self.load_labeling_json(filepath, **kwargs)

    def save_colormap_json(self, filepath: str) -> str:
        """Backward-compatible alias for ``save_labeling_json``."""
        return self.save_labeling_json(filepath)

    def get_labeling_preset(self) -> dict:
        """Return a copy of the currently synced Labeling preset."""
        preset = self.get_browser_settings().get("active_colormap")
        if not isinstance(preset, dict) or not isinstance(preset.get("rules"), list):
            raise ValueError("No active Labeling preset has been synced from the browser yet")
        return json.loads(json.dumps(preset))

    @staticmethod
    def _normalize_hex_color(color: str, field: str) -> str:
        value = str(color).strip()
        if (
            len(value) == 7
            and value[0] == "#"
            and all(char in "0123456789abcdefABCDEF" for char in value[1:])
        ):
            return value.lower()
        raise ValueError(f"{field} must be a #RRGGBB color")

    @staticmethod
    def _bounded_float(value: Any, field: str, lower: float, upper: float) -> float:
        numeric = float(value)
        if not math.isfinite(numeric) or numeric < lower or numeric > upper:
            raise ValueError(f"{field} must be between {lower:g} and {upper:g}")
        return numeric

    def set_labeling_display(self, *, read_background: str = None,
                             no_read_background: str = None,
                             smoothing_enabled: bool = None,
                             smoothing_sigma_x: float = None,
                             smoothing_sigma_y: float = None,
                             layer_opacities: Dict[str, float] = None,
                             edge_mode: str = None,
                             edge_apply_nuc: bool = None,
                             edge_apply_tf: bool = None,
                             apply_quality_filters: bool = True) -> dict:
        """Update Labeling display controls from Python/Jupyter.

        These fields are part of the active labeling preset, so they are saved
        with sessions and exported labeling JSON. ``layer_opacities`` accepts
        canonical layers and aliases such as ``msp`` -> ``fire``.
        """
        preset = self.get_labeling_preset()

        if read_background is not None:
            preset["readBackgroundColor"] = self._normalize_hex_color(read_background, "read_background")

        if no_read_background is not None:
            color = self._normalize_hex_color(no_read_background, "no_read_background")
            preset["noReadBackgroundColor"] = color
            preset["backgroundColor"] = color

        if any(value is not None for value in (smoothing_enabled, smoothing_sigma_x, smoothing_sigma_y)):
            current = preset.get("displaySmoothing")
            if not isinstance(current, dict):
                current = {}
            smoothing = {
                "enabled": bool(current.get("enabled", False)),
                "sigmaX": self._bounded_float(current.get("sigmaX", 0), "smoothing_sigma_x", 0, 10),
                "sigmaY": self._bounded_float(current.get("sigmaY", 0), "smoothing_sigma_y", 0, 10),
            }
            if smoothing_enabled is not None:
                smoothing["enabled"] = bool(smoothing_enabled)
            if smoothing_sigma_x is not None:
                smoothing["sigmaX"] = self._bounded_float(smoothing_sigma_x, "smoothing_sigma_x", 0, 10)
            if smoothing_sigma_y is not None:
                smoothing["sigmaY"] = self._bounded_float(smoothing_sigma_y, "smoothing_sigma_y", 0, 10)
            preset["displaySmoothing"] = smoothing

        if layer_opacities is not None:
            if not isinstance(layer_opacities, dict):
                raise ValueError("layer_opacities must be a dict of layer -> opacity")
            current = preset.get("layerOpacities")
            opacities = dict(current) if isinstance(current, dict) else {}
            for layer, opacity in layer_opacities.items():
                normalized = self._normalize_annotation_layer(layer)
                if not normalized:
                    raise ValueError(f"Invalid layer opacity key: {layer!r}")
                opacities[normalized] = self._bounded_float(opacity, f"opacity for {normalized}", 0, 1)
            preset["layerOpacities"] = opacities

        if any(value is not None for value in (edge_mode, edge_apply_nuc, edge_apply_tf)):
            # Edges: 'strict' = conservative span, 'soft' = gradient by edge
            # confidence, 'loose' = liberal boundary.
            edges = dict(preset.get("edgeAmbiguity") or {})
            if edge_mode is not None:
                if edge_mode not in ("strict", "soft", "loose"):
                    raise ValueError("edge_mode must be 'strict', 'soft' or 'loose'")
                edges["mode"] = edge_mode
            if edge_apply_nuc is not None:
                edges["applyNuc"] = bool(edge_apply_nuc)
            if edge_apply_tf is not None:
                edges["applyTf"] = bool(edge_apply_tf)
            preset["edgeAmbiguity"] = edges

        return self.set_labeling_preset(preset, apply_quality_filters=apply_quality_filters)

    def set_layer_opacity(self, layer: str, opacity: float,
                          apply_quality_filters: bool = True) -> dict:
        """Set one Labeling layer opacity from Python/Jupyter."""
        return self.set_labeling_display(
            layer_opacities={layer: opacity},
            apply_quality_filters=apply_quality_filters,
        )

    def add_labeling_rule(self, name: str, color: str = "#888888",
                          size_min: int = 1, size_max: Optional[int] = None,
                          target_layers: Sequence[str] = None,
                          conditions: Sequence[dict] = None,
                          quality_gates: Sequence[dict] = None,
                          enabled: bool = True) -> dict:
        """Append one labeling rule to the live browser preset.

        Use this for reproducible notebook-driven labeling. Field names map
        directly to the browser JSON schema: ``targetLayers``, ``conditions``,
        and ``qualityGates``.
        """
        preset = self.get_labeling_preset()
        rule = {
            "id": f"nb_{uuid.uuid4().hex[:8]}",
            "name": name,
            "color": color,
            "sizeMin": int(size_min),
            "sizeMax": None if size_max is None else int(size_max),
            "targetLayers": list(target_layers or []),
            "conditions": list(conditions or []),
            "qualityGates": list(quality_gates or []),
            "enabled": bool(enabled),
        }
        preset["rules"].append(rule)
        return self.set_labeling_preset(preset)

    def add_pol2_gene_exclusion_rule(self, gene_name: str = None, gene_id: str = None,
                                     name: str = None, color: str = "#ff69b4",
                                     size_min: int = 35, size_max: int = 65) -> dict:
        """Append a Pol II-sized footprint rule excluding one gene.

        This mirrors the browser's "Pol II footprints NOT in gene X" quick-add
        control and is intended for reproducible overlapping-gene exclusions.
        Supply at least one of ``gene_name`` or ``gene_id``.
        """
        if not gene_name and not gene_id:
            raise ValueError("Supply gene_name or gene_id")
        label = gene_name or gene_id
        return self.add_labeling_rule(
            name=name or f"Pol II not {label}",
            color=color,
            size_min=size_min,
            size_max=size_max,
            conditions=[{
                "target": "gene",
                "geneId": gene_id,
                "geneName": gene_name,
                "negate": True,
            }],
        )

    def set_peak_rules(self, rules: Sequence[dict], lock: bool = None,
                       clear_peaks: bool = True, rescan: bool = False) -> dict:
        """
        Push exact peak-rule settings into the live browser.

        Args:
            rules: List of Peak Rule dictionaries, matching the UI JSON export.
            lock: Optional peak-lock state to apply after import. ``None`` leaves
                the browser's current lock state unchanged.
            clear_peaks: Clear stale peak calls and signal caches after changing rules.
            rescan: Ask the browser to rescan enabled non-custom rules after import.
        """
        body = {
            "rules": [self._json_safe(dict(rule)) for rule in rules],
            "lock": lock,
            "clear_peaks": bool(clear_peaks),
            "rescan": bool(rescan),
        }
        return self._post("/api/jupyter/peak_rules", body)

    def set_peak_lock(self, locked: bool = True) -> dict:
        """Set the live browser peak-lock state without changing peak rules."""
        return self._post("/api/jupyter/peak_rules", {
            "rules": [],
            "lock": bool(locked),
            "clear_peaks": False,
            "rescan": False,
        })

    def lock_peaks(self) -> dict:
        """Lock current browser peaks so autoscan cannot move them."""
        return self.set_peak_lock(True)

    def unlock_peaks(self) -> dict:
        """Unlock current browser peaks so peak rules can rescan."""
        return self.set_peak_lock(False)

    def load_peak_rules_json(self, filepath: str, lock: bool = None,
                             clear_peaks: bool = True, rescan: bool = False) -> dict:
        """
        Load a Peak Rules JSON export into the live browser.

        Accepts either the UI export shape ``{"rules": [...]}`` or a raw list
        of rule dictionaries.
        """
        with open(filepath, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        rules = payload.get("rules") if isinstance(payload, dict) else payload
        if not isinstance(rules, list):
            raise ValueError("Peak rules JSON must contain a `rules` list or be a list of rules")
        return self.set_peak_rules(rules, lock=lock, clear_peaks=clear_peaks, rescan=rescan)

    def reload_peak_rules_json(self, filepath: str, **kwargs) -> dict:
        """Alias for ``load_peak_rules_json``."""
        return self.load_peak_rules_json(filepath, **kwargs)

    def import_peak_rules_json(self, filepath: str, **kwargs) -> dict:
        """Alias for ``load_peak_rules_json``."""
        return self.load_peak_rules_json(filepath, **kwargs)

    def get_meta(self, chrom: str = None, start: int = None, end: int = None,
                 dataset_id: str = None,
                 read_ids: Optional[List[str]] = None) -> dict:
        """
        Get meta profile (nucleosome and small-footprint occupancy) for a region.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            dataset_id: Dataset ID (default: browser's first/current dataset)
            read_ids: Optional subset of read IDs to compute the profile over.
                Prefer this over a separate ``filter_reads()`` call — the
                metaprofile is computed locally from the subset and gets its
                own cache entry, avoiding fragile global-filter coupling.

        Returns:
            dict with 'nucleosome_profile' and 'subnuc_profile' lists
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        if dataset_id:
            params['dataset_id'] = dataset_id
        if read_ids is not None:
            # Comma-separated; the server splits and dedups. Large subsets
            # (>~hundreds of ids) should be paginated — query-string length
            # limits apply. An empty list is sent as an empty value: a
            # selection matching no reads, not "all reads".
            params['read_ids'] = ",".join(str(rid) for rid in read_ids)
        return self._get("/api/meta", params)

    def get_fire(self, chrom: str = None, start: int = None,
                 end: int = None) -> dict:
        """
        Get FIRE peaks and signal for a region.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position

        Returns:
            dict with 'peaks', 'signal', and 'type' keys
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        return self._get("/api/fire", {'chrom': chrom, 'start': int(start), 'end': int(end)})

    def clear_cache(self) -> dict:
        """Clear all server-side read caches to force fresh data loading."""
        return self._post("/api/clear_cache")

    def get_working_set_info(self, chrom: str = None, start: int = None,
                             end: int = None, dataset_id: str = None,
                             spanning: bool = False,
                             sample_seed: str = None) -> dict:
        """
        Get info about the working set for a region.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            dataset_id: Dataset ID (default: browser's first/current dataset)
            spanning: Only count spanning reads
            sample_seed: Optional seed for reproducible backend working-set caps

        Returns:
            dict with working_count, total_spanning, has_clusters, etc.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        if dataset_id:
            params['dataset_id'] = dataset_id
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._get("/api/working_set_info", params)

    def get_read_info(self, chrom: str = None, start: int = None,
                      end: int = None, spanning: bool = False) -> dict:
        """
        Get read count for a region.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only count spanning reads

        Returns:
            dict with 'count'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        return self._get("/api/reads/info", {
            'chrom': chrom, 'start': int(start), 'end': int(end),
            'spanning': str(spanning).lower()
        })

    # =========================================================================
    # Track Management
    # =========================================================================

    def get_tracks(self) -> List[dict]:
        """
        Get list of loaded orthogonal tracks (bigWig, bigBed, etc.).

        Returns:
            List of track dicts
        """
        data = self._get("/api/tracks")
        # The route answers {"tracks": [...]}; older servers sent the list itself.
        return data.get("tracks", []) if isinstance(data, dict) else list(data or [])

    def get_tracks_batch(self, track_indices: Sequence[int], chrom: str = None,
                         start: int = None, end: int = None, bins: int = 500,
                         annotation_filters: Dict[int, Sequence[str]] = None) -> dict:
        """Fetch multiple signal/annotation track payloads in one request."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        body = {
            "track_indices": [int(idx) for idx in track_indices],
            "chrom": chrom,
            "start": int(start),
            "end": int(end),
            "bins": int(bins),
            "annotation_filters": {
                int(idx): [str(name) for name in names]
                for idx, names in (annotation_filters or {}).items()
                if names
            },
        }
        return self._post("/api/tracks/batch", body)

    def add_track(self, path: str, label: str = None,
                  render_mode: str = None, track_type: str = None,
                  ucsc_genome: str = None, ucsc_track: str = None,
                  filter_names: Optional[Union[str, Sequence[str]]] = None,
                  category: str = None) -> dict:
        """
        Add an orthogonal track (bigWig, bigBed, BED, or UCSC API track).

        Args:
            path: File path or ucsc:// URL
            label: Display label
            render_mode: Rendering mode (e.g. 'signal', 'annotation')
            track_type: Optional explicit track type
            ucsc_genome: Genome ID for UCSC-backed tracks
            ucsc_track: UCSC table/track ID
            filter_names: Optional annotation-name filter to apply immediately
            category: Optional track-browser category label

        Returns:
            dict with success status and track info
        """
        params = {'path': path}
        if label:
            params['label'] = label
        if render_mode:
            params['render_mode'] = render_mode
        if track_type:
            params['track_type'] = track_type
        if ucsc_genome:
            params['ucsc_genome'] = ucsc_genome
        if ucsc_track:
            params['ucsc_track'] = ucsc_track
        names = self._comma_param(filter_names)
        if names:
            params['filter_names'] = names
        if category:
            params['category'] = category
        return self._post("/api/add_track", params=params)

    def export_track(self, track_idx: int, chrom: str, start: int, end: int,
                     format: str = "bedgraph", bins: int = 2000,
                     output_path: str = None) -> bytes:
        """Export one track region as bytes; optionally write to `output_path`."""
        params = {
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'format': format,
            'bins': int(bins),
        }
        r = self._get_response(f"/api/tracks/{track_idx}/export", params=params, timeout=60)
        if output_path:
            with open(output_path, 'wb') as fh:
                fh.write(r.content)
        return r.content

    def export_tracks_multi(self, track_indices: List[int], labels: List[str],
                            chrom: str, start: int, end: int,
                            bins: int = 2000,
                            output_path: str = None) -> bytes:
        """Export multiple tracks as TSV bytes; optionally write to `output_path`."""
        body = {
            'track_indices': track_indices,
            'labels': labels,
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'bins': int(bins),
        }
        r = self._post_response("/api/tracks/export", data=body, timeout=60)
        if output_path:
            with open(output_path, 'wb') as fh:
                fh.write(r.content)
        return r.content

    def remove_track(self, track_idx: int) -> dict:
        """
        Remove an orthogonal track by index.

        Args:
            track_idx: Index of the track to remove
        """
        return self._delete(f"/api/tracks/{track_idx}")

    # =========================================================================
    # GTF & Genome Management
    # =========================================================================

    def pick_folder(self) -> dict:
        """Open the backend folder picker."""
        return self._get("/api/pick_folder")

    def load_folder(self, path: str) -> dict:
        """Load a folder dataset via the same endpoint used by the UI."""
        return self._post("/api/load_folder", params={'path': path})

    def pick_file(self, file_type: str = "gtf") -> dict:
        """Open the backend file picker for a specific file type."""
        return self._get("/api/pick_file", params={'file_type': file_type})

    def pick_dataset(self) -> dict:
        """Pick one or more dataset files."""
        return self._get("/api/pick_file", params={'file_type': 'dataset', 'multiple': 'true'})

    def pick_any_file(self) -> dict:
        """Pick one or more supported data files."""
        return self._get("/api/pick_file", params={'file_type': 'any', 'multiple': 'true'})

    def pick_overlay_file(self, overlay_type: str = None) -> dict:
        """Pick an overlay file, optionally constrained by overlay type."""
        params = {'file_type': 'overlay'}
        if overlay_type:
            params['overlay_type'] = overlay_type
        return self._get("/api/pick_file", params=params)

    def pick_annotation_file(self) -> dict:
        """Pick an annotation BigBed file."""
        return self._get("/api/pick_file", params={'file_type': 'annotation'})

    def pick_file_primer(self, file_type: str) -> dict:
        """Pick primer-design support files (`fasta` or `blast`)."""
        return self._get("/api/pick_file_primer", params={'file_type': file_type})

    def upload_file(self, file_path: str) -> dict:
        """Upload a local file to the browser process."""
        with open(file_path, 'rb') as fh:
            return self._post_response("/api/files/upload", files={'file': fh}, timeout=60).json()

    def load_gtf(self, path: str) -> dict:
        """
        Load a GTF or GFF3 annotation file.

        Args:
            path: Path to GTF/GFF3 file (plain or gzipped)

        Returns:
            dict with success status and gene_count
        """
        return self._post("/api/load_gtf", params={'path': path})

    def remove_gtf(self) -> dict:
        """Remove loaded GTF annotations."""
        return self._delete("/api/gtf")

    def get_genomes(self) -> List[dict]:
        """
        Get list of available online genomes.

        Returns:
            List of genome dicts with 'id', 'name', 'gtf_label'
        """
        result = self._get("/api/genomes")
        return result.get('genomes', [])

    def load_genome(self, genome_id: str) -> dict:
        """
        Load an online genome (remote FASTA + cached GTF).

        Args:
            genome_id: Genome identifier (e.g. 'dm6', 'hg38')

        Returns:
            dict with success status and details
        """
        return self._post("/api/load_genome", params={'genome_id': genome_id})

    def load_fasta(self, path: str) -> dict:
        """
        Load a reference FASTA file at runtime.

        Args:
            path: Path to FASTA file (must have .fai index)

        Returns:
            dict with success status, path, and number of sequences
        """
        return self._post("/api/load_fasta", params={'path': path})

    def load_plasmid(self, path: str) -> dict:
        """
        Load a native plasmid/genome map as a supplemental chromosome.

        Supported formats include GenBank, SnapGene, EMBL, FASTA with a
        same-name GFF3/GFF/BED companion, annotation-first GFF3/GFF/BED with a
        same-name FASTA companion, and SBOL RDF/XML/Turtle.

        Args:
            path: Path to the plasmid map, FASTA, or companion annotation file

        Returns:
            dict with success status, reference name, length, circular flag,
            feature_count, and optional warnings
        """
        return self._post("/api/load_plasmid", params={'path': path})

    def load_plasmids(self, paths: list[str]) -> dict:
        """
        Load multiple native plasmid/genome maps as supplemental chromosomes.

        Args:
            paths: Paths to plasmid maps, FASTA files, or companion annotation files

        Returns:
            dict with loaded entries, per-path errors, and loaded count
        """
        return self._post("/api/load_plasmids", data={'paths': list(paths)})

    def set_circular_chrom(self, chrom: str, circular: bool = True) -> dict:
        """
        Mark or unmark a loaded chromosome/reference as circular.

        Args:
            chrom: Chromosome/reference name
            circular: True to mark circular, False to mark linear

        Returns:
            dict with success status, chrom, circular, and size
        """
        return self._post("/api/circular_chrom", params={
            'chrom': chrom,
            'circular': bool(circular),
        })

    def mark_circular_chrom(self, chrom: str) -> dict:
        """Convenience wrapper for set_circular_chrom(chrom, True)."""
        return self.set_circular_chrom(chrom, True)

    def mark_linear_chrom(self, chrom: str) -> dict:
        """Convenience wrapper for set_circular_chrom(chrom, False)."""
        return self.set_circular_chrom(chrom, False)

    def get_sequence(self, chrom: str, start: int, end: int) -> dict:
        """
        Get reference DNA sequence for a region (max 10kb).

        Args:
            chrom: Chromosome
            start: Start position
            end: End position

        Returns:
            dict with 'sequence', 'chrom', 'start', 'end'
        """
        return self._get("/api/sequence", {
            'chrom': chrom, 'start': int(start), 'end': int(end)
        })

    def search_gene(self, query: str) -> dict:
        """
        Search for a gene by name.

        Args:
            query: Gene name or partial name

        Returns:
            dict with 'found', 'chrom', 'start', 'end', 'gene_name'
            (or 'suggestions' if partial match)
        """
        return self._get("/api/gene_search", {'query': query})

    # =========================================================================
    # Overlay Management
    # =========================================================================

    def get_overlays(self) -> List[dict]:
        """
        Get list of loaded modification overlays.

        Returns:
            List of overlay dicts with 'id', 'label', 'path', 'type', 'color'
        """
        result = self._get("/api/overlays")
        return result.get('overlays', [])

    def add_overlay(self, path: str, overlay_type: str = None) -> dict:
        """
        Add a modification overlay from a bigBed file.

        Type is auto-detected from filename (_m6a, _m5c, _footprint, _msp)
        unless explicitly specified. Legacy _msp files are user-facing FIRE.

        Args:
            path: Path to bigBed overlay file or directory
            overlay_type: Override type ('m6a', 'm5c', 'footprint', 'fire'/'msp')

        Returns:
            dict with overlay info
        """
        data = {'path': path}
        if overlay_type:
            data['type'] = overlay_type
        return self._post("/api/overlays/add", data)

    def remove_overlay(self, overlay_id: str) -> dict:
        """
        Remove a modification overlay.

        Args:
            overlay_id: ID of the overlay to remove
        """
        return self._delete(f"/api/overlays/{overlay_id}")

    # =========================================================================
    # Co-Accessibility
    # =========================================================================

    def get_coacc_matrix(self, chrom: str = None, start: int = None,
                         end: int = None, normalization: str = 'oe',
                         bin_size: int = 0, min_coverage: int = 20,
                         dataset_id: str = None,
                         dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                         signal_type: str = 'accessibility',
                         layer: str = None,
                         read_ids: List[str] = None,
                         read_ids_by_dataset: Dict[str, List[str]] = None,
                         sample_seed: str = None,
                         as_dataframe: bool = True) -> Union['np.ndarray', 'pd.DataFrame']:
        """Get co-accessibility matrix as numpy array or pandas DataFrame.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            normalization: 'raw', 'oe', 'oe_distance', or 'correlation'
            bin_size: Bin size in bp (0 = auto)
            min_coverage: Minimum read coverage per bin pair
            dataset_id: Specific dataset ID (default: all)
            dataset_ids: Dataset IDs for combined/cohort matrix
            signal_type: 'accessibility', 'nucleosome', 'small_fp', 'linker', 'all_fp'
            layer: Annotation layer name (e.g. 'fire', 'tf') overriding size heuristics
            read_ids: Optional read IDs to restrict the computation
            read_ids_by_dataset: Optional dataset-scoped read IDs for multi-dataset scopes
            as_dataframe: Return as pandas DataFrame (default: True)

        Returns:
            numpy array or pandas DataFrame with co-accessibility values
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'normalization': normalization, 'bin_size': bin_size,
                  'min_coverage': min_coverage}
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        resp = self._get('/api/coacc/matrix/data', params=params)
        np = _ensure_numpy()
        matrix = np.array([[v if v is not None else float('nan') for v in row]
                           for row in resp['matrix']])
        if as_dataframe:
            pd = _ensure_pandas()
            labels = [f"{resp['chrom']}:{resp['start'] + i * resp['bin_size']}"
                      for i in range(resp['n_bins'])]
            return pd.DataFrame(matrix, index=labels, columns=labels)
        return matrix

    def get_coacc_matrix_data(self, chrom: str, start: int, end: int,
                              bin_size: int = None,
                              dataset_ids: List[str] = None,
                              normalization: str = None,
                              min_coverage: int = None,
                              read_ids: List[str] = None,
                              read_ids_by_dataset: Dict[str, List[str]] = None,
                              signal_type: str = None,
                              layer: str = None,
                              sample_seed: str = None) -> dict:
        """Frontend-name wrapper returning the raw co-accessibility response."""
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        if bin_size is not None:
            params['bin_size'] = int(bin_size)
        dataset_ids_param = self._comma_param(dataset_ids)
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if normalization:
            params['normalization'] = normalization
        if min_coverage is not None:
            params['min_coverage'] = int(min_coverage)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if signal_type and signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._get('/api/coacc/matrix/data', params=params)

    def get_coacc_slice(self, position: int, chrom: str = None,
                        start: int = None, end: int = None,
                        normalization: str = 'oe', bin_size: int = 0,
                        min_coverage: int = 20,
                        dataset_id: str = None,
                        dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                        signal_type: str = 'accessibility',
                        layer: str = None,
                        read_ids: List[str] = None,
                        read_ids_by_dataset: Dict[str, List[str]] = None,
                        sample_seed: str = None) -> dict:
        """Get 1D co-accessibility profile from a viewpoint position (virtual 4C).

        Args:
            position: Genomic position of viewpoint
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            normalization: Normalization method
            bin_size: Bin size in bp (0 = auto)
            min_coverage: Minimum coverage threshold
            dataset_id: Specific dataset ID (default: all)
            dataset_ids: Dataset IDs for combined/cohort profile
            signal_type: Signal source for bin accessibility
            layer: Annotation layer name (e.g. 'fire', 'tf') overriding size heuristics
            read_ids: Optional read IDs to restrict the computation
            read_ids_by_dataset: Optional dataset-scoped read IDs for multi-dataset scopes

        Returns:
            dict with 'profile', 'coverage', 'bin_size', 'n_bins',
            'viewpoint_bin', 'viewpoint_start', 'viewpoint_end'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'position': int(position), 'normalization': normalization,
                  'bin_size': bin_size, 'min_coverage': min_coverage}
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._get('/api/coacc/slice', params=params)

    def get_coacc_arcs(self, chrom: str = None, start: int = None,
                       end: int = None, threshold: float = 1.5,
                       normalization: str = 'oe', bin_size: int = 0,
                       min_coverage: int = 20, max_arcs: int = 200,
                       dataset_id: str = None,
                       dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                       signal_type: str = 'accessibility',
                       layer: str = None,
                       read_ids: List[str] = None,
                       read_ids_by_dataset: Dict[str, List[str]] = None,
                       min_distance: int = 2,
                       sample_seed: str = None,
                       as_dataframe: bool = True) -> Union['pd.DataFrame', dict]:
        """Get top co-accessible pairs as arcs.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            threshold: Minimum value to include
            normalization: Normalization method
            bin_size: Bin size in bp (0 = auto)
            min_coverage: Minimum coverage threshold
            max_arcs: Maximum number of arcs to return
            dataset_id: Specific dataset ID (default: all)
            dataset_ids: Dataset IDs for combined/cohort arcs
            signal_type: Signal source for bin accessibility
            layer: Annotation layer name (e.g. 'fire', 'tf') overriding size heuristics
            read_ids: Optional read IDs to restrict the computation
            read_ids_by_dataset: Optional dataset-scoped read IDs for multi-dataset scopes
            min_distance: Minimum bin distance between arc endpoints
            as_dataframe: Return arcs as pandas DataFrame (default: True)

        Returns:
            DataFrame or dict with arcs (start, end, strength, coverage)
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'threshold': threshold, 'normalization': normalization,
                  'bin_size': bin_size, 'min_coverage': min_coverage,
                  'max_arcs': max_arcs, 'min_distance': min_distance}
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        resp = self._get('/api/coacc/arcs', params=params)
        if as_dataframe:
            pd = _ensure_pandas()
            arcs = resp.get('arcs', [])
            if not arcs:
                return pd.DataFrame(columns=['start', 'end', 'strength', 'coverage'])
            return pd.DataFrame(arcs)
        return resp

    def get_coacc_matrix_png(self, chrom: str = None, start: int = None,
                             end: int = None,
                             dataset_id: str = None,
                             dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                             normalization: str = 'oe',
                             scaling: str = 'linear',
                             colormap: str = 'fall',
                             vmin: float = None,
                             vmax: float = None,
                             bin_size: int = 0,
                             min_coverage: int = 20,
                             signal_type: str = 'accessibility',
                             layer: str = None,
                             read_ids: List[str] = None,
                             read_ids_by_dataset: Dict[str, List[str]] = None,
                             sample_seed: str = None,
                             output_path: str = None) -> bytes:
        """Return the co-accessibility matrix PNG used by the browser panel."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'normalization': normalization,
            'scaling': scaling,
            'colormap': colormap,
            'bin_size': int(bin_size),
            'min_coverage': int(min_coverage),
        }
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if vmin is not None:
            params['vmin'] = float(vmin)
        if vmax is not None:
            params['vmax'] = float(vmax)
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        content = self._get_bytes('/api/coacc/matrix/image', params=params)
        if output_path:
            with open(output_path, 'wb') as handle:
                handle.write(content)
        return content

    def save_coacc_matrix_png(self, filepath: str, **kwargs) -> str:
        """Save the co-accessibility matrix PNG and return ``filepath``."""
        self.get_coacc_matrix_png(output_path=filepath, **kwargs)
        return filepath

    def get_coacc_strip_png(self, chrom: str = None, start: int = None,
                            end: int = None,
                            width: int = 800,
                            height: int = 120,
                            dataset_id: str = None,
                            dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                            normalization: str = 'oe',
                            scaling: str = 'linear',
                            colormap: str = 'fall',
                            bin_size: int = 0,
                            min_coverage: int = 20,
                            signal_type: str = 'accessibility',
                            layer: str = None,
                            read_ids: List[str] = None,
                            read_ids_by_dataset: Dict[str, List[str]] = None,
                            sample_seed: str = None,
                            output_path: str = None) -> bytes:
        """Return the compact triangular co-accessibility strip PNG used by the track."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'width': int(width),
            'height': int(height),
            'normalization': normalization,
            'scaling': scaling,
            'colormap': colormap,
            'bin_size': int(bin_size),
            'min_coverage': int(min_coverage),
        }
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        content = self._get_bytes('/api/coacc/strip', params=params)
        if output_path:
            with open(output_path, 'wb') as handle:
                handle.write(content)
        return content

    def save_coacc_strip_png(self, filepath: str, **kwargs) -> str:
        """Save the co-accessibility track strip PNG and return ``filepath``."""
        self.get_coacc_strip_png(output_path=filepath, **kwargs)
        return filepath

    # UI/API wording aliases for byte-returning helpers.
    get_coacc_matrix_image = get_coacc_matrix_png
    get_coacc_strip_image = get_coacc_strip_png

    # =========================================================================
    # Analysis Methods
    # =========================================================================

    def scan_peaks(self, chrom: str = None, start: int = None, end: int = None,
                   dataset_id: str = None, dataset_ids: Union[str, Sequence[str]] = None,
                   spanning: bool = False, signal_source: str = None,
                   read_ids: Optional[Sequence[str]] = None,
                   read_ids_by_dataset: Optional[Dict[str, Sequence[str]]] = None,
                   sample_seed: str = None, return_signal: bool = False,
                   **kwargs) -> dict:
        """
        Scan for peaks using multi-threshold detection.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            dataset_id: Legacy single dataset ID query param
            dataset_ids: Explicit dataset scope for multi-dataset scans
            spanning: Only use spanning reads
            signal_source: Signal to scan (default 'accessibility'). One of:
                           'accessibility' — coverage of sub-90bp footprints
                           'fire' — fraction of reads with a FIRE interval
                           'tf_density' — fraction of footprints in 20-65bp TF range
                           'tf_layer' / 'nuc_layer' — v3 per-layer intervals
                           'msp' — legacy alias for FIRE
                           'm6a' / 'm5c' / 'deam' — per-base modification density
                           'layer:<name>' — any interval layer (e.g. 'layer:ctcf')
            read_ids: Optional legacy read ID scope
            read_ids_by_dataset: Optional dataset-scoped read IDs to match browser UI scope
            sample_seed: Optional reproducibility seed for backend sampling
            return_signal: Include the binned signal arrays in the response
            **kwargs: Additional ScanPeaksRequest fields (min_width, min_reads,
                      smooth_width, threshold_strong, threshold_medium,
                      max_peak_width (default 2000 bp; wider calls are the
                      view's background and come back as 'broad_peaks';
                      0 = no limit), etc.)

        Returns:
            dict with 'peaks', 'layer_info', 'n_reads'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        if dataset_id:
            params['dataset_id'] = dataset_id
        data = dict(kwargs) if kwargs else {}
        if signal_source:
            data['signal_source'] = signal_source
        ds_list = self._list_param(dataset_ids)
        if ds_list is not None:
            data['dataset_ids'] = ds_list
        if read_ids is not None:
            data['read_ids'] = [str(read_id) for read_id in read_ids]
        if read_ids_by_dataset is not None:
            data['read_ids_by_dataset'] = {
                str(dataset_id): [str(read_id) for read_id in scoped_read_ids]
                for dataset_id, scoped_read_ids in read_ids_by_dataset.items()
            }
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        if return_signal:
            data['return_signal'] = True
        return self._post("/api/scan_peaks", data=data, params=params)

    def cluster(self, peak_indices: List[int], k: int = 5,
                chrom: str = None, start: int = None, end: int = None,
                spanning: bool = False, dataset_id: str = None,
                filter_mode: str = "either",
                min_footprints: int = 0,
                sample_seed: str = None) -> dict:
        """
        Cluster reads for a single dataset using k-means.

        Args:
            peak_indices: Indices of peaks to use for clustering
            k: Number of clusters (default: 5)
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            dataset_id: Dataset ID (default: browser's first/current dataset)
            min_footprints: Min footprints per read

        Returns:
            dict with 'assignments', 'cluster_counts', 'filtered_read_ids'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower(),
                  'min_footprints': min_footprints}
        if dataset_id:
            params['dataset_id'] = dataset_id
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._post("/api/cluster",
                          data={'peak_indices': peak_indices, 'k': k, 'filter_mode': filter_mode},
                          params=params)

    def cluster_reads(self, chrom: str, start: int, end: int,
                      peak_indices: List[int], k: int,
                      filter_mode: str = "either", spanning: bool = False,
                      dataset_id: str = None,
                      sample_seed: str = None) -> dict:
        """Alias matching the frontend `clusterReads` helper."""
        return self.cluster(
            peak_indices=peak_indices,
            k=k,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_id=dataset_id,
            filter_mode=filter_mode,
            sample_seed=sample_seed,
        )

    @staticmethod
    def make_peaks(regions: list, mode: str = 'accessibility') -> List[dict]:
        """Create peak region dicts for clustering from simple coordinate tuples.

        Args:
            regions: List of (start, end) tuples, or (start, end, mode) tuples,
                or dicts with 'start'/'end' keys. Coordinates are absolute genomic.
            mode: Default peak mode. Accepted values:
                'accessibility' — primary-interval short footprints
                'fire' — FIRE coverage (aliases legacy internal MSP/as-al intervals)
                'tf' / 'tf_layer' — v3 TF-layer intervals (falls back to size)
                'nuc' / 'nuc_layer' — v3 nucleosome-layer intervals
                'msp' — legacy alias for FIRE intervals
                'modification' / 'mod' / 'm6a' — m6A presence (methyl_m6a)
                'm5c' — 5mC presence (methyl_m5c)
                'deam' — deamination presence (deam positions)
                '<custom>' — any named layer from dataset.available_layers

        Returns:
            List of peak region dicts suitable for cluster_all(peak_regions=...)

        Example::

            # Define 3 peak regions manually
            peaks = b.make_peaks([(1000, 1500), (2000, 2800), (3500, 4000)])
            result = b.cluster_all(peak_regions=peaks, k=5, method='kmeans')

            # Or with per-peak modes
            peaks = b.make_peaks([
                (1000, 1500, 'accessibility'),
                (2000, 2800, 'tf'),
            ])
        """
        out = []
        for r in regions:
            if isinstance(r, dict):
                d = {'start': r['start'], 'end': r['end'],
                     'mode': r.get('mode', mode)}
            elif isinstance(r, (list, tuple)):
                d = {'start': int(r[0]), 'end': int(r[1]),
                     'mode': r[2] if len(r) > 2 else mode}
            else:
                continue
            out.append(d)
        return out

    def scan_and_cluster(self, k: int = 5, method: str = 'kmeans',
                         signal_source: str = 'accessibility',
                         min_layer: int = 0, max_layer: int = None,
                         chrom: str = None, start: int = None, end: int = None,
                         spanning: bool = False, dataset_ids: List[str] = None,
                         **kwargs) -> dict:
        """Convenience: scan peaks + cluster in one call.

        Scans for peaks, selects peaks at or above min_layer, then clusters.

        Args:
            k: Number of clusters
            method: Clustering method ('kmeans', 'combinatorial', 'hdbscan', etc.)
            signal_source: Signal for peak scanning. See scan_peaks() for the
                full list — includes 'm6a', 'm5c', 'deam' for modification
                density, plus 'fire', 'tf_layer', and 'nuc_layer' for layer
                scans. Legacy 'msp' is accepted as a FIRE alias.
            min_layer: Minimum peak layer to include (0=strongest, 3=weakest)
            max_layer: Maximum peak layer (None=all)
            **kwargs: Additional params forwarded to cluster_all

        Returns:
            dict with 'peaks' (detected), 'cluster_result' (assignments),
            'peak_regions' (the regions used for clustering)

        Example::

            # One-call scan + cluster
            result = b.scan_and_cluster(k=8, method='kmeans')
            print(f"Found {len(result['peaks'])} peaks, clustered into {k} groups")

            # Use only strong peaks (layer 0)
            result = b.scan_and_cluster(k=5, min_layer=0, max_layer=0)
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']

        # Keep scan and cluster sampling aligned when callers provide the
        # global reproducibility seed through kwargs.
        scan_kwargs = {}
        if kwargs.get('sample_seed'):
            scan_kwargs['sample_seed'] = kwargs['sample_seed']
        scan = self.scan_peaks(chrom=chrom, start=start, end=end,
                               dataset_ids=dataset_ids,
                               signal_source=signal_source, spanning=spanning,
                               **scan_kwargs)
        peaks = scan.get('peaks', [])

        # Filter by layer
        if max_layer is not None:
            peaks = [p for p in peaks if min_layer <= p.get('layer', 0) <= max_layer]
        else:
            peaks = [p for p in peaks if p.get('layer', 0) >= min_layer]

        if not peaks:
            return {'peaks': [], 'cluster_result': None, 'peak_regions': []}

        # Build peak regions (absolute coords), clustering on the feature the
        # scan measured (the TF-density scan's feature is the 'tf' mode).
        feature_mode = {'tf_density': 'tf'}.get(signal_source, signal_source)
        peak_regions = [
            {'start': p['start'], 'end': p['end'], 'mode': feature_mode}
            for p in peaks
        ]

        # Cluster
        cluster_result = self.cluster_all(
            peak_regions=peak_regions, k=k, method=method,
            chrom=chrom, start=start, end=end,
            spanning=spanning, dataset_ids=dataset_ids, **kwargs
        )

        return {
            'peaks': peaks,
            'peak_regions': peak_regions,
            'cluster_result': cluster_result,
        }

    def cluster_all(self, peak_regions: List[dict] = None, k: int = 5,
                    method: str = 'combinatorial', dataset_ids: List[str] = None,
                    chrom: str = None, start: int = None, end: int = None,
                    spanning: bool = False, **kwargs) -> dict:
        """
        Cluster reads across multiple datasets.

        Args:
            peak_regions: List of peak dicts with 'start', 'end', 'mode' keys.
                          Coordinates are absolute genomic positions.
            k: Number of clusters (default: 5)
            method: Clustering method ('combinatorial', 'kmeans', 'hdbscan',
                    'graph', etc.). 'graph' finds communities of the t-SNE
                    neighbourhood graph (the number of clusters follows from
                    the data; pass resolution=, default 1.0, higher = more).
            dataset_ids: List of dataset IDs (default: all)
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            **kwargs: Additional ClusterAllRequest fields
                      (sample_seed, subnucleosomal_threshold, accessibility_threshold, etc.)

        Returns:
            dict with 'results' keyed by dataset_id
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {'k': k, 'method': method}
        if peak_regions:
            data['peak_regions'] = peak_regions
        if dataset_ids:
            data['dataset_ids'] = dataset_ids
        if 'cluster_feature_rules' not in kwargs:
            rules = self._cluster_feature_rules_for_regions(peak_regions or [])
            if rules:
                data['cluster_feature_rules'] = rules
        data.update(kwargs)
        return self._post("/api/cluster_all", data=data, params=params)

    def cluster_all_reads(self, chrom: str, start: int, end: int,
                          peak_regions: List[dict], k: int, spanning: bool,
                          dataset_ids: List[str], method: str = "kmeans",
                          read_ids: Dict[str, List[str]] = None,
                          max_reads: int = None,
                          subnucleosomal_threshold: int = 90,
                          accessibility_threshold: float = 0.5,
                          extra_chroms: List[str] = None,
                          sample_seed: str = None,
                          cluster_feature_rules: Sequence[dict] = None) -> dict:
        """Alias matching the frontend `clusterAllReads` helper."""
        kwargs = {
            'subnucleosomal_threshold': subnucleosomal_threshold,
            'accessibility_threshold': accessibility_threshold,
        }
        if read_ids:
            kwargs['read_ids'] = read_ids
        if max_reads is not None:
            kwargs['max_reads'] = int(max_reads)
        if sample_seed:
            kwargs['sample_seed'] = str(sample_seed)
        if extra_chroms:
            kwargs['extra_chroms'] = extra_chroms
        rules = self._cluster_feature_rules_for_regions(peak_regions, cluster_feature_rules)
        if rules:
            kwargs['cluster_feature_rules'] = rules
        return self.cluster_all(
            peak_regions=peak_regions,
            k=k,
            method=method,
            dataset_ids=dataset_ids,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            **kwargs,
        )

    @staticmethod
    def _dict_get(mapping: dict, *keys: str, default=None):
        for key in keys:
            if isinstance(mapping, dict) and key in mapping:
                return mapping.get(key)
        return default

    @staticmethod
    def _chroms_match(a: Any, b: Any) -> bool:
        if not a or not b:
            return True
        aa = str(a).strip().lower()
        bb = str(b).strip().lower()
        if aa.startswith("chr"):
            aa = aa[3:]
        if bb.startswith("chr"):
            bb = bb[3:]
        return aa == bb

    @staticmethod
    def _clip_region_to_viewport(region_start: int, region_end: int,
                                 viewport_start: int, viewport_end: int) -> Optional[Tuple[int, int]]:
        left = max(int(viewport_start), int(round(region_start)))
        right = min(int(viewport_end), int(round(region_end)))
        if right <= left:
            return None
        return left, right

    @classmethod
    def _peak_passes_rule_scope(cls, peak: dict, scope: dict, chrom: str) -> bool:
        if not cls._chroms_match(peak.get("chrom"), chrom):
            return False
        level_min = scope.get("peakLevelMin", scope.get("peak_level_min"))
        level_max = scope.get("peakLevelMax", scope.get("peak_level_max"))
        if level_min is None and level_max is None:
            return True
        try:
            level = int(peak.get("layer"))
        except (TypeError, ValueError):
            return False
        if level_min is not None and level < int(level_min):
            return False
        if level_max is not None and level > int(level_max):
            return False
        return True

    @staticmethod
    def _gene_segments(gene: dict, part: str) -> List[Tuple[int, int]]:
        start = int(gene.get("start", 0))
        end = int(gene.get("end", start))
        if part == "tss":
            tss = end if gene.get("strand") == "-" else start
            return [(max(0, tss - 250), tss + 250)]
        exons = gene.get("exons") or []
        if part == "exon" and exons:
            return [(int(exon["start"]), int(exon["end"])) for exon in exons if "start" in exon and "end" in exon]
        if part == "intron":
            # Fewer than two exons: no introns (not the whole gene), as in the browser.
            sorted_exons = sorted(exons, key=lambda exon: int(exon.get("start", 0)))
            introns = []
            for left, right in zip(sorted_exons, sorted_exons[1:]):
                intron_start = int(left.get("end", 0))
                intron_end = int(right.get("start", 0))
                if intron_end > intron_start:
                    introns.append((intron_start, intron_end))
            return introns
        return [(start, end)]

    def _analysis_rule_context(self, chrom: str, start: int, end: int,
                               peaks: Optional[Sequence[dict]] = None,
                               selected_peaks: Optional[Sequence[int]] = None,
                               selected_genes: Optional[Sequence[dict]] = None,
                               peak_modes: Optional[dict] = None) -> dict:
        state = {}
        if peaks is None or selected_peaks is None or selected_genes is None or peak_modes is None:
            try:
                state = self.get_analysis_state()
            except Exception:
                state = {}

        resolved_peaks: List[dict] = list(peaks or [])
        if peaks is None:
            for rule_peaks in (state.get("peaks_by_rule") or {}).values():
                resolved_peaks.extend(list(rule_peaks or []))
            if not resolved_peaks:
                try:
                    resolved_peaks = list(self.get_peaks(selected_only=False, as_dataframe=False) or [])
                except Exception:
                    resolved_peaks = []

        return {
            "peaks": resolved_peaks,
            "selected_peaks": set(int(idx) for idx in (selected_peaks if selected_peaks is not None else state.get("selected_peaks", [])) or []),
            "selected_genes": list(selected_genes if selected_genes is not None else state.get("selected_genes", []) or []),
            "peak_modes": dict(peak_modes if peak_modes is not None else state.get("peak_modes", {}) or {}),
            "chrom": chrom,
            "start": int(start),
            "end": int(end),
        }

    def _resolve_gene_for_analysis_rule(self, scope: dict, context: dict) -> Optional[dict]:
        gene_id = self._dict_get(scope, "geneId", "gene_id")
        gene_name = self._dict_get(scope, "geneName", "gene_name")
        selected_genes = context.get("selected_genes") or []
        if gene_id:
            for gene in selected_genes:
                if str(gene.get("id")) == str(gene_id):
                    return gene
        if gene_name:
            for gene in selected_genes:
                if str(gene.get("name", "")).lower() == str(gene_name).lower():
                    return gene
        # The first selected gene stands in only when the scope names no gene;
        # a named gene is that gene or nothing.
        if not gene_id and not gene_name:
            return selected_genes[0] if selected_genes else None
        if gene_id or gene_name:
            for gene in self.get_genes(context["chrom"], context["start"], context["end"]):
                if gene_id and str(gene.get("id")) == str(gene_id):
                    return gene
                if gene_name and str(gene.get("name", "")).lower() == str(gene_name).lower():
                    return gene
        return None

    def resolve_analysis_rule_windows(self, rule: dict, chrom: str = None,
                                      start: int = None, end: int = None,
                                      peaks: Optional[Sequence[dict]] = None,
                                      selected_peaks: Optional[Sequence[int]] = None,
                                      selected_genes: Optional[Sequence[dict]] = None,
                                      peak_modes: Optional[dict] = None) -> List[List[int]]:
        """Resolve a UI Analysis Rule scope to absolute genomic windows."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        scope = dict((rule or {}).get("scope") or {})
        kind = scope.get("kind", "selectedPeaks")
        context = self._analysis_rule_context(chrom, start, end, peaks, selected_peaks, selected_genes, peak_modes)

        if kind == "currentWindow":
            return [[int(start), int(end)]] if int(end) > int(start) else []
        if kind == "customRegion":
            region = scope.get("region") or {}
            if not self._chroms_match(region.get("chrom"), chrom):
                return []
            clipped = self._clip_region_to_viewport(region.get("start", 0), region.get("end", 0), start, end)
            return [[clipped[0], clipped[1]]] if clipped else []
        if kind in {"gene", "transcript"}:
            gene = self._resolve_gene_for_analysis_rule(scope, context)
            if not gene or not self._chroms_match(gene.get("chrom"), chrom):
                return []
            part = scope.get("genePart", scope.get("gene_part", "full")) or "full"
            windows = []
            for seg_start, seg_end in self._gene_segments(gene, part):
                clipped = self._clip_region_to_viewport(seg_start, seg_end, start, end)
                if clipped:
                    windows.append([clipped[0], clipped[1]])
            return windows

        selected = context["selected_peaks"]
        windows = []
        for peak in context["peaks"]:
            if kind != "allPeaks" and int(peak.get("index", -1)) not in selected:
                continue
            if not self._peak_passes_rule_scope(peak, scope, chrom):
                continue
            windows.append([int(peak["start"]), int(peak["end"])])
        return windows

    def resolve_cluster_feature_rule_regions(self, rule: dict, chrom: str = None,
                                             start: int = None, end: int = None,
                                             peaks: Optional[Sequence[dict]] = None,
                                             selected_peaks: Optional[Sequence[int]] = None,
                                             selected_genes: Optional[Sequence[dict]] = None,
                                             peak_modes: Optional[dict] = None) -> List[dict]:
        """Resolve a Cluster Analysis Rule to ``cluster_all`` peak regions."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        mode = f"cluster_rule:{rule.get('id')}" if rule and rule.get("id") else "accessibility"
        windows = self.resolve_analysis_rule_windows(
            rule,
            chrom=chrom,
            start=start,
            end=end,
            peaks=peaks,
            selected_peaks=selected_peaks,
            selected_genes=selected_genes,
            peak_modes=peak_modes,
        )
        return [{"start": window[0], "end": window[1], "mode": mode} for window in windows]

    def _cluster_feature_rules_for_regions(self, peak_regions: Sequence[dict],
                                           cluster_feature_rules: Sequence[dict] = None) -> List[dict]:
        if cluster_feature_rules is not None:
            return list(cluster_feature_rules)
        if not any(str((region or {}).get("mode", "")).startswith("cluster_rule:") for region in (peak_regions or [])):
            return []
        try:
            return list(self.get_analysis_rules().get("cluster_feature_rules", []) or [])
        except Exception:
            return []

    @classmethod
    def _analysis_rule_first_term(cls, rule: dict) -> dict:
        terms = (rule or {}).get("terms") or []
        return terms[0] if terms and isinstance(terms[0], dict) else {}

    @classmethod
    def _analysis_rule_layer(cls, term: dict) -> Optional[str]:
        source = term.get("source", "layer")
        if source == "label_rule":
            targets = cls._dict_get(term.get("rule") or {}, "targetLayers", "target_layers", default=[]) or []
            return targets[0] if len(targets) == 1 else None
        if source == "footprint_group":
            return (term.get("group") or {}).get("layer")
        return term.get("layer")

    @classmethod
    def _analysis_rule_payload_from_term(cls, term: dict) -> dict:
        source = term.get("source", "layer")
        base = term.get("rule") if source == "label_rule" else term.get("group") if source == "footprint_group" else term
        base = base or term
        size_min = cls._dict_get(base, "sizeMin", "size_min", default=cls._dict_get(term, "sizeMin", "size_min", default=0))
        size_max = cls._dict_get(base, "sizeMax", "size_max", default=cls._dict_get(term, "sizeMax", "size_max"))
        gates = cls._dict_get(base, "qualityGates", "quality_gates",
                              default=cls._dict_get(term, "qualityGates", "quality_gates", default=None))
        return {
            "size_min": max(0, float(size_min or 0)),
            "size_max": None if size_max is None else max(0, float(size_max or 0)),
            "conditions": list(base.get("conditions") or term.get("conditions") or []),
            "quality_gates": cls._quality_gates_payload(gates),
        }

    @classmethod
    def _quality_gates_payload(cls, gates) -> List[dict]:
        """A rule's quality gates as the sort/filter API takes them (as the browser sends them)."""
        payload = []
        for gate in gates or []:
            if not isinstance(gate, dict):
                continue
            name = cls._dict_get(gate, "qualityName", "quality_name")
            if not name:
                continue
            max_value = cls._dict_get(gate, "maxValue", "max_value")
            payload.append({
                "quality_name": str(name),
                "min_value": float(cls._dict_get(gate, "minValue", "min_value", default=0) or 0),
                "max_value": None if max_value is None else float(max_value),
            })
        return payload

    @classmethod
    def _analysis_sort_backend_mode(cls, metric: str) -> str:
        if metric == "rate":
            return "fp_rate"
        if metric in {"occupancy", "accessibility"}:
            return metric
        return "rule"

    @classmethod
    def _analysis_rule_transcription_state(cls, term: dict) -> Optional[str]:
        if term.get("source") != "transcription_state":
            return None
        state = term.get("transcriptionState", term.get("transcription_state", "elongating"))
        if state == "hyperburst":
            raise ValueError(
                "The 'hyperburst' transcription state has been removed; "
                "use 'pause', 'pic' or 'elongating'"
            )
        return state if state in {"pause", "pic", "elongating"} else "elongating"

    def _analysis_rule_gene_ids(self, rule: dict, selected_genes: Optional[Sequence[dict]] = None) -> List[str]:
        scope = dict((rule or {}).get("scope") or {})
        gene_id = self._dict_get(scope, "geneId", "gene_id")
        if gene_id:
            return [str(gene_id)]
        genes = list(selected_genes if selected_genes is not None else self.get_analysis_state().get("selected_genes", []) or [])
        return [str(gene.get("id")) for gene in genes if gene.get("id")]

    def _analysis_rule_peak_windows(self, chrom: str, start: int, end: int,
                                    peaks: Optional[Sequence[dict]] = None) -> List[List[int]]:
        if peaks is None:
            peaks = self._analysis_rule_context(chrom, start, end).get("peaks", [])
        return [
            [int(peak["start"]), int(peak["end"])]
            for peak in peaks or []
            if "start" in peak and "end" in peak and self._chroms_match(peak.get("chrom"), chrom)
        ]

    def sort_reads(self, sort_by: str = 'fp_count', chrom: str = None,
                   start: int = None, end: int = None,
                   spanning: bool = False, **kwargs) -> dict:
        """
        Sort reads/clusters by a metric.

        Args:
            sort_by: Sort mode ('fp_count', 'fp_rate', 'accessibility',
                     'similarity', 'rule')
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            **kwargs: Additional SortReadsRequest fields (dataset_ids, rule,
                      descending, linked, peak_regions, selected_peak_windows)

        Returns:
            dict with 'results' keyed by dataset_id
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {'sort_by': sort_by}
        data.update(kwargs)
        return self._post("/api/sort_reads", data=data, params=params)

    def sort_by_analysis_rule(self, rule: dict, chrom: str = None, start: int = None,
                              end: int = None, spanning: bool = False,
                              dataset_ids: Union[str, Sequence[str]] = None,
                              linked: bool = True, scope_windows: Sequence[Sequence[int]] = None,
                              peak_regions: Sequence[Sequence[int]] = None,
                              selected_genes: Optional[Sequence[dict]] = None,
                              peaks: Optional[Sequence[dict]] = None,
                              selected_peaks: Optional[Sequence[int]] = None,
                              peak_modes: Optional[dict] = None,
                              sample_seed: str = None) -> dict:
        """Run the same backend sort used by a UI Analysis Rules > Sort entry."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        term = self._analysis_rule_first_term(rule)
        transcription_state = self._analysis_rule_transcription_state(term)
        gene_ids = self._analysis_rule_gene_ids(rule, selected_genes) if transcription_state else None
        if transcription_state and not gene_ids:
            raise ValueError("Pol II state analysis-sort rules require selected genes or scope.geneId")
        windows = [list(map(int, window)) for window in scope_windows] if scope_windows is not None else self.resolve_analysis_rule_windows(
            rule, chrom=chrom, start=start, end=end, peaks=peaks, selected_peaks=selected_peaks,
            selected_genes=selected_genes, peak_modes=peak_modes,
        )
        if not windows:
            raise ValueError("Analysis sort rule has no regions in scope")
        metric = rule.get("metric", "count")
        backend_sort_by = "transcription_state" if transcription_state else self._analysis_sort_backend_mode(metric)
        body_kwargs = {
            "dataset_ids": self._list_param(dataset_ids) or [],
            "descending": rule.get("descending", True) is not False,
            "linked": linked,
            "selected_peak_windows": windows,
            "peak_regions": [list(map(int, region)) for region in peak_regions] if peak_regions is not None else self._analysis_rule_peak_windows(chrom, start, end, peaks),
            "sample_seed": sample_seed,
        }
        if transcription_state:
            body_kwargs["transcription_state"] = transcription_state
            body_kwargs["gene_ids"] = gene_ids
        else:
            # As the browser does: count rules send the size rule and the term's layer.
            if metric == "count":
                body_kwargs["rule"] = self._analysis_rule_payload_from_term(term)
            layer = self._analysis_rule_layer(term)
            if layer:
                body_kwargs["layer"] = layer
        return self.sort_reads(backend_sort_by, chrom=chrom, start=start, end=end, spanning=spanning, **body_kwargs)

    def sort_by_transcription_state(self, gene_ids: Union[str, Sequence[str]], state_kind: str = "elongating",
                                    chrom: str = None, start: int = None, end: int = None,
                                    spanning: bool = False, dataset_ids: Union[str, Sequence[str]] = None,
                                    descending: bool = True, linked: bool = True,
                                    selected_peak_windows: Sequence[Sequence[int]] = None,
                                    sample_seed: str = None) -> dict:
        """Sort reads by a Pol II state metric using Transcription-panel definitions."""
        return self.sort_reads(
            "transcription_state",
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_ids=self._list_param(dataset_ids) or [],
            transcription_state=state_kind,
            gene_ids=self._list_param(gene_ids) or [],
            descending=descending,
            linked=linked,
            selected_peak_windows=[list(map(int, w)) for w in selected_peak_windows] if selected_peak_windows else None,
            sample_seed=sample_seed,
        )

    def filter_by_analysis_rule(self, rule: dict = None, chrom: str = None, start: int = None,
                                end: int = None, spanning: bool = False,
                                dataset_ids: Union[str, Sequence[str]] = None,
                                metric: str = None, operator: str = None, threshold: float = None,
                                scope_windows: Sequence[Sequence[int]] = None,
                                peak_regions: Sequence[Sequence[int]] = None,
                                selected_genes: Optional[Sequence[dict]] = None,
                                peaks: Optional[Sequence[dict]] = None,
                                selected_peaks: Optional[Sequence[int]] = None,
                                peak_modes: Optional[dict] = None,
                                sample_seed: str = None,
                                transcription_state: str = None,
                                gene_ids: Union[str, Sequence[str]] = None,
                                layer: str = None,
                                rule_payload: dict = None,
                                pin: bool = False) -> dict:
        """Filter reads with the Analysis Rules backend endpoint.

        When ``pin=True`` the resulting read-id set is also pinned as the
        browser's active read filter (one /api/jupyter/filter POST per dataset),
        matching what the Filter tab does in the UI.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        term = self._analysis_rule_first_term(rule or {})
        tx_state = transcription_state or self._analysis_rule_transcription_state(term)
        resolved_gene_ids = self._list_param(gene_ids) or (self._analysis_rule_gene_ids(rule, selected_genes) if tx_state and rule else [])
        if tx_state and not resolved_gene_ids:
            raise ValueError("Pol II state analysis-filter rules require selected genes, gene_ids, or scope.geneId")
        windows = [list(map(int, window)) for window in scope_windows] if scope_windows is not None else (
            self.resolve_analysis_rule_windows(
                rule, chrom=chrom, start=start, end=end, peaks=peaks, selected_peaks=selected_peaks,
                selected_genes=selected_genes, peak_modes=peak_modes,
            ) if rule else None
        )
        if rule and not windows:
            raise ValueError("Analysis filter rule has no regions in scope")
        body = {
            "dataset_ids": self._list_param(dataset_ids) or [],
            "metric": metric or (rule or {}).get("metric", "count"),
            "operator": operator or (rule or {}).get("operator", "gte"),
            "threshold": float(threshold if threshold is not None else (rule or {}).get("threshold", 1)),
            "sample_seed": sample_seed,
        }
        if windows:
            body["scope_windows"] = windows
        if peak_regions is not None:
            body["peak_regions"] = [list(map(int, region)) for region in peak_regions]
        elif rule:
            body["peak_regions"] = self._analysis_rule_peak_windows(chrom, start, end, peaks)
        if tx_state:
            body["transcription_state"] = tx_state
            body["gene_ids"] = resolved_gene_ids
        else:
            payload = rule_payload
            if payload is None and rule and body["metric"] == "count":
                payload = self._analysis_rule_payload_from_term(term)
            if payload is not None:
                body["rule"] = payload
            resolved_layer = layer or (self._analysis_rule_layer(term) if rule else None)
            if resolved_layer:
                body["layer"] = resolved_layer
        params = {"chrom": chrom, "start": int(start), "end": int(end), "spanning": str(spanning).lower()}
        result = self._post("/api/filter_by_analysis_rule", data=body, params=params)
        if pin:
            self.pin_analysis_filter_result(result)
        return result

    def pin_analysis_filter_result(self, result: dict) -> dict:
        """Pin a ``filter_by_analysis_rule`` response as the browser's active
        per-dataset read filter (one /api/jupyter/filter POST per dataset).

        Returns a mapping of dataset_id -> the pin call's response.
        """
        if not result or not isinstance(result, dict):
            return {}
        per_dataset = (result.get("results") or {})
        pinned: dict = {}
        for dataset_id, payload in per_dataset.items():
            read_ids = (payload or {}).get("read_ids") or []
            pinned[dataset_id] = self.filter_reads(list(read_ids), dataset_id=dataset_id)
        return pinned

    def filter_reads_by_ids(self, read_ids: Sequence[str], dataset_id: str = None) -> dict:
        """Pin a specific set of read IDs as the browser's display filter.

        Identical wire shape to :py:meth:`filter_reads`; this name is the one
        the Copilot record set and the README catalog table point at because
        it reads more naturally in notebook code ("filter reads by ids = …").
        """
        return self.filter_reads(list(read_ids), dataset_id=dataset_id)

    def cluster_by_feature_rule(self, rule: dict, chrom: str = None, start: int = None,
                                end: int = None, spanning: bool = False,
                                dataset_ids: Union[str, Sequence[str]] = None,
                                rules: Sequence[dict] = None, method: str = "kmeans",
                                k: int = 5, peaks: Optional[Sequence[dict]] = None,
                                selected_peaks: Optional[Sequence[int]] = None,
                                selected_genes: Optional[Sequence[dict]] = None,
                                peak_modes: Optional[dict] = None, **kwargs) -> dict:
        """Cluster reads using a UI Analysis Rules > Cluster feature rule."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        peak_regions = self.resolve_cluster_feature_rule_regions(
            rule, chrom=chrom, start=start, end=end, peaks=peaks,
            selected_peaks=selected_peaks, selected_genes=selected_genes, peak_modes=peak_modes,
        )
        if not peak_regions:
            raise ValueError("Cluster feature rule has no regions in scope")
        cluster_feature_rules = list(rules or [rule])
        return self.cluster_all(
            peak_regions=peak_regions,
            k=k,
            method=method,
            dataset_ids=self._list_param(dataset_ids) or None,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            cluster_feature_rules=cluster_feature_rules,
            **kwargs,
        )

    def filter_by_transcription_state(self, gene_ids: Union[str, Sequence[str]], filters: dict = None,
                                      chrom: str = None, start: int = None,
                                      end: int = None, spanning: bool = False,
                                      dataset_ids: Union[str, Sequence[str]] = None,
                                      pause: Optional[bool] = None,
                                      pic: Optional[bool] = None,
                                      elongating: Optional[int] = None,
                                      elongating_max: Optional[int] = None,
                                      sample_seed: str = None) -> dict:
        """
        Filter reads by transcription state criteria relative to gene(s).

        Args:
            gene_ids: Transcript ID or list of transcript IDs from GTF
            filters: dict with boolean/int flags:
                     {'pause': bool, 'pic': bool, 'elongating': int|None,
                      'elongating_max': int|None}
                     Keyword flags below are merged into this dict.
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            dataset_ids: Dataset IDs to filter (default: all)
            pause: Match reads with pause-proximal footprints
            pic: Match reads with PIC-state footprints
            elongating: Minimum Pol II-sized footprint count
            elongating_max: Optional maximum Pol II-sized footprint count

        Returns:
            dict with per-dataset 'filtered_ids', 'read_states', and 'summary'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        merged_filters = dict(filters or {})
        for key, value in (
            ('pause', pause),
            ('pic', pic),
            ('elongating', elongating),
            ('elongating_max', elongating_max),
        ):
            if value is not None:
                merged_filters[key] = value
        data = {'gene_ids': self._list_param(gene_ids), 'filters': merged_filters}
        ds_list = self._list_param(dataset_ids)
        if ds_list:
            data['dataset_ids'] = ds_list
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        return self._post("/api/filter_by_transcription_state", data=data, params=params)

    def get_transcription_state_counts(self, gene_ids: Union[str, Sequence[str]],
                                       chrom: str = None, start: int = None,
                                       end: int = None, spanning: bool = False,
                                       dataset_ids: Union[str, Sequence[str]] = None,
                                       sample_seed: str = None) -> dict:
        """Fetch the same state-count summary used when the browser panel opens."""
        return self.filter_by_transcription_state(
            gene_ids=gene_ids,
            filters={'pause': True, 'pic': True, 'elongating': 1},
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_ids=dataset_ids,
            sample_seed=sample_seed,
        )

    def get_pol2_com(self, gene_ids: List[str], dataset_ids: List[str] = None,
                     fp_size_min: int = 35, fp_size_max: int = 65,
                     n_bins: int = 100, chrom: str = None,
                     start: int = None, end: int = None,
                     spanning: bool = False,
                     smoothing_sigma: float = None,
                     sample_seed: str = None) -> dict:
        """
        Pol II center-of-mass heatmap data sorted by COM position.

        Args:
            gene_ids: List of transcript IDs from GTF
            dataset_ids: Dataset IDs (default: all)
            fp_size_min: Min footprint size for Pol II (default: 35)
            fp_size_max: Max footprint size for Pol II (default: 65)
            n_bins: Number of bins across gene body (default: 100)
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads

        Returns:
            dict with per-dataset 'binary_matrix', 'smoothed_matrix',
            'com_values', 'read_ids', 'n_reads', 'n_bins', 'gene_body_size'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data: Dict[str, Any] = {
            'gene_ids': gene_ids,
            'fp_size_min': fp_size_min,
            'fp_size_max': fp_size_max,
            'n_bins': n_bins,
        }
        if smoothing_sigma is not None:
            data['smoothing_sigma'] = smoothing_sigma
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        if dataset_ids:
            data['dataset_ids'] = dataset_ids
        return self._post("/api/pol2_com", data=data, params=params)

    def fetch_pol2_com(self, chrom: str, start: int, end: int, spanning: bool,
                       dataset_ids: List[str], gene_ids: List[str],
                       fp_size_min: int = None, fp_size_max: int = None,
                       n_bins: int = None,
                       smoothing_sigma: float = None,
                       sample_seed: str = None) -> dict:
        """Alias matching the frontend `fetchPol2COM` helper."""
        return self.get_pol2_com(
            gene_ids=gene_ids,
            dataset_ids=dataset_ids,
            fp_size_min=35 if fp_size_min is None else fp_size_min,
            fp_size_max=65 if fp_size_max is None else fp_size_max,
            n_bins=100 if n_bins is None else n_bins,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            smoothing_sigma=smoothing_sigma,
            sample_seed=sample_seed,
        )

    def autozoom(self, distance: int = 1000, chrom: str = None,
                 start: int = None, end: int = None,
                 spanning: bool = False, **kwargs) -> dict:
        """
        Find the optimal window that maximizes spanning reads.

        Detects primer sites and clips inward for targeted DAF-seq data.

        Args:
            distance: How far to search in each direction (default: 1000bp)
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            **kwargs: Additional AutozoomRequest fields (dataset_ids,
                      min_reads, primer_clip, cluster_window)

        Returns:
            dict with optimal window coordinates
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {'distance': distance}
        data.update(kwargs)
        return self._post("/api/autozoom", data=data, params=params)

    def dissolve_cluster(self, cluster_id: int, assignments: Dict[str, Dict[str, int]],
                         peak_regions: List[dict], dataset_ids: List[str] = None,
                         chrom: str = None, start: int = None, end: int = None,
                         spanning: bool = False, sample_seed: str = None,
                         cluster_feature_rules: Sequence[dict] = None,
                         **kwargs) -> dict:
        """
        Dissolve a cluster by reassigning its reads to the nearest remaining clusters.

        Args:
            cluster_id: Cluster ID to dissolve
            assignments: Current assignments dict: {dataset_id: {read_id: cluster_id}}
            peak_regions: List of peak dicts with 'start', 'end', 'mode' keys
            dataset_ids: Dataset IDs (default: all)
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            **kwargs: Additional DissolveClusterRequest fields
                      (subnucleosomal_threshold, accessibility_threshold)

        Returns:
            dict with 'results' keyed by dataset_id, each containing
            updated 'assignments'

        Example:
            result = client.dissolve_cluster(
                cluster_id=3,
                assignments={ds: r['assignments'] for ds, r in clusters['results'].items()},
                peak_regions=[{'start': 1000, 'end': 1200, 'mode': 'accessibility'}],
            )
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {
            'cluster_to_dissolve': cluster_id,
            'current_assignments': assignments,
            'peak_regions': peak_regions,
        }
        if dataset_ids:
            data['dataset_ids'] = dataset_ids
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        rules = self._cluster_feature_rules_for_regions(peak_regions, cluster_feature_rules)
        if rules:
            data['cluster_feature_rules'] = rules
        data.update(kwargs)
        return self._post("/api/dissolve_cluster", data=data, params=params)

    def get_cluster_vplot(self, chrom: str = None, start: int = None,
                          end: int = None, spanning: bool = False,
                          size_bin: int = 10, pos_bin: int = 10,
                          size_min: int = 10, size_max: int = 300,
                          log_norm: bool = True, smooth: float = 1.0,
                          layer: str = None,
                          normalize: str = "per_cluster",
                          sample_seed: str = None,
                          mode: str = "midpoint",
                          row_normalize: bool = False,
                          row_min_footprints: int = 20) -> dict:
        """
        Get V-plot data (footprint size vs. genomic position) per cluster.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            size_bin: Footprint size bin width in bp (default: 10)
            pos_bin: Position bin width in bp (default: 10)
            size_min: Minimum footprint size to include (default: 10)
            size_max: Maximum footprint size to include (default: 300)
            log_norm: Log-normalize counts (default: True)
            smooth: Gaussian smoothing sigma (default: 1.0, 0 = off)
            layer: Optional annotation layer to use for intervals (e.g. 'tf', 'fire', 'nuc')
            normalize: 'per_cluster' or 'shared' color scaling
            mode: 'midpoint' (traditional: each footprint counted at its centre)
                or 'span' (full footprint: each footprint adds to every position
                it covers, in its size row)
            row_normalize: divide each size row by its mean across the window
                (enrichment of that footprint size at each position over the
                window's expectation for that size)
            row_min_footprints: with row_normalize, size rows drawn from fewer
                footprints than this are left blank (default 20)

        Returns:
            dict with 'data' keyed by dataset_id, each containing per-cluster
            V-plot matrices with 'matrix', 'size_min', 'size_max', etc.

        Example:
            vplot = client.get_cluster_vplot(size_bin=5, size_max=500)
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'region_start': int(start), 'region_end': int(end)}
        data = {
            'size_bin': size_bin, 'pos_bin': pos_bin,
            'size_min': size_min, 'size_max': size_max,
            'log_norm': log_norm, 'smooth': smooth,
            'layer': self._normalize_annotation_layer(layer),
            'normalize': normalize,
            'mode': mode,
            'row_normalize': bool(row_normalize),
            'row_min_footprints': int(row_min_footprints),
        }
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        return self._post("/api/cluster/vplot", data=data, params=params)

    def fetch_cluster_vplot(self, chrom: str, region_start: int, region_end: int,
                            size_bin: int = 5, pos_bin: int = 5,
                            size_min: int = 10, size_max: int = 300,
                            log_norm: bool = True, smooth: float = 1.0,
                            layer: str = None,
                            normalize: str = "per_cluster",
                            sample_seed: str = None,
                            mode: str = "midpoint",
                            row_normalize: bool = False,
                            row_min_footprints: int = 20) -> dict:
        """Alias matching the frontend `fetchClusterVPlot` helper."""
        return self.get_cluster_vplot(
            chrom=chrom,
            start=region_start,
            end=region_end,
            size_bin=size_bin,
            pos_bin=pos_bin,
            size_min=size_min,
            size_max=size_max,
            log_norm=log_norm,
            smooth=smooth,
            layer=layer,
            normalize=normalize,
            sample_seed=sample_seed,
            mode=mode,
            row_normalize=row_normalize,
            row_min_footprints=row_min_footprints,
        )

    def fetch_cluster_v_plot(self, *args, **kwargs) -> dict:
        """Acronym-preserving alias for `fetch_cluster_vplot`."""
        return self.fetch_cluster_vplot(*args, **kwargs)

    def get_cluster_projection(self, peak_regions: List[dict],
                               dataset_ids: List[str] = None,
                               chrom: str = None, start: int = None, end: int = None,
                               spanning: bool = False,
                               method: str = "tsne",
                               n_components: int = 2,
                               simulate_autocull: bool = False,
                               min_fraction: float = 0.05,
                               max_cosine_similarity: float = 0.95,
                               subnucleosomal_threshold: int = 90,
                               accessibility_threshold: float = 0.5,
                               sample_seed: str = None,
                               cluster_feature_rules: Sequence[dict] = None,
                               max_reads: int = None,
                               include_strands: bool = False) -> dict:
        """Project clustered reads into t-SNE (default), PCA or UMAP coordinates.

        Mirrors the Cluster Detail projection tab and can optionally simulate
        autoculling before committing an autocull operation. The same reads,
        settings and sample_seed give the same t-SNE map; `projection_params`
        in the response records its seed, perplexity and feature digest.
        `max_reads` caps how many reads t-SNE embeds (the rest are placed by
        their nearest embedded reads). Use `get_projection_table` for a
        per-read DataFrame.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {
            'dataset_ids': dataset_ids or [],
            'peak_regions': peak_regions,
            'method': method,
            'n_components': int(n_components),
            'simulate_autocull': simulate_autocull,
            'min_fraction': min_fraction,
            'max_cosine_similarity': max_cosine_similarity,
            'subnucleosomal_threshold': subnucleosomal_threshold,
            'accessibility_threshold': accessibility_threshold,
        }
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        if max_reads:
            data['max_reads'] = int(max_reads)
        if include_strands:
            data['include_strands'] = True
        rules = self._cluster_feature_rules_for_regions(peak_regions, cluster_feature_rules)
        if rules:
            data['cluster_feature_rules'] = rules
        return self._post("/api/cluster_projection", data=data, params=params)

    def get_projection_table(self, method: str = "tsne",
                             dataset_ids: List[str] = None,
                             chrom: str = None, start: int = None, end: int = None,
                             peak_regions: List[dict] = None,
                             spanning: bool = False,
                             sample_seed: str = None,
                             max_reads: int = None,
                             cluster_feature_rules: Sequence[dict] = None,
                             path: str = None):
        """Per-read map of the clustered reads as a DataFrame (t-SNE by default).

        One row per read: read_name, dataset, strand (DAF CT/GA),
        alignment_strand, cluster, tsne_x, tsne_y, embedded. The map's
        parameters (seed, perplexity, neighbours, feature digest, region) are
        in ``df.attrs["projection"]``. Without peak_regions the peaks each
        dataset was clustered on are used, as in the Projection tab. With
        `path`, also writes a TSV whose '#' header lines hold the parameters
        (the same file as the Projection tab's Export).

        t-SNE keeps each read's nearest neighbours together; distances between
        groups and group sizes on the map are not meaningful.
        """
        response = self.get_cluster_projection(
            peak_regions=peak_regions or [],
            dataset_ids=dataset_ids,
            chrom=chrom, start=start, end=end,
            spanning=spanning,
            method=method,
            sample_seed=sample_seed,
            cluster_feature_rules=cluster_feature_rules,
            max_reads=max_reads,
            include_strands=True,
        )
        if response.get("error"):
            raise RuntimeError(response["error"])
        df = projection_table_from_response(response)
        if path:
            write_projection_table(df, path)
        return df

    def sort_by_projection(self, dataset_ids: List[str] = None,
                           chrom: str = None, start: int = None, end: int = None,
                           peak_regions: List[dict] = None,
                           spanning: bool = False,
                           sample_seed: str = None,
                           subnucleosomal_threshold: int = 90,
                           max_reads: int = None,
                           cluster_feature_rules: Sequence[dict] = None) -> dict:
        """Read order along the t-SNE map (the toolbar's Sort > By projection).

        Clusters follow a path through their centroids on the map and each
        cluster's reads a nearest-neighbour path, so neighbours on the map are
        next to each other. Returns {"results": {dataset: {"cluster_order",
        "read_sort_order"}}, "projection_params": ...}. Needs a clustering.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {'dataset_ids': dataset_ids or [], 'sort_by': 'projection'}
        # The same map get_projection_table draws for these settings.
        projection = {'subnucleosomal_threshold': int(subnucleosomal_threshold)}
        if peak_regions:
            projection['peak_regions'] = peak_regions
            rules = self._cluster_feature_rules_for_regions(peak_regions, cluster_feature_rules)
            if rules:
                projection['cluster_feature_rules'] = rules
        if max_reads:
            projection['max_reads'] = int(max_reads)
        data['projection'] = projection
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        return self._post("/api/sort_reads", data=data, params=params)

    def fetch_cluster_projection(self, chrom: str, start: int, end: int,
                                 dataset_ids: List[str],
                                 peak_regions: List[dict],
                                 method: str = "tsne",
                                 spanning: bool = False,
                                 simulate_autocull: bool = False,
                                 min_fraction: float = 0.05,
                                 max_cosine_similarity: float = 0.95,
                                 subnucleosomal_threshold: int = 90,
                                 accessibility_threshold: float = 0.5,
                                 n_components: int = 2,
                                 sample_seed: str = None,
                                 cluster_feature_rules: Sequence[dict] = None) -> dict:
        """Alias matching the frontend `fetchClusterProjection` helper."""
        return self.get_cluster_projection(
            peak_regions=peak_regions,
            dataset_ids=dataset_ids,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            method=method,
            n_components=n_components,
            simulate_autocull=simulate_autocull,
            min_fraction=min_fraction,
            max_cosine_similarity=max_cosine_similarity,
            subnucleosomal_threshold=subnucleosomal_threshold,
            accessibility_threshold=accessibility_threshold,
            sample_seed=sample_seed,
            cluster_feature_rules=cluster_feature_rules,
        )

    def get_read_stats(self, read_ids_by_dataset: Union[Dict[str, List[str]], List[str]],
                       chrom: str = None, start: int = None, end: int = None,
                       spanning: bool = False, as_dataframe: bool = True,
                       dataset_id: str = None,
                       sample_seed: str = None) -> Union[dict, 'pd.DataFrame']:
        """
        Get per-read alignment and footprint statistics.

        Args:
            read_ids_by_dataset: Dict mapping dataset_id to read IDs, or a
                plain list of read IDs for ``dataset_id``
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            spanning: Only use spanning reads
            as_dataframe: Return per_read as DataFrame (default: True)
            dataset_id: Dataset used when read_ids_by_dataset is a list
                (default: first loaded dataset)
            sample_seed: Optional seed for reproducible backend working-set caps

        Returns:
            If as_dataframe: DataFrame with per-read stats
            If not: raw dict with 'per_read', 'aggregate', and histogram fields

        Example:
            # Get stats for reads in the current view
            reads = client.get_reads()
            stats = client.get_read_stats(reads['id'].tolist()[:10])
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        read_ids_by_dataset = self._normalize_read_ids_by_dataset(read_ids_by_dataset, dataset_id)
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        data = {'read_ids_by_dataset': read_ids_by_dataset}
        if sample_seed:
            data['sample_seed'] = str(sample_seed)
        resp = self._post("/api/reads/stats", data=data, params=params)
        resp = self._read_stats_with_viewer_order(resp, read_ids_by_dataset)
        if as_dataframe:
            pd = _ensure_pandas()
            per_read = resp.get('per_read', [])
            if not per_read:
                return pd.DataFrame()
            return pd.DataFrame(per_read)
        return resp

    def get_read_stats_tsv(self, read_ids_by_dataset: Union[Dict[str, List[str]], List[str]],
                           chrom: str = None, start: int = None, end: int = None,
                           spanning: bool = False, dataset_id: str = None,
                           sample_seed: str = None,
                           columns: Sequence[str] = None) -> str:
        """Return selected read stats as TSV in browser/table viewer order."""
        normalized_ids = self._normalize_read_ids_by_dataset(read_ids_by_dataset, dataset_id)
        resp = self.get_read_stats(
            read_ids_by_dataset=normalized_ids,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_id=dataset_id,
            sample_seed=sample_seed,
            as_dataframe=False,
        )
        selected_columns = list(columns or READ_STATS_TSV_COLUMNS)
        lines = ["\t".join(selected_columns)]
        for row in resp.get("per_read", []) or []:
            lines.append("\t".join(self._tsv_cell(row.get(col)) for col in selected_columns))
        return "\n".join(lines) + "\n"

    def save_read_stats_tsv(self, filepath: str,
                            read_ids_by_dataset: Union[Dict[str, List[str]], List[str]],
                            chrom: str = None, start: int = None, end: int = None,
                            spanning: bool = False, dataset_id: str = None,
                            sample_seed: str = None,
                            columns: Sequence[str] = None) -> str:
        """Write ``get_read_stats_tsv()`` output to ``filepath`` and return the path."""
        text = self.get_read_stats_tsv(
            read_ids_by_dataset=read_ids_by_dataset,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            dataset_id=dataset_id,
            sample_seed=sample_seed,
            columns=columns,
        )
        with open(filepath, "w", encoding="utf-8") as handle:
            handle.write(text)
        return filepath

    def fetch_read_stats(self, chrom: str, start: int, end: int,
                         spanning: bool,
                         read_ids_by_dataset: Dict[str, List[str]],
                         sample_seed: str = None) -> dict:
        """Alias matching the frontend `fetchReadStats` helper."""
        return self.get_read_stats(
            read_ids_by_dataset=read_ids_by_dataset,
            chrom=chrom,
            start=start,
            end=end,
            spanning=spanning,
            as_dataframe=False,
            sample_seed=sample_seed,
        )

    def design_primers(self, chrom: str = None, start: int = None, end: int = None,
                       min_product: int = 5000, max_product: int = 50000,
                       min_tm: float = 55.0, max_tm: float = 65.0,
                       max_results: int = 5,
                       tm_method: str = "primer3",
                       check_tandem_repeats: bool = True,
                       **kwargs) -> dict:
        """
        Design PCR primers for a genomic region.

        Requires FASTA and BLAST database to be configured.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Target region start
            end: Target region end
            min_product: Minimum product size in bp (default: 5000)
            max_product: Maximum product size in bp (default: 20000)
            min_tm: Minimum melting temperature (default: 55)
            max_tm: Maximum melting temperature (default: 65)
            max_results: Number of primer pairs to return (default: 5)
            **kwargs: Additional PrimerDesignRequest fields
                      (max_tm_diff, min_len, max_len, max_g_count, optimize_for, min_spacing)

        Returns:
            dict with 'success', 'pairs' (list of primer pair dicts),
            and backward-compatible 'pair' (top result)

        Example:
            primers = client.design_primers(chrom='chr1', start=10000, end=11000)
            for pair in primers['pairs']:
                print(pair['fwd_seq'], pair['rev_seq'])
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        data = {
            'chrom': chrom, 'start': int(start), 'end': int(end),
            'min_product': min_product, 'max_product': max_product,
            'min_tm': min_tm, 'max_tm': max_tm,
            'max_results': max_results,
            'tm_method': tm_method,
            'check_tandem_repeats': check_tandem_repeats,
        }
        data.update(kwargs)
        return self._post("/api/design_primers", data=data)

    def get_annotations(self, chrom: str = None, start: int = None, end: int = None,
                        dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                        file_ids: Optional[Union[str, Sequence[str]]] = None,
                        as_dataframe: bool = True,
                        sample_seed: str = None) -> Union[dict, 'pd.DataFrame']:
        """
        Get per-read annotations (e.g., FiberCNN/factorCNN predictions) in a region.

        Args:
            chrom: Chromosome (auto-detected if omitted)
            start: Start position
            end: End position
            dataset_ids: Dataset IDs to query (default: all)
            file_ids: Annotation file IDs to query (default: all active)
            as_dataframe: Return as DataFrame (default: True)
            sample_seed: Optional seed for reproducible backend working-set caps

        Returns:
            If as_dataframe: DataFrame with columns dataset_id, read_name,
                            type, start, end, confidence
            If not: raw dict with 'annotations' and 'types'

        Example:
            anns = client.get_annotations()
            zld_reads = anns[anns['type'] == 'zld']['read_name'].unique()
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        dataset_ids_param = self._comma_param(dataset_ids)
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        file_ids_param = self._comma_param(file_ids)
        if file_ids_param:
            params['file_ids'] = file_ids_param
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        resp = self._get("/api/annotations/region", params=params)
        if as_dataframe:
            pd = _ensure_pandas()
            # Flatten {dataset_id: {read_name: [{type, start, end, ...}]}} → rows,
            # keeping which dataset each molecule is from (read names can repeat
            # across datasets with different annotations). Older servers send
            # only the flat per-read union.
            rows = []
            by_dataset = resp.get('annotations_by_dataset')
            if isinstance(by_dataset, dict):
                for dataset_id, per_read in by_dataset.items():
                    for read_name, ann_list in (per_read or {}).items():
                        for ann in ann_list:
                            rows.append({'dataset_id': dataset_id, 'read_name': read_name, **ann})
            else:
                for read_name, ann_list in resp.get('annotations', {}).items():
                    for ann in ann_list:
                        rows.append({'read_name': read_name, **ann})
            if not rows:
                columns = ['read_name', 'type', 'start', 'end', 'confidence']
                return pd.DataFrame(columns=(['dataset_id'] + columns) if isinstance(by_dataset, dict) else columns)
            return pd.DataFrame(rows)
        return resp

    def get_annotations_for_region(self, chrom: str = None, start: int = None, end: int = None,
                                   dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                                   file_ids: Optional[Union[str, Sequence[str]]] = None,
                                   as_dataframe: bool = True,
                                   sample_seed: str = None) -> Union[dict, 'pd.DataFrame']:
        """Alias matching the frontend API name for per-read annotations."""
        return self.get_annotations(
            chrom=chrom,
            start=start,
            end=end,
            dataset_ids=dataset_ids,
            file_ids=file_ids,
            as_dataframe=as_dataframe,
            sample_seed=sample_seed,
        )

    # =========================================================================
    # Peak and Sequence Methods
    # =========================================================================

    def set_fasta(self, fasta_path: str) -> bool:
        """
        Set reference genome FASTA file for sequence extraction.

        Args:
            fasta_path: Path to reference genome FASTA file

        Returns:
            True if successful

        Example:
            client.set_fasta("/path/to/genome.fa")
        """
        result = self._post_response(
            "/api/load_fasta",
            params={'path': fasta_path},
            timeout=300,
        ).json()
        if not result.get('success'):
            raise ValueError(result.get('error') or result.get('message') or 'Failed to load FASTA')
        return True

    def get_peaks(self, selected_only: bool = False, as_dataframe: bool = True) -> Union[pd.DataFrame, List[dict]]:
        """
        Get peak coordinates from browser.

        Returns peaks synced from the browser, including both auto-detected
        and user-drawn custom peaks.

        Args:
            selected_only: Only return peaks that are selected in the browser
            as_dataframe: Return as pandas DataFrame (default: True)

        Returns:
            DataFrame or list with columns:
                - index: Peak index
                - chrom: Chromosome
                - start: Start position (genomic coordinates)
                - end: End position (genomic coordinates)
                - layer: Layer (0=NDR/accessible, 1=nucleosome, etc.)
                - score: Peak score (if available)
                - isCustom: True if user-drawn peak
                - isSelected: True if selected in browser

        Example:
            peaks = client.get_peaks()
            selected = client.get_peaks(selected_only=True)
        """
        result = self._get("/api/jupyter/peaks", {'selected_only': str(selected_only).lower()})
        peaks = result.get('peaks', [])

        if as_dataframe:
            pd = _ensure_pandas()
            if not peaks:
                return pd.DataFrame(columns=['index', 'chrom', 'start', 'end', 'layer', 'score', 'isCustom', 'isSelected'])
            return pd.DataFrame(peaks)
        return peaks

    @staticmethod
    def _bed_field(value: Any) -> str:
        is_nan = False
        try:
            is_nan = bool(value != value)
        except Exception:
            is_nan = False
        if value is None or value == "" or is_nan:
            return "."
        return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")

    @staticmethod
    def _bed_score(score: Any) -> int:
        try:
            value = float(score)
        except (TypeError, ValueError):
            return 0
        if value != value:
            return 0
        scaled = value * 1000 if value <= 1 else value
        return max(0, min(1000, int(round(scaled))))

    @staticmethod
    def _peak_name(peak: Dict[str, Any]) -> str:
        return (
            peak.get("sourceLabel")
            or peak.get("ruleName")
            or ("custom_peak" if peak.get("isCustom") else f"peak_{peak.get('index', '')}".rstrip("_"))
        )

    @staticmethod
    def _json_safe(value):
        """Convert pandas/numpy scalar values into JSON-safe Python values."""
        if hasattr(value, "item"):
            value = value.item()
        try:
            if value != value:
                return None
        except Exception:
            pass
        if isinstance(value, dict):
            cleaned = {}
            for k, v in value.items():
                cleaned_value = BrowserClient._json_safe(v)
                if cleaned_value is not None:
                    cleaned[k] = cleaned_value
            return cleaned
        if isinstance(value, (list, tuple)):
            return [BrowserClient._json_safe(v) for v in value]
        return value

    @classmethod
    def _peak_records(cls, peaks: Union[List[dict], "pd.DataFrame"]) -> List[dict]:
        if hasattr(peaks, "to_dict"):
            rows = peaks.to_dict("records")
        else:
            rows = list(peaks or [])
        return [cls._json_safe(dict(row)) for row in rows]

    @classmethod
    def format_peak_bed(cls, peaks: Union[List[dict], "pd.DataFrame"]) -> str:
        """
        Format peaks as FiberBrowser BED6+ text.

        Accepts either the list/dict output from ``get_peaks(as_dataframe=False)``
        or a DataFrame with equivalent columns.
        """
        peak_rows = cls._peak_records(peaks)

        lines = [
            "# fiberbrowser_peaks_v1",
            "# columns=" + "\t".join(PEAK_BED_COLUMNS),
        ]
        sorted_peaks = sorted(
            peak_rows,
            key=lambda p: (str(p.get("chrom") or ""), int(p.get("start") or 0), int(p.get("end") or 0)),
        )
        for peak in sorted_peaks:
            score = peak.get("score")
            row = [
                peak.get("chrom"),
                int(peak.get("start", 0)),
                int(peak.get("end", 0)),
                cls._peak_name(peak),
                cls._bed_score(score),
                ".",
                peak.get("ruleId") or peak.get("rule_id"),
                peak.get("ruleName") or peak.get("rule_name"),
                peak.get("source"),
                peak.get("layer", 0),
                score,
                peak.get("threshold"),
                1 if peak.get("isSelected") or peak.get("selected") else 0,
                peak.get("mode") or "accessibility",
                1 if peak.get("isCustom") or peak.get("is_custom") else 0,
                peak.get("color") or peak.get("sourceColor"),
            ]
            lines.append("\t".join(cls._bed_field(v) for v in row))
        return "\n".join(lines) + "\n"

    def get_peaks_bed(self, selected_only: bool = False) -> str:
        """Return current browser peaks as FiberBrowser BED6+ text."""
        return self.format_peak_bed(self.get_peaks(selected_only=selected_only, as_dataframe=False))

    def save_peaks_bed(self, filepath: str, selected_only: bool = False) -> str:
        """Write current browser peaks as FiberBrowser BED6+ and return the path."""
        with open(filepath, "w", encoding="utf-8") as handle:
            handle.write(self.get_peaks_bed(selected_only=selected_only))
        return filepath

    @staticmethod
    def parse_peak_bed(text: str) -> List[dict]:
        """Parse BED3/BED6 or FiberBrowser BED6+ peak text into peak dicts."""
        entries: List[dict] = []
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("track") or line.startswith("browser"):
                continue
            fields = line.split("\t") if "\t" in line else line.split()
            if len(fields) < 3:
                continue
            try:
                start = int(float(fields[1]))
                end = int(float(fields[2]))
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue

            def optional(idx: int) -> Optional[str]:
                if idx >= len(fields) or fields[idx] in ("", "."):
                    return None
                return fields[idx]

            def optional_float(idx: int) -> Optional[float]:
                value = optional(idx)
                if value is None:
                    return None
                try:
                    return float(value)
                except ValueError:
                    return None

            def optional_bool(idx: int) -> Optional[bool]:
                value = (optional(idx) or "").lower()
                if value in ("1", "true", "yes", "selected"):
                    return True
                if value in ("0", "false", "no", "unselected"):
                    return False
                return None

            score = optional_float(10)
            if score is None:
                bed_score = optional_float(4)
                score = (bed_score / 1000) if bed_score and bed_score > 0 else None

            layer = optional_float(9)
            entry = {
                "chrom": fields[0],
                "start": max(0, start),
                "end": max(0, end),
            }
            if optional(3) is not None:
                entry["name"] = optional(3)
            if score is not None:
                entry["score"] = score
            if optional(6) is not None:
                entry["ruleId"] = optional(6)
            if optional(7) is not None:
                entry["ruleName"] = optional(7)
            if optional(8) is not None:
                entry["source"] = optional(8)
            if layer is not None:
                entry["layer"] = int(layer)
            if optional_float(11) is not None:
                entry["threshold"] = optional_float(11)
            selected = optional_bool(12)
            if selected is not None:
                entry["selected"] = selected
            if optional(13) is not None:
                entry["mode"] = optional(13)
            is_custom = optional_bool(14)
            if is_custom is not None:
                entry["isCustom"] = is_custom
            if optional(15) is not None:
                entry["color"] = optional(15)
            entries.append(entry)
        return entries

    @classmethod
    def load_peak_bed(cls, filepath: str, as_dataframe: bool = True) -> Union["pd.DataFrame", List[dict]]:
        """Load BED3/BED6 or FiberBrowser BED6+ peaks from disk."""
        with open(filepath, "r", encoding="utf-8") as handle:
            entries = cls.parse_peak_bed(handle.read())
        if as_dataframe:
            pd = _ensure_pandas()
            return pd.DataFrame(entries)
        return entries

    @classmethod
    def peak_bed_regions(cls, filepath: str, mode: str = "accessibility") -> List[dict]:
        """Load a BED file as ``cluster_all(peak_regions=...)`` region dicts."""
        return [
            {"start": p["start"], "end": p["end"], "mode": p.get("mode") or mode}
            for p in cls.load_peak_bed(filepath, as_dataframe=False)
        ]

    def set_peaks(self, peaks: Union[List[dict], "pd.DataFrame"], chrom: str = None,
                  label: str = None, lock: bool = True, select: bool = True,
                  replace_existing: bool = True) -> dict:
        """
        Push a peak set into the live browser and optionally lock it.

        This is the notebook-controlled counterpart to importing a BED file in
        the UI. Peaks may be BED-parsed dicts or a DataFrame with chrom/start/end
        columns. If ``chrom`` is provided, peaks without a chrom field are
        assigned to that chromosome.
        """
        rows = []
        for peak in self._peak_records(peaks):
            row = dict(peak)
            if chrom and not row.get("chrom"):
                row["chrom"] = chrom
            if "selected" not in row and "isSelected" in row:
                row["selected"] = bool(row["isSelected"])
            rows.append(row)
        return self._post("/api/jupyter/import_peaks", {
            "peaks": rows,
            "chrom": chrom,
            "label": label,
            "lock": bool(lock),
            "select": bool(select),
            "replace_existing": bool(replace_existing),
        })

    def import_peaks_bed(self, filepath: str, chrom: str = None, label: str = None,
                         lock: bool = True, select: bool = True,
                         replace_existing: bool = True, goto: bool = False,
                         padding: int = 500) -> dict:
        """
        Load a BED3/BED6/FiberBrowser BED6+ peak file into the live browser.

        Args:
            filepath: BED file produced by ``save_peaks_bed`` or any BED3+ file.
            chrom: Optional chromosome to import; defaults to the BED chroms.
            label: Optional label for imported peak rules.
            lock: Lock peaks after import so autoscan cannot shift them.
            select: Select imported peaks for downstream clustering/analysis.
            replace_existing: Remove previous imported peak rules and active
                peak calls before importing. Defaults to True for reproducible
                reloads from notebooks.
            goto: Navigate to the imported peak span before import.
            padding: Base pairs of padding for ``goto=True``.
        """
        peaks = self.load_peak_bed(filepath, as_dataframe=False)
        if goto and peaks:
            target_chrom = chrom or peaks[0].get("chrom")
            target_peaks = [p for p in peaks if not target_chrom or p.get("chrom") == target_chrom]
            if target_chrom and target_peaks:
                view_start = max(0, min(int(p["start"]) for p in target_peaks) - int(padding))
                view_end = max(int(p["end"]) for p in target_peaks) + int(padding)
                self.goto(target_chrom, view_start, view_end)
        return self.set_peaks(
            peaks,
            chrom=chrom,
            label=label,
            lock=lock,
            select=select,
            replace_existing=replace_existing,
        )

    def import_peak_bed(self, filepath: str, **kwargs) -> dict:
        """Alias for ``import_peaks_bed``."""
        return self.import_peaks_bed(filepath, **kwargs)

    def reload_peaks_bed(self, filepath: str, **kwargs) -> dict:
        """Alias for ``import_peaks_bed``."""
        return self.import_peaks_bed(filepath, **kwargs)

    def get_peak_sequences(self, peaks: pd.DataFrame = None, extend: int = 0,
                           strand: str = "+", as_dataframe: bool = True) -> Union[pd.DataFrame, List[dict]]:
        """
        Extract DNA sequences for peaks.

        Requires FASTA file to be configured via set_fasta().

        Args:
            peaks: DataFrame with chrom, start, end columns (default: all peaks from browser)
            extend: Extend each peak by this many bp on each side (default: 0)
            strand: "+" for forward, "-" for reverse complement
            as_dataframe: Return as pandas DataFrame (default: True)

        Returns:
            DataFrame or list with columns:
                - chrom: Chromosome
                - start: Start position (after extension)
                - end: End position (after extension)
                - name: Region name
                - sequence: DNA sequence
                - length: Sequence length

        Example:
            # Get all peaks with 100bp flanking
            seqs = client.get_peak_sequences(extend=100)

            # Get sequences for specific peaks
            my_peaks = peaks[peaks['layer'] == 0]
            seqs = client.get_peak_sequences(my_peaks, extend=50)

            # Write as FASTA
            with open("peaks.fa", "w") as f:
                for _, row in seqs.iterrows():
                    f.write(f">{row['chrom']}:{row['start']}-{row['end']}\\n")
                    f.write(f"{row['sequence']}\\n")
        """
        pd = _ensure_pandas()

        # Get peaks from browser if not provided
        if peaks is None:
            peaks = self.get_peaks(as_dataframe=True)

        if peaks.empty:
            if as_dataframe:
                return pd.DataFrame(columns=['chrom', 'start', 'end', 'name', 'sequence', 'length'])
            return []

        # Build regions list
        regions = []
        for idx, row in peaks.iterrows():
            regions.append({
                'chrom': row['chrom'],
                'start': int(row['start']),
                'end': int(row['end']),
                'name': f"{row['chrom']}:{row['start']}-{row['end']}"
            })

        # Request sequences
        result = self._post("/api/jupyter/sequences", {
            'regions': regions,
            'strand': strand,
            'extend': extend
        })

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to extract sequences'))

        sequences = result.get('sequences', [])

        if as_dataframe:
            if not sequences:
                return pd.DataFrame(columns=['chrom', 'start', 'end', 'name', 'sequence', 'length'])
            return pd.DataFrame(sequences)
        return sequences

    def get_selected_peak_sequences(self, extend: int = 0, strand: str = "+") -> pd.DataFrame:
        """
        Convenience method: get sequences for selected peaks only.

        Args:
            extend: Extend each peak by this many bp on each side
            strand: "+" for forward, "-" for reverse complement

        Returns:
            DataFrame with chrom, start, end, name, sequence, length

        Example:
            # Select peaks in browser, then:
            seqs = client.get_selected_peak_sequences(extend=50)
        """
        peaks = self.get_peaks(selected_only=True)
        return self.get_peak_sequences(peaks, extend=extend, strand=strand)

    # =========================================================================
    # TF Motif Search
    # =========================================================================

    def list_motifs(
        self,
        species: Optional[int] = None,
        tax_group: Optional[str] = None,
        tf_family: Optional[str] = None,
        name_contains: Optional[str] = None,
        as_dataframe: bool = True
    ):
        """
        List available JASPAR motifs with optional filtering.

        Requires pyjaspar: pip install pyjaspar

        Args:
            species: NCBI taxonomy ID (e.g., 7227 for Drosophila melanogaster,
                    9606 for human, 10090 for mouse)
            tax_group: Taxonomic group ('insects', 'vertebrates', 'plants', etc.)
            tf_family: TF family (e.g., 'C2H2 zinc finger factors')
            name_contains: Filter by TF name substring (case-insensitive)
            as_dataframe: Return as pandas DataFrame (default True)

        Returns:
            DataFrame or list of motifs with: matrix_id, name, species, tf_family, length

        Example:
            # List Drosophila motifs
            motifs = client.list_motifs(species=7227)

            # Search for CTCF across all species
            ctcf = client.list_motifs(name_contains="CTCF")
        """
        pd = _ensure_pandas()

        params = {}
        if species is not None:
            params['species'] = species
        if tax_group is not None:
            params['tax_group'] = tax_group
        if tf_family is not None:
            params['tf_family'] = tf_family
        if name_contains is not None:
            params['name_contains'] = name_contains

        result = self._get("/api/jupyter/motifs/list", params=params)

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to list motifs'))

        motifs = result.get('motifs', [])

        if as_dataframe:
            if not motifs:
                return pd.DataFrame(columns=['matrix_id', 'name', 'species', 'tf_family', 'length'])
            return pd.DataFrame(motifs)
        return motifs

    def search_motifs(
        self,
        peaks: Optional['pd.DataFrame'] = None,
        motifs: Optional[List[str]] = None,
        motif_ids: Optional[List[str]] = None,
        threshold: float = 0.8,
        extend: int = 0,
        both_strands: bool = True,
        as_dataframe: bool = True
    ):
        """
        Search for TF motifs in peak sequences.

        Searches JASPAR database for named motifs and/or custom-loaded motifs.
        Requires FASTA to be configured with set_fasta().

        Args:
            peaks: DataFrame with chrom, start, end columns (uses all synced peaks if None)
            motifs: List of TF names to search (e.g., ["CTCF", "GAF"])
            motif_ids: List of JASPAR matrix IDs (e.g., ["MA0139.1"])
            threshold: Score threshold 0-1, where 1 = perfect match (default 0.8)
            extend: Extend each peak by this many bp on each side
            both_strands: Search both forward and reverse strands (default True)
            as_dataframe: Return as pandas DataFrame (default True)

        Returns:
            DataFrame or list of hits with columns:
            - region: Region name
            - chrom, region_start, region_end: Region coordinates
            - motif_id, motif_name: Motif identifiers
            - start, end: Genomic coordinates of hit
            - strand: '+' or '-'
            - score: Raw PSSM score
            - rel_score: Relative score (0-1)
            - matched_seq: Matched DNA sequence

        Example:
            # Search for CTCF in all peaks
            hits = client.search_motifs(motifs=["CTCF"], threshold=0.8)

            # Search selected peaks with extended regions
            selected = client.get_peaks(selected_only=True)
            hits = client.search_motifs(peaks=selected, motifs=["GAF", "M1BP"], extend=100)

            # Use custom motif
            client.load_custom_motif("TATA", {'A':[0,95,0,95], 'C':[0,0,0,0], 'G':[0,0,0,0], 'T':[100,5,100,5]})
            hits = client.search_motifs(motifs=["custom:TATA"])
        """
        pd = _ensure_pandas()

        # Build request
        request_data = {
            'threshold': threshold,
            'extend': extend,
            'both_strands': both_strands
        }

        # Add regions if provided
        if peaks is not None:
            regions = []
            for _, row in peaks.iterrows():
                regions.append({
                    'chrom': row['chrom'],
                    'start': int(row['start']),
                    'end': int(row['end']),
                    'name': f"{row['chrom']}:{row['start']}-{row['end']}"
                })
            request_data['regions'] = regions

        # Add motif specifications
        custom_motifs = []
        jaspar_motifs = []

        if motifs:
            for m in motifs:
                if m.startswith('custom:'):
                    custom_motifs.append(m)
                else:
                    jaspar_motifs.append(m)

        if jaspar_motifs:
            request_data['motifs'] = jaspar_motifs
        if motif_ids:
            request_data['motif_ids'] = motif_ids
        if custom_motifs:
            request_data['custom_motifs'] = custom_motifs

        result = self._post("/api/jupyter/motifs/search", request_data)

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to search motifs'))

        hits = result.get('hits', [])

        if as_dataframe:
            if not hits:
                return pd.DataFrame(columns=[
                    'region', 'chrom', 'region_start', 'region_end',
                    'motif_id', 'motif_name', 'start', 'end', 'strand',
                    'score', 'rel_score', 'matched_seq'
                ])
            return pd.DataFrame(hits)
        return hits

    def load_custom_motif(self, name: str, pwm: Dict[str, List[float]]) -> dict:
        """
        Load a custom PWM for motif searching.

        Args:
            name: Name for the motif (use "custom:name" in search_motifs)
            pwm: Position Weight Matrix as dict with keys 'A', 'C', 'G', 'T',
                 each containing a list of counts per position.

        Returns:
            dict with success status and motif length

        Example:
            # TATA box motif
            client.load_custom_motif("TATA_box", {
                'A': [0, 95, 0, 95],
                'C': [0, 0, 0, 0],
                'G': [0, 0, 0, 0],
                'T': [100, 5, 100, 5]
            })

            # Then search with it
            hits = client.search_motifs(motifs=["custom:TATA_box"])
        """
        result = self._post("/api/jupyter/motifs/custom", {
            'name': name,
            'counts': pwm
        })

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to load motif'))

        return result

    def load_custom_motifs(self, file_path: str, format: str = "auto") -> dict:
        """
        Load motifs from a file.

        Supports JASPAR (.jaspar, .pfm) and MEME (.meme) formats.

        Args:
            file_path: Path to motif file
            format: 'auto' (detect from extension), 'jaspar', or 'meme'

        Returns:
            dict with success status and list of loaded motif names

        Example:
            # Load from JASPAR format file
            client.load_custom_motifs("my_motifs.jaspar")

            # Load from MEME format
            client.load_custom_motifs("motifs.meme", format="meme")

            # Search with loaded motifs
            hits = client.search_motifs(motifs=["custom:CTCF", "custom:GAF"])
        """
        result = self._post("/api/jupyter/motifs/load_file", {
            'file_path': file_path,
            'format': format
        })

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to load motifs'))

        return result

    def list_custom_motifs(self, as_dataframe: bool = True):
        """
        List all registered custom motifs.

        Returns:
            DataFrame or list with name and length of each custom motif
        """
        pd = _ensure_pandas()

        result = self._get("/api/jupyter/motifs/custom")

        if not result.get('success'):
            raise ValueError(result.get('error', 'Failed to list custom motifs'))

        motifs = result.get('motifs', [])

        if as_dataframe:
            if not motifs:
                return pd.DataFrame(columns=['name', 'length'])
            return pd.DataFrame(motifs)
        return motifs

    def clear_custom_motifs(self, name: Optional[str] = None) -> dict:
        """
        Remove custom motifs.

        Args:
            name: Specific motif name to remove, or None to list all

        Note: To remove a specific motif, use delete_custom_motif().

        Returns:
            List of current custom motifs
        """
        if name:
            return self.delete_custom_motif(name)
        return self.list_custom_motifs(as_dataframe=False)

    def delete_custom_motif(self, name: str) -> dict:
        """
        Remove a specific custom motif.

        Args:
            name: Name of the motif to remove

        Returns:
            dict with success status
        """
        result = self._delete(f"/api/jupyter/motifs/custom/{name}")

        if not result.get('success'):
            raise ValueError(result.get('error', f'Failed to delete motif {name}'))

        return result

    def get_selection(self, dataset_id: str = None) -> List[str]:
        """Get read IDs selected by user/browser or Python selection commands."""
        params = {'dataset_id': dataset_id} if dataset_id else None
        result = self._get("/api/jupyter/selection", params=params)
        return result.get('read_ids', [])

    def set_jupyter_selection(self, read_ids: List[str], dataset_id: str = None) -> dict:
        """Set the read IDs selected in the live browser from Python/Jupyter."""
        params = {'dataset_id': dataset_id} if dataset_id else None
        return self._post("/api/jupyter/selection", list(read_ids), params=params)
    
    def get_jupyter_state(self) -> dict:
        """Get full Jupyter integration state (for debugging)."""
        return self._get("/api/jupyter/state")
    
    # =========================================================================
    # Headless Mode
    # =========================================================================

    @classmethod
    def headless(cls, bam: str = None, gtf: str = None, fasta: str = None,
                 fire: str = None, dataset: List[str] = None,
                 port: int = None, timeout: int = 30, quiet: bool = True,
                 copilot: str = 'off',
                 **kwargs) -> 'BrowserClient':
        """Start a FiberBrowser server as a subprocess and connect to it.

        Use as a context manager for automatic cleanup::

            with BrowserClient.headless(bam="data.bam", gtf="genes.gtf") as client:
                img = client.render("chr1", 1000000, 1020000)
                img.save("figure.png")

        Args:
            bam: Path to BAM or BigBed file
            gtf: Path to GTF annotation file
            fasta: Path to reference FASTA file
            fire: Path to FIRE BED directory
            dataset: List of additional dataset paths (``PATH:LABEL`` format)
            port: Server port (auto-selected if None)
            timeout: Seconds to wait for server readiness
            quiet: Suppress server stdout/stderr
            copilot: Copilot backend mode passed to the server
                (``off``/``auto``/``mlx``/``ollama``). Defaults to ``off`` —
                headless/Jupyter use doesn't need the natural-language panel, and
                ``off`` avoids the auto-download/spawn that would otherwise block
                startup. Pass ``auto`` to opt back in.

        Returns:
            Connected BrowserClient with ``_headless_proc`` set.
        """
        import subprocess, sys, os, socket, time, atexit

        # Find free port
        if port is None:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', 0))
                port = s.getsockname()[1]

        # Build command
        browser_py = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'browser.py'
        )
        cmd = [sys.executable, browser_py, '-p', str(port)]
        # Headless/programmatic server: never pop a GUI browser window. (Opening
        # Chrome also fires its own API requests that pollute caches during tests.)
        cmd.append('--no-open')
        if copilot:
            cmd.extend(['--copilot', copilot])
        if bam:
            cmd.extend(['-b', bam])
        if gtf:
            cmd.extend(['-g', gtf])
        if fasta:
            cmd.extend(['-f', fasta])
        if fire:
            cmd.extend(['-r', fire])
        if dataset:
            for ds in dataset:
                cmd.extend(['--dataset', ds])
        if not bam and not dataset:
            cmd.append('--standalone')

        devnull = subprocess.DEVNULL if quiet else None
        import secrets
        token = secrets.token_urlsafe(32)  # this server's access token
        child_env = {**os.environ, "FIBERBROWSER_HEADLESS": "1", "FIBERBROWSER_TOKEN": token}
        proc = subprocess.Popen(cmd, stdout=devnull, stderr=devnull, env=child_env)

        # Register cleanup in case user forgets to call close()
        def _cleanup():
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
        atexit.register(_cleanup)

        # Poll until server is ready
        url = f"http://localhost:{port}"
        deadline = time.time() + timeout
        last_err = None
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"Server process exited with code {proc.returncode}"
                )
            try:
                r = requests.get(f"{url}/api/status", timeout=2, headers={TOKEN_HEADER: token})
                if r.status_code == 200:
                    break
            except requests.exceptions.RequestException as e:
                last_err = e
            time.sleep(0.3)
        else:
            proc.terminate()
            raise TimeoutError(
                f"Server at {url} did not become ready within {timeout}s. "
                f"Last error: {last_err}"
            )

        client = cls.__new__(cls)
        client.url = url
        client.token = token
        client._session = None
        client._http_session()
        client._headless_proc = proc
        client._atexit_cleanup = _cleanup
        return client

    def close(self):
        """Close the HTTP session and shut down the headless server subprocess (if any)."""
        session = getattr(self, '_session', None)
        if session is not None:
            session.close()
            self._session = None

        proc = getattr(self, '_headless_proc', None)
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
            self._headless_proc = None

        # Unregister atexit cleanup
        cleanup = getattr(self, '_atexit_cleanup', None)
        if cleanup is not None:
            import atexit
            try:
                atexit.unregister(cleanup)
            except Exception:
                pass
            self._atexit_cleanup = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False

    # =========================================================================
    # Footprint analysis (Binding panel)
    # =========================================================================

    def analyze_footprints(self, chrom: str = None, start: int = None,
                           end: int = None, dataset_id: str = None,
                           read_ids: list = None, footprints: List[dict] = None,
                           dataset_ids: List[str] = None, spanning: bool = False,
                           groups: List[dict] = None, max_reads: int = None,
                           read_ids_by_dataset: Dict[str, List[str]] = None,
                           layer: str = None, include_overlap_sizes: bool = True,
                           layers: Optional[Union[str, Sequence[str]]] = None,
                           include_read_analysis: bool = True,
                           auto_motifs: bool = True,
                           custom_motif_names: List[str] = None,
                           motif_track_indices: List[int] = None,
                           custom_pwms: List[dict] = None,
                           motif_threshold: float = 0.8,
                           flank_bp: int = 20,
                           profile_window: int = 500,
                           include_sequences: bool = True,
                           include_motifs: bool = True,
                           include_overlap: bool = True,
                           include_profiles: bool = True,
                           include_vplot: bool = True,
                           include_coocc: bool = True,
                           vplot_size_bin: int = 10,
                           vplot_pos_bin: int = 10,
                           vplot_size_min: int = 10,
                           vplot_size_max: int = 300,
                           vplot_log: bool = True,
                           vplot_smooth: float = 1.0,
                           sample_seed: str = None) -> dict:
        """Run footprint analysis on explicit footprint regions.

        Args:
            footprints: List of dicts with absStart/absEnd/size/readId/datasetId.
                Simple dicts with start/end are also accepted and normalized.
            dataset_id: Single dataset convenience selector.
            dataset_ids: Multiple dataset IDs. Defaults to all loaded datasets
                when dataset_id is omitted.
            read_ids: Optional read ID filter for the selected dataset.
            read_ids_by_dataset: Optional read ID filters keyed by dataset ID.
            sample_seed: Optional seed for reproducible max_reads sampling.
            layer: Optional annotation layer to analyze (e.g. 'tf', 'nuc', 'all_fp').
            layers: Optional layer names for per-layer aggregate profiles.
            include_read_analysis: Master switch for overlap/profile/V-plot/co-occ work.
            include_overlap_sizes: Include raw per-read size arrays. Set false
                for faster histogram-only payloads on high-coverage regions.
            motif_track_indices: Optional backend track indices for loaded custom
                motif tracks to include alongside/instead of JASPAR.
            custom_pwms: Optional list of raw PWM dictionaries to scan without
                first adding them as persistent browser tracks.

        Returns profiles, size histograms, overlap statistics, and optional
        sequence/motif/V-plot/co-occupancy data based on include_* flags.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        target_dataset_ids = dataset_ids or ([dataset_id] if dataset_id else [])
        default_footprint_dataset_id = target_dataset_ids[0] if target_dataset_ids else None

        def fallback_footprint_dataset_id() -> str:
            nonlocal default_footprint_dataset_id
            if not default_footprint_dataset_id:
                default_footprint_dataset_id = self._default_dataset_id_or_legacy()
            return default_footprint_dataset_id

        normalized_footprints = []
        for i, fp in enumerate(footprints or []):
            if isinstance(fp, dict):
                abs_start = fp.get('absStart', fp.get('abs_start', fp.get('start')))
                abs_end = fp.get('absEnd', fp.get('abs_end', fp.get('end')))
                if abs_start is None or abs_end is None:
                    continue
                normalized_footprints.append({
                    'absStart': int(abs_start),
                    'absEnd': int(abs_end),
                    'size': int(fp.get('size', int(abs_end) - int(abs_start))),
                    'readId': fp.get('readId', fp.get('read_id', f'footprint_{i}')),
                    'datasetId': fp.get('datasetId', fp.get('dataset_id', fallback_footprint_dataset_id())),
                })
            elif isinstance(fp, (list, tuple)) and len(fp) >= 2:
                abs_start, abs_end = int(fp[0]), int(fp[1])
                normalized_footprints.append({
                    'absStart': abs_start,
                    'absEnd': abs_end,
                    'size': int(fp[2]) if len(fp) > 2 else abs_end - abs_start,
                    'readId': f'footprint_{i}',
                    'datasetId': fallback_footprint_dataset_id(),
                })

        params = (
            f"chrom={chrom}&region_start={int(start)}&region_end={int(end)}"
            f"&spanning={str(spanning).lower()}"
        )
        body = {
            'footprints': normalized_footprints,
            'dataset_ids': target_dataset_ids,
            'auto_motifs': auto_motifs,
            'custom_motif_names': custom_motif_names,
            'motif_track_indices': motif_track_indices,
            'custom_pwms': custom_pwms,
            'motif_threshold': motif_threshold,
            'flank_bp': flank_bp,
            'profile_window': profile_window,
            'groups': groups,
            'max_reads': max_reads,
            'sample_seed': sample_seed,
            'include_read_analysis': include_read_analysis,
            'include_sequences': include_sequences,
            'include_motifs': include_motifs,
            'include_overlap': include_overlap,
            'include_overlap_sizes': include_overlap_sizes,
            'include_profiles': include_profiles,
            'include_vplot': include_vplot,
            'include_coocc': include_coocc,
            'vplot_size_bin': vplot_size_bin,
            'vplot_pos_bin': vplot_pos_bin,
            'vplot_size_min': vplot_size_min,
            'vplot_size_max': vplot_size_max,
            'vplot_log': vplot_log,
            'vplot_smooth': vplot_smooth,
        }
        self._add_layer_param(body, layer)
        profile_layers = self._layer_names_list(layers)
        if profile_layers:
            body['layers'] = profile_layers
        # An explicit empty selection (read_ids=[]) scopes to no reads.
        if read_ids_by_dataset is not None:
            body['read_ids_by_dataset'] = read_ids_by_dataset
        elif read_ids is not None:
            body['read_ids_by_dataset'] = {fallback_footprint_dataset_id(): list(read_ids)}
        return self._post(f"/api/footprint/analyze?{params}", body)

    @classmethod
    def format_footprint_cooccurrence_tsv(cls, result: dict,
                                          groups: Sequence[dict],
                                          datasets: Sequence[dict] = None) -> str:
        """Format Binding co-occupancy output as TSV.

        The schema matches the browser's Binding > Co-occupancy
        export and includes per-group counts, pairwise contingency cells,
        odds ratios, raw/FDR-adjusted p values, and the read IDs used for each cell.
        """
        header = [
            "scope", "dataset_id", "dataset_label", "total_reads",
            "group_i", "group_i_name", "group_j", "group_j_name",
            "cell", "n_reads", "odds_ratio", "p_value", "q_value", "read_ids",
        ]
        dataset_labels = {
            str(ds.get("id")): str(ds.get("label") or ds.get("id"))
            for ds in (datasets or [])
            if isinstance(ds, dict) and ds.get("id") is not None
        }
        enabled_groups = [group for group in (groups or []) if group.get("enabled", True)]
        coocc = (result or {}).get("co_occupancy") or {}
        lines = ["\t".join(header)]

        def group_name(index: int) -> str:
            if 0 <= index < len(enabled_groups):
                return str(enabled_groups[index].get("name") or enabled_groups[index].get("id") or index)
            return str(index)

        def read_ids(ids: Any) -> str:
            return ",".join(str(read_id) for read_id in (ids or []))

        for dataset_id, summary in coocc.items():
            if not isinstance(summary, dict):
                continue
            dataset_id = str(dataset_id)
            dataset_label = dataset_labels.get(dataset_id, dataset_id)
            total_reads = int(summary.get("total_reads", 0) or 0)

            for gi, per_group in enumerate(summary.get("per_group") or []):
                if not isinstance(per_group, dict):
                    continue
                for cell, count_key, ids_key in (
                    ("with", "n_with", "ids_with"),
                    ("without", "n_without", "ids_without"),
                ):
                    row = [
                        "single", dataset_id, dataset_label, total_reads,
                        gi, group_name(gi), "", "",
                        cell, int(per_group.get(count_key, 0) or 0), "", "", "",
                        read_ids(per_group.get(ids_key)),
                    ]
                    lines.append("\t".join(cls._tsv_cell(value) for value in row))

            for pair in summary.get("pairs") or []:
                if not isinstance(pair, dict):
                    continue
                gi = int(pair.get("group_i", -1))
                gj = int(pair.get("group_j", -1))
                odds_ratio = pair.get("odds_ratio")
                if isinstance(odds_ratio, (int, float)) and not math.isfinite(float(odds_ratio)):
                    odds_ratio = "inf"
                for cell, count_key, ids_key in (
                    ("both", "n_both", "ids_both"),
                    ("i_only", "n_i_only", "ids_i_only"),
                    ("j_only", "n_j_only", "ids_j_only"),
                    ("neither", "n_neither", "ids_neither"),
                ):
                    row = [
                        "pair", dataset_id, dataset_label, total_reads,
                        gi, group_name(gi), gj, group_name(gj),
                        cell, int(pair.get(count_key, 0) or 0),
                        odds_ratio, pair.get("p_value"), pair.get("q_value", ""), read_ids(pair.get(ids_key)),
                    ]
                    lines.append("\t".join(cls._tsv_cell(value) for value in row))

        return "\n".join(lines) + "\n"

    def save_footprint_cooccurrence_tsv(self, filepath: str, result: dict,
                                        groups: Sequence[dict],
                                        datasets: Sequence[dict] = None) -> str:
        """Write Binding co-occupancy output to a TSV file."""
        text = self.format_footprint_cooccurrence_tsv(result, groups, datasets=datasets)
        with open(filepath, "w", encoding="utf-8") as handle:
            handle.write(text)
        return filepath

    def save_footprint_rules(self, output_dir: str, groups: List[dict] = None,
                             chrom: str = None, start: int = None, end: int = None,
                             dataset_id: str = None, dataset_ids: List[str] = None,
                             spanning: bool = None, bundle_name: str = None,
                             sample_seed: str = None) -> dict:
        """Save saved footprint list (Binding > Saved) definitions as portable rule JSON.

        Rules are portable size/layer/position definitions that can be loaded
        onto other datasets. Use ``save_derived_layers`` only when you need a
        frozen per-read BED/BigBed snapshot for the current datasets.
        """
        state = None
        if groups is None:
            state = self.get_analysis_state()
            groups = state.get("footprint_groups", [])
        if chrom is None or start is None or end is None:
            region = self.get_region()
            chrom = chrom or region["chrom"]
            start = int(start if start is not None else region["start"])
            end = int(end if end is not None else region["end"])
        target_dataset_ids = dataset_ids or ([dataset_id] if dataset_id else None)
        if target_dataset_ids is None:
            state = state or self.get_analysis_state()
            manifest_datasets = (state.get("manifest") or {}).get("datasets") or []
            target_dataset_ids = [d.get("id") for d in manifest_datasets if d.get("id")] or None
        if spanning is None:
            state = state or self.get_analysis_state()
            spanning = (state.get("reproducibility") or {}).get("spanning_only")
        if sample_seed is None:
            state = state or self.get_analysis_state()
            sample_seed = (state.get("reproducibility") or {}).get("analysis_sample_seed")

        return self._post("/api/footprint/rules/save", {
            "groups": groups,
            "output_dir": output_dir,
            "bundle_name": bundle_name,
            "chrom": chrom,
            "start": int(start),
            "end": int(end),
            "spanning": spanning,
            "dataset_ids": target_dataset_ids,
            "sample_seed": sample_seed,
        })

    def load_footprint_rules(self, path: str, apply: bool = True,
                             append: bool = False) -> dict:
        """Load portable saved footprint list (Binding > Saved) rules from JSON.

        ``.fiberlayer-rules.json`` is the primary format. Legacy
        ``.fiberlayers.json`` manifests are converted back into portable rules.
        When ``apply`` is true, rules are queued into the live browser cart.
        """
        result = self._post("/api/footprint/rules/load", {"path": path})
        groups = result.get("groups") if isinstance(result, dict) else None
        if apply and result.get("success") and isinstance(groups, list):
            if append:
                existing = self.get_footprint_rules()
                imported = [{**group, "id": str(uuid.uuid4())} for group in groups]
                groups_to_apply = existing + imported
            else:
                groups_to_apply = groups
            result["applied"] = self.set_footprint_rules(groups_to_apply)
        return result

    def reload_footprint_rules(self, path: str, **kwargs) -> dict:
        """Alias for ``load_footprint_rules``."""
        return self.load_footprint_rules(path, **kwargs)

    def import_footprint_rules(self, path: str, **kwargs) -> dict:
        """Alias for ``load_footprint_rules``."""
        return self.load_footprint_rules(path, **kwargs)

    def save_fiberlayer_rules(self, *args, **kwargs) -> dict:
        """Alias for portable rule JSON; prefer over materialized layer bundles."""
        return self.save_footprint_rules(*args, **kwargs)

    def load_fiberlayer_rules(self, path: str, **kwargs) -> dict:
        """Alias for portable saved-footprint rule JSON loading."""
        return self.load_footprint_rules(path, **kwargs)

    def reload_fiberlayer_rules(self, path: str, **kwargs) -> dict:
        """Alias for portable saved-footprint rule JSON loading."""
        return self.load_footprint_rules(path, **kwargs)

    def save_derived_layers(self, output_dir: str, groups: List[dict] = None,
                            chrom: str = None, start: int = None, end: int = None,
                            dataset_id: str = None, dataset_ids: List[str] = None,
                            spanning: bool = None, bundle_name: str = None,
                            include_disabled: bool = False,
                            read_ids_by_dataset: Dict[str, List[str]] = None,
                            max_reads: int = None,
                            sample_seed: str = None) -> dict:
        """Save footprint cart definitions as materialized `.fiberlayers` bundles.

        If `groups` is omitted, uses the browser-synced saved footprint list (Binding > Saved)
        (`get_analysis_state()["footprint_groups"]`). The backend writes one
        bundle per dataset and immediately registers any generated BigBeds with
        the live browser session. For portable reusable definitions, prefer
        ``save_footprint_rules``.
        """
        settings = None
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        if groups is None:
            settings = self.get_analysis_state()
            groups = settings.get("footprint_groups", [])
        target_dataset_ids = dataset_ids or ([dataset_id] if dataset_id else None)
        if not target_dataset_ids:
            settings = settings or self.get_analysis_state()
            manifest_datasets = (settings.get("manifest") or {}).get("datasets") or []
            target_dataset_ids = [d.get("id") for d in manifest_datasets if d.get("id")] or []
        if spanning is None:
            settings = settings or self.get_analysis_state()
            repro = (settings.get("reproducibility") or {})
            spanning_value = repro.get("spanning_only")
            if spanning_value is None:
                spanning_value = self.get_browser_settings().get("spanning_only")
            spanning = bool(spanning_value)
        if sample_seed is None:
            settings = settings or self.get_analysis_state()
            repro = (settings.get("reproducibility") or {})
            sample_seed = repro.get("analysis_sample_seed")
            if sample_seed is None:
                sample_seed = self.get_browser_settings().get("analysis_sample_seed")

        params = {
            "chrom": chrom,
            "region_start": int(start),
            "region_end": int(end),
            "spanning": str(bool(spanning)).lower(),
        }
        body = {
            "dataset_ids": target_dataset_ids,
            "groups": groups,
            "output_dir": output_dir,
            "bundle_name": bundle_name,
            "include_disabled": include_disabled,
            "read_ids_by_dataset": read_ids_by_dataset,
            "max_reads": max_reads,
            "sample_seed": sample_seed,
        }
        return self._post("/api/footprint/derived_layers/export", body, params=params)

    def load_derived_layers(self, path: str, dataset_id: str = None,
                            dataset_ids: List[str] = None) -> dict:
        """Load a saved `.fiberlayers` bundle into matching loaded datasets.

        `path` may be the `.fiberlayers.json` manifest, `.fiberlayers.bb`
        BigBed, or local `.fiberlayers.bed` fallback. If dataset IDs are
        omitted, the backend tries all loaded datasets and attaches only where
        the bundle source matches.
        """
        target_dataset_ids = dataset_ids or ([dataset_id] if dataset_id else None)
        return self._post("/api/footprint/derived_layers/load", {
            "path": path,
            "dataset_ids": target_dataset_ids,
        })

    def auto_cull_clusters(self, chrom: str = None, start: int = None,
                           end: int = None, assignments: dict = None,
                           peak_regions: list = None, dataset_ids: list = None,
                           spanning: bool = False,
                           subnucleosomal_threshold: int = 90,
                           accessibility_threshold: float = 0.5,
                           min_fraction: float = 0.05,
                           max_cosine_similarity: float = 0.95,
                           sample_seed: str = None,
                           cluster_feature_rules: Sequence[dict] = None) -> dict:
        """Auto-cull low-abundance and similar clusters.

        Args:
            assignments: Current cluster assignments {ds_id: {read_id: cluster}}
            peak_regions: List of peak region dicts
            min_fraction: Clusters below this fraction are culled
            max_cosine_similarity: Clusters more similar than this are merged
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        body = {
            'current_assignments': assignments or {},
            'peak_regions': peak_regions or [],
            'dataset_ids': dataset_ids or [],
            'subnucleosomal_threshold': subnucleosomal_threshold,
            'accessibility_threshold': accessibility_threshold,
            'min_fraction': min_fraction,
            'max_cosine_similarity': max_cosine_similarity,
        }
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        rules = self._cluster_feature_rules_for_regions(peak_regions or [], cluster_feature_rules)
        if rules:
            body['cluster_feature_rules'] = rules
        return self._post("/api/auto_cull_clusters", data=body, params=params)

    def detect_peaks(self, chrom: str = None, start: int = None,
                     end: int = None, signal_source: str = 'accessibility',
                     threshold_strong: float = 0.50, threshold_medium: float = 0.30,
                     threshold_weak: float = 0.15, threshold_rare: float = 0.08,
                     min_width: int = 80, return_signal: bool = False) -> dict:
        """Auto-detect peaks from signal tracks.

        Args:
            signal_source: One of 'accessibility', 'fire', 'tf_density',
                'tf_layer', 'nuc_layer', 'm6a', 'm5c', 'deam', or
                'track:{idx}'. Same options as scan_peaks; legacy 'msp'
                is accepted as a FIRE alias. Modification
                sources (m6a/m5c/deam) report per-base mark density /
                read coverage.
            threshold_*: Layer thresholds
            return_signal: Include downsampled signal for visualization
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = f"chrom={chrom}&start={int(start)}&end={int(end)}"
        body = {
            'signal_source': signal_source,
            'threshold_strong': threshold_strong,
            'threshold_medium': threshold_medium,
            'threshold_weak': threshold_weak,
            'threshold_rare': threshold_rare,
            'min_width': min_width,
            'return_signal': return_signal,
        }
        # Source-based detection is the peak scan; /api/detect_peaks takes a
        # ready signal array (see detect_signal_peaks).
        return self._post(f"/api/scan_peaks?{params}", body)

    def detect_signal_peaks(self, signal: Sequence[float],
                            chrom: str, start: int, end: int,
                            label: str = "",
                            min_distance: int = 100,
                            min_width: int = 80,
                            threshold_pct: int = 50,
                            threshold_value: float = None) -> dict:
        """Detect peaks from an arbitrary numeric signal array.

        This mirrors the generic frontend helper used for BigWig, annotation,
        and metaprofile-derived signals.
        """
        body = {
            'signal': list(signal),
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'label': label,
            'min_distance_bp': int(min_distance),
            'min_width_bp': int(min_width),
            'threshold_percentile': int(threshold_pct),
        }
        if threshold_value is not None:
            body['threshold_value'] = float(threshold_value)
        return self._post("/api/detect_peaks", body)

    def get_compact_reads(self, chrom: str = None, start: int = None,
                          end: int = None, dataset_id: str = None,
                          spanning: bool = True, include_methylation: bool = True,
                          include_layers: bool = False,
                          layer_names: Optional[Union[str, Sequence[str]]] = None,
                          include_cigar: bool = False,
                          min_fp_quality: int = 0,
                          min_footprints: int = 0,
                          max_reads: int = 500,
                          fill_gap_size: int = None,
                          infer_legacy_layers: Optional[bool] = None,
                          legacy_nuc_min_size: Optional[int] = None,
                          sample_seed: str = None) -> list:
        """Get compact read data with intervals and per-type modification marks.

        Args:
            min_fp_quality: Minimum nq quality score (0-255). Footprints below
                this threshold are hidden. Useful for filtering low-confidence calls.
            min_footprints: Minimum footprint count per read.
            include_methylation: Include per-base modification marks parsed from
                BAM MM/ML (split by mod code: A+a → m6A, C+m → 5mC, u / ChEBI
                55797 → deam) and, for DAF-seq, IUPAC R/Y codes or ref mismatches.
            include_layers: Include all display annotation layers (TF/Nuc/FIRE/etc.).
                Leave false for lean interval-only reads.
            layer_names: Optional layer name or list of names to load selectively.
                Passing this implies include_layers=True; use e.g. ['tf'] to avoid
                loading every companion BigBed/layer.
            include_cigar: Include CIGAR events (mismatches, indels).
            max_reads: Maximum display reads (sampled from working set).
            infer_legacy_layers: Infer TF/nuc/FIRE from legacy footprint-only
                datasets. ``None`` uses the browser/backend default.
            legacy_nuc_min_size: Footprint size cutoff for inferred nucs.
            sample_seed: Optional seed for reproducible sampling paths.

        Returns:
            list of dicts with keys:
                'id'            — read name
                'intervals'     — [[start, end, size], ...] (size<0 = gap)
                'methyl'        — legacy position-only union (back-compat)
                'methyl_m6a'    — m6A positions from MM/ML A+a or _m6a.bb
                'methyl_m5c'    — 5mC positions from MM/ML C+m or _m5c.bb
                'deam'          — [[pos, blockMod], ...] DAF deamination events.
                                  blockMod 0 = R (GA-dea), 1 = Y (CT-dea)
                'fire'          — [[s, e, q], ...] FIRE intervals (legacy as/al/aq)
                'layers'        — {layer_name: {intervals, qualities, quality_names}}
                                  from v3 BAMs or BED12+N BigBeds
                'qualities'     — per-footprint nq (primary layer)
                'cigar'         — CIGAR events (when include_cigar=True)
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower(),
                  'include_methylation': str(include_methylation).lower(),
                  'include_cigar': str(include_cigar).lower(),
                  'max_reads': max_reads}
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        if dataset_id:
            params['dataset_id'] = dataset_id
        layer_names_param = self._layer_names_param(layer_names)
        if layer_names_param:
            params['include_layers'] = 'true'
            params['layer_names'] = layer_names_param
        elif include_layers:
            params['include_layers'] = 'true'
        if min_fp_quality > 0:
            params['min_fp_quality'] = min_fp_quality
        if min_footprints > 0:
            params['min_footprints'] = min_footprints
        if fill_gap_size is not None:
            params['fill_gap_size'] = fill_gap_size
        if infer_legacy_layers is not None:
            params['infer_legacy_layers'] = str(bool(infer_legacy_layers)).lower()
        if legacy_nuc_min_size is not None:
            params['legacy_nuc_min_size'] = int(legacy_nuc_min_size)
        resp = self._get('/api/reads/compact', params=params)
        return resp.get('reads', [])

    # ---------- Modification-focused convenience methods ----------
    #
    # Thin wrappers over get_compact_reads / scan_peaks / scan_and_cluster
    # that pre-select the per-type field (methyl_m6a / methyl_m5c / deam) so
    # notebooks don't have to know which field corresponds to which mod.
    # All of them accept the same `chrom/start/end/dataset_id/spanning`
    # kwargs as their non-mod counterparts.

    _MOD_FIELD = {'m6a': 'methyl_m6a', 'm5c': 'methyl_m5c', 'deam': 'deam'}

    def get_available_mods(self, dataset_id: str = None) -> Dict[str, bool]:
        """Report which modification layers the backend has detected.

        Returns a dict like ``{'m6a': True, 'm5c': False, 'deam': True}``
        aggregated across loaded datasets (union) or for a single dataset
        when ``dataset_id`` is set. Handy as a first-query gate so scripts
        don't call scan_mod_peaks('m5c') on data that doesn't carry 5mC.
        """
        datasets = self._get('/api/datasets').get('datasets', [])
        if dataset_id:
            datasets = [d for d in datasets if d.get('id') == dataset_id]
        present = {'m6a': False, 'm5c': False, 'deam': False}
        for d in datasets:
            layers = d.get('available_layers') or {}
            for k in present:
                if layers.get(k):
                    present[k] = True
            # Legacy `mod` key maps to m6a in this codebase.
            if layers.get('mod'):
                present['m6a'] = True
        return present

    def get_modifications(self, mod_type: str = 'm6a',
                          chrom: str = None, start: int = None, end: int = None,
                          dataset_id: str = None, spanning: bool = True,
                          min_footprints: int = 0, max_reads: int = 500,
                          read_ids: List[str] = None,
                          sample_seed: str = None) -> Dict[str, list]:
        """Return per-read modification positions for the current viewport.

        Args:
            mod_type: 'm6a' | 'm5c' | 'deam'.
            read_ids: Optional list of read IDs to restrict the return to.
            sample_seed: Optional seed for reproducible display sampling.

        Returns:
            Dict ``{read_id: positions}``. For m6a/m5c the positions are
            flat region-relative ints. For deam they are ``[[pos, blockMod],
            ...]`` pairs — ``blockMod 0 = R (GA-deamination)``, ``1 = Y
            (CT-deamination)``. Empty dict when no reads carry the layer.

        Example::

            # Only reads with ≥50 m6a marks
            m6a = b.get_modifications('m6a')
            heavy = {rid: pos for rid, pos in m6a.items() if len(pos) >= 50}
        """
        if mod_type not in self._MOD_FIELD:
            raise ValueError(f"mod_type must be one of {list(self._MOD_FIELD)}")
        field = self._MOD_FIELD[mod_type]
        reads = self.get_compact_reads(chrom=chrom, start=start, end=end,
                                       dataset_id=dataset_id, spanning=spanning,
                                       include_methylation=True,
                                       min_footprints=min_footprints,
                                       max_reads=max_reads,
                                       sample_seed=sample_seed)
        # An explicit empty selection (read_ids=[]) matches no reads.
        allowed = set(read_ids) if read_ids is not None else None
        out: Dict[str, list] = {}
        for r in reads:
            rid = r.get('id')
            if allowed is not None and rid not in allowed:
                continue
            data = r.get(field)
            if not data:
                continue
            out[rid] = data
        return out

    def get_deam_by_strand(self, strand: str,
                           chrom: str = None, start: int = None, end: int = None,
                           dataset_id: str = None, spanning: bool = True,
                           **kwargs) -> Dict[str, List[int]]:
        """Deamination positions filtered to a single strand flavor.

        Args:
            strand: ``'R'`` / ``'GA'`` = GA-deamination (``blockMod=0``),
                    ``'Y'`` / ``'CT'`` = CT-deamination (``blockMod=1``).

        Returns:
            Dict ``{read_id: [pos, pos, ...]}`` — the blockMod dim has been
            filtered out, so each value is a flat position list. Useful for
            per-strand density heatmaps or strand-specific clustering.
        """
        key = strand.upper()
        if key in ('R', 'GA', 'GA-DEA', '0'):
            target = 0
        elif key in ('Y', 'CT', 'CT-DEA', '1'):
            target = 1
        else:
            raise ValueError(f"strand must be R/Y or GA/CT (got {strand!r})")
        raw = self.get_modifications('deam', chrom=chrom, start=start, end=end,
                                     dataset_id=dataset_id, spanning=spanning,
                                     **kwargs)
        out: Dict[str, List[int]] = {}
        for rid, events in raw.items():
            positions = [ev[0] for ev in events if len(ev) > 1 and ev[1] == target]
            if positions:
                out[rid] = positions
        return out

    def count_modifications(self, mod_type: str = 'm6a',
                            chrom: str = None, start: int = None, end: int = None,
                            dataset_id: str = None, spanning: bool = True,
                            **kwargs) -> Dict[str, int]:
        """Per-read mark count for the given modification type.

        Returns ``{read_id: count}``. For ``deam`` the count is total events
        regardless of strand — use ``get_deam_by_strand`` if you need per-
        strand counts. Empty dict when the layer is not present.
        """
        data = self.get_modifications(mod_type, chrom=chrom, start=start, end=end,
                                      dataset_id=dataset_id, spanning=spanning,
                                      **kwargs)
        return {rid: len(marks) for rid, marks in data.items()}

    def scan_mod_peaks(self, mod_type: str = 'm6a',
                       chrom: str = None, start: int = None, end: int = None,
                       dataset_id: str = None, spanning: bool = True,
                       **kwargs) -> dict:
        """Peak-call on per-base modification density.

        Thin wrapper over :meth:`scan_peaks` with ``signal_source`` preset
        to the right mod type. Signal is mark_count / read_coverage at
        each base.
        """
        if mod_type not in self._MOD_FIELD:
            raise ValueError(f"mod_type must be one of {list(self._MOD_FIELD)}")
        return self.scan_peaks(chrom=chrom, start=start, end=end,
                               dataset_id=dataset_id, spanning=spanning,
                               signal_source=mod_type, **kwargs)

    def cluster_by_mod(self, mod_type: str = 'm6a', k: int = 5,
                       method: str = 'kmeans',
                       chrom: str = None, start: int = None, end: int = None,
                       spanning: bool = False, **kwargs) -> dict:
        """Scan peaks on modification density, then cluster reads by them.

        Shortcut for :meth:`scan_and_cluster` with the signal source wired
        to m6a / m5c / deam. Resulting cluster patterns are binary
        presence-vectors over the detected mod-density peaks.
        """
        if mod_type not in self._MOD_FIELD:
            raise ValueError(f"mod_type must be one of {list(self._MOD_FIELD)}")
        return self.scan_and_cluster(k=k, method=method, signal_source=mod_type,
                                     chrom=chrom, start=start, end=end,
                                     spanning=spanning, **kwargs)

    # ---------- Per-interval quality access + filtering ----------
    #
    # Each annotation layer exposes a `qualities` / `quality_names` pair on
    # every read (see get_compact_reads). These helpers project that shape
    # so notebooks don't have to hunt through a nested dict.

    def get_interval_qualities(self, layer: str, quality_name: str = None,
                               chrom: str = None, start: int = None, end: int = None,
                               dataset_id: str = None, spanning: bool = True,
                               max_reads: int = 500,
                               read_ids: List[str] = None,
                               sample_seed: str = None) -> Dict[str, list]:
        """Pull per-interval quality arrays for one layer.

        Canonical quality dims by layer:
            nuc:  ``nq`` (call), ``lq`` / ``rq`` (left/right edge confidence)
            tf:   ``tq`` (significance), ``el`` / ``er`` (left/right edge)
            fire: ``aq`` (FIRE precision; aliases legacy internal MSP layers)
            m6a / m5c: per-base ``ml`` (if the BigBed carries blockMl)

        Args:
            layer: Layer name (``'nuc'``, ``'tf'``, ``'fire'``, ...).
                ``'fire'`` aliases older internal ``'msp'`` layers.
            quality_name: Which quality dim to return. Omit to get the full
                dict ``{quality_name: [values_for_interval_0, ...], ...}``.
            sample_seed: Optional seed for reproducible display sampling.

        Returns:
            When ``quality_name`` is set, ``{read_id: [v0, v1, ...]}`` —
            one value per interval in ``read.layers[layer].intervals``.
            When omitted, ``{read_id: {quality_name: [vals], ...}}``.
            Reads with no data for that layer are omitted.
        """
        reads = self.get_compact_reads(chrom=chrom, start=start, end=end,
                                       dataset_id=dataset_id, spanning=spanning,
                                       max_reads=max_reads,
                                       layer_names=[layer],
                                       sample_seed=sample_seed)
        # An explicit empty selection (read_ids=[]) matches no reads.
        allowed = set(read_ids) if read_ids is not None else None
        out: Dict[str, Any] = {}
        for r in reads:
            rid = r.get('id')
            if allowed is not None and rid not in allowed:
                continue
            layers = r.get('layers') or {}
            layer_data = layers.get(layer)
            if not layer_data and layer == 'fire':
                layer_data = layers.get('msp')
            elif not layer_data and layer == 'msp':
                layer_data = layers.get('fire')
            if not layer_data:
                continue
            qnames = layer_data.get('quality_names') or []
            quals = layer_data.get('qualities') or []
            if not qnames or not quals:
                continue
            if quality_name is None:
                out[rid] = {qn: list(quals[i]) for i, qn in enumerate(qnames)
                            if i < len(quals)}
            else:
                if quality_name not in qnames:
                    continue
                idx = qnames.index(quality_name)
                if idx >= len(quals):
                    continue
                out[rid] = list(quals[idx])
        return out

    def filter_reads_by_quality(self, layer: str, quality_name: str,
                                min: Optional[int] = None,
                                max: Optional[int] = None,
                                mode: str = 'any',
                                chrom: str = None, start: int = None, end: int = None,
                                dataset_id: str = None, spanning: bool = True,
                                max_reads: int = 500,
                                sample_seed: str = None) -> List[str]:
        """Return read IDs whose layer intervals pass a quality gate.

        Args:
            layer: ``'nuc'``, ``'tf'``, ``'fire'``, or a custom layer name.
                ``'fire'`` aliases older internal ``'msp'`` layers.
            quality_name: Which quality dim to test (see get_interval_qualities
                for the canonical set).
            min, max: Byte-scale bounds (0-255). Both inclusive. At least
                one must be supplied.
            mode: ``'any'`` — read passes if ANY interval clears the gate.
                ``'all'`` — read passes only if EVERY interval does. Use
                ``'all'`` for conservative read-level filters like "this
                TF footprint set is uniformly high-confidence".

        Returns:
            List of read_ids that pass. Empty when the layer / quality dim
            isn't present.

        Example::

            # FIRE reads where every call clears 0.9 precision
            fire_reads = b.filter_reads_by_quality('fire', 'aq', min=230, mode='all')

            # Any TF footprint on this read has high edge confidence
            clean_tf = b.filter_reads_by_quality('tf', 'el', min=200, mode='any')
        """
        if min is None and max is None:
            raise ValueError("Supply at least one of min, max")
        if mode not in ('any', 'all'):
            raise ValueError(f"mode must be 'any' or 'all' (got {mode!r})")
        per_read = self.get_interval_qualities(
            layer=layer, quality_name=quality_name,
            chrom=chrom, start=start, end=end,
            dataset_id=dataset_id, spanning=spanning, max_reads=max_reads,
            sample_seed=sample_seed,
        )
        passing: List[str] = []
        for rid, vals in per_read.items():
            if not vals:
                continue
            def _ok(v: int) -> bool:
                if min is not None and v < min:
                    return False
                if max is not None and v > max:
                    return False
                return True
            if mode == 'any':
                if any(_ok(v) for v in vals):
                    passing.append(rid)
            else:  # 'all'
                if all(_ok(v) for v in vals):
                    passing.append(rid)
        return passing

    @classmethod
    def _quality_filter_payload(cls, filters: Sequence[dict]) -> List[dict]:
        """Normalize UI/Python quality filter dictionaries for the backend."""
        payload = []
        for filt in filters or []:
            if not filt:
                continue
            layer = filt.get("layer", "*")
            quality_name = filt.get("quality_name", filt.get("qualityName", "nq"))
            min_value = filt.get("min_value", filt.get("minValue", 0))
            enabled = filt.get("enabled", True)
            if not enabled:
                continue
            normalized_layer = (
                "*" if str(layer or "*").strip() == "*"
                else cls._normalize_annotation_layer(layer)
            )
            payload.append({
                "layer": str(normalized_layer or "*"),
                "quality_name": str(quality_name or "nq"),
                "min_value": int(min_value or 0),
            })
        return payload

    def get_quality_filters(self) -> List[dict]:
        """Return active backend interval-quality filters."""
        return self._get("/api/quality_filters").get("filters", [])

    def set_quality_filters(self, filters: Sequence[dict]) -> dict:
        """
        Set backend quality filters used by working sets and analyses.

        Filters accept either API-style keys (``quality_name``, ``min_value``)
        or UI-style keys (``qualityName``, ``minValue``). Disabled filters are
        dropped. Use ``clear_quality_filters()`` to disable all filters.
        """
        return self._post("/api/quality_filters", {
            "filters": self._quality_filter_payload(filters),
        })

    def add_quality_filter(self, layer: str, quality_name: str,
                           min_value: int, replace: bool = False) -> dict:
        """Append one backend quality filter, optionally replacing all existing filters."""
        filters = [] if replace else self.get_quality_filters()
        filters.append({
            "layer": layer,
            "quality_name": quality_name,
            "min_value": int(min_value),
        })
        return self.set_quality_filters(filters)

    def clear_quality_filters(self) -> dict:
        """Disable all backend interval-quality filters."""
        return self.set_quality_filters([])

    def get_quality_impact(self, chrom: str = None, start: int = None, end: int = None,
                           filters: Sequence[dict] = None,
                           dataset_ids: Sequence[str] = None) -> dict:
        """What each quality filter keeps in a region, and which scores the data carries.

        Returns ``{"filters": [{layer, quality_name, min_value, total, kept, layers}],
        "available": {layer: [quality names]}}``. ``filters`` defaults to the
        active ones; the region defaults to the browser's view. Skipped (empty)
        beyond 2 Mb.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region["chrom"], region["start"], region["end"]
        active = self.get_quality_filters() if filters is None else self._quality_filter_payload(filters)
        return self._post("/api/quality/impact", {
            "chrom": chrom, "start": int(start), "end": int(end),
            "filters": active,
            **({"dataset_ids": list(dataset_ids)} if dataset_ids else {}),
        })

    def set_class_support(self, min_value: Optional[int], layers: Sequence[str] = None,
                          chrom: str = None, start: int = None, end: int = None) -> dict:
        """Filter footprint-class calls by class support (q0, 0-255); ``None`` turns it off.

        The same setting as Class support in the toolbar's Quality group.
        ``layers`` defaults to every layer that carries q0 in the region
        (plus any already filtered); other quality filters are kept.
        """
        current = [f for f in self.get_quality_filters() if f.get("quality_name") != "q0"]
        if min_value is None or int(min_value) <= 0:
            return self.set_quality_filters(current)
        if layers is None:
            impact = self.get_quality_impact(chrom, start, end, filters=[])
            layers = sorted({layer for layer, names in impact.get("available", {}).items() if "q0" in names}
                            | {f["layer"] for f in self.get_quality_filters() if f.get("quality_name") == "q0"})
        if not layers:
            raise ValueError("No layer in this region carries class support (q0); pass layers= explicitly")
        return self.set_quality_filters(current + [
            {"layer": layer, "quality_name": "q0", "min_value": int(min_value)} for layer in layers
        ])

    def get_coverage(self, chrom: str = None, start: int = None,
                     end: int = None, dataset_id: str = None,
                     bins: int = 500) -> list:
        """Get per-bin read coverage for a region.

        Returns list of coverage values.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'bins': bins}
        if dataset_id:
            params['dataset_id'] = dataset_id
        resp = self._get('/api/coverage', params=params)
        return resp.get('coverage', [])

    # =========================================================================
    # Co-Accessibility (extended)
    # =========================================================================

    def get_coacc_image(self, chrom: str = None, start: int = None,
                        end: int = None, normalization: str = 'oe',
                        scaling: str = 'linear', colormap: str = 'fall',
                        bin_size: int = 0, min_coverage: int = 20,
                        signal_type: str = 'accessibility',
                        dataset_id: str = None,
                        dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                        layer: str = None,
                        read_ids: List[str] = None,
                        read_ids_by_dataset: Dict[str, List[str]] = None,
                        sample_seed: str = None) -> 'PILImage.Image':
        """Get co-accessibility matrix as a PIL Image (heatmap).

        Returns:
            PIL Image of the co-accessibility heatmap
        """
        from PIL import Image as PILImageMod
        import io as _io

        content = self.get_coacc_matrix_png(
            chrom=chrom,
            start=start,
            end=end,
            normalization=normalization,
            scaling=scaling,
            colormap=colormap,
            bin_size=bin_size,
            min_coverage=min_coverage,
            signal_type=signal_type,
            dataset_id=dataset_id,
            dataset_ids=dataset_ids,
            layer=layer,
            read_ids=read_ids,
            read_ids_by_dataset=read_ids_by_dataset,
            sample_seed=sample_seed,
        )
        return PILImageMod.open(_io.BytesIO(content))

    # =========================================================================
    # Annotation Management
    # =========================================================================

    def list_annotations(self) -> list:
        """List loaded annotation files."""
        resp = self._get('/api/annotations/files')
        return resp.get('files', [])

    def get_annotation_files(self) -> list:
        """Alias matching the frontend API name for loaded annotation files."""
        return self.list_annotations()

    def add_annotation(self, path: str, label: str = None,
                       dataset_ids: List[str] = None) -> dict:
        """Add an annotation file (BED, BigBed, etc.)."""
        body = {'path': path}
        if label:
            body['label'] = label
        if dataset_ids:
            body['dataset_ids'] = dataset_ids
        return self._post('/api/annotations/add', body)

    def add_annotation_file(self, path: str, label: str = None,
                            dataset_ids: List[str] = None) -> dict:
        """Alias matching the frontend API name for adding annotation files."""
        return self.add_annotation(path, label, dataset_ids)

    def activate_annotation(self, file_id: str) -> dict:
        """Activate an annotation file for display."""
        return self._post('/api/annotations/activate', {'file_id': file_id})

    def activate_annotation_file(self, file_id: str) -> dict:
        """Alias matching the frontend API name for activating annotations."""
        return self.activate_annotation(file_id)

    def get_annotation_profile(self, chrom: str = None, start: int = None,
                               end: int = None, file_id: str = None,
                               dataset_id: str = None,
                               annotation_types: Optional[Union[str, Sequence[str]]] = None,
                               bins: int = 500) -> dict:
        """Get annotation density profile for a region.

        ``file_id`` is retained for backward compatibility but the current API
        profiles all active annotation files and filters by annotation_types.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'bins': int(bins),
        }
        if dataset_id:
            params['dataset_id'] = dataset_id
        type_names = self._comma_param(annotation_types)
        if type_names:
            params['annotation_types'] = type_names
        return self._get('/api/annotations/profile', params=params)

    # =========================================================================
    # Multi-Region Compilation
    # =========================================================================

    def compile_regions(self, regions: list, dataset_id: str = None,
                        spanning: bool = True, max_reads_per_region: int = 200,
                        anchor: str = 'center', target_width: int = None,
                        sample_seed: str = None,
                        include_deam_opportunities: bool = False) -> dict:
        """Compile reads from multiple genomic regions into a single normalized view.

        Fetches reads from each region, re-centers them to a common coordinate
        system, and returns combined compact reads suitable for clustering,
        analysis, or rendering.

        Args:
            regions: List of region dicts or tuples. Accepted formats:
                - ``[{'chrom': 'chr1', 'start': 1000, 'end': 2000, 'label': 'Gene X'}, ...]``
                - ``[('chr1', 1000, 2000), ...]``
                - ``[('chr1', 1000, 2000, 'Gene X'), ...]``
            dataset_id: Specific dataset (default: all datasets)
            spanning: Only include spanning reads
            max_reads_per_region: Max reads per region (downsampled)
            anchor: Alignment mode: 'center' (default), 'start', or 'end'
            target_width: Normalize all regions to this bp width (default: max region width)
            sample_seed: Optional seed for reproducible per-region sampling
            include_deam_opportunities: Include aligned possible C/G sites and
                explicit DAF events for strand-consensus review

        Returns:
            dict with 'reads' (compiled compact reads), 'regions' (metadata),
            'n_reads', 'n_regions', 'target_width'

        Example::

            # Compile reads from 3 promoters
            regions = [
                {'chrom': 'chr1', 'start': 1000, 'end': 5000, 'label': 'GeneA'},
                {'chrom': 'chr2', 'start': 50000, 'end': 54000, 'label': 'GeneB'},
                {'chrom': 'chr5', 'start': 80000, 'end': 84000, 'label': 'GeneC'},
            ]
            result = b.compile_regions(regions)

            # Render the compiled view
            b.render_compiled(regions, show_mods=True, sort_by='kmeans')
        """
        # Normalize region format
        normalized = []
        for r in regions:
            if isinstance(r, (list, tuple)):
                d = {'chrom': r[0], 'start': int(r[1]), 'end': int(r[2])}
                if len(r) > 3:
                    d['label'] = r[3]
                normalized.append(d)
            else:
                normalized.append(r)

        body = {
            'regions': normalized,
            'spanning': spanning,
            'max_reads_per_region': max_reads_per_region,
            'anchor': anchor,
        }
        if dataset_id:
            body['dataset_ids'] = [dataset_id]
        if target_width:
            body['target_width'] = target_width
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        if include_deam_opportunities:
            body['include_deam_opportunities'] = True
        return self._post('/api/reads/compile', body)

    def render_compiled(self, regions: list, width: int = 2000,
                        row_height: int = 3, max_reads: int = 500,
                        show_mods: bool = False, show_fire: bool = False,
                        sort_by: str = None, title: str = None,
                        dataset_id: str = None, spanning: bool = True,
                        anchor: str = 'center', target_width: int = None,
                        max_reads_per_region: int = 200,
                        sample_seed: str = None,
                        include_deam_opportunities: bool = False) -> 'PILImage.Image':
        """Compile reads from multiple regions and render as a single PIL Image.

        Args:
            regions: List of region dicts/tuples (same format as compile_regions)
            sort_by: 'accessibility', 'kmeans', 'region', or None
            show_mods: Show methylation marks
            show_fire: Show FIRE overlay
            include_deam_opportunities: Show possible C/G edge rugs and use
                explicit DAF events for black observed marks
            title: Title text
            sample_seed: Optional seed for reproducible per-region sampling
            Other args: forwarded to compile endpoint

        Returns:
            PIL Image

        Example::

            img = b.render_compiled(
                [('chr1', 1000, 5000, 'TSS1'), ('chr2', 50000, 54000, 'TSS2')],
                show_mods=True, sort_by='kmeans', row_height=4,
            )
            img.save('compiled.png')
        """
        from PIL import Image as PILImageMod
        import io as _io

        normalized = []
        for r in regions:
            if isinstance(r, (list, tuple)):
                d = {'chrom': r[0], 'start': int(r[1]), 'end': int(r[2])}
                if len(r) > 3:
                    d['label'] = r[3]
                normalized.append(d)
            else:
                normalized.append(r)

        body = {
            'regions': normalized,
            'spanning': spanning,
            'max_reads_per_region': max_reads_per_region,
            'anchor': anchor,
        }
        if dataset_id:
            body['dataset_ids'] = [dataset_id]
        if target_width:
            body['target_width'] = target_width
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        if include_deam_opportunities:
            body['include_deam_opportunities'] = True

        params = {
            'width': width, 'row_height': row_height, 'max_reads': max_reads,
            'show_mods': str(show_mods).lower(), 'show_fire': str(show_fire).lower(),
        }
        if sort_by:
            params['sort_by'] = sort_by
        if title:
            params['title'] = title

        r = self._post_response("/api/render/compile", data=body, params=params, timeout=120)

        if r.headers.get('content-type', '').startswith('application/json'):
            data = r.json()
            raise RuntimeError(data.get('error', 'Render failed'))

        return PILImageMod.open(_io.BytesIO(r.content))

    # =========================================================================
    # Micro-C / DAF-C
    # =========================================================================

    def get_microc_matrix(self, chrom: str = None, start: int = None,
                          end: int = None, normalization: str = 'none',
                          resolution: int = None) -> dict:
        """Get Micro-C contact matrix data.

        Returns dict with 'matrix', 'resolution', and region metadata.
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'normalization': normalization}
        if resolution is not None:
            params['resolution'] = resolution
        return self._get('/api/microc/matrix/data', params=params)

    def get_microc_arcs(self, chrom: str = None, start: int = None,
                        end: int = None, threshold: float = 0.1,
                        max_arcs: int = 100, min_distance: int = 5000,
                        max_distance: int = 500000, resolution: int = None,
                        normalization: str = 'none', min_count: int = 0,
                        merge_bin: int = 0, stable_strength: bool = False,
                        oe_floor: float = 0, acc_correct: bool = False,
                        acc_log: bool = False) -> list:
        """Get top Micro-C contact pairs as arcs."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'threshold': threshold, 'max_arcs': max_arcs,
                  'min_distance': min_distance, 'max_distance': max_distance,
                  'normalization': normalization, 'min_count': min_count,
                  'merge_bin': merge_bin,
                  'stable_strength': str(stable_strength).lower(),
                  'oe_floor': oe_floor,
                  'acc_correct': str(acc_correct).lower(),
                  'acc_log': str(acc_log).lower()}
        if resolution is not None:
            params['resolution'] = resolution
        resp = self._get('/api/microc/arcs', params=params)
        return resp.get('arcs', [])

    def get_microc_virtual4c(self, viewpoint_start: int = None,
                             viewpoint_end: int = None,
                             profile_start: int = None,
                             profile_end: int = None,
                             chrom: str = None, start: int = None,
                             end: int = None, position: int = None,
                             resolution: int = None,
                             normalization: str = 'none') -> dict:
        """Get Micro-C virtual 4C profile from a viewpoint position."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        if position is not None and viewpoint_start is None:
            viewpoint_start = int(position)
            viewpoint_end = int(position) + 1
        if viewpoint_start is None:
            midpoint = (int(start) + int(end)) // 2
            viewpoint_start = midpoint
            viewpoint_end = midpoint + 1
        if viewpoint_end is None:
            viewpoint_end = int(viewpoint_start) + 1
        profile_start = int(start) if profile_start is None else int(profile_start)
        profile_end = int(end) if profile_end is None else int(profile_end)
        params = {
            'chrom': chrom,
            'viewpoint_start': int(viewpoint_start),
            'viewpoint_end': int(viewpoint_end),
            'profile_start': profile_start,
            'profile_end': profile_end,
            'normalization': normalization,
        }
        if resolution is not None:
            params['resolution'] = resolution
        return self._get('/api/microc/virtual4c', params=params)

    # =========================================================================
    # Data Retrieval (extended)
    # =========================================================================

    def get_chroms(self) -> list:
        """Get list of chromosomes with sizes."""
        return self._get('/api/chroms').get('chroms', [])

    def get_chromosomes(self) -> dict:
        """Frontend-name wrapper returning the full `/api/chroms` response."""
        return self._get('/api/chroms')

    def get_genes(self, chrom: str = None, start: int = None,
                  end: int = None) -> list:
        """Get gene annotations in a region."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        return self._get('/api/genes', params={
            'chrom': chrom, 'start': int(start), 'end': int(end)
        }).get('genes', [])

    def _compact_all_params(self, chrom: str = None, start: int = None,
                            end: int = None, dataset_id: str = None,
                            spanning: bool = True,
                            include_methylation: bool = False,
                            include_layers: bool = False,
                            layer_names: Optional[Union[str, Sequence[str]]] = None,
                            min_fp_quality: int = 0,
                            min_footprints: int = 0,
                            fill_gap_size: int = None,
                            max_reads: Optional[int] = None,
                            profile_max_reads: Optional[int] = None,
                            infer_legacy_layers: Optional[bool] = None,
                            legacy_nuc_min_size: Optional[int] = None,
                            sample_seed: str = None) -> Tuple[dict, Optional[str]]:
        """Build `/api/reads/compact_all` params plus the resolved dataset ID."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        target_id = self.resolve_dataset_id(dataset_id)
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower(),
                  'include_methylation': str(include_methylation).lower(),
                  'max_reads': 0 if max_reads is None else int(max_reads)}
        if target_id:
            params['dataset_id'] = target_id
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        layer_names_param = self._layer_names_param(layer_names)
        if layer_names_param:
            params['include_layers'] = 'true'
            params['layer_names'] = layer_names_param
        elif include_layers:
            params['include_layers'] = 'true'
        if min_fp_quality > 0:
            params['min_fp_quality'] = min_fp_quality
        if min_footprints > 0:
            params['min_footprints'] = min_footprints
        if fill_gap_size is not None:
            params['fill_gap_size'] = fill_gap_size
        if profile_max_reads is not None:
            params['profile_max_reads'] = int(profile_max_reads)
        if infer_legacy_layers is not None:
            params['infer_legacy_layers'] = str(bool(infer_legacy_layers)).lower()
        if legacy_nuc_min_size is not None:
            params['legacy_nuc_min_size'] = int(legacy_nuc_min_size)
        return params, target_id

    def get_all_reads_response(self, chrom: str = None, start: int = None,
                               end: int = None, dataset_id: str = None,
                               spanning: bool = True,
                               include_methylation: bool = False,
                               include_layers: bool = False,
                               layer_names: Optional[Union[str, Sequence[str]]] = None,
                               min_fp_quality: int = 0,
                               min_footprints: int = 0,
                               fill_gap_size: int = None,
                               max_reads: Optional[int] = None,
                               profile_max_reads: Optional[int] = None,
                               infer_legacy_layers: Optional[bool] = None,
                               legacy_nuc_min_size: Optional[int] = None,
                               sample_seed: str = None) -> dict:
        """Get the raw compact-all response, including per-dataset count metadata.

        The response shape mirrors the browser API:
        ``{"datasets": {dataset_id: {"reads": [...], "display_count": ...}}}``.
        Count fields include ``display_count``, ``working_count``,
        ``total_in_scope``, ``total_spanning``, and metaprofile pool metadata
        when served by a current backend.
        """
        params, _target_id = self._compact_all_params(
            chrom=chrom,
            start=start,
            end=end,
            dataset_id=dataset_id,
            spanning=spanning,
            include_methylation=include_methylation,
            include_layers=include_layers,
            layer_names=layer_names,
            min_fp_quality=min_fp_quality,
            min_footprints=min_footprints,
            fill_gap_size=fill_gap_size,
            max_reads=max_reads,
            profile_max_reads=profile_max_reads,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            sample_seed=sample_seed,
        )
        return self._get('/api/reads/compact_all', params=params)

    def get_all_reads(self, chrom: str = None, start: int = None,
                      end: int = None, dataset_id: str = None,
                      spanning: bool = True,
                      include_methylation: bool = False,
                      include_layers: bool = False,
                      layer_names: Optional[Union[str, Sequence[str]]] = None,
                      min_fp_quality: int = 0,
                      min_footprints: int = 0,
                      fill_gap_size: int = None,
                      max_reads: Optional[int] = None,
                      profile_max_reads: Optional[int] = None,
                      infer_legacy_layers: Optional[bool] = None,
                      legacy_nuc_min_size: Optional[int] = None,
                      sample_seed: str = None) -> list:
        """Get all compact reads for one dataset.

        By default this disables the `/api/reads/compact_all` display cap
        (`max_reads=0`). Pass a positive max_reads to request a capped response.
        ``profile_max_reads`` controls only endpoint-computed metaprofiles.
        Use :meth:`get_all_reads_response` when you also need display/working/
        in-scope count metadata. Use with caution on large regions.
        """
        params, target_id = self._compact_all_params(
            chrom=chrom,
            start=start,
            end=end,
            dataset_id=dataset_id,
            spanning=spanning,
            include_methylation=include_methylation,
            include_layers=include_layers,
            layer_names=layer_names,
            min_fp_quality=min_fp_quality,
            min_footprints=min_footprints,
            fill_gap_size=fill_gap_size,
            max_reads=max_reads,
            profile_max_reads=profile_max_reads,
            infer_legacy_layers=infer_legacy_layers,
            legacy_nuc_min_size=legacy_nuc_min_size,
            sample_seed=sample_seed,
        )
        response = self._get('/api/reads/compact_all', params=params)
        datasets = response.get('datasets', {})
        if target_id in datasets:
            return datasets[target_id].get('reads', [])
        if (not dataset_id or str(dataset_id).strip() == LEGACY_PRIMARY_DATASET_ID) and datasets:
            first_dataset = next(iter(datasets.values()))
            return first_dataset.get('reads', [])
        return []

    def get_reads_image(self, chrom: str = None, start: int = None,
                        end: int = None, dataset_id: str = None,
                        width: int = 2000, height: int = None,
                        spanning: bool = True) -> 'PILImage.Image':
        """Get reads rendered as a PNG image (server-side)."""
        from PIL import Image as PILImageMod
        import io as _io
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'width': width, 'spanning': str(spanning).lower()}
        if dataset_id:
            params['dataset_id'] = dataset_id
        if height:
            params['height'] = height
        r = self._get_response("/api/reads/image", params=params, timeout=60)
        return PILImageMod.open(_io.BytesIO(r.content))

    def get_meta_all(self, chrom: str = None, start: int = None,
                     end: int = None, dataset_ids: List[str] = None,
                     spanning: bool = False) -> dict:
        """Get metaprofiles for all datasets at once."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'spanning': str(spanning).lower()}
        if dataset_ids:
            params['dataset_ids'] = ','.join(dataset_ids)
        return self._get('/api/meta_all', params=params)

    # =========================================================================
    # Tracks (extended)
    # =========================================================================

    def get_track_signal(self, track_idx: int, chrom: str = None,
                         start: int = None, end: int = None,
                         bins: int = 500) -> list:
        """Get signal values from an orthogonal track (BigWig, BED, etc.)."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'bins': bins}
        resp = self._get(f'/api/tracks/{track_idx}', params=params)
        return resp.get('values', [])

    def get_track_data(self, track_idx: int, chrom: str = None,
                       start: int = None, end: int = None,
                       bins: int = None) -> dict:
        """Frontend-name wrapper returning the full track data response."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        if bins is not None:
            params['bins'] = int(bins)
        return self._get(f'/api/tracks/{track_idx}', params=params)

    def get_track_annotations(self, track_idx: int, chrom: str = None,
                              start: int = None, end: int = None,
                              filter_names: Optional[Union[str, Sequence[str]]] = None) -> list:
        """Get annotation intervals from a track (BigBed, BED, motif)."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        names = self._comma_param(filter_names)
        if names:
            params['filter_names'] = names
        resp = self._get(f'/api/tracks/{track_idx}/annotations', params=params)
        return resp.get('intervals', resp.get('annotations', []))

    def get_bigbed_names(self, url: str, genome: str = None,
                         sample_size: int = None) -> dict:
        """Get unique names from a BigBed-backed motif/annotation source."""
        params = {'url': url}
        if genome:
            params['genome'] = genome
        if sample_size is not None:
            params['sample_size'] = int(sample_size)
        return self._get('/api/bigbed/names', params=params)

    def get_big_bed_names(self, url: str, genome: str = None,
                          sample_size: int = None) -> dict:
        """Acronym-preserving alias for `get_bigbed_names`."""
        return self.get_bigbed_names(url=url, genome=genome, sample_size=sample_size)

    def add_motif_track(self, name: str, sequence: str, threshold: float = 0.8,
                        render_mode: str = None) -> dict:
        """Add a motif track by DNA sequence (scans reference for matches)."""
        body = {'label': name, 'sequence': sequence, 'threshold': threshold}
        if render_mode:
            body['render_mode'] = render_mode
        return self._post('/api/tracks/add_motif_sequence', body)

    def add_motif_sequence_track(self, sequence: str, label: str = None,
                                 threshold: float = 0.85) -> dict:
        """Alias matching the frontend `addMotifSequenceTrack` helper."""
        body = {'sequence': sequence, 'label': label, 'threshold': threshold}
        return self._post('/api/tracks/add_motif_sequence', body)

    def add_motif_pwm_track(self, name: str, counts: dict, label: str = None,
                            threshold: float = 0.85) -> dict:
        """Add a motif track from a raw A/C/G/T PWM or count dictionary."""
        body = {'name': name, 'counts': counts, 'label': label, 'threshold': threshold}
        return self._post('/api/tracks/add_motif_pwm', body)

    def add_motif_track_file(self, file_path: str, format: str = None,
                             threshold: float = 0.8) -> dict:
        """Add motif tracks from a file (JASPAR, MEME, PFM, HOMER)."""
        body = {'file_path': file_path, 'threshold': threshold}
        if format:
            body['format'] = format
        return self._post('/api/tracks/add_motif_file', body)

    def search_jaspar(self, query: str, limit: int = 20, genome: str = None) -> List[dict]:
        """Search JASPAR CORE by TF name or matrix ID (e.g. ``"CTCF"``, ``"MA0139"``)."""
        params = {'q': query, 'limit': int(limit)}
        if genome:
            params['genome'] = genome
        result = self._get('/api/motifs/jaspar/search', params)
        if not result.get('available', True):
            raise RuntimeError(result.get('message') or 'JASPAR search unavailable (pip install pyjaspar)')
        return result.get('results', [])

    def add_jaspar_motifs(self, names_or_ids: Union[str, Sequence[str]],
                          threshold: float = 0.85) -> dict:
        """Add JASPAR motifs as scanned tracks, by matrix ID or TF name.

        Names resolve to the best exact match for the loaded genome, the same
        way the browser's motif box does.
        """
        wanted = [names_or_ids] if isinstance(names_or_ids, str) else list(names_or_ids)
        ids, unknown = [], []
        for item in wanted:
            item_upper = str(item).strip().upper()
            hits = self.search_jaspar(item)
            match = next((h for h in hits if h['matrix_id'].upper() == item_upper
                          or h['matrix_id'].split('.')[0].upper() == item_upper
                          or h['name'].upper() == item_upper), None)
            if match:
                ids.append(match['matrix_id'])
            else:
                unknown.append(item)
        if not ids:
            raise ValueError(f"No JASPAR motif named {', '.join(map(str, unknown))}")
        result = self._post('/api/tracks/add_motif_jaspar', {'matrix_ids': ids, 'threshold': threshold})
        if unknown:
            result['not_found'] = unknown
        return result

    def add_motif_file_tracks(self, file_path: str, format: str = None,
                              threshold: float = 0.8) -> dict:
        """Alias matching the frontend `addMotifFileTracks` helper."""
        return self.add_motif_track_file(file_path=file_path, format=format, threshold=threshold)

    def filter_track(self, track_idx: int,
                     filter_names: Optional[Union[str, Sequence[str]]] = None) -> dict:
        """Filter track annotations by one or more names; pass None/empty to clear."""
        names = self._comma_param(filter_names)
        body = {'filter_names': names.split(',') if names else None}
        return self._post(f'/api/tracks/{track_idx}/filter', body)

    def update_track_filter(self, track_idx: int,
                            filter_names: Optional[Union[str, Sequence[str]]] = None) -> dict:
        """Alias matching the frontend `updateTrackFilter` helper."""
        return self.filter_track(track_idx, filter_names=filter_names)

    def reorder_tracks(self, from_index: int, to_index: int) -> dict:
        """Move one orthogonal track from ``from_index`` to ``to_index``."""
        return self._post('/api/tracks/reorder', {
            'from_index': int(from_index),
            'to_index': int(to_index),
        })

    # =========================================================================
    # Clustering (extended)
    # =========================================================================

    def assign_to_clusters(self, cluster_patterns: dict, peak_regions: list,
                           dataset_ids: List[str] = None,
                           chrom: str = None, start: int = None, end: int = None,
                           spanning: bool = False, sample_seed: str = None,
                           cluster_feature_rules: Sequence[dict] = None,
                           **kwargs) -> dict:
        """Assign reads to existing cluster patterns (for dynamic clustering).

        Args:
            cluster_patterns: {cluster_id: [binary_pattern]} from previous clustering
            peak_regions: Peak region dicts with 'start', 'end', 'mode'
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = f"chrom={chrom}&start={int(start)}&end={int(end)}&spanning={str(spanning).lower()}"
        body = {'cluster_patterns': cluster_patterns, 'peak_regions': peak_regions}
        if dataset_ids:
            body['dataset_ids'] = dataset_ids
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        rules = self._cluster_feature_rules_for_regions(peak_regions, cluster_feature_rules)
        if rules:
            body['cluster_feature_rules'] = rules
        body.update(kwargs)
        return self._post(f"/api/assign_to_clusters?{params}", body)

    def expand_cluster(self, cluster_ids: List[int], chrom: str = None,
                       start: int = None, end: int = None,
                       spanning: bool = False, max_reads: int = 500,
                       dataset_id: str = None,
                       sample_seed: str = None) -> dict:
        """Expand clusters to get reads from all datasets matching the pattern."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = f"chrom={chrom}&start={int(start)}&end={int(end)}&spanning={str(spanning).lower()}"
        body = {'cluster_ids': cluster_ids, 'max_reads': max_reads}
        if dataset_id:
            body['dataset_id'] = dataset_id
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        return self._post(f"/api/cluster_expand?{params}", body)

    def cluster_expand(self, chrom: str, start: int, end: int,
                       cluster_ids: List[int], dataset_id: str,
                       max_reads: int = 500,
                       sample_seed: str = None) -> dict:
        """Alias matching the frontend `clusterExpand` helper."""
        return self.expand_cluster(
            cluster_ids=cluster_ids,
            chrom=chrom,
            start=start,
            end=end,
            dataset_id=dataset_id,
            max_reads=max_reads,
            sample_seed=sample_seed,
        )

    # =========================================================================
    # Filtering (extended)
    # =========================================================================

    def filter_by_peaks(self, peak_regions: list = None, peak_indices: list = None,
                        filter_mode: str = 'either', dataset_id: str = None,
                        chrom: str = None, start: int = None, end: int = None,
                        spanning: bool = False, layer: str = None,
                        sample_seed: str = None) -> dict:
        """Filter reads by peak region overlap.

        Args:
            peak_regions: List of peak dicts with 'start', 'end'
            peak_indices: List of peak indices (alternative to peak_regions)
            filter_mode: 'either' (any peak) or 'all' (all peaks)
            layer: Optional annotation layer used for overlap scoring
            sample_seed: Optional seed for reproducible backend working-set caps
        """
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = f"chrom={chrom}&start={int(start)}&end={int(end)}&spanning={str(spanning).lower()}"
        if dataset_id:
            params += f"&dataset_id={dataset_id}"
        body = {'filter_mode': filter_mode}
        if peak_regions:
            body['peak_regions'] = peak_regions
        if peak_indices:
            body['peak_indices'] = peak_indices
        self._add_layer_param(body, layer)
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        return self._post(f"/api/filter?{params}", body)

    def filter_by_annotations(self, annotation_types: List[str],
                              filter_mode: str = 'has_any',
                              chrom: str = None, start: int = None, end: int = None,
                              dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                              sample_seed: str = None) -> dict:
        """Filter reads by annotation overlap."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        body = {'annotation_types': annotation_types, 'filter_mode': filter_mode,
                'chrom': chrom, 'start': int(start), 'end': int(end)}
        dataset_ids_list = self._list_param(dataset_ids)
        if dataset_ids_list:
            body['dataset_ids'] = dataset_ids_list
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        return self._post('/api/annotations/filter', body)

    # =========================================================================
    # Annotations (extended)
    # =========================================================================

    def deactivate_annotation(self, file_id: str) -> dict:
        """Deactivate an annotation file from display."""
        return self._post('/api/annotations/deactivate', {'file_id': file_id})

    def deactivate_annotation_file(self, file_id: str) -> dict:
        """Alias matching the frontend API name for deactivating annotations."""
        return self.deactivate_annotation(file_id)

    def delete_annotation(self, file_id: str) -> dict:
        """Remove an annotation file."""
        return self._delete(f'/api/annotations/{file_id}')

    def remove_annotation_file(self, file_id: str) -> dict:
        """Alias matching the frontend API name for removing annotations."""
        return self.delete_annotation(file_id)

    def browse_annotations(self, directory: str) -> list:
        """Browse annotation BigBed files in a local directory."""
        return self._get('/api/annotations/browse', params={'dir': directory}).get('files', [])

    def browse_annotation_files(self, directory: str) -> list:
        """Alias matching the frontend API name for browsing annotation files."""
        return self.browse_annotations(directory)

    def cluster_by_annotations(self, annotation_types: List[str],
                               peak_regions: list = None,
                               method: str = 'combinatorial', k: int = 5,
                               chrom: str = None, start: int = None, end: int = None,
                               dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                               sample_seed: str = None) -> dict:
        """Cluster reads based on annotation overlap patterns."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        body = {'annotation_types': annotation_types, 'method': method, 'k': k,
                'chrom': chrom, 'start': int(start), 'end': int(end)}
        if peak_regions:
            body['peak_regions'] = peak_regions
        dataset_ids_list = self._list_param(dataset_ids)
        if dataset_ids_list:
            body['dataset_ids'] = dataset_ids_list
        if sample_seed:
            body['sample_seed'] = str(sample_seed)
        return self._post('/api/annotations/cluster', body)

    def set_annotation_threshold(self, type_name: str, threshold: float) -> dict:
        """Set display threshold for an annotation type."""
        return self._post('/api/annotations/set_threshold',
                         {'type_name': type_name, 'threshold': threshold})

    # =========================================================================
    # Co-Accessibility (metadata & strip)
    # =========================================================================

    def get_coacc_metadata(self, chrom: str = None, start: int = None,
                           end: int = None, bin_size: int = 0,
                           normalization: str = 'oe',
                           min_coverage: int = 20, signal_type: str = 'accessibility',
                           dataset_id: str = None,
                           dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                           layer: str = None,
                           read_ids: List[str] = None,
                           read_ids_by_dataset: Dict[str, List[str]] = None,
                           sample_seed: str = None) -> dict:
        """Get co-accessibility metadata (n_reads, bins, coverage stats)."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'bin_size': bin_size, 'min_coverage': min_coverage}
        if normalization:
            params['normalization'] = normalization
        if signal_type != 'accessibility':
            params['signal_type'] = signal_type
        dataset_ids_param = self._comma_param(dataset_ids) or dataset_id
        if dataset_ids_param:
            params['dataset_ids'] = dataset_ids_param
        self._add_layer_param(params, layer)
        self._add_read_scope_params(params, read_ids, read_ids_by_dataset)
        if sample_seed:
            params['sample_seed'] = str(sample_seed)
        return self._get('/api/coacc/metadata', params=params)

    def get_coacc_strip(self, chrom: str = None, start: int = None,
                        end: int = None, width: int = 800, height: int = 120,
                        normalization: str = 'oe', scaling: str = 'linear',
                        colormap: str = 'fall', signal_type: str = 'accessibility',
                        dataset_id: str = None,
                        dataset_ids: Optional[Union[str, Sequence[str]]] = None,
                        bin_size: int = 0,
                        min_coverage: int = 20,
                        layer: str = None,
                        read_ids: List[str] = None,
                        read_ids_by_dataset: Dict[str, List[str]] = None,
                        sample_seed: str = None) -> 'PILImage.Image':
        """Get co-accessibility triangular strip as PIL Image."""
        from PIL import Image as PILImageMod
        import io as _io
        content = self.get_coacc_strip_png(
            chrom=chrom,
            start=start,
            end=end,
            width=width,
            height=height,
            normalization=normalization,
            scaling=scaling,
            colormap=colormap,
            bin_size=bin_size,
            min_coverage=min_coverage,
            signal_type=signal_type,
            dataset_id=dataset_id,
            dataset_ids=dataset_ids,
            layer=layer,
            read_ids=read_ids,
            read_ids_by_dataset=read_ids_by_dataset,
            sample_seed=sample_seed,
        )
        return PILImageMod.open(_io.BytesIO(content))

    # =========================================================================
    # DAF-C / Micro-C (extended)
    # =========================================================================

    def load_dafc(self, cool_file: str = None, bigbed_file: str = None) -> dict:
        """Load a .cool/.mcool or DAF-C BigBed file for contact analysis."""
        params = {}
        if cool_file:
            params['cool_file'] = cool_file
        if bigbed_file:
            params['bigbed_file'] = bigbed_file
        return self._post('/api/dafc/load', params=params)

    def get_dafc_status(self) -> dict:
        """Get DAF-C / Micro-C loading status."""
        return self._get('/api/dafc/status')

    def select_dafc_region(self, chrom: str, x_start: int, x_end: int,
                           y_start: int, y_end: int) -> dict:
        """Query a DAF-C/Micro-C selected contact region for contacts and linked reads."""
        return self._get('/api/dafc/select', params={
            'chrom': chrom,
            'x_start': int(x_start),
            'x_end': int(x_end),
            'y_start': int(y_start),
            'y_end': int(y_end),
        })

    def get_dafc_image(self, chrom: str = None, start: int = None,
                       end: int = None, resolution: int = None,
                       normalization: str = 'none',
                       scaling: str = 'log', colormap: str = 'fall',
                       x_start: int = None, x_end: int = None,
                       y_start: int = None, y_end: int = None,
                       vmin: float = None, vmax: float = None) -> 'PILImage.Image':
        """Get DAF-C/Micro-C contact matrix as PIL Image."""
        from PIL import Image as PILImageMod
        import io as _io
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'normalization': normalization, 'scaling': scaling,
                  'colormap': colormap}
        if resolution is not None:
            params['resolution'] = resolution
        for key, value in {
            'x_start': x_start,
            'x_end': x_end,
            'y_start': y_start,
            'y_end': y_end,
            'vmin': vmin,
            'vmax': vmax,
        }.items():
            if value is not None:
                params[key] = value
        r = self._get_response("/api/dafc/matrix/image", params=params, timeout=60)
        return PILImageMod.open(_io.BytesIO(r.content))

    def get_microc_strip(self, chrom: str = None, start: int = None,
                         end: int = None, width: int = 800, height: int = 120,
                         normalization: str = 'none',
                         scaling: str = 'log', colormap: str = 'fall',
                         resolution: int = None, max_distance: int = 100000,
                         focus_start: int = None,
                         focus_end: int = None) -> 'PILImage.Image':
        """Get Micro-C triangular strip as PIL Image."""
        from PIL import Image as PILImageMod
        import io as _io
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end),
                  'width': width, 'height': height, 'normalization': normalization,
                  'scaling': scaling, 'colormap': colormap,
                  'max_distance': max_distance}
        if resolution is not None:
            params['resolution'] = resolution
        if focus_start is not None:
            params['focus_start'] = focus_start
        if focus_end is not None:
            params['focus_end'] = focus_end
        r = self._get_response("/api/microc/matrix/strip", params=params, timeout=60)
        return PILImageMod.open(_io.BytesIO(r.content))

    def get_microc_apa(self, peaks: List[dict] = None, window: int = 10000,
                       resolution: int = None, chrom: str = None,
                       normalization: str = 'oe',
                       anchors: List[int] = None) -> dict:
        """Aggregate Peak Analysis (APA) for Micro-C data.

        Args:
            peaks: List of ``{'start': int, 'end': int}`` peak regions.
            window: Window around each peak-pair intersection in bp.
            resolution: Cooler resolution/bin size. Uses current resolution if omitted.
            chrom: Chromosome (auto-detected if omitted).
            normalization: ``'oe'`` or ``'none'``.
            anchors: Backward-compatible list of point anchors; converted to
                zero-width peak regions when ``peaks`` is omitted.
        """
        if chrom is None:
            region = self.get_region()
            chrom = region['chrom']
        if peaks is None:
            peaks = [{'start': int(a), 'end': int(a)} for a in (anchors or [])]
        params = {'chrom': chrom, 'window': window, 'normalization': normalization}
        if resolution is not None:
            params['resolution'] = resolution
        return self._post('/api/microc/apa', {'peaks': peaks}, params=params)

    def precompute_microc_expected(self, chrom: str = None, resolution: int = None) -> dict:
        """Precompute a chromosome's expected contacts for global O/E.

        Args:
            chrom: Chromosome (default: the current view's).
            resolution: Bin size in bp (default: the loaded resolution).
        """
        if chrom is None:
            chrom = self.get_region()['chrom']
        params = {'chrom': chrom}
        if resolution is not None:
            params['resolution'] = int(resolution)
        return self._post('/api/microc/precompute_expected', params=params)

    def get_microc_expected_status(self) -> dict:
        """Check status of expected value computation."""
        return self._get('/api/microc/expected_status')

    def create_linked_session(self) -> dict:
        """Create a linked split-view session for DAF-C or Micro-C regions."""
        return self._post('/api/linked/session/create')

    def get_linked_sessions(self) -> List[dict]:
        """List active linked split-view sessions."""
        result = self._get('/api/linked/sessions')
        return result.get('sessions', [])

    def list_linked_sessions(self) -> List[dict]:
        """Alias for ``get_linked_sessions``."""
        return self.get_linked_sessions()

    def get_linked_session(self, session_id: str) -> dict:
        """Get linked split-view session state."""
        return self._get(f'/api/linked/session/{session_id}')

    def send_to_linked_session(self, session_id: str, regions: dict = None,
                               read_ids: Sequence[str] = None,
                               contact_mode: str = None,
                               split_view_mode: str = None,
                               chrom: str = None,
                               x_chrom: str = None,
                               y_chrom: str = None,
                               x_start: int = None, x_end: int = None,
                               y_start: int = None, y_end: int = None) -> dict:
        """
        Send a DAF-C/Micro-C region pair to a linked split-view session.

        Args:
            session_id: ID from ``create_linked_session()``
            regions: Optional dict with ``chrom``, ``x_start``, ``x_end``,
                ``y_start``, and ``y_end``
            read_ids: Optional DAF-C read IDs to retain
            contact_mode: Legacy ``'dafc'``/``'microc'`` compatibility field
            split_view_mode: Semantic mode: ``'molecule_linked'``,
                ``'region_independent'``, or ``'coordinate_synced'``
            chrom/x_chrom/y_chrom/x_start/...: Convenience fields used when
                ``regions`` is omitted. ``x_chrom``/``y_chrom`` support
                coordinate-synced or haplotype split views with different
                chromosome names.
        """
        if regions is None:
            base_chrom = chrom or x_chrom or y_chrom
            if base_chrom is None or None in (x_start, x_end, y_start, y_end):
                raise ValueError("Provide regions or chrom/x_start/x_end/y_start/y_end")
            regions = {
                'chrom': base_chrom,
                'x_start': int(x_start),
                'x_end': int(x_end),
                'y_start': int(y_start),
                'y_end': int(y_end),
            }
            if x_chrom:
                regions['x_chrom'] = x_chrom
            if y_chrom:
                regions['y_chrom'] = y_chrom
        body = {
            'regions': regions,
            'read_ids': list(read_ids or []),
        }
        if contact_mode:
            body['contact_mode'] = contact_mode
        if split_view_mode:
            body['split_view_mode'] = split_view_mode
        return self._post(f'/api/linked/session/{session_id}/send', body)

    def get_linked_reads_data(self, session_id: str) -> dict:
        """Get raw linked read data for a split-view session."""
        return self._get('/api/linked/reads/data', params={'session_id': session_id})

    def get_linked_reads_compact(self, session_id: str, region: str,
                                 max_reads: int = 500, sort_by: str = 'x',
                                 hide_terminal_gaps: bool = True,
                                 terminal_gap_threshold: int = 500,
                                 sample_seed: str = None) -> dict:
        """Get linked reads in compact ReadTrack format for region ``'x'`` or ``'y'``."""
        if region not in ('x', 'y'):
            raise ValueError("region must be 'x' or 'y'")
        params = {
            'session_id': session_id,
            'region': region,
            'max_reads': int(max_reads),
            'sort_by': sort_by,
            'hide_terminal_gaps': str(hide_terminal_gaps).lower(),
            'terminal_gap_threshold': int(terminal_gap_threshold),
        }
        if sample_seed:
            params['sample_seed'] = sample_seed
        return self._get('/api/linked/reads/compact', params=params)

    def get_linked_reads_image(self, session_id: str, region: str,
                               max_width: int = 2000,
                               row_height: int = 3) -> 'PILImage.Image':
        """Render linked reads for region ``'x'`` or ``'y'`` as a PIL image."""
        if region not in ('x', 'y'):
            raise ValueError("region must be 'x' or 'y'")
        from PIL import Image as PILImageMod
        import io as _io
        params = {
            'session_id': session_id,
            'region': region,
            'max_width': int(max_width),
            'row_height': int(row_height),
        }
        r = self._get_response('/api/linked/reads/image', params=params, timeout=60)
        return PILImageMod.open(_io.BytesIO(r.content))

    def delete_linked_session(self, session_id: str) -> dict:
        """Delete a linked split-view session."""
        return self._delete(f'/api/linked/session/{session_id}')

    # =========================================================================
    # Primers (extended)
    # =========================================================================

    def get_primer_config(self) -> dict:
        """Get current primer design configuration (FASTA, BLAST DB)."""
        return self._get('/api/primer_config')

    def set_primer_config(self, fasta_path: str = None,
                          blast_db_path: str = None) -> dict:
        """Configure primer design tool."""
        params = {}
        if fasta_path:
            params['fasta_path'] = fasta_path
        if blast_db_path:
            params['blast_db_path'] = blast_db_path
        return self._post('/api/primer_config', params=params)

    def build_primer_blast_db(self, force: bool = False, output_dir: str = None) -> dict:
        """Build/select a local primer BLAST DB from the browser's loaded FASTA."""
        params = {}
        if force:
            params['force'] = True
        if output_dir:
            params['output_dir'] = output_dir
        return self._post('/api/primer_blast_db/build', params=params)

    def get_primers(self) -> list:
        """Get currently designed primers."""
        payload = self._get('/api/primers')
        if not payload.get('success'):
            return []
        if 'pairs' in payload:
            return payload.get('pairs') or []
        if 'quads' in payload:
            return payload.get('quads') or []
        if payload.get('pair'):
            return [payload['pair']]
        return payload.get('primers', [])

    def get_primer_results(self) -> dict:
        """Get the raw latest primer-design result payload."""
        return self._get('/api/primers')

    @staticmethod
    def _primer_csv_cell(value: Any) -> str:
        text = "" if value is None else str(value)
        if text.startswith(("=", "+", "-", "@", "\t", "\r")):
            text = "'" + text
        if any(ch in text for ch in ('"', ",", "\n", "\r")):
            return '"' + text.replace('"', '""') + '"'
        return text

    @classmethod
    def _primer_csv_row(cls, values: Sequence[Any]) -> str:
        return ",".join(cls._primer_csv_cell(value) for value in values)

    @staticmethod
    def _primer_well_name(index: int) -> str:
        rows = "ABCDEFGH"
        plate_index = index % 96
        return f"{rows[plate_index // 12]}{(plate_index % 12) + 1}"

    @staticmethod
    def _primer_pair_from_order_item(item: dict) -> Tuple[str, dict]:
        if isinstance(item.get("pair"), dict):
            return str(item.get("name") or "Primer"), item["pair"]
        return str(item.get("name") or item.get("pair_name") or "Primer"), item

    @classmethod
    def _expand_primer_quads(cls, primers: Sequence[dict]) -> List[dict]:
        """DAF-C/3C quads (``x_pair``/``y_pair``) become their two pairs, named
        like the browser's + Order (``<name>_X``, ``<name>_Y``)."""
        items = []
        for index, item in enumerate(primers or [], start=1):
            if isinstance(item, dict) and (isinstance(item.get("x_pair"), dict) or isinstance(item.get("y_pair"), dict)):
                base = str(item.get("name") or f"Quad_{index}")
                for side in ("x", "y"):
                    pair = item.get(f"{side}_pair")
                    if isinstance(pair, dict):
                        items.append({"name": f"{base}_{side.upper()}", "pair": pair})
            else:
                items.append(item)
        return items

    @classmethod
    def _flatten_primer_order_rows(cls, primers: Sequence[dict]) -> List[dict]:
        rows = []
        for index, item in enumerate(cls._expand_primer_quads(primers), start=1):
            if not isinstance(item, dict):
                continue
            pair_name, pair = cls._primer_pair_from_order_item(item)
            if not isinstance(pair, dict):
                continue
            fwd_seq = pair.get("fwd_seq") or pair.get("forward_seq") or pair.get("forward")
            rev_seq = pair.get("rev_seq") or pair.get("reverse_seq") or pair.get("reverse")
            if not fwd_seq or not rev_seq:
                continue
            if pair_name == "Primer":
                pair_name = f"Primer_{index}"
            rows.extend([
                {"name": f"{pair_name}_F", "sequence": str(fwd_seq), "pair_name": pair_name, "direction": "F"},
                {"name": f"{pair_name}_R", "sequence": str(rev_seq), "pair_name": pair_name, "direction": "R"},
            ])
        return rows

    def format_primer_order(self, primers: Sequence[dict] = None,
                            format: str = "idt") -> dict:
        """Format primers for IDT, Azenta/GENEWIZ, Eurofins, Sigma, generic CSV, or FASTA."""
        if primers is None:
            cart = self.get_primer_cart()
            primers = cart.get("saved_primers") or self.get_primers()
        fmt = str(format or "idt").lower()
        definition = PRIMER_ORDER_FORMATS.get(fmt, PRIMER_ORDER_FORMATS["idt"])
        rows = self._flatten_primer_order_rows(primers)

        if fmt == "fasta":
            content = "\n".join(f">{row['name']}\n{row['sequence']}" for row in rows)
        elif fmt == "eurofins":
            content = "\n".join([
                self._primer_csv_row(["Well", "Oligo Name", "Sequence", "PlateName"]),
                *[
                    self._primer_csv_row([
                        self._primer_well_name(index),
                        row["name"],
                        row["sequence"],
                        f"FiberBrowser_{(index // 96) + 1}",
                    ])
                    for index, row in enumerate(rows)
                ],
            ])
        elif fmt == "sigma":
            content = "\n".join([
                self._primer_csv_row(["Oligo Name", "Sequence", "Scale", "Notes"]),
                *[
                    self._primer_csv_row([row["name"], row["sequence"], "0.025 umol", row["pair_name"]])
                    for row in rows
                ],
            ])
        elif fmt == "generic":
            content = "\n".join([
                self._primer_csv_row(["Name", "Sequence", "Direction"]),
                *[self._primer_csv_row([row["name"], row["sequence"], row["direction"]]) for row in rows],
            ])
        else:
            scale = "25 nmol" if fmt == "genewiz" else "25 nmole"
            purification = "Desalted" if fmt == "genewiz" else "STD"
            content = "\n".join([
                self._primer_csv_row(["Name", "Sequence", "Scale", "Purification"]),
                *[
                    self._primer_csv_row([row["name"], row["sequence"], scale, purification])
                    for row in rows
                ],
            ])

        return {
            "content": content,
            "filename": definition["filename"],
            "mime_type": definition["mime_type"],
        }

    def save_primer_order(self, filepath: str, primers: Sequence[dict] = None,
                          format: str = "idt") -> str:
        """Write a vendor primer-order file and return ``filepath``."""
        order = self.format_primer_order(primers=primers, format=format)
        with open(filepath, "w", encoding="utf-8", newline="") as handle:
            handle.write(order["content"])
            if order["content"] and not order["content"].endswith("\n"):
                handle.write("\n")
        return filepath

    save_primers_order = save_primer_order

    def clear_primers(self) -> dict:
        """Clear all designed primers."""
        return self._delete('/api/primers')

    def get_primer_progress(self) -> dict:
        """Get progress for the active primer design job."""
        return self._get('/api/primer_progress')

    def abort_primer_design(self) -> dict:
        """Abort the active primer design job."""
        return self._post('/api/primer_abort')

    def design_dafc_primers(self, chrom: str, x_start: int, x_end: int,
                            y_start: int, y_end: int, y_chrom: str = None,
                            min_product: int = 5000, max_product: int = 50000,
                            min_tm: float = 55.0, max_tm: float = 65.0,
                            max_results: int = 5,
                            tm_method: str = "primer3",
                            check_tandem_repeats: bool = True,
                            **kwargs) -> dict:
        """Design DAF-C/3C primer pairs for two loci."""
        body = {
            'chrom': chrom,
            'x_start': int(x_start),
            'x_end': int(x_end),
            'y_start': int(y_start),
            'y_end': int(y_end),
            'min_product': min_product,
            'max_product': max_product,
            'min_tm': min_tm,
            'max_tm': max_tm,
            'max_results': max_results,
            'tm_method': tm_method,
            'check_tandem_repeats': check_tandem_repeats,
        }
        if y_chrom:
            body['y_chrom'] = y_chrom
        body.update(kwargs)
        return self._post('/api/design_dafc_primers', body)

    def design_4c_primers(self, chrom: str = None, start: int = None, end: int = None,
                          min_spacing: int = 50, max_spacing: int = 500,
                          min_tm: float = 55.0, max_tm: float = 65.0,
                          max_results: int = 5,
                          tm_method: str = "primer3",
                          check_tandem_repeats: bool = True,
                          **kwargs) -> dict:
        """Design outward-facing 4C primers inside a viewpoint interval."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        body = {
            'chrom': chrom,
            'start': int(start),
            'end': int(end),
            'min_spacing': min_spacing,
            'max_spacing': max_spacing,
            'min_tm': min_tm,
            'max_tm': max_tm,
            'max_results': max_results,
            'tm_method': tm_method,
            'check_tandem_repeats': check_tandem_repeats,
        }
        body.update(kwargs)
        return self._post('/api/design_4c_primers', body)

    def design4c_primers(self, chrom: str, start: int, end: int, **kwargs) -> dict:
        """Alias matching the frontend `design4cPrimers` helper."""
        return self.design_4c_primers(chrom=chrom, start=start, end=end, **kwargs)

    # =========================================================================
    # Datasets (extended)
    # =========================================================================

    def merge_datasets(self, dataset_ids: List[str],
                       merged_label: str = None) -> dict:
        """Merge multiple datasets into one combined view."""
        body = {'dataset_ids': dataset_ids}
        if merged_label:
            body['label'] = merged_label
        return self._post('/api/datasets/merge', body)

    def unmerge_datasets(self, dataset_id: str) -> dict:
        """Unmerge a previously merged dataset."""
        return self._post('/api/datasets/unmerge', {'dataset_id': dataset_id})

    def unmerge_dataset(self, dataset_id: str) -> dict:
        """Alias matching the frontend API name for unmerging one dataset."""
        return self.unmerge_datasets(dataset_id)

    # =========================================================================
    # Dataset Catalog / Remote Sources
    # =========================================================================

    def get_catalog(self) -> dict:
        """Get the configured dataset catalog, if the server was launched with one."""
        return self._get('/api/catalog')

    def catalog_load(self, group_index: int) -> dict:
        """Load a catalog dataset group into the current browser session."""
        return self._post('/api/catalog/load', params={'group_index': int(group_index)})

    def catalog_unload(self, group_index: int) -> dict:
        """Unload a catalog dataset group from the current browser session."""
        return self._post('/api/catalog/unload', params={'group_index': int(group_index)})

    def catalog_track_load(self, track_index: int) -> dict:
        """Load a catalog orthogonal track into the current browser session."""
        return self._post('/api/catalog/tracks/load', params={'track_index': int(track_index)})

    def catalog_track_unload(self, track_index: int) -> dict:
        """Unload a catalog orthogonal track from the current browser session."""
        return self._post('/api/catalog/tracks/unload', params={'track_index': int(track_index)})

    def get_s3_status(self) -> dict:
        """Get S3 support/configuration status."""
        return self._get('/api/s3/status')

    def configure_s3(self, profile: str = None, region: str = None,
                     endpoint_url: str = None) -> dict:
        """Configure S3 or S3-compatible storage access for this server."""
        params = {}
        if profile:
            params['profile'] = profile
        if region:
            params['region'] = region
        if endpoint_url:
            params['endpoint_url'] = endpoint_url
        return self._post('/api/s3/configure', params=params)

    def test_s3_access(self, url: str) -> dict:
        """Test access to an S3 URL such as ``s3://bucket/key``."""
        return self._get('/api/s3/test', params={'url': url})

    def list_s3_bucket(self, bucket: str, prefix: str = '',
                       max_keys: int = 100) -> dict:
        """List objects in an S3 bucket/prefix."""
        return self._get('/api/s3/list', params={
            'bucket': bucket,
            'prefix': prefix,
            'max_keys': int(max_keys),
        })

    def get_presigned_url(self, url: str, expiration: int = 3600) -> dict:
        """Generate a temporary presigned URL for an S3 object."""
        return self._get('/api/s3/presign', params={
            'url': url,
            'expiration': int(expiration),
        })

    def get_ucsc_curated(self, genome: str) -> dict:
        """Get curated UCSC tracks for a genome."""
        return self._get('/api/ucsc/curated', params={'genome': genome})

    def search_ucsc_tracks(self, genome: str, query: str) -> dict:
        """Search UCSC tracks for a genome."""
        return self._get('/api/ucsc/search', params={'genome': genome, 'query': query})

    def browse_ucsc_tracks(self, genome: str) -> dict:
        """Browse UCSC tracks grouped by category for a genome."""
        return self._get('/api/ucsc/browse', params={'genome': genome})

    def get_encode_facets(self, genome: str) -> dict:
        """Get ENCODE search facets for a genome."""
        return self._get('/api/encode/facets', params={'genome': genome})

    def search_encode(self, genome: str, assay: str = None, target: str = None,
                      biosample: str = None, query: str = None,
                      limit: int = 25) -> dict:
        """Search ENCODE bigWig tracks."""
        params = {'genome': genome, 'limit': int(limit)}
        if assay:
            params['assay'] = assay
        if target:
            params['target'] = target
        if biosample:
            params['biosample'] = biosample
        if query:
            params['query'] = query
        return self._get('/api/encode/search', params=params)

    def get_chipatlas_status(self) -> dict:
        """Get ChIP-Atlas metadata loading status."""
        return self._get('/api/chipatlas/status')

    def get_chip_atlas_status(self) -> dict:
        """Acronym-preserving alias for `get_chipatlas_status`."""
        return self.get_chipatlas_status()

    def get_chipatlas_facets(self, genome: str) -> dict:
        """Get ChIP-Atlas facets for a genome."""
        return self._get('/api/chipatlas/facets', params={'genome': genome})

    def get_chip_atlas_facets(self, genome: str) -> dict:
        """Acronym-preserving alias for `get_chipatlas_facets`."""
        return self.get_chipatlas_facets(genome)

    def search_chipatlas(self, genome: str,
                         antigen_class: str = None,
                         antigen: str = None,
                         cell_type_class: str = None,
                         cell_type: str = None,
                         limit: int = 25) -> dict:
        """Search ChIP-Atlas tracks."""
        params = {'genome': genome, 'limit': int(limit)}
        if antigen_class:
            params['antigen_class'] = antigen_class
        if antigen:
            params['antigen'] = antigen
        if cell_type_class:
            params['cell_type_class'] = cell_type_class
        if cell_type:
            params['cell_type'] = cell_type
        return self._get('/api/chipatlas/search', params=params)

    def search_chip_atlas(self, *args, **kwargs) -> dict:
        """Acronym-preserving alias for `search_chipatlas`."""
        return self.search_chipatlas(*args, **kwargs)

    def diagnose_bam(self, bam_path: str = None, dataset_idx: int = None,
                     chrom: str = None, limit: int = 10) -> dict:
        """Diagnose BAM file tags and capabilities."""
        params = {'limit': limit}
        if bam_path:
            params['bam_path'] = bam_path
        if dataset_idx is not None:
            params['dataset_idx'] = dataset_idx
        if chrom:
            params['chrom'] = chrom
        return self._get('/api/diagnose_bam', params=params)

    # =========================================================================
    # Overlays (extended)
    # =========================================================================

    def get_overlay_marks(self, overlay_id: str, chrom: str = None,
                          start: int = None, end: int = None) -> dict:
        """Get modification marks from an overlay for a region."""
        if chrom is None:
            region = self.get_region()
            chrom, start, end = region['chrom'], region['start'], region['end']
        params = {'chrom': chrom, 'start': int(start), 'end': int(end)}
        return self._get(f'/api/overlays/{overlay_id}/marks', params=params)

    # =========================================================================
    # Utility (extended)
    # =========================================================================

    def get_cache_status(self) -> dict:
        """Get cache directory and per-genome cache status."""
        return self._get('/api/cache/status')

    # =========================================================================
    # Rendering
    # =========================================================================

    def render(self, chrom: str = None, start: int = None, end: int = None,
               dataset_id: str = None,
               dataset_ids: Optional[Union[str, Sequence[str]]] = None,
               tracks: Optional[Sequence[str]] = None,
               width: int = None,
               row_height: int = None,
               max_reads: int = None,
               sample_seed: str = None,
               use_clusters: bool = None,
               cluster_order: Optional[Dict[str, List[int]]] = None,
               read_sort_order: Optional[Dict[str, List[str]]] = None,
               show_layers: bool = None,
               show_mods: bool = None,
               show_fire: bool = None,
               show_cigar: bool = None,
               spanning_only: bool = None,
               sort_by: str = None,
               n_clusters: int = None,
               title: str = None,
               **kwargs) -> 'PILImage.Image':
        """Render the browser's view of a region as a PIL Image, headlessly.

        Drawn on the server in Python (no browser needed), from the open
        browser tab's state if there is one, else the browser's defaults.
        :meth:`figure` / :meth:`save_view` add sessions, SVG/PDF and scale.
        Pass ``engine="numpy"`` for the legacy compositor.

        If ``chrom``/``start``/``end`` are omitted, the current viewport is used
        (requires the browser to have navigated to a region first).

        Args:
            chrom: Chromosome name
            start: Start position
            end: End position
            dataset_id: Single dataset to render (default: browser's first/current dataset)
            dataset_ids: Render multiple datasets stacked
            tracks: Track types, e.g. ["axis", "meta", "peaks", "reads", "genes"]
            width: Image width in pixels
            row_height: Pixels per read row
            max_reads: Max display reads to render
            sample_seed: Seed for reproducible display sampling and k-means sort
            title: Title text above the composite
            use_clusters: Draw reads in stored cluster bands from a prior
                ``cluster_all`` call.
            cluster_order: Explicit per-dataset cluster draw order, e.g.
                ``{"primary": [2, 0, 1]}``.
            read_sort_order: Explicit per-dataset read order. Highest priority;
                use ``get_browser_order()`` to mirror the current screen order.
            spanning_only: Only show spanning reads
            sort_by: "accessibility" or "kmeans" fallback sort
            n_clusters: K for ad-hoc k-means sort
            show_layers: Render explicit TF/nuc/FIRE/deam layer calls
            show_mods: Show methylation/deamination marks
            show_fire: Show FIRE overlay
            show_cigar: Show mismatches/indels
            **kwargs: Additional advanced options forwarded to ``/api/render``
                such as ``quality_shading``, ``subnuc_threshold``, ``colors``,
                and ``tf_overlay``.

        Returns:
            PIL Image
        """
        from PIL import Image as PILImageMod
        import io as _io

        # Auto-detect region from viewport if not specified
        if chrom is None:
            region = self.get_region()
            chrom = region['chrom']
            start = region['start']
            end = region['end']

        payload = {'chrom': chrom, 'start': int(start), 'end': int(end),
                   'format': 'png'}
        explicit_options = {
            'dataset_id': dataset_id,
            'dataset_ids': self._list_param(dataset_ids),
            'tracks': list(tracks) if tracks is not None else None,
            'width': int(width) if width is not None else None,
            'row_height': int(row_height) if row_height is not None else None,
            'max_reads': int(max_reads) if max_reads is not None else None,
            'sample_seed': str(sample_seed) if sample_seed else None,
            'use_clusters': use_clusters,
            'cluster_order': cluster_order,
            'read_sort_order': read_sort_order,
            'show_layers': show_layers,
            'show_mods': show_mods,
            'show_fire': show_fire,
            'show_cigar': show_cigar,
            'spanning_only': spanning_only,
            'sort_by': sort_by,
            'n_clusters': int(n_clusters) if n_clusters is not None else None,
            'title': title,
        }
        payload.update({k: v for k, v in explicit_options.items() if v is not None})
        payload.update(kwargs)
        payload.pop('format', None)  # Always PNG for render() — use save_figure for other formats

        r = self._post_response("/api/render", data=payload, timeout=120)

        if r.headers.get('content-type', '').startswith('application/json'):
            # Error response
            data = r.json()
            raise RuntimeError(data.get('error', 'Render failed'))

        return PILImageMod.open(_io.BytesIO(r.content))

    # ------------------------------------------------------------------
    # Figures identical to the browser (Export button parity)
    # ------------------------------------------------------------------

    def get_live_view(self) -> dict:
        """What the open browser tab shows (region, track-area size, age)."""
        return self._get("/api/render/live_state")

    def figure(self, region: str = None, *, chrom: str = None, start: int = None,
               end: int = None, session: Union[str, dict] = None,
               load_session: bool = False, format: str = 'png', scale: float = 2.0,
               width: int = None, height: int = None, title: str = None,
               include_title: bool = False, include_coords: bool = False,
               expand_read_tracks: bool = True, match_read_counts: bool = False,
               match_ui_size: bool = True,
               show_nudges: bool = False, timeout_ms: int = None,
               engine: str = 'headless', source: str = 'auto',
               row_height: float = None, max_reads: int = None,
               dataset_ids: Optional[Union[str, Sequence[str]]] = None) -> bytes:
        """Render a figure of the browser's view (Export button equivalent).

        By default this is the open browser's current view: same panels,
        clusters, colors, layers and tracks. Pass ``region`` (``"chr1:1-2000"``)
        to render another region with that same setup, or ``session`` (a path
        or a session dict) to render a saved session instead.

        Args:
            format: ``"png"``, ``"svg"`` or ``"pdf"``.
            scale: Output pixels per screen pixel for PNG (2 = retina, 4 = print).
            width, height: Track-area size in screen pixels (default: the
                browser tab's size).
            include_title, title, include_coords: Optional title above and
                coordinates below, as in the Export panel.
            expand_read_tracks: Show every read row of scrolling read tracks.
            match_read_counts: Same number of reads in every sample.
            match_ui_size: Browser engine: draw at the session's UI size (a 150%
                UI gives 150% text, labels, rows and lines); False: at 100%.
            load_session: When the session's datasets are not loaded here,
                load them first (replaces what the browser shows).

            engine: ``"headless"`` (default) draws the browser's view in Python on
                the server: no browser needed, works from a session or with no
                browser open (``source="defaults"``). ``"browser"`` drives the
                real app in headless Chromium (needs Node + Playwright).
            source: Headless engine: ``"auto"`` (session if given, else the open
                tab, else defaults), ``"session"``, ``"current"`` or ``"defaults"``.
            row_height, max_reads, dataset_ids: Headless engine: read row height
                in px, reads per panel, and which datasets to draw.

        Returns:
            The file bytes.
        """
        if engine == 'headless':
            # Only coordinates the caller gave: otherwise the server takes the
            # region from the session, the open tab, or its last view.
            body = {'format': format, 'scale': float(scale), 'engine': 'headless', 'source': source}
            if region is not None:
                body['region'] = region
            for key, value in (('chrom', chrom), ('start', start), ('end', end)):
                if value is not None:
                    body[key] = value if key == 'chrom' else int(value)
            if load_session:
                body['load_session'] = True
            optional = {'width': width, 'title': title if (include_title or title) else None,
                        'include_coords': include_coords or None,
                        'row_height': row_height, 'max_reads': max_reads,
                        'dataset_ids': self._list_param(dataset_ids)}
            body.update({k: v for k, v in optional.items() if v is not None})
            if session is not None:
                body['source'] = 'session'
                if isinstance(session, dict):
                    body['session'] = session
                else:
                    import os
                    with open(os.path.expanduser(str(session)), encoding='utf-8') as handle:
                        body['session'] = json.load(handle)
            r = self._http_session().post(f"{self.url}/api/render", json=body, timeout=300)
            if r.status_code != 200 or r.headers.get('content-type', '').startswith('application/json'):
                try:
                    message = r.json().get('error')
                except Exception:
                    message = r.text[:300]
                raise RuntimeError(message or f'Figure render failed ({r.status_code})')
            return r.content
        if engine != 'browser':
            raise ValueError("engine must be 'headless' or 'browser'")
        # engine='browser': the real app in headless Chromium (Node + Playwright).
        body: Dict[str, Any] = {
            'format': format, 'scale': float(scale),
            'include_title': include_title, 'include_coords': include_coords,
            'expand_read_tracks': expand_read_tracks, 'match_read_counts': match_read_counts,
            'match_ui_size': match_ui_size, 'show_nudges': show_nudges,
        }
        optional = {'region': region, 'chrom': chrom, 'start': start, 'end': end,
                    'width': width, 'height': height, 'title': title, 'timeout_ms': timeout_ms}
        body.update({k: v for k, v in optional.items() if v is not None})
        if session is not None:
            body['source'] = 'session'
            body['load_session'] = load_session
            if isinstance(session, dict):
                body['session'] = session
            else:
                # Read it here: the server may be another machine.
                import os
                with open(os.path.expanduser(str(session)), encoding='utf-8') as handle:
                    body['session'] = json.load(handle)
        # Server waits up to settle + export + start-up; allow a bit more.
        settle_ms = timeout_ms or 30_000
        http_timeout = (settle_ms + max(30_000, settle_ms) + 60_000) / 1000
        # Not _post_response: keep the server's error message on 4xx/5xx.
        r = self._http_session().post(f"{self.url}/api/render/figure", json=body, timeout=http_timeout)
        if r.status_code != 200 or r.headers.get('content-type', '').startswith('application/json'):
            try:
                message = r.json().get('error')
            except Exception:
                message = r.text[:300]
            raise RuntimeError(message or f'Figure render failed ({r.status_code})')
        return r.content

    @staticmethod
    def _parse_region_string(region: str) -> tuple:
        """'chr1:1,000-2,000' -> ('chr1', 1000, 2000)."""
        import re as _re
        match = _re.match(r"^\s*([^:\s]+):([\d,]+)-([\d,]+)\s*$", str(region))
        if not match:
            raise ValueError(f"Region must look like chr1:1,000-2,000, got {region!r}")
        start, end = int(match.group(2).replace(",", "")), int(match.group(3).replace(",", ""))
        if end <= start:
            raise ValueError(f"Region end must be after start: {region!r}")
        return match.group(1), start, end

    def render_view(self, region: str = None, **kwargs) -> 'PILImage.Image':
        """:meth:`figure` as a PIL image (PNG), e.g. for display in Jupyter."""
        from PIL import Image as PILImageMod
        import io as _io
        kwargs['format'] = 'png'
        return PILImageMod.open(_io.BytesIO(self.figure(region, **kwargs)))

    def save_view(self, filepath: str, region: str = None, **kwargs) -> str:
        """Save :meth:`figure` to a file; the format follows the extension
        (``.png``, ``.svg``, ``.pdf``).

        Example::

            b.save_view("fig1a.pdf")                          # what the browser shows
            b.save_view("fig1b.png", "chr11:5,225,000-5,230,000", scale=4)
            b.save_view("fig1c.svg", session="figure1.json")
        """
        import os
        ext = os.path.splitext(filepath)[1].lower().lstrip('.')
        if ext in ('png', 'svg', 'pdf'):
            kwargs['format'] = ext
        else:
            kwargs.setdefault('format', 'png')
        data = self.figure(region, **kwargs)
        with open(filepath, 'wb') as f:
            f.write(data)
        return filepath

    def save_figure(self, filepath: str, **render_kwargs) -> str:
        """Render the browser's view headlessly (see :meth:`render`) and save it.

        :meth:`save_view` is the same with session and scale options.

        Format is inferred from the file extension:
        ``.png`` → PNG, ``.pdf`` → PDF, ``.svg`` → SVG.

        Args:
            filepath: Output file path (e.g. ``"figure.png"``, ``"fig.pdf"``,
                ``"output.svg"``)
            **render_kwargs: Forwarded to :meth:`render` / ``/api/render``.
                Common options: ``width``, ``row_height``, ``max_reads``,
                ``show_mods``, ``show_fire``, ``title``, ``dpi`` (for PDF/SVG).

        Returns:
            The filepath written.

        Example::

            # High-res PNG with modification marks
            b.save_figure("region.png", width=3000, row_height=4, show_mods=True)

            # PDF for publication
            b.save_figure("figure.pdf", width=2000, dpi=300, show_mods=True, title="Gene X")

            # SVG
            b.save_figure("figure.svg", width=2000)
        """
        import os

        ext = os.path.splitext(filepath)[1].lower()
        fmt_map = {'.png': 'png', '.pdf': 'pdf', '.svg': 'svg'}
        fmt = fmt_map.get(ext, 'png')

        if fmt in ('pdf', 'svg'):
            # Request format directly from server
            chrom = render_kwargs.pop('chrom', None)
            start = render_kwargs.pop('start', None)
            end = render_kwargs.pop('end', None)

            if chrom is None:
                region = self.get_region()
                chrom = region['chrom']
                start = region['start']
                end = region['end']

            payload = {'chrom': chrom, 'start': int(start), 'end': int(end),
                       'format': fmt}
            payload.update(render_kwargs)

            r = self._post_response("/api/render", data=payload, timeout=120)

            if r.headers.get('content-type', '').startswith('application/json'):
                data = r.json()
                raise RuntimeError(data.get('error', 'Render failed'))

            with open(filepath, 'wb') as f:
                f.write(r.content)
        else:
            img = self.render(**render_kwargs)
            img.save(filepath)

        return filepath

    def __repr__(self):
        headless = getattr(self, '_headless_proc', None) is not None
        try:
            status = self.get_status()
            return (f"BrowserClient(url='{self.url}', "
                    f"datasets={status.get('datasets', 0)}, "
                    f"chroms={status.get('chroms', 0)}"
                    f"{', headless=True' if headless else ''})")
        except Exception:
            return f"BrowserClient(url='{self.url}', connected=False)"


# Convenience function
def connect(url: str = "http://localhost:8000") -> BrowserClient:
    """
    Connect to a running FiberBrowser.
    
    Args:
        url: Browser server URL (default: http://localhost:8000)
    
    Returns:
        BrowserClient instance
    """
    return BrowserClient(url)
