"""Internal plugin packs: optional feature folders that ship with some builds.

A pack is a directory directly under ``browser/`` holding a
``fiberbrowser-pack.json`` manifest and a Python package whose ``pack``
module defines ``register(api: PackAPI)``. Core code never imports a pack by
name: it only calls :func:`load_packs` (from the router registry and, lazily,
from every hook below) and goes through the hooks a pack registered. A build
without the folder simply has no packs. See ARCHITECTURE.md.

Manifest::

    {"name": "<id>", "label": "<shown in About>", "flavor": "<build flavour>",
     "module": "<package>.pack"}

What a pack can contribute (all optional):

- API routers (``add_router``), and their places in the public-server,
  remote-viewer and public-protection allowlists (``allow_routes``);
- session hooks: an export step, an import start/finish step, and a dispose
  step (a session closing or being replaced);
- dataset hooks: a step when a dataset opens, extra fields in its session
  entry, and a restorer for session dataset entries it owns;
- a FASTA context describer (how a panel's own reference is named);
- feature-state providers for feature kinds of its own (``/api/features/states``).
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

MANIFEST = "fiberbrowser-pack.json"
# Where the session export hooks note which keys each pack added (moved into session["packs"] before writing).
PACK_PARTS_KEY = "_pack_parts"
BROWSER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

Route = Tuple[str, str]


@dataclass
class PackInfo:
    name: str
    label: str
    flavor: str
    module: str
    path: str

    def to_dict(self) -> dict:
        return {"name": self.name, "label": self.label, "flavor": self.flavor}


@dataclass
class DatasetRestorer:
    """Claims session dataset entries (``owns(entry)``) and opens them after the
    plain datasets and references are back (``restore(state, entry) -> payload``
    like ``open_dataset``'s), then ``finish(state)`` once all are open."""
    owns: Callable[[dict], bool]
    restore: Callable[[Any, dict], dict]
    finish: Optional[Callable[[Any], None]] = None
    label: str = "dataset"


@dataclass
class PackHooks:
    routers: List[Any] = field(default_factory=list)
    public_routes: set = field(default_factory=set)
    remote_routes: set = field(default_factory=set)
    protected_routes: set = field(default_factory=set)
    session_export: List[Callable[[Any, dict, dict], None]] = field(default_factory=list)
    session_import_begin: List[Callable[[Any, dict], None]] = field(default_factory=list)
    session_import_end: List[Callable[[Any, dict, dict], None]] = field(default_factory=list)
    session_dispose: List[Callable[[Any], None]] = field(default_factory=list)
    dataset_opened: List[Callable[[Any, Any], None]] = field(default_factory=list)
    dataset_session_entry: List[Callable[[Any], Optional[dict]]] = field(default_factory=list)
    dataset_restorers: List[DatasetRestorer] = field(default_factory=list)
    fasta_context: List[Callable[[Any, str], Optional[dict]]] = field(default_factory=list)
    session_reference_filters: List[Callable[[str, str, dict], bool]] = field(default_factory=list)
    feature_states: Dict[str, Callable[..., Any]] = field(default_factory=dict)
    preference_maps: Dict[str, Callable[[Any], Any]] = field(default_factory=dict)


class PackAPI:
    """What a pack's ``register(api)`` is given."""

    def __init__(self, info: PackInfo, hooks: PackHooks, *, builtin: bool = False):
        self.info = info
        self._hooks = hooks
        # A core module registering through the same extension points (plugins/builtin_features.py): every build has
        # it, so what it writes into sessions is not marked as a pack's.
        self._builtin = builtin

    def add_router(self, router) -> None:
        """An APIRouter mounted like the built-in ones (its own paths, no prefix)."""
        self._hooks.routers.append(router)

    def allow_routes(self, routes: Iterable[Route], *, public: bool = False, remote: bool = False,
                     protected: bool = False) -> None:
        """(method, path) pairs this pack's routers serve that a public server (``public``), a remote viewer
        (``remote``) may call, or that a public server rate-limits as heavy work (``protected``)."""
        for route in routes:
            if public:
                self._hooks.public_routes.add(tuple(route))
            if remote:
                self._hooks.remote_routes.add(tuple(route))
            if protected:
                self._hooks.protected_routes.add(tuple(route))

    def on_session_export(self, fn: Callable[[Any, dict, dict], None]) -> None:
        """fn(state, frontend_state, session): add this pack's part to the session being written. The keys a pack adds
        are listed with it (``session["packs"][name]["parts"]``): a build without the pack reports it missing only when
        the session holds such a part."""
        if self._builtin:
            self._hooks.session_export.append(fn)
            return
        name = self.info.name

        def export(state, frontend_state, session):
            before = set(session)
            fn(state, frontend_state, session)
            added = [key for key in session if key not in before]
            if added:
                session.setdefault(PACK_PARTS_KEY, {}).setdefault(name, []).extend(added)
        self._hooks.session_export.append(export)

    def on_session_import_begin(self, fn: Callable[[Any, dict], None]) -> None:
        """fn(state, session): before the replaced session's datasets go (dispose what the new one doesn't keep)."""
        self._hooks.session_import_begin.append(fn)

    def on_session_import_end(self, fn: Callable[[Any, dict, dict], None]) -> None:
        """fn(state, session, results): once the datasets are open (restore this pack's part, report in results)."""
        self._hooks.session_import_end.append(fn)

    def on_session_dispose(self, fn: Callable[[Any], None]) -> None:
        """fn(state): a session closes (cancel and drop this pack's work)."""
        self._hooks.session_dispose.append(fn)

    def on_dataset_opened(self, fn: Callable[[Any, Any], None]) -> None:
        """fn(state, dataset): a dataset was registered."""
        self._hooks.dataset_opened.append(fn)

    def dataset_session_entry(self, fn: Callable[[Any], Optional[dict]]) -> None:
        """fn(dataset) -> fields merged into the dataset's session entry (or None). An entry with fields of a pack
        is marked ``"pack": <name>``: a build without the pack skips it (and says so) instead of opening it."""
        if self._builtin:
            self._hooks.dataset_session_entry.append(fn)
            return
        name = self.info.name

        def entry(dataset):
            extra = fn(dataset)
            return {**extra, "pack": name} if extra else extra
        self._hooks.dataset_session_entry.append(entry)

    def dataset_restorer(self, restorer: DatasetRestorer) -> None:
        self._hooks.dataset_restorers.append(restorer)

    def fasta_context(self, fn: Callable[[Any, str], None]) -> None:
        """fn(ctx, fasta_path): a panel reference was loaded; a pack that built it describes it on the context's
        ``_panel_genome_spec`` (label, ``"pack": <name>``, ...)."""
        self._hooks.fasta_context.append(fn)

    def session_reference_filter(self, fn: Callable[[str, str, dict], bool]) -> None:
        """fn(kind, key, source) -> True for a session reference a pack rebuilds itself (not a file to relink)."""
        self._hooks.session_reference_filters.append(fn)

    def feature_states(self, kind: str, fn: Callable[..., Any]) -> None:
        """fn(state, feature) -> (states, datasets, label, span) for a feature kind of this pack."""
        self._hooks.feature_states[kind] = fn

    def preference_map(self, field_name: str, clean: Callable[[Any], Any]) -> None:
        """An analysis preference kept on this computer (services/analysis_preferences.py) as ``{key: value}``,
        merged per key like the core maps; ``clean(raw)`` validates one value (None drops it)."""
        self._hooks.preference_maps[field_name] = clean


_lock = threading.RLock()
_loaded: Optional[List[PackInfo]] = None
_hooks = PackHooks()
_errors: List[str] = []


# Core features that use the pack extension points (plugins/builtin_features.py): registered first, in every build,
# and never listed as a pack (no flavour, no session marker).
BUILTIN = PackInfo(name="core", label="FiberBrowser", flavor="public", module="plugins.builtin_features",
                   path=os.path.dirname(os.path.abspath(__file__)))


def discover_packs(browser_dir: str = BROWSER_DIR) -> List[PackInfo]:
    """Packs present in this build: subfolders of browser/ with a manifest."""
    found: List[PackInfo] = []
    try:
        entries = sorted(os.listdir(browser_dir))
    except OSError:
        return found
    for entry in entries:
        manifest = os.path.join(browser_dir, entry, MANIFEST)
        if not os.path.isfile(manifest):
            continue
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            name = str(data.get("name") or entry)
            found.append(PackInfo(
                name=name,
                label=str(data.get("label") or name),
                flavor=str(data.get("flavor") or name),
                module=str(data.get("module") or f"{entry}.pack"),
                path=os.path.join(browser_dir, entry),
            ))
        except Exception as exc:  # a broken manifest must not stop the server
            _errors.append(f"{manifest}: {exc}")
    return found


def load_packs() -> List[PackInfo]:
    """Discover and register every pack once (idempotent, thread-safe)."""
    global _loaded
    if _loaded is not None:
        return _loaded
    with _lock:
        if _loaded is not None:
            return _loaded
        loaded: List[PackInfo] = []
        if BROWSER_DIR not in sys.path:
            sys.path.insert(0, BROWSER_DIR)
        try:
            importlib.import_module(BUILTIN.module).register(PackAPI(BUILTIN, _hooks, builtin=True))
        except Exception as exc:
            _errors.append(f"builtin features: {exc}")
            print(f"  Warning: built-in features failed to register: {exc}")
        for info in discover_packs():
            try:
                module = importlib.import_module(info.module)
                register = getattr(module, "register")
                register(PackAPI(info, _hooks))
                loaded.append(info)
            except Exception as exc:
                _errors.append(f"{info.name}: {exc}")
                print(f"  Warning: plugin pack {info.name} failed to load: {exc}")
        _loaded = loaded
        return loaded


def hooks() -> PackHooks:
    load_packs()
    return _hooks


def loaded_packs() -> List[PackInfo]:
    return list(load_packs())


def pack_errors() -> List[str]:
    return list(_errors)


def build_flavor() -> str:
    """The build's flavour: the first pack's, else "public"."""
    packs = load_packs()
    return packs[0].flavor if packs else "public"


def run_hooks(name: str, *args) -> None:
    """Call every hook of a list; one failing never stops the others (it is reported)."""
    for fn in list(getattr(hooks(), name)):
        try:
            fn(*args)
        except Exception as exc:
            print(f"  Warning: plugin pack hook {name} failed: {exc}")


def dataset_session_fields(dataset) -> dict:
    out: dict = {}
    for fn in list(hooks().dataset_session_entry):
        try:
            extra = fn(dataset)
        except Exception:
            extra = None
        if extra:
            out.update(extra)
    return out


def restorer_for(entry: dict) -> Optional[DatasetRestorer]:
    for restorer in hooks().dataset_restorers:
        try:
            if restorer.owns(entry):
                return restorer
        except Exception:
            continue
    return None


def pack_rebuilds_reference(kind: str, key: str, source: dict) -> bool:
    """A session reference a pack or a core feature rebuilds itself (marked ``"pack"`` or ``"built_by"``, or one a
    filter claims)."""
    if isinstance(source, dict) and (source.get("pack") or source.get("built_by")):
        return True
    for fn in list(hooks().session_reference_filters):
        try:
            if fn(kind, key, source):
                return True
        except Exception:
            continue
    return False


def preference_maps() -> Dict[str, Callable[[Any], Any]]:
    """The packs' analysis preference maps: field -> clean(raw)."""
    return dict(hooks().preference_maps)


def pack_routes(kind: str) -> frozenset:
    """Routes the packs placed on an allowlist: 'public', 'remote' or 'protected'."""
    h = hooks()
    return frozenset({"public": h.public_routes, "remote": h.remote_routes, "protected": h.protected_routes}[kind])


def pack_router_routes() -> frozenset:
    """(method, path) of every route the packs' routers serve (core route audits leave them to the pack's tests)."""
    out = set()
    for router in hooks().routers:
        for route in getattr(router, "routes", ()):
            for method in getattr(route, "methods", None) or ():
                out.add((method, getattr(route, "path", "")))
    return frozenset(out)
