"""BigBed layer-type and companion-file detection."""
from __future__ import annotations

import os
import re
from typing import Optional

from utils.validation import is_url


_bigbed_autosql_type_cache: dict[str, Optional[str]] = {}
_bigbed_autosql_sample_cache: dict[str, Optional[str]] = {}
_bigbed_duplicate_field_cache: dict[str, bool] = {}
# Capture the Sample tag up to the sentence boundary ('. ' — a period
# *followed by whitespace*), NOT the first period. FiberHMM sample names
# routinely embed dots (e.g. "BioSample70.decorated.reads.MA.filtered_T"),
# and the old `([^\s.]+?)\.` form truncated them to the first token
# ("BioSample70"), making sibling pools (…_T vs …_GA) indistinguishable so
# their layers overwrote each other during companion grouping. Non-greedy
# `.+?` plus the required trailing whitespace stops only at the real
# "Sample: <name>. <description>" delimiter. A trailing-anchor fallback
# handles a description that is *only* the Sample tag with no following text.
_SAMPLE_TAG_RE = re.compile(r'Sample:\s*(.+?)\.(?:\s|$)', re.IGNORECASE)

_FIBERHMM_TABLE_TO_TYPE = {
    'fiberhmm_footprint': 'footprint',
    # `fiberhmm_nucleosome` is the same BED12 read-backbone layer as
    # `fiberhmm_footprint` under the newer recall naming — treat it as the
    # primary footprint layer so its companions group by the Sample tag.
    'fiberhmm_nucleosome': 'footprint',
    'fiberhmm_msp': 'msp',
    'fiberhmm_tf': 'tf',
    'fiberhmm_m6a': 'm6a',
    'fiberhmm_m5c': 'm5c',
    'fiberhmm_deam': 'deam',
    # `fiberhmm-extract --both-strand`: spans where both physical strands of a
    # paired-duplex DAF molecule contributed deamination evidence. Interval
    # blocks (not per-base marks, not footprints): its own interval layer.
    'fiberhmm_bothstrand': 'bothstrand',
    'fiberhmm_fiberlayers': 'fiberlayers',
    'fiberbrowser_fiberlayers': 'fiberlayers',
    'fiberbrowser_derived_layers': 'fiberlayers',
}

_DISPLAY_LAYER_TYPE_LABELS = {
    'footprint': 'Footprint',
    'msp': 'FIRE',
    'fire': 'FIRE',
    'tf': 'TF',
    'm6a': 'm6A',
    'm5c': '5mC',
    'deam': 'Deamination',
    'bothstrand': 'Both-strand coverage',
    'fiberlayers': 'Derived layers',
    'unknown': 'Unknown',
}

# Overlay type -> color mapping. Must stay in sync with
# frontend/src/utils/layerColors.ts KNOWN_COLORS.
OVERLAY_COLORS = {
    'm6a': '#6b21a8',
    'mod': '#6b21a8',
    'm5c': '#dc2626',
    'deam': '#2dd4bf',
    'footprint': '#16a34a',
    'msp': '#1e40af',
    'fire': '#ea580c',
    'unknown': '#6b7280',
}


def display_layer_type(layer_type: str) -> str:
    """Return the user-facing label for an internal BigBed/FiberHMM layer key."""
    normalized = (layer_type or 'unknown').lower()
    return _DISPLAY_LAYER_TYPE_LABELS.get(normalized, normalized.upper())


def _read_bigbed_autosql(path: str) -> Optional[str]:
    """Read the raw autoSQL string from a bigBed."""
    try:
        from services.bigbed_handles import get_bigbed_handle
        bw = get_bigbed_handle(path)
        if bw is None:
            return None
        sql_bytes = bw.SQL() if hasattr(bw, 'SQL') else None
        if not sql_bytes:
            return None
        return sql_bytes.decode('utf-8', errors='replace') if isinstance(sql_bytes, bytes) else str(sql_bytes)
    except Exception:
        return None


def detect_bigbed_autosql_type(path: str) -> Optional[str]:
    """Read embedded autoSQL and map a FiberHMM table name to a layer type."""
    if path in _bigbed_autosql_type_cache:
        return _bigbed_autosql_type_cache[path]

    sql = _read_bigbed_autosql(path)
    result: Optional[str] = None
    sample: Optional[str] = None
    if sql:
        for line in sql.splitlines():
            s = line.strip()
            if s.startswith('table '):
                name = s[6:].strip().split()[0] if s[6:].strip() else ''
                result = _FIBERHMM_TABLE_TO_TYPE.get(name)
                break
        match = _SAMPLE_TAG_RE.search(sql)
        if match:
            sample = match.group(1).strip()

    _bigbed_autosql_type_cache[path] = result
    _bigbed_autosql_sample_cache[path] = sample
    return result


def detect_bigbed_autosql_sample(path: str) -> Optional[str]:
    """Return the FiberHMM autoSQL `Sample: <name>.` tag when present."""
    if path in _bigbed_autosql_sample_cache:
        return _bigbed_autosql_sample_cache[path]
    detect_bigbed_autosql_type(path)
    return _bigbed_autosql_sample_cache.get(path)


def bigbed_has_duplicate_field(path: str) -> bool:
    """Return whether a BigBed schema carries FiberHMM's ``isDuplicate``."""
    if path in _bigbed_duplicate_field_cache:
        return _bigbed_duplicate_field_cache[path]
    sql = _read_bigbed_autosql(path)
    result = bool(sql and re.search(r'\bisDuplicate\s*;', sql, re.IGNORECASE))
    _bigbed_duplicate_field_cache[path] = result
    return result


def detect_overlay_type(path: str) -> str:
    """Detect layer type from autoSQL first, then legacy filename conventions."""
    autosql_type = detect_bigbed_autosql_type(path)
    if autosql_type is not None:
        return autosql_type

    basename = os.path.basename(path).lower()

    # Before the other rules: `<dataset>_bothstrand.bb` (fiberhmm-extract) must
    # not fall through to 'unknown', which registers it as the primary footprint layer.
    if re.search(r'(?:^|[_.])both_?strand(?=[_.]|$)', basename):
        return 'bothstrand'
    if '_footprint' in basename or 'footprint_' in basename or 'footprint.' in basename:
        return 'footprint'
    if '_fp' in basename or 'fp_' in basename or basename.startswith('fp.') or basename.startswith('fp_'):
        return 'footprint'
    if '_fire' in basename or 'fire_' in basename or basename.startswith('fire.') or basename.startswith('fire_'):
        return 'fire'
    if '_msp' in basename or 'msp_' in basename or basename.startswith('msp.') or basename.startswith('msp_'):
        return 'msp'
    if '_m6a' in basename or 'm6a_' in basename or '.m6a.' in basename or basename.startswith('m6a'):
        return 'm6a'
    if '_m5c' in basename or 'm5c_' in basename or '.m5c.' in basename or basename.startswith('m5c'):
        return 'm5c'
    if '_5mc' in basename or '5mc_' in basename:
        return 'm5c'
    if '_deam' in basename or 'deam_' in basename or '.deam.' in basename or basename.startswith('deam'):
        return 'deam'
    if '.fiberlayers.' in basename or '_fiberlayers.' in basename:
        return 'fiberlayers'
    if '_tf' in basename or 'tf_' in basename or '.tf.' in basename or basename.startswith('tf'):
        return 'tf'
    if re.search(r'[_.]mod[_.]', basename) or basename.startswith('mod_') or basename.startswith('mod.'):
        return 'm6a'

    return 'unknown'


_fire_bigbed_kind_cache: dict[str, Optional[str]] = {}
_fire_decorator_sibling_cache: dict[str, Optional[str]] = {}
_FIRE_DECORATORS_BASENAME = 'fire-fiber-decorators.bb'


def _autosql_table_and_fields(sql: str) -> tuple[Optional[str], list[str]]:
    """The table name and field names of an autoSQL definition."""
    table = None
    fields: list[str] = []
    for line in sql.splitlines():
        s = line.strip()
        if table is None and s.startswith('table '):
            rest = s[6:].strip()
            table = rest.split()[0] if rest else ''
            continue
        match = re.match(r'^[A-Za-z_][\w\[\]]*(?:\s+unsigned)?\s+([A-Za-z_]\w*)\s*;', s)
        if match:
            fields.append(match.group(1))
    return table, fields


# What `ft track-decorators` names its decoration rows (bigbed_read_loader reads these).
_FIRE_DECORATION_NAMES = frozenset({'m6A', '5mC', 'NUC', 'FIRE', 'LINKER', 'MSP'})
_FIRE_SAMPLE_ROWS = 50
_FIRE_SAMPLE_QUERIES = 24
_FIRE_SAMPLE_FIRST_WINDOW = 100_000
_FIRE_SAMPLE_MAX_WINDOW = 8_000_000


_BIGBED_MAGIC = 0x8789F2EB
# The first data block is read only to sample a few rows: its compressed and
# decompressed sizes are bounded (bedToBigBed blocks are tens of KB), and a
# block larger than it declares, or than this, leaves the answer inconclusive.
_MAX_FIRST_BLOCK_BYTES = 4 << 20
_RTREE_MAGIC = 0x2468ACE0


class _RangeReader:
    """Byte ranges of a local file or an http(s) URL (a relay or cluster
    loopback URL included); ``None`` for what it can't read this way (s3://)."""

    def __init__(self, target: str):
        self._target = target
        self._handle = None
        if not target.lower().startswith(('http://', 'https://')):
            self._handle = open(target, 'rb')

    def read(self, offset: int, size: int) -> bytes:
        if self._handle is not None:
            self._handle.seek(offset)
            return self._handle.read(size)
        import urllib.request
        request = urllib.request.Request(self._target, headers={
            'Range': f'bytes={offset}-{offset + size - 1}', 'User-Agent': 'FiberBrowser', 'Accept-Encoding': 'identity'})
        with urllib.request.urlopen(request, timeout=15) as reply:
            data = reply.read(size + 1)
            if reply.status == 200:  # the host ignored the range
                data = data[:0] if offset else data
        return data[:size]

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()


def _first_bigbed_rows(path: str, limit: int = _FIRE_SAMPLE_ROWS) -> Optional[list]:
    """The file's first ``limit`` rows ``(start, end, rest)``, wherever they lie:
    the leftmost leaf of the bigBed's R-tree index names its first data block,
    which is read and decompressed (a few small reads, local or remote; the
    block's compressed and decompressed sizes are bounded). ``None`` when the
    file can't be read this way (another reader may try); ``[]`` when it was
    read but gives no rows: empty, damaged, or a block larger than it declares
    or than the bound (inconclusive; nothing else reads that block)."""
    import struct
    import zlib

    from services.remote_sources.opening import resolve_open_path

    target = resolve_open_path(path)
    if not isinstance(target, str) or target.lower().startswith('s3://'):
        return None
    reader = _RangeReader(target)
    try:
        header = reader.read(0, 64)
        if len(header) < 64:
            return None
        order = '<' if struct.unpack('<I', header[:4])[0] == _BIGBED_MAGIC else '>'
        if struct.unpack(order + 'I', header[:4])[0] != _BIGBED_MAGIC:
            return None
        index_offset = struct.unpack(order + 'Q', header[24:32])[0]
        uncompressed = struct.unpack(order + 'I', header[52:56])[0]
        rtree = reader.read(index_offset, 48)
        if len(rtree) < 48 or struct.unpack(order + 'I', rtree[:4])[0] != _RTREE_MAGIC:
            return None
        node_offset = index_offset + 48
        for _depth in range(32):
            node = reader.read(node_offset, 4)
            if len(node) < 4:
                return None
            is_leaf, _reserved, count = struct.unpack(order + 'BBH', node)
            if count == 0:
                return []
            if is_leaf:
                item = reader.read(node_offset + 4, 32)
                data_offset, data_size = struct.unpack(order + 'QQ', item[16:32])
                break
            item = reader.read(node_offset + 4, 24)
            node_offset = struct.unpack(order + 'Q', item[16:24])[0]
        else:
            return None
        # [] from here on: inconclusive, and no other reader (pyBigWig) is tried on the block.
        if data_size > _MAX_FIRST_BLOCK_BYTES or uncompressed > _MAX_FIRST_BLOCK_BYTES:
            return []
        block = reader.read(data_offset, int(data_size))
        if uncompressed:
            inflater = zlib.decompressobj()
            block = inflater.decompress(block, uncompressed)  # never more than the header declares
            if inflater.unconsumed_tail:
                return []  # the block inflates past its declared size: corrupt or crafted
        rows = []
        pos = 0
        while pos + 12 <= len(block) and len(rows) < limit:
            _chrom, start, end = struct.unpack(order + 'III', block[pos:pos + 12])
            stop = block.index(b'\0', pos + 12)
            rows.append((start, end, block[pos + 12:stop].decode('utf-8', 'replace')))
            pos = stop + 1
        return rows
    except (ValueError, struct.error, zlib.error):
        return []  # a damaged index or block: inconclusive
    except OSError:
        return None
    finally:
        reader.close()


def _sample_bigbed_rows(path: str, limit: int = _FIRE_SAMPLE_ROWS) -> list:
    """Up to ``limit`` rows ``(start, end, rest)`` from the start of the file's data.

    Chromosomes smallest first (bedToBigBed lists only chromosomes with data),
    windows doubling from 100 kb (at most 8 Mb each), at most 24 queries in
    all: a few range reads, even for a remote file."""
    from services.bigbed_handles import get_bigbed_handle

    handle = get_bigbed_handle(path)
    if handle is None:
        return []
    chroms = sorted((handle.chroms() or {}).items(), key=lambda item: (item[1], item[0]))
    queries = 0
    for chrom, size in chroms:
        start, window = 0, _FIRE_SAMPLE_FIRST_WINDOW
        while start < size and queries < _FIRE_SAMPLE_QUERIES:
            end = min(size, start + window)
            queries += 1
            rows = handle.entries(chrom, start, end) or []
            if rows:
                return list(rows[:limit])
            start, window = end, min(window * 2, _FIRE_SAMPLE_MAX_WINDOW)
        if queries >= _FIRE_SAMPLE_QUERIES:
            break
    return []


def _rows_are_fire_decorations(rows: list) -> bool:
    """``ft track-decorators`` rows: named m6A / 5mC / NUC / FIRE / LINKER (MSP),
    each inside the fiber its ``decoratedItem`` (``chrom:start-end:qname``) names."""
    from services.bigbed_read_loader import parse_decorated_item

    if not rows:
        return False
    for start, end, rest in rows:
        fields = (rest or '').split('\t')
        if len(fields) < 10 or fields[0].strip() not in _FIRE_DECORATION_NAMES:
            return False
        item = parse_decorated_item(fields[9])
        if item is None or not (item[1] <= int(start) and int(end) <= item[2]):
            return False
    return True


def _rows_are_fire_fibers(rows: list) -> bool:
    """``fire-fibers.bb`` rows: one per fiber, two 1-bp blocks at its two ends."""
    if not rows:
        return False
    for start, end, rest in rows:
        fields = (rest or '').split('\t')
        if len(fields) < 9:
            return False
        try:
            count = int(fields[6])
            sizes = [int(x) for x in fields[7].rstrip(',').split(',') if x]
            offsets = [int(x) for x in fields[8].rstrip(',').split(',') if x]
        except ValueError:
            return False
        if count != 2 or sizes != [1, 1] or offsets != [0, int(end) - int(start) - 1]:
            return False
    return True


def detect_fire_bigbed_kind(path: str) -> Optional[str]:
    """Which fibertools/FIRE per-fiber bigBed this is, from its autoSQL and rows.

    ``'decorators'``: ``fire-fiber-decorators.bb`` (``ft track-decorators``
    rows in UCSC's ``decoration`` table: one row per fiber and element type,
    with the fiber in ``decoratedItem``). ``'fibers'``: ``fire-fibers.bb`` (the
    same ``decoration`` table name, but BED12 + ``keywords``: one row per
    fiber, two 1-bp blocks marking its ends). ``None`` for anything else.

    The autoSQL alone is not evidence: FIRE's decorator schema is UCSC's
    generic ``decoration`` table, which gene and feature decorations use
    too. So the first rows must also look like fibertools output (element
    names and decorated fibers, or the two end blocks); a file whose rows
    can't be read, or don't match, is an ordinary annotation track.
    """
    if path in _fire_bigbed_kind_cache:
        return _fire_bigbed_kind_cache[path]
    kind: Optional[str] = None
    sql = _read_bigbed_autosql(path)
    if sql:
        table, fields = _autosql_table_and_fields(sql)
        candidate = None
        if table == 'decoration':
            if 'decoratedItem' in fields:
                candidate = 'decorators'
            elif len(fields) >= 13 and 'keywords' in fields:
                candidate = 'fibers'
        if candidate is not None:
            # The first rows of the file, from its index (anywhere in the genome);
            # a windowed search from each chromosome's start only where the index
            # can't be read directly (s3://).
            try:
                rows = _first_bigbed_rows(path)
            except Exception:
                rows = None
            if rows is None:
                try:
                    rows = _sample_bigbed_rows(path)
                except Exception:
                    rows = []
            if not rows:
                # Inconclusive (no rows found or read), not evidence against FIRE:
                # opened as an annotation this time, not remembered (a session
                # link's "as": "reads" opens it as reads regardless).
                return None
            check = _rows_are_fire_decorations if candidate == 'decorators' else _rows_are_fire_fibers
            if check(rows):
                kind = candidate
    _fire_bigbed_kind_cache[path] = kind
    return kind


def find_fire_decorator_sibling(path: str) -> Optional[str]:
    """The ``fire-fiber-decorators.bb`` next to a FIRE ``fire-fibers.bb``.

    FIRE's track hub pairs the two (``decorator.default.bigDataUrl``); the
    fibers file alone only has each fiber's span. Local files: the directory's
    decorators bigBed (by autoSQL, whatever its name, preferring FIRE's name).
    URLs: FIRE's file name in the same folder, if it opens as decorators.
    """
    if path in _fire_decorator_sibling_cache:
        return _fire_decorator_sibling_cache[path]
    found: Optional[str] = None
    if is_url(path):
        base, _, _name = path.split('?', 1)[0].rpartition('/')
        candidate = f"{base}/{_FIRE_DECORATORS_BASENAME}"
        if base and candidate != path and detect_fire_bigbed_kind(candidate) == 'decorators':
            found = candidate
    else:
        parent_dir = os.path.dirname(os.path.abspath(path))
        if os.path.isdir(parent_dir):
            names = sorted(
                (name for name in os.listdir(parent_dir) if name.lower().endswith(('.bb', '.bigbed'))),
                key=lambda name: (name != _FIRE_DECORATORS_BASENAME, name),
            )
            for name in names:
                candidate = os.path.join(parent_dir, name)
                if os.path.abspath(candidate) == os.path.abspath(path):
                    continue
                if detect_fire_bigbed_kind(candidate) == 'decorators':
                    found = candidate
                    break
    _fire_decorator_sibling_cache[path] = found
    return found


def fire_bigbed_mark_layers(path: str) -> list[str]:
    """Per-base mark layers a FIRE per-fiber bigBed source carries (m6A, 5mC)."""
    kind = detect_fire_bigbed_kind(path)
    if kind == 'decorators' or (kind == 'fibers' and find_fire_decorator_sibling(path)):
        return ['m6a', 'm5c']
    return []


def find_companion_bigbed_files(primary_path: str, primary_layer_type: str) -> dict:
    """Scan the primary BigBed directory for companion BigBed files."""
    if is_url(primary_path):
        return {}

    parent_dir = os.path.dirname(os.path.abspath(primary_path))
    if not os.path.isdir(parent_dir):
        return {}

    primary_basename = os.path.basename(primary_path)

    def _strip_type_suffix(basename: str, layer_type: str) -> str:
        stem = os.path.splitext(basename)[0]
        for sep in ('_', '.'):
            suffix = f'{sep}{layer_type}'
            if stem.endswith(suffix):
                return stem[:-len(suffix)]
            if stem.lower().endswith(suffix.lower()):
                return stem[:-len(suffix)]
        return stem

    primary_autosql = detect_bigbed_autosql_type(primary_path)
    primary_sample = detect_bigbed_autosql_sample(primary_path)
    if primary_autosql is not None:
        primary_stem = _strip_type_suffix(primary_basename, primary_autosql)
        companions = {}
        for fname in os.listdir(parent_dir):
            if not fname.lower().endswith(('.bb', '.bigbed')):
                continue
            if fname == primary_basename:
                continue
            fpath = os.path.join(parent_dir, fname)
            layer = detect_bigbed_autosql_type(fpath)
            if layer is None or layer == primary_autosql or layer == 'fiberlayers':
                continue
            matches = False
            if primary_sample is not None:
                sib_sample = detect_bigbed_autosql_sample(fpath)
                if sib_sample and sib_sample == primary_sample:
                    matches = True
            if not matches and _strip_type_suffix(fname, layer) == primary_stem:
                matches = True
            if matches:
                companions[layer] = fpath
        if companions:
            return companions

    layer_kw_re = re.compile(
        r'[_.](?:fp|footprint|m6a|mod|deam|methylation|msp|fire|m5c|5mc|tf|both_?strand)(?=[_.\b])',
        re.IGNORECASE,
    )

    def _classify(basename: str) -> Optional[str]:
        lowered = basename.lower()
        if re.search(r'[_.]both_?strand(?=[_.])', lowered):
            return 'bothstrand'
        if re.search(r'[_.](?:fp|footprint)(?=[_.])', lowered):
            return 'footprint'
        if re.search(r'[_.]deam(?=[_.])', lowered):
            return 'deam'
        if re.search(r'[_.](?:m6a|mod|methylation)(?=[_.])', lowered):
            return 'm6a'
        if re.search(r'[_.]msp(?=[_.])', lowered):
            return 'msp'
        if re.search(r'[_.]fire(?=[_.])', lowered):
            return 'fire'
        if re.search(r'[_.](?:m5c|5mc)(?=[_.])', lowered):
            return 'm5c'
        if re.search(r'[_.]tf(?=[_.])', lowered):
            return 'tf'
        return None

    def _stem(basename: str) -> str:
        return layer_kw_re.sub('', basename.lower())

    primary_stem = _stem(primary_basename)
    companions = {}
    for fname in os.listdir(parent_dir):
        if not fname.lower().endswith(('.bb', '.bigbed')):
            continue
        if fname == primary_basename:
            continue
        layer = _classify(fname)
        if layer is None or layer == primary_layer_type:
            continue
        if _stem(fname) == primary_stem:
            companions[layer] = os.path.join(parent_dir, fname)

    return companions


def is_ddda_mcg_block(block_size: int, block_ml: Optional[int]) -> bool:
    """Is this m5c BigBed block a DddA ``ddda_mcg`` span rather than a 5mC call?

    FiberHMM's m5c extractor writes one of two kinds of rows into the same
    BigBed: native per-base 5mC calls (1 bp blocks, blockMl = the call's ML)
    or the DddA-inferred methylated-CpG spans of ``MA:ddda_mcg`` (blockMl = 0,
    since they carry no quality byte). Without a blockMl column, a block wider
    than 1 bp is the only sign of a span.
    """
    if block_ml is not None:
        return int(block_ml) == 0
    return int(block_size) > 1


_m5c_ddda_span_cache: dict[str, bool] = {}


def m5c_bigbed_has_ddda_spans(path: str, max_entries: int = 2000, max_windows: int = 200) -> bool:
    """Sample an m5c BigBed for DddA ``ddda_mcg`` span rows (cached per path).

    Reads at most ``max_entries`` rows, in 500 kb windows (at most
    ``max_windows`` of them) from the start of the first chromosomes. Remote
    files are not sampled (False).
    """
    if path in _m5c_ddda_span_cache:
        return _m5c_ddda_span_cache[path]
    found = False
    if not is_url(path):
        try:
            from services.bigbed_handles import get_bigbed_handle

            bw = get_bigbed_handle(path)
            seen = 0
            windows = [
                (chrom, lo, min(int(size), lo + 500_000))
                for chrom, size in (list((bw.chroms() or {}).items())[:25] if bw is not None else [])
                for lo in range(0, int(size), 500_000)
            ][:max_windows]
            for chrom, lo, hi in windows:
                for _start, _end, rest in bw.entries(chrom, lo, hi) or []:
                    seen += 1
                    parts = rest.split("\t")
                    if len(parts) >= 9 and parts[7].strip(",. "):
                        sizes = [int(x) for x in parts[7].rstrip(",").split(",") if x]
                        mls = None
                        if len(parts) >= 10 and parts[9].strip(",. "):
                            try:
                                mls = [int(x) for x in parts[9].rstrip(",").split(",") if x]
                            except ValueError:
                                mls = None
                            if mls is not None and len(mls) != len(sizes):
                                mls = None
                        if any(is_ddda_mcg_block(size_, mls[i] if mls else None) for i, size_ in enumerate(sizes)):
                            found = True
                            break
                    if seen >= max_entries:
                        break
                if found or seen >= max_entries:
                    break
        except Exception:
            found = False
    _m5c_ddda_span_cache[path] = found
    return found
