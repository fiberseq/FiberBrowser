"""Pick a random genomic window that has read coverage.

Useful for sparse/targeted data (e.g. DAF-seq) where most of the genome is
empty: jump straight to a region that actually has data, at the current zoom.
Windows are anchored on real reads/entries (so coverage is guaranteed > 0) and
validated against a minimum depth before being returned.

Only reads the browser can show are searched: on contigs of the loaded
reference (by name, alias or plasmid link) and within its length. When the
data has reads but none of them are on the loaded reference (a dm6 BAM with
hg38 loaded), the search stops at once with ``reason: "contig_mismatch"``;
a dataset without mapped reads answers ``reason: "no_reads"``. Every search
has a time budget, checked between reads of the files (one read of a
blocked remote file is not interrupted), so it always ends.
"""
from __future__ import annotations

import math
import os
import random
import time
from dataclasses import dataclass
from typing import Callable, Optional

from services.bam_handles import get_bam_handle
from services.bigbed_handles import get_bigbed_handle
from services.read_coverage import compute_binned_read_coverage
from utils.chrom import get_chrom_variants

MAX_COVERAGE_BINS = 2000
# Wall-clock budget of one search (seconds): it returns what it found by then.
SEARCH_BUDGET_S = 20.0
# Records examined when looking for a primary read to anchor on (a contig
# whose reads are all secondary/supplementary is not scanned to the end).
MAX_ANCHOR_SCAN = 5000


@dataclass(frozen=True)
class _Contig:
    """One contig of one file that has data on the loaded reference."""
    path: str
    contig: str
    weight: float  # mapped reads (BAM) or length (BigBed, or BAM without index stats)
    size: int      # searchable length: the file's, capped at the reference's


@dataclass
class _Scope:
    """Where each dataset's reads are that the browser can show."""
    contigs: dict           # dataset id -> list[_Contig]
    with_data: list         # datasets that have any mapped reads/entries at all
    data_contigs: list      # a few contig names with data (for the message)


def _linked_chrom(state, contig: str, datasets) -> Optional[str]:
    """The chromosome a dataset's contig is shown on in this workspace (a plasmid link)."""
    from services.plasmid_reconcile import contig_links
    for dataset in datasets or ():
        target = contig_links(state, dataset_id=getattr(dataset, "id", None)).get(contig)
        if target:
            return target
    return None


def _state_chrom_names(state) -> list:
    chroms = getattr(state, "chroms", None) or []
    names = [getattr(c, "name", None) or (c.get("name") if isinstance(c, dict) else None) for c in chroms]
    return [n for n in names if n]


def _resolve_state_chrom(state, contig: str) -> str:
    """Map a BAM/BigBed reference name to the chromosome name the browser uses."""
    names = _state_chrom_names(state)
    if contig in names:
        return contig
    contig_variants = set(get_chrom_variants(contig))
    for name in names:
        if name in contig_variants or contig in set(get_chrom_variants(name)):
            return name
    return contig


def _reference_loaded(state) -> bool:
    """A genome/FASTA (or plasmid maps) is loaded: without one, the chromosome
    list is only the first dataset's header, and every dataset is shown in its
    own coordinates."""
    return (getattr(state, "fasta", None) is not None or bool(getattr(state, "current_genome", None))
            or bool(getattr(state, "plasmid_sequences", None)))


def _reference_sizes(state) -> Optional[dict]:
    """``{name: length}`` of the loaded reference's chromosomes (None: nothing loaded)."""
    if not _reference_loaded(state):
        return None
    out: dict = {}
    for c in getattr(state, "chroms", None) or []:
        name = getattr(c, "name", None) or (c.get("name") if isinstance(c, dict) else None)
        size = getattr(c, "size", None) if not isinstance(c, dict) else c.get("size")
        if name:
            try:
                out[name] = int(size or 0)
            except (TypeError, ValueError):
                out[name] = 0
    return out or None


def _reference_resolver(state, ref_sizes: Optional[dict]) -> Callable[[str, object], Optional[tuple]]:
    """``(contig, dataset) -> (chromosome, its length or 0)`` on the loaded reference, or None."""
    if ref_sizes is None:
        return lambda contig, _dataset: (contig, 0)
    by_variant: dict = {}
    for name in ref_sizes:
        for variant in get_chrom_variants(name):
            by_variant.setdefault(variant, name)

    def resolve(contig: str, dataset) -> Optional[tuple]:
        linked = _linked_chrom(state, contig, [dataset]) if dataset is not None else None
        if linked:
            return linked, 0  # a plasmid link: the file's own length applies
        if contig in ref_sizes:
            return contig, ref_sizes[contig]
        for variant in get_chrom_variants(contig):
            if variant in by_variant:
                name = by_variant[variant]
                return name, ref_sizes[name]
        return None
    return resolve


def _bam_contigs(path: str):
    """[(contig, weight, file length)] of one BAM's contigs that have mapped reads."""
    bam = get_bam_handle(path)
    if bam is None:
        return []
    try:
        stats = list(bam.get_index_statistics())
    except Exception:
        stats = None
    out = []
    if stats is not None:
        for s in stats:
            if int(getattr(s, "mapped", 0) or 0) <= 0:
                continue
            try:
                size = int(bam.get_reference_length(s.contig) or 0)
            except Exception:
                size = 0
            out.append((s.contig, float(s.mapped), size))
        return out
    # No index statistics (some CRAM/remote indexes): every contig may hold reads.
    for contig in getattr(bam, "references", None) or ():
        try:
            size = int(bam.get_reference_length(contig) or 0)
        except Exception:
            size = 0
        if size > 0:
            out.append((contig, float(size), size))
    return out


def _bigbed_contigs(path: str):
    bb = get_bigbed_handle(path)
    if bb is None:
        return []
    try:
        chroms = bb.chroms() or {}
    except Exception:
        chroms = {}
    return [(name, float(size), int(size)) for name, size in chroms.items() if size and size > 0]


def _search_scope(state, datasets) -> _Scope:
    ref_sizes = _reference_sizes(state)
    resolve = _reference_resolver(state, ref_sizes)
    scope = _Scope(contigs={}, with_data=[], data_contigs=[])
    for dataset in datasets:
        kind = getattr(dataset, "data_type", None)
        reader = _bam_contigs if kind == "bam" else _bigbed_contigs if kind == "bigbed" else None
        if reader is None:
            continue
        usable: list = []
        has_data = False
        for path in dataset.paths or []:
            for contig, weight, size in reader(path):
                has_data = True
                if len(scope.data_contigs) < 6 and contig not in scope.data_contigs:
                    scope.data_contigs.append(contig)
                hit = resolve(contig, dataset)
                if hit is None:
                    continue
                ref_len = hit[1]
                searchable = min(size, ref_len) if ref_len > 0 and size > 0 else (size or ref_len)
                if searchable > 0:
                    usable.append(_Contig(path, contig, weight, int(searchable)))
        if has_data:
            scope.with_data.append(dataset)
        if usable:
            scope.contigs[getattr(dataset, "id", None)] = usable
    return scope


def _genome_label(state) -> Optional[str]:
    genome = getattr(state, "current_genome", None)
    if genome:
        return str(genome)
    path = getattr(state, "fasta_path", None)
    return os.path.basename(str(path)) if path else None


def _datasets_label(datasets) -> str:
    if len(datasets) == 1:
        d = datasets[0]
        return str(getattr(d, "label", None) or getattr(d, "id", None) or "this dataset")
    return "the loaded datasets"


def _no_reachable_reads(state, datasets, scope: _Scope) -> Optional[dict]:
    """The definite answer when nothing can be found, before any sampling (else None)."""
    if any(scope.contigs.get(getattr(d, "id", None)) for d in datasets):
        return None
    label = _datasets_label(datasets)
    if not scope.with_data:
        return {"success": False, "reason": "no_reads", "error": f"No reads found in {label}."}
    genome = _genome_label(state)
    where = f"the loaded genome ({genome})" if genome else "the loaded reference"
    return {
        "success": False,
        "reason": "contig_mismatch",
        "genome": genome,
        "dataset_contigs": list(scope.data_contigs),
        "error": f"No reads from {label} map to {where}.",
    }


def _place_window(pos: int, span: int, chrom_size: int) -> tuple[int, int]:
    """Center a `span`-wide window on `pos`, clamped within [0, chrom_size]."""
    if chrom_size <= span:
        return 0, chrom_size
    start = pos - span // 2
    start = max(0, min(start, chrom_size - span))
    return start, start + span


def _pick(contigs: list, rng) -> _Contig:
    """A contig, weighted by its reads."""
    total = sum(c.weight for c in contigs)
    target = rng.random() * total
    acc = 0.0
    for c in contigs:
        acc += c.weight
        if target <= acc:
            return c
    return contigs[-1]


def _sample_bam_anchor(contigs: list, rng) -> Optional[tuple[str, int, int]]:
    chosen = _pick(contigs, rng)
    bam = get_bam_handle(chosen.path)
    if bam is None:
        return None
    contig, size = chosen.contig, chosen.size
    offset = int(rng.random() * size)

    def _first_read(start):
        try:
            for seen, read in enumerate(bam.fetch(contig, start, size)):
                if seen >= MAX_ANCHOR_SCAN:
                    return None
                if read.is_unmapped or read.is_secondary or read.is_supplementary:
                    continue
                if int(read.reference_start) >= size:
                    return None
                return read
        except Exception:
            return None
        return None

    read = _first_read(offset) or _first_read(0)
    if read is None:
        return None
    rstart = int(read.reference_start)
    rend = min(size, int(read.reference_end or rstart + 1))
    # Use the random offset directly when it is covered (good spread on dense
    # data); otherwise it fell in a gap, so anchor inside the nearest read.
    anchor = offset if rstart <= offset < rend else rstart + int(rng.random() * max(1, rend - rstart))
    return contig, anchor, size


def _sample_bigbed_anchor(contigs: list, rng, span_hint: int) -> Optional[tuple[str, int, int]]:
    chosen = _pick(contigs, rng)
    bb = get_bigbed_handle(chosen.path)
    if bb is None:
        return None
    contig, size = chosen.contig, chosen.size
    offset = int(rng.random() * size)
    window_end = min(offset + max(1, span_hint), size)
    try:
        entries = bb.entries(contig, offset, window_end) or bb.entries(contig, 0, size) or []
    except Exception:
        entries = []
    if not entries:
        return None
    covering = any(int(e[0]) <= offset < int(e[1]) for e in entries)
    if covering:
        anchor = offset
    else:
        entry = entries[int(rng.random() * len(entries))]
        es, ee = int(entry[0]), min(int(entry[1]), size)
        anchor = es + int(rng.random() * max(1, ee - es))
    return contig, min(anchor, size - 1), size


def _sample_anchor(dataset, rng, span_hint: int, contigs: Optional[list] = None) -> Optional[tuple[str, int, int]]:
    """(contig, position, searchable contig length) on one of the dataset's reads."""
    kind = getattr(dataset, "data_type", None)
    if contigs is None:  # no reference check (callers outside a search)
        reader = _bam_contigs if kind == "bam" else _bigbed_contigs if kind == "bigbed" else None
        contigs = [_Contig(p, c, w, s) for p in (dataset.paths or []) if reader
                   for c, w, s in reader(p) if s > 0]
    if not contigs:
        return None
    if kind == "bam":
        return _sample_bam_anchor(contigs, rng)
    if kind == "bigbed":
        return _sample_bigbed_anchor(contigs, rng, span_hint)
    return None


def _search_datasets(state, dataset_id: Optional[str], dataset_ids: Optional[list] = None) -> list:
    if dataset_id:
        ds = state.get_dataset(dataset_id)
        datasets = [ds] if ds else []
    else:
        wanted = state.dataset_order if dataset_ids is None else [d for d in state.dataset_order if d in set(dataset_ids)]
        datasets = [state.get_dataset(d) for d in wanted]
        datasets = [d for d in datasets if d]
    from services.lift.capability import require_all
    require_all(datasets, "random_window")  # Classify the resolved scope before dropping unsupported file types.
    return [d for d in datasets if getattr(d, "data_type", None) in ("bam", "bigbed") and (d.paths or [])]


def random_covered_window(
    state,
    *,
    span: int,
    min_coverage: int = 1,
    dataset_id: Optional[str] = None,
    seed: Optional[int] = None,
    max_attempts: int = 60,
    budget_s: float = SEARCH_BUDGET_S,
    dataset_ids: Optional[list] = None,
) -> dict:
    """Return a random window of width `span` whose peak read depth >= min_coverage.

    `dataset_ids` limits the search to those datasets (default: all of them).
    """
    deadline = time.monotonic() + budget_s  # from entry: the contig scan counts too
    span = max(1, int(span))
    min_coverage = max(1, int(min_coverage))

    datasets = _search_datasets(state, dataset_id, dataset_ids)
    if not datasets:
        return {"success": False, "reason": "no_datasets",
                "error": "No BAM/BigBed datasets loaded to sample coverage from."}
    scope = _search_scope(state, datasets)
    nothing = _no_reachable_reads(state, datasets, scope)
    if nothing:
        return nothing
    searchable = [d for d in datasets if scope.contigs.get(getattr(d, "id", None))]

    rng = random.Random(seed)
    bins = min(MAX_COVERAGE_BINS, span)

    for attempt in range(1, max_attempts + 1):
        if time.monotonic() > deadline:
            return {"success": False, "reason": "timeout",
                    "error": f"No window with reads found within {budget_s:g} s."}
        dataset = rng.choice(searchable)
        anchor = _sample_anchor(dataset, rng, span, scope.contigs[getattr(dataset, "id", None)])
        if anchor is None:
            continue
        contig, pos, chrom_size = anchor
        w_start, w_end = _place_window(pos, span, chrom_size)
        if w_end <= w_start:
            continue

        result = compute_binned_read_coverage(
            datasets,
            contig,
            w_start,
            w_end,
            min(bins, max(1, w_end - w_start)),
            bam_handle_getter=get_bam_handle,
            bigbed_handle_getter=get_bigbed_handle,
        )
        max_cov = int(result.get("max", 0))
        if max_cov >= min_coverage:
            return {
                "success": True,
                "chrom": _linked_chrom(state, contig, [dataset]) or _resolve_state_chrom(state, contig),
                "start": int(w_start),
                "end": int(w_end),
                "max_coverage": max_cov,
                "attempts": attempt,
            }

    return {
        "success": False,
        "reason": "not_found",
        "error": f"No window with coverage >= {min_coverage} found after {max_attempts} tries.",
    }


from services.byte_cache import shared_cache
_TOP_WINDOW_CACHE = shared_cache('indexes')


def top_covered_windows(
    state,
    *,
    span: int,
    dataset_id: Optional[str] = None,
    n: int = 20,
    samples: int = 160,
    seed: int = 17,
    budget_s: float = SEARCH_BUDGET_S,
    fit: bool = False,
) -> dict:
    """The best-covered windows of width `span`, deepest first (at most `n`, not overlapping).

    ``fit``: size each window to the reads in it (with a margin) so going there
    shows them: an amplicon's reads (sharing their ends) get their extent,
    narrower or wider than `span`; other reads only narrow a window they cover
    much less of (short reads), never widen it (long reads keep the zoom).

    Positions are sampled across the data (contigs weighted by their reads,
    landing on reads), and each is refined to the densest `span`-wide window in
    its neighborhood. Deterministic for a given dataset, span and seed, so the
    ranking is stable while you step through it. Only the loaded reference's
    contigs are searched, within its lengths, and for at most ``budget_s``.
    """
    deadline = time.monotonic() + budget_s  # from entry: the contig scan counts too
    span = max(1, int(span))
    n = max(1, min(100, int(n)))
    datasets = _search_datasets(state, dataset_id)
    if not datasets:
        return {"success": False, "reason": "no_datasets",
                "error": "No BAM/BigBed datasets loaded to rank coverage from.", "windows": []}
    scope = _search_scope(state, datasets)
    nothing = _no_reachable_reads(state, datasets, scope)
    if nothing:
        return {**nothing, "windows": []}

    # Candidates are cached with raw contig names (the state's aliases are
    # applied per request) and independent of n; the searchable contigs (the
    # loaded reference) are part of the key.
    reach = tuple(sorted((str(getattr(d, "id", "")), c.path, c.contig, c.size)
                         for d in datasets for c in scope.contigs.get(getattr(d, "id", None), ())))
    key = (tuple(sorted(tuple(d.paths) for d in datasets)), reach, span, samples, seed)
    candidates = _TOP_WINDOW_CACHE.get(key)
    complete = True
    if candidates is None:
        candidates, complete = _top_window_candidates(datasets, span, samples, seed, scope=scope,
                                                      deadline=deadline)
        if complete:
            _TOP_WINDOW_CACHE[key] = candidates

    names: dict = {}

    def shown_as(contig: str) -> str:
        # Datasets naming a contig differently ('chr1' / '1') are one contig.
        if contig not in names:
            names[contig] = _linked_chrom(state, contig, datasets) or _resolve_state_chrom(state, contig) or contig
        return names[contig]

    chosen: list[tuple[float, str, int, int, str]] = []
    windows = []
    for depth, contig, w_start, w_end in candidates:
        chrom = shown_as(contig)
        if any(chrom == c[1] and w_start < c[3] and c[2] < w_end for c in chosen):
            continue
        window = {"chrom": chrom, "start": w_start, "end": w_end, "depth": round(depth, 1)}
        if fit:
            fitted = _fit_window_to_reads(datasets, scope, contig, w_start, w_end, span)
            if fitted is not None:
                # Windows inside one long amplicon fit to the same one: keep it once.
                if any(chrom == c[1] and fitted[0] < c[3] and c[2] < fitted[1] for c in chosen):
                    continue
                window["start"], window["end"] = fitted
                window["fitted"] = True
        chosen.append((depth, chrom, window["start"], window["end"], contig))
        windows.append(window)
        if len(chosen) >= n:
            break
    out = {
        "success": bool(chosen),
        "windows": windows,
    }
    if not complete:
        out["partial"] = True
    if not chosen:
        if complete:
            genome = _genome_label(state)
            where = f" on the loaded genome ({genome})" if genome else ""
            out.update(reason="not_found",
                       error=f"No reads found from {_datasets_label(datasets)}{where}.")
        else:
            out.update(reason="timeout", error=f"No covered windows found within {budget_s:g} s.")
    return out


# A fitted window: the reads' extent (robust to a few stragglers) plus a
# margin of this fraction of it on each side, at least FIT_MIN_MARGIN bp.
FIT_MARGIN = 0.1
FIT_MIN_MARGIN = 100
# Reads looked at per window when fitting (enough to see an amplicon's ends).
FIT_MAX_READS = 20_000
# Widest window an amplicon's reads are fitted to (wider: keep the span).
FIT_MAX_WIDTH = 100_000


def _fit_window_to_reads(datasets, scope: Optional[_Scope], contig: str, start: int, end: int,
                         span: int) -> Optional[tuple[int, int]]:
    """(start, end) around the reads overlapping [start, end) when they cover
    clearly less than `span`; None to keep the window as it is."""
    starts: list[int] = []
    ends: list[int] = []
    size = 0
    for dataset in datasets:
        contigs = scope.contigs.get(getattr(dataset, "id", None), ()) if scope is not None else ()
        for c in contigs:
            if c.contig != contig:
                continue
            size = max(size, int(c.size or 0))
            kind = getattr(dataset, "data_type", None)
            try:
                if kind == "bam":
                    bam = get_bam_handle(c.path)
                    if bam is None:
                        continue
                    from services.graph_lift import lift_hidden_predicate
                    hidden = lift_hidden_predicate(getattr(bam, "header", None))
                    for read in bam.fetch(contig, max(0, start), max(start + 1, end)):
                        if read.is_unmapped or read.is_secondary or read.is_supplementary:
                            continue
                        if hidden is not None and hidden(read):
                            continue
                        starts.append(int(read.reference_start))
                        ends.append(int(read.reference_end or read.reference_start + 1))
                        if len(starts) >= FIT_MAX_READS:
                            break
                elif kind == "bigbed":
                    bb = get_bigbed_handle(c.path)
                    for entry in (bb.entries(contig, max(0, start), max(start + 1, end)) or []) if bb is not None else []:
                        starts.append(int(entry[0]))
                        ends.append(int(entry[1]))
                        if len(starts) >= FIT_MAX_READS:
                            break
            except Exception:
                continue
    if not starts:
        return None
    lengths = sorted(e - s for s, e in zip(starts, ends))
    starts.sort()
    ends.sort()
    trim = len(starts) // 50  # the outer 2% at each end
    lo = starts[trim]
    hi = ends[len(ends) - 1 - trim]
    extent = hi - lo
    if extent <= 0:
        return None
    # Amplicon-like: the reads share their ends (start positions spread far
    # less than a read is long), so the window is their extent, wider or
    # narrower than span. Otherwise (fragments tiling the region, long reads)
    # only narrow a window the reads cover much less of.
    decile = len(starts) // 10
    start_spread = starts[len(starts) - 1 - decile] - starts[decile]
    median_length = lengths[len(lengths) // 2]
    amplicon = len(starts) >= 3 and start_spread < 0.5 * median_length and extent <= FIT_MAX_WIDTH
    if not amplicon and extent >= 0.8 * span:
        return None
    margin = max(FIT_MIN_MARGIN, int(round(extent * FIT_MARGIN)))
    fitted_start = max(0, lo - margin)
    fitted_end = hi + margin
    if size > 0:
        fitted_end = min(size, fitted_end)
    if not amplicon and fitted_end - fitted_start >= span:
        return None
    if (fitted_start, fitted_end) == (start, end):
        return None
    return int(fitted_start), int(fitted_end)


def _densest_pair(values: list) -> tuple[float, int]:
    """Score and index j of the adjacent bins j, j+1 with the most coverage."""
    best, best_i = -1.0, 0
    for j in range(max(1, len(values) - 1)):
        score = values[j] + (values[j + 1] if j + 1 < len(values) else 0)
        if score > best:
            best, best_i = score, j
    return best, best_i


def _top_window_candidates(datasets, span: int, samples: int, seed: int, *, scope: Optional[_Scope] = None,
                           deadline: Optional[float] = None) -> tuple[list[tuple[float, str, int, int]], bool]:
    """(depth, contig, start, end) of the densest window near each sampled position, deepest
    first, and whether every sample was tried before ``deadline``."""
    rng = random.Random(seed)
    all_datasets = list(datasets)  # coverage counts every dataset's reads
    if scope is not None:  # samples land on the reads the reference can show
        datasets = [d for d in datasets if scope.contigs.get(getattr(d, "id", None))] or all_datasets
    # Half-window bins: the best window is the densest pair of adjacent bins.
    neighborhood = int(min(max(span * 10, 20_000), 200_000))
    half = max(1, span // 2)
    candidates: list[tuple[float, str, int, int]] = []
    complete = True
    from services.background_work import checkpoint
    for i in range(samples):
        if deadline is not None and time.monotonic() > deadline:
            complete = False
            break
        checkpoint()  # a client that went away stops the search
        dataset = datasets[i % len(datasets)]
        contigs = scope.contigs.get(getattr(dataset, "id", None)) if scope is not None else None
        anchor = _sample_anchor(dataset, rng, span, contigs) if contigs is not None else _sample_anchor(dataset, rng, span)
        if anchor is None:
            continue
        contig, pos, chrom_size = anchor
        lo, hi = _place_window(pos, max(neighborhood, span), chrom_size)
        values: list = []
        best_i = 0
        # Bins are capped at 400, so for a small span they can be much wider
        # than half a window; narrow in on the densest pair until they aren't,
        # so the depth is measured where the window actually is.
        for _level in range(4):
            bins = max(2, min(400, (hi - lo) // half))
            result = compute_binned_read_coverage(
                all_datasets, contig, lo, hi, bins,
                bam_handle_getter=get_bam_handle, bigbed_handle_getter=get_bigbed_handle,
            )
            values = result.get("coverage") or []
            if not values:
                break
            best, best_i = _densest_pair(values)
            bin_size = (hi - lo) / len(values)
            if best <= 0 or bin_size <= half * 1.5 or _level == 3:
                break  # (lo, hi) still match `values`
            lo, hi = int(lo + best_i * bin_size), int(math.ceil(lo + (best_i + 2) * bin_size))
        if not values or _densest_pair(values)[0] <= 0:
            continue
        bin_size = (hi - lo) / len(values)
        centre = int(lo + (best_i + 1) * bin_size)
        w_start, w_end = _place_window(centre, span, chrom_size)
        depth = max(values[best_i], values[best_i + 1] if best_i + 1 < len(values) else 0)
        candidates.append((float(depth), contig, int(w_start), int(w_end)))
    candidates.sort(key=lambda c: -c[0])
    return candidates, complete
