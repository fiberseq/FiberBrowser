"""Reference sequence track (SequenceTrack.tsx): coloured bases, letters at <= 200 bp.

Shown only with a reference loaded and a view of at most 2 kb, like the browser.
The bases come from the same server route as the browser's /api/sequence.
"""
from __future__ import annotations

from services.figure.tracks import register
from services.figure.tracks._util import cluster_sidebar_width, run_sync

BASE_COLORS = {"A": "#00b300", "T": "#ff0000", "C": "#0000ff", "G": "#e6a800", "N": "#999999"}
COMPLEMENT = {"A": "T", "T": "A", "C": "G", "G": "C", "N": "N"}
MAX_REGION = 2000
LETTER_REGION = 200


def has_fasta(state) -> bool:
    """/api/status has_fasta."""
    return getattr(state, "fasta", None) is not None or bool(getattr(state, "plasmid_sequences", {}) or {})


def load_sequence(ctx) -> tuple[int, str] | None:
    """(genomic start of the first base, bases inside the view). Near a linear
    contig's end the server returns fewer bases than the view spans."""
    def load():
        from routers.genome import get_sequence
        try:
            res = run_sync(get_sequence(ctx.chrom, ctx.start, ctx.end, state=ctx.state))
        except Exception:
            return None
        seq = (res or {}).get("sequence") or ""
        seq_start = int((res or {}).get("start", ctx.start))
        # Keep only the bases inside [start, end).
        if seq_start < ctx.start:
            seq = seq[ctx.start - seq_start:]
            seq_start = ctx.start
        seq = seq[:max(0, ctx.end - seq_start)]
        return (seq_start, seq) if seq else None

    return ctx.data.get(("sequence", ctx.chrom, ctx.start, ctx.end), load)


def measure(ctx, track) -> float:
    if not has_fasta(ctx.state) or ctx.end - ctx.start > MAX_REGION:
        return 0.0
    return float(track.height or ctx.heights()["sequence"])


def draw(surface, ctx, track, height: float) -> None:
    sidebar = cluster_sidebar_width(ctx)
    width = ctx.width - sidebar
    loaded = load_sequence(ctx)
    if not loaded or width <= 0:
        return  # the browser leaves the canvas blank until bases arrive
    # A bare string (a primed cache) starts at the view's start.
    seq_start, sequence = (ctx.start, loaded) if isinstance(loaded, str) else loaded
    surface.save()
    surface.translate(sidebar, 0)
    surface.rect(0, 0, width, height, fill="#fafafa")
    # Each base at its genomic position across the view; positions outside the
    # reference stay blank rather than stretching the bases over them.
    span = max(1, ctx.end - ctx.start)
    show_letters = span <= LETTER_REGION
    w = width / span
    font = min(14, w * 0.8)
    for i, base in enumerate(sequence):
        offset = seq_start - ctx.start + i
        if ctx.reversed:
            base = COMPLEMENT.get(base, base)
            offset = span - 1 - offset
        x = offset * w
        color = BASE_COLORS.get(base, BASE_COLORS["N"])
        if show_letters:
            surface.rect(x, 0, w, height, fill=color)
            surface.text(x + w / 2, height / 2, base, size=font, color="#ffffff", anchor="middle",
                         baseline="middle", weight="bold", mono=True)
        else:
            surface.rect(x, 2, w, height - 4, fill=color)
    surface.restore()


register("sequence", measure, draw)
