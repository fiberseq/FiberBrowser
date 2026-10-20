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

**Composition.** Every bound (dataset, path) decodes its topology windows once
(``live_lift.decode_source_records``: the lifted loader options, hard-clip scope,
duplicates, supplementary records) and composes them with ``lift_compact_reads``
through one identity piece over the source contig. Whole calls, call identities
(``call_id``, ``call_parts``), the explicit-channel precedence and legacy
nucleosome/MSP inference are the linear composer's, in source coordinates,
before any node slicing. The browser cuts the composed calls at the visits and
at the read's coverage holes (``cov``); nothing is inferred there.

**Budgets** (§7): at most 300 molecules, 100,000 mark primitives and 8 MiB of
decoded reads per request. Molecules are sampled by QNAME hash *before*
decoding (``read_sampling.Sampler``; a load that would still pass 8 MiB is
retried one level sparser), then capped in hash order; marks beyond the budget
become m6A density. Every omission is reported, never silent. Topology and
selected paths are never reduced for reads.
"""
from __future__ import annotations

import hashlib
import math
import os
import threading
import time
from collections import OrderedDict
from typing import Iterable, Optional

MAX_MOLECULES = 300
MAX_MARKS = 100_000
MAX_DECODED_BYTES = 8 * 1024 * 1024
MAX_SOURCE_BP = 400_000
MAX_WINDOWS = 64
MAX_LEVEL = 8
# Loader options of a graph read load (the lifted load fixes the rest; compose infers the legacy layers).
LOADER_OPTIONS = dict(include_methylation=True, ml_threshold=125, include_layers=True, include_layer_qualities=True,
                      hide_terminal_gaps=True, include_cigar=False, include_duplicates=False,
                      sv_min_len=50)
_LAYERS = ("nuc", "tf", "msp")


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
        if not binding.get("size_inferred") and binding.get("size") is not None and int(src.get("size") or -1) != int(binding["size"]):
            problems.append(f"{name}: the map's source size {src.get('size')} is not the graph path's {binding['size']}")
            continue
        frags = sorted((int(f["offset"]), int(f["offset"]) + int(f["len"])) for f in src.get("fragments") or ())
        if frags and frags != _fragment_spans(binding):
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
                    "paths": paths, "problems": problems, "libraries": len(dataset.paths)})
    return out


# ── Composition ─────────────────────────────────────────────────────────────

class _Plan:
    """The fetch plan shape ``decode_source_records``/``lift_compact_reads`` read: one contig, its windows,
    one identity piece over the whole contig (source coordinates are kept)."""

    def __init__(self, contig: str, size: int, windows: list, hap: str):
        from services.lift.live_lift import ContigFetch, LiftPiece, PieceSelection
        piece = LiftPiece(0, 0, int(size), 0, int(size), "+", True, hap, contig)
        a, b = windows[0][0], windows[-1][1]
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


def window_records(dataset, contig: str, windows: list) -> Optional[set]:
    """The records the windows hold, by an index walk over record headers (no tag decoding): ``{(library, QNAME,
    start, flag)}``. Their count is the molecule count's upper bound that picks the sampling level before any call
    is decoded; the names give how many records the loader's own filters then left out."""
    import pysam
    out = set()
    for lib, path in enumerate(dataset.paths):
        try:
            with pysam.AlignmentFile(path, "rb") as bam:
                if contig not in bam.references:
                    continue
                for a, b in windows:
                    for rec in bam.fetch(contig, a, b):
                        if rec.is_unmapped or rec.is_secondary or rec.is_qcfail or rec.is_duplicate:
                            continue
                        out.add((lib, rec.query_name, rec.reference_start, rec.flag))
        except (OSError, ValueError):
            return None
    return out


def _abs_layer(layer: Optional[dict], ids, parts, origin: int, name: str) -> Optional[dict]:
    if not layer or not layer.get("intervals"):
        return None
    names = list(layer.get("quality_names") or ())
    quals = layer.get("qualities") or []
    out = {"iv": [[int(a) + origin, int(b) + origin, int(s)] for a, b, s, *_ in layer["intervals"]],
           "id": list(ids or [None] * len(layer["intervals"])), "part": list(parts or [None] * len(layer["intervals"]))}
    for qn, track in zip(names, quals):
        if track is not None and qn in ("nq", "lq", "rq", "aq", "tq", "el", "er", "q0"):
            out[qn] = list(track)
    if name == "msp" and all(i is None for i in out["id"]):
        out["inferred"] = True
    return out


def compact_row(row: dict, origin: int, dataset_id: str, binding: str) -> dict:
    """A composed row (relative to ``origin``) as the graph wire form, in absolute source coordinates."""
    ll = row["live_lift"]
    calls, parts = ll.get("calls") or {}, ll.get("call_parts") or {}
    spans = sorted(ll.get("molecular_spans") or ())
    cov = [[int(t0) + origin, int(t1) + origin, int(m0), int(step)] for t0, t1, m0, step, *_ in spans]
    ins = []
    for (a0, a1, m0, step), (b0, _b1, n0, _s) in zip(cov, cov[1:]):
        expected = m0 + step * (a1 - a0)
        extra = (n0 - expected) * step
        if extra > 0:
            ins.append([b0 if b0 == a1 else a1, int(extra), int(expected if step > 0 else n0 + 1)])
    src = ll.get("source") or {}
    layers = row.get("layers") or {}
    out = {
        "k": f"{dataset_id}|{ll.get('library', 0)}|{row.get('id')}|{ll.get('record')}",
        "d": dataset_id, "lib": int(ll.get("library", 0)), "q": row.get("id"), "rec": ll.get("record"),
        "b": binding, "c": src.get("contig"), "st": "-" if row.get("alignment_orientation") == "reverse" else "+",
        "sup": bool(src.get("supplementary")), "s": int(src.get("start", 0)), "e": int(src.get("end", 0)),
        "cov": cov, "ins": ins,
    }
    for name in _LAYERS:
        layer = _abs_layer(layers.get(name), calls.get(f"layer:{name}"), parts.get(f"layer:{name}"), origin, name)
        if layer is not None:
            out[name] = layer
    m6a = row.get("methyl_m6a")
    if m6a:
        out["m6a"] = [int(p) + origin for p in m6a]
    return out


def marks_of(read: dict) -> int:
    return sum(len((read.get(n) or {}).get("iv") or ()) for n in _LAYERS) + len(read.get("m6a") or ())


def m6a_density(read: dict, bin_bp: int) -> None:
    """Replace a read's m6A ticks by counts per ``bin_bp`` bin: ``[[start, end, count], ...]``."""
    points = read.pop("m6a", None) or []
    bins: dict = {}
    for p in points:
        b = (p // bin_bp) * bin_bp
        bins[b] = bins.get(b, 0) + 1
    if bins:
        read["m6a_density"] = [[b, b + bin_bp, n] for b, n in sorted(bins.items())]


def _decode(dataset, contig: str, size: int, windows: list, binding: str, level: int, counts: dict):
    """Decoded and composed rows of one (dataset, path) at a sampling level; ``(reads, truncated)``."""
    from services.lift.compose import lift_compact_reads
    from services.lift.live_lift import LiftSettings, LoadBudget, decode_source_records
    from services.read_sampling import Sampler

    settings = dataset.live_lift.settings if getattr(dataset, "live_lift", None) is not None else LiftSettings()
    plan = _Plan(contig, size, windows, binding)
    budget = LoadBudget(max_bytes=MAX_DECODED_BYTES)
    sampler = Sampler(level) if level > 0 else None
    decoded = decode_source_records(list(dataset.paths), plan, loader_options=LOADER_OPTIONS, budget=budget,
                                    counts=counts, sampler=sampler, include_supplementary=settings.load_supplementaries)
    a = windows[0][0]
    rows = lift_compact_reads(decoded, plan, handle=None, region_start=a, region_end=windows[-1][1], settings=settings,
                              key=f"graph:{binding}", dataset_id=dataset.id, counts=counts,
                              loader_options=LOADER_OPTIONS,
                              molecule_groups={p: dataset.id for p in dataset.paths})
    hide_supplementary = getattr(settings, "supplementary_display", "own_rows") == "hide"
    out, seen = [], set()
    for row in rows:
        ll = row.get("live_lift") or {}
        if hide_supplementary and (ll.get("source") or {}).get("supplementary"):
            counts["supplementary_hidden"] = counts.get("supplementary_hidden", 0) + 1
            continue
        read = compact_row(row, a, dataset.id, binding)
        if read["k"] in seen:
            counts["record_collisions"] = counts.get("record_collisions", 0) + 1
            continue
        seen.add(read["k"])
        out.append(read)
    counts["records_decoded"] = counts.get("records_decoded", 0) + len(decoded)
    return out, bool(budget.truncated)


# ── Cache ───────────────────────────────────────────────────────────────────

_CACHE: "OrderedDict[tuple, tuple]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 48


def _cached(key, build):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit, True
    value = build()
    with _CACHE_LOCK:
        _CACHE[key] = value
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return value, False


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


# ── Request ─────────────────────────────────────────────────────────────────

def _bad(message: str, code: str = "invalid_request", status: int = 422, **detail) -> ReadsError:
    return ReadsError(code, message, status, **detail)


def validate(state, reg, body: dict) -> list:
    """``[(dataset, binding dict, contig, windows)]`` of a reads request, or ReadsError."""
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
        if bound is None:
            raise _bad(f"dataset {dataset_id!r} is not loaded or binds to no path of this graph", "unknown_dataset", 404)
        if d.get("revision") and d["revision"] != bound["revision"]:
            raise _bad(f"dataset {dataset_id!r} changed since it was bound", "stale_revision", 409,
                       current=bound["revision"])
        dataset = state.datasets[dataset_id]
        for key, contig in bound["paths"].items():
            if key in windows_of and windows_of[key][1]:
                binding, windows = windows_of[key]
                size = binding.get("size") or windows[-1][1]
                jobs.append((dataset, binding, contig, windows, int(size)))
    return jobs


def load(state, reg, body: dict, *, max_molecules: int = MAX_MOLECULES, max_marks: int = MAX_MARKS) -> dict:
    """The reads of a request (blocking; run it in a worker thread)."""
    from services.read_sampling import name_hash

    t0 = time.perf_counter()
    jobs = validate(state, reg, body)
    limits = body.get("limits") or {}
    if isinstance(limits.get("molecules"), int) and 0 < limits["molecules"] < max_molecules:
        max_molecules = limits["molecules"]
    if isinstance(limits.get("marks"), int) and 0 < limits["marks"] < max_marks:
        max_marks = limits["marks"]
    # One sampling level for the request: expected molecules at most the cap, before any decoding.
    estimated = 0.0
    known = True
    listed: list = []
    for dataset, _binding, contig, windows, _size in jobs:
        recs = window_records(dataset, contig, windows)
        listed.append(recs)
        if recs is None:
            known = False
        else:
            estimated += len(recs)
    level = 0
    if known and estimated > max_molecules:
        level = min(MAX_LEVEL, int(math.ceil(math.log2(estimated / max_molecules))))
    if isinstance(limits.get("level"), int) and limits["level"] > level:
        level = min(MAX_LEVEL, limits["level"])
    counts: dict = {}
    reads: list = []

    def run(job):
        dataset, binding, contig, windows, size = job
        lvl = level
        hit_all = True
        while True:
            key = (dataset.id, dataset_revision(dataset), binding["key"], contig, tuple(map(tuple, windows)), lvl,
                   tuple(sorted(LOADER_OPTIONS.items())))
            part_counts: dict = {}

            def build():
                got, trunc = _decode(dataset, contig, size, windows, binding["key"], lvl, part_counts)
                return got, trunc, dict(part_counts)

            (got, trunc, c), hit = _cached(key, build)
            hit_all = hit_all and hit
            if trunc and lvl < MAX_LEVEL:
                lvl += 1  # sparser before decoding past the payload budget
                continue
            return got, trunc, c, lvl, hit_all

    # One path after another: decoding is Python-bound, so threads would not overlap it.
    results = [run(j) for j in jobs]
    cached_all = all(r[4] for r in results) if results else True
    # Records the loader's own filters (signal, footprint, hard-clip scope) left out: listed and kept by the sample,
    # yet not decoded. Reported, never silent.
    from services.read_sampling import keeps as _keeps
    filtered = 0
    for recs, (got_decoded, _t, c, lvl, _h) in zip(listed, results):
        if recs is not None:
            expected = sum(1 for _lib, q, _s, _f in recs if _keeps(q, lvl))
            filtered += max(0, expected - int(c.get("records_decoded", 0)) - int(c.get("hard_clipped_supplementary", 0)))
    truncated = any(r[1] for r in results)
    for got, _trunc, c, lvl, _hit in results:
        level = max(level, lvl)
        for k, v in c.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                counts[k] = counts.get(k, 0) + v
            elif isinstance(v, dict):  # e.g. hard_clipped_scoped: {partial, whole, none}
                into = counts.setdefault(k, {})
                for kk, vv in v.items():
                    if isinstance(vv, (int, float)) and not isinstance(vv, bool):
                        into[kk] = into.get(kk, 0) + vv
        reads.extend(got)
    # A sparser level for one path applies to all (one deterministic sample by QNAME hash).
    from services.read_sampling import keeps
    if level:
        before = len(reads)
        reads = [r for r in reads if keeps(str(r["q"]), level)]
        counts["sampled_out_after_retry"] = before - len(reads)
    molecules = sorted({(r["d"], r["lib"], r["q"]) for r in reads}, key=lambda m: (name_hash(str(m[2])), m))
    capped = 0
    if len(molecules) > max_molecules:
        keep = set(molecules[:max_molecules])
        capped = len(molecules) - max_molecules
        reads = [r for r in reads if (r["d"], r["lib"], r["q"]) in keep]
        molecules = molecules[:max_molecules]
    # QNAMEs in more than one library of a dataset: kept apart by library.
    libs: dict = {}
    for d, lib, q in molecules:
        libs.setdefault((d, q), set()).add(lib)
    shared_qnames = sum(1 for s in libs.values() if len(s) > 1)
    # Marks: over the budget, m6A becomes density on every read (one rule for the whole view); if calls alone still
    # pass it, the reads last in hash order keep their bodies only. Both are reported.
    order = {m: i for i, m in enumerate(molecules)}
    reads.sort(key=lambda r: (order[(r["d"], r["lib"], r["q"])], r["b"], r["s"], r["k"]))
    density_reads = 0
    if sum(marks_of(r) for r in reads) > max_marks:
        for r in reads:
            if r.get("m6a"):
                m6a_density(r, 50)
                density_reads += 1
    marks = 0
    for r in reads:
        n = marks_of(r) + len(r.get("m6a_density") or ())
        if marks + n > max_marks:
            for name in _LAYERS:
                r.pop(name, None)
            r["calls_omitted"] = True
            n = len(r.get("m6a_density") or ())
        marks += n
    report = {
        "molecules": len(molecules), "records": len(reads), "marks": marks,
        "sampling": {"level": level, "fraction": 1.0 / (1 << level), "estimated": round(estimated) if known else None,
                     "molecules_capped": capped, "max_molecules": max_molecules},
        "m6a_density_reads": density_reads, "calls_omitted_reads": sum(1 for r in reads if r.get("calls_omitted")),
        "truncated": truncated,
        "omitted": {**{k: counts[k] for k in ("hard_clipped_supplementary", "supplementary_hidden", "record_collisions",
                                              "records_without_correspondence", "sampled_out_after_retry")
                       if counts.get(k)}, **({"loader_filters": filtered} if filtered else {})},
        "shared_qnames": shared_qnames,
        "hard_clipped_scoped": counts.get("hard_clipped_scoped"),
    }
    return {"reads": reads, "report": report, "cached": cached_all,
            "bindings": [{"dataset_id": j[0].id, "binding": j[1]["key"], "contig": j[2],
                          "windows": [{"start": a, "end": b} for a, b in j[3]]} for j in jobs],
            "timings": {"total_ms": round((time.perf_counter() - t0) * 1000, 1)}}
