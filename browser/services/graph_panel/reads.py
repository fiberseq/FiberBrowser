"""Reads on the graph panel (DESIGN_GRAPH_PANEL.md §5, Gate E): molecules of a
bound dataset in source-assembly coordinates, composed by the live-lift composer
and sent for the browser to place along each selected path's walk.

**Read bindings.** A dataset binds to a package path only through explicit
identities, never MAT/PAT names:

- a live-lift dataset (``bam_livelift``): its map's ``sources[]`` entry whose
  ``path`` (``sample#haplotype#contig``) is the binding's path, with the same
  size and fragments, and the BAM's contig of that name with that length;
- a native BAM dataset: the package's *target* binding (a map target) when the
  BAM has the target contig at the binding's size and the main reference does
  too.

**Composition.** Every bound (dataset, path) decodes the records of its topology windows
it has not decoded before (a per-record cache: a record is composed whole, so its
composition does not depend on the window or sampling level that fetched it; a pan
decodes only its new records) with ``live_lift.decode_source_records`` (the lifted loader options, hard-clip scope,
duplicates, supplementary records) and composes them with ``lift_compact_reads``
through one identity piece over the source contig. Whole calls, call identities
(``call_id``, ``call_parts``), the explicit-channel precedence and legacy
nucleosome/MSP inference are the linear composer's, in source coordinates,
before any node slicing. The browser cuts the composed calls at the visits and
at the read's coverage holes (``cov``); nothing is inferred there.

**Budgets** (DESIGN_GRAPH_PRIMARY §6, graph primary G7): the performance profile's
``sample_target`` molecules per request (1,000 Low memory, 4,000 Standard/High),
split across the request's sub-bands — each (dataset, path) — at least 50 each,
pins on top; 100,000 mark primitives per draw; 32 MiB of decoded reads (8 MiB
Low memory), shared across concurrent loads (every host's request). Each
sub-band is sampled by QNAME hash *before* decoding at the level its own quota
needs (``read_sampling.Sampler``; a load that would still pass its byte budget
is retried one level sparser), then capped in hash order; marks beyond the
budget become m6A density. Every omission is reported, never silent. Topology
and selected paths are never reduced for reads.

**Density strip** (§6.2 L2): per sub-band, coverage and the accessible (MSP) and
nucleosome counts at each bin's centre, over every row decoded at the band's
sampling level — before the molecule cap and before the mark budget drops any
call — so a band that draws fewer rows than it has molecules still shows them.
"""
from __future__ import annotations

import hashlib
import math
import os
import threading
import time
from collections import OrderedDict
from typing import Iterable, Optional

MAX_MOLECULES = 300          # a request without a profile (tests, tools)
MIN_BAND_MOLECULES = 50      # each sub-band's share of the profile's molecules is at least this
MAX_PINS = 2000
MAX_MARKS = 100_000
MAX_DECODED_BYTES = 32 * 1024 * 1024   # the ceiling of a request's decoded-bytes budget (Standard/High)
LOW_DECODED_BYTES = 8 * 1024 * 1024    # Low memory
MIN_SHARED_BYTES = 2 * 1024 * 1024     # a request's floor while other loads share the budget
MAX_STRIP_BINS = 4000
MAX_SOURCE_BP = 400_000
MAX_WINDOWS = 64
MAX_LEVEL = 8
# Loader options of a graph read load (the lifted load fixes the rest; compose infers the legacy layers).
LOADER_OPTIONS = dict(include_methylation=True, ml_threshold=125, include_layers=True, include_layer_qualities=True,
                      hide_terminal_gaps=True, include_cigar=True, include_duplicates=False, sv_min_len=50)
_LAYERS = ("nuc", "tf", "msp")
# The cached rows' wire form: 2 adds the identities (aid, rk, hap) and the map's molecule groups (graph primary G0);
# 3 the DAF strand (ds: CT / GA) of DAF-seq records (G8).
WIRE_VERSION = 3


class ReadsError(Exception):
    def __init__(self, code: str, message: str, status: int = 422, **detail):
        super().__init__(message)
        self.code, self.message, self.status, self.detail = code, message, status, detail

    def payload(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.status >= 500, **self.detail}


# ── Bindings ────────────────────────────────────────────────────────────────

def path_name(binding: dict) -> str:
    p = binding.get("path") or {}
    return f"{p.get('sample')}#{p.get('haplotype')}#{p.get('contig')}"


def _bam_lengths(path: str) -> dict:
    from services.bam_handles import get_bam_handle
    bam = get_bam_handle(path)
    return dict(zip(bam.references, bam.lengths))


def dataset_revision(dataset) -> str:
    """The dataset's files (path, size, mtime) and lift identity: a changed BAM or map is a new revision."""
    from services.background_work import file_identity
    from services.lift.reads import lift_identity
    raw = repr((file_identity(getattr(dataset, "paths", None) or ()), lift_identity(dataset)))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _fragment_spans(binding: dict) -> list:
    return sorted((int(f["origin"]), int(f["end"])) for f in binding.get("fragments") or ())


def _lifted_paths(dataset, reg) -> tuple[dict, list]:
    handle = dataset.live_lift.handle
    sources = {s.get("path"): s for s in handle.manifest.get("sources") or () if s.get("path")}
    out, problems = {}, []
    lengths = None
    for binding in reg.bindings:
        src = sources.get(path_name(binding))
        if src is None:
            continue
        name = src.get("name")
        size = int(src.get("size") or -1)
        want = binding.get("size")
        if want is not None and (size < int(want) if binding.get("size_inferred") else size != int(want)):
            problems.append(f"{name}: the map's source size {src.get('size')} is not the graph path's {want}")
            continue
        # The fragments are the identity evidence: both sides must list them, and they must agree.
        frags = sorted((int(f["offset"]), int(f["offset"]) + int(f["len"])) for f in src.get("fragments") or ())
        if not frags or not _fragment_spans(binding):
            problems.append(f"{name}: no fragment list to verify it is the graph's {path_name(binding)}")
            continue
        if frags != _fragment_spans(binding):
            problems.append(f"{name}: the map's fragments of {path_name(binding)} differ from the graph package's")
            continue
        if lengths is None:
            lengths = {}
            for p in dataset.paths:
                for contig, ln in _bam_lengths(p).items():
                    lengths.setdefault(contig, set()).add(int(ln))
        if lengths.get(name) != {int(src.get("size") or -1)}:
            problems.append(f"{name}: the BAM's contig length is not the map's source size")
            continue
        out[binding["key"]] = name
    return out, problems


def lifted_haps(dataset, paths: dict) -> dict:
    """``{binding key: haplotype label}`` of a lifted dataset's bound paths (graph primary: a split panel's
    ``liftHap`` names the path it is a member for)."""
    hap_of, labels = {}, {}
    for key, contig in paths.items():
        hap, labels = source_haplotype(dataset, contig)
        if hap is not None:
            hap_of[key] = labels.get(hap, hap)
    return hap_of


def _native_paths(state, dataset, reg) -> tuple[dict, list]:
    targets = {m.get("target") for m in reg.maps}
    main = {c.name: int(c.size) for c in (getattr(state, "chroms", None) or ())}
    out, problems = {}, []
    lengths: dict = {}
    for p in dataset.paths:
        for contig, ln in _bam_lengths(p).items():
            lengths.setdefault(contig, set()).add(int(ln))
    for binding in reg.bindings:
        if binding["key"] not in targets:
            continue
        contig = (binding.get("path") or {}).get("contig")
        size = binding.get("size")
        if contig not in lengths or size is None:
            continue
        if lengths[contig] != {int(size)} or main.get(contig) != int(size):
            problems.append(f"{contig}: the BAM's or main reference's length is not the graph target's {int(size):,}")
            continue
        out[binding["key"]] = contig
    return out, problems


def read_bindings(state, reg) -> list:
    """Every loaded local BAM dataset with the package paths it binds to (``paths``: binding key -> BAM contig)."""
    from services.lift.reads import is_lifted
    out = []
    for dataset in list((getattr(state, "datasets", None) or {}).values()):
        kind = "lifted" if is_lifted(dataset) else "native" if getattr(dataset, "data_type", None) == "bam" else None
        if kind is None or getattr(dataset, "is_remote", False):
            continue
        try:
            paths, problems = (_lifted_paths(dataset, reg) if kind == "lifted" else _native_paths(state, dataset, reg))
        except Exception as exc:  # noqa: BLE001 - a dataset whose files went missing binds to nothing
            paths, problems = {}, [f"{type(exc).__name__}: {exc}"]
        if not paths and not problems:
            continue
        out.append({"dataset_id": dataset.id, "label": dataset.label, "kind": kind, "revision": dataset_revision(dataset),
                    "paths": paths, "problems": problems, "libraries": len(dataset.paths),
                    **({"haps": lifted_haps(dataset, paths)} if kind == "lifted" else {})})
    return out


# ── Composition ─────────────────────────────────────────────────────────────

class _Plan:
    """The fetch plan shape ``decode_source_records``/``lift_compact_reads`` read: one contig, its windows (the
    records to fetch), one identity piece over the whole contig (source coordinates are kept) and a region that
    holds every fetched record whole, so no call is clipped before it is composed."""

    def __init__(self, contig: str, size: int, windows: list, hap: str, region: Optional[tuple] = None):
        from services.lift.live_lift import ContigFetch, LiftPiece, PieceSelection
        piece = LiftPiece(0, 0, int(size), 0, int(size), "+", True, hap, contig)
        a, b = region if region is not None else (windows[0][0], windows[-1][1])
        a, b = max(0, int(a)), min(int(size), int(b))
        self.region = (a, b)
        self.selection = PieceSelection(contig, a, b, a, b, [piece])
        self.contigs = [ContigFetch(contig, a, b, [tuple(w) for w in windows], [piece])]
        self.source_bp = sum(e - s for s, e in windows)
        self.budget_bp = MAX_SOURCE_BP

    def pieces_by_contig(self) -> dict:
        return {self.contigs[0].contig: list(self.selection.pieces)}


def merge_windows(windows: Iterable) -> list:
    spans = sorted((int(w[0]), int(w[1])) for w in windows if int(w[1]) > int(w[0]))
    out: list = []
    for a, b in spans:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def window_records(dataset, contig: str, windows: list) -> Optional[list]:
    """The physical records the windows hold, from an index walk over record headers (no tag decoding):
    ``[(library, QNAME, start, flag, end, hard_clipped)]``, each once (a record over two windows is listed by the first). Their
    count bounds the molecules (the sampling level is chosen from it before any call is decoded), their extent is
    the composition region (records whole), and they say how many records the loader's own filters left out."""
    import pysam
    out: list = []
    for lib, path in enumerate(dataset.paths):
        try:
            with pysam.AlignmentFile(path, "rb") as bam:
                if contig not in bam.references:
                    continue
                for k, (a, b) in enumerate(windows):
                    for rec in bam.fetch(contig, a, b):
                        if rec.is_unmapped or rec.is_secondary or rec.is_qcfail or rec.is_duplicate:
                            continue
                        end = rec.reference_end or rec.reference_start + 1
                        if any(rec.reference_start < wb and end > wa for wa, wb in windows[:k]):
                            continue
                        hard = any(op == 5 for op, _n in (rec.cigartuples or ()))
                        out.append((lib, rec.query_name, rec.reference_start, rec.flag, end, hard))
        except (OSError, ValueError):
            return None
    return out


def contig_length(dataset, contig: str) -> Optional[int]:
    """The source contig's length from the BAM header(s): the authoritative bound of a composition region (a
    graph binding's size can be an inferred lower bound)."""
    sizes = {int(ln) for p in dataset.paths for c, ln in _bam_lengths(p).items() if c == contig}
    return max(sizes) if sizes else None


def _abs_layer(layer: Optional[dict], ids, parts, origin: int, name: str, keep) -> Optional[dict]:
    if not layer or not layer.get("intervals"):
        return None
    names = list(layer.get("quality_names") or ())
    quals = layer.get("qualities") or []
    ids = list(ids or [None] * len(layer["intervals"]))
    parts = list(parts or [None] * len(layer["intervals"]))
    idx = [i for i, iv in enumerate(layer["intervals"]) if keep(int(iv[0]) + origin, int(iv[1]) + origin)]
    if not idx:
        return None
    out = {"iv": [[int(layer["intervals"][i][0]) + origin, int(layer["intervals"][i][1]) + origin,
                   int(layer["intervals"][i][2])] for i in idx],
           "id": [ids[i] for i in idx], "part": [parts[i] for i in idx]}
    for qn, track in zip(names, quals):
        if track is not None and qn in ("nq", "lq", "rq", "aq", "tq", "el", "er", "q0"):
            out[qn] = [track[i] for i in idx]
    if name == "msp" and all(i is None for i in out["id"]):
        out["inferred"] = True
    return out


def compact_row(row: dict, origin: int, dataset_id: str, binding: str, windows: Optional[list] = None) -> dict:
    """A composed row (relative to ``origin``) as the graph wire form, in absolute source coordinates. Calls are
    whole (their own bounds, never clipped); only those touching ``windows`` are sent, and m6A inside them."""
    ll = row["live_lift"]
    calls, parts = ll.get("calls") or {}, ll.get("call_parts") or {}
    spans = sorted(ll.get("molecular_spans") or ())
    cov = [[int(t0) + origin, int(t1) + origin, int(m0), int(step)] for t0, t1, m0, step, *_ in spans]
    wins = windows or [[-1 << 62, 1 << 62]]

    def keep(a, b):
        return any(a < wb and b > wa for wa, wb in wins)

    def inside(p):
        return any(wa <= p < wb for wa, wb in wins)

    # CIGAR events (the loader's include_cigar list, mapped by the composer): insertions with their length and
    # deletions (where a coverage hole has no D it is a skip, N). Soft clips have no path bp; the loader lists none
    # and the molecular coordinates of the coverage runs already account for them.
    ins, dels = [], []
    events = row.get("cigar")
    if events is not None:
        for e in events:
            t, pos, ln = e.get("type"), int(e.get("pos", 0)) + origin, int(e.get("len", 0))
            if t == "I":
                ins.append([pos, ln, 0])
            elif t == "D":
                dels.append([pos, ln])
    else:  # no event list: insertions from the coverage runs' molecular jumps
        for (a0, a1, m0, step), (_b0, _b1, n0, _s) in zip(cov, cov[1:]):
            expected = m0 + step * (a1 - a0)
            extra = (n0 - expected) * step
            if extra > 0:
                ins.append([a1, int(extra), int(expected if step > 0 else n0 + 1)])
    src = ll.get("source") or {}
    layers = row.get("layers") or {}
    out = {
        "k": f"{dataset_id}|{ll.get('library', 0)}|{row.get('id')}|{ll.get('record')}",
        "d": dataset_id, "lib": int(ll.get("library", 0)), "q": row.get("id"), "rec": ll.get("record"),
        "b": binding, "c": src.get("contig"), "st": "-" if row.get("alignment_orientation") == "reverse" else "+",
        "sup": bool(src.get("supplementary")), "s": int(src.get("start", 0)), "e": int(src.get("end", 0)),
        "cov": cov, "ins": ins, "dl": dels,
    }
    for name in _LAYERS:
        layer = _abs_layer(layers.get(name), calls.get(f"layer:{name}"), parts.get(f"layer:{name}"), origin, name, keep)
        if layer is not None:
            out[name] = layer
    m6a = [int(p) + origin for p in row.get("methyl_m6a") or ()]
    m6a = [p for p in m6a if inside(p)]
    if m6a:
        out["m6a"] = m6a
    # A DAF-seq record's strand (CT / GA: its st:Z tag, else its deamination marks), as linear rows read it, so a
    # one-strand member's sub-band shows only its strand (G8).
    from services.read_strand import read_strand
    daf = read_strand(row)
    if daf:
        out["ds"] = daf
    return out


def marks_of(read: dict) -> int:
    return (sum(len((read.get(n) or {}).get("iv") or ()) for n in _LAYERS) + len(read.get("m6a") or ())
            + len(read.get("m6a_density") or ()))


def m6a_density(read: dict, bin_bp: int) -> None:
    """Replace a read's m6A ticks by counts per ``bin_bp`` bin: ``[[start, end, count], ...]`` (on a copy)."""
    points = read.pop("m6a", None) or []
    bins: dict = {}
    for p in points:
        b = (p // bin_bp) * bin_bp
        bins[b] = bins.get(b, 0) + 1
    if bins:
        read["m6a_density"] = [[b, b + bin_bp, n] for b, n in sorted(bins.items())]


def compact_full(row: dict, origin: int, dataset_id: str, binding: str) -> dict:
    """A composed row in absolute source coordinates with every call and mark (no window clip)."""
    return compact_row(row, origin, dataset_id, binding, None)


def clip_to_windows(read: dict, windows: list) -> dict:
    """A cached whole read as the request's wire form: only calls touching ``windows`` (their own bounds kept) and
    m6A inside them (a new dict; the cached one is never changed)."""
    def keep(a, b):
        return any(a < wb and b > wa for wa, wb in windows)

    out = {k: v for k, v in read.items() if k not in _LAYERS and k != "m6a"}
    for name in _LAYERS:
        layer = read.get(name)
        if not layer:
            continue
        idx = [i for i, iv in enumerate(layer["iv"]) if keep(iv[0], iv[1])]
        if not idx:
            continue
        if len(idx) == len(layer["iv"]):
            out[name] = layer
            continue
        out[name] = {k: ([v[i] for i in idx] if isinstance(v, list) else v) for k, v in layer.items()}
    m6a = [p for p in read.get("m6a") or () if any(wa <= p < wb for wa, wb in windows)]
    if m6a:
        out["m6a"] = m6a
    return out


# ── Per-record cache ────────────────────────────────────────────────────────
#
# A record's composition depends only on the record (it is composed whole, in source coordinates, through an
# identity piece), never on the window that fetched it or the sampling level that kept it. So a pan decodes only
# the records it has not seen; the rest come from here and are clipped to the request's windows. Each entry is
# the record's composed reads (whole), its decoded-size estimate and, for a record that composed to nothing, why.

_RECORDS: "OrderedDict[tuple, tuple]" = OrderedDict()
_RECORDS_LOCK = threading.Lock()
_RECORDS_MAX_BYTES = 96 * 1024 * 1024
_records_bytes = 0
# The record cache follows the profile (4,000 molecules of long reads per band would thrash 96 MiB).
_RECORDS_BUDGET = {"low": 48 * 1024 * 1024, "standard": 192 * 1024 * 1024, "high": 384 * 1024 * 1024}


def profile_budgets(state) -> dict:
    """The performance profile's read budgets (``services/performance.py``): molecules per request, the decoded-bytes
    budget and the record cache. A state without a profile (tests, tools) keeps the Phase E defaults."""
    perf = getattr(state, "performance", None) or {}
    effective = perf.get("effective")
    if not effective:
        return {"molecules": MAX_MOLECULES, "decoded_bytes": MAX_DECODED_BYTES, "records_bytes": _RECORDS_MAX_BYTES,
                "effective": None}
    low = effective == "low"
    target = int(perf.get("sample_target") or (1000 if low else 4000))
    return {"molecules": max(1, target), "decoded_bytes": min(MAX_DECODED_BYTES, LOW_DECODED_BYTES if low else MAX_DECODED_BYTES),
            "records_bytes": _RECORDS_BUDGET.get(effective, _RECORDS_BUDGET["standard"]), "effective": effective}


_SHARED = threading.Condition()
_shared_in_use = 0
_active_loads = 0


class _SharedBytes:
    """The decoded-bytes budget shared across concurrent read loads (every host's request): one allocator, so the
    loads' allowances together never pass the budget. A load reserves a share of what is free (the budget over the
    loads running, at least ``MIN_SHARED_BYTES``, never more than is free) and waits while less than that floor is
    free; it releases its share when it ends."""

    def __init__(self, total: int):
        self.total = int(total)
        self.share = 0
        self.concurrent = 1

    def __enter__(self):
        global _shared_in_use, _active_loads
        from services.background_work import checkpoint
        floor = min(self.total, MIN_SHARED_BYTES)
        with _SHARED:
            _active_loads += 1
            try:
                while self.total - _shared_in_use < floor:
                    _SHARED.wait(0.05)
                    checkpoint()   # a load whose client left stops waiting
            except BaseException:
                _active_loads -= 1
                _SHARED.notify_all()
                raise
            free = self.total - _shared_in_use
            self.concurrent = _active_loads
            self.share = min(free, max(floor, self.total // max(1, _active_loads)))
            _shared_in_use += self.share
        return self

    def __exit__(self, *exc):
        global _shared_in_use, _active_loads
        with _SHARED:
            _shared_in_use = max(0, _shared_in_use - self.share)
            _active_loads = max(0, _active_loads - 1)
            _SHARED.notify_all()
        return False


def band_bytes(need: list, total: int) -> list:
    """Each band's share of the decoded bytes: what it needs when that fits, else an equal share of the rest (a band
    needing less than its share leaves the remainder to the others)."""
    out = [0] * len(need)
    left = max(0, int(total))
    order = sorted(range(len(need)), key=lambda i: (need[i], i))
    for k, i in enumerate(order):
        share = left // (len(order) - k)
        out[i] = min(int(need[i]), share)
        left -= out[i]
    return out


def split_quota(total: int, estimates: list, floor: int = MIN_BAND_MOLECULES) -> list:
    """Each sub-band's molecule quota: ``total`` split evenly, at least ``floor`` each (never more than ``total``), a
    band with fewer molecules than its share keeping only what it has and leaving the rest to the others (``None``:
    unknown, takes its share)."""
    n = len(estimates)
    if not n:
        return []
    floor = max(1, min(int(floor), int(total)))
    quotas = [0] * n
    left = int(total)
    order = sorted(range(n), key=lambda i: (estimates[i] is None, estimates[i] or 0, i))
    for k, i in enumerate(order):
        share = max(floor, left // (n - k) if k < n - 1 else left)
        q = share if estimates[i] is None else min(int(estimates[i]), share)
        quotas[i] = q
        left = max(0, left - q)
    return quotas


def density_strip(reads: list, windows: list, bin_bp: int) -> dict:
    """A sub-band's density strip over its windows: per bin (``bin_bp`` from each window's start), the rows covering
    the bin's centre (coverage holes excluded), and of them the rows with an accessible (MSP) or a nucleosome call
    there. ``{"bp", "windows": [[start, end, cov[], acc[], nuc[]]]}``."""
    import numpy as np
    out = []
    for wa, wb in windows:
        n = max(1, int(math.ceil((wb - wa) / bin_bp)))
        centres = wa + (np.arange(n) + 0.5) * bin_bp
        counts = {}
        for name in ("cov", "msp", "nuc"):
            starts, ends = [], []
            for r in reads:
                if name == "cov":
                    ivs = r.get("cov") or ()
                else:
                    ivs = (r.get(name) or {}).get("iv") or ()
                for iv in ivs:
                    a, b = int(iv[0]), int(iv[1])
                    if b > wa and a < wb:
                        starts.append(a)
                        ends.append(b)
            diff = np.zeros(n + 1, dtype=np.int64)
            if starts:
                a = np.searchsorted(centres, np.asarray(starts, dtype=np.float64), side="left")
                b = np.searchsorted(centres, np.asarray(ends, dtype=np.float64), side="left")
                keep = b > a
                np.add.at(diff, a[keep], 1)
                np.add.at(diff, b[keep], -1)
            counts[name] = np.cumsum(diff[:-1]).tolist()
        out.append([int(wa), int(wb), counts["cov"], counts["msp"], counts["nuc"]])
    return {"bp": int(bin_bp), "windows": out}


def _entry_bytes(reads: tuple) -> int:
    return 256 + sum(512 + 32 * (marks_of(r) + len(r["cov"]) + len(r["ins"]) + len(r.get("dl") or ())) for r in reads)


def _records_get(keys) -> dict:
    out = {}
    with _RECORDS_LOCK:
        for k in keys:
            hit = _RECORDS.get(k)
            if hit is not None:
                _RECORDS.move_to_end(k)
                out[k] = hit
    return out


def _records_resize(max_bytes: int) -> None:
    """A new record-cache budget (the profile changed): least recently used entries go at once."""
    global _RECORDS_MAX_BYTES, _records_bytes
    with _RECORDS_LOCK:
        _RECORDS_MAX_BYTES = int(max_bytes)
        while _records_bytes > _RECORDS_MAX_BYTES and _RECORDS:
            _k, old = _RECORDS.popitem(last=False)
            _records_bytes -= old[3]


def _records_put(items: dict) -> None:
    global _records_bytes
    with _RECORDS_LOCK:
        for k, v in items.items():
            old = _RECORDS.pop(k, None)
            if old is not None:
                _records_bytes -= old[3]
            _RECORDS[k] = v
            _records_bytes += v[3]
        while _records_bytes > _RECORDS_MAX_BYTES and _RECORDS:
            _k, old = _RECORDS.popitem(last=False)
            _records_bytes -= old[3]


def clear_cache() -> None:
    global _records_bytes
    with _RECORDS_LOCK:
        _RECORDS.clear()
        _records_bytes = 0


def source_haplotype(dataset, contig: str) -> tuple:
    """A lifted dataset's map haplotype of a source contig and the map's labels (``(None, {})``: native)."""
    config = getattr(dataset, "live_lift", None)
    handle = getattr(config, "handle", None) if config is not None else None
    if handle is None:
        return None, {}
    return getattr(handle, "source_haplotype", {}).get(contig), dict(getattr(handle, "haplotype_labels", {}) or {})


def row_identity(row: dict, settings, labels: dict) -> dict:
    """A lifted graph row's identities (DESIGN_GRAPH_PRIMARY §3.1): its standard ``analysis_id`` (``aid``; the
    graph's one synthetic piece is recorded as the primary placement), its record key (``rk``: molecule, QNAME,
    record; no row index, no placement) and its haplotype's label (``hap``), as the linear rows of the same record
    carry them."""
    from services.lift.cohort import analysis_id, record_key
    ll = dict(row["live_lift"])
    ll["placement"] = "primary"
    aid = analysis_id({**row, "live_lift": ll}, settings)
    hap = ll.get("hap")
    return {"aid": aid, "rk": record_key(aid), "hap": labels.get(hap, hap) if hap is not None else None}


def _record_key(base: tuple, rec: tuple) -> tuple:
    """A listed record's cache key: the (dataset, revision, path, contig) base and the identity its composed rows
    carry, (library, QNAME, start, end, supplementary). Physical records sharing it (duplicates, the same alignment
    twice) are one entry, cached only once every one of them was decoded."""
    lib, qname, start, flag, end = rec[:5]
    return base + (lib, qname, start, end, bool(flag & 0x800))


def _decode_records(dataset, contig: str, size: int, windows: list, binding: str, missing: list, region: tuple,
                    base: tuple, listed_n: Optional[dict] = None, max_bytes: int = MAX_DECODED_BYTES) -> tuple:
    """Decode and compose the ``missing`` listed records (only them: by QNAME, over their own spans inside the
    windows) and cache each: ``(entries, truncated, scoped counts)``. A record of the batch that composed to nothing
    is cached with its reason: a hard-clipped supplementary whose tags cannot be scoped, a record the loader's
    filters left out, or one with no correspondence. Nothing is cached for records a truncated batch never reached."""
    from services.lift.compose import lift_compact_reads
    from services.lift.live_lift import LoadBudget, decode_source_records, decoded_size_estimate
    from services.read_sampling import Sampler

    settings = _settings(dataset)
    spans = merge_windows((max(r[2], wa), min(r[4], wb)) for r in missing for wa, wb in windows
                          if r[2] < wb and r[4] > wa)
    if not spans:  # zero-length records: their start inside a window
        spans = merge_windows((r[2], r[2] + 1) for r in missing)
    # The plan piece's haplotype is the map source's (DESIGN_GRAPH_PRIMARY §2.6, G0), as a linear lift names it, so
    # a haplotype rule (``lift_hap``) and the rows' labels mean the same in both views; a native dataset has none.
    hap, labels = source_haplotype(dataset, contig)
    plan = _Plan(contig, size, spans, hap or binding, region)
    budget = LoadBudget(max_bytes=min(max_bytes, MAX_DECODED_BYTES))
    counts: dict = {}
    sampler = Sampler(0, only_ids=frozenset(r[1] for r in missing), exact_ids=True)
    decoded = decode_source_records(list(dataset.paths), plan, loader_options=LOADER_OPTIONS, budget=budget,
                                    counts=counts, sampler=sampler, include_supplementary=settings.load_supplementaries)
    a, b = plan.region
    rows = lift_compact_reads(decoded, plan, handle=None, region_start=a, region_end=b, settings=settings,
                              key=f"graph:{binding}", dataset_id=dataset.id, counts=counts,
                              loader_options=LOADER_OPTIONS,
                              molecule_groups=settings.molecule_group_map(list(dataset.paths), dataset.id))
    lib_of = {p: i for i, p in enumerate(dataset.paths)}

    def ident(lib, qname, start, end, sup):
        return (lib, qname, int(start), int(end), bool(sup))

    nbytes: dict = {}
    for read in decoded:
        k = ident(lib_of.get(read.get("source_path"), 0), read.get("id"), read.get("reference_start", 0),
                  read.get("reference_end", 0), (read.get("_fiberbrowser_primary") or {}).get("is_supplementary"))
        nbytes[k] = nbytes.get(k, 0) + decoded_size_estimate(read)
    composed: dict = {}
    lifted = getattr(dataset, "live_lift", None) is not None
    for row in rows:
        read = compact_full(row, a, dataset.id, binding)
        if lifted:
            read.update(row_identity(row, settings, labels))
        composed.setdefault(ident(read["lib"], read["q"], read["s"], read["e"], read["sup"]), []).append(read)
    entries: dict = {}
    hard_left = int(counts.get("hard_clipped_supplementary", 0))
    for rec in missing:
        lib, qname, start, flag, end, hard = rec
        k = ident(lib, qname, start, end, flag & 0x800)
        key = _record_key(base, rec)
        got = tuple(composed.get(k, ()))
        n = int((listed_n or {}).get(key, 1))
        if budget.truncated and len(got) < n:
            continue   # the batch stopped before every record of this identity: decoded again by a later request
        reason = None
        if not got:
            if k in nbytes:
                reason = "records_without_correspondence"
            elif hard and flag & 0x800 and hard_left > 0:
                reason, hard_left = "hard_clipped_supplementary", hard_left - 1
            else:
                reason = "loader_filters"
        # Records of the identity that composed to nothing while another one did (a duplicate the loader dropped).
        partial = max(0, n - len(got)) if got else 0
        entries[key] = (got, nbytes.get(k, 0), reason, _entry_bytes(got), partial if reason is None else max(0, n - 1))
    _records_put(entries)
    return entries, bool(budget.truncated), counts.get("hard_clipped_scoped"), len(decoded)


# ── Request ─────────────────────────────────────────────────────────────────

def _bad(message: str, code: str = "invalid_request", status: int = 422, **detail) -> ReadsError:
    return ReadsError(code, message, status, **detail)


def validate(state, reg, body: dict) -> list:
    """``[(dataset, binding dict, contig, windows, size)]`` of a reads request, or ReadsError."""
    datasets = body.get("datasets")
    paths = body.get("paths")
    if not isinstance(datasets, list) or not all(isinstance(d, dict) for d in datasets):
        raise _bad("datasets must list {dataset_id, revision}")
    if not isinstance(paths, list) or not all(isinstance(p, dict) for p in paths):
        raise _bad("paths must list {binding, windows}")
    if len(paths) > 4:
        raise _bad("at most four paths", "selection_limit", 413)
    windows_of: dict = {}
    total, n = 0, 0
    for p in paths:
        binding = reg.binding(str(p.get("binding")))
        if binding is None:
            raise _bad(f"unknown binding {p.get('binding')!r}")
        raw = p.get("windows")
        if not isinstance(raw, list) or not all(isinstance(w, dict) and isinstance(w.get("start"), int)
                                                and isinstance(w.get("end"), int) for w in raw):
            raise _bad("windows must be {start, end} integers")
        frags = _fragment_spans(binding)
        clipped = []
        for w in merge_windows((w["start"], w["end"]) for w in raw):
            for fa, fb in frags:  # never fetch outside the path's own fragments
                a, b = max(w[0], fa), min(w[1], fb)
                if b > a:
                    clipped.append((a, b))
        windows = merge_windows(clipped)
        total += sum(b - a for a, b in windows)
        n += len(windows)
        windows_of[binding["key"]] = (binding, windows)
    if total > MAX_SOURCE_BP or n > MAX_WINDOWS:
        raise _bad(f"the reads need {total:,} source bp in {n} windows (at most {MAX_SOURCE_BP:,} in {MAX_WINDOWS})",
                   "selection_limit", 413)
    known = {b["dataset_id"]: b for b in read_bindings(state, reg)}
    jobs = []
    for d in datasets:
        dataset_id = str(d.get("dataset_id"))
        bound = known.get(dataset_id)
        if bound is None or not bound["paths"]:
            # Not loaded, or its files went missing (a moved BAM): never an empty "no reads here".
            why = "; ".join((bound or {}).get("problems") or ())
            raise _bad(f"dataset {dataset_id!r} is not loaded or binds to no path of this graph{': ' + why if why else ''}",
                       "unknown_dataset", 404, problems=(bound or {}).get("problems") or [])
        if d.get("revision") and d["revision"] != bound["revision"]:
            raise _bad(f"dataset {dataset_id!r} changed since it was bound", "stale_dataset_revision", 409,
                       current=bound["revision"])
        dataset = state.datasets[dataset_id]
        for key, contig in bound["paths"].items():
            if key in windows_of and windows_of[key][1]:
                binding, windows = windows_of[key]
                size = binding.get("size") or windows[-1][1]
                jobs.append((dataset, binding, contig, windows, int(size)))
    return jobs


def _settings(dataset):
    from services.lift.live_lift import LiftSettings
    return dataset.live_lift.settings if getattr(dataset, "live_lift", None) is not None else LiftSettings()


def load(state, reg, body: dict, *, max_molecules: Optional[int] = None, max_marks: int = MAX_MARKS) -> dict:
    """The reads of a request (blocking; run it in a worker thread). ``max_molecules``: the request's molecule budget
    (default: the performance profile's ``sample_target``)."""
    budgets = profile_budgets(state)
    if budgets["records_bytes"] != _RECORDS_MAX_BYTES:
        _records_resize(budgets["records_bytes"])
    with _SharedBytes(min(MAX_DECODED_BYTES, budgets["decoded_bytes"])) as shared:
        return _load(state, reg, body, max_molecules=budgets["molecules"] if max_molecules is None else max_molecules,
                     max_marks=max_marks, max_bytes=shared.share, budgets={**budgets, "concurrent": shared.concurrent,
                                                                             "decoded_share": shared.share})


def _load(state, reg, body: dict, *, max_molecules: int, max_marks: int, max_bytes: int, budgets: dict) -> dict:
    from services.read_sampling import keeps, name_hash

    t0 = time.perf_counter()
    jobs = validate(state, reg, body)
    limits = body.get("limits") or {}
    if isinstance(limits.get("molecules"), int) and 0 < limits["molecules"] < max_molecules:
        max_molecules = limits["molecules"]
    if isinstance(limits.get("marks"), int) and 0 < limits["marks"] < max_marks:
        max_marks = limits["marks"]
    # Pins (graph primary G3): QNAMEs a host's members filter, select or highlight. Their records are kept at every
    # sampling level and their molecules come first under the cap, so a read kept in a linear view is drawn here too.
    raw_pins = body.get("pins") or []
    if not isinstance(raw_pins, list) or not all(isinstance(q, str) for q in raw_pins):
        raise _bad("pins must list QNAMEs")
    pins = frozenset(raw_pins[:MAX_PINS])
    # The windows' records from their headers: the sampling level (expected molecules at most the cap) is chosen
    # before any call is decoded; supplementaries the dataset does not load are counted as omitted here.
    estimated = 0
    known = True
    listed: list = []
    per_job: list = []
    not_loaded = 0
    t_list = time.perf_counter()
    for dataset, _binding, contig, windows, _size in jobs:
        recs = window_records(dataset, contig, windows)
        if recs is not None and not _settings(dataset).load_supplementaries:
            not_loaded += sum(1 for k in recs if k[3] & 0x800)
            recs = [k for k in recs if not k[3] & 0x800]
        listed.append(recs)
        if recs is None:
            known = False
            per_job.append(None)
        else:
            n_mol = len({(k[0], k[1]) for k in recs})
            per_job.append(n_mol)
            estimated += n_mol
    list_ms = (time.perf_counter() - t_list) * 1000
    # Each sub-band (dataset, path) samples at the level its own share of the molecules needs (§6.1).
    # (An explicit request limit is a total: no per-band floor above it.)
    explicit = isinstance(limits.get("molecules"), int) and 0 < limits["molecules"] <= max_molecules
    quotas = split_quota(max_molecules, per_job, 1 if explicit else MIN_BAND_MOLECULES)
    levels = []
    for est, q in zip(per_job, quotas):
        lvl = min(MAX_LEVEL, int(math.ceil(math.log2(est / max(1, q))))) if est is not None and est > q else 0
        if isinstance(limits.get("level"), int) and limits["level"] > lvl:
            lvl = min(MAX_LEVEL, limits["level"])
        levels.append(lvl)
    # (Tests and tools patch MAX_DECODED_BYTES: it stays the ceiling.)
    max_bytes = min(max_bytes, MAX_DECODED_BYTES)
    decode_ms = 0.0
    decoded_records = 0
    scoped: dict = {}

    def run(job, recs, lvl):
        """The job's kept records at ``lvl`` as cache entries, decoding the ones not cached yet: ``([(listed
        record, entry)], truncated, all cached)``."""
        nonlocal decode_ms, decoded_records
        dataset, binding, contig, windows, size = job
        kept = [k for k in recs or () if k[1] in pins or keeps(k[1], lvl)]
        base = (dataset.id, dataset_revision(dataset), binding["key"], contig, tuple(sorted(LOADER_OPTIONS.items())),
                WIRE_VERSION)
        keys = [_record_key(base, k) for k in kept]
        listed_n: dict = {}
        for key in keys:
            listed_n[key] = listed_n.get(key, 0) + 1
        have = _records_get(keys)
        missing, seen = [], set()
        for k, key in zip(kept, keys):
            if key not in have and key not in seen:
                seen.add(key)
                missing.append(k)
        truncated = False
        if missing:
            # The region holds the windows and every record they fetch whole, a base beyond either end (so a
            # terminal insertion's boundary is inside it): no call is clipped before composing. It is bounded by
            # the BAM's own contig length (one base past it: coordinates only), never by a graph binding's possibly
            # inferred size.
            size = contig_length(dataset, contig) or size
            region = (max(0, min([windows[0][0], *(k[2] for k in missing)]) - 1),
                      min(size + 1, max([windows[-1][1], *(k[4] for k in missing)]) + 1))
            t = time.perf_counter()
            got, truncated, sc, n_decoded = _decode_records(dataset, contig, size + 1, windows, binding["key"], missing,
                                                            region, base, listed_n, max_bytes)
            decode_ms += (time.perf_counter() - t) * 1000
            decoded_records += n_decoded
            for kk, vv in (sc or {}).items():
                scoped[kk] = scoped.get(kk, 0) + vv
            have.update(got)
        out, done = [], set()
        for k, key in zip(kept, keys):
            if key in have and key not in done:
                done.add(key)
                out.append((k, have[key]))
        # Identities a truncated batch never reached (still uncached): left out of this answer and reported.
        reached = {key for _k, key in zip(kept, keys) if key in have}
        return out, truncated, not missing, sum(n for key, n in listed_n.items() if key not in reached)

    # Bands over their share of the request's payload budget go one level sparser (by QNAME hash) until every
    # band's reads fit together; a band that fits its share keeps its level. A sparser level is a subset of the
    # records already decoded: only the first pass decodes.
    while True:
        results = [run(j, recs, lvl) for j, recs, lvl in zip(jobs, listed, levels)]
        need = [sum(entry[1] for _rec, entry in got) for got, _t, _c, _u in results]
        total_bytes = sum(need)
        if total_bytes <= max_bytes and not any(r[1] for r in results):
            break
        shares = band_bytes(need, max_bytes)
        over = [i for i, (n, sh) in enumerate(zip(need, shares)) if (n > sh or results[i][1]) and levels[i] < MAX_LEVEL]
        if not over:
            break
        for i in over:
            levels[i] += 1
    truncated = any(r[1] for r in results)
    level = max(levels, default=0)
    cached_all = all(r[2] for r in results)
    counts: dict = {}
    reads: list = []
    filtered = 0
    hide = {j[0].id: getattr(_settings(j[0]), "supplementary_display", "own_rows") == "hide" for j in jobs}
    over_budget = total_bytes > max_bytes   # even at the sparsest level: enforced below, reported
    unreached = sum(r[3] for r in results)
    for job, (got, _t, _c, _u) in zip(jobs, results):
        dataset, _binding, _contig, windows, _size = job
        seen = set()
        for rec, (rows, _nb, reason, _eb, extra) in got:
            # `extra`: further records of this identity with no row of their own (counted like the first one).
            if reason == "loader_filters":
                filtered += 1 + extra
                continue
            if reason:
                counts[reason] = counts.get(reason, 0) + 1 + extra
                continue
            filtered += extra
            for r in rows:
                if r["sup"] and hide[dataset.id]:
                    counts["supplementary_hidden"] = counts.get("supplementary_hidden", 0) + 1
                    continue
                if r["k"] in seen:
                    counts["record_collisions"] = counts.get("record_collisions", 0) + 1
                    continue
                seen.add(r["k"])
                reads.append(clip_to_windows(r, windows))   # copies: the cached read is never changed
    if not_loaded:
        counts["supplementary_not_loaded"] = not_loaded
    # Density strips (§6.2 L2): every row decoded at the band's level, before the cap and the mark budget.
    strips = []
    span_bp = sum(b - a for j in jobs for a, b in j[3]) / max(1, len(jobs))
    strip_bp = limits.get("strip_bp")
    if not (isinstance(strip_bp, int) and strip_bp > 0):
        strip_bp = max(10, int(span_bp // 1000) or 10)
    t_strip = time.perf_counter()
    by_job_rows: dict = {}
    for r in reads:
        by_job_rows.setdefault((r["d"], r["b"]), []).append(r)
    for job in jobs:
        dataset, binding, _contig, windows, _size = job
        total_bins = sum(int(math.ceil((b - a) / strip_bp)) for a, b in windows)
        bp = strip_bp if total_bins <= MAX_STRIP_BINS else int(math.ceil(sum(b - a for a, b in windows) / MAX_STRIP_BINS))
        strips.append({"dataset_id": dataset.id, "binding": binding["key"],
                       **density_strip(by_job_rows.get((dataset.id, binding["key"]), []), windows, bp)})
    strip_ms = (time.perf_counter() - t_strip) * 1000
    molecules = sorted({(r["d"], r["lib"], r["q"]) for r in reads}, key=lambda m: (m[2] not in pins, name_hash(str(m[2])), m))
    payload_dropped = 0
    if over_budget:
        # Whole molecules in hash order while their decoded size fits the request's budget; the rest are left out.
        size_of: dict = {}
        for r in reads:   # the decoded-size estimate of live_lift.decoded_size_estimate: a row plus 32 B per entry
            m = (r["d"], r["lib"], r["q"])
            size_of[m] = size_of.get(m, 0) + 512 + 32 * (marks_of(r) + len(r["cov"]) + len(r["ins"]) + len(r["dl"]))
        fit, used = set(), 0
        for m in molecules:
            if used + size_of[m] > max_bytes:
                continue
            fit.add(m)
            used += size_of[m]
        payload_dropped = len(molecules) - len(fit)
        reads = [r for r in reads if (r["d"], r["lib"], r["q"]) in fit]
        molecules = [m for m in molecules if m in fit]
        truncated = True
    capped = 0
    # Each band keeps its quota of molecules in this order; pinned molecules (first) never count against it. A
    # molecule kept by one band keeps its records in every band.
    job_of = {(j[0].id, j[1]["key"]): i for i, j in enumerate(jobs)}
    mols_of: list = [[] for _ in jobs]
    seen_m: list = [set() for _ in jobs]
    for r in reads:
        i = job_of.get((r["d"], r["b"]))
        m = (r["d"], r["lib"], r["q"])
        if i is not None and m not in seen_m[i]:
            seen_m[i].add(m)
            mols_of[i].append(m)
    rank_m = {m: i for i, m in enumerate(molecules)}
    keep: set = set()
    band_report = []
    for i, job in enumerate(jobs):
        ms = sorted(mols_of[i], key=rank_m.__getitem__)
        cap_i = quotas[i] + sum(1 for m in ms if m[2] in pins)
        keep.update(ms[:cap_i])
        band_report.append({"dataset_id": job[0].id, "binding": job[1]["key"], "estimated": per_job[i],
                            "quota": quotas[i], "level": levels[i], "fraction": 1.0 / (1 << levels[i]),
                            "decoded": len(ms), "capped": max(0, len(ms) - cap_i)})
    if len(keep) < len(molecules):
        capped = len(molecules) - len(keep)
        reads = [r for r in reads if (r["d"], r["lib"], r["q"]) in keep]
        molecules = [m for m in molecules if m in keep]
    for b in band_report:
        b["molecules"] = len({(r["d"], r["lib"], r["q"]) for r in reads if r["d"] == b["dataset_id"] and r["b"] == b["binding"]})
    # QNAMEs in more than one library of a dataset: kept apart by library.
    libs: dict = {}
    for d, lib, q in molecules:
        libs.setdefault((d, q), set()).add(lib)
    shared_qnames = sum(1 for s in libs.values() if len(s) > 1)
    # Marks: over the budget, m6A becomes density on every read (one rule for the view), in bins as fine as the
    # budget allows; if calls alone still pass it, the reads last in hash order keep their bodies only. Reported.
    order = {m: i for i, m in enumerate(molecules)}
    reads.sort(key=lambda r: (order[(r["d"], r["lib"], r["q"])], r["b"], r["s"], r["k"]))
    density_reads, density_bp = 0, None
    if sum(marks_of(r) for r in reads) > max_marks:
        ticks = [r.pop("m6a", None) or [] for r in reads]
        calls_n = sum(marks_of(r) for r in reads)
        bin_bp = 50
        while True:
            bins = sum(len({p // bin_bp for p in t}) for t in ticks)
            if calls_n + bins <= max_marks or bin_bp >= 10_000:
                break
            bin_bp *= 2
        for r, t in zip(reads, ticks):
            if t:
                r["m6a"] = t
                m6a_density(r, bin_bp)
                density_reads += 1
        density_bp = bin_bp
    marks = 0
    for r in reads:
        n = marks_of(r)
        if marks + n > max_marks:
            for name in (*_LAYERS, "m6a_density"):
                r.pop(name, None)
            r["calls_omitted"] = True
            n = 0
        marks += n
    omitted = {k: counts[k] for k in ("hard_clipped_supplementary", "supplementary_hidden", "supplementary_not_loaded",
                                      "record_collisions", "records_without_correspondence") if counts.get(k)}
    if filtered:
        omitted["loader_filters"] = filtered
    if payload_dropped:
        omitted["payload_limit"] = payload_dropped           # molecules
    if unreached:
        omitted["records_not_reached"] = unreached           # record identities a truncated decode never reached
    report = {
        "molecules": len(molecules), "records": len(reads), "marks": marks,
        "sampling": {"level": level, "fraction": 1.0 / (1 << level), "estimated": estimated if known else None,
                     "molecules_capped": capped, "max_molecules": max_molecules},
        "bands": band_report,
        "budgets": {"profile": budgets.get("effective"), "molecules": max_molecules, "decoded_bytes": max_bytes,
                    "concurrent_loads": budgets.get("concurrent", 1), "marks": max_marks},
        "m6a_density_reads": density_reads, "m6a_density_bp": density_bp,
        "calls_omitted_reads": sum(1 for r in reads if r.get("calls_omitted")),
        "truncated": truncated, "decoded_bytes": total_bytes,
        "omitted": omitted, "shared_qnames": shared_qnames, "pinned": len({m for m in molecules if m[2] in pins}),
        "hard_clipped_scoped": scoped or None,   # of the records this request decoded
    }
    return {"reads": reads, "report": report, "cached": cached_all, "strips": strips,
            "bindings": [{"dataset_id": j[0].id, "binding": j[1]["key"], "contig": j[2],
                          "windows": [{"start": a, "end": b} for a, b in j[3]]} for j in jobs],
            "timings": {"total_ms": round((time.perf_counter() - t0) * 1000, 1), "list_ms": round(list_ms, 1),
                        "decode_ms": round(decode_ms, 1), "records_decoded": decoded_records,
                          "strip_ms": round(strip_ms, 1)}}
