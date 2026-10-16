"""Track renderers: one module per browser track type.

Each module ports one browser canvas (browser/frontend/src/components/tracks)
and exposes:

    measure(ctx: TrackContext, track: TrackSpec) -> float   # height in px
    draw(surface: Surface, ctx: TrackContext, track: TrackSpec, height: float) -> None

``draw`` paints the box (0, 0)-(ctx.width, height); compose.py translates and
clips the surface to the track's box first, so tracks draw in local
coordinates exactly as the browser canvas does (same pixel sizes and fonts).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from services.figure.data import DataCache
from services.figure.spec import FigureSpec, PanelSpec, TrackSpec


@dataclass
class TrackContext:
    state: object
    spec: FigureSpec
    panel: PanelSpec
    data: DataCache
    width: float

    @property
    def fe(self) -> dict:
        return self.spec.fe

    @property
    def region(self) -> tuple:
        """(chrom, start, end) this panel shows: its own location, else the figure's."""
        return self.panel.region or (self.spec.chrom, self.spec.start, self.spec.end)

    @property
    def chrom(self) -> str:
        return self.region[0]

    @property
    def start(self) -> int:
        return self.region[1]

    @property
    def end(self) -> int:
        return self.region[2]

    @property
    def reversed(self) -> bool:
        return bool(self.fe.get("isReversed"))

    def x_of(self, pos: float) -> float:
        """Genomic position -> x in the track (honours reversed view)."""
        frac = (pos - self.start) / max(1, self.end - self.start)
        return (1 - frac) * self.width if self.reversed else frac * self.width

    def heights(self) -> dict:
        from services.figure.defaults import defaults
        return defaults()["heights"]


@dataclass
class TrackModule:
    measure: Callable[[TrackContext, TrackSpec], float]
    draw: Callable


_REGISTRY: dict[str, TrackModule] = {}


def register(kind: str, measure, draw) -> None:
    _REGISTRY[kind] = TrackModule(measure, draw)


def module_for(track_type: str) -> Optional[TrackModule]:
    if track_type.startswith("composite-"):
        return _REGISTRY.get("composite")
    if track_type.startswith("ortho-"):
        return _REGISTRY.get("ortho")
    return _REGISTRY.get(track_type)


def load_all() -> None:
    """Import every track module so it registers itself."""
    from services.figure.tracks import axis, header  # noqa: F401
    for name in ("peaks", "genes", "sequence", "composite", "reads", "consensus"):
        try:
            __import__(f"services.figure.tracks.{name}")
        except ModuleNotFoundError as exc:
            if exc.name != f"services.figure.tracks.{name}":
                raise
