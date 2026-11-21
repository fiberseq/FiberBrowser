"""FiberHMM per-read variant and structural-event bigBeds (``fiberhmm-extract``).

Two BED12+ tables, grouped into a sample's dataset like its footprint / MSP /
TF / m6A layers (autoSQL table name, ``Sample: <name>.`` tag, joined on read id):

``fiberhmm_var``: one row per read covering at least one site of a VCF
    (more rows, same name, when its sites overlap: bigBed blocks can't).
    name = read id; chromStart/End = its first block's start and last block's
    end. One block per site (block size = REF allele length). Extra columns: ``blockAllele``
    (k >= 0: VCF allele index, 0 = REF; -1 another base; -2 deleted; -3
    ambiguous because of DAF conversion), ``blockBq`` (base quality, -1 none),
    optional ``hp`` / ``ps`` (-1 absent).

``fiberhmm_sv``: one row per alignment record with at least one event
    (supplementaries are their own rows; more rows when events overlap).
    Blocks: a deletion's deleted span; an insertion's anchor base (the
    reference base before it); a left clip's first and a right clip's last
    aligned base. Extra
    columns: ``blockType`` (0 DEL, 1 INS, 2 CLIP_LEFT, 3 CLIP_RIGHT),
    ``blockLen``, ``mapq``, ``readLen``, ``flag``, ``sa`` (SA tag or "."),
    optional ``hp`` / ``ps``.

Both end with FiberHMM's ``isDuplicate``; columns are looked up by their
autoSQL names. A row's span is its blocks' hull, not the read's alignment:
where a read's extent matters (which reads span an SV without it), it comes
from the sample's footprint / MSP / TF rows of the same read id.

Nothing here runs when a dataset merely has these layers: ``fiberhmm-extract
--all`` writes them routinely, so they are read only when a view asks (the
Variants panel's scans, the SV split, or the read rows' overlay toggled on).

Events come out in the schema ``services/sv_events.py`` gives BAM reads
(``{'t': 'D'|'I'|'S'|'SA', ...}``, absolute 0-based reference coordinates), so
the SV band, the per-read marks, clustering and the carrier / reference split
are the BAM ones. Variant sites come out as the Variants panel's SNP entries,
so its table, SNP channel, splits and groups are the BAM ones too.

Lift: rows can be mapped through any interval mapper (``map_interval`` /
``source_intervals``, e.g. ``ChainMapper`` for a UCSC chain). A block that does
not lift is dropped together with its per-block columns, so a site keeps its
allele and an event its type and length.
"""
from __future__ import annotations

import gzip
import os
import re
import threading
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Optional, Sequence

VAR_LAYER = "var"
SV_LAYER = "sv"
VARIANT_LAYER_TYPES = (VAR_LAYER, SV_LAYER)

ALLELE_OTHER = -1
ALLELE_DELETED = -2
ALLELE_AMBIGUOUS = -3

SV_DEL, SV_INS, SV_CLIP_LEFT, SV_CLIP_RIGHT = 0, 1, 2, 3

FLAG_REVERSE = 0x10
FLAG_SECONDARY = 0x100
FLAG_QCFAIL = 0x200
FLAG_DUPLICATE = 0x400
FLAG_SUPPLEMENTARY = 0x800

# A read row overlay is cut to views at most this wide (the read rows draw
# events only up to a few hundred kb anyway).
MAX_SPAN = 2_000_000


class VariantLayerError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Rows

def _ints(text: str) -> Optional[list[int]]:
    text = (text or "").strip().rstrip(",")
    if not text or text == ".":
        return []
    try:
        return [int(x) for x in text.split(",") if x != ""]
    except ValueError:
        return None


@dataclass
class VarRow:
    read_id: str
    chrom: str
    start: int
    end: int
    strand: str
    # (pos, ref_len, allele, bq) per site, ascending
    sites: list = field(default_factory=list)
    hp: int = -1
    ps: int = -1
    duplicate: bool = False


@dataclass
class SvRow:
    read_id: str
    chrom: str
    start: int
    end: int
    strand: str
    # (type, pos, block_size, length) per event
    events: list = field(default_factory=list)
    mapq: int = 0
    read_len: int = 0
    flag: int = 0
    sa: str = "."
    hp: int = -1
    ps: int = -1
    duplicate: bool = False

    @property
    def supplementary(self) -> bool:
        return bool(self.flag & FLAG_SUPPLEMENTARY)

    @property
    def secondary(self) -> bool:
        return bool(self.flag & FLAG_SECONDARY)

    @property
    def reverse(self) -> bool:
        return bool(self.flag & FLAG_REVERSE) if self.flag else self.strand == "-"


def _blocks(start: int, fields: list[str]) -> Optional[list[tuple[int, int]]]:
    """(absolute start, size) of a BED12 row's blocks; ``fields`` start at name."""
    if len(fields) < 9:
        return None
    try:
        count = int(fields[6])
    except ValueError:
        return None
    sizes, starts = _ints(fields[7]), _ints(fields[8])
    if sizes is None or starts is None or len(sizes) != count or len(starts) != count:
        return None
    return [(start + s, z) for s, z in zip(starts, sizes)]


# Positions (in pyBigWig's ``rest`` split on tabs, i.e. from ``name`` on) of the
# extra columns, by autoSQL field name; these are the documented orders, used
# when a file's autoSQL can't be read. Named lookup keeps a later extra column
# (FiberHMM's ``isDuplicate``, circular fields) from shifting hp / ps.
VAR_DEFAULT_FIELDS = {"blockAllele": 9, "blockBq": 10, "hp": 11, "ps": 12}
SV_DEFAULT_FIELDS = {"blockType": 9, "blockLen": 10, "mapq": 11, "readLen": 12, "flag": 13, "sa": 14,
                     "hp": 15, "ps": 16}
_field_cache: dict = {}


def file_fields(path: Optional[str], layer: str) -> dict:
    """``{field name: index into rest}`` from a file's autoSQL (cached), else the defaults."""
    default = VAR_DEFAULT_FIELDS if layer == VAR_LAYER else SV_DEFAULT_FIELDS
    if not path:
        return default
    if path in _field_cache:
        return _field_cache[path]
    result = default
    try:
        from services.bigbed_detection import _autosql_table_and_fields, _read_bigbed_autosql
        sql = _read_bigbed_autosql(path)
        if sql:
            _table, names = _autosql_table_and_fields(sql)
            # _autosql_table_and_fields reads plain "type name;" lines; array fields
            # ("int[blockCount] blockAllele;") match too.
            index = {name: i - 3 for i, name in enumerate(names) if i >= 3}
            if all(k in index for k in default if k not in ("hp", "ps")):
                result = {k: index[k] for k in (*default, "isDuplicate") if k in index}
    except Exception:
        result = default
    _field_cache[path] = result
    return result


def _col(fields: list[str], index: Optional[int]) -> Optional[str]:
    return fields[index] if index is not None and 0 <= index < len(fields) else None


def _col_int(fields: list[str], index: Optional[int], default: int = -1) -> int:
    value = _col(fields, index)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def parse_var_row(chrom: str, start: int, end: int, rest: str, names: Optional[dict] = None) -> Optional[VarRow]:
    """A ``fiberhmm_var`` row (pyBigWig ``entries`` form), or None when malformed
    (the per-block columns must have one value per block)."""
    names = names or VAR_DEFAULT_FIELDS
    fields = rest.split("\t")
    blocks = _blocks(int(start), fields)
    allele_col = _col(fields, names.get("blockAllele"))
    if blocks is None or allele_col is None:
        return None
    alleles, bqs = _ints(allele_col), _ints(_col(fields, names.get("blockBq")) or "")
    if alleles is None or len(alleles) != len(blocks):
        return None
    if bqs is None or len(bqs) != len(blocks):
        bqs = [-1] * len(blocks)
    sites = sorted((pos, size, a, q) for (pos, size), a, q in zip(blocks, alleles, bqs))
    return VarRow(fields[0], chrom, int(start), int(end), fields[2] if fields[2] in "+-" else ".", sites,
                  _col_int(fields, names.get("hp")), _col_int(fields, names.get("ps")),
                  _col_int(fields, names.get("isDuplicate"), 0) == 1)


def parse_sv_row(chrom: str, start: int, end: int, rest: str, names: Optional[dict] = None) -> Optional[SvRow]:
    """A ``fiberhmm_sv`` row, or None when malformed."""
    names = names or SV_DEFAULT_FIELDS
    fields = rest.split("\t")
    blocks = _blocks(int(start), fields)
    type_col, len_col = _col(fields, names.get("blockType")), _col(fields, names.get("blockLen"))
    if blocks is None or type_col is None or len_col is None:
        return None
    types, lengths = _ints(type_col), _ints(len_col)
    if types is None or lengths is None or len(types) != len(blocks) or len(lengths) != len(blocks):
        return None
    events = [(t, pos, size, n) for (pos, size), t, n in zip(blocks, types, lengths)
              if t in (SV_DEL, SV_INS, SV_CLIP_LEFT, SV_CLIP_RIGHT)]
    events.sort(key=lambda e: (e[1], e[0]))
    sa = (_col(fields, names.get("sa")) or ".").strip() or "."
    return SvRow(fields[0], chrom, int(start), int(end), fields[2] if fields[2] in "+-" else ".", events,
                 _col_int(fields, names.get("mapq"), 0), _col_int(fields, names.get("readLen"), 0),
                 _col_int(fields, names.get("flag"), 0), sa,
                 _col_int(fields, names.get("hp")), _col_int(fields, names.get("ps")),
                 _col_int(fields, names.get("isDuplicate"), 0) == 1)


def sv_row_events(row: SvRow, *, min_len: int = 0, link_split: bool = True) -> list[dict]:
    """A row's events in the ``sv_events`` schema (absolute coordinates). Its SA
    segments come too unless ``link_split`` is off."""
    from services.sv_events import parse_sa_tag

    out: list[dict] = []
    for t, pos, size, length in row.events:
        if t == SV_DEL:
            n = length if length > 0 else size
            if n >= min_len:
                out.append({"t": "D", "ref": pos, "len": n, "q": -1})
        elif t == SV_INS:
            # The block is the anchor base; sv_events puts an insertion before reference base ``ref``.
            if length >= min_len:
                out.append({"t": "I", "ref": pos + 1, "len": length, "q": -1})
        elif length >= min_len:
            side = "L" if t == SV_CLIP_LEFT else "R"
            # sv_events: an L clip sits at the alignment start (the block: first aligned base), an R clip at its
            # end (the block: last aligned base).
            ref = pos if side == "L" else pos + 1
            out.append({"t": "S", "side": side, "ref": ref, "len": length, "q": -1})
    out.sort(key=lambda ev: (ev["ref"], ev["t"]))
    if link_split and row.sa not in ("", "."):
        out.extend(parse_sa_tag(row.sa, supplementary=row.supplementary, read_reverse=row.reverse))
    return out


# ---------------------------------------------------------------------------
# Lift

def lift_blocks(chrom: str, blocks: Sequence[tuple[int, int]], columns: Sequence[Sequence],
                map_interval: Callable) -> tuple[Optional[str], list[tuple[int, int]], list[list], list[int]]:
    """Blocks ``(abs start, size)`` and their per-block ``columns`` through
    ``map_interval(chrom, start, end) -> (chrom, start, end) | None``.

    A block that fails to lift, or lands on another chromosome than the
    first lifted block, is dropped with its value in every column. Returns
    (target chrom, lifted blocks, lifted columns, indices kept), blocks sorted
    by their lifted start (columns follow)."""
    kept = []
    target = None
    for i, (pos, size) in enumerate(blocks):
        hit = map_interval(chrom, pos, pos + max(1, size))
        if hit is None:
            continue
        tchrom, a, b = hit
        if target is None:
            target = tchrom
        elif tchrom != target:
            continue
        kept.append((a, max(0, b - a) if size else 0, i))
    kept.sort()
    return (target, [(a, z) for a, z, _ in kept],
            [[col[i] for _a, _z, i in kept] for col in columns], [i for _a, _z, i in kept])


def _lift_span(chrom, start, end, map_interval, target, lifted_blocks):
    """A row's lifted span: its own span when it lifts whole onto ``target``,
    else the hull of its lifted blocks."""
    hit = map_interval(chrom, start, end)
    if hit is None or hit[0] != target:
        # A read across a gap of the map: its two ends, each lifted on its own.
        left, right = map_interval(chrom, start, start + 1), map_interval(chrom, end - 1, end)
        if left is not None and right is not None and left[0] == right[0] == target:
            hit = (target, min(left[1], right[1]), max(left[2], right[2]))
    if hit is not None and hit[0] == target:
        a, b = hit[1], hit[2]
        if lifted_blocks:
            a = min(a, lifted_blocks[0][0])
            b = max(b, max(p + max(1, z) for p, z in lifted_blocks))
        return a, b
    if not lifted_blocks:
        return None
    return lifted_blocks[0][0], max(p + max(1, z) for p, z in lifted_blocks)


def lift_var_row(row: VarRow, map_interval: Callable) -> Optional[VarRow]:
    """A var row on the target assembly; sites that fail to lift are dropped
    with their allele and base quality. None when no site lifts."""
    blocks = [(p, z) for p, z, _a, _q in row.sites]
    target, lifted, (alleles, bqs), _kept = lift_blocks(
        row.chrom, blocks, [[s[2] for s in row.sites], [s[3] for s in row.sites]], map_interval)
    if target is None or not lifted:
        return None
    span = _lift_span(row.chrom, row.start, row.end, map_interval, target, lifted)
    if span is None:
        return None
    return replace(row, chrom=target, start=span[0], end=span[1],
                   sites=[(p, z, a, q) for (p, z), a, q in zip(lifted, alleles, bqs)])


def lift_sa(sa: str, map_interval: Callable) -> str:
    """An SA tag on the target assembly: each segment's position (1-based) lifted, a
    segment whose position fails to lift dropped; ``.`` when none is left."""
    if not sa or sa in (".", ""):
        return sa
    out = []
    for entry in sa.rstrip(";").split(";"):
        parts = entry.split(",")
        if len(parts) < 2:
            continue
        try:
            pos0 = int(parts[1]) - 1
        except ValueError:
            continue
        hit = map_interval(parts[0], pos0, pos0 + 1)
        if hit is None:
            continue
        out.append(",".join([hit[0], str(hit[1] + 1), *parts[2:]]))
    return ";".join(out) + ";" if out else "."


def lift_sv_row(row: SvRow, map_interval: Callable) -> Optional[SvRow]:
    """An SV row on the target assembly; events whose block fails to lift are
    dropped with their type and length. A deletion keeps its source length
    (the read's own deleted bases). None when the span and every event fail."""
    blocks = [(p, z) for _t, p, z, _n in row.events]
    target, lifted, (types, lengths), _kept = lift_blocks(
        row.chrom, blocks, [[e[0] for e in row.events], [e[3] for e in row.events]], map_interval)
    sa = lift_sa(row.sa, map_interval)  # its segments on the target assembly too
    if target is None:
        hit = map_interval(row.chrom, row.start, row.end)
        if hit is None:
            return None
        return replace(row, chrom=hit[0], start=hit[1], end=hit[2], events=[], sa=sa)
    span = _lift_span(row.chrom, row.start, row.end, map_interval, target, lifted)
    if span is None:
        return None
    events = [(t, p, z, n) for (p, z), t, n in zip(lifted, types, lengths)]
    return replace(row, chrom=target, start=span[0], end=span[1], events=events, sa=sa)


def lift_bed12_fields(chrom: str, start: int, end: int, fields: list[str], map_interval: Callable,
                      per_block_columns: Sequence[int] = ()) -> Optional[tuple[str, int, int, list[str]]]:
    """A BED12+ row (``fields`` from name on, pyBigWig ``rest`` split on tabs)
    lifted block by block; ``per_block_columns``: indices (into ``fields``) of
    comma lists with one value per block, kept aligned with the blocks."""
    blocks = _blocks(int(start), fields)
    if blocks is None:
        return None
    cols = [[x for x in fields[i].rstrip(",").split(",")] if i < len(fields) else [] for i in per_block_columns]
    cols = [c if len(c) == len(blocks) else ["."] * len(blocks) for c in cols]
    target, lifted, lifted_cols, _kept = lift_blocks(chrom, blocks, cols, map_interval)
    if target is None or not lifted:
        return None
    span = _lift_span(chrom, int(start), int(end), map_interval, target, lifted)
    if span is None:
        return None
    a, b = span
    out = list(fields)
    out[6] = str(len(lifted))
    out[7] = ",".join(str(max(1, z)) for _p, z in lifted) + ","
    out[8] = ",".join(str(p - a) for p, _z in lifted) + ","
    if len(out) > 5:
        out[4], out[5] = str(a), str(b)  # thickStart / thickEnd
    for i, col in zip(per_block_columns, lifted_cols):
        if i < len(out):
            out[i] = ",".join(col) + ","
    return target, a, b, out


class ChainMapper:
    """A UCSC ``.chain`` (liftOver) as an interval mapper.

    ``map_interval(chrom, start, end)``: source -> target, liftOver style: both
    ends inside aligned blocks of the same chain, on the target strand of that
    chain (a '-' chain reverses), or None. ``source_intervals(chrom, start,
    end)``: the source pieces a target window draws from (to fetch rows).
    In UCSC terms the chain's *target* is the source assembly here (the reads'
    coordinates) and its *query* the assembly drawn."""

    def __init__(self, path: str):
        self.path = path
        self._by_source: dict[str, list] = {}
        self._by_target: dict[str, list] = {}
        opener = gzip.open if str(path).endswith(".gz") else open
        chain = None
        with opener(path, "rt") as handle:
            for line in handle:
                parts = line.split()
                if not parts:
                    continue
                if parts[0] == "chain":
                    tname, tstart = parts[2], int(parts[5])
                    qname, qsize, qstrand, qstart = parts[7], int(parts[8]), parts[9], int(parts[10])
                    chain = {"t": tname, "q": qname, "qsize": qsize, "strand": qstrand, "blocks": [],
                             "tpos": tstart, "qpos": qstart}
                    self._by_source.setdefault(tname, []).append(chain)
                    self._by_target.setdefault(qname, []).append(chain)
                    continue
                if chain is None:
                    continue
                size = int(parts[0])
                chain["blocks"].append((chain["tpos"], chain["qpos"], size))
                chain["tpos"] += size
                chain["qpos"] += size
                if len(parts) >= 3:
                    chain["tpos"] += int(parts[1])
                    chain["qpos"] += int(parts[2])
        for chains in self._by_source.values():
            for c in chains:
                c["tstarts"] = [b[0] for b in c["blocks"]]

    def _point(self, chain, pos: int) -> Optional[int]:
        import bisect
        i = bisect.bisect_right(chain["tstarts"], pos) - 1
        if i < 0:
            return None
        t0, q0, size = chain["blocks"][i]
        if pos >= t0 + size:
            return None
        q = q0 + (pos - t0)
        return q if chain["strand"] == "+" else chain["qsize"] - 1 - q

    def map_interval(self, chrom: str, start: int, end: int):
        for chain in self._by_source.get(chrom, ()):
            a = self._point(chain, int(start))
            b = self._point(chain, int(end) - 1)
            if a is None or b is None:
                continue
            lo, hi = min(a, b), max(a, b) + 1
            return chain["q"], lo, hi
        return None

    def source_intervals(self, chrom: str, start: int, end: int) -> list[tuple[str, int, int]]:
        out = []
        for chain in self._by_target.get(chrom, ()):
            for t0, q0, size in chain["blocks"]:
                if chain["strand"] == "+":
                    qa, qb = q0, q0 + size
                else:
                    qa, qb = chain["qsize"] - q0 - size, chain["qsize"] - q0
                lo, hi = max(qa, int(start)), min(qb, int(end))
                if lo >= hi:
                    continue
                if chain["strand"] == "+":
                    sa, sb = t0 + (lo - qa), t0 + (hi - qa)
                else:
                    sa, sb = t0 + (qb - hi), t0 + (qb - lo)
                out.append((chain["t"], sa, sb))
        merged: list = []
        for c, a, b in sorted(out):
            if merged and merged[-1][0] == c and a <= merged[-1][2]:
                merged[-1] = (c, merged[-1][1], max(b, merged[-1][2]))
            else:
                merged.append((c, a, b))
        return merged


# ---------------------------------------------------------------------------
# Datasets

def _layer_of(path: str) -> Optional[str]:
    from services.bigbed_detection import detect_bigbed_autosql_type
    try:
        return detect_bigbed_autosql_type(path)
    except Exception:
        return None


def layer_paths(dataset, layer: str) -> list[str]:
    """The dataset's files of one variant layer (companions, or its own files)."""
    if dataset is None or getattr(dataset, "data_type", None) != "bigbed":
        return []
    out: list[str] = []
    companions = (getattr(dataset, "companion_layers", None) or {}).get(layer) or []
    for p in companions if isinstance(companions, (list, tuple)) else [companions]:
        if p not in out:
            out.append(p)
    if getattr(dataset, "layer_type", None) == layer:
        for p in getattr(dataset, "paths", None) or []:
            if p not in out and _layer_of(p) == layer:
                out.append(p)
    return out


def has_layer(dataset, layer: str) -> bool:
    return bool(layer_paths(dataset, layer))


def tidy_dataset_layers(dataset) -> None:
    """Variant layers are not read-row layers: keep them out of the layer list
    (they have their own toggles), in ``companion_layers`` only."""
    available = getattr(dataset, "available_layers", None)
    if isinstance(available, dict):
        for layer in VARIANT_LAYER_TYPES:
            available.pop(layer, None)
        if not available and getattr(dataset, "layer_type", None) in VARIANT_LAYER_TYPES:
            available["footprint"] = True


def strip_variant_paths(paths: Iterable[str]) -> list[str]:
    """``paths`` without variant-layer files (they are never read as footprint rows)."""
    return [p for p in paths if _layer_of(p) not in VARIANT_LAYER_TYPES]


def _lift_of(dataset):
    return getattr(dataset, "fiberhmm_variant_lift", None)


def set_lift(dataset, mapper) -> None:
    """Draw this dataset's variant layers through ``mapper`` (None: as stored)."""
    dataset.fiberhmm_variant_lift = mapper
    clear_cache()


# ---------------------------------------------------------------------------
# Row fetch (cached per file, window and lift)

_CACHE: "OrderedDict[tuple, list]" = OrderedDict()
_CACHE_MAX = 64
_LOCK = threading.Lock()


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()
        _qcfail_cache.clear()


def _stamp(path: str):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _entries(path: str, chrom: str, start: int, end: int) -> tuple[Optional[str], list]:
    from services.bigbed_bounds import bigbed_entries_in_bounds
    from services.bigbed_handles import get_bigbed_handle
    from utils.chrom import get_chrom_variants

    bw = get_bigbed_handle(path)
    if bw is None:
        return None, []
    chroms = bw.chroms() or {}
    actual = next((v for v in get_chrom_variants(chrom) if v in chroms), None)
    if actual is None:
        return None, []
    return actual, bigbed_entries_in_bounds(bw, actual, max(0, int(start)), int(end), chroms) or []


def fetch_rows(path: str, layer: str, chrom: str, start: int, end: int, mapper=None) -> list:
    """Parsed rows of one file overlapping ``[start, end)`` (target coordinates
    when ``mapper`` lifts; malformed rows skipped)."""
    key = (path, _stamp(path), layer, chrom, int(start), int(end), id(mapper) if mapper is not None else None)
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    names = file_fields(path, layer)
    base_parse = parse_var_row if layer == VAR_LAYER else parse_sv_row

    def parse(c, s_, e_, rest):
        return base_parse(c, s_, e_, rest, names)

    rows = []
    if mapper is None:
        actual, entries = _entries(path, chrom, start, end)
        for s, e, rest in entries:
            row = parse(actual, s, e, rest)
            if row is not None:
                rows.append(row)
        # Report coordinates under the requested chromosome name.
        for row in rows:
            row.chrom = chrom
    else:
        lift = lift_var_row if layer == VAR_LAYER else lift_sv_row
        seen = set()
        for schrom, sa, sb in mapper.source_intervals(chrom, start, end):
            actual, entries = _entries(path, schrom, sa, sb)
            for s, e, rest in entries:
                ident = (actual, s, e, rest)
                if ident in seen:
                    continue
                seen.add(ident)
                row = parse(schrom, s, e, rest)
                if row is None:
                    continue
                lifted = lift(row, mapper.map_interval)
                if lifted is not None and lifted.end > start and lifted.start < end:
                    rows.append(lifted)
    with _LOCK:
        _CACHE[key] = rows
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return rows


def dataset_rows(dataset, layer: str, chrom: str, start: int, end: int) -> list:
    out = []
    for path in layer_paths(dataset, layer):
        out.extend(fetch_rows(path, layer, chrom, start, end, _lift_of(dataset)))
    return out


# ---------------------------------------------------------------------------
# VCF alleles (optional: the source VCF next to the bigBed)

_VCF_NAME_RE = re.compile(r"([\w.+\-]+\.(?:vcf(?:\.gz)?|bcf))\b", re.IGNORECASE)
_vcf_cache: dict = {}


_VCF_NOTE_RE = re.compile(r"VCF:\s*name=([^;\s]+)", re.IGNORECASE)
_VCF_SAMPLE_RE = re.compile(r"VCF:[^\"]*?sample=([^;\s]+?)\.?(?:\s|$)", re.IGNORECASE)


def source_vcf_name(path: str) -> Optional[str]:
    """The VCF basename the autoSQL description names (FiberHMM's
    ``VCF: name=<basename>; md5=<hex>; sample=<name|*>.`` marker), if any."""
    from services.bigbed_detection import _read_bigbed_autosql
    sql = _read_bigbed_autosql(path) or ""
    match = _VCF_NOTE_RE.search(sql) or _VCF_NAME_RE.search(sql)
    return match.group(1) if match else None


def source_vcf_sample(path: str) -> Optional[str]:
    """The VCF sample the var layer was restricted to (None: every site, ``*``)."""
    from services.bigbed_detection import _read_bigbed_autosql
    match = _VCF_SAMPLE_RE.search(_read_bigbed_autosql(path) or "")
    value = match.group(1) if match else None
    return None if value in (None, "*") else value


def _vcf_path(path: str) -> Optional[str]:
    """The source VCF named in the var file's ``VCF: name=`` marker, in the var file's
    folder: a plain file name only (no folder parts), and on a lab server only when this
    request may read it and its index (services/lab/paths.py)."""
    if path in _vcf_cache:
        found = _vcf_cache[path]
    else:
        found = None
        name = source_vcf_name(path)
        if (name and not re.match(r"^[a-z]+://", str(path)) and name == os.path.basename(name)
                and "/" not in name and "\\" not in name and name not in (".", "..")):
            candidate = os.path.join(os.path.dirname(os.path.abspath(path)), name)
            if os.path.isfile(candidate):
                found = candidate
        _vcf_cache[path] = found
    if found is None:
        return None
    from services.lab.paths import readable
    indexes = [found + ext for ext in (".tbi", ".csi") if os.path.exists(found + ext)]
    if not readable(found) or not readable(os.path.realpath(found)) or not all(readable(i) for i in indexes):
        return None  # a lab server: outside this request's data roots
    return found


def vcf_alleles(dataset, chrom: str, start: int, end: int) -> dict[int, list[str]]:
    """``{pos0: [REF, ALT1, ...]}`` from the source VCF when it sits next to the
    var bigBed (an indexed VCF/BCF); {} otherwise. With a lift, the VCF (on the
    reads' assembly) is read over the view's source intervals and its sites are
    lifted to the target positions the rows are drawn at (a site that fails to
    lift is left out)."""
    out: dict[int, list[str]] = {}
    mapper = _lift_of(dataset)
    windows = [(chrom, start, end)] if mapper is None else mapper.source_intervals(chrom, start, end)
    for path in layer_paths(dataset, VAR_LAYER):
        vcf = _vcf_path(path)
        if not vcf:
            continue
        try:
            import pysam
            from utils.chrom import get_chrom_variants
            with pysam.VariantFile(vcf) as handle:
                contigs = set(handle.header.contigs)
                for wchrom, wa, wb in windows:
                    actual = next((v for v in get_chrom_variants(wchrom) if v in contigs), None)
                    if actual is None:
                        continue
                    for rec in handle.fetch(actual, max(0, wa), wb):
                        pos0 = int(rec.pos) - 1
                        if mapper is not None:
                            hit = mapper.map_interval(wchrom, pos0, pos0 + max(1, len(rec.ref or "")))
                            if hit is None:
                                continue
                            pos0 = hit[1]
                        if start <= pos0 < end:
                            out.setdefault(pos0, [rec.ref, *(rec.alts or ())])
        except Exception:
            continue
    return out


# ---------------------------------------------------------------------------
# Variant sites and allele groups (the Variants panel)

@dataclass
class Site:
    pos: int
    ref_len: int
    alleles: list  # labels per VCF allele index
    kind: str
    sid: str
    alt: int = 1  # the VCF allele index shown as ALT (the most common ALT at the site)


def _site_for(pos: int, ref_len: int, bases: Optional[list[str]], alt_index: int) -> Site:
    """The Variants panel's entry shape for a site: id ``pos:kind:a1/a2``."""
    if bases:
        labels = list(bases)
        ref, alt = bases[0], bases[alt_index] if alt_index < len(bases) else (bases[1] if len(bases) > 1 else "N")
        if len(ref) == 1 and len(alt) == 1:
            kind, a1, a2 = "snv", ref, alt
        elif len(ref) > len(alt):
            kind, a1, a2 = "del", "ref", f"-{len(ref) - len(alt)}"
        elif len(alt) > len(ref):
            kind, a1, a2 = "ins", "ref", f"+{len(alt) - len(ref)}"
        else:
            kind, a1, a2 = "snv", ref, alt
    else:
        labels = ["REF"] + [f"ALT{k}" if k > 1 else "ALT" for k in range(1, 10)]
        if ref_len <= 1:
            kind, a1, a2 = "snv", "REF", labels[alt_index] if alt_index < len(labels) else "ALT"
        else:
            kind, a1, a2 = "del", "ref", f"-{ref_len - 1}"
    return Site(pos, ref_len, labels, kind, f"{pos}:{kind}:{a1}/{a2}", alt_index)


def _letter(site: Site, allele: int) -> Optional[str]:
    """A read's allele at a site in the Variants panel's letters: one of the
    site's two alleles, 'x' (another allele, another base, deleted) or None
    (ambiguous, or not covering)."""
    if allele == ALLELE_AMBIGUOUS:
        return None
    a1, a2 = site.sid.split(":", 2)[2].split("/", 1)
    if allele == 0:
        return a1
    if allele == site_alt_index(site):
        return a2
    return "x"


def site_alt_index(site: Site) -> int:
    return site.alt


def merge_var_rows(rows: list) -> list:
    """One row per read: a read whose sites overlap is written as several rows."""
    by_id: "OrderedDict[str, VarRow]" = OrderedDict()
    for row in rows:
        have = by_id.get(row.read_id)
        if have is None:
            by_id[row.read_id] = replace(row, sites=list(row.sites))
            continue
        seen = {(p, z) for p, z, _a, _q in have.sites}
        have.sites = sorted(have.sites + [x for x in row.sites if (x[0], x[1]) not in seen])
        have.start, have.end = min(have.start, row.start), max(have.end, row.end)
        if have.hp < 0:
            have.hp, have.ps = row.hp, row.ps
    return list(by_id.values())


# ---------------------------------------------------------------------------
# The read set: the reads the read track shows

# Layers whose rows are footprint calls: a read with a row in one of them is called.
_CALL_LAYERS = ("footprint", "msp", "fire", "tf")


def request_read_policy(body: Optional[dict] = None) -> tuple[bool, bool]:
    """``(hide_uncalled, include_qcfail)`` as the request asks: Min footprints hides reads
    without footprint calls unless its "All reads, including uncalled" choice
    (``hide_uncalled=false`` or ``min_footprints=-1``, in the body or the query);
    QC-fail reads are hidden unless ``include_qcfail``."""
    from services.signal_evidence import body_hide_uncalled
    body = body or {}
    return body_hide_uncalled(body), bool(body.get("include_qcfail", False))


def _call_layer_paths(dataset) -> list[str]:
    paths: list[str] = []
    companions = getattr(dataset, "companion_layers", None) or {}
    for layer in _CALL_LAYERS:
        value = companions.get(layer) or []
        paths.extend(value if isinstance(value, (list, tuple)) else [value])
    variant = set(p for layer in VARIANT_LAYER_TYPES for p in layer_paths(dataset, layer))
    other = {p for v in companions.values() for p in (v if isinstance(v, (list, tuple)) else [v])}
    paths.extend(p for p in getattr(dataset, "paths", None) or [] if p not in other)
    return [p for p in dict.fromkeys(paths) if p not in variant and str(p).lower().endswith((".bb", ".bigbed"))]


_QC_CHUNK = 5_000_000
_qcfail_cache: "OrderedDict[tuple, frozenset]" = OrderedDict()


def _flag_index(path: str) -> Optional[int]:
    names = file_fields(path, SV_LAYER)
    return names.get("flag")


def qcfail_read_ids(dataset, chrom: str) -> frozenset:
    """The read ids whose sv records carry QC-fail (0x200), over the whole chromosome
    (on the reads' assembly when lifted), so a read's QC status does not depend on which
    of its records overlap the view. Read in chunks, only the flag column kept; cached
    per file version."""
    mapper = _lift_of(dataset)
    out: set[str] = set()
    for path in layer_paths(dataset, SV_LAYER):
        flag_at = _flag_index(path)
        if flag_at is None:
            continue
        sources = [chrom] if mapper is None else list(dict.fromkeys(
            c for c, _a, _b in mapper.source_intervals(chrom, 0, 1 << 40)))
        for schrom in sources:
            key = (path, _stamp(path), schrom)
            with _LOCK:
                hit = _qcfail_cache.get(key)
            if hit is None:
                from services.bigbed_handles import get_bigbed_handle
                from utils.chrom import get_chrom_variants
                found: set[str] = set()
                bw = get_bigbed_handle(path)
                chroms = (bw.chroms() or {}) if bw is not None else {}
                actual = next((v for v in get_chrom_variants(schrom) if v in chroms), None)
                if actual is not None:
                    length = int(chroms[actual])
                    for lo in range(0, length, _QC_CHUNK):
                        for _s, _e, rest in (bw.entries(actual, lo, min(length, lo + _QC_CHUNK)) or []):
                            fields = rest.split("\t")
                            try:
                                if int(fields[flag_at]) & FLAG_QCFAIL:
                                    found.add(fields[0])
                            except (IndexError, ValueError):
                                continue
                hit = frozenset(found)
                with _LOCK:
                    _qcfail_cache[key] = hit
                    while len(_qcfail_cache) > _CACHE_MAX:
                        _qcfail_cache.popitem(last=False)
            out |= hit
    return frozenset(out)


def read_set_filter(dataset, chrom: str, start: int, end: int, *, hide_uncalled: bool = True,
                    include_qcfail: bool = False) -> Callable[[str], bool]:
    """Whether a read of the var / sv layers is in the read track's read set.

    The layers carry no call status: a read is called when it has a row in the sample's
    footprint / MSP / FIRE / TF bigBeds (its read-track row). Min footprints hides the
    others unless "All reads, including uncalled". A dataset with no such bigBed (only
    variant layers) has no call status to go by: nothing is hidden as uncalled. QC-fail
    reads (sv ``flag`` 0x200; fiberhmm-extract leaves FiberHMM chimeras out of every
    layer) are hidden unless ``include_qcfail``; shown by choice, they are exempt from the
    uncalled rule."""
    qcfail = qcfail_read_ids(dataset, chrom) if has_layer(dataset, SV_LAYER) else frozenset()
    called = None
    if hide_uncalled and _call_layer_paths(dataset):
        called = set(read_extents(dataset, chrom, start, end, layers=_CALL_LAYERS))

    def visible(read_id: str) -> bool:
        if read_id in qcfail:
            return include_qcfail
        return called is None or read_id in called
    return visible


def _filter_var_rows(rows: list, params: dict, read_ids=None, visible=None) -> list:
    min_bq = int(params.get("min_bq", 0) or 0)
    include_duplicates = bool(params.get("include_duplicates", False))
    out = []
    for row in merge_var_rows(rows):
        if read_ids is not None and row.read_id not in read_ids:
            continue
        if visible is not None and not visible(row.read_id):
            continue
        if row.duplicate and not include_duplicates:
            continue
        if min_bq > 0:
            # A base under the quality floor is not a call there: the read does not cover the site.
            sites = [s for s in row.sites if not (0 <= s[3] < min_bq and s[2] >= 0)]
            row = replace(row, sites=sites)
        out.append(row)
    return out


def sites_in_view(dataset, chrom: str, start: int, end: int, params: dict, read_ids=None, visible=None):
    """(sites with counts, reads) of the var layer in ``[start, end)``; ``visible``: the
    read track's read set (``read_set_filter``)."""
    rows = _filter_var_rows(dataset_rows(dataset, VAR_LAYER, chrom, start, end), params, read_ids, visible)
    bases = vcf_alleles(dataset, chrom, start, end)
    tallies: dict[tuple[int, int], dict] = {}
    for row in rows:
        rev = row.strand == "-"
        for pos, size, allele, _q in row.sites:
            if not (start <= pos < end):
                continue
            t = tallies.setdefault((pos, size), {"alleles": Counter(), "fwd": Counter(), "rev": Counter(),
                                                 "ambiguous": 0, "deleted": 0, "other": 0})
            if allele == ALLELE_AMBIGUOUS:
                t["ambiguous"] += 1
            elif allele == ALLELE_DELETED:
                t["deleted"] += 1
            elif allele == ALLELE_OTHER:
                t["other"] += 1
            else:
                t["alleles"][allele] += 1
                (t["rev"] if rev else t["fwd"])[allele] += 1
    out = []
    for (pos, size), t in sorted(tallies.items()):
        counts = t["alleles"]
        alts = [(n, k) for k, n in counts.items() if k > 0]
        alt_index = max(alts)[1] if alts else 1
        site = _site_for(pos, size, bases.get(pos), alt_index)
        out.append((site, t))
    return out, rows


def _snp_entry(site: Site, t: dict, params: dict, median_depth: float) -> dict:
    a1, a2 = site.sid.split(":", 2)[2].split("/", 1)
    alt = site_alt_index(site)
    n_ref, n_alt = t["alleles"].get(0, 0), t["alleles"].get(alt, 0)
    n_other_alt = sum(n for k, n in t["alleles"].items() if k not in (0, alt))
    depth = n_ref + n_alt + n_other_alt + t["other"] + t["deleted"]
    minor = min(n_ref, n_alt)
    maf = round(minor / depth, 4) if depth else 0.0
    strands = {}
    for name, key in (("fwd", "fwd"), ("rev", "rev")):
        c = t[key]
        ref_n, alt_n = c.get(0, 0), c.get(alt, 0)
        minor_is_alt = n_alt <= n_ref
        strands[name] = {"depth": sum(c.values()), "minor": alt_n if minor_is_alt else ref_n,
                         "major": ref_n if minor_is_alt else alt_n}
    both = all(strands[n]["minor"] >= 1 for n in strands) if minor else False
    counts = {a1: n_ref, a2: n_alt}
    if n_other_alt or t["other"]:
        counts["other"] = n_other_alt + t["other"]
    if t["deleted"]:
        counts["-"] = t["deleted"]
    if t["ambiguous"]:
        counts["ambiguous"] = t["ambiguous"]
    min_depth = int(params.get("min_depth", 1) or 1)
    min_maf = float(params.get("min_maf", 0) or 0)
    passes = depth >= min_depth and maf >= min_maf and (both or not params.get("both_strands", True))
    return {
        "id": site.sid, "pos": site.pos, "kind": site.kind,
        "ref": a1 if site.kind == "snv" and a1 not in ("REF",) else None,
        "alleles": [a1, a2], "alt": a2, "length": max(0, site.ref_len - 1) if site.kind != "snv" else 0,
        "depth": depth, "counts": counts, "minor": minor, "maf": maf,
        "strands": strands, "strand_balance": (round(strands["fwd"]["minor"] / minor, 3) if minor else None),
        "both_strands": bool(both), "daf_safe": None,
        "daf_reason": ("Site from the VCF given to fiberhmm-extract. Reads whose base there is ambiguous after "
                       "DAF conversion are left out of the counts."),
        "low_depth": bool(depth < 0.5 * median_depth), "passes": bool(passes),
        "ambiguous": t["ambiguous"], "ref_len": site.ref_len, "source": "fiberhmm_var",
    }


def _region(body: dict) -> tuple[str, int, int]:
    chrom = str(body.get("chrom") or "")
    if not chrom:
        raise VariantLayerError("missing chrom")
    try:
        start, end = max(0, int(body.get("start"))), int(body.get("end"))
    except (TypeError, ValueError):
        raise VariantLayerError("start and end must be integers") from None
    if end <= start:
        raise VariantLayerError("end must be after start")
    return chrom, start, end


def _read_ids(body: dict):
    ids = body.get("read_ids")
    return frozenset(ids) if isinstance(ids, list) else None


def _visible(dataset, chrom, start, end, body: dict):
    hide_uncalled, include_qcfail = request_read_policy(body)
    return read_set_filter(dataset, chrom, start, end, hide_uncalled=hide_uncalled, include_qcfail=include_qcfail)


def _scan_key(dataset, chrom, start, end, params) -> str:
    import hashlib
    ident = repr((tuple(layer_paths(dataset, VAR_LAYER)), tuple(_stamp(p) for p in layer_paths(dataset, VAR_LAYER)),
                  id(_lift_of(dataset))))
    digest = hashlib.sha1(ident.encode()).hexdigest()[:10]
    return "|".join(str(x) for x in (getattr(dataset, "id", ""), chrom, start, end, params.get("min_maf"),
                                     params.get("min_depth"), params.get("both_strands"), params.get("min_bq"),
                                     params.get("include_duplicates"), params.get("include_qcfail"),
                                     # Min footprints' uncalled rule: the read set differs.
                                     "uncalled_shown" if not request_read_policy(params)[0] else "uncalled_hidden",
                                     "fiberhmm_var", digest))


def snps_payload(state, dataset, body: dict) -> dict:
    """``/api/variants/snps`` for a bigBed dataset with a var layer: its VCF sites in view."""
    from services.variants_endpoint import scan_params
    t0 = time.perf_counter()
    chrom, start, end = _region(body)
    params = {**scan_params(body), **{k: body[k] for k in ("hide_uncalled", "min_footprints") if k in body}}
    sites, rows = sites_in_view(dataset, chrom, start, end, params, _read_ids(body),
                                _visible(dataset, chrom, start, end, body))
    depths = []
    for site, t in sites:
        depths.append(sum(t["alleles"].values()) + t["other"] + t["deleted"])
    import statistics
    median_depth = float(statistics.median(depths)) if depths else 0.0
    snps = [_snp_entry(site, t, params, median_depth) for site, t in sites]
    hp_counts = Counter(str(r.hp) for r in rows if r.hp >= 0)
    vcf = next((source_vcf_name(p) for p in layer_paths(dataset, VAR_LAYER) if source_vcf_name(p)), None)
    return {
        "scan_key": _scan_key(dataset, chrom, start, end, params),
        "dataset_id": getattr(dataset, "id", ""), "region": {"chrom": chrom, "start": start, "end": end},
        "params": params, "mode": "basecall", "chemistry": "FiberHMM var layer",
        "reference": "fasta" if any(s["ref"] for s in snps) else "none",
        "n_reads": len(rows), "median_depth": median_depth, "fixed": 0, "snps": snps,
        "directions": {"CT": 0, "GA": 0, "none": 0},
        "hp": {"tagged": sum(hp_counts.values()), "values": dict(hp_counts),
               "untagged": len(rows) - sum(hp_counts.values())},
        "daf_policy": "fiberhmm-extract per-read alleles",
        "elapsed_ms": round((time.perf_counter() - t0) * 1000), "cached": False,
        "source": "fiberhmm_var", "vcf": vcf,
        "ambiguous": sum(t["ambiguous"] for _s, t in sites),
    }


def _row_alleles(rows: list) -> dict[str, dict[int, int]]:
    return {row.read_id: {pos: allele for pos, _z, allele, _q in row.sites} for row in rows}


def _msp_fraction(dataset, chrom: str, lo: int, hi: int) -> dict[str, float]:
    """Per read id, the fraction of its bases in ``[lo, hi)`` inside MSP / FIRE
    blocks (from the sample's MSP companion); {} without one."""
    paths = []
    for key in ("msp", "fire"):
        value = (getattr(dataset, "companion_layers", None) or {}).get(key) or []
        paths.extend(value if isinstance(value, (list, tuple)) else [value])
    if getattr(dataset, "layer_type", None) in ("msp", "fire"):
        paths.extend(getattr(dataset, "paths", None) or [])
    out: dict[str, float] = {}
    for path in dict.fromkeys(paths):
        _actual, entries = _entries(path, chrom, lo, hi)
        for s, e, rest in entries:
            fields = rest.split("\t")
            blocks = _blocks(int(s), fields)
            if blocks is None:
                continue
            a, b = max(lo, int(s)), min(hi, int(e))
            if b <= a:
                continue
            covered = sum(max(0, min(b, p + z) - max(a, p)) for p, z in blocks)
            out[fields[0]] = covered / (b - a)
    return out


ACCESSIBILITY_HALF_WINDOW = 500


def alleles_payload(state, dataset, body: dict) -> dict:
    """``/api/variants/alleles`` for a var layer: reads by allele at one site
    (REF / ALT / other / ambiguous / not informative), by allele combination at
    several, or by the ``hp`` column."""
    from services import snp_scan
    from services.variants_endpoint import scan_params
    chrom, start, end = _region(body)
    params = {**scan_params(body), **{k: body[k] for k in ("hide_uncalled", "min_footprints") if k in body}}
    sites, rows = sites_in_view(dataset, chrom, start, end, params, _read_ids(body),
                                _visible(dataset, chrom, start, end, body))
    names = [r.read_id for r in rows]
    meta = {"dataset_id": getattr(dataset, "id", ""), "region": {"chrom": chrom, "start": start, "end": end},
            "scan_key": _scan_key(dataset, chrom, start, end, params), "mode": "basecall", "tags": None,
            "source": "fiberhmm_var"}
    if str(body.get("source") or "snps") == "hp":
        values = sorted({r.hp for r in rows if r.hp >= 0})
        gid = {v: g for g, v in enumerate(values)}
        untagged = len(values)
        assignments, sizes = {}, Counter()
        for r in rows:
            g = gid.get(r.hp, untagged)
            assignments[r.read_id] = g
            sizes[g] += 1
        groups = [{"id": g, "key": f"HP{v}", "label": f"HP {v}", "alleles": [], "count": sizes[g], "kind": "combo"}
                  for v, g in gid.items()]
        groups.append({"id": untagged, "key": "not-informative", "label": "No HP", "alleles": [],
                       "count": sizes[untagged], "kind": "not-informative"})
        return {"groups": groups, "assignments": assignments, "n_reads": len(rows),
                "covering": len(rows) - sizes[untagged], "snps": [], "phase": None, "partial_assigned": 0,
                "threshold": 0, "distinct": len(values), **meta}
    by_id = {s.sid: (s, t) for s, t in sites}
    by_pos = {s.pos: (s, t) for s, t in sites}
    wanted = body.get("snps")
    if wanted == "informative" or wanted is None:
        median = sorted(_snp_entry(s, t, params, 0)["depth"] for s, t in sites)
        med = median[len(median) // 2] if median else 0
        chosen = [s for s, t in sites if _snp_entry(s, t, params, med)["passes"]]
    elif isinstance(wanted, list):
        chosen = []
        for sid in wanted:
            hit = by_id.get(sid)
            if hit is None:
                try:
                    hit = by_pos.get(int(str(sid).split(":", 1)[0]))
                except ValueError:
                    hit = None
            if hit is None:
                raise VariantLayerError(f"site {sid!r} is not in this view", 409)
            chosen.append(hit[0])
    else:
        raise VariantLayerError("snps must be a list of site ids or 'informative'")
    alleles = _row_alleles(rows)
    if not chosen:
        return {"groups": [], "assignments": {}, "n_reads": len(rows), "covering": 0, "snps": [], "phase": None,
                "partial_assigned": 0, "threshold": 0, "distinct": 0, **meta}
    if len(chosen) == 1 and not body.get("as_combination"):
        result = single_site_groups(chosen[0], names, alleles)
        _add_accessibility(result, dataset, chrom, chosen[0].pos)
    else:
        letters = [[_letter(s, alleles[n].get(s.pos, None)) if s.pos in alleles[n] else None for s in chosen]
                   for n in names]
        columns = [{"id": s.sid, "name": f"{s.pos + 1:,}", "kind": "snv"} for s in chosen]
        result = snp_scan.genotype_groups(names, letters, columns, partial=bool(body.get("partial", False)),
                                          min_fraction=float(body.get("min_fraction", 0.02) or 0.02),
                                          min_reads=int(body.get("min_reads", 3) or 3))
        result.pop("svs", None)
        result.pop("columns", None)
        result["snps"] = [s.sid for s in chosen]
    result.update(meta)
    return result


def single_site_groups(site: Site, names: list, alleles: dict) -> dict:
    """Reads at one site: REF, ALT, other (other ALT, other base, deleted),
    ambiguous after DAF conversion, not covering. Ambiguous reads are not
    counted as covering the site."""
    a1, a2 = site.sid.split(":", 2)[2].split("/", 1)
    alt = site_alt_index(site)
    ref_label = "ref" if a1 in ("ref", "REF") else f"ref {a1}"
    alt_label = f"alt {a2}" if site.kind == "snv" else f"alt {site.kind} {a2}"
    spec = [(0, a1, ref_label, "combo"), (1, a2, alt_label, "combo"), (2, "other", "Other allele", "other"),
            (3, "ambiguous", "Ambiguous (DAF)", "not-informative"), (4, "not-informative", "Not covering", "not-informative")]
    assignments, sizes = {}, Counter()
    for name in names:
        a = alleles.get(name, {}).get(site.pos)
        if a is None:
            g = 4
        elif a == ALLELE_AMBIGUOUS:
            g = 3
        elif a == 0:
            g = 0
        elif a == alt:
            g = 1
        else:
            g = 2
        assignments[name] = g
        sizes[g] += 1
    groups = [{"id": g, "key": key, "label": label, "alleles": [key] if kind == "combo" else [],
               "count": sizes[g], "kind": kind} for g, key, label, kind in spec]
    return {"groups": groups, "assignments": assignments, "n_reads": len(names),
            "covering": sizes[0] + sizes[1] + sizes[2], "ambiguous": sizes[3], "snps": [site.sid], "phase": None,
            "partial_assigned": 0, "threshold": 0, "distinct": 2}


def _add_accessibility(result: dict, dataset, chrom: str, pos: int) -> None:
    """Each group's mean MSP fraction within +-500 bp of the site (when the
    sample has an MSP layer), in ``accessibility`` and the group's label."""
    lo, hi = max(0, pos - ACCESSIBILITY_HALF_WINDOW), pos + ACCESSIBILITY_HALF_WINDOW + 1
    try:
        fractions = _msp_fraction(dataset, chrom, lo, hi)
    except Exception:
        fractions = {}
    if not fractions:
        return
    per: dict[int, list[float]] = {}
    for name, g in result["assignments"].items():
        if name in fractions:
            per.setdefault(g, []).append(fractions[name])
    summary = {}
    for group in result["groups"]:
        values = per.get(group["id"]) or []
        if values and group["kind"] == "combo":
            mean = sum(values) / len(values)
            summary[group["key"]] = {"reads": len(values), "mean_msp_fraction": round(mean, 4)}
            group["label"] = f"{group['label']} · MSP {mean:.0%}"
    result["accessibility"] = {"window": [lo, hi], "groups": summary}


# ---------------------------------------------------------------------------
# SVs (the SV band, the read rows, the carrier / reference split)

def _filter_sv_rows(rows: list, *, min_mapq: int = 0, hide_supplementary: bool = False,
                    include_duplicates: bool = True) -> list:
    out = []
    for row in rows:
        if row.secondary:
            continue
        if hide_supplementary and row.supplementary:
            continue
        if row.mapq >= 0 and row.mapq < min_mapq:
            continue
        if not include_duplicates and (row.flag & FLAG_DUPLICATE or row.duplicate):
            continue
        out.append(row)
    return out


def _record_key(row: SvRow) -> tuple:
    """Rows of one alignment record (split because its events overlap) share these."""
    return (row.read_id, row.flag, row.mapq, row.read_len, row.sa)


def compact_sv_entries(rows: list, *, min_len: int = 0, link_split: bool = True,
                       extents: Optional[dict] = None, chrom: Optional[str] = None) -> list[dict]:
    """One compact entry per alignment record (``sv_endpoint`` form). A
    primary record's bounds take in its read's extent from the other layers
    (``extents``: read id -> (start, end)); reads there with no SV record come
    as entries without events (they can be reference reads)."""
    records: "OrderedDict[tuple, dict]" = OrderedDict()
    for row in rows:
        key = _record_key(row)
        entry = records.get(key)
        events = sv_row_events(row, min_len=min_len, link_split=False)
        if entry is None:
            sa = []
            if link_split and row.sa not in ("", "."):
                sa = [ev for ev in sv_row_events(replace(row, events=[]), link_split=True) if ev["t"] == "SA"]
            entry = records[key] = {
                "id": row.read_id, "reference_start": row.start, "reference_end": row.end, "sv": events, "_sa": sa,
                "duplicate": bool(row.flag & FLAG_DUPLICATE) or row.duplicate, "qcfail": False,
                "file_chrom": row.chrom, "supplementary": row.supplementary, "mapq": row.mapq,
            }
        else:
            entry["sv"].extend(events)
            entry["reference_start"] = min(entry["reference_start"], row.start)
            entry["reference_end"] = max(entry["reference_end"], row.end)
    out = []
    seen_ids = set()
    for entry in records.values():
        entry["sv"].sort(key=lambda ev: (ev["ref"], ev["t"]))
        entry["sv"].extend(entry.pop("_sa"))
        if not entry["supplementary"]:
            seen_ids.add(entry["id"])
            extent = (extents or {}).get(entry["id"])
            if extent is not None:
                entry["reference_start"] = min(entry["reference_start"], extent[0])
                entry["reference_end"] = max(entry["reference_end"], extent[1])
        out.append(entry)
    for read_id, (a, b) in (extents or {}).items():
        if read_id not in seen_ids:
            out.append({"id": read_id, "reference_start": a, "reference_end": b, "sv": [], "duplicate": False,
                        "qcfail": False, "file_chrom": chrom, "supplementary": False, "mapq": -1})
    return out


_EXTENT_LAYERS = ("footprint", "msp", "fire", "tf", "bothstrand")


_dup_field_cache: dict = {}


def _duplicate_field(path: str) -> Optional[int]:
    """The ``isDuplicate`` column of a FiberHMM bigBed (index into the row's rest), or None."""
    if path in _dup_field_cache:
        return _dup_field_cache[path]
    index = None
    try:
        from services.bigbed_detection import _autosql_table_and_fields, _read_bigbed_autosql
        sql = _read_bigbed_autosql(path)
        if sql:
            _table, names = _autosql_table_and_fields(sql)
            if "isDuplicate" in names and names.index("isDuplicate") >= 3:
                index = names.index("isDuplicate") - 3
    except Exception:
        index = None
    _dup_field_cache[path] = index
    return index


def read_extents(dataset, chrom: str, start: int, end: int, layers=_EXTENT_LAYERS,
                 include_duplicates: bool = True) -> dict[str, tuple[int, int]]:
    """Each read's extent from the sample's footprint / MSP / TF rows overlapping ``[start, end)``
    (without ``include_duplicates``, rows marked ``isDuplicate`` are left out)."""
    paths: list[str] = []
    companions = getattr(dataset, "companion_layers", None) or {}
    for layer in layers:
        value = companions.get(layer) or []
        paths.extend(value if isinstance(value, (list, tuple)) else [value])
    variant = set(p for layer in VARIANT_LAYER_TYPES for p in layer_paths(dataset, layer))
    other_companions = {p for v in companions.values() for p in (v if isinstance(v, (list, tuple)) else [v])}
    paths.extend(p for p in getattr(dataset, "paths", None) or [] if p not in other_companions)
    out: dict[str, tuple[int, int]] = {}
    mapper = _lift_of(dataset)
    for path in dict.fromkeys(paths):
        if path in variant or not str(path).lower().endswith((".bb", ".bigbed")):
            continue
        dup_at = None if include_duplicates else _duplicate_field(path)
        try:
            windows = [(chrom, start, end)] if mapper is None else mapper.source_intervals(chrom, start, end)
            for wchrom, wa, wb in windows:
                _actual, entries = _entries(path, wchrom, wa, wb)
                for s, e, rest in entries:
                    a, b = int(s), int(e)
                    if mapper is not None:
                        hit = _lift_span(wchrom, a, b, mapper.map_interval, chrom, [])
                        if hit is None:
                            continue
                        a, b = hit
                    if not include_duplicates and dup_at is not None:
                        fields = rest.split("\t")
                        if dup_at < len(fields) and fields[dup_at].strip() == "1":
                            continue
                    name = rest.split("\t", 1)[0]
                    have = out.get(name)
                    out[name] = (a, b) if have is None else (min(have[0], a), max(have[1], b))
        except Exception:
            continue
    return out


def _duplicate_ids(rows: list) -> set[str]:
    return {r.read_id for r in rows if (r.flag & FLAG_DUPLICATE) or r.duplicate}


def _reference_extents(dataset, chrom, start, end, sv_rows, visible, include_duplicates: bool) -> dict:
    """Read extents of the read set for reference reads (reads without an SV record): a
    duplicate (its footprint row's isDuplicate, or its sv record's flag) is left out unless
    duplicates are shown, so an excluded duplicate never comes back as a reference read."""
    dups = set() if include_duplicates else _duplicate_ids(sv_rows)
    return {k: v for k, v in read_extents(dataset, chrom, start, end, include_duplicates=include_duplicates).items()
            if visible(k) and k not in dups}


def sv_split_payload(state, dataset, *, chrom: str, start: int, end: int, t: str, ref: int, length: int,
                     margin: Optional[int] = None, include_duplicates: bool = False,
                     include_qcfail: bool = False) -> dict:
    """``/api/sv/split`` from the sv layer: primary records as carrier (0),
    reference (1) or not informative (2), of the read track's read set."""
    from services.sv_endpoint import allele_floor, classify_compact
    from services.sv_events import SV_SPAN_MARGIN, allele_label
    margin = SV_SPAN_MARGIN if margin is None else max(0, int(margin))
    visible = _visible(dataset, chrom, start, end, {"include_qcfail": include_qcfail})
    all_rows = dataset_rows(dataset, SV_LAYER, chrom, start, end)
    rows = [r for r in _filter_sv_rows(all_rows, hide_supplementary=True, include_duplicates=include_duplicates)
            if visible(r.read_id)]
    extents = _reference_extents(dataset, chrom, start, end, all_rows, visible, include_duplicates)
    entries = compact_sv_entries(rows, min_len=allele_floor(length), extents=extents, chrom=chrom)
    by_name = classify_compact(((c, c) for c in entries), t=t, ref=ref, length=length, margin=margin,
                               include_duplicates=include_duplicates)
    # Reads of the footprint / MSP / TF layers with no SV record are reference reads when they span the SV.
    assignments: dict[str, int] = {}
    counts = [0, 0, 0]
    by_kind = {"cigar": 0, "sa": 0, "clip": 0}
    for name, entry in by_name.items():
        allele = entry["allele"]
        assignments[name] = allele
        counts[allele] += 1
        if allele == 0:
            by_kind[entry["evidence"]["kind"]] += 1
    return {"assignments": assignments, "counts": counts, "carriers_by": by_kind,
            "label": allele_label(t, ref, length, chrom), "margin": margin,
            "groups": ["carriers", "reference", "not informative"], "source": "fiberhmm_sv",
            "note": "Reads without an SV record are reference reads when their footprint / MSP / TF rows span the SV."}


def svs_payload(state, dataset, body: dict) -> dict:
    """``/api/variants/svs`` from the sv layer."""
    from services.sv_events import normalize_min_sv_len, sv_summary_for_reads
    chrom, start, end = _region(body)
    min_len = normalize_min_sv_len(body.get("min_len"))
    ids = _read_ids(body)
    visible = _visible(dataset, chrom, start, end, body)
    include_duplicates = bool(body.get("include_duplicates", False))
    all_rows = dataset_rows(dataset, SV_LAYER, chrom, start, end)
    rows = [r for r in _filter_sv_rows(all_rows, hide_supplementary=True, include_duplicates=include_duplicates)
            if (ids is None or r.read_id in ids) and visible(r.read_id)]
    extents = {k: v for k, v in _reference_extents(dataset, chrom, start, end, all_rows, visible,
                                                   include_duplicates).items()
               if ids is None or k in ids}
    compact = compact_sv_entries(rows, min_len=min_len, extents=extents, chrom=chrom)
    summary = sv_summary_for_reads(compact, start, end, min_len, chrom=chrom) or {"clusters": []}
    clusters = sorted((c for c in summary["clusters"] if c["len"] >= min_len), key=lambda c: (c["ref"], c["t"]))
    return {"dataset_id": getattr(dataset, "id", ""), "region": {"chrom": chrom, "start": start, "end": end},
            "min_len": min_len, "n_reads": len(compact), "clusters": clusters, "source": "fiberhmm_sv"}


def read_overlay_payload(state, dataset, *, chrom: str, start: int, end: int, layers: Sequence[str],
                         min_sv_len: int = 50, min_mapq: int = 0, hide_supplementary: bool = False,
                         link_split: bool = True, include_qcfail: bool = False,
                         hide_uncalled: Optional[bool] = None, include_duplicates: bool = False) -> dict:
    """What the read rows draw from the variant layers when toggled on:

    ``reads``: ``{read_id: {'sv': [...], 'var': [[pos, ref_len, allele], ...],
    'mapq', 'supplementary'}}`` (absolute coordinates; ``sv`` from the read's
    primary record, ``var`` its alleles at sites in view); ``pieces``: the
    supplementary records in view (``{id, start, end, strand, mapq, sv}``) to
    draw as their own rows unless hidden; ``sv_summary``: the SV band's clusters
    for these records (``sv_events.sv_summary_for_reads``); ``sites``: the var
    sites in view (``pos``, ``ref_len``, ``id``). Only the read track's read set
    (``read_set_filter``)."""
    from services.sv_events import sv_events_in_view, sv_summary_for_reads
    if end - start > MAX_SPAN:
        raise VariantLayerError(f"Zoom in to {MAX_SPAN // 1_000_000} Mb or less for the variant layers", 413)
    visible = _visible(dataset, chrom, start, end, {"include_qcfail": include_qcfail,
                                                    **({} if hide_uncalled is None else {"hide_uncalled": hide_uncalled})})
    reads: dict[str, dict] = {}
    pieces: list[dict] = []
    payload: dict = {"dataset_id": getattr(dataset, "id", ""), "region": {"chrom": chrom, "start": start, "end": end}}
    if SV_LAYER in layers and has_layer(dataset, SV_LAYER):
        all_rows = dataset_rows(dataset, SV_LAYER, chrom, start, end)
        rows = [r for r in _filter_sv_rows(all_rows, min_mapq=min_mapq, hide_supplementary=hide_supplementary,
                                           include_duplicates=include_duplicates) if visible(r.read_id)]
        primaries = [r for r in rows if not r.supplementary]
        for row in primaries:
            events = sv_events_in_view(sv_row_events(row, link_split=link_split), start, end, 0) or []
            entry = reads.setdefault(row.read_id, {})
            entry["mapq"] = row.mapq
            entry["read_len"] = row.read_len
            if events:
                have = entry.setdefault("sv", [])
                # (Every row of a record repeats its SA segments.)
                have.extend(ev for ev in events if ev not in have)
        for entry in reads.values():
            if entry.get("sv"):
                entry["sv"].sort(key=lambda ev: (ev["t"] == "SA", ev.get("ref", 0), ev["t"]))
        by_record: "OrderedDict[tuple, dict]" = OrderedDict()
        for row in rows:
            if not row.supplementary:
                continue
            events = sv_events_in_view(sv_row_events(row, link_split=link_split), start, end, 0) or []
            piece = by_record.get(_record_key(row))
            if piece is None:
                by_record[_record_key(row)] = {"id": row.read_id, "start": row.start, "end": row.end,
                                               "strand": row.strand, "mapq": row.mapq, "flag": row.flag, "sv": events}
            else:
                piece["start"], piece["end"] = min(piece["start"], row.start), max(piece["end"], row.end)
                piece["sv"].extend(ev for ev in events if ev not in piece["sv"])
        pieces.extend(by_record.values())
        compact = compact_sv_entries(primaries, link_split=link_split, chrom=chrom,
                                     extents=_reference_extents(dataset, chrom, start, end, all_rows, visible,
                                                                include_duplicates))
        summary = sv_summary_for_reads(compact, start, end, int(min_sv_len), chrom=chrom)
        payload["sv_summary"] = summary
    if VAR_LAYER in layers and has_layer(dataset, VAR_LAYER):
        rows = [r for r in merge_var_rows(dataset_rows(dataset, VAR_LAYER, chrom, start, end)) if visible(r.read_id)]
        sites = {}
        for row in rows:
            marks = [[p, z, a] for p, z, a, _q in row.sites if start <= p < end]
            if marks:
                reads.setdefault(row.read_id, {})["var"] = marks
                for p, z, _a in marks:
                    sites.setdefault((p, z), 0)
                    sites[(p, z)] += 1
        payload["sites"] = [{"pos": p, "ref_len": z, "reads": n} for (p, z), n in sorted(sites.items())]
    payload["reads"] = reads
    payload["pieces"] = pieces
    return payload


def span_reads_for_rows(dataset, chrom: str, start: int, end: int) -> list[dict]:
    """Span-only compact reads from a dataset's variant layers when it has no
    footprint layer (a var or sv bigBed opened on its own): one row per read,
    intervals relative to ``start``."""
    spans: dict[str, list[int]] = {}
    for layer in VARIANT_LAYER_TYPES:
        for row in dataset_rows(dataset, layer, chrom, start, end):
            if layer == SV_LAYER and (row.supplementary or row.secondary):
                continue
            span = spans.setdefault(row.read_id, [row.start, row.end])
            span[0], span[1] = min(span[0], row.start), max(span[1], row.end)
    out = []
    for read_id, (a, b) in spans.items():
        lo, hi = max(a, start), min(b, end)
        if hi <= lo:
            continue
        out.append({"id": read_id, "intervals": [[lo - start, hi - start, 0]]})
    return out
