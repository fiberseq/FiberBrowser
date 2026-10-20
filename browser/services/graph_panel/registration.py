"""Registered graph packages (DESIGN_GRAPH_PANEL.md §§2, 6).

A package is the immutable directory ``fiberbrowser-graph prepare`` publishes
(``manifest.json``, ``graph.db``, maps). Registration runs the helper's full
digest check (``verify --package``) once, records the manifest's revisions,
bindings and extents, and fingerprints every file (size, mtime). Queries name a
registration ID, never a path; a package whose files changed since verification
is refused until it is registered again.

Registrations come from ``FIBERBROWSER_GRAPH_PACKAGES`` (os.pathsep-separated
directories, verified at first use) and from ``POST /api/graph/registrations``
(a host-only route). They are remembered in ``~/.fiberhmm/graph_registrations.json``
(``FIBERBROWSER_GRAPH_REGISTRY`` overrides the file) as locators only.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

ENV_PACKAGES = "FIBERBROWSER_GRAPH_PACKAGES"
ENV_REGISTRY = "FIBERBROWSER_GRAPH_REGISTRY"
VERIFY_TIMEOUT_S = float(os.environ.get("FIBERBROWSER_GRAPH_VERIFY_TIMEOUT_S", "900"))
MANIFEST = "manifest.json"
MAX_MANIFEST_BYTES = 64 << 20


class RegistrationError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class Registration:
    id: str
    package_dir: str
    revisions: dict
    bindings: list
    maps: list
    producer: str
    build_target: str
    verified_at: float
    fingerprint: dict = field(repr=False, default_factory=dict)
    verify_ms: float = 0.0

    def binding(self, key: str) -> Optional[dict]:
        return next((b for b in self.bindings if b.get("key") == key), None)

    def public(self) -> dict:
        return {
            "id": self.id, "label": os.path.basename(os.path.normpath(self.package_dir)),
            "revisions": self.revisions, "producer": self.producer, "build_target": self.build_target,
            "bindings": self.bindings, "maps": self.maps, "verified_at": self.verified_at,
            "verify_ms": round(self.verify_ms, 1),
        }


def registry_file() -> str:
    override = (os.environ.get(ENV_REGISTRY) or "").strip()
    return override or os.path.join(os.path.expanduser("~"), ".fiberhmm", "graph_registrations.json")


def _fingerprint(package_dir: str) -> dict:
    out = {}
    for root, _dirs, files in os.walk(package_dir):
        for name in files:
            path = os.path.join(root, name)
            st = os.stat(path)
            out[os.path.relpath(path, package_dir)] = (st.st_size, st.st_mtime_ns)
    return out


def _binding_summary(binding: dict) -> dict:
    fragments = binding.get("fragments") or []
    return {
        "key": binding.get("key"), "path": binding.get("path"), "assembly": binding.get("assembly"),
        "reference": binding.get("reference"), "size": binding.get("size"),
        "size_inferred": bool(binding.get("size_inferred")),
        "fragments": [{"origin": f.get("origin"), "end": f.get("end"), "indexed": bool(f.get("indexed"))} for f in fragments],
        "uncovered": binding.get("uncovered") or [],
    }


def read_manifest(package_dir: str) -> dict:
    path = os.path.join(package_dir, MANIFEST)
    try:
        size = os.path.getsize(path)
    except OSError:
        raise RegistrationError("not_a_package", f"{package_dir} has no {MANIFEST}", 404) from None
    if size > MAX_MANIFEST_BYTES:
        raise RegistrationError("package_data", f"{MANIFEST} is {size} bytes, above {MAX_MANIFEST_BYTES}")
    try:
        with open(path, "rb") as handle:
            manifest = json.loads(handle.read())
    except (OSError, ValueError) as exc:
        raise RegistrationError("package_data", f"cannot read {MANIFEST}: {exc}") from None
    revisions = manifest.get("revisions") or {}
    if not all(isinstance(revisions.get(k), str) and revisions.get(k) for k in ("package", "graph", "db", "maps")):
        raise RegistrationError("package_data", f"{MANIFEST} has no complete revisions")
    return manifest


def verify_package(helper_path: str, package_dir: str, timeout_s: float = VERIFY_TIMEOUT_S) -> float:
    """The helper's full digest verification of every packaged byte; returns its wall time in ms."""
    t0 = time.perf_counter()
    try:
        proc = subprocess.run([helper_path, "verify", "--package", package_dir], stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired:
        raise RegistrationError("verify_timeout", f"verification took longer than {timeout_s:g} s", 504) from None
    except OSError as exc:
        raise RegistrationError("helper_unavailable", f"cannot run the graph helper: {exc}", 503) from None
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip()[-600:]
        raise RegistrationError("package_invalid", f"the package failed verification: {tail or 'exit ' + str(proc.returncode)}", 422)
    return (time.perf_counter() - t0) * 1000.0


def build_registration(helper_path: str, package_dir: str) -> Registration:
    package_dir = os.path.realpath(os.path.expanduser(package_dir))
    if not os.path.isdir(package_dir):
        raise RegistrationError("not_a_package", f"{package_dir} is not a directory", 404)
    read_manifest(package_dir)
    before = _fingerprint(package_dir)
    verify_ms = verify_package(helper_path, package_dir)
    after = _fingerprint(package_dir)
    if before != after:
        raise RegistrationError("package_changed", "the package changed while it was being verified", 409)
    manifest = read_manifest(package_dir)
    revisions = {k: manifest["revisions"][k] for k in ("package", "graph", "db", "maps")}
    bindings = [_binding_summary(b) for b in manifest.get("bindings") or []]
    maps = [{"target": m.get("target"), "source": m.get("source")} for m in manifest.get("maps") or []]
    return Registration(
        id="g" + revisions["package"][:16], package_dir=package_dir, revisions=revisions, bindings=bindings, maps=maps,
        producer=str(manifest.get("producer") or ""), build_target=str(manifest.get("build_target") or ""),
        verified_at=time.time(), fingerprint=after, verify_ms=verify_ms)


class Registry:
    """Thread-safe registration table; persistence holds locators only."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or registry_file()
        self._lock = threading.Lock()
        self._items: dict[str, Registration] = {}
        self._errors: dict[str, str] = {}
        self._loaded = False

    def _load_locators(self) -> list[str]:
        dirs: list[str] = []
        env = (os.environ.get(ENV_PACKAGES) or "").strip()
        if env:
            dirs += [d for d in env.split(os.pathsep) if d.strip()]
        try:
            with open(self.path) as handle:
                saved = json.load(handle)
            dirs += [str(d) for d in saved.get("packages", []) if isinstance(d, str)]
        except (OSError, ValueError, AttributeError):
            pass
        seen, out = set(), []
        for d in dirs:
            real = os.path.realpath(os.path.expanduser(d))
            if real not in seen:
                seen.add(real)
                out.append(real)
        return out

    def _save(self) -> None:
        packages = sorted({r.package_dir for r in self._items.values()})
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = f"{self.path}.tmp{os.getpid()}"
            with open(tmp, "w") as handle:
                json.dump({"packages": packages}, handle, indent=1)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def ensure_loaded(self, helper_path: Optional[str]) -> None:
        """Verify remembered/env packages once a helper exists (each failure is listed, not fatal)."""
        with self._lock:
            if self._loaded or not helper_path:
                return
            self._loaded = True
            locators = self._load_locators()
        for d in locators:
            try:
                reg = build_registration(helper_path, d)
            except RegistrationError as exc:
                with self._lock:
                    self._errors[d] = exc.message
                continue
            with self._lock:
                self._items[reg.id] = reg

    def register(self, helper_path: str, package_dir: str) -> Registration:
        reg = build_registration(helper_path, package_dir)
        with self._lock:
            self._items[reg.id] = reg
            self._errors.pop(reg.package_dir, None)
            self._save()
        return reg

    def unregister(self, reg_id: str) -> bool:
        with self._lock:
            removed = self._items.pop(reg_id, None) is not None
            if removed:
                self._save()
        return removed

    def get(self, reg_id: str) -> Registration:
        with self._lock:
            reg = self._items.get(reg_id)
        if reg is None:
            raise RegistrationError("unknown_registration", f"no graph registration {reg_id!r}", 404)
        return reg

    def check_unchanged(self, reg: Registration) -> None:
        """Refuse a package edited after verification (immutability is the caller's duty, GRAPH_HELPER.md)."""
        try:
            now = _fingerprint(reg.package_dir)
        except OSError:
            now = None
        if now != reg.fingerprint:
            raise RegistrationError("package_changed",
                                    "the graph package changed or disappeared since it was verified; register it again", 409)

    def list(self) -> list[dict]:
        with self._lock:
            return [r.public() for r in self._items.values()]

    def errors(self) -> list[dict]:
        with self._lock:
            return [{"package": d, "error": e} for d, e in self._errors.items()]
