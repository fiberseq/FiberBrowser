"""Window-wide columnar pre-pass for ``compose.lift_compact_reads``.

The composer maps every interval, call and point mark of every row through
that row's fragments. Done row by row and group by group, the fixed cost of
each small NumPy call (or of the Python loop below the vectorisation cutoff)
dominates: a 50 kb view has about 400 rows and 2,000 interval groups of
2-80 intervals each. This module does the same mapping for all rows of a
window at once, in a few batched ``searchsorted`` passes over one fragment
table, and leaves the results on each row (``row._pre``) for
``compose._row_payload`` to pick up.

It is an exact re-implementation of ``compose._map_group``,
``compose._call_identity``, ``compose._map_points`` and
``compose._molecular_spans`` for the cases it accepts; everything else stays
on those functions (``row._pre`` then lacks the entry):

- rows whose fragments overlap in source (``row.disjoint`` false);
- interval groups that are not all ``[start, end, size]`` Python ints, and
  point fields that are not all Python ints (``deam`` pairs always);
- reads whose aligned runs are not ascending and disjoint;
- coordinates outside ``[0, 2**40)``;
- top-level gaps of rows with deletion cuts (``sv``) or with a call that has
  several parts in one span (``_logical`` would join them).

Hidden insertion blocks run through it too, each in its own frame
(``precompute(regions=...)``).

Rows of one window are told apart by a composite key ``row * 2**40 + x``, so
a single sorted array holds every row's fragment starts (or ends, or a read's
run starts) and one ``searchsorted`` finds, for each position, the fragment
or run of its own row. Mapped intervals and marks are handed back as
``read_columns.IntColumn`` copies of slices of the window arrays (read row
format 2: they read exactly as the lists they stand for; each row owns its
arrays, so no row pins a window); every other value is a
Python int, bool or list (``tolist``), never a NumPy scalar. A read's lists
are read into arrays once per load (``_cached``), so its hidden insertion
blocks reuse them.
"""
from __future__ import annotations

from itertools import chain
from operator import itemgetter

import numpy as np

from services.read_columns import owned, read_only

_SHIFT = 1 << 40
_first = itemgetter(0)
# Intervals, calls and marks (times the rows that map them) per batch: bounds
# the temporary arrays; larger windows run as several batches.
CHUNK_ELEMENTS = 1 << 16


class RowColumns:
    """Pre-computed per-row results (each None or missing where the per-row
    functions must run instead):

    - ``groups[name] = (parts, mapped, ids, keys)``: ``_map_group``, the mapped
      intervals and ``_call_identity`` of one interval group;
    - ``points[field] = (marks, dropped)``: ``_map_points``;
    - ``molecular_spans``: region-relative, sorted and clipped to the region
      as ``reads.clip_geometry`` clips them;
    - ``intervals``: the row's top-level ``(intervals, call ids, call parts,
      qualities or None)``, gaps rebuilt, in display order."""
    __slots__ = ("groups", "points", "molecular_spans", "intervals")

    def __init__(self):
        self.groups, self.points, self.molecular_spans, self.intervals = {}, {}, None, None


class LazyParts:
    """A group's parts ``[(t0, t1, i, k)]`` as ``_map_group`` returns them,
    built from the window's columns only when a caller iterates or indexes
    them (the batched top-level layout and fire never do); ``index()`` is the
    interval index of each part."""
    __slots__ = ("_cols", "_lo", "_hi", "_list")

    def __init__(self, cols, lo, hi):
        self._cols, self._lo, self._hi, self._list = cols, lo, hi, None

    def _parts(self):
        if self._list is None:
            lo, hi = self._lo, self._hi
            self._list = list(zip(*(c[lo:hi].tolist() for c in self._cols)))
        return self._list

    def index(self):
        return self._cols[2][self._lo:self._hi].tolist()

    def __len__(self):
        return self._hi - self._lo

    def __bool__(self):
        return self._hi > self._lo

    def __iter__(self):
        return iter(self._parts())

    def __getitem__(self, j):
        return self._parts()[j]


def _all_ints(values) -> bool:
    return all(t is int for t in set(map(type, values)))


def _ints(values, n=None):
    return np.fromiter(values, dtype=np.int64, count=-1 if n is None else n)


def _small(a) -> bool:
    """All values within ``(-2**40, 2**40)``: composite keys and int64
    arithmetic on them are exact."""
    return not len(a) or (int(a.min()) > -_SHIFT and int(a.max()) < _SHIFT)


# ── Runs (per read) ─────────────────────────────────────────────────────────

class _Runs:
    """Every read's aligned runs (``_SeqRuns``), concatenated: ``ref``, ``seq``,
    ``len`` with per-read offsets; ``ok[d]`` when read ``d``'s runs are
    ascending and disjoint (the batched mol/span lookups need that)."""

    def __init__(self, runs_list):
        n = np.fromiter((len(r.ref) for r in runs_list), dtype=np.int64, count=len(runs_list))
        self.n = n
        self.off = np.zeros(len(runs_list) + 1, dtype=np.int64)
        np.cumsum(n, out=self.off[1:])
        total = int(self.off[-1])
        # Each read's runs are read once per load: its hidden insertion blocks
        # use the same runs again (``_cols``, kept on the runs object).
        cols = [getattr(r, "_cols", None) for r in runs_list]
        if all(c is not None for c in cols):
            self.ref, self.seq, self.len = ((np.concatenate([c[j] for c in cols]) if cols
                                             else np.zeros(0, dtype=np.int64)) for j in range(3))
        else:
            self.ref = read_only(_ints(chain.from_iterable(r.ref for r in runs_list), total))
            self.seq = read_only(_ints(chain.from_iterable(r.seq for r in runs_list), total))
            self.len = read_only(_ints(chain.from_iterable(r.len for r in runs_list), total))
            for r, a, b in zip(runs_list, self.off[:-1].tolist(), self.off[1:].tolist()):
                r._cols = (self.ref[a:b], self.seq[a:b], self.len[a:b])
        self.reverse = np.fromiter((bool(r.reverse) for r in runs_list), dtype=bool, count=len(runs_list))
        self.length = _ints((r.length for r in runs_list), len(runs_list))
        self.read = np.repeat(np.arange(len(runs_list), dtype=np.int64), n)
        ok = np.ones(len(runs_list), dtype=bool)
        if total:
            bad = (self.ref < 0) | (self.ref + self.len >= _SHIFT) | (self.len < 0)
            if total > 1:
                same = self.read[1:] == self.read[:-1]
                bad[1:] |= same & (self.ref[:-1] + self.len[:-1] > self.ref[1:])
            ok[self.read[bad]] = False
        self.ok = ok
        self._seqkey = self._seq_ok = None
        self.key = self.read * _SHIFT + self.ref
        # Run ends ascend within a read whose runs are ``ok``; the running
        # maximum keeps the array sorted across the others (never searched).
        self.end_key = np.maximum.accumulate(self.read * _SHIFT + self.ref + self.len) if total else self.key

    def has_aligned(self, d, m0, m1):
        """``_SeqRuns.has_aligned(m0, m1)`` for reads ``d`` (arrays):
        ``(result, exact)``; ``exact`` false where the batched search can't
        reproduce it (a read whose SEQ starts are not ascending within
        ``[0, 2**40)``)."""
        if self._seqkey is None:
            total = len(self.seq)
            ok = np.ones(len(self.n), dtype=bool)
            if total:
                bad = (self.seq < 0) | (self.seq >= _SHIFT)
                if total > 1:
                    bad[1:] |= (self.read[1:] == self.read[:-1]) & (self.seq[1:] < self.seq[:-1])
                ok[self.read[bad]] = False
            # Reads that can't be searched get a constant key: the array stays sorted.
            self._seqkey = self.read * _SHIFT + np.where(ok[self.read], self.seq, 0) if total else self.seq
            self._seq_ok = ok
        n = self.n[d]
        reverse = self.reverse[d]
        length = self.length[d]
        a = np.where(reverse, length - m1, m0)
        b = np.where(reverse, length - m0, m1)
        exact = self._seq_ok[d].copy()
        if not len(self.seq):
            return np.zeros(len(d), dtype=bool), exact
        x = np.clip(b - 1, -1, _SHIFT - 1)
        off = self.off[d]
        i = np.searchsorted(self._seqkey, d * _SHIFT + x, side="right") - 1 - off
        ii = np.clip(off + np.clip(i, 0, np.maximum(n - 1, 0)), 0, len(self.seq) - 1)
        return (n > 0) & (i >= 0) & (self.seq[ii] + self.len[ii] > a), exact

    def mol_at(self, d, x):
        """``_SeqRuns.mol_at`` for reads ``d`` at reference positions ``x`` (arrays)."""
        if not len(x):
            return np.zeros(0, dtype=np.int64)
        total = len(self.ref)
        n = self.n[d]
        if not total:
            return np.zeros(len(x), dtype=np.int64)
        off = self.off[d]
        i = np.searchsorted(self.key, d * _SHIFT + x, side="right") - 1 - off
        i = np.maximum(i, -1)
        last = np.maximum(n - 1, 0)
        ii = np.clip(off + np.clip(i, 0, last), 0, total - 1)
        inside = (i >= 0) & (x < self.ref[ii] + self.len[ii])
        nxt = np.clip(off + np.minimum(i + 1, last), 0, total - 1)
        end_i = np.clip(off + last, 0, total - 1)
        out = np.where(inside, self.seq[ii] + (x - self.ref[ii]),
                       np.where(i + 1 < n, self.seq[nxt], self.seq[end_i] + self.len[end_i]))
        out = np.where(self.reverse[d], self.length[d] - 1 - out, out)
        return np.where(n == 0, 0, out)


# ── Fragments (per row) ─────────────────────────────────────────────────────

class _Frags:
    """Every row's fragments: transform parameters, plus a search table over
    the disjoint rows (``skey``/``ekey`` sorted composite keys of starts/ends,
    with each row's offset ``soff`` into it)."""

    def __init__(self, rows):
        frags = [f for row in rows for f in row.frags]
        nf = np.fromiter((len(row.frags) for row in rows), dtype=np.int64, count=len(rows))
        n = len(frags)
        self.off = np.zeros(len(rows) + 1, dtype=np.int64)
        np.cumsum(nf, out=self.off[1:])
        self.row = np.repeat(np.arange(len(rows), dtype=np.int64), nf)
        self.s = _ints((f.s for f in frags), n)
        self.e = _ints((f.e for f in frags), n)
        self.minus = np.fromiter((f.minus for f in frags), dtype=bool, count=n)
        self.qs = _ints((f.p.q_start for f in frags), n)
        self.ts = _ints((f.p.t_start for f in frags), n)
        self.te = _ints((f.p.t_end for f in frags), n)
        self.primary = np.fromiter((bool(f.p.primary) for f in frags), dtype=bool, count=n)
        self.span = _ints((f.span for f in frags), n)
        self.t0 = _ints((f.t0 for f in frags), n)
        self.t1 = _ints((f.t1 for f in frags), n)
        # Joinable-chain start of each fragment (row-local index).
        cs = []
        for row in rows:
            start = 0
            for k in range(len(row.frags)):
                if k and not row.joinable[k - 1]:
                    start = k
                cs.append(start)
        self.chain_start = _ints(cs, n)
        disjoint = np.fromiter((bool(row.disjoint) for row in rows), dtype=bool, count=len(rows))
        if n:
            disjoint &= ~np.bincount(self.row[(self.s < 0) | (self.e >= _SHIFT)], minlength=len(rows)).astype(bool)
        self.disjoint = disjoint
        searchable = disjoint[self.row]
        self.sidx = np.flatnonzero(searchable)          # search table -> fragment index
        srow = self.row[self.sidx]
        self.skey = srow * _SHIFT + self.s[self.sidx]
        self.ekey = srow * _SHIFT + self.e[self.sidx]
        cnt = np.bincount(srow, minlength=len(rows)) if len(srow) else np.zeros(len(rows), dtype=np.int64)
        self.soff = np.zeros(len(rows) + 1, dtype=np.int64)
        np.cumsum(cnt, out=self.soff[1:])

    def find(self, r, x):
        """Row-local index of the last fragment of row ``r`` starting at or
        before ``x`` (``bisect_right(row.starts, x) - 1``), -1 when none."""
        if not len(self.skey):
            return np.full(len(x), -1, dtype=np.int64)
        k = np.searchsorted(self.skey, r * _SHIFT + x, side="right") - 1 - self.soff[r]
        return np.maximum(k, -1)

    def base_t(self, g, x):
        """``_Frag.T(x)`` for global fragment indices ``g``."""
        return np.where(self.minus[g], self.te[g] - 1 - (x - self.qs[g]), self.ts[g] + (x - self.qs[g]))


# ── Interval groups ─────────────────────────────────────────────────────────


class _Unit:
    """One interval group of one read (``intervals``, ``fire``, ``layer:<name>``):
    ``start`` is its offset in the window's unit tables; ``ids``/``has``/``first``
    per interval (output call id, whether it has a call, the source start of
    its call's first interval as ``_call_starts`` finds it)."""
    __slots__ = ("name", "ivs", "calls", "ok", "ids", "has", "first", "start", "arr")

    def __init__(self, name, ivs, calls):
        self.name, self.ivs, self.calls = name, ivs or [], calls
        self.ok, self.ids, self.has, self.first, self.start = True, None, None, None, 0
        self.arr = None  # the intervals as an (n, 3) int64 array, once read


def _cached(ctx, name, read, make):
    """``make(read)``, kept on ``ctx`` for the rest of the load: the hidden
    insertion blocks are composed from the same reads again, and need not
    read their lists, nor work out their call identity, a second time."""
    cache = ctx.__dict__.setdefault(name, {})
    hit = cache.get(id(read))
    if hit is not None and hit[0] is read:
        return hit[1], False
    value = make(read)
    cache[id(read)] = (read, value)
    return value, True


def _read_units(read):
    calls = read.get("_fiberbrowser_calls") or {}
    units = [_Unit("intervals", read.get("intervals"), calls.get("intervals"))]
    if read.get("fire") is not None:
        units.append(_Unit("fire", read["fire"], calls.get("fire")))
    for name, layer in (read.get("layers") or {}).items():
        if isinstance(layer, dict):
            units.append(_Unit(f"layer:{name}", layer.get("intervals"), layer.get("_fiberbrowser_calls")))
    return units


def _unit_identity(unit):
    """``ids``, ``has`` and ``first`` of a unit whose group has calls
    (``first`` None: each interval's own start)."""
    calls, ivs = unit.calls, unit.ivs
    n = len(ivs)
    head = calls[:n] if len(calls) > n else calls
    if all(head):
        ids = list(map(_first, head))
        has = None
        dup = len(set(ids)) != len(ids)
    else:
        has = list(map(bool, head))
        ids = [c[0] if c else None for c in head]
        with_call = [cid for cid, h in zip(ids, has) if h]
        dup = len(set(with_call)) != len(with_call)
    if len(head) < n:
        if has is None:
            has = [True] * len(head)
        has += [False] * (n - len(head))
        ids += [None] * (n - len(head))
    first = None
    if dup:  # a call the decoder cut into pieces: its lowest start
        flags = has if has is not None else [True] * n
        starts = list(map(_first, ivs))
        lo = {}
        for cid, h, s in zip(ids, flags, starts):
            if h:
                v = lo.get(cid)
                if v is None or s < v:
                    lo[cid] = s
        first = [lo[cid] if h else s for cid, h, s in zip(ids, flags, starts)]
    unit.ids, unit.has, unit.first = ids, has, first


def _part_order(seg, c0, c1, i, k, width):
    """Order of parts by ``(segment, c0, c1, i, k)`` (``_map_group``'s sort per
    group): one stable sort by ``(segment, c0)`` (nearly sorted already), then
    the few ties by the full key."""
    if not len(seg):
        return np.zeros(0, dtype=np.int64)
    if width >= (1 << 31) or int(seg.max()) >= (1 << 31) or int(c0.min()) < 0:
        return np.lexsort((k, i, c1, c0, seg))
    major = (seg << 32) | c0
    order = np.argsort(major, kind="stable")
    m = major[order]
    tie = m[1:] == m[:-1]
    if tie.any():
        member = np.zeros(len(m), dtype=bool)
        member[1:] |= tie
        member[:-1] |= tie
        at = np.flatnonzero(member)
        sub = order[at]
        order[at] = sub[np.lexsort((k[sub], i[sub], c1[sub], major[sub]))]
    return order


def _expand(ei, r, a, b, k0, n, soff, F, RS0, WID, E_seg, E_i):
    """Parts ``(segment, c0, c1, i, k)`` of intervals ``ei`` (``[a, b)`` on
    row ``r``) through fragments ``k0 .. k0 + n - 1``, clipped (row.parts)."""
    rep = np.repeat(np.arange(len(ei), dtype=np.int64), n)
    first_rep = np.zeros(len(ei) + 1, dtype=np.int64)
    np.cumsum(n, out=first_rep[1:])
    kl = k0[rep] + (np.arange(len(rep), dtype=np.int64) - first_rep[rep])
    g = F.sidx[soff[rep] + kl]
    a2 = np.maximum(a[rep], F.s[g])
    b2 = np.minimum(b[rep], F.e[g])
    minus = F.minus[g]
    t0 = np.where(minus, F.te[g] - (b2 - F.qs[g]), F.ts[g] + (a2 - F.qs[g]))
    t1 = np.where(minus, F.te[g] - (a2 - F.qs[g]), F.ts[g] + (b2 - F.qs[g]))
    rr = r[rep]
    c0 = np.maximum(t0 - RS0[rr], 0)
    c1 = np.minimum(t1 - RS0[rr], WID[rr])
    keep = np.flatnonzero(c1 > c0)
    src = ei[rep[keep]]
    return E_seg[src], c0[keep], c1[keep], E_i[src], kl[keep]


def _map_units(items, rows, row_read, F, R, base, ctx, rest_parts, small):
    """``groups`` of every disjoint row: ``_map_group`` + ``_call_identity``."""
    RS0, WID = F.row_rs0, F.row_width
    units_by_read, fresh = [], []
    for it in items:
        units, new = _cached(ctx, "_column_units", it[0], _read_units)
        units_by_read.append(units)
        if new:
            fresh += units
    flat = [u for units in units_by_read for u in units]
    every = list(chain.from_iterable(u.ivs for u in fresh))
    if every and not (set(map(len, every)) == {3} and _all_ints(chain.from_iterable(every))):
        for u in fresh:
            u.ok = not u.ivs or (set(map(len, u.ivs)) == {3} and _all_ints(chain.from_iterable(u.ivs)))
    live = [u for u in flat if u.ok and u.ivs]
    total = 0
    for u in live:
        u.start = total
        total += len(u.ivs)
    unread = [u for u in live if u.arr is None]
    try:
        values = read_only(_ints(chain.from_iterable(chain.from_iterable(u.ivs for u in unread)),
                                 3 * sum(len(u.ivs) for u in unread)).reshape(-1, 3))
    except OverflowError:  # beyond int64: the per-row path
        return
    at = 0
    for u in unread:
        u.arr = values[at:at + len(u.ivs)]
        at += len(u.ivs)
    vals = (values if len(unread) == len(live) else
            np.concatenate([u.arr for u in live]) if live else np.zeros((0, 3), dtype=np.int64))
    UA, UB, USZ = vals[:, 0], vals[:, 1], vals[:, 2]
    if not (_small(UA) and _small(UB)):
        return
    # A small group (Python path in _map_group) with an empty interval of
    # non-negative size fails there (span_of gives None): keep that behaviour.
    empty = np.flatnonzero((UB <= UA) & (USZ >= 0))
    if len(empty):
        starts = np.fromiter((u.start for u in live), dtype=np.int64, count=len(live))
        for j in np.unique(np.searchsorted(starts, empty, side="right") - 1).tolist():
            if len(live[j].ivs) <= small:
                live[j].ok = False
    UHAS = np.zeros(total, dtype=bool)
    UFIRST = UA.copy()
    UIDS = []
    for u in live:
        n = len(u.ivs)
        if not u.calls:
            UIDS += [None] * n
            continue
        if u.ids is None:
            _unit_identity(u)
        UIDS += u.ids
        if u.has is None:
            UHAS[u.start:u.start + n] = True
        else:
            UHAS[u.start:u.start + n] = u.has
        if u.first is not None:
            UFIRST[u.start:u.start + n] = u.first

    # Segments: (row, unit) of disjoint rows; ``segs`` holds the non-empty ones.
    targets, segs = [], []
    for r, row in enumerate(rows):
        if not F.disjoint[r]:
            continue
        for u in units_by_read[row_read[r]]:
            if u.ok:
                targets.append((row, u))
                if u.ivs:
                    segs.append((r, row, u))
    nseg = len(segs)
    seg_row = _ints((s[0] for s in segs), nseg)
    seg_read = _ints((row_read[s[0]] for s in segs), nseg)
    seg_ustart = _ints((s[2].start for s in segs), nseg)
    seg_len = _ints((len(s[2].ivs) for s in segs), nseg)
    seg_calls = np.fromiter((s[2].calls is not None for s in segs), dtype=bool, count=nseg)
    seg_off = np.zeros(nseg + 1, dtype=np.int64)
    np.cumsum(seg_len, out=seg_off[1:])
    E_seg = np.repeat(np.arange(nseg, dtype=np.int64), seg_len)
    E_i = np.arange(len(E_seg), dtype=np.int64) - seg_off[E_seg]
    E_u = seg_ustart[E_seg] + E_i
    E_r = seg_row[E_seg]
    E_d = seg_read[E_seg]
    A = base[E_d] + UA[E_u]
    B = base[E_d] + UB[E_u]
    if len(A) and max(int(A.max()), int(B.max())) >= _SHIFT:
        return  # composite keys need positions below 2**40: the per-row path
    todo = USZ[E_u] >= 0
    # Width-1 intervals of a group with calls may be insertion-only markers
    # (a call with no aligned base: rest_parts makes a zero-width marker).
    # Whether a call has an aligned base is looked up for all of them at once;
    # the markers, and calls of any unusual form, go one by one exactly as
    # _map_group does (rest_parts); the others are ordinary intervals.
    slow = todo & (B - A == 1) & seg_calls[E_seg]
    marker, by_hand, mol0 = _insertion_only(np.flatnonzero(slow), E_seg, E_i, E_d, segs, R)
    extra = []
    for e in np.flatnonzero(marker | by_hand).tolist():
        s = int(E_seg[e])
        r, row, u = segs[s]
        d = row_read[r]
        for part in rest_parts(int(E_i[e]), u.ivs, u.calls, row, int(base[d]), items[d][2], F.rs0[r], F.width[r]):
            extra.append((s, *part))
    # Every other interval: one part per fragment it overlaps (row.parts;
    # nearly always the one fragment holding it whole).
    ei = np.flatnonzero(todo & ~(marker | by_hand))
    r, a, b = E_r[ei], A[ei], B[ei]
    k = F.find(r, a)
    soff = F.soff[r]
    last = max(len(F.sidx) - 1, 0)
    k0 = np.where((k >= 0) & (F.e[F.sidx[np.clip(soff + np.maximum(k, 0), 0, last)]] > a), k, k + 1)
    k1 = np.searchsorted(F.skey, r * _SHIFT + b, side="left") - 1 - soff
    n = np.maximum(k1 - k0 + 1, 0)
    # (interval, fragment) candidates, a slice of intervals at a time so that
    # intervals crossing many fragments never expand past the batch budget.
    cut = np.cumsum(n)
    pieces, lo = [], 0
    while lo < len(ei):
        hi = int(np.searchsorted(cut, (cut[lo - 1] if lo else 0) + CHUNK_ELEMENTS, side="right"))
        hi = max(hi, lo + 1)
        pieces.append(_expand(ei[lo:hi], r[lo:hi], a[lo:hi], b[lo:hi], k0[lo:hi], n[lo:hi], soff[lo:hi], F,
                              RS0, WID, E_seg, E_i))
        lo = hi
    cols = ([np.concatenate([p[j] for p in pieces]) for j in range(5)] if pieces
            else [np.zeros(0, dtype=np.int64) for _ in range(5)])
    if extra:
        ex = np.asarray(extra, dtype=np.int64).reshape(-1, 5)
        cols = [np.concatenate([c, ex[:, j]]) for j, c in enumerate(cols)]
    order = _part_order(*cols, F.max_width)
    P_seg, P_c0, P_c1, P_i, P_k = (c[order] for c in cols)

    # Call identity: part = first source base of the part; group = first part
    # of its rejoin group (row.group_start, closed form on disjoint rows).
    P_u = seg_ustart[P_seg] + P_i
    P_r = seg_row[P_seg]
    P_d = seg_read[P_seg]
    fg = F.off[P_r] + P_k
    a_src = base[P_d] + UA[P_u]
    part_src = np.maximum(a_src, F.s[fg])
    first = base[P_d] + UFIRST[P_u]
    # A part whose call starts inside its own fragment is its group's first
    # part (no earlier fragment ends after that start): only the others search.
    group_src = part_src.copy()
    walk = np.flatnonzero((first != a_src) | (a_src < F.s[fg]))
    if len(walk) and len(F.ekey):
        wr, wk, wf = P_r[walk], P_k[walk], first[walk]
        n_le = np.searchsorted(F.ekey, wr * _SHIFT + wf, side="right") - F.soff[wr]
        gk = np.minimum(wk, np.maximum(F.chain_start[fg[walk]], n_le))
        group_src[walk] = np.maximum(wf, F.s[F.off[wr] + gk])
    mp = R.mol_at(P_d, part_src)
    mg = mp.copy()
    other = np.flatnonzero(group_src != part_src)
    if len(other):
        mg[other] = R.mol_at(P_d[other], group_src[other])
    keys = np.stack([mp, mg], axis=1).tolist()
    has = UHAS[P_u]
    for j in np.flatnonzero(~has).tolist():
        keys[j] = None
    # Width-1 parts with a call (all among the candidates above): a marker's
    # key is its own molecular start; unusual calls are checked one by one.
    w1 = np.flatnonzero(has & (UB[P_u] - UA[P_u] == 1))
    if len(w1):
        e_of = seg_off[P_seg[w1]] + P_i[w1]
        for j, e in zip(w1[marker[e_of]].tolist(), e_of[marker[e_of]].tolist()):
            keys[j] = [mol0[e], mol0[e]]  # insertion-only: its own molecular start
        for j in w1[by_hand[e_of]].tolist():
            u = segs[int(P_seg[j])][2]
            call = u.calls[int(P_i[j])]
            if not items[int(P_d[j])][2].has_aligned(int(call[1]), int(call[2])):
                keys[j] = [int(call[1]), int(call[1])]
    ids = list(map(UIDS.__getitem__, P_u.tolist()))
    # Mapped intervals stay one window array; each group gets a read-only
    # copy of its slice (``read_columns.owned``, read row format 2), never Python lists.
    mapped = read_only(np.stack([P_c0, P_c1, USZ[P_u]], axis=1))
    cols = (P_c0, P_c1, P_i, P_k)
    bounds = np.searchsorted(P_seg, np.arange(nseg + 1, dtype=np.int64)).tolist()
    _top_level(items, rows, row_read, segs, F, USZ, seg_ustart, P_seg, P_c0, P_c1, P_i, fg, bounds, ctx, mapped)
    s = 0
    for row, u in targets:
        if not u.ivs:
            row._pre.groups[u.name] = ([], [], [], [])
            continue
        lo, hi = bounds[s], bounds[s + 1]
        s += 1
        if u.calls:
            row._pre.groups[u.name] = (LazyParts(cols, lo, hi), owned(mapped[lo:hi]), ids[lo:hi], keys[lo:hi])
        else:  # no calls: no identity (_call_identity)
            row._pre.groups[u.name] = (LazyParts(cols, lo, hi), owned(mapped[lo:hi]), [None] * (hi - lo),
                                       [None] * (hi - lo))
    for r, row, u in segs:
        top = row._pre.intervals
        if u.name == "intervals" and top is not None:  # the top-level intervals in display order (_top_level)
            shown, order, ranks = top
            group = row._pre.groups["intervals"]
            extra = [None] * (len(order) - len(group[2]))
            quals = items[row_read[r]][0].get("qualities") or []
            row._pre.intervals = (shown,
                                  list(map((group[2] + extra).__getitem__, order)),
                                  list(map((group[3] + extra).__getitem__, order)),
                                  list(map(quals.__getitem__, ranks)) if quals else None)


def _insertion_only(cand, E_seg, E_i, E_d, segs, R):
    """For the width-1 intervals ``cand`` (element indices) of groups with
    calls: ``(marker, by_hand, mol0)`` over all elements. ``marker``: a plain
    ``[id, m0, m1]`` call with no aligned base in ``[m0, m1)``
    (``_SeqRuns.has_aligned`` false), ``mol0[e]`` its ``m0``; ``by_hand``: a
    call of another form, or one the batched lookup can't answer exactly.
    Candidates without a call (None) are neither: ordinary intervals."""
    n = len(E_seg)
    marker = np.zeros(n, dtype=bool)
    by_hand = np.zeros(n, dtype=bool)
    mol0 = {}
    if not len(cand):
        return marker, by_hand, mol0
    plain, m0s, m1s = [], [], []
    for e, s, i in zip(cand.tolist(), E_seg[cand].tolist(), E_i[cand].tolist()):
        calls = segs[s][2].calls
        call = calls[i] if i < len(calls) else None
        if call is None:
            continue
        if (type(call) is list and len(call) >= 3 and type(call[1]) is int and type(call[2]) is int
                and -_SHIFT < call[1] < _SHIFT and -_SHIFT < call[2] < _SHIFT):
            plain.append(e)
            m0s.append(call[1])
            m1s.append(call[2])
        else:
            by_hand[e] = True
    if plain:
        e = np.asarray(plain, dtype=np.int64)
        m0 = np.asarray(m0s, dtype=np.int64)
        aligned, exact = R.has_aligned(E_d[e], m0, np.asarray(m1s, dtype=np.int64))
        by_hand[e[~exact]] = True
        hit = exact & ~aligned
        marker[e[hit]] = True
        mol0.update(zip(e[hit].tolist(), m0[hit].tolist()))
    return marker, by_hand, mol0


def _top_level(items, rows, row_read, segs, F, USZ, seg_ustart, P_seg, P_c0, P_c1, P_i, fg, bounds, ctx, mapped):
    """The top-level intervals of each row as ``_row_payload`` lays them out:
    footprint parts plus the gaps between whole calls inside each span
    (``_logical`` + ``_gaps``), sorted by ``(start, end, index)``, with their
    qualities. Only rows whose read has no ``sv`` (no deletion cuts) and whose
    calls each map to one part per span (so each logical call is one part);
    ``row._pre.intervals`` is left None for the others. Sets it to
    ``(intervals, order, quality ranks)``: the intervals (``IntColumn``, a
    slice of one window array of parts and gaps in display order) and the
    index of each in ``mapped`` + gaps, from which ``_map_units`` orders the
    call lists."""
    RS0, WID, hide = F.row_rs0, F.row_width, ctx.hide_terminal_gaps
    nseg = len(segs)
    if not nseg or F.max_width >= (1 << 31):
        return
    ok = np.fromiter((u.name == "intervals" and "sv" not in items[row_read[r]][0] and u.first is None
                      for r, _row, u in segs), dtype=bool, count=nseg)
    if not ok.any():
        return
    # Spans: every (row, span id) of the rows, with their target bounds.
    nf = len(F.s)
    if not nf:
        return
    new_span = np.ones(nf, dtype=bool)
    new_span[1:] = (F.row[1:] != F.row[:-1]) | (F.span[1:] != F.span[:-1])
    st_first = np.flatnonzero(new_span)
    st_row = F.row[st_first]
    st_b0 = np.minimum.reduceat(F.t0, st_first) - RS0[st_row]
    st_b1 = np.maximum.reduceat(F.t1, st_first) - RS0[st_row]
    row_st = np.searchsorted(st_row, np.arange(len(rows) + 1, dtype=np.int64))   # first span entry of each row
    if int(F.span.max()) >= (1 << 20) or len(st_first) >= (1 << 30):
        return
    seg_row = np.fromiter((r for r, _row, _u in segs), dtype=np.int64, count=nseg)
    # Positive parts of the eligible segments; an interval with two parts in one span disqualifies its row.
    psz = USZ[seg_ustart[P_seg] + P_i]
    pos = np.flatnonzero(ok[P_seg] & (psz > 0))
    sti = row_st[seg_row[P_seg[pos]]] + F.span[fg[pos]]
    if len(pos) > 1:
        o = np.lexsort((sti, P_i[pos], P_seg[pos]))
        a_seg, a_i, a_st = P_seg[pos][o], P_i[pos][o], sti[o]
        same = (a_seg[1:] == a_seg[:-1]) & (a_i[1:] == a_i[:-1]) & (a_st[1:] == a_st[:-1])
        if same.any():
            ok[a_seg[1:][same]] = False
            keep = ok[P_seg[pos]]
            pos, sti = pos[keep], sti[keep]
    c0, c1 = P_c0[pos], P_c1[pos]
    o = np.argsort((sti << 32) | c0, kind="stable")
    sti, c0, c1 = sti[o], c0[o], c1[o]
    run = np.maximum.accumulate((sti << 32) | c1) & 0xFFFFFFFF if len(sti) else sti
    first = np.ones(len(sti), dtype=bool)
    first[1:] = sti[1:] != sti[:-1]
    prev = np.empty_like(run)
    prev[1:] = run[:-1]
    inner = ~first & (c0 > prev)
    g_st, g0, g1 = [sti[inner]], [prev[inner]], [c0[inner]]
    if not hide:
        # Leading gap of each span with calls, trailing gap after its last call,
        # and the whole span when it has none (eligible rows only).
        g_st.append(sti[first])
        g0.append(st_b0[sti[first]])
        g1.append(c0[first])
        last = np.ones(len(sti), dtype=bool)
        last[:-1] = sti[1:] != sti[:-1]
        g_st.append(sti[last])
        g0.append(run[last])
        g1.append(st_b1[sti[last]])
        row_ok = np.zeros(len(rows), dtype=bool)
        row_ok[seg_row[ok]] = True
        empty = row_ok[st_row]
        empty[sti] = False
        e = np.flatnonzero(empty)
        g_st.append(e)
        g0.append(st_b0[e])
        g1.append(st_b1[e])
    g_st, g0, g1 = np.concatenate(g_st), np.concatenate(g0), np.concatenate(g1)
    real = g1 > g0
    g_st, g0, g1 = g_st[real], g0[real], g1[real]
    size = -(g1 - g0)
    k0, k1 = np.maximum(g0, 0), np.minimum(g1, WID[st_row[g_st]])
    vis = k1 > k0
    g_st, k0, k1, size = g_st[vis], k0[vis], k1[vis], size[vis]
    o = np.argsort((g_st << 32) | k0, kind="stable")
    g_st, k0, k1, size = g_st[o], k0[o], k1[o], size[o]
    # Gap -> segment (each eligible row has one "intervals" segment).
    seg_of_row = np.full(len(rows), -1, dtype=np.int64)
    seg_of_row[seg_row[ok]] = np.flatnonzero(ok)
    g_seg = seg_of_row[st_row[g_st]]
    gaps = np.stack([k0, k1, size], axis=1)
    gb = np.searchsorted(g_seg, np.arange(nseg + 1, dtype=np.int64)).tolist()
    # Display order of parts + gaps per segment: (start, end, index), gaps after parts.
    pb = np.asarray(bounds, dtype=np.int64)
    n_p = pb[1:] - pb[:-1]
    sel = np.flatnonzero(ok[P_seg])
    e_seg = np.concatenate([P_seg[sel], g_seg])
    e_c0 = np.concatenate([P_c0[sel], k0])
    e_c1 = np.concatenate([P_c1[sel], k1])
    gfirst = np.asarray(gb[:-1], dtype=np.int64)
    e_j = np.concatenate([sel - pb[P_seg[sel]], n_p[g_seg] + (np.arange(len(g_seg), dtype=np.int64) - gfirst[g_seg])])
    if len(e_j) and int(e_j.max()) >= (1 << 24):
        return
    o1 = np.argsort((e_c1 << 24) | e_j, kind="stable")
    o2 = o1[np.argsort(((e_seg << 32) | e_c0)[o1], kind="stable")]
    e_seg, e_j = e_seg[o2], e_j[o2]
    eb = np.searchsorted(e_seg, np.arange(nseg + 1, dtype=np.int64)).tolist()
    order_all = e_j.tolist()
    # Quality ranks: footprints (size > 0) are numbered in decode order.
    is_part = e_j < n_p[e_seg]
    pi = (np.where(is_part, P_i[np.clip(pb[e_seg] + np.minimum(e_j, np.maximum(n_p[e_seg] - 1, 0)), 0, len(P_i) - 1)], 0)
          if len(P_i) else np.zeros(len(e_j), dtype=np.int64))
    ustart = seg_ustart[e_seg]
    positive = USZ > 0
    urank = np.cumsum(positive) - 1
    u_first_rank = urank[seg_ustart] + 1 - positive[seg_ustart].astype(np.int64)  # footprints before each unit
    rk = urank[ustart + pi] - u_first_rank[e_seg]
    nq = np.fromiter((len(items[row_read[r]][0].get("qualities") or ()) for r, _row, _u in segs),
                     dtype=np.int64, count=nseg)
    qual_ok = is_part & positive[ustart + pi] & (rk < nq[e_seg])
    # Each row's ranks: the qualifying entries of its slice, in order.
    qual_ok &= rk >= 0
    rk_l = rk[qual_ok].tolist()
    qb = np.cumsum(qual_ok)
    qb = np.concatenate([[0], qb]).tolist()
    # The displayed intervals of every eligible row, in order, in one array.
    shown = np.empty((len(e_j), 3), dtype=np.int64)
    at = np.flatnonzero(is_part)
    shown[at] = mapped[pb[e_seg[at]] + e_j[at]]
    at = np.flatnonzero(~is_part)
    shown[at] = gaps[gfirst[e_seg[at]] + (e_j[at] - n_p[e_seg[at]])]
    read_only(shown)
    for j in np.flatnonzero(ok).tolist():
        row = segs[j][1]
        a, b = eb[j], eb[j + 1]
        row._pre.intervals = (owned(shown[a:b]), order_all[a:b], rk_l[qb[a]:qb[b]])


# ── Point marks ─────────────────────────────────────────────────────────────

def _map_point_fields(items, rows, row_read, F, base, ctx, fields, small):
    """``points`` of every disjoint row: ``_map_points`` for plain position lists.
    Lists longer than ``small`` go through NumPy there too (int64 conversion);
    shorter ones are mapped in Python, so they must hold Python ints."""
    RS0, WID = F.row_rs0, F.row_width
    # Each list is read into an array once per load (_cached): a read's rows,
    # and its hidden insertion blocks, share it. ``store[key]``: the array, or
    # False for a short list that is not all ints (the per-row path).
    targets, segs, arrays, unread = [], [], [], []
    for r, row in enumerate(rows):
        if not F.disjoint[r]:
            continue
        read = items[row_read[r]][0]
        store = _cached(ctx, "_column_points", read, _new_store)[0]
        for key in fields:
            if key not in read:
                continue
            values = read[key]
            if not isinstance(values, list):
                continue
            if not values:
                row._pre.points[key] = ([], 0)
                continue
            if key not in store:
                if len(values) <= small and not _all_ints(values):
                    store[key] = False
                    continue
                store[key] = None
                unread.append((store, key, values))
            elif store[key] is False:
                continue
            targets.append((row, key))
            segs.append((r, len(values)))
            arrays.append((store, key))
    if unread:
        try:
            got = read_only(_ints(chain.from_iterable(v for _s, _k, v in unread),
                                  sum(len(v) for _s, _k, v in unread)))
        except OverflowError:  # beyond int64: the per-row path
            for store, key, _v in unread:
                del store[key]
            return
        at = 0
        for store, key, values in unread:
            store[key] = got[at:at + len(values)]
            at += len(values)
    if not segs or F.max_width >= (1 << 31):
        return
    nseg = len(segs)
    seg_row = _ints((s[0] for s in segs), nseg)
    seg_len = _ints((s[1] for s in segs), nseg)
    E_seg = np.repeat(np.arange(nseg, dtype=np.int64), seg_len)
    x = np.concatenate([store[key] for store, key in arrays])
    if not _small(x):
        return
    x += base[_ints((row_read[s[0]] for s in segs), nseg)][E_seg]
    if not _small(x):  # absolute positions too: composite keys need them below 2**40
        return
    xkey = (E_seg << 40) | x if nseg < (1 << 23) and int(x.min()) >= 0 else None
    if xkey is not None and bool((xkey[1:] >= xkey[:-1]).all()):
        # Marks ascend within each list (as decoded): find each fragment's
        # range of marks instead of each mark's fragment.
        nfr = F.soff[seg_row + 1] - F.soff[seg_row]
        f_seg = np.repeat(np.arange(nseg, dtype=np.int64), nfr)
        f_first = np.zeros(nseg + 1, dtype=np.int64)
        np.cumsum(nfr, out=f_first[1:])
        g = F.sidx[F.soff[seg_row][f_seg] + (np.arange(len(f_seg), dtype=np.int64) - f_first[f_seg])]
        lo = np.searchsorted(xkey, (f_seg << 40) | F.s[g], side="left")
        cnt = np.searchsorted(xkey, (f_seg << 40) | F.e[g], side="left") - lo
        dropped = (seg_len - np.bincount(f_seg, weights=cnt, minlength=nseg).astype(np.int64)).tolist()
        rep = np.repeat(np.arange(len(g), dtype=np.int64), cnt)
        starts = np.zeros(len(g) + 1, dtype=np.int64)
        np.cumsum(cnt, out=starts[1:])
        pidx = lo[rep] + (np.arange(len(rep), dtype=np.int64) - starts[rep])
        pseg = f_seg[rep]
        prow = seg_row[pseg]
        rel = F.base_t(g[rep], x[pidx]) - RS0[prow]
        keep = (rel >= 0) & (rel < WID[prow])
        packed = np.sort((pseg[keep] << 32) | rel[keep])
    else:
        E_r = seg_row[E_seg]
        k = F.find(E_r, x)
        kg = F.sidx[np.clip(F.soff[E_r] + np.maximum(k, 0), 0, max(len(F.sidx) - 1, 0))]
        hit = (k >= 0) & (x < F.e[kg])
        dropped = np.bincount(E_seg[~hit], minlength=nseg).tolist()
        rel = F.base_t(kg, x) - RS0[E_r]
        keep = hit & (rel >= 0) & (rel < WID[E_r])
        packed = np.sort((E_seg[keep] << 32) | rel[keep])
    marks = read_only(packed & 0xFFFFFFFF)
    bounds = np.searchsorted(packed, np.arange(nseg + 1, dtype=np.int64) << 32).tolist()
    for s, (row, key) in enumerate(targets):
        row._pre.points[key] = (owned(marks[bounds[s]:bounds[s + 1]]), dropped[s])


def _new_store(_read):
    return {}


# ── Molecular spans ─────────────────────────────────────────────────────────

def _molecular_spans(rows, row_read, F, R):
    """``molecular_spans`` of every row whose read's runs are ascending and
    disjoint, already clipped to ``[0, width]``."""
    if not len(F.s) or not len(R.ref):
        for r, row in enumerate(rows):
            if R.ok[row_read[r]]:
                row._pre.molecular_spans = []
        return
    d = np.asarray(row_read, dtype=np.int64)[F.row]
    row_ok = R.ok[np.asarray(row_read, dtype=np.int64)]
    row_ok &= ~np.bincount(F.row[(F.s < 0) | (F.e >= _SHIFT)], minlength=len(rows)).astype(bool)
    lo = np.searchsorted(R.end_key, d * _SHIFT + F.s, side="right")
    hi = np.searchsorted(R.key, d * _SHIFT + F.e, side="left")
    cnt = np.maximum(hi - lo, 0)
    cnt[~row_ok[F.row]] = 0
    fidx = np.repeat(np.arange(len(F.s), dtype=np.int64), cnt)
    starts = np.zeros(len(cnt) + 1, dtype=np.int64)
    np.cumsum(cnt, out=starts[1:])
    j = lo[fidx] + (np.arange(len(fidx), dtype=np.int64) - starts[fidx])
    ref, ln = R.ref[j], R.len[j]
    a = np.maximum(F.s[fidx], ref)
    b = np.minimum(F.e[fidx], ref + ln)
    ok = b > a
    fidx, j, a, b = fidx[ok], j[ok], a[ok], b[ok]
    minus = F.minus[fidx]
    origin = F.row_rs0[F.row[fidx]]
    t0 = np.where(minus, F.base_t(fidx, b - 1), F.base_t(fidx, a)) - origin
    t1 = np.where(minus, F.base_t(fidx, a), F.base_t(fidx, b - 1)) + 1 - origin
    x = np.where(minus, b - 1, a)
    m0 = R.seq[j] + (x - R.ref[j])
    rd = d[fidx]
    rev = R.reverse[rd]
    m0 = np.where(rev, R.length[rd] - 1 - m0, m0)
    step = np.where(rev, -1, 1) * np.where(minus, -1, 1)
    prim = F.primary[fidx]
    rr = F.row[fidx]
    order = np.lexsort((prim, step, m0, t1, t0, rr))
    rr, t0, t1, m0, step, prim = rr[order], t0[order], t1[order], m0[order], step[order], prim[order]
    # Clipped to the region as reads.clip_geometry(.., 0, width) does (order kept).
    width = F.row_width[rr]
    vis = (t1 > 0) & (t0 < width)
    rr, t0, t1, m0, step, prim, width = rr[vis], t0[vis], t1[vis], m0[vis], step[vis], prim[vis], width[vis]
    a = np.maximum(t0, 0)
    spans = list(map(list, zip(a.tolist(), np.minimum(t1, width).tolist(), (m0 + (a - t0) * step).tolist(),
                               step.tolist(), prim.tolist())))
    bounds = np.searchsorted(rr, np.arange(len(rows) + 1, dtype=np.int64)).tolist()
    for r, row in enumerate(rows):
        if row_ok[r]:
            row._pre.molecular_spans = spans[bounds[r]:bounds[r + 1]]


# ── Entry point ─────────────────────────────────────────────────────────────

def precompute(items, ctx, *, point_fields, rest_parts, small_group, regions=None):
    """Attach ``row._pre`` (a ``RowColumns``) to every row of ``items``
    (``[(read, rows, runs), ...]``, one per read with rows). Rows are relative
    to and clipped to ``ctx``'s region, or to ``regions[d] = (start, width)``
    of item ``d`` (the hidden insertion blocks, each its own frame). Runs in
    batches of about ``CHUNK_ELEMENTS`` intervals and marks; checks for
    cancellation before each."""
    from services.background_work import checkpoint

    lo = 0
    while lo < len(items):
        hi, load = lo, 0
        while hi < len(items) and (hi == lo or load < CHUNK_ELEMENTS):
            load += _load(items[hi][0], point_fields) * len(items[hi][1])
            hi += 1
        checkpoint()
        _precompute(items[lo:hi], ctx, point_fields, rest_parts, small_group,
                    regions[lo:hi] if regions is not None else None)
        lo = hi


def _load(read, point_fields):
    n = len(read.get("intervals") or ()) + len(read.get("fire") or ())
    for layer in (read.get("layers") or {}).values():
        if isinstance(layer, dict):
            n += len(layer.get("intervals") or ())
    for key in point_fields:
        values = read.get(key)
        if isinstance(values, list):
            n += len(values)
    return n


def _precompute(items, ctx, point_fields, rest_parts, small_group, regions):
    rows, row_read = [], []
    for d, (_read, read_rows, _runs) in enumerate(items):
        for row in read_rows:
            row._pre = RowColumns()
            rows.append(row)
            row_read.append(d)
    if not rows:
        return
    if regions is None:
        rs0, width = [ctx.region_start] * len(rows), [ctx.width] * len(rows)
    else:
        rs0, width = [regions[d][0] for d in row_read], [regions[d][1] for d in row_read]
    try:
        R = _Runs([it[2] for it in items])
        F = _Frags(rows)
        base = _ints((int(it[0]["_fiberbrowser_source_base"]) for it in items), len(items))
        F.row_rs0, F.row_width = _ints(rs0, len(rows)), _ints(width, len(rows))
    except OverflowError:  # beyond int64: every row takes the per-row path
        return
    if len(R.ref) and (int(R.ref.min()) < 0 or max(int(R.ref.max()), int((R.ref + R.len).max())) >= _SHIFT):
        return  # composite keys need [0, 2**40): all rows take the per-row path
    if not all(_small(a) for a in (R.seq, R.len, R.length, F.s, F.e, F.qs, F.ts, F.te, F.t0, F.t1, base,
                                    F.row_rs0, F.row_width)):
        return
    F.rs0, F.width = rs0, width
    F.max_width = max(width)
    _molecular_spans(rows, row_read, F, R)
    _map_units(items, rows, row_read, F, R, base, ctx, rest_parts, small_group)
    _map_point_fields(items, rows, row_read, F, base, ctx, point_fields, small_group)
