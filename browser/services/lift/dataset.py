"""Live-lift datasets (``data_type='bam_livelift'``, DESIGN_LIVE_LIFT.md §2.1):
source BAM(s) drawn on the main genome through a graphlift sidecar.

Behind the flag ``FIBERBROWSER_LIVE_LIFT`` (off: the routes answer 404 and
the frontend shows no entry point; a session holding a lifted dataset says so).
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

from services.lift.live_lift import LiftSettings, lift_key, open_lift_map

FLAG_ENV = "FIBERBROWSER_LIVE_LIFT"


def live_lift_enabled() -> bool:
    return os.environ.get(FLAG_ENV, "").strip().lower() in ("1", "true", "yes", "on")


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
            "source_sample": source_sample(handle.haplotypes),
            "target_reference": target_reference(handle.manifest),
            "source_fasta": self.source_fasta,
            "validation": self.validation,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LiveLiftConfig":
        config = cls(data["manifest"], data.get("haplotypes") or (), LiftSettings.from_dict(data.get("settings")),
                     source_fasta=data.get("source_fasta"))
        config.validation = data.get("validation")
        return config


def _pansn_sample(name) -> Optional[str]:
    """The sample of a PanSN name (``HG002#1#chr3`` and ``HG002#1`` -> ``HG002``); a ``_MAT``/``_PATERNAL``-style
    suffix on the sample is dropped (``HG002_MAT#1`` -> ``HG002``)."""
    import re
    sample = str(name or "").split("#", 1)[0].strip()
    sample = re.sub(r"[_.\-](MAT|PAT)(ERNAL)?$", "", sample, flags=re.IGNORECASE)
    return sample or None


def source_sample(haplotypes) -> Optional[str]:
    """The one sample a map's source haplotypes belong to (labels: "Open in HG002 view"); None for several or none."""
    samples = {_pansn_sample(h) for h in haplotypes or ()}
    samples.discard(None)
    return samples.pop() if len(samples) == 1 else None


def target_reference(manifest) -> Optional[str]:
    """The target assembly's name from the map's target paths (``GRCh38#0`` -> ``GRCh38``), when they agree."""
    names = {_pansn_sample(t.get("haplotype") or t.get("path") or "") if "#" in str(t.get("haplotype") or t.get("path") or "") else None
             for t in manifest.get("targets") or [] if isinstance(t, dict)}
    names.discard(None)
    return names.pop() if len(names) == 1 else None


def _source_assembly(handle) -> str:
    graph = handle.manifest.get("graph") or {}
    name = graph.get("name") if isinstance(graph, dict) else None
    return name or "source assembly"
