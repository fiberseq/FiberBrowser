"""The view frame of a regularity / geometry observation.

Molecules, tiles and patches are computed in their records' own coordinates. A native dataset's records are in the
main genome, so they are drawn as they are. A live-lift dataset's linear observation is a target view whose records
are on the lift map's source assembly (one contig per haplotype, possibly reversed): their reference intervals are
projected through the view's primary lift pieces into the target view (alignment blocks projected piece by piece),
so the haplotypes of one dataset, and lifted and native datasets, pool and compare in one frame.
A graph observation (a haplotype's own path) stays in the source frame.

``view_frame(state, source, obs)`` gives (target window, frame): frame None when no projection applies, else
``frame.record(chrom, start, end)`` gives a record's ``RecordFrame`` (None when no primary piece of the
observation's haplotype holds it, or its pieces inside the view mix orientations: no single frame), whose
``interval(a, b)`` maps a source interval to its target envelope, ``hidden_ends(a, b)`` says which of its ends lie in
an unlifted stretch (no target position: the envelope is cut there, so those ends are open) and ``reverse`` says
whether left and right swap.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

#: target bases selected around the view (records reach past its edges)
MARGIN_BP = 5000
#: a source gap between two lift pieces up to this long (an alignment's small indel) still places a patch end that
#: falls in it (at the gap); an end in a longer unlifted stretch, or past the pieces, is hidden (open, cut there)
HIDDEN_GAP_BP = 50


class RecordFrame:
    __slots__ = ('pieces', 'reverse')

    def __init__(self, pieces, reverse: bool):
        self.pieces = pieces
        self.reverse = reverse

    def hidden_ends(self, a: int, b: int) -> Tuple[bool, bool]:
        """Whether source ``[a, b)``'s start / end (in source orientation) lie outside every piece: in an unlifted
        stretch (inserted sequence, a non-primary or other-orientation piece, past the selected pieces). Such an end
        has no target position of its own; its envelope ends at a piece edge, which is where the interval is cut
        (open there), not where it ends."""
        a, b = int(a), int(b)
        return not self._placed(a, start=True), not self._placed(b, start=False)

    def _placed(self, x: int, *, start: bool) -> bool:
        """Whether source position ``x`` (a start, or an exclusive end) has a target position: inside a piece, or in
        a gap of at most ``HIDDEN_GAP_BP`` between two pieces (an alignment's small indel, where the chain breaks
        into blocks: the end is placed at the gap)."""
        qs = [(int(p.q_start), int(p.q_end)) for p in self.pieces]
        if any((s0 <= x < e0) if start else (s0 < x <= e0) for s0, e0 in qs):
            return True
        before = max((e0 for _s0, e0 in qs if e0 <= x), default=None)
        after = min((s0 for s0, _e0 in qs if s0 >= x), default=None)
        return before is not None and after is not None and after - before <= HIDDEN_GAP_BP

    def interval(self, a: int, b: int) -> Optional[Tuple[int, int]]:
        """The target envelope of source ``[a, b)`` (None outside every piece)."""
        lo = hi = None
        for p in self.pieces:
            s, e = max(int(a), int(p.q_start)), min(int(b), int(p.q_end))
            if e <= s:
                continue
            if p.strand == '-':
                ts, te = int(p.t_end) - (e - int(p.q_start)), int(p.t_end) - (s - int(p.q_start))
            else:
                ts, te = int(p.t_start) + (s - int(p.q_start)), int(p.t_start) + (e - int(p.q_start))
            lo = ts if lo is None else min(lo, ts)
            hi = te if hi is None else max(hi, te)
        return (lo, hi) if lo is not None else None


class ViewFrame:
    def __init__(self, pieces, view: Optional[Tuple[int, int]] = None):
        from .observations import same_contig
        self._same = same_contig
        self.view = view
        self.by_source: Dict[str, List] = {}
        for p in pieces:
            self.by_source.setdefault(str(p.source), []).append(p)

    def record(self, chrom: str, start: int, end: int) -> Optional[RecordFrame]:
        ps = [p for src, group in self.by_source.items() if self._same(src, chrom) for p in group
              if int(p.q_start) < int(end) and int(p.q_end) > int(start)]
        strands = {p.strand for p in ps}
        if ps and len(strands) > 1 and self.view is not None:
            # the record also crosses pieces of the other orientation (an inversion beside the view): its frame is
            # the orientation of its pieces inside the view; the other-orientation parts are unlifted stretches
            # (their ends open, ``RecordFrame.hidden_ends``)
            v0, v1 = self.view
            inside = {p.strand for p in ps if int(p.t_start) < v1 and int(p.t_end) > v0}
            if len(inside) == 1:
                ps = [p for p in ps if p.strand in inside]
                strands = inside
        if not ps or len(strands) != 1:
            return None
        return RecordFrame(sorted(ps, key=lambda p: int(p.q_start)), '-' in strands)


def view_frame(state, source, obs: dict):
    """(target window or None, ViewFrame or None) of an observation (module docstring)."""
    if source.kind == 'native' or (obs.get('kind') or 'linear') != 'linear':
        return None, None
    chrom, start, end = str(obs.get('chrom') or ''), int(obs.get('start') or 0), int(obs.get('end') or 0)
    if not chrom or end <= start:
        return None, None
    from services.lift.live_lift import lift_key, select_pieces
    config = state.datasets[source.browser_id].live_lift
    handle = config.handle
    if chrom not in handle.map.targets:
        return (chrom, start, end), ViewFrame([])
    haps = handle.resolve_haplotypes(config.haplotypes)
    sel = select_pieces(handle, chrom, max(0, start - MARGIN_BP), end + MARGIN_BP, haplotypes=haps,
                        settings=config.settings, key=lift_key(handle, haps, config.settings))
    hap = obs.get('liftHap')
    labels = getattr(handle, 'haplotype_labels', None) or {}
    pieces = [p for p in sel.pieces if p.primary and (not hap or hap in (p.hap, labels.get(p.hap)))]
    return (chrom, start, end), ViewFrame(pieces, (start, end))
