"""Consensus of an insertion's inserted sequences, and each read's map onto it.

Star consensus: the insert of median length is the backbone; up to
``max_reads`` inserts are aligned to it (banded global alignment, edit-distance
scoring), each backbone column takes the majority base (or is dropped when
most reads skip it), and an insertion after a column is kept when most reads
carry one. Two rounds (the second against the first consensus) polish it.
Every carrier's insert is then aligned to the consensus once more, giving its
identity and sparse "knots" ``[read_pos, consensus_pos]`` that the lens uses
to draw that read in consensus coordinates.

The banded alignment runs under numba (a core dependency); without numba the
same function runs as plain Python, which is slow but correct.

DAF data (DddA/DddB) needs more than a majority: an open C deaminated in most
molecules reads T on most C->T reads, and a majority calls it T. FiberHMM 3.0's
``fiberhmm.daf.insert_consensus`` calls each column by its variability per
strand (a column that is sometimes C, sometimes T on C->T reads is a C; G/A
likewise on G->A reads), the consensus fiberhmm-call itself calls recurrent
insertions against. The lens uses it for DAF datasets when the FiberHMM the
Browser runs has it (``daf_aware_consensus``), and the majority vote otherwise
(Fiber-seq m6A data, or an older FiberHMM).
"""

from __future__ import annotations

from collections import Counter
from typing import Optional

import numpy as np

try:  # numba is a core dependency; the fallback only keeps imports working.
    from numba import njit as _njit
except Exception:  # pragma: no cover - exercised only without numba
    def _njit(*args, **kwargs):
        if args and callable(args[0]):
            return args[0]
        return lambda fn: fn

_ENCODE = np.full(256, 4, dtype=np.uint8)
for _code, _base in enumerate("ACGT"):
    _ENCODE[ord(_base)] = _code
    _ENCODE[ord(_base.lower())] = _code
_DECODE = np.array(list("ACGTN"))

OP_MATCH, OP_INS, OP_DEL = 0, 1, 2  # INS: base only in b; DEL: base only in a
_NEG = -(1 << 28)


def encode(seq: str) -> np.ndarray:
    return _ENCODE[np.frombuffer(seq.encode("ascii", "replace"), dtype=np.uint8)]


@_njit(cache=True, nogil=True)
def _banded_align(a, b, w):  # pragma: no cover - compiled
    """Global alignment of ``a`` against ``b`` in a band of half-width ``w``
    around the scaled diagonal. Returns the forward op array (OP_*)."""
    n = a.shape[0]
    m = b.shape[0]
    width = 2 * w + 1
    score = np.full((n + 1, width), _NEG, dtype=np.int32)
    trace = np.zeros((n + 1, width), dtype=np.uint8)
    centers = np.empty(n + 1, dtype=np.int64)
    for i in range(n + 1):
        centers[i] = (i * m) // n if n > 0 else 0
    # Row 0: only gaps in a (bases of b).
    off0 = centers[0] - w
    for k in range(width):
        j = off0 + k
        if 0 <= j <= m:
            score[0, k] = -j
            trace[0, k] = 1
    for i in range(1, n + 1):
        off = centers[i] - w
        prev_off = centers[i - 1] - w
        for k in range(width):
            j = off + k
            if j < 0 or j > m:
                continue
            best = _NEG
            move = 0
            # diagonal from (i-1, j-1)
            if j >= 1:
                pk = j - 1 - prev_off
                if 0 <= pk < width and score[i - 1, pk] > _NEG:
                    s = score[i - 1, pk] + (1 if (a[i - 1] == b[j - 1] and a[i - 1] < 4) else -1)
                    if s > best:
                        best = s
                        move = 0
            # up from (i-1, j): base of a against a gap
            pk = j - prev_off
            if 0 <= pk < width and score[i - 1, pk] > _NEG:
                s = score[i - 1, pk] - 1
                if s > best:
                    best = s
                    move = 2
            # left from (i, j-1): base of b against a gap
            if k >= 1 and score[i, k - 1] > _NEG:
                s = score[i, k - 1] - 1
                if s > best:
                    best = s
                    move = 1
            score[i, k] = best
            trace[i, k] = move
    ops = np.empty(n + m, dtype=np.uint8)
    count = 0
    i = n
    j = m
    while i > 0 or j > 0:
        k = j - (centers[i] - w)
        if i == 0:
            move = 1
        elif j == 0:
            move = 2
        else:
            move = trace[i, k]
        ops[count] = move
        count += 1
        if move == 0:
            i -= 1
            j -= 1
        elif move == 1:
            j -= 1
        else:
            i -= 1
    out = np.empty(count, dtype=np.uint8)
    for idx in range(count):
        out[idx] = ops[count - 1 - idx]
    return out


def band_width(len_a: int, len_b: int) -> int:
    # The band follows the scaled diagonal, so it needs room for the indel
    # random walk around it (nanopore inserts drift a few % either way).
    return int(48 + abs(len_a - len_b) // 2 + 0.015 * max(len_a, len_b))


def align(a: str | np.ndarray, b: str | np.ndarray, w: Optional[int] = None) -> np.ndarray:
    """Forward op array aligning ``a`` (a read's insert) to ``b`` (a backbone)."""
    from services.reconstruction_budget import current_budget, isolated
    n, m = len(a), len(b)
    width = int(w if w is not None else band_width(n, m))
    budget = current_budget()
    if budget is None:
        return isolated(__name__, 'align', (a, b, w), {}, lengths=[n, m], pairs=[(n, m, width)], large=True, allow_wavefront=True)
    if budget.algorithm == 'weighted_wavefront:v1':
        from services.weighted_wavefront import weighted_wavefront
        from services.reconstruction_budget import ResourceResult
        score, states = budget.wavefront(n, m)
        ea = encode(a) if isinstance(a, str) else a
        eb = encode(b) if isinstance(b, str) else b
        ops, status, used = weighted_wavefront(ea, eb, score, states, width)
        budget.cells += used
        if status:
            raise ResourceResult('budget_exceeded', 'wavefront_states', states=used, score=score, n=n, m=m,
                                 alignment_algorithm=budget.algorithm)
        return ops
    budget.pair(n, m, width)
    ea = encode(a) if isinstance(a, str) else a
    eb = encode(b) if isinstance(b, str) else b
    if ea.shape[0] == 0 or eb.shape[0] == 0:
        return np.concatenate([
            np.full(ea.shape[0], OP_DEL, dtype=np.uint8),
            np.full(eb.shape[0], OP_INS, dtype=np.uint8),
        ])
    return _banded_align(ea, eb, int(w if w is not None else band_width(ea.shape[0], eb.shape[0])))


def _vote(backbone: str, reads: list[str]) -> str:
    """One round of star consensus over ``backbone``."""
    m = len(backbone)
    eb = encode(backbone)
    base_votes = np.zeros((m + 1, 5), dtype=np.int64)  # A C G T gap (row m unused)
    insert_votes: list[Counter] = [Counter() for _ in range(m + 1)]
    for seq in reads:
        ea = encode(seq)
        ops = align(ea, eb)
        a_steps = (ops != OP_INS).astype(np.int64)
        b_steps = (ops != OP_DEL).astype(np.int64)
        i_pos = np.cumsum(a_steps) - a_steps   # read index at each op
        j_pos = np.cumsum(b_steps) - b_steps   # backbone column at each op
        match = ops == OP_MATCH
        called = match & (ea[np.minimum(i_pos, max(len(ea) - 1, 0))] < 4) if len(ea) else match
        np.add.at(base_votes, (j_pos[called], ea[i_pos[called]].astype(np.int64)), 1)
        np.add.at(base_votes, (j_pos[ops == OP_INS], 4), 1)
        # Read bases between backbone columns: runs of OP_DEL, voted at the next column.
        dels = np.flatnonzero(ops == OP_DEL)
        if dels.size:
            breaks = np.flatnonzero(np.diff(dels) != 1) + 1
            for run in np.split(dels, breaks):
                start, stop = int(i_pos[run[0]]), int(i_pos[run[-1]]) + 1
                insert_votes[int(j_pos[run[0]])][seq[start:stop].upper()] += 1
    n_reads = len(reads)
    out: list[str] = []
    for j in range(m + 1):
        votes = insert_votes[j]
        if votes and sum(votes.values()) * 2 > n_reads:
            out.append(_majority_insert(votes))
        if j == m:
            break
        column = base_votes[j]
        if column[4] * 2 > n_reads:
            continue
        out.append("ACGT"[int(np.argmax(column[:4]))] if column[:4].sum() else backbone[j])
    return "".join(out)


def _majority_insert(votes: Counter) -> str:
    lengths = Counter()
    for seq, count in votes.items():
        lengths[len(seq)] += count
    modal = lengths.most_common(1)[0][0]
    same = [(seq, count) for seq, count in votes.items() if len(seq) == modal]
    chars = []
    for pos in range(modal):
        tally = Counter()
        for seq, count in same:
            tally[seq[pos]] += count
        chars.append(tally.most_common(1)[0][0])
    return "".join(chars)


def _evenly(items: list, limit: int) -> list:
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _build_consensus(inserts: list[str], *, max_reads: int = 32, rounds: int = 2) -> str:
    """Star consensus of ``inserts`` (all in the same orientation)."""
    inserts = [seq for seq in inserts if seq]
    if not inserts:
        return ""
    if len(inserts) == 1:
        return inserts[0].upper()
    ordered = sorted(inserts, key=len)
    backbone = ordered[len(ordered) // 2].upper()
    sample = _evenly(sorted(inserts, key=len), max_reads)
    for _ in range(max(1, rounds)):
        backbone = _vote(backbone, sample) or backbone
    return backbone


def read_to_consensus_knots(
    ops: np.ndarray, a: Optional[np.ndarray] = None, b: Optional[np.ndarray] = None, *,
    step: int = 32, max_drift: int = 2,
) -> tuple[list[list[int]], float]:
    """Sparse ``[read_pos, consensus_pos]`` knots along one alignment, and its identity.

    Knots sit on read bases (each read position at most once): the first and
    last read base, a base about every ``step`` read bases, and the first base
    of a run wherever the read/consensus offset has moved by more than
    ``max_drift`` since the last knot, so interpolating between knots places
    every read base within ``max_drift`` of where it aligns (gaps included).
    The closing knot ``[n, m_end]`` maps the read's end to the consensus
    position after its last base. Identity counts equal bases only (``a`` and
    ``b`` encoded); without them it falls back to the diagonal fraction.
    """
    ops = np.asarray(ops)
    a_steps = (ops != OP_INS).astype(np.int64)
    b_steps = (ops != OP_DEL).astype(np.int64)
    a_pos = np.cumsum(a_steps) - a_steps  # position before this column
    b_pos = np.cumsum(b_steps) - b_steps
    n = int(a_steps.sum())
    on_read = np.flatnonzero(a_steps)
    knots: list[list[int]] = []
    if on_read.size:
        last_a = None
        last_offset = None
        for idx in on_read:
            ap = int(a_pos[idx])
            bp = int(b_pos[idx])
            offset = bp - ap
            if (last_a is None or ap - last_a >= step
                    or abs(offset - last_offset) > max_drift):
                knots.append([ap, bp])
                last_a = ap
                last_offset = offset
        end_idx = int(on_read[-1])
        end_b = int(b_pos[end_idx]) + (1 if ops[end_idx] == OP_MATCH else 0)
        if knots[-1][0] != n:
            knots.append([n, end_b])
    else:
        knots = [[0, 0]]
    diagonal = ops == OP_MATCH
    if a is not None and b is not None and diagonal.any():
        ai = a_pos[diagonal]
        bi = b_pos[diagonal]
        equal = (a[ai] == b[bi]) & (a[ai] < 4)
        identity = float(equal.sum()) / float(ops.size)
    else:
        identity = float(diagonal.sum()) / float(ops.size) if ops.size else 0.0
    return knots, identity


METHOD_LABELS = {"daf": "DAF-aware (FiberHMM)", "majority": "majority vote"}


def fiberhmm_insert_consensus():
    """FiberHMM's DAF-aware insert consensus module (the FiberHMM this Browser runs), or None
    when that FiberHMM has none (older than 3.0)."""
    try:
        import importlib

        from services.fiberhmm_runtime import configure_fiberhmm_runtime
        configure_fiberhmm_runtime()
        module = importlib.import_module("fiberhmm.daf.insert_consensus")
    except Exception:
        return None
    needed = ("collect_carriers", "build_consensus", "record_key", "Carrier", "MIN_QUALITY", "STRAND_CT")
    return module if all(hasattr(module, name) for name in needed) else None


def daf_aware_consensus(records: list, module=None) -> tuple[Optional[dict], Optional[str]]:
    """FiberHMM's deamination-aware consensus of CIGAR-insert carriers, or (None, why not).

    ``records``: ``(pysam record, insert start in SEQ, insert length[, canonical sequence])``
    per carrier. Sequence overrides rotate each observation before alignment;
    strand and record identity still come from the original read. Each
    carrier's strand is the one fiberhmm-call gives the read (its MD comparison, or MM/ML
    marks); carriers it cannot assign, and PCR duplicates, do not vote. Returns
    ``{seq, confident_fraction, carriers_ct, carriers_ga}``: ``confident_fraction`` is the
    share of consensus columns called at FiberHMM's quality floor (Phred 20), not a
    per-base confidence."""
    module = module or fiberhmm_insert_consensus()
    values, why = _collect_daf(records, module)
    if values is None:
        return None, why
    from services.reconstruction_budget import isolated
    lengths = [len(value[2]) for value in values]
    median = sorted(lengths)[len(lengths) // 2]
    used = _evenly(sorted(values, key=lambda value: value[0]), 200)
    pairs = [(len(v[2]), median, 48 + abs(len(v[2]) - median) + max(len(v[2]), median) // 40)
             for v in used] * 3
    return isolated(__name__, '_daf_from_carriers', (values,), {}, lengths=lengths, pairs=pairs, large=True)


def _collect_daf(records, module):
    if module is None:
        return None, "the FiberHMM this Browser runs has no DAF-aware insert consensus (it is older than 3.0)"
    if not records:
        return None, "no carrier has its inserted bases in the alignment"
    # The strand fiberhmm-call gives each read, from FiberHMM's own carrier collection (every
    # CIGAR insertion, any length); the carrier is the lens's insert span, which may join
    # several nearby insertion pieces into one.
    strands: dict = {}
    for _contig, _pos, carrier in module.collect_carriers([read for read, *_span in records], min_length=1):
        strands.setdefault(carrier.key, carrier.strand)
    carriers = []
    seen = set()
    for record in records:
        read, q, length, *canonical = record
        key = module.record_key(read)
        strand = strands.get(key)
        if strand is None or read.is_duplicate or (key, int(q)) in seen:
            continue
        seen.add((key, int(q)))
        seq = read.query_sequence or ""
        carriers.append(module.Carrier(key, int(q), (canonical[0] if canonical and canonical[0] is not None else seq[int(q):int(q) + int(length)]), strand, False))
    if len(carriers) < 2:
        return None, ("FiberHMM could not tell the deamination strand of enough carriers (it reads it from the "
                      "MD tag or MM/ML marks)")
    return [(c.key, c.query_start, c.seq, c.strand, c.duplicate) for c in carriers], None


def _daf_from_carriers(values):
    from services.reconstruction_budget import ResourceResult, current_budget
    module = fiberhmm_insert_consensus()
    if module is None:
        return None, 'DAF-aware consensus is unavailable'
    # Only the supported banded allocation contract can enter this adapter.
    import inspect
    kernel = getattr(module, '_banded_align', None)
    source = inspect.getsource(getattr(kernel, 'py_func', kernel)) if kernel else ''
    if not all(part in source for part in ('width = 2 * w + 1', 'dtype=np.int32', 'dtype=np.uint8', '(n + 1, width)')):
        raise ResourceResult('unavailable', 'unsupported_daf_allocation_contract')
    def budgeted_align(read, cons, strand):
        w = 48 + abs(len(read) - len(cons)) + max(len(read), len(cons)) // 40
        current_budget().pair(len(read), len(cons), w)
        return kernel(read, cons, w, strand)
    module.align = budgeted_align
    carriers = [module.Carrier(*value) for value in values]
    consensus = module.build_consensus(carriers, max_reads=200, rounds=3)
    if consensus is None or not consensus.sequence:
        return None, 'FiberHMM built no consensus from these carriers'
    used = _evenly(sorted(carriers, key=lambda c: c.key), 200)
    n_ct = sum(1 for c in used if c.strand == module.STRAND_CT)
    quality = np.asarray(consensus.quality, dtype=float)
    return {'seq': consensus.sequence,
            'confident_fraction': round(float(np.mean(quality >= module.MIN_QUALITY)) if quality.size else 0.0, 4),
            'carriers_ct': n_ct, 'carriers_ga': len(used) - n_ct,
            'input_count': len(carriers), 'used_count': len(used),
            'sampling': 'evenly_by_record_key', 'max_reads': 200, 'rounds': 3}, None


def _consensus_with_knots(
    inserts: list[str], *, max_reads: int = 32, knot_step: int = 32, seq: Optional[str] = None,
) -> dict:
    """``{seq, reads: [{knots, identity}]}`` for ``inserts`` (order kept); ``seq``: a consensus
    already built (the DAF-aware one) to map them onto instead of their majority vote."""
    seq = build_consensus(inserts, max_reads=max_reads) if seq is None else seq
    eb = encode(seq) if seq else np.zeros(0, dtype=np.uint8)

    def one(insert: str) -> dict:
        if not insert or not seq:
            return {"knots": [[0, 0], [len(insert), len(seq)]], "identity": 0.0}
        ea = encode(insert)
        knots, identity = read_to_consensus_knots(align(ea, eb), ea, eb, step=knot_step)
        return {"knots": knots, "identity": round(identity, 4)}

    reads = [one(insert) for insert in inserts]
    from services.reconstruction_budget import current_budget
    return {"seq": seq, "reads": reads, "alignment_algorithm": current_budget().algorithm}


def _partials_to_consensus(partials: list[tuple[str, str]], seq: str, *, knot_step: int = 32) -> list[dict]:
    """Knots and identity of partial inserts (from reads clipped at the
    insertion) against the consensus ``seq``.

    Each item is ``(insert_bases, 'start' | 'end')``: the start of the insert
    (the read's alignment ends at the insertion) is aligned to the consensus's
    first ``len`` bases, the end of the insert to its last ``len`` bases, and
    the knots are in whole-consensus coordinates."""
    if not seq:
        return [{"knots": [[0, 0], [len(p), len(p)]], "identity": 0.0} for p, _ in partials]
    eb_all = encode(seq)
    m = len(seq)

    def one(item: tuple[str, str]) -> dict:
        insert, which = item
        if not insert:
            return {"knots": [[0, 0]], "identity": 0.0}
        w = min(len(insert), m)
        offset = 0 if which == "start" else m - w
        eb = eb_all[offset:offset + w]
        ea = encode(insert)
        knots, identity = read_to_consensus_knots(align(ea, eb), ea, eb, step=knot_step)
        return {"knots": [[a, b + offset] for a, b in knots], "identity": round(identity, 4)}

    return [one(item) for item in partials]


def _planned(inserts, backbone, *, repeats=1):
    return [(len(s), len(backbone), band_width(len(s), len(backbone))) for s in inserts] * repeats


def build_consensus(inserts: list[str], *, max_reads: int = 32, rounds: int = 2) -> str:
    from services.reconstruction_budget import isolated
    ordered = sorted((s for s in inserts if s), key=len)
    backbone = ordered[len(ordered) // 2] if ordered else ''
    sample = _evenly(ordered, max_reads)
    return isolated(__name__, '_build_consensus', (inserts,), {'max_reads': max_reads, 'rounds': rounds},
                    lengths=[len(s) for s in inserts], pairs=_planned(sample, backbone, repeats=max(1, rounds)), large=True, allow_wavefront=True)


def consensus_with_knots(inserts, *, max_reads=32, knot_step=32, seq=None):
    from services.reconstruction_budget import isolated
    ordered = sorted((s for s in inserts if s), key=len)
    backbone = seq if seq is not None else ordered[len(ordered) // 2] if ordered else ''
    pairs = _planned(inserts, backbone)
    if seq is None:
        pairs += _planned(_evenly(ordered, max_reads), backbone, repeats=2)
    return isolated(__name__, '_consensus_with_knots', (inserts,),
                    {'max_reads': max_reads, 'knot_step': knot_step, 'seq': seq},
                    lengths=[len(s) for s in inserts] + ([len(seq)] if seq is not None else []), pairs=pairs, large=True, allow_wavefront=True)


def partials_to_consensus(partials, seq, *, knot_step=32):
    from services.reconstruction_budget import isolated
    pairs = [(len(s), min(len(s), len(seq)), band_width(len(s), min(len(s), len(seq)))) for s, _ in partials]
    return isolated(__name__, '_partials_to_consensus', (partials, seq), {'knot_step': knot_step},
                    lengths=[len(s) for s, _ in partials] + [len(seq)], pairs=pairs, large=True, allow_wavefront=True)


def _lens_reconstruction(full, canonical, partials, daf_values, why):
    daf_info, method = None, 'majority'
    if daf_values:
        daf_info, why = _daf_from_carriers(daf_values)
        if daf_info is not None:
            method = 'daf'
    sequence = daf_info['seq'] if daf_info else _build_consensus(canonical)
    result = _consensus_with_knots(full, seq=sequence)
    return {'full': result, 'partials': _partials_to_consensus(partials, sequence),
            'daf': daf_info, 'method': method, 'fallback': why, 'alignment_algorithm': result['alignment_algorithm']}


def reconstruct_lens(full, canonical, partials, *, records=(), daf=False, daf_compatible=True):
    from services.reconstruction_budget import isolated
    values, why = None, None
    if daf and daf_compatible:
        values, why = _collect_daf(records, fiberhmm_insert_consensus())
    if daf and not daf_compatible:
        why = 'Canonical allele normalization changes the source query span; using canonical sequence majority'
    ordered = sorted(canonical, key=len)
    backbone = ordered[len(ordered) // 2] if ordered else ''
    pairs = _planned(full, backbone)
    pairs += [(len(s), min(len(s), len(backbone)), band_width(len(s), min(len(s), len(backbone)))) for s, _ in partials]
    if values:
        ns = [len(v[2]) for v in values]
        median = sorted(ns)[len(ns) // 2]
        used = _evenly(sorted(values, key=lambda value: value[0]), 200)
        pairs += [(len(v[2]), median, 48 + abs(len(v[2]) - median) + max(len(v[2]), median) // 40) for v in used] * 3
    else:
        pairs += _planned(_evenly(ordered, 32), backbone, repeats=2)
    lengths = [len(s) for s in full + canonical] + [len(s) for s, _ in partials]
    return isolated(__name__, '_lens_reconstruction', (full, canonical, partials, values, why), {},
                    lengths=lengths, pairs=pairs, large=True, allow_wavefront=not bool(values))
