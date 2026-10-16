"""Dataset panel header (PanelHeader.tsx): a bar in the dataset colour with its name."""
from __future__ import annotations

from services.figure.tracks import register


def measure(ctx, track) -> float:
    return float(ctx.heights()["panelHeader"])


def draw(surface, ctx, track, height: float) -> None:
    surface.rect(0, 0, ctx.width, height, fill=ctx.panel.color)
    # px-2, bold 13px white label, truncated to the bar.
    # A strand panel names its strand, like StrandChip does in the browser.
    label = f"{ctx.panel.label} · {ctx.panel.strand} strand" if ctx.panel.strand else ctx.panel.label
    surface.text(8, height / 2, label, size=13, color="#ffffff", weight="bold",
                 baseline="middle", max_width=ctx.width - 16)


register("header", measure, draw)
