"""Live-lift datasets (``data_type='bam_livelift'``, DESIGN_LIVE_LIFT.md §2.1):
source BAM(s) drawn on the main genome through a graphlift sidecar.

On by default on a personal server. ``FIBERBROWSER_LIVE_LIFT=0`` turns it off
(the routes answer 404, the frontend shows no entry point and a session holding
a lifted dataset says so). A public server and remote clients never reach the
lift routes (their allowlists leave them out). A shared lab server keeps live
lift off unless its host sets ``FIBERBROWSER_LIVE_LIFT=1``, because opening a
map reads a path on the server outside the lab's dataset confinement.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

from services.lift.live_lift import LiftSettings, lift_key, open_lift_map

FLAG_ENV = "FIBERBROWSER_LIVE_LIFT"


def live_lift_enabled() -> bool:
    value = os.environ.get(FLAG_ENV, "").strip().lower()
    if value in ("0", "false", "no", "off"):
        return False
    if value in ("1", "true", "yes", "on"):
        return True
    from services.runtime import get_lab_mode, get_public_mode
    return not (get_lab_mode() or get_public_mode())


def label_order(label: str) -> tuple:
    """MAT before PAT before anything else (panels, chips and menus list haplotypes this way)."""
    return ({"MAT": 0, "PAT": 1}.get(str(label).upper(), 2), str(label))


class LiveLiftConfig:
    """A lifted dataset's map, haplotypes and advanced settings."""

    def __init__(self, manifest: str, haplotypes: Iterable[str], settings: Optional[LiftSettings] = None, *,
                 source_fasta: Optional[str] = None):
        self.manifest = os.path.abspath(os.path.expanduser(manifest))
        self.settings = settings or LiftSettings()
        self.source_fasta = os.path.abspath(os.path.expanduser(source_fasta)) if source_fasta else None
        self.validation = None
        labels = self.handle.haplotype_labels
        self.haplotypes = sorted(self.handle.resolve_haplotypes(list(haplotypes) or self.handle.haplotypes),
                                 key=lambda h: label_order(labels.get(h, h)))

    @property
    def handle(self):
        """The shared map handle (reopened when the sidecar changes)."""
        return open_lift_map(self.manifest)

    def key(self) -> str:
        return lift_key(self.handle, self.haplotypes, self.settings)

    def labels(self) -> dict:
        labels = self.handle.haplotype_labels
        return {hap: labels.get(hap, hap) for hap in self.haplotypes}

    def to_dict(self) -> dict:
        handle = self.handle
        return {
            "manifest": self.manifest,
            "map_label": os.path.basename(self.manifest),
            "haplotypes": list(self.haplotypes),
            "haplotype_labels": self.labels(),
            "available_haplotypes": {hap: handle.haplotype_labels.get(hap, hap) for hap in handle.haplotypes},
            "settings": self.settings.as_dict(),
            "key": self.key(),
            "source_assembly": _source_assembly(handle),
            "source_fasta": self.source_fasta,
            "validation": self.validation,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LiveLiftConfig":
        config = cls(data["manifest"], data.get("haplotypes") or (), LiftSettings.from_dict(data.get("settings")),
                     source_fasta=data.get("source_fasta"))
        config.validation = data.get("validation")
        return config


def _source_assembly(handle) -> str:
    graph = handle.manifest.get("graph") or {}
    name = graph.get("name") if isinstance(graph, dict) else None
    return name or "source assembly"
