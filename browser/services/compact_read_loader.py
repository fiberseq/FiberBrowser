"""Compact-read loader helpers."""
from __future__ import annotations

from services.bigbed_bounds import bigbed_entries_in_bounds  # noqa: F401 (re-exported)
import hashlib
import re
import os
from operator import add, itemgetter
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from models.domain import CigarCoordMapper
from services.sv_events import (
    SV_MIN_LEN_DEFAULT,
    deletion_spans,
    extract_sv_events,
    sv_extraction_floor,
    split_compact_read_at_deletions,
)
from services.circular_genome import (
    alignment_spans_cover,
    bam_wrap_length,
    concat_compact_read_parts,
    wrap_passes,
)
from services.diagnostics import env_flag_enabled, log_if_enabled
from utils.validation import is_url


_bigbed_format_cache: dict[str, bool] = {}
BAM_DIAGNOSTICS_ENV = "FIBERBROWSER_BAM_DIAGNOSTICS"
BIGBED_DIAGNOSTICS_ENV = "FIBERBROWSER_BIGBED_DIAGNOSTICS"



_PRIMARY_BIGBED_TYPES = ('footprint', None, 'unknown')
_LAYER_SUFFIX_TOKENS = (
    'footprints', 'footprint', 'fp', 'nucleosomes', 'nucleosome', 'nuc', 'tf', 'msp',
    'fire', 'm6a', 'm5c', '5mc', 'deam', 'bothstrand', 'fiberlayers', 'layers',
)


def _read_ma_tags(read, ma_molecular):
    """A read's molecular-annotation tags: ``(MA, AQ, AN, frame)`` or None (``frame``: the file's
    ``bam_tags.MAGroupFrame``, or a bare header flag).

    FiberHMM writes ``MA``/``AQ``/``AN`` (frame from the header's coord=molecular
    declaration). Current fibertools-rs (v0.13+: ``ft add-nucleosomes``,
    ``ft convert-tags``) writes the same spec under ``Ma``/``Aq``/``An``, always in
    molecular frame (a reverse read carries the same offsets as a forward one).
    """
    from services.bam_tags import MA_ALL_MOLECULAR
    if read.has_tag("MA"):
        # The file's per-group frame (bam_tags.MAGroupFrame).
        return (read.get_tag("MA"), read.get_tag("AQ") if read.has_tag("AQ") else None,
                read.get_tag("AN") if read.has_tag("AN") else None, ma_molecular)
    if read.has_tag("Ma"):
        return (read.get_tag("Ma"), read.get_tag("Aq") if read.has_tag("Aq") else None,
                read.get_tag("An") if read.has_tag("An") else None, MA_ALL_MOLECULAR)
    return None


def _attach_record_fields(read_data, read):
    """Per-record fields every compact read carries when its record has them:
    the DAF strand from ``st:Z`` and an ``st``/SEQ disagreement
    (``services.read_strand.record_strand_fields``), and a repaired graph
    lift's provenance ``lift: {from: Yp, mapq: Yq}`` (``services.graph_lift``)."""
    from services.graph_lift import read_lift_provenance
    from services.read_strand import record_strand_fields
    read_data.update(record_strand_fields(read))
    lift = read_lift_provenance(read)
    if lift is not None:
        read_data["lift"] = lift


_MA_FOOTPRINT_TYPES = ('nuc', 'tf', 'fp_v2')   # as dense_bam_loader.MA_FOOTPRINT_LAYERS


def ma_footprint_count(ma_str) -> int:
    """Footprints (nucleosome and TF annotations) a whole MA tag carries, for
    ``min_footprints`` on reads with no legacy ns/nl tags."""
    count = 0
    for part in str(ma_str or '').split(';')[1:]:
        head, sep, body = part.partition(':')
        name = re.split(r'[+\-.]', head, maxsplit=1)[0]
        if sep and name in _MA_FOOTPRINT_TYPES:
            count += sum(1 for iv in body.split(',') if '-' in iv)
    return count


# Read-end footprints: the first and the last footprint call of a read (what
# lies beyond them is the read's terminal gap, as hidden by "Hide terminal
# gaps") that sit at the read end are cut off by it, so their true extent is
# unknown. Shorter than this they are dropped for display and FiberBrowser's
# analyses (on amplicons such stubs pile up at the amplicon ends).
SHORT_TERMINAL_FOOTPRINT_BP = 90
# "At the read end": the call's outer edge lies less than this from the read's
# end (query ends). FiberHMM calls the first and last 10-24 bp of a read
# accessible (an end margin), so a cut-off call starts there: most sub-90 bp
# first/last calls lie 10-19 bp from the end, and few lie further than 30 bp,
# where the distribution turns into a flat tail of calls at real positions
# (e.g. a recurrent TF call 47 bp into an amplicon, behind an accessible
# stretch, and single TF calls in the middle of otherwise accessible reads),
# which are kept.
SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP = 30


def short_terminal_footprint_bp_for(state) -> int:
    """The read-end footprint cutoff a workspace loads reads with (0 = keep all)."""
    if not getattr(state, "drop_short_terminal_footprints", True):
        return 0
    return int(getattr(state, "short_terminal_footprint_bp", SHORT_TERMINAL_FOOTPRINT_BP) or 0)


def short_terminal_spans(ns_starts, ns_lengths, ma_spans, min_bp: int, *,
                         read_length: int = 0,
                         max_end_gap: int = SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP) -> set:
    """A read's read-end footprint calls shorter than ``min_bp``, as SEQ-frame
    query ``(start, end)``.

    The calls are the read's whole-read ns/nl footprints (``ns_starts`` /
    ``ns_lengths``) and its MA footprint calls (``ma_spans``, from
    ``ma_footprint_query_spans``). A read-end call is the one starting first
    (or ending last), as the terminal-gap logic (``build_intervals_from_footprints``)
    bounds a read's body by them, and only when it lies at the read end: its
    outer edge less than ``max_end_gap`` from the read's start (or from
    ``read_length``; unknown: the last call is kept). A first or last call
    further in (a lone TF call in the middle of an accessible read) is kept.
    Only those extreme calls (at most two per source) are looked at, through
    C-level min/max: no per-call Python work.
    """
    if min_bp <= 0:
        return set()
    candidates = []
    if ns_starts is not None and len(ns_starts):
        ends = list(map(add, ns_starts, ns_lengths))
        first = min(range(len(ends)), key=ns_starts.__getitem__)
        last = max(range(len(ends)), key=ends.__getitem__)
        candidates.append((int(ns_starts[first]), int(ends[first])))
        candidates.append((int(ns_starts[last]), int(ends[last])))
    if ma_spans:
        first = min(ma_spans, key=itemgetter(1))
        last = max(ma_spans, key=itemgetter(2))
        candidates.append((first[1], first[2]))
        candidates.append((last[1], last[2]))
    if not candidates:
        return set()
    lo = min(c[0] for c in candidates)
    hi = max(c[1] for c in candidates)
    at_start = lo < max_end_gap
    at_end = bool(read_length) and read_length - hi < max_end_gap
    return {
        c for c in candidates
        if c[1] - c[0] < min_bp and ((at_start and c[0] == lo) or (at_end and c[1] == hi))
    }


def _extent_union(*extents):
    """The union ``(start, end)`` of the given extents (None ones skipped), or None."""
    present = [e for e in extents if e is not None]
    if not present:
        return None
    return min(e[0] for e in present), max(e[1] for e in present)


def ma_footprint_query_spans(ma_tags, *, read_length: int, is_reverse: bool,
                             family_contracts=None) -> list:
    """A read's MA footprint calls (nuc, tf, fp_v2) as SEQ-frame query
    ``(name, start, end)``, over the whole read, with the section and frame
    rules of ``parse_ma_aq_tags_into_layers``."""
    from services.bam_tags import CONSENSUS_MOLECULAR_COORDINATES, ma_group_frame
    if ma_tags is None or not ma_tags[0] or not isinstance(ma_tags[0], str):
        return []
    spans = []
    spec_by_name: Dict[str, str] = {}
    for part in ma_tags[0].split(";")[1:]:
        type_sig, sep, body = part.partition(":")
        if not sep:
            continue
        # The layer parser's strand split: the first of '+', '-', '.' found.
        strand_idx = next((i for i in (type_sig.find(c) for c in "+-.") if i >= 0), -1)
        if strand_idx <= 0:
            continue
        name, qualspec = type_sig[:strand_idx], type_sig[strand_idx + 1:]
        if name not in _MA_FOOTPRINT_TYPES:
            continue
        # A later same-name section with another quality spec is skipped there.
        if spec_by_name.setdefault(name, qualspec) != qualspec:
            continue
        contract = (family_contracts or {}).get(name, {})
        molecular = (ma_group_frame(ma_tags[3]).is_molecular(name, type_sig[strand_idx])
                     or contract.get("coordinates") == CONSENSUS_MOLECULAR_COORDINATES)
        flip = bool(molecular and is_reverse and read_length)
        for iv in body.split(","):
            iv = iv.strip()
            if not iv or "-" not in iv:
                continue
            try:
                s_str, l_str = iv.split("-", 1)
                q_start, q_end = int(s_str) - 1, int(s_str) - 1 + int(l_str)
            except ValueError:
                continue
            if flip:
                q_start, q_end = read_length - q_end, read_length - q_start
            spans.append((name, q_start, q_end))
    return spans


def ma_footprint_call_extent(ma_tags, coord_mapper, ref_start: int, ref_end: int, *,
                             read_length: int, is_reverse: bool, family_contracts=None,
                             spans=None, skip=None):
    """Absolute reference ``(start, end)`` of a read's MA footprint calls
    (nuc, tf, fp_v2) over its whole alignment, or None.

    Placed as ``parse_ma_aq_tags_into_layers`` places them (same section and
    frame rules, same aligned-base CIGAR projection), but without building
    the layers: CIGAR projection is monotone, so only the leftmost and
    rightmost calls that map are projected. Used to keep the read's body over
    TF calls that the legacy ns/nl tags do not carry (FiberHMM >= 2.14 writes
    only nucleosomes there).

    ``spans``: the read's ``ma_footprint_query_spans`` when already parsed;
    ``skip``: query ``(start, end)`` calls left out (dropped read-end calls).
    """
    if ma_tags is None or not ma_tags[0] or not isinstance(ma_tags[0], str) or ref_end <= ref_start:
        return None
    to_ref = (getattr(coord_mapper, "aligned_query_interval_to_ref", None)
              or getattr(coord_mapper, "query_interval_to_ref", None))
    if not callable(to_ref):
        return None
    if spans is None:
        spans = ma_footprint_query_spans(
            ma_tags, read_length=read_length, is_reverse=is_reverse, family_contracts=family_contracts)
    spans = [(q_start, q_end) for _name, q_start, q_end in spans
             if not skip or (q_start, q_end) not in skip]
    if not spans:
        return None

    def first_mapped(ordered, pick):
        for q_start, q_end in ordered:
            r_start, r_end = to_ref(q_start, q_end - 1)
            if r_start is not None and r_end is not None and min(r_end, ref_end) > max(r_start, ref_start):
                return pick(r_start, r_end)
        return None

    lo = first_mapped(sorted(spans), lambda r_start, _r_end: max(int(r_start), ref_start))
    hi = first_mapped(sorted(spans, key=lambda span: span[1], reverse=True),
                      lambda _r_start, r_end: min(int(r_end), ref_end))
    if lo is None or hi is None or hi <= lo:
        return None
    return lo, hi


def bigbed_sample_key(path) -> str:
    """A BigBed's sample: its folder plus its name without layer suffixes, so
    ``s_footprint.bb``, ``s_tf.bb`` and ``s.m6a.bb`` share one key."""
    raw = str(path).split('?', 1)[0]
    base = os.path.basename(raw).lower()
    for ext in ('.bigbed', '.bb', '.bed'):
        if base.endswith(ext):
            base = base[:-len(ext)]
            break
    changed = True
    while changed:
        changed = False
        for token in _LAYER_SUFFIX_TOKENS:
            for sep in ('.', '_', '-'):
                if base.endswith(sep + token) and len(base) > len(sep + token):
                    base = base[:-len(sep + token)]
                    changed = True
    return f"{os.path.dirname(raw)}/{base}"


def bigbed_merge_groups(file_types: Dict[str, Optional[str]]) -> Dict[str, Optional[str]]:
    """Which molecules each file of a multi-file BigBed source belongs to.

    Companion files (tf/msp/marks) merge onto their sample's footprint reads by
    read name. With one sample every file is one group (``''``). With several
    samples, each footprint file is its own group and a companion joins the one
    its name matches; ``None`` marks a companion whose sample can't be told from
    its name (it then joins the one group holding that read name).
    """
    keys = {path: bigbed_sample_key(path) for path in file_types}
    primary_keys = {keys[path] for path, kind in file_types.items() if kind in _PRIMARY_BIGBED_TYPES}
    if len(primary_keys) <= 1:
        return {path: '' for path in file_types}
    return {
        path: keys[path] if (kind in _PRIMARY_BIGBED_TYPES or keys[path] in primary_keys) else None
        for path, kind in file_types.items()
    }


def msp_complement(starts, lengths, read_length):
    """The protected stretches of a read whose only calls are MSPs (as/al)."""
    msps = sorted((int(s), int(s) + int(l)) for s, l in zip(starts or [], lengths or []) if int(l) > 0)
    out_starts, out_lengths = [], []
    pos = 0
    for lo, hi in msps:
        if lo > pos:
            out_starts.append(pos)
            out_lengths.append(lo - pos)
        pos = max(pos, hi)
    if read_length > pos:
        out_starts.append(pos)
        out_lengths.append(read_length - pos)
    return out_starts, out_lengths


def _bam_projection_identity(read, library_id, occurrences):
    """Identity matching FiberHMM ReadEvidence, independent of display cropping.

    The digest identifies the original SAM record, not a modification-pattern
    approximation. Occurrence distinguishes exact duplicate records within one
    BAM; filters on identical records cannot change their relative occurrence.
    Lightweight read adapters without SAM serialization retain partial identity
    only, so the consensus projector must still reject ambiguous matches.
    """
    identity = dict(library_id=library_id, reference_start=int(read.reference_start),
        reference_end=int(read.reference_end),
        alignment_orientation='reverse' if read.is_reverse else 'forward')
    serialize = getattr(read, 'to_string', None)
    if callable(serialize):
        record = hashlib.sha256(serialize().encode('utf-8')).hexdigest()
        identity.update(record_sha256=record, alignment_occurrence=occurrences.get(record, 0))
        occurrences[record] = identity['alignment_occurrence'] + 1
    return identity


def bam_diagnostics_enabled() -> bool:
    """Return whether verbose BAM loader diagnostics should be printed."""
    return env_flag_enabled(BAM_DIAGNOSTICS_ENV)


def log_bam_diagnostic(message: str) -> None:
    """Print BAM loader diagnostics only when explicitly enabled."""
    log_if_enabled(BAM_DIAGNOSTICS_ENV, message)


def log_bigbed_diagnostic(message: str) -> None:
    """Print BigBed loader diagnostics only when explicitly enabled."""
    log_if_enabled(BIGBED_DIAGNOSTICS_ENV, message)


def _is_fiberlayers_bed_file(path: str) -> bool:
    basename = os.path.basename(str(path)).lower()
    return basename.endswith(".fiberlayers.bed") or (
        ".fiberlayers." in basename and basename.endswith(".bed")
    )


def _entries_from_fiberlayers_bed(
    path: str,
    chrom_variants: list[str],
    region_start: int,
    region_end: int,
) -> list[tuple[int, int, str]]:
    """Read local `.fiberlayers.bed` payloads in pyBigWig-compatible entry form."""
    wanted = set(chrom_variants)
    entries: list[tuple[int, int, str]] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip() or line.startswith("#") or line.startswith("track ") or line.startswith("browser "):
                    continue
                fields = line.rstrip("\n").split("\t")
                if len(fields) < 12:
                    continue
                chrom = fields[0]
                if chrom not in wanted:
                    continue
                try:
                    start = int(fields[1])
                    end = int(fields[2])
                except ValueError:
                    continue
                if end <= region_start or start >= region_end:
                    continue
                entries.append((start, end, "\t".join(fields[3:])))
    except OSError:
        return []
    return entries


def detect_swapped_bed12_columns(df, sample_size=10) -> bool:
    """Detect old BigBed files with swapped blockStarts/blockSizes columns."""
    if df.empty:
        return False

    multi_block_reads = df[df["blockCount"].astype(int) > 1].head(sample_size)
    if multi_block_reads.empty:
        return False

    starts_ascending_count = 0
    sizes_ascending_count = 0

    for _, row in multi_block_reads.iterrows():
        bs_str = row["blockStarts"].rstrip(",")
        bz_str = row["blockSizes"].rstrip(",")

        try:
            starts = [int(x) for x in bs_str.split(",")]
            sizes = [int(x) for x in bz_str.split(",")]
        except Exception:
            continue

        if len(starts) < 2 or len(sizes) < 2:
            continue

        starts_ascending = sum(1 for i in range(len(starts) - 1) if starts[i + 1] > starts[i])
        sizes_ascending = sum(1 for i in range(len(sizes) - 1) if sizes[i + 1] > sizes[i])

        if starts_ascending >= (len(starts) - 1) * 0.8:
            starts_ascending_count += 1
        if sizes_ascending >= (len(sizes) - 1) * 0.8:
            sizes_ascending_count += 1

    total = len(multi_block_reads)
    if total == 0:
        return False

    starts_pct = starts_ascending_count / total
    sizes_pct = sizes_ascending_count / total
    if sizes_pct > 0.7 and starts_pct < 0.3:
        log_bigbed_diagnostic(
            "  WARNING: Detected swapped blockStarts/blockSizes columns in BigBed, auto-correcting"
        )
        return True

    return False


def normalize_layer_request(
    include_layers: bool,
    requested_layers: Optional[Iterable[str] | str],
) -> tuple[bool, Optional[set[str]]]:
    """Normalize layer payload flags used by compact BAM/BigBed loaders."""
    if isinstance(requested_layers, str):
        requested_layer_set = {name.strip() for name in requested_layers.split(",") if name.strip()}
    elif requested_layers is None:
        requested_layer_set = None
    else:
        requested_layer_set = {
            str(name).strip()
            for name in requested_layers
            if str(name).strip()
        }

    if requested_layer_set == set() and include_layers:
        requested_layer_set = None
    if requested_layer_set is not None:
        if "fire" in requested_layer_set:
            requested_layer_set.add("msp")
        if "msp" in requested_layer_set:
            requested_layer_set.add("fire")
    include_layers = bool(include_layers or requested_layer_set)
    return include_layers, requested_layer_set


def wants_layer(
    include_layers: bool,
    requested_layer_set: Optional[set[str]],
    *names: str,
) -> bool:
    """Return whether any of the given layer aliases should be built."""
    if not include_layers:
        return False
    if requested_layer_set is None:
        return True
    return any(name in requested_layer_set for name in names)


def parse_int_tag_values(tag) -> Optional[list[int]]:
    """Parse BAM array/string/list tag values into Python ints."""
    if tag is None:
        return None
    if isinstance(tag, str):
        return [int(x) for x in tag.split(",") if x]
    return [int(x) for x in tag]


def parse_optional_int_tag_values(tag) -> Optional[list[int]]:
    """Best-effort int tag parser for optional quality arrays."""
    try:
        return parse_int_tag_values(tag)
    except Exception:
        return None


def parse_bed_circular_group_fields(fields: list[str]) -> Optional[dict]:
    """Parse FiberHMM BED12+ circular grouping fields when present.

    `fiberhmm-extract --circular-groups` appends five fields after any
    per-block quality columns: circId, circPart, circParts, molStart, molLength.
    The parser intentionally checks the tail so it works for footprint, TF,
    MSP/FIRE, and custom layer BED12+ layouts.
    """
    if len(fields) < 14:
        return None
    circ_id = str(fields[-5]).strip()
    try:
        circ_part = int(fields[-4])
        circ_parts = int(fields[-3])
        mol_start = int(fields[-2])
        mol_length = int(fields[-1])
    except (TypeError, ValueError):
        return None
    if circ_parts <= 1 and (not circ_id or circ_id == "."):
        return None
    return {
        "circ_id": "" if circ_id == "." else circ_id,
        "circ_part": circ_part,
        "circ_parts": circ_parts,
        "mol_start": mol_start,
        "mol_length": mol_length,
    }


def map_tagged_footprints(
    fp_starts_query: list[int],
    fp_lengths: list[int],
    fp_qualities: Optional[list[int]],
    query_to_ref,
    min_fp_quality: int = 0,
) -> list[tuple[int, int, int, Optional[int], int]]:
    """Map query-space footprint tags to reference-space footprint tuples.

    Returns tuples of (ref_start, ref_end, size, quality, tag_index).
    """
    query_mapper = getattr(query_to_ref, "__self__", None)
    # footprint_to_ref: as query_interval_to_ref, keeping a soft-clipped start's aligned part.
    query_interval_to_ref = (getattr(query_mapper, "footprint_to_ref", None)
                             or getattr(query_mapper, "query_interval_to_ref", None))
    query_to_ref_many = getattr(query_mapper, "query_to_ref_many", None)
    footprints = []
    if callable(query_interval_to_ref):
        for tag_index, (fp_start, fp_len) in enumerate(zip(fp_starts_query, fp_lengths)):
            if min_fp_quality > 0 and fp_qualities is not None:
                if tag_index < len(fp_qualities) and fp_qualities[tag_index] < min_fp_quality:
                    continue

            fp_ref_start, fp_ref_end = query_interval_to_ref(fp_start, fp_start + fp_len - 1)
            if fp_ref_start is None or fp_ref_end is None:
                continue

            fp_q = (
                fp_qualities[tag_index]
                if fp_qualities is not None and tag_index < len(fp_qualities)
                else None
            )
            footprints.append((fp_ref_start, fp_ref_end, fp_len, fp_q, tag_index))
        return footprints

    candidates: list[tuple[int, int, int, int]] = []
    query_positions: list[int] = []
    for tag_index, (fp_start, fp_len) in enumerate(zip(fp_starts_query, fp_lengths)):
        if min_fp_quality > 0 and fp_qualities is not None:
            if tag_index < len(fp_qualities) and fp_qualities[tag_index] < min_fp_quality:
                continue

        fp_end_query = fp_start + fp_len - 1
        candidates.append((tag_index, fp_start, fp_len, fp_end_query))
        query_positions.extend([fp_start, fp_end_query])

    if not candidates:
        return footprints

    if callable(query_to_ref_many):
        mapped_positions = query_to_ref_many(query_positions)
    else:
        mapped_positions = [query_to_ref(query_pos) for query_pos in query_positions]

    for candidate_index, (tag_index, fp_start, fp_len, fp_end_query) in enumerate(candidates):
        fp_ref_start = mapped_positions[candidate_index * 2]
        if fp_ref_start is None:
            continue

        fp_ref_end = mapped_positions[candidate_index * 2 + 1]
        if fp_ref_end is not None:
            fp_ref_end += 1
        else:
            fp_ref_end = fp_ref_start + 1
            for qpos in range(fp_end_query, fp_start, -1):
                ref_pos = query_to_ref(qpos)
                if ref_pos is not None:
                    fp_ref_end = ref_pos + 1
                    break

        if fp_ref_end <= fp_ref_start:
            fp_ref_end = fp_ref_start + 1

        fp_q = (
            fp_qualities[tag_index]
            if fp_qualities is not None and tag_index < len(fp_qualities)
            else None
        )
        footprints.append((fp_ref_start, fp_ref_end, fp_len, fp_q, tag_index))

    return footprints


def walk_read_intervals(blocks, read_start: int, read_end: int, region_start: int,
                        region_end: int, hide_terminal_gaps: bool, call_extent=None):
    """A read's footprints and gaps inside [region_start, region_end).

    ``blocks`` are the read's footprints as sorted absolute ``(start, end,
    size)``. Gaps come from consecutive footprints of the whole read, so a
    window inside an internal gap still shows that gap (and the read), and the
    gap before the window's first footprint is kept. Returns absolute clipped
    ``(start, end, size, block_index)``; gaps have negative sizes (an internal
    gap its full length) and a ``None`` index.

    ``call_extent``: absolute ``(start, end)`` of the read's footprint calls not
    in ``blocks`` (the MA TF calls of a file whose ns/nl hold nucleosomes only).
    With terminal gaps hidden the read's body still spans them: the stretch
    between such a call and the nearest block is a gap between calls (full
    size), so no call is drawn outside its read.
    """
    out = []

    def add_gap(lo, hi, size):
        a, b = max(lo, region_start), min(hi, region_end)
        if b > a:
            out.append((a, b, size, None))

    call_lo = call_hi = None
    if hide_terminal_gaps and call_extent is not None:
        call_lo, call_hi = int(call_extent[0]), int(call_extent[1])
    prev = None if hide_terminal_gaps else int(read_start)
    if call_lo is not None and blocks and call_lo < int(blocks[0][0]):
        prev = call_lo
    for i, (fp_start, fp_end, fp_size) in enumerate(blocks):
        fp_start, fp_end = int(fp_start), int(fp_end)
        if prev is not None and fp_start > prev:
            if i == 0 and not hide_terminal_gaps:
                # Leading terminal gap (shown only when terminal gaps are): its
                # size is the part in view, as before.
                add_gap(prev, fp_start, -(min(fp_start, region_end) - max(prev, region_start)))
            else:
                add_gap(prev, fp_start, -(fp_start - prev))
        if fp_end > region_start and fp_start < region_end:
            out.append((max(fp_start, region_start), min(fp_end, region_end), int(fp_size), i))
        prev = fp_end if prev is None else max(prev, fp_end)
    if not hide_terminal_gaps and prev is not None and int(read_end) > prev:
        add_gap(prev, int(read_end), -(min(int(read_end), region_end) - max(prev, region_start)))
    elif call_hi is not None and prev is not None and call_hi > prev:
        add_gap(prev, call_hi, -(call_hi - prev))
    return out


def terminal_gap_rejects(sorted_footprints, ref_start: int, ref_end: int,
                         terminal_gap_threshold: int, call_extent=None) -> bool:
    """Whether a read's leading or trailing gap (alignment end to its first /
    last call of any kind) is longer than ``terminal_gap_threshold`` (0: never)."""
    if terminal_gap_threshold <= 0 or not sorted_footprints:
        return False
    first_call = sorted_footprints[0][0]
    last_call = sorted_footprints[-1][1]
    if call_extent is not None:
        first_call = min(first_call, call_extent[0])
        last_call = max(last_call, call_extent[1])
    leading_gap = first_call - ref_start
    trailing_gap = ref_end - last_call
    return leading_gap > terminal_gap_threshold or trailing_gap > terminal_gap_threshold


def build_intervals_from_footprints(
    footprints: list[tuple[int, int, int, Optional[int], int]],
    ref_start: int,
    ref_end: int,
    region_start: int,
    region_end: int,
    hide_terminal_gaps: bool = True,
    terminal_gap_threshold: int = 500,
    lq_qualities: Optional[list[int]] = None,
    rq_qualities: Optional[list[int]] = None,
    call_extent: Optional[tuple[int, int]] = None,
) -> tuple[list[list[int]], list[int], list[int], list[int], bool]:
    """Build compact intervals and quality arrays from mapped footprints.

    ``call_extent``: absolute ``(start, end)`` of the read's other footprint
    calls (MA nuc/tf/fp_v2 over the whole read). With terminal gaps hidden
    they bound the read's body too, and the terminal-gap filter measures from
    the alignment ends to the nearest call of any kind.
    """
    if not footprints:
        return [], [], [], [], False

    sorted_footprints = sorted(footprints, key=lambda item: item[0])
    if hide_terminal_gaps and terminal_gap_rejects(
        sorted_footprints, ref_start, ref_end, terminal_gap_threshold, call_extent,
    ):
        return [], [], [], [], True

    intervals: list[list[int]] = []
    fp_quality_list: list[int] = []
    lq_quality_list: list[int] = []
    rq_quality_list: list[int] = []
    for clip_start, clip_end, size, i in walk_read_intervals(
        [(fp[0], fp[1], fp[2]) for fp in sorted_footprints],
        ref_start, ref_end, region_start, region_end, hide_terminal_gaps,
        call_extent=call_extent,
    ):
        intervals.append([int(clip_start - region_start), int(clip_end - region_start), int(size)])
        if i is None:
            continue
        _, _, _, fp_q, tag_index = sorted_footprints[i]
        if fp_q is not None:
            fp_quality_list.append(fp_q)
        if lq_qualities is not None:
            lq_quality_list.append(
                lq_qualities[tag_index] if tag_index < len(lq_qualities) else 0
            )
        if rq_qualities is not None:
            rq_quality_list.append(
                rq_qualities[tag_index] if tag_index < len(rq_qualities) else 0
            )

    return intervals, fp_quality_list, lq_quality_list, rq_quality_list, False


def _load_fire_fiber_bigbeds(bb_files, chrom_variants, region_start, region_end, *,
                             bigbed_handle_getter, fire_kind_detector=None, **read_options):
    """Split FIRE per-fiber bigBeds off ``bb_files`` and build their reads.

    Returns (the other files, the FIRE reads). A fire-fibers.bb is read with
    its fire-fiber-decorators.bb (listed, or found next to it); a fibers file
    with no decorators gives span-only reads.
    """
    from services.bigbed_detection import detect_fire_bigbed_kind, find_fire_decorator_sibling
    from services.bigbed_read_loader import FIRE_DECORATOR_FETCH_PAD, fire_fiber_reads

    detector = fire_kind_detector or detect_fire_bigbed_kind
    kinds = {}
    for path in bb_files:
        if _is_fiberlayers_bed_file(path):
            continue
        try:
            kind = detector(path)
        except Exception:
            kind = None
        if kind in ('fibers', 'decorators'):
            kinds[path] = kind
    if not kinds:
        return bb_files, []

    decorator_paths = [p for p, k in kinds.items() if k == 'decorators']
    pairs = []  # (fibers path or None, decorators path or None)
    for path, kind in kinds.items():
        if kind != 'fibers':
            continue
        sibling = next(iter(decorator_paths), None) if len(decorator_paths) == 1 else None
        if sibling is None:
            sibling = find_fire_decorator_sibling(path)
        if sibling in decorator_paths:
            decorator_paths.remove(sibling)
        pairs.append((path, sibling))
    pairs.extend((None, path) for path in decorator_paths)

    def _entries(path, start, end):
        try:
            bw = bigbed_handle_getter(path)
            if bw is None:
                return []
            available = bw.chroms()
            chrom = next((v for v in chrom_variants if v in available), None)
            if chrom is None:
                return []
            return bigbed_entries_in_bounds(bw, chrom, start, end, available) or []
        except Exception as exc:
            log_bigbed_diagnostic(f"  FIRE bigBed {os.path.basename(str(path))}: {exc}")
            return []

    reads = []
    for fibers_path, decorators_path in pairs:
        fiber_entries = _entries(fibers_path, region_start, region_end) if fibers_path else None
        decorator_entries = []
        if decorators_path:
            decorator_entries = _fire_decorators_for_whole_fibers(
                lambda start, end: _entries(decorators_path, start, end),
                region_start, region_end, fiber_entries, FIRE_DECORATOR_FETCH_PAD)
        reads.extend(fire_fiber_reads(
            decorator_entries, region_start, region_end, fiber_entries=fiber_entries, **read_options,
        ))
    return [p for p in bb_files if p not in kinds], reads


def _fire_decorators_for_whole_fibers(fetch, region_start, region_end, fiber_entries, pad):
    """Every decorator row of every fiber that overlaps the window.

    Decorator rows are indexed by the span of their own calls, so a window
    query misses the rows of a fiber whose calls of one kind all lie outside
    it (e.g. the MSP before a long gap), and the footprints inferred between
    MSPs would then start or end at the wrong place and change size with the
    viewport. The first query (the window padded by ``pad``) finds the fibers
    (their decoratedItem spans, and the fire-fibers rows when present); if any
    of them extends beyond it, the rows are read again over the union of those
    fibers' spans. A fiber's rows all lie inside its span, so that holds all
    of them.
    """
    from services.bigbed_read_loader import parse_decorated_item

    lo, hi = max(0, region_start - pad), region_end + pad
    rows = fetch(lo, hi)
    need_lo, need_hi = lo, hi
    for e_start, e_end, _rest in fiber_entries or ():
        if e_start < region_end and e_end > region_start:
            need_lo, need_hi = min(need_lo, int(e_start)), max(need_hi, int(e_end))
    for _e_start, _e_end, rest in rows:
        fields = rest.split('\t')
        item = parse_decorated_item(fields[9]) if len(fields) >= 10 else None
        if item is not None and item[1] < region_end and item[2] > region_start:
            need_lo, need_hi = min(need_lo, item[1]), max(need_hi, item[2])
    if need_lo < lo or need_hi > hi:
        rows = fetch(need_lo, need_hi)
    return rows


def _whole_molecule_entries(paths, groups, fetch, start, end):
    """Fetch counterparts of visible molecules whose layer rows end outside the view."""
    entries = {path: fetch(path, start, end) for path in paths}
    names, spans = {}, {}
    for path, rows in entries.items():
        group = groups.get(path, '')
        ids = names.setdefault(group, set())
        lo, hi = spans.get(group, (start, end))
        for a, b, rest in rows:
            ids.add(rest.split('\t', 1)[0])
            lo, hi = min(lo, a), max(hi, b)
        spans[group] = lo, hi
    for path in paths:
        group = groups.get(path, '')
        # An unnamed companion can belong to any of the named samples.
        related = list(names) if group is None else [group, None]
        ids = set().union(*(names.get(key, set()) for key in related))
        lo = min((spans[key][0] for key in related if key in spans), default=start)
        hi = max((spans[key][1] for key in related if key in spans), default=end)
        if lo < start or hi > end:
            entries[path] = [row for row in fetch(path, lo, hi) if row[2].split('\t', 1)[0] in ids]
    return entries


def build_compact_reads_from_bigbed(
    bigbed_path,
    chrom,
    region_start,
    region_end,
    spanning_only=True,
    include_methylation=False,
    ml_threshold=125,
    hide_terminal_gaps=True,
    terminal_gap_threshold=500,
    include_layers=True,
    requested_layers=None,
    include_layer_qualities=True,
    infer_legacy_layers=True,
    legacy_nuc_min_size=90,
    include_duplicates=False,
    min_footprints=0,
    bigbed_handle_getter=None,
    overlay_type_detector=None,
    duplicate_field_detector=None,
    swapped_column_detector=None,
    format_cache=None,
    fire_kind_detector=None,
    short_terminal_footprint_bp=0,
):
    """
    Build compact interval representation of reads.
    Returns list of {id, intervals: [[start, end, size], ...]}
    where start/end are clipped to region, size is original (negative for gaps).

    Accepts:
    - Single file path
    - Directory path
    - List of file paths

    Note: include_methylation and ml_threshold are accepted for API compatibility but BigBed files
    do not contain methylation data (MM/ML tags are BAM-specific).

    Auto-detects and handles old BigBed files where blockStarts and blockSizes were swapped.

    Args:
        hide_terminal_gaps: If True, hide leading/trailing gaps (before first footprint,
                           after last footprint). Default True for cleaner display.
        include_layers: If True, include layer payloads in addition to primary intervals.
        requested_layers: Optional iterable of layer names to include. None means all layers.
        include_layer_qualities: If False, omit per-layer quality arrays from layer payloads.
        short_terminal_footprint_bp: drop a footprint block at either end of a
            single-file read shorter than this (0 keeps them; merged
            multi-file molecules are not filtered).
    """
    import numpy as np
    import pandas as pd
    from utils.chrom import get_chrom_variants, resolve_reference_name

    if bigbed_handle_getter is None:
        from services.bigbed_handles import get_bigbed_handle as bigbed_handle_getter
    if overlay_type_detector is None:
        from services.bigbed_detection import detect_overlay_type as overlay_type_detector
    if duplicate_field_detector is None:
        from services.bigbed_detection import bigbed_has_duplicate_field as duplicate_field_detector
    if swapped_column_detector is None:
        swapped_column_detector = detect_swapped_bed12_columns
    if format_cache is None:
        format_cache = _bigbed_format_cache
    from services.bam_tags import infer_legacy_layers_from_intervals
    from services.bigbed_detection import is_ddda_mcg_block

    reads = []
    include_layers, requested_layer_set = normalize_layer_request(include_layers, requested_layers)

    def _wants_layer(*names: str) -> bool:
        return wants_layer(include_layers, requested_layer_set, *names)

    def _wants_inferred_layer(name: str) -> bool:
        if name == 'nuc':
            return _wants_layer('nuc', 'footprint')
        if name == 'msp':
            return _wants_layer('msp', 'fire')
        return _wants_layer(name)

    # Get chrom variants for flexible matching
    chrom_variants = get_chrom_variants(chrom)

    # Build list of files to process
    if isinstance(bigbed_path, list):
        bb_files = bigbed_path
    elif is_url(bigbed_path) or os.path.isfile(bigbed_path):
        bb_files = [bigbed_path]
    else:
        bb_files = [os.path.join(bigbed_path, f) for f in os.listdir(bigbed_path)
                    if f.endswith(('.bb', '.bigbed', '.bigBed'))]

    # fibertools/FIRE per-fiber bigBeds (fire-fibers.bb, fire-fiber-decorators.bb)
    # are not FiberHMM footprint tables: their rows are read by fire_fiber_reads.
    bb_files, fire_reads = _load_fire_fiber_bigbeds(
        bb_files, chrom_variants, region_start, region_end,
        bigbed_handle_getter=bigbed_handle_getter,
        fire_kind_detector=fire_kind_detector,
        spanning_only=spanning_only,
        hide_terminal_gaps=hide_terminal_gaps,
        min_footprints=min_footprints,
        include_nuc=_wants_inferred_layer('nuc'),
        include_msp=_wants_layer('msp', 'fire'),
        include_layer_qualities=include_layer_qualities,
    )
    reads.extend(fire_reads)

    reads_per_file = {}  # Track reads per file for debugging
    # If multiple files are being merged (companion-style loading), keep a
    # read_id -> dict mapping so features from tf.bb + msp.bb + fp.bb all merge
    # onto the same read's layers. When only one file is being read (common),
    # we fall back to the simple append path.
    # Keyed by (sample group, read name): merging several samples' files must
    # not fuse two molecules that happen to share a read name.
    merged_reads_by_id: Dict[tuple, dict] = {}
    groups_by_read: Dict[str, set] = {}
    min_footprint_pass_ids: set = set()
    # Molecules whose footprint row failed the terminal-gap filter: their
    # companion rows go with them.
    terminal_gap_rejected: set = set()
    multi_file = len(bb_files) > 1
    # Merged molecules, with terminal gaps hidden: each one's footprint row
    # (sorted blocks and read span) and the whole-read extent of its TF calls
    # from the companion file. The TF calls bound the read's body too (the
    # footprint BigBed holds nucleosomes only), so no TF is drawn beyond its
    # read, and the terminal-gap filter measures to the nearest call of either
    # kind; both are settled when the molecule is flushed.
    footprint_rows: Dict[tuple, tuple] = {}
    tf_call_extents: Dict[tuple, tuple] = {}

    def _file_layer_type(path):
        if _is_fiberlayers_bed_file(path):
            return 'fiberlayers'
        kind = overlay_type_detector(path)
        return 'msp' if kind == 'fire' else kind

    file_groups: Dict[str, Optional[str]] = {}
    if multi_file:
        layer_types = {path: _file_layer_type(path) for path in bb_files}
        file_groups = bigbed_merge_groups(layer_types)
        # Footprint files first, so a companion without a recognisable sample
        # name finds the reads it belongs to.
        bb_files = sorted(bb_files, key=lambda path: layer_types[path] not in _PRIMARY_BIGBED_TYPES)

    def _merge_key(path, read_id):
        group = file_groups.get(path, '')
        if group is None:
            seen = groups_by_read.get(read_id) or set()
            if len(seen) != 1:
                return None  # no sample, or several: can't tell which molecule
            group = next(iter(seen))
        return (group, read_id)

    def fetch_entries(path, start, end):
        from services.background_work import checkpoint
        checkpoint()
        if _is_fiberlayers_bed_file(path):
            return _entries_from_fiberlayers_bed(path, chrom_variants, start, end)
        try:
            bw = bigbed_handle_getter(path)
            if bw is None:
                return []
            chroms = bw.chroms()
            matching = next((variant for variant in chrom_variants if variant in chroms), None)
            if matching is None:
                return []
            return bigbed_entries_in_bounds(bw, matching, start, end, chroms) or []
        except Exception:
            return []

    molecule_entries = None
    if multi_file and not spanning_only:
        active_paths = [path for path in bb_files if not (
            (layer_types[path] == 'tf' and not _wants_layer('tf'))
            or (layer_types[path] == 'msp' and not _wants_layer('msp', 'fire'))
            or (layer_types[path] == 'bothstrand' and not _wants_layer('bothstrand')))]
        molecule_entries = _whole_molecule_entries(active_paths, file_groups, fetch_entries, region_start, region_end)

    for filepath in bb_files:
        file_reads_start = len(reads)
        has_duplicate_field = bool(duplicate_field_detector(filepath))
        # Identify which fiberhmm layer this file carries (autoSQL -> filename).
        # 'footprint' becomes the primary intervals + nuc layer; 'tf' and 'msp'
        # become their own layers; 'fiberlayers' rows carry their class_id as
        # an extra BED12+ column; 'm6a'/'m5c' are handled elsewhere (methyl).
        is_fiberlayers_bed = _is_fiberlayers_bed_file(filepath)
        file_layer_type = 'fiberlayers' if is_fiberlayers_bed else overlay_type_detector(filepath)
        # FIRE is the user-facing name; compact read payloads keep the legacy
        # internal key `msp` so existing render/analysis code can alias it.
        if file_layer_type == 'fire':
            file_layer_type = 'msp'
        if file_layer_type == 'tf' and not _wants_layer('tf'):
            continue
        if file_layer_type == 'msp' and not _wants_layer('msp', 'fire'):
            continue
        if file_layer_type == 'bothstrand' and not _wants_layer('bothstrand'):
            continue

        entries = (molecule_entries.get(filepath, []) if molecule_entries is not None
                   else fetch_entries(filepath, region_start, region_end))
        if not entries:
            continue
        if is_fiberlayers_bed:
            is_swapped = False
        else:
            # Detect swapped columns on first encounter (needs a small DataFrame for detection)
            if filepath not in format_cache:
                det_df = pd.DataFrame(entries[:min(20, len(entries))], columns=['start', 'end', 'rest'])
                try:
                    cols = ['name', 'X1', 'X2', 'X3', 'X4', 'X5', 'blockCount', 'blockSizes', 'blockStarts']
                    det_df[cols] = det_df['rest'].str.split('\t', expand=True)
                    format_cache[filepath] = swapped_column_detector(det_df)
                except Exception:
                    format_cache[filepath] = False

            is_swapped = format_cache[filepath]

        # Process entries directly without full DataFrame
        from services.background_work import checkpoint
        for entry_index, (e_start, e_end, rest) in enumerate(entries):
            if entry_index % 256 == 0:
                checkpoint()
            read_start = int(e_start)
            read_end = int(e_end)

            # Filter by spanning
            if spanning_only:
                if read_start > region_start or read_end < region_end:
                    continue
            elif molecule_entries is None:
                if read_start >= region_end or read_end <= region_start:
                    continue

            fields = rest.split('\t')
            if len(fields) < 9:
                continue
            layout_fields = fields[:-1] if has_duplicate_field else fields
            circular_group = parse_bed_circular_group_fields(layout_fields)

            read_id = fields[0] or f'read_{len(reads)}'
            is_duplicate = bool(has_duplicate_field and fields[-1].strip() == '1')
            if is_duplicate and not include_duplicates:
                continue
            derived_layer_name = None
            if file_layer_type == 'fiberlayers':
                if len(fields) < 10:
                    continue
                derived_layer_name = fields[9].strip()
                if not derived_layer_name or not _wants_layer(derived_layer_name):
                    continue

            bs_str = fields[8].rstrip(',')  # blockStarts
            bz_str = fields[7].rstrip(',')  # blockSizes
            if is_swapped:
                bs_str, bz_str = bz_str, bs_str

            # Skip entries with missing or invalid block data ('.' is BED placeholder for missing)
            if not bs_str or not bz_str or bs_str == '.' or bz_str == '.':
                continue

            try:
                raw_starts = np.array([int(x) for x in bs_str.split(',')]) if ',' in bs_str else np.array([int(bs_str)])
                raw_sizes = np.array([int(x) for x in bz_str.split(',')]) if ',' in bz_str else np.array([int(bz_str)])
            except ValueError:
                # Skip entries with non-numeric block data
                continue

            is_primary_footprint_file = file_layer_type in ('footprint', None, 'unknown')
            merge_key = _merge_key(filepath, read_id) if multi_file else ('', read_id)
            if multi_file and merge_key is None:
                continue
            if is_primary_footprint_file:
                if min_footprints > 0 and len(raw_starts) < min_footprints:
                    continue
                min_footprint_pass_ids.add(merge_key)
                if multi_file:
                    groups_by_read.setdefault(read_id, set()).add(merge_key[0])

            # BED12+N: FiberHMM 2.9+ embeds per-block quality arrays in extra
            # columns beyond the standard BED12 (blockSizes, chromStarts).
            # Layer type -> expected extra column names (ordered):
            #   footprint -> [blockNq, blockEl, blockEr]   (bed12+3 w/ recaller;
            #                 bed12+1 for legacy/HMM-only nucleosomes, where the
            #                 el/er columns are absent and the per-column guard
            #                 below stops after blockNq)
            #   msp       -> [blockAq]          (bed12+1)
            #   tf        -> [blockTq, blockEl, blockEr]   (bed12+3)
            # Each extra column is a comma-separated int array of length
            # blockCount, same 1:1 alignment as blockSizes / chromStarts.
            # Off by default on the write side, so files without extra columns
            # (all pre-2.9 BigBeds) still parse via the zero-qualities path.
            _BLOCK_QUAL_SPEC = {
                'footprint': ['nq', 'el', 'er'],
                'msp':       ['aq'],
                'tf':        ['tq', 'el', 'er'],
                # m6a/m5c blocks represent runs of modified bases; `ml` is the
                # per-block ML probability (0-255). Exposed per-base below.
                'm6a':       ['ml'],
                'm5c':       ['ml'],
                # deam block -> per-block `blockMod` (0=R/GA-dea, 1=Y/CT-dea).
                'deam':      ['blockMod'],
            }
            raw_qualities: Dict[str, np.ndarray] = {}
            if include_layer_qualities and file_layer_type == 'fiberlayers':
                qstr = layout_fields[12].rstrip(',').strip() if len(layout_fields) >= 13 else ''
                if qstr and qstr != '.':
                    try:
                        qvals = (np.fromstring(qstr, sep=',', dtype=np.int64)
                                 if ',' in qstr else np.array([int(qstr)], dtype=np.int64))
                    except (ValueError, TypeError):
                        qvals = np.array([], dtype=np.int64)
                    if len(qvals) == len(raw_starts):
                        raw_qualities['confidence'] = qvals
            elif (
                len(layout_fields) >= 10
                and file_layer_type in _BLOCK_QUAL_SPEC
                # deam's flavor and m5c's blockMl (a 0 marks a DddA span) are
                # needed to read the blocks, not only as qualities.
                and (include_layer_qualities or file_layer_type in ('deam', 'm5c'))
            ):
                for qi, qname in enumerate(_BLOCK_QUAL_SPEC[file_layer_type]):
                    col_idx = 9 + qi  # fields[9]=blockNq/Aq/Tq, [10]=El, [11]=Er
                    if col_idx >= len(layout_fields):
                        break
                    qstr = layout_fields[col_idx].rstrip(',').strip()
                    if not qstr or qstr == '.':
                        continue
                    try:
                        qvals = (np.fromstring(qstr, sep=',', dtype=np.int64)
                                 if ',' in qstr else np.array([int(qstr)], dtype=np.int64))
                    except (ValueError, TypeError):
                        continue
                    if len(qvals) == len(raw_starts):
                        raw_qualities[qname] = qvals

            abs_starts = raw_starts + read_start
            abs_ends = abs_starts + raw_sizes

            # Sort by position
            sort_idx = np.argsort(abs_starts)
            abs_starts = abs_starts[sort_idx]
            abs_ends = abs_ends[sort_idx]
            raw_sizes = raw_sizes[sort_idx]
            # Keep raw_qualities aligned with the sorted blocks.
            if raw_qualities:
                for qname in list(raw_qualities):
                    raw_qualities[qname] = raw_qualities[qname][sort_idx]

            if multi_file and hide_terminal_gaps and len(abs_starts):
                if file_layer_type == 'tf':
                    lo, hi = int(abs_starts[0]), int(abs_ends.max())
                    known = tf_call_extents.get(merge_key)
                    tf_call_extents[merge_key] = (lo, hi) if known is None else (min(known[0], lo), max(known[1], hi))
                elif is_primary_footprint_file and merge_key not in footprint_rows:
                    footprint_rows[merge_key] = (
                        [(int(a), int(b), int(z)) for a, b, z in zip(abs_starts, abs_ends, raw_sizes)],
                        read_start, read_end,
                    )
                    # A narrow view may fall between this row's nucleosomes
                    # and its companion TF calls. Keep its place until merging.
                    entry = merged_reads_by_id.setdefault(merge_key, {'id': read_id, 'intervals': [], 'layers': {}})
                    if is_duplicate:
                        entry['duplicate'] = True
                    if circular_group and circular_group.get('circ_id'):
                        entry['circular_group'] = circular_group

            # ---- m6a / m5c / deam - per-base mark expansion ----
            # These track types don't carry HMM features; each block is a run
            # of per-base modification / deamination calls. Bypass the
            # footprint-style interval loop entirely and build the per-type
            # `methyl_m6a` / `methyl_m5c` / `deam` field the frontend expects.
            if file_layer_type in ('m6a', 'm5c', 'deam'):
                mod_qual = raw_qualities.get('ml')          # blockMl (m6a/m5c)
                mod_flavor = raw_qualities.get('blockMod')  # blockMod (deam)
                mark_list: list = []
                # m5c BigBeds also carry DddA ddda_mcg spans (blockMl 0): an
                # interval layer, never expanded into per-base 5mC marks.
                ddda_mcg_intervals: list = []
                has_ddda_span = False
                for raw_i, (blk_start, blk_end) in enumerate(zip(abs_starts, abs_ends)):
                    if blk_end <= region_start or blk_start >= region_end:
                        continue
                    clip_start = max(int(blk_start), region_start)
                    clip_end = min(int(blk_end), region_end)
                    if clip_end <= clip_start:
                        continue
                    if file_layer_type == 'm5c' and is_ddda_mcg_block(
                        int(raw_sizes[raw_i]), int(mod_qual[raw_i]) if mod_qual is not None else None,
                    ):
                        has_ddda_span = True
                        if _wants_layer('ddda_mcg'):
                            ddda_mcg_intervals.append(
                                [clip_start - region_start, clip_end - region_start, int(raw_sizes[raw_i])])
                        continue
                    if file_layer_type == 'deam':
                        flavor = 1 if (mod_flavor is not None and int(mod_flavor[raw_i])) else 0
                        for pos in range(clip_start, clip_end):
                            mark_list.append([pos - region_start, flavor])
                    else:
                        # m6a / m5c - flat position list. Per-base ML can be
                        # threaded as a parallel quality array in a follow-up;
                        # rendering currently consumes positions-only.
                        for pos in range(clip_start, clip_end):
                            mark_list.append(pos - region_start)

                # A DddA read of an m5c-only source still shows (as its span)
                # when its ddda_mcg layer isn't requested.
                if not mark_list and not ddda_mcg_intervals and not (has_ddda_span and not multi_file):
                    continue
                ddda_layer = ({'ddda_mcg': {'intervals': ddda_mcg_intervals, 'qualities': None,
                                            'quality_names': []}}
                              if ddda_mcg_intervals else {})

                read_span_iv = [
                    int(max(read_start, region_start) - region_start),
                    int(min(read_end, region_end) - region_start),
                    0,  # size=0 marks this as a raw-span placeholder (not a footprint)
                ]
                field_name = {'m6a': 'methyl_m6a', 'm5c': 'methyl_m5c', 'deam': 'deam'}[file_layer_type]

                if multi_file:
                    # In multi-file mode, a footprint companion is usually
                    # present and owns `intervals` - don't plant a zero-size
                    # span placeholder here (it would look "already set" and
                    # block the footprint file from populating real intervals
                    # later in the merge loop). If no footprint file is
                    # present at all, the flush step below synthesizes a
                    # placeholder so the read still displays.
                    entry = merged_reads_by_id.get(merge_key)
                    if entry is None:
                        entry = {'id': read_id, 'intervals': [], 'layers': {}}
                        merged_reads_by_id[merge_key] = entry
                    if is_duplicate:
                        entry['duplicate'] = True
                    if mark_list:
                        entry[field_name] = mark_list
                    entry.setdefault('layers', {}).update(ddda_layer)
                    # Stash the read span for the post-merge fallback.
                    if not entry.get('_span_fallback'):
                        entry['_span_fallback'] = read_span_iv
                else:
                    read_data = {'id': read_id, 'intervals': [read_span_iv]}
                    if mark_list:
                        read_data[field_name] = mark_list
                        # Back-compat: `methyl` union lets legacy 'mod' toggle + any
                        # code reading `read.methyl` keep rendering a single track.
                        if field_name == 'deam':
                            read_data['methyl'] = [e[0] for e in mark_list]
                        else:
                            read_data['methyl'] = mark_list
                    if ddda_layer:
                        read_data['layers'] = ddda_layer
                    if is_duplicate:
                        read_data['duplicate'] = True
                    reads.append(read_data)
                # Skip the footprint/interval path entirely for these types.
                continue

            # Filter reads with large terminal gaps (gap between alignment edge and first/last footprint).
            # In a merge this is the molecule's call, made on its footprint row:
            # a companion's sparse calls (TF, MSP) aren't the read's edges.
            # (A merged molecule is judged when it is flushed, once its TF
            # calls are known too.)
            if hide_terminal_gaps and terminal_gap_threshold > 0 and not multi_file:
                leading_gap = abs_starts[0] - read_start
                trailing_gap = read_end - abs_ends[-1]
                if leading_gap > terminal_gap_threshold or trailing_gap > terminal_gap_threshold:
                    continue

            # Read-end footprints under the cutoff (the first block and the one
            # ending last): judged on the whole row, after the gap filter. The
            # read keeps its body over all its blocks (as the BAM loader does).
            body_extent = None
            if (short_terminal_footprint_bp > 0 and not multi_file and len(abs_starts)
                    and is_primary_footprint_file):
                last_i = int(np.argmax(abs_ends))
                # Only at the read end (SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP).
                drop_i = set()
                if (int(raw_sizes[0]) < short_terminal_footprint_bp
                        and int(abs_starts[0]) - int(read_start) < SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP):
                    drop_i.add(0)
                if (int(raw_sizes[last_i]) < short_terminal_footprint_bp
                        and int(read_end) - int(abs_ends[last_i]) < SHORT_TERMINAL_FOOTPRINT_MAX_END_GAP_BP):
                    drop_i.add(last_i)
                if drop_i:
                    body_extent = (int(abs_starts[0]), int(abs_ends[last_i]))
                    keep = np.ones(len(abs_starts), dtype=bool)
                    keep[list(drop_i)] = False
                    abs_starts, abs_ends, raw_sizes = abs_starts[keep], abs_ends[keep], raw_sizes[keep]
                    for qname in list(raw_qualities):
                        raw_qualities[qname] = raw_qualities[qname][keep]

            intervals = []
            # Track which raw (sorted) block indices survived region-clipping so
            # we can slice the per-block quality arrays to match layer_ivs.
            fp_raw_indices: List[int] = []
            blocks = zip(abs_starts, abs_ends, raw_sizes)
            for clip_start, clip_end, size, raw_i in walk_read_intervals(
                blocks if body_extent is None else list(blocks),
                read_start, read_end, region_start, region_end, hide_terminal_gaps,
                call_extent=body_extent,
            ):
                # Footprints keep their original size (for coloring); bounds are clipped.
                intervals.append([int(clip_start - region_start), int(clip_end - region_start), int(size)])
                if raw_i is not None:
                    fp_raw_indices.append(raw_i)
            if body_extent is not None and not len(abs_starts):
                # Only read-end stubs: the read stays, empty, where they were.
                lo = max(body_extent[0] if hide_terminal_gaps else read_start, region_start)
                hi = min(body_extent[1] if hide_terminal_gaps else read_end, region_end)
                if hi > lo:
                    intervals = [[int(lo - region_start), int(hi - region_start), 0]]

            if intervals:
                # Layer-specific intervals derived from this bigBed's track type.
                # For footprint bigBeds: ALSO emit a 'nuc' layer so layer-aware
                # consumers (clustering, sort, Pol II) can use it without a size
                # heuristic. For tf/msp bigBeds: features belong to that layer
                # only (don't duplicate into primary intervals as nucleosomes).
                layer_ivs = [[iv[0], iv[1], iv[2]] for iv in intervals if iv[2] > 0]

                # Build per-layer qualities matching layer_ivs row order.
                # raw_qualities keys are the quality_names; each value is a
                # sorted array aligned with the raw (post-sort) block order.
                # fp_raw_indices picks the entries that survived region-clip.
                layer_qualities = None
                layer_qual_names: List[str] = []
                if include_layer_qualities and raw_qualities and fp_raw_indices:
                    layer_qual_names = list(raw_qualities.keys())
                    layer_qualities = [
                        [int(raw_qualities[qn][i]) for i in fp_raw_indices]
                        for qn in layer_qual_names
                    ]

                def _layer_dict() -> Dict:
                    payload = {
                        'intervals': layer_ivs,
                        'qualities': layer_qualities,
                        'quality_names': layer_qual_names,
                    }
                    if circular_group and circular_group.get("circ_id"):
                        payload['annotation_names'] = [circular_group["circ_id"]] * len(layer_ivs)
                        payload['circular_ids'] = [circular_group["circ_id"]] * len(layer_ivs)
                        payload['circular_group'] = circular_group
                    return payload

                if multi_file:
                    # Merge with any previously-seen entry for this read_id so
                    # tf.bb + msp.bb + fp.bb contribute to a single read's layers.
                    entry = merged_reads_by_id.get(merge_key)
                    if entry is None:
                        entry = {'id': read_id, 'intervals': [], 'layers': {}}
                        merged_reads_by_id[merge_key] = entry
                    if is_duplicate:
                        entry['duplicate'] = True
                    if circular_group and circular_group.get("circ_id"):
                        entry.setdefault('annotation_names', []).extend([circular_group["circ_id"]] * len(layer_ivs))
                        entry.setdefault('circular_ids', []).extend([circular_group["circ_id"]] * len(layer_ivs))
                        entry['circular_group'] = circular_group
                    # One footprint record per molecule: a second one with the
                    # same key (a duplicate row) adds neither intervals nor layers.
                    owns_intervals = (file_layer_type in ('footprint', None, 'unknown')
                                      and not entry['intervals'])
                    if owns_intervals:
                        entry['intervals'] = intervals
                    if owns_intervals and infer_legacy_layers:
                        inferred_layers = infer_legacy_layers_from_intervals(
                            intervals,
                            quality_names=layer_qual_names,
                            qualities=layer_qualities,
                            nuc_min_size=legacy_nuc_min_size,
                            infer_tf=_wants_inferred_layer('tf'),
                            infer_nuc=_wants_inferred_layer('nuc'),
                            infer_msp=_wants_inferred_layer('msp'),
                        )
                        # A layer a companion file calls explicitly wins over one
                        # inferred from footprint sizes, whichever file loads first.
                        explicit = entry.get('_explicit_layers') or ()
                        for inferred_name, inferred_layer in inferred_layers.items():
                            if _wants_inferred_layer(inferred_name) and inferred_name not in explicit:
                                entry['layers'][inferred_name] = inferred_layer
                    elif file_layer_type == 'tf' and layer_ivs and _wants_layer('tf'):
                        entry['layers'][file_layer_type] = _layer_dict()
                        entry.setdefault('_explicit_layers', set()).add(file_layer_type)
                    elif file_layer_type == 'msp' and layer_ivs and _wants_layer('msp', 'fire'):
                        entry['layers'][file_layer_type] = _layer_dict()
                        entry.setdefault('_explicit_layers', set()).add(file_layer_type)
                    elif file_layer_type == 'bothstrand' and layer_ivs:
                        entry['layers'][file_layer_type] = _layer_dict()
                    elif file_layer_type == 'fiberlayers' and derived_layer_name and layer_ivs:
                        entry['layers'][derived_layer_name] = _layer_dict()
                else:
                    read_data = {'id': read_id, 'intervals': intervals}
                    if is_duplicate:
                        read_data['duplicate'] = True
                    if circular_group and circular_group.get("circ_id"):
                        read_data['annotation_names'] = [circular_group["circ_id"]] * len(layer_ivs)
                        read_data['circular_ids'] = [circular_group["circ_id"]] * len(layer_ivs)
                        read_data['circular_group'] = circular_group
                    if file_layer_type in ('footprint', None, 'unknown') and infer_legacy_layers:
                        inferred_layers = infer_legacy_layers_from_intervals(
                            intervals,
                            quality_names=layer_qual_names,
                            qualities=layer_qualities,
                            nuc_min_size=legacy_nuc_min_size,
                            infer_tf=_wants_inferred_layer('tf'),
                            infer_nuc=_wants_inferred_layer('nuc'),
                            infer_msp=_wants_inferred_layer('msp'),
                        )
                        filtered_layers = {
                            inferred_name: inferred_layer
                            for inferred_name, inferred_layer in inferred_layers.items()
                            if _wants_inferred_layer(inferred_name)
                        }
                        if filtered_layers:
                            read_data['layers'] = filtered_layers
                    elif file_layer_type == 'tf' and layer_ivs and _wants_layer('tf'):
                        read_data['layers'] = {file_layer_type: _layer_dict()}
                    elif file_layer_type == 'msp' and layer_ivs and _wants_layer('msp', 'fire'):
                        read_data['layers'] = {file_layer_type: _layer_dict()}
                    elif file_layer_type == 'bothstrand' and layer_ivs:
                        read_data['layers'] = {file_layer_type: _layer_dict()}
                    elif file_layer_type == 'fiberlayers' and derived_layer_name and layer_ivs:
                        # A bare fiberlayers file has no primary read spans; it
                        # is intended to merge onto a BAM/BigBed source by read id.
                        read_data = {
                            'id': read_id, 'intervals': [],
                            'layers': {derived_layer_name: _layer_dict()},
                        }
                        if is_duplicate:
                            read_data['duplicate'] = True
                    reads.append(read_data)

        # Track reads from this file (single-file mode) or contribution counts
        # (multi-file mode: number of rows this file contributed, not read_ids).
        if not multi_file:
            file_reads = len(reads) - file_reads_start
            if file_reads > 0:
                reads_per_file[os.path.basename(filepath)] = file_reads

    # Flush merged reads (multi-file path)
    if multi_file:
        for merge_key, (blocks, fp_read_start, fp_read_end) in footprint_rows.items():
            call_extent = tf_call_extents.get(merge_key)
            if terminal_gap_threshold > 0:
                first_call, last_call = blocks[0][0], blocks[-1][1]
                if call_extent is not None:
                    first_call, last_call = min(first_call, call_extent[0]), max(last_call, call_extent[1])
                if (first_call - fp_read_start > terminal_gap_threshold
                        or fp_read_end - last_call > terminal_gap_threshold):
                    terminal_gap_rejected.add(merge_key)
                    continue
            entry = merged_reads_by_id.get(merge_key)
            if call_extent is None or entry is None:
                continue
            # The body over the TF calls: the footprint row walked again with
            # them (its footprints, and so their qualities and layers, are the
            # same; only the gaps out to the TF calls are added).
            entry['intervals'] = [
                [int(a - region_start), int(b - region_start), int(size)]
                for a, b, size, _ in walk_read_intervals(
                    blocks, fp_read_start, fp_read_end, region_start, region_end, True,
                    call_extent=call_extent,
                )
            ]
        layer_counts: Dict[str, int] = {}
        for merge_key, entry in merged_reads_by_id.items():
            entry.pop('_explicit_layers', None)
            if min_footprints > 0 and merge_key not in min_footprint_pass_ids:
                continue
            if merge_key in terminal_gap_rejected:
                continue
            if merge_key[0]:
                # Several samples merged: which one this molecule is, so marks
                # loaded later from companion files go to the right read.
                entry['bigbed_sample'] = merge_key[0]
            # If only per-base mark data landed on this read (m6a/m5c/deam with
            # no footprint companion contributing), synthesize a single-span
            # placeholder so the read still has a positionable interval. Kept
            # OFF the happy path - footprint files set real intervals and we
            # just drop the stashed fallback.
            if not entry['intervals']:
                fallback = entry.pop('_span_fallback', None)
                if fallback is not None and (
                    entry.get('methyl_m6a') or entry.get('methyl_m5c') or entry.get('deam')
                    or (entry.get('layers') or {}).get('ddda_mcg')
                ):
                    entry['intervals'] = [fallback]
            else:
                entry.pop('_span_fallback', None)

            if not entry['intervals'] and not entry['layers']:
                continue
            if not entry['layers']:
                entry.pop('layers', None)
            else:
                for layer_name in entry['layers']:
                    layer_counts[layer_name] = layer_counts.get(layer_name, 0) + 1
            reads.append(entry)
        if layer_counts:
            log_bigbed_diagnostic(
                f"  build_compact_reads: merged {len(reads)} reads from {len(bb_files)} files, layers: {layer_counts}"
            )
    elif len(reads_per_file) > 1:
        log_bigbed_diagnostic(
            f"  build_compact_reads: loaded {len(reads)} total reads from {len(reads_per_file)} files: {reads_per_file}"
        )

    return reads


def build_compact_reads_from_bam(
    bam_path,
    chrom,
    region_start,
    region_end,
    spanning_only=True,
    include_methylation=False,
    ml_threshold=125,
    min_fp_quality=0,
    include_cigar=False,
    hide_terminal_gaps=True,
    terminal_gap_threshold=500,
    include_layers=True,
    requested_layers=None,
    include_layer_qualities=True,
    infer_legacy_layers=True,
    legacy_nuc_min_size=90,
    include_duplicates=False,
    min_footprints=0,
    bam_handle_getter=None,
    chrom_map=None,
    circular=False,
    contig_links=None,
    short_terminal_footprint_bp=0,
    sv_min_len=SV_MIN_LEN_DEFAULT,
    include_sv_seq=False,
    fetch_regions=None,
    include_supplementary=False,
    include_lift_meta=False,
    lift_counts=None,
    load_budget=None,
    sample_bounds=None,
    sv_reference=None,
):
    """Build compact interval reads from a BAM file.

    Every read carries ``sv`` evidence (services/sv_events.py: deletions,
    insertions and clips at the shared evidence floor, plus SA segments;
    absolute coordinates). Calls are split at deletions >= ``sv_min_len``. ``include_sv_seq`` adds the
    first bases of each insertion.

    ``short_terminal_footprint_bp``: drop a footprint call at either end of a
    read shorter than this (``SHORT_TERMINAL_FOOTPRINT_BP``; 0 keeps them).

    On a circular contig (``@SQ TP:circular``, or ``circular=True`` from the
    browser's circular flags) a window starting inside the contig also gets
    the wrapped tails of origin-spanning records: records whose alignment runs
    past the contig end (the SAM circular representation) are fetched at
    ``[start + k*LN, end + k*LN)``, built in the same window frame, and joined
    with their head part (if also in view) into one read.  Reads with a
    wrapped part carry ``alignment_spans``: their parts' alignment extents,
    projected to the window's coordinates (``reference_start``/``end`` stay
    the record's own, for consensus identity).

    Live lift (services/lift) decodes source records with:
    ``include_supplementary``: also supplementary records. A hard-clipped one
    follows the per-record annotation-scope rule
    (``scope_hard_clipped_supplementary``): tags on its stored SEQ decode as
    they are, whole-molecule tags decode on the record with its clips restored
    as unknown bases, and an undecidable record is skipped and counted in
    ``lift_counts['hard_clipped_supplementary']``;
    ``include_lift_meta``: internal per-read fields for lifting
    (``lift_meta_fields``); also turns the shared SignalWindow off;
    ``load_budget``: an object whose ``examine()`` is asked before each record
    (False stops the load) and whose ``account(read)`` sees each decoded read;
    ``sample_bounds``: ``(ref_start, ref_end) -> [(start, end), ...]``, the
    extents a sampled record is counted at (the target frame's)."""
    options = dict(
        include_methylation=include_methylation,
        ml_threshold=ml_threshold,
        min_fp_quality=min_fp_quality,
        include_cigar=include_cigar,
        hide_terminal_gaps=hide_terminal_gaps,
        terminal_gap_threshold=terminal_gap_threshold,
        include_layers=include_layers,
        requested_layers=requested_layers,
        include_layer_qualities=include_layer_qualities,
        infer_legacy_layers=infer_legacy_layers,
        legacy_nuc_min_size=legacy_nuc_min_size,
        include_duplicates=include_duplicates,
        min_footprints=min_footprints,
        bam_handle_getter=bam_handle_getter,
        chrom_map=chrom_map,
        contig_links=contig_links,
        short_terminal_footprint_bp=short_terminal_footprint_bp,
        sv_min_len=sv_min_len,
        include_sv_seq=include_sv_seq,
        fetch_regions=fetch_regions,
        include_supplementary=include_supplementary,
        include_lift_meta=include_lift_meta,
        lift_counts=lift_counts,
        load_budget=load_budget,
        sample_bounds=sample_bounds,
        sv_reference=sv_reference,
    )
    wrap_length = _bam_wrap_length_for(bam_path, chrom, bool(circular), bam_handle_getter, chrom_map, contig_links)
    if wrap_length and fetch_regions is not None:
        from services.read_edge_cache import EdgeFetchUnsupported
        raise EdgeFetchUnsupported('Circular BAMs require the full-view loader')
    offsets = wrap_passes(int(region_start), int(region_end), wrap_length)
    if not offsets:
        return _build_compact_reads_from_bam_region(
            bam_path, chrom, region_start, region_end, spanning_only=spanning_only, **options)

    from services.read_stream import decoded_read_sink
    token = decoded_read_sink.set(None)
    try:
        head = _build_compact_reads_from_bam_region(
            bam_path, chrom, region_start, region_end, spanning_only=False, **options)
        tails_by_offset = []
        for offset in offsets:
            tail = _build_compact_reads_from_bam_region(
                bam_path, chrom, region_start + offset, region_end + offset, spanning_only=False, **options)
            if not tail:
                break
            tails_by_offset.append((offset, tail))
        return _join_wrapped_parts(head, tails_by_offset, region_start, region_end, spanning_only,
                                   wrap_length=wrap_length)
    finally:
        decoded_read_sink.reset(token)


def _bam_wrap_length_for(bam_path, chrom, circular, bam_handle_getter, chrom_map, contig_links=None):
    """The contig length origin-spanning records of ``chrom`` wrap at, or None."""
    from utils.chrom import resolve_reference_name

    try:
        if bam_handle_getter is None:
            from services.bam_handles import get_bam_handle as bam_handle_getter
        bam = bam_handle_getter(bam_path)
        if bam is None:
            return None
        actual_chrom = resolve_reference_name(chrom, bam.references, chrom_map or {}, links=contig_links)
        if actual_chrom is None:
            return None
        return bam_wrap_length(bam, actual_chrom, flagged_circular=circular)
    except Exception:
        return None


def _record_key(read: dict):
    if read.get("record_sha256") is not None:
        return ("sha", read.get("id"), read.get("record_sha256"), read.get("alignment_occurrence"))
    return ("pos", read.get("id"), read.get("reference_start"), read.get("reference_end"),
            read.get("alignment_orientation"))


def _alignment_covers(read: dict, start: int, end: int) -> bool:
    covered = alignment_spans_cover(read, start, end)
    if covered is not None:
        return covered
    rs, re_ = read.get("reference_start"), read.get("reference_end")
    if isinstance(rs, int) and isinstance(re_, int):
        return rs <= start and re_ >= end
    return False


def _projected_alignment_spans(rs: int, re_: int, length: int) -> list[list[int]]:
    """A record's alignment projected onto a contig of ``length`` it runs
    past the end of: ``[rs - k*length, re - k*length)`` for every revolution
    ``k`` still reaching the contig; empty for a record inside the contig."""
    if not length or length <= 0 or re_ <= length:
        return []
    spans = []
    k = 0
    while re_ - k * length > 0:
        spans.append([rs - k * length, re_ - k * length])
        k += 1
    return spans


def _clip_part_before(read: dict, frame_end: int) -> Optional[dict]:
    """A wrapped part cut to window-frame positions < ``frame_end`` (only a
    record longer than the contig overlaps itself)."""
    from services.working_sets import project_broad_read_to_viewport

    if frame_end <= 0:
        return None
    clipped, _ = project_broad_read_to_viewport(
        read, viewport_offset=0, region_width=int(frame_end), include_methylation=True,
        layer_key=None, include_layer_qualities=True)
    if clipped is None:
        return None
    for key in ("duplicate", "alignment_spans", "sv", "sv_evidence", "aligned_blocks", "sv_segments",
                "sequence_span", "sv_alignments", "supplementary"):
        if key in read:
            clipped[key] = read[key]
    if read.get("cigar"):
        clipped["cigar"] = [ev for ev in read["cigar"] if int(ev.get("pos", 0)) < frame_end]
    return clipped


def _join_wrapped_parts(head, tails_by_offset, region_start, region_end, spanning_only, *, wrap_length=None):
    """One read per record: its wrapped tails (outermost first) then its head.

    A record longer than the contig (``wrap_length``) overlaps itself: the
    part at offset ``k * LN`` keeps only window positions no lower pass
    (``j < k``) already covers, i.e. those before ``rs - (k - 1) * LN``, so
    each position is shown once however many revolutions the record makes.

    Every record running past the contig end carries ``alignment_spans``: all
    its projections ``[rs - k*LN, re - k*LN)`` that reach the contig, whether
    or not a part of it is drawn there (a short tail with nothing to show is
    still covered by the record's bases)."""
    parts_by_key: dict = {}
    order: list = []

    seen: dict = {}

    def add(read, offset):
        # The n-th same-keyed read of a pass is the n-th record in every pass
        # (a fetch returns records in the same order), so reads without a
        # record digest (exact duplicates, read adapters) stay apart too.
        key = _record_key(read)
        nth = seen.get((offset, key), 0)
        seen[(offset, key)] = nth + 1
        key = key + (nth,)
        if key not in parts_by_key:
            parts_by_key[key] = {}
            order.append(key)
        parts_by_key[key][offset] = read

    for read in head:
        add(read, 0)
    for offset, tail in tails_by_offset:
        for read in tail:
            add(read, offset)

    offsets = [offset for offset, _tail in tails_by_offset]
    length = int(wrap_length or (min(offsets) if offsets else 0))
    out = []
    for key in order:
        by_offset = parts_by_key[key]
        sample = next(iter(by_offset.values()))
        rs, re_ = sample.get("reference_start"), sample.get("reference_end")
        bounded = isinstance(rs, int) and isinstance(re_, int)
        spans = _projected_alignment_spans(rs, re_, length) if bounded else []
        if not by_offset.keys() - {0}:
            read = by_offset[0]
            if spans:
                read = dict(read, alignment_spans=spans)
        else:
            parts = []
            for offset in sorted(by_offset, reverse=True):
                part = dict(by_offset[offset])
                if offset and bounded and re_ - rs > length:
                    # A record longer than the contig covers these positions
                    # again in the previous revolution (down to its start at
                    # offset 0): show each position once.
                    part = _clip_part_before(part, rs - (offset - length) - region_start)
                    if part is None:
                        continue
                parts.append(part)
            if not parts:
                continue
            read = concat_compact_read_parts(parts)
            if spans:
                read["alignment_spans"] = spans
        if spanning_only and not _alignment_covers(read, region_start, region_end):
            continue
        out.append(read)
    return out


def _build_compact_reads_from_bam_region(
    bam_path,
    chrom,
    region_start,
    region_end,
    spanning_only=True,
    include_methylation=False,
    ml_threshold=125,
    min_fp_quality=0,
    include_cigar=False,
    hide_terminal_gaps=True,
    terminal_gap_threshold=500,
    include_layers=True,
    requested_layers=None,
    include_layer_qualities=True,
    infer_legacy_layers=True,
    legacy_nuc_min_size=90,
    include_duplicates=False,
    min_footprints=0,
    bam_handle_getter=None,
    chrom_map=None,
    contig_links=None,
    short_terminal_footprint_bp=0,
    sv_min_len=SV_MIN_LEN_DEFAULT,
    include_sv_seq=False,
    fetch_regions=None,
    include_supplementary=False,
    include_lift_meta=False,
    lift_counts=None,
    load_budget=None,
    sample_bounds=None,
    sv_reference=None,
):
    """Compact reads of the records overlapping one linear BAM region.

    ``contig_links``: this file's plasmid links in the caller's workspace
    (``services.plasmid_reconcile.contig_links``)."""
    import time as time_module
    import traceback

    from services.bam_tags import (
        seq_span_to_molecular,
        bam_legacy_frame,
        bam_ma_group_frame,
        read_legacy_tags_are_molecular,
        bam_consensus_contracts,
        legacy_starts_in_seq_frame,
        build_legacy_layers,
        generate_msp_from_nuc_gaps,
        parse_daf_mismatches,
        parse_deamination_opportunities,
        parse_iupac_ry_positions,
        parse_ma_aq_tags_into_layers,
        parse_mm_ml_tags_by_type,
    )
    from utils.chrom import get_chrom_variants, resolve_reference_name
    from utils.validation import is_url

    if bam_handle_getter is None:
        from services.bam_handles import get_bam_handle as bam_handle_getter

    chrom_map = chrom_map or {}
    from services.packed_reads import packed_decode, decode_partition, PackedReadBuilder
    reads = PackedReadBuilder() if packed_decode.get() else []
    partition = decode_partition.get()
    from services.read_stream import decoded_read_sink
    stream = decoded_read_sink.get()
    include_layers, requested_layer_set = normalize_layer_request(include_layers, requested_layers)
    include_deam_opportunities = bool(
        include_methylation
        and requested_layer_set
        and "deam_opportunity" in requested_layer_set
    )

    def _wants_layer(*names: str) -> bool:
        return wants_layer(include_layers, requested_layer_set, *names)

    # Nucleosome outputs computed for these records (services/nuc): layers of their rows, as MA groups read.
    from services.nuc.layers import injector as _nuc_injector
    from services.nuc.scalars import (NUC_MA_GROUPS as _NUC_GROUP_NAMES, SCALAR_GROUPS,
                                      drop_stale_nuc_groups as _drop_stale_nuc_groups,
                                      scalar_groups_to_fields as _scalar_groups_to_fields)
    _SCALAR_GROUP_NAMES = frozenset(SCALAR_GROUPS)
    nuc_inject = _nuc_injector(bam_path, region_start, region_end, include_layers=include_layers,
                               requested_layers=requested_layer_set, include_qualities=include_layer_qualities,
                               include_lift_meta=include_lift_meta)

    profile_bam = os.environ.get("FIBERBROWSER_PROFILE_BAM") == "1"
    diagnose_bam = profile_bam or bam_diagnostics_enabled()
    profile_total_t0 = time_module.perf_counter() if profile_bam else 0.0
    profile_timings: dict[str, float] = {}
    profile_counts = {
        "records_seen": 0,
        "records_unmapped": 0,
        "records_nonspanning": 0,
        "records_duplicate_hidden": 0,
        "tagged_reads": 0,
        "raw_reads": 0,
        "terminal_gap_filtered": 0,
        "terminal_footprints_dropped": 0,
        "terminal_footprints_only": 0,
    }

    def _profile_start() -> float:
        return time_module.perf_counter() if profile_bam else 0.0

    def _profile_add(name: str, started_at: float) -> None:
        if profile_bam:
            profile_timings[name] = profile_timings.get(name, 0.0) + (
                time_module.perf_counter() - started_at
            )

    if not is_url(bam_path):
        if not os.path.exists(bam_path):
            log_bam_diagnostic(f"BAM file not found: {bam_path}")
            return reads.finish() if isinstance(reads, PackedReadBuilder) else reads

        from services.bam_handles import local_bam_index_exists
        if not local_bam_index_exists(bam_path):
            log_bam_diagnostic(f"BAM index not found for: {bam_path}")
            return reads.finish() if isinstance(reads, PackedReadBuilder) else reads

    reads_without_tags = 0
    reads_with_tags = 0
    # Record iterators hold their file's reader lock (services/file_handles.py)
    # until closed. An early break or an exception must close them here, in this
    # thread: left to the garbage collector, another thread would try to release
    # the lock, fail, and leave the file locked for every later reader.
    open_iterators = []

    try:
        phase_t0 = _profile_start()
        bam = bam_handle_getter(bam_path)
        _profile_add("open_handle", phase_t0)
        if bam is None:
            log_bam_diagnostic(f"Failed to open BAM file: {bam_path}")
            if is_url(bam_path):
                from services.remote_sources.base import RemoteReadError
                from services.remote_sources.opening import redact
                raise RemoteReadError(f"Could not open {redact(bam_path)}: the network or the server may be down "
                                      "(the server log has the reason). Check it, then reload the region.")
            return reads.finish() if isinstance(reads, PackedReadBuilder) else reads

        # Legacy ns/nl/as/al tags carry no frame signal; infer molecular vs SEQ
        # from @PG/@CO provenance (fibertools add-nucleosome, or an explicit
        # coord=molecular marker). MA/AQ only flips when the file explicitly
        # declares molecular coordinates. Detected once per file.
        try:
            legacy_frame = bam_legacy_frame(bam.header)
        except Exception:
            legacy_frame = (False, False)
        ma_aq_tags_molecular = bam_ma_group_frame(bam.header)

        from services.signal_evidence import signal_header, record_signal, signal_keeps
        signal_provenance = signal_header(bam.header)
        family_contracts = bam_consensus_contracts(bam.header)
        phase_t0 = _profile_start()
        references = bam.references
        actual_chrom = resolve_reference_name(chrom, references, chrom_map, links=contig_links)
        if actual_chrom is None:
            log_bam_diagnostic(f"Chromosome {chrom} not found in BAM")
            return reads.finish() if isinstance(reads, PackedReadBuilder) else reads
        _profile_add("resolve_chrom", phase_t0)

        projection_library_id = str(Path(bam_path).expanduser().resolve())
        projection_occurrences = {}
        from services.background_work import checkpoint
        from services.read_sampling import active_sampler
        sampler = active_sampler()
        if sampler is not None and sampler.level <= 0 and sampler.only_ids is None:
            sampler = None
        records_seen = 0
        from services.signal_windows import SignalWindow
        # A lifted source load (supplementaries, budget stops) never feeds the
        # shared per-window signal counts.
        signal_window = (SignalWindow(bam_path, actual_chrom, region_start, region_end,
            regions=fetch_regions, source={"header": signal_provenance, "references": tuple(references)})
            if (partition is None or partition == (0, 1)) and not (include_lift_meta or include_supplementary)
            else None)
        from services.read_edge_cache import iter_edge_records
        # An unrepaired graph lift (ft pg-lift) turned supplementaries into
        # extra primaries: hide those that carry evidence of it
        # (services.graph_lift; per record, so every view agrees).
        from services.graph_lift import lift_hidden_predicate
        lift_hidden = lift_hidden_predicate(bam.header)
        from services.sv_molecules import molecule_alignments
        def eligible_segment(record):
            if record.is_unmapped or record.is_secondary or (lift_hidden is not None and lift_hidden(record)):
                return None
            evidence = record_signal(record, signal_provenance)
            if signal_window is not None and not record.is_supplementary:
                signal_window.append(record, evidence)
            return signal_keeps(evidence) and (include_duplicates or not getattr(record, 'is_duplicate', False))
        selected_molecules = 0
        def keep_molecule(name):
            nonlocal selected_molecules
            if partition is not None:
                from services.read_sampling import name_hash
                if name_hash(name) % partition[1] != partition[0]:
                    return False
            if sampler is not None:
                if not sampler.keep(name):
                    return False
                if sampler.max_records is not None and selected_molecules >= sampler.max_records:
                    return False
            selected_molecules += 1
            return True
        def skipped_molecule(name, start, end):
            if sampler is None:
                return
            if partition is not None:
                from services.read_sampling import name_hash
                if name_hash(name) % partition[1] != partition[0]:
                    return  # each worker counts only its own sampling decisions
            sampler.skip(start, end)
        records = iter_edge_records(bam, actual_chrom, region_start, region_end, fetch_regions)
        open_iterators.append(records)
        # Lift composition needs each source record's own calls and molecular
        # frame. Native SV loading instead collects the complete molecule bundle.
        record_scoped = include_lift_meta or include_supplementary
        records = (((record, None, ordinal) for ordinal, record in enumerate(records, 1))
                   if record_scoped else molecule_alignments(
                       records, eligible_segment, keep=keep_molecule,
                       on_skipped=skipped_molecule, with_source_order=True))
        open_iterators.append(records)
        for read, molecule_records, source_order in records:
            records_seen += 1
            if not records_seen & 255:
                checkpoint()  # a background job whose client went away stops here
            if load_budget is not None and sampler is None and not load_budget.examine():
                break
            if profile_bam:
                profile_counts["records_seen"] += 1
            if (read.is_unmapped or read.is_secondary
                    or (record_scoped and read.is_supplementary and not include_supplementary)):
                if profile_bam:
                    profile_counts["records_unmapped"] += 1
                continue
            if record_scoped and read.is_supplementary:
                read = scope_hard_clipped_supplementary(read, lift_counts)
                if read is None:
                    continue
            if lift_hidden is not None and lift_hidden(read):
                continue
            if record_scoped and partition is not None:
                from services.read_sampling import name_hash
                if name_hash(read.query_name) % partition[1] != partition[0]:
                    continue
            signal_evidence = record_signal(read, signal_provenance)
            if not signal_keeps(signal_evidence):
                continue
            # A sampled display load (services/read_sampling.py): decided on the
            # name after signal eligibility; a skipped read leaves its extent.
            if sampler is not None:
                # Counted once per molecule: a supplementary shares its primary's name (and fate).
                counted = (include_duplicates or not read.is_duplicate) and (not record_scoped or not read.is_supplementary)
                extents = (sample_bounds(read.reference_start, read.reference_end) if sample_bounds is not None
                           else ((read.reference_start, read.reference_end),))
                if record_scoped and not sampler.keep(read.query_name):
                    if counted:
                        for extent in extents:
                            sampler.skip(*extent)
                    continue
                if counted:
                    for extent in extents:
                        sampler.kept(*extent)
            # With explicit live-lift sampling the budget bounds records we
            # decode, not the cheap skipped records whose extents we counted.
            if load_budget is not None and sampler is not None and not load_budget.examine():
                break
            is_duplicate = bool(getattr(read, "is_duplicate", False))
            if is_duplicate and not include_duplicates:
                if profile_bam:
                    profile_counts["records_duplicate_hidden"] += 1
                continue

            ref_start = read.reference_start
            ref_end = read.reference_end

            if spanning_only and (ref_start > region_start or ref_end < region_end):
                if profile_bam:
                    profile_counts["records_nonspanning"] += 1
                continue
            lift_call_meta = record_call_meta(read) if include_lift_meta else None

            # Annotation tags on recovered hard-clipped segments may still use
            # whole-molecule coordinates. The per-layer frame cannot be proven
            # from truncated SEQ: keep SV evidence without displaced chromatin.
            if not record_scoped and read.is_supplementary and any(op == 5 for op, _n in read.cigartuples or []):
                if min_fp_quality > 0 or min_footprints > 0:
                    continue
                a, b = max(ref_start, region_start), min(ref_end, region_end)
                if b > a:
                    read_data = {'id': read.query_name, 'intervals': [[a - region_start, b - region_start, 0]],
                                 'no_calls': True,
                                 **_bam_projection_identity(read, projection_library_id, projection_occurrences)}
                    if is_duplicate:
                        read_data['duplicate'] = True
                    _attach_record_fields(read_data, read)
                    _attach_sv_events(read_data, read, region_start, sv_min_len, include_sv_seq,
                                      molecule_records=molecule_records, reference=sv_reference)
                    if include_cigar:
                        read_data['cigar'] = extract_cigar_events(read, region_start, region_end)
                    if partition is not None:
                        read_data['_fiberbrowser_source_order'] = source_order
                    reads.append(read_data)
                    if stream is not None:
                        stream.append(read_data)
                continue

            phase_t0 = _profile_start()
            ns_tag = None
            nl_tag = None
            nq_tag = None
            fire_starts = None
            fire_lengths = None
            fire_quals = None
            fire_quals_all_zero = False
            lq_tag = None
            rq_tag = None

            try:
                ns_tag = read.get_tag("ns")
                nl_tag = read.get_tag("nl")
                try:
                    nq_tag = read.get_tag("nq")
                except KeyError:
                    pass
                try:
                    lq_tag = read.get_tag("lq")
                except KeyError:
                    pass
                try:
                    rq_tag = read.get_tag("rq")
                except KeyError:
                    pass
                try:
                    fire_starts = read.get_tag("as")
                    fire_lengths = read.get_tag("al")
                    try:
                        fire_quals = read.get_tag("aq")
                        fire_qual_values = parse_optional_int_tag_values(fire_quals) or []
                        fire_quals_all_zero = bool(fire_qual_values) and all(v == 0 for v in fire_qual_values)
                        if fire_quals_all_zero:
                            fire_quals = None
                    except KeyError:
                        pass
                except KeyError:
                    pass
            except KeyError:
                pass

            if ns_tag is None:
                try:
                    msp_starts = read.get_tag("as")
                    msp_lengths = read.get_tag("al")
                    # as/al are accessible MSPs, not footprints: the footprints
                    # are the stretches between them (same frame as the MSPs).
                    ns_tag, nl_tag = msp_complement(msp_starts, msp_lengths, read.query_length or 0)
                    nq_tag = None
                except KeyError:
                    pass
            _profile_add("tag_lookup", phase_t0)

            ma_tags = _read_ma_tags(read, ma_aq_tags_molecular)
            if ns_tag is None:
                # Footprints carried only in MA (current FiberHMM / fibertools)
                # count toward the whole-fiber minimum like ns/nl ones.
                if min_footprints > 0 and (ma_tags is None or ma_footprint_count(ma_tags[0]) < min_footprints):
                    continue
                reads_without_tags += 1
                if profile_bam:
                    profile_counts["raw_reads"] += 1
                read_start_in_region = max(ref_start, region_start)
                read_end_in_region = min(ref_end, region_end)
                if read_end_in_region > read_start_in_region:
                    phase_t0 = _profile_start()
                    projection_identity = _bam_projection_identity(read, projection_library_id, projection_occurrences)
                    _profile_add("record_identity", phase_t0)
                    read_data = {
                        "id": read.query_name,
                        **projection_identity,
                        **({"signal": signal_evidence} if signal_evidence["reason"] != "annotation_unavailable" else {}),
                        "intervals": [[
                            int(read_start_in_region - region_start),
                            int(read_end_in_region - region_start),
                            0,
                        ]],
                    }
                    if is_duplicate:
                        read_data["duplicate"] = True
                    _attach_record_fields(read_data, read)
                    if include_layers and ma_tags is not None:
                        phase_t0 = _profile_start()
                        try:
                            coord_mapper = CigarCoordMapper(read.cigartuples, ref_start)
                            terminal_drop = None
                            if short_terminal_footprint_bp > 0:
                                terminal_drop = short_terminal_spans(
                                    None, None,
                                    ma_footprint_query_spans(
                                        ma_tags, read_length=read.query_length or 0,
                                        is_reverse=read.is_reverse, family_contracts=family_contracts),
                                    short_terminal_footprint_bp,
                                    read_length=read.query_length or 0,
                                )
                                if terminal_drop and profile_bam:
                                    profile_counts["terminal_footprints_dropped"] += len(terminal_drop)
                            ma_layers = parse_ma_aq_tags_into_layers(
                                ma_tags[0],
                                ma_tags[1],
                                coord_mapper,
                                region_start,
                                region_end,
                                include_names=requested_layer_set,
                                an_str=ma_tags[2],
                                include_qualities=include_layer_qualities,
                                read_length=read.query_length or 0,
                                is_reverse=read.is_reverse,
                                tags_are_molecular=ma_tags[3],
                                family_contracts=family_contracts,
                                skip_query_spans=terminal_drop or None,
                                skip_span_layers=_MA_FOOTPRINT_TYPES,
                                call_meta=lift_call_meta,
                            )
                            if ma_layers:
                                read_data["layers"] = ma_layers
                        except Exception as exc:
                            if diagnose_bam:
                                log_bam_diagnostic(
                                    f"  Warning: Failed to parse MA/AQ tags for read {read.query_name}: {exc}"
                                )
                        _profile_add("layer_build", phase_t0)
                    if include_methylation:
                        phase_t0 = _profile_start()
                        mm_by_type = parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold)
                        if mm_by_type.get("m6a"):
                            read_data["methyl_m6a"] = mm_by_type["m6a"]
                        if mm_by_type.get("m5c"):
                            read_data["methyl_m5c"] = mm_by_type["m5c"]

                        deam_events = mm_by_type.get("deam") or []
                        if not deam_events:
                            deam_events = parse_iupac_ry_positions(read, region_start, region_end)
                        if not deam_events and not mm_by_type.get("m6a") and not mm_by_type.get("m5c"):
                            deam_events = parse_daf_mismatches(read, region_start, region_end)
                        if deam_events:
                            read_data["deam"] = deam_events
                        if include_deam_opportunities:
                            opportunities = parse_deamination_opportunities(
                                read, region_start, region_end, deam_events
                            )
                            if opportunities["ct"]:
                                read_data["possible_deam_ct"] = opportunities["ct"]
                            if opportunities["ga"]:
                                read_data["possible_deam_ga"] = opportunities["ga"]

                        if read_data.get("methyl_m6a"):
                            read_data["methyl"] = read_data["methyl_m6a"]
                        elif read_data.get("methyl_m5c"):
                            read_data["methyl"] = read_data["methyl_m5c"]
                        elif deam_events:
                            read_data["methyl"] = [e[0] for e in deam_events]
                        _profile_add("mark_parse", phase_t0)
                    if include_cigar:
                        if include_lift_meta:
                            read_data["_fiberbrowser_sequence"] = read.query_sequence
                            read_data["_fiberbrowser_md"] = read.get_tag("MD") if read.has_tag("MD") else None
                            read_data["_fiberbrowser_sequence_lead"] = lift_call_meta[1]
                        phase_t0 = _profile_start()
                        cigar_events = extract_cigar_events(read, region_start, region_end)
                        if cigar_events:
                            read_data["cigar"] = cigar_events
                        _profile_add("cigar_parse", phase_t0)
                    phase_t0 = _profile_start()
                    if include_lift_meta:
                        read_data.update(lift_meta_fields(
                            read, CigarCoordMapper(read.cigartuples, ref_start), lift_call_meta,
                            interval_calls=[None] * len(read_data["intervals"])))
                    _attach_sv_events(read_data, read, region_start, sv_min_len, include_sv_seq,
                                      molecule_records=molecule_records, reference=sv_reference)
                    from services.read_binary import binary_read_context
                    if binary_read_context.get():
                        read_data["_fiberbrowser_terminal_gaps"] = []
                    _profile_add("sv_events", phase_t0)
                    if partition is not None:
                        read_data['_fiberbrowser_source_order'] = source_order
                    if read_data.get("layers") and _NUC_GROUP_NAMES.intersection(read_data["layers"]):
                        # The record's own nucleosome groups, only when FiberHMM reads them as current.
                        _drop_stale_nuc_groups(read_data, read)
                    if read_data.get("layers") and _SCALAR_GROUP_NAMES.intersection(read_data["layers"]):
                        _scalar_groups_to_fields(read_data)
                    if nuc_inject is not None:
                        nuc_inject(read_data)
                    reads.append(read_data)
                    if load_budget is not None:
                        load_budget.account(read_data)
                    if stream is not None:
                        stream.append(read_data)
                continue

            reads_with_tags += 1
            if profile_bam:
                profile_counts["tagged_reads"] += 1

            if reads_with_tags == 1 and diagnose_bam:
                log_bam_diagnostic(f"  First read tag info: ns type={type(ns_tag).__name__}, nl type={type(nl_tag).__name__}")
                if hasattr(ns_tag, "dtype"):
                    log_bam_diagnostic(f"  Tag dtype: ns={ns_tag.dtype}")
                if nq_tag is not None:
                    tag_name = "nq" if "ns" in [t for t, _ in read.get_tags()] else "aq"
                    log_bam_diagnostic(f"  Quality tag ({tag_name}) found: type={type(nq_tag).__name__}, len={len(nq_tag) if hasattr(nq_tag, '__len__') else 'N/A'}")
                    try:
                        sample = list(nq_tag[:5]) if len(nq_tag) > 5 else list(nq_tag)
                        log_bam_diagnostic(f"  Sample quality values: {sample}")
                    except Exception:
                        log_bam_diagnostic(f"  Raw quality value: {nq_tag}")
                else:
                    log_bam_diagnostic("  No primary footprint quality tag (nq) found in BAM")
                if fire_starts is not None and fire_lengths is not None:
                    if fire_quals is not None:
                        log_bam_diagnostic(f"  FIRE aq tag found: type={type(fire_quals).__name__}, len={len(fire_quals) if hasattr(fire_quals, '__len__') else 'N/A'}")
                    elif fire_quals_all_zero:
                        log_bam_diagnostic("  FIRE aq tag is all zero; treating as missing/unqualified")
                    else:
                        log_bam_diagnostic("  No FIRE aq tag found; treating FIRE intervals as unqualified")
            if min_fp_quality > 0 and reads_with_tags == 1 and diagnose_bam:
                log_bam_diagnostic(f"  Filtering by min_fp_quality={min_fp_quality}")

            phase_t0 = _profile_start()
            try:
                fp_starts_query = parse_int_tag_values(ns_tag)
                fp_lengths = parse_int_tag_values(nl_tag)
                if fp_starts_query is None or fp_lengths is None:
                    raise ValueError("missing ns/nl tag values")
            except Exception as exc:
                if diagnose_bam:
                    log_bam_diagnostic(f"  Warning: Failed to parse ns/nl tags for read {read.query_name}: {exc}")
                continue

            fp_qualities = parse_optional_int_tag_values(nq_tag)
            if len(fp_starts_query) != len(fp_lengths):
                _profile_add("parse_fp_tags", phase_t0)
                continue

            lq_qualities = parse_optional_int_tag_values(lq_tag)
            rq_qualities = parse_optional_int_tag_values(rq_tag)

            # Molecular-frame legacy tags (fibertools / marked FiberHMM): flip
            # each ns/nl interval to SEQ frame on reverse reads so the SEQ-frame
            # CIGAR mapper places it correctly, and swap left/right edge
            # qualities (molecular-left is the genomic-right edge).
            # build_intervals_from_footprints re-sorts by position and keeps
            # lq/rq aligned, so interval order is handled downstream.
            read_length = read.query_length or 0
            flip_legacy = bool(read.is_reverse and read_length > 0 and read_legacy_tags_are_molecular(read, legacy_frame))
            if flip_legacy:
                fp_starts_query = legacy_starts_in_seq_frame(fp_starts_query, fp_lengths, read, True)
                if lq_qualities is not None and rq_qualities is not None:
                    lq_qualities, rq_qualities = rq_qualities, lq_qualities
            _profile_add("parse_fp_tags", phase_t0)

            phase_t0 = _profile_start()
            coord_mapper = CigarCoordMapper(read.cigartuples, ref_start)
            query_to_ref = coord_mapper.query_to_ref
            _profile_add("coord_mapper", phase_t0)

            phase_t0 = _profile_start()
            footprints = map_tagged_footprints(
                fp_starts_query, fp_lengths, fp_qualities, query_to_ref,
                min_fp_quality=min_fp_quality,
            )
            _profile_add("footprint_coords", phase_t0)
            # Membership is a whole-fiber property. Reject before parsing
            # annotation layers or fingerprinting a record that cannot be used.
            if min_footprints > 0 and len(footprints) < min_footprints:
                continue

            # Read-end footprints shorter than the cutoff, among every call the
            # read carries (ns/nl and MA nuc/tf), whole-read and in SEQ frame.
            ma_spans = None
            terminal_drop = set()
            if short_terminal_footprint_bp > 0:
                phase_t0 = _profile_start()
                if ma_tags is not None:
                    ma_spans = ma_footprint_query_spans(
                        ma_tags, read_length=read_length, is_reverse=read.is_reverse,
                        family_contracts=family_contracts,
                    )
                terminal_drop = short_terminal_spans(
                    fp_starts_query, fp_lengths, ma_spans, short_terminal_footprint_bp,
                    read_length=read_length)
                if terminal_drop and profile_bam:
                    profile_counts["terminal_footprints_dropped"] += len(terminal_drop)
                _profile_add("terminal_footprints", phase_t0)

            # Parse only the explicitly requested MA layers before applying
            # legacy-footprint filters. This keeps rescue-only rows without
            # making the mere presence of an unrelated MA tag disable terminal
            # gap filtering for every v3 read.
            ma_layers = {}
            ma_layer_names = set()
            ma_skipped_in_region = []
            ma_skipped_spans = [] if include_lift_meta else None
            if include_layers and ma_tags is not None:
                phase_t0 = _profile_start()
                ma_layers = parse_ma_aq_tags_into_layers(
                    ma_tags[0],
                    ma_tags[1] if include_layer_qualities else None,
                    coord_mapper,
                    region_start,
                    region_end,
                    include_names=requested_layer_set,
                    an_str=ma_tags[2],
                    include_qualities=include_layer_qualities,
                    read_length=read.query_length or 0,
                    is_reverse=read.is_reverse,
                    tags_are_molecular=ma_tags[3],
                    family_contracts=family_contracts,
                    skip_query_spans=terminal_drop or None,
                    skip_span_layers=_MA_FOOTPRINT_TYPES,
                    skipped_in_region=ma_skipped_in_region,
                    skipped_spans=ma_skipped_spans,
                    present_names=ma_layer_names,
                    call_meta=lift_call_meta,
                )
                _profile_add("ma_layer_parse", phase_t0)

            # Read membership (min footprints above, the terminal-gap filter
            # below) is judged on all the read's calls; the dropped read-end
            # calls are only left out of what is drawn and analysed.
            all_footprints = footprints
            dropped_extent = None
            dropped_footprints = []
            if terminal_drop:
                footprints = []
                for fp in all_footprints:
                    if (fp[2] < short_terminal_footprint_bp
                            and (int(fp_starts_query[fp[4]]), int(fp_starts_query[fp[4]]) + int(fp_lengths[fp[4]]))
                            in terminal_drop):
                        dropped_extent = _extent_union(dropped_extent, (fp[0], fp[1]))
                        dropped_footprints.append(fp)
                    else:
                        footprints.append(fp)

            # Explicit MA/AQ layers are independent of the legacy ns/nl
            # footprint stream. A read can carry a valid named TF call in a
            # viewport where no legacy footprint survives mapping or where the
            # terminal-gap heuristic rejects the legacy geometry. Preserve a
            # neutral alignment-span row in that case so the explicit layer is
            # still queryable and renderable.
            # Judged as if no read-end call were dropped (a dropped MA call that
            # would have been drawn here counts), so every window keeps its reads.
            has_explicit_ma_layers = (
                bool(ma_layers) or bool(ma_skipped_in_region)
            ) and requested_layer_set is not None
            # A supplementary-only local alignment may carry whole-molecule
            # annotation tags whose calls all lie on another segment. Preserve
            # its local evidence as a neutral row when no quality gate rejects it.
            evidence_only_segment = bool(read.is_supplementary) and min_footprints <= 0 and min_fp_quality <= 0
            has_explicit_ma_layers = has_explicit_ma_layers or evidence_only_segment
            # A read whose only ns/nl footprints were read-end stubs stays (as an
            # empty row) wherever its body would have reached.
            stubs_only = bool(terminal_drop) and not footprints and bool(all_footprints)
            if stubs_only and profile_bam:
                profile_counts["terminal_footprints_only"] += 1
            if not footprints and not has_explicit_ma_layers and not stubs_only:
                continue

            phase_t0 = _profile_start()
            # The body spans every footprint call, not only the ns/nl ones:
            # current FiberHMM keeps TF calls in MA only, and hiding terminal
            # gaps must not leave a TF drawn beyond its read.
            call_extent = None
            if hide_terminal_gaps and (footprints or stubs_only) and ma_tags is not None:
                try:
                    if include_lift_meta and ma_spans is None:
                        # Retain the query spans call_extent already needs, so
                        # live lift can reuse them for per-record MA presence.
                        ma_spans = ma_footprint_query_spans(
                            ma_tags, read_length=read_length, is_reverse=read.is_reverse,
                            family_contracts=family_contracts)
                    call_extent = ma_footprint_call_extent(
                        ma_tags, coord_mapper, ref_start, ref_end,
                        read_length=read_length, is_reverse=read.is_reverse,
                        family_contracts=family_contracts, spans=ma_spans,
                    )
                except Exception as exc:
                    if diagnose_bam:
                        log_bam_diagnostic(f"  Warning: Failed to read MA call extent for read {read.query_name}: {exc}")
            if terminal_drop and hide_terminal_gaps:
                # The read keeps its body (and the terminal-gap test) over all its
                # calls, the dropped ones included: a dropped read-end call leaves
                # an empty stretch, as any call left out does, and every window
                # and analysis keeps the same reads.
                call_extent = _extent_union(call_extent, dropped_extent)
            if stubs_only:
                terminal_filtered = hide_terminal_gaps and terminal_gap_rejects(
                    sorted(all_footprints, key=lambda item: item[0]), ref_start, ref_end,
                    terminal_gap_threshold, call_extent,
                )
                intervals, fp_quality_list, lq_quality_list, rq_quality_list = [], [], [], []
            else:
                intervals, fp_quality_list, lq_quality_list, rq_quality_list, terminal_filtered = build_intervals_from_footprints(
                    footprints,
                    ref_start,
                    ref_end,
                    region_start,
                    region_end,
                    hide_terminal_gaps=hide_terminal_gaps,
                    terminal_gap_threshold=terminal_gap_threshold,
                    lq_qualities=lq_qualities,
                    rq_qualities=rq_qualities,
                    call_extent=call_extent,
                )
            if terminal_filtered:
                if not has_explicit_ma_layers:
                    if profile_bam:
                        profile_counts["terminal_gap_filtered"] += 1
                    _profile_add("interval_build", phase_t0)
                    continue

            if not intervals:
                body_start, body_end = ref_start, ref_end
                if stubs_only and hide_terminal_gaps:
                    # Its body where its calls were.
                    call_body = _extent_union(
                        (min(fp[0] for fp in all_footprints), max(fp[1] for fp in all_footprints))
                        if all_footprints else None,
                        call_extent,
                    )
                    if call_body is not None:
                        body_start, body_end = max(call_body[0], ref_start), min(call_body[1], ref_end)
                read_start_in_region = max(body_start, region_start)
                read_end_in_region = min(body_end, region_end)
                # The same neutral row a containing cache view projects when
                # only named annotations reach this window. Whole-read terminal
                # filtering above still applies to an unscoped layer request.
                if ma_layers and not (has_explicit_ma_layers or stubs_only):
                    annotations = [iv for layer in ma_layers.values() for iv in layer['intervals']]
                    read_start_in_region = region_start + min(iv[0] for iv in annotations)
                    read_end_in_region = region_start + max(iv[1] for iv in annotations)
                if not (has_explicit_ma_layers or stubs_only or ma_layers) or read_end_in_region <= read_start_in_region:
                    _profile_add("interval_build", phase_t0)
                    continue
                intervals = [[
                    int(read_start_in_region - region_start),
                    int(read_end_in_region - region_start),
                    0,
                ]]
                fp_quality_list = []
                lq_quality_list = []
                rq_quality_list = []

            _profile_add("interval_build", phase_t0)
            phase_t0 = _profile_start()
            # Identical SAM records pass the same filters, so delaying their
            # digest preserves both the exact identity and occurrence number.
            projection_identity = _bam_projection_identity(read, projection_library_id, projection_occurrences)
            _profile_add("record_identity", phase_t0)
            read_data = {
                "id": read.query_name,
                **projection_identity,
                **({"signal": signal_evidence} if signal_evidence["reason"] != "annotation_unavailable" else {}),
                "intervals": intervals,
            }
            # Terminal gaps use their visible length; internal gaps keep their
            # full length. Retain the distinction for contained cache views.
            from services.read_binary import binary_read_context
            if binary_read_context.get():
                read_data["_fiberbrowser_terminal_gaps"] = (
                    [[int(ref_start), min(fp[0] for fp in footprints)],
                     [max(fp[1] for fp in footprints), int(ref_end)]]
                    if footprints and not hide_terminal_gaps else []
                )
            if is_duplicate:
                read_data["duplicate"] = True
            _attach_record_fields(read_data, read)

            if fp_quality_list:
                read_data["qualities"] = fp_quality_list

            if include_methylation:
                phase_t0 = _profile_start()
                mm_by_type = parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold)
                if mm_by_type.get("m6a"):
                    read_data["methyl_m6a"] = mm_by_type["m6a"]
                if mm_by_type.get("m5c"):
                    read_data["methyl_m5c"] = mm_by_type["m5c"]

                deam_events = mm_by_type.get("deam") or []
                if not deam_events:
                    deam_events = parse_iupac_ry_positions(read, region_start, region_end)
                if not deam_events and not mm_by_type.get("m6a") and not mm_by_type.get("m5c"):
                    deam_events = parse_daf_mismatches(read, region_start, region_end)
                if deam_events:
                    read_data["deam"] = deam_events
                if include_deam_opportunities:
                    opportunities = parse_deamination_opportunities(
                        read, region_start, region_end, deam_events
                    )
                    if opportunities["ct"]:
                        read_data["possible_deam_ct"] = opportunities["ct"]
                    if opportunities["ga"]:
                        read_data["possible_deam_ga"] = opportunities["ga"]

                if read_data.get("methyl_m6a"):
                    read_data["methyl"] = read_data["methyl_m6a"]
                elif read_data.get("methyl_m5c"):
                    read_data["methyl"] = read_data["methyl_m5c"]
                elif deam_events:
                    read_data["methyl"] = [e[0] for e in deam_events]
                _profile_add("mark_parse", phase_t0)

            if include_cigar:
                if include_lift_meta:
                    read_data["_fiberbrowser_sequence"] = read.query_sequence
                    read_data["_fiberbrowser_md"] = read.get_tag("MD") if read.has_tag("MD") else None
                    read_data["_fiberbrowser_sequence_lead"] = lift_call_meta[1]
                phase_t0 = _profile_start()
                cigar_events = extract_cigar_events(read, region_start, region_end)
                if cigar_events:
                    read_data["cigar"] = cigar_events
                _profile_add("cigar_parse", phase_t0)

            fire_intervals = []
            fire_sizes = []
            fire_calls = [] if include_lift_meta else None
            has_explicit_msp = fire_starts is not None and len(fire_starts) > 0
            fire_qualities_available = fire_quals is not None and any(int(q) not in (0, 128) for q in fire_quals)
            if _wants_layer("fire", "msp") and fire_starts is not None and fire_lengths is not None:
                phase_t0 = _profile_start()
                fs_list = list(fire_starts)
                fl_list = list(fire_lengths)
                fq_list = list(fire_quals) if fire_quals is not None else None
                for fire_index, (fire_start, fire_len) in enumerate(zip(fs_list, fl_list)):
                    fs_int = int(fire_start)
                    fl_int = int(fire_len)
                    # MSP (as/al) tags share the legacy frame; flip to SEQ on
                    # reverse reads when the file's legacy tags are molecular.
                    if flip_legacy:
                        fs_int = read_length - (fs_int + fl_int)
                    # Both ends through the CIGAR, as footprints are: an MSP
                    # running into a soft clip ends at the alignment edge
                    # (not start + length past it), and one starting in a
                    # soft clip keeps its aligned part.
                    fs_ref, fe_ref = coord_mapper.footprint_to_ref(fs_int, fs_int + fl_int - 1)
                    if fs_ref is None or fe_ref is None:
                        continue
                    clip_start = max(fs_ref, region_start)
                    clip_end = min(fe_ref, region_end)
                    if clip_end <= clip_start:
                        continue
                    quality = int(fq_list[fire_index]) if fq_list and fire_index < len(fq_list) else 128
                    fire_intervals.append([
                        int(clip_start - region_start),
                        int(clip_end - region_start),
                        quality,
                    ])
                    if fire_calls is not None:
                        fire_calls.append([f"as:{fire_index}",
                                           *seq_span_to_molecular(fs_int, fs_int + fl_int, *lift_call_meta)])
                    # Color/quality semantics belong to the call, independent
                    # of whether this load was a viewport or a wider cache fill.
                    # Its size is the molecular length (al), as MA layers give theirs:
                    # the same on every alignment of the molecule (a lifted record too).
                    fire_sizes.append(fl_int)
                if fire_intervals:
                    read_data["fire"] = fire_intervals
                _profile_add("fire_overlay", phase_t0)

            if include_layers:
                phase_t0 = _profile_start()
                legacy_layers = {}
                wants_nuc_layer = _wants_layer("nuc", "footprint")
                wants_tf_layer = _wants_layer("tf")
                wants_msp_layer = _wants_layer("msp", "fire")
                if infer_legacy_layers and (wants_nuc_layer or wants_tf_layer or wants_msp_layer):
                    legacy_layers = build_legacy_layers(
                        intervals,
                        fp_quality_list,
                        lq_quality_list,
                        rq_quality_list,
                        fire_intervals if wants_msp_layer else [],
                        region_start,
                        region_end,
                        infer_layers=True,
                        nuc_min_size=legacy_nuc_min_size,
                        include_qualities=include_layer_qualities,
                        infer_tf=wants_tf_layer,
                        infer_nuc=wants_nuc_layer,
                        infer_msp=wants_msp_layer and not has_explicit_msp,
                        fire_sizes=fire_sizes,
                        fire_qualities_available=fire_qualities_available,
                    )
                elif wants_msp_layer and fire_intervals:
                    legacy_layers = build_legacy_layers(
                        intervals,
                        fp_quality_list,
                        lq_quality_list,
                        rq_quality_list,
                        fire_intervals,
                        region_start,
                        region_end,
                        infer_layers=False,
                        nuc_min_size=legacy_nuc_min_size,
                        include_qualities=include_layer_qualities,
                        fire_sizes=fire_sizes,
                        fire_qualities_available=fire_qualities_available,
                    )

                # A canonical channel outside the viewport still suppresses
                # legacy inference, just as when cropping a containing cache.
                layers = {name: layer for name, layer in legacy_layers.items() if name not in ma_layer_names}
                layers.update(ma_layers)
                if (fire_calls and "msp" in layers and "msp" not in ma_layers
                        and len(layers["msp"]["intervals"]) == len(fire_calls)):
                    # The MSP layer built from as/al: one call per FIRE interval.
                    layers["msp"]["_fiberbrowser_calls"] = [list(call) for call in fire_calls]

                if infer_legacy_layers and wants_msp_layer and not has_explicit_msp and "msp" not in layers and "msp" not in ma_layer_names:
                    msp_intervals = generate_msp_from_nuc_gaps(intervals, min_nuc_size=legacy_nuc_min_size)
                    if msp_intervals:
                        layers["msp"] = {
                            "intervals": msp_intervals,
                            "qualities": None,
                            "quality_names": [],
                        }

                if layers:
                    read_data["layers"] = layers
                _profile_add("layer_build", phase_t0)

            phase_t0 = _profile_start()
            if include_lift_meta:
                read_data.update(lift_meta_fields(
                    read, coord_mapper, lift_call_meta,
                    interval_calls=_footprint_interval_calls(
                        intervals, footprints, region_start, region_end, fp_starts_query, fp_lengths, lift_call_meta),
                    fire_calls=fire_calls,
                    edge_qualities=_footprint_edge_qualities(footprints, lq_qualities, rq_qualities),
                    legacy={"ma_names": sorted(ma_layer_names), "explicit_msp": has_explicit_msp,
                            "fire_qualities_available": fire_qualities_available}))
                # Live lift applies the per-record footprint rules (no footprint, the terminal-gap
                # filter, the hidden terminal gaps' call extent) to each lifted record itself: the whole
                # record's kept footprints, its call extent and dropped read-end calls (absolute
                # reference), and what parses its MA footprint calls when a lifted record holds only
                # some of them.
                read_data["_fiberbrowser_call_bounds"] = {
                    "fp": sorted([int(fp[0]), int(fp[1])] for fp in footprints),
                    "fp_extent": ([min(int(fp[0]) for fp in footprints), max(int(fp[1]) for fp in footprints)]
                                  if footprints else None),
                    "extent": [int(call_extent[0]), int(call_extent[1])] if call_extent is not None else None,
                    "dropped": sorted([int(fp[0]), int(fp[1])] for fp in dropped_footprints),
                    # Requested MA calls left out as read-end calls (they still keep a record: explicit MA).
                    "ma_skipped": sorted(ma_skipped_spans or ()),
                    "ma": ((ma_tags, read_length, bool(read.is_reverse), family_contracts, lift_call_meta[1])
                           if ma_tags is not None else None),
                    "_ma_query": ma_spans,
                }
            _attach_sv_events(read_data, read, region_start, sv_min_len, include_sv_seq, mapper=coord_mapper,
                              molecule_records=molecule_records, reference=sv_reference)
            _profile_add("sv_events", phase_t0)
            if partition is not None:
                read_data['_fiberbrowser_source_order'] = source_order
            if read_data.get("layers") and _NUC_GROUP_NAMES.intersection(read_data["layers"]):
                # The record's own nucleosome groups (an annotated BAM), only when FiberHMM reads them as current
                # for its calls: a stale or unsupported group is neither a layer nor scalars.
                _drop_stale_nuc_groups(read_data, read)
            if read_data.get("layers") and _SCALAR_GROUP_NAMES.intersection(read_data["layers"]):
                # A scan's per-molecule scalar group (nucmol, nfrmol): values on the row, never a drawn layer.
                _scalar_groups_to_fields(read_data)
            if nuc_inject is not None:
                nuc_inject(read_data)
            reads.append(read_data)
            if load_budget is not None:
                load_budget.account(read_data)
            if stream is not None:
                stream.append(read_data)

        if signal_window is not None:
            signal_window.finish()

    except Exception as exc:
        from services.bam_tags import FramePolicyError
        from services.sv_molecules import MoleculeBudgetError
        if isinstance(exc, (FramePolicyError, MoleculeBudgetError)):
            raise
        from services.packed_reads import bounded_analysis
        if stream is not None or fetch_regions is not None or bounded_analysis.get():
            raise
        from services.remote_sources.base import RemoteReadError
        if isinstance(exc, RemoteReadError):
            raise
        log_bam_diagnostic(f"Error reading BAM file {bam_path}: {exc}")
        if diagnose_bam:
            traceback.print_exc()
        if is_url(bam_path) and isinstance(exc, OSError):
            # A remote file whose connection broke: answering with the reads read
            # so far (often none) showed an empty region, cached, and the broken
            # handle kept failing after the network came back.
            from services.bam_handles import discard_bam_handle
            from services.remote_sources.base import RemoteReadError
            from services.remote_sources.opening import redact
            discard_bam_handle(bam_path)
            raise RemoteReadError(
                f"Reading {redact(bam_path)} failed at {chrom}:{region_start}-{region_end} "
                f"({redact(str(exc)) or type(exc).__name__}): the network or the server may be down. "
                "Check it, then reload the region."
            ) from None
    finally:
        for iterator in reversed(open_iterators):
            close = getattr(iterator, "close", None)
            if close is not None:
                close()

    if diagnose_bam and (reads_with_tags == 0 or reads_without_tags > 0):
        log_bam_diagnostic(f"BAM compact reads for {chrom}:{region_start}-{region_end}:")
        log_bam_diagnostic(f"  Reads with Fiber-seq tags: {reads_with_tags}")
        log_bam_diagnostic(f"  Reads without tags (included as raw): {reads_without_tags}")
        if reads_with_tags == 0:
            log_bam_diagnostic("  Note: No reads with ns/nl or as/al tags found. Showing raw read extents.")
            log_bam_diagnostic("  To add footprint annotations, run 'ft add-nucleosomes' on your BAM.")

    if profile_bam:
        total = time_module.perf_counter() - profile_total_t0
        phase_payload = {
            name: round(elapsed, 4)
            for name, elapsed in sorted(profile_timings.items(), key=lambda item: item[0])
        }
        profile_counts["returned_reads"] = len(reads)
        print(
            "BAM loader profile "
            f"{os.path.basename(bam_path)} {chrom}:{region_start}-{region_end} "
            f"marks={include_methylation} layers={requested_layer_set if requested_layer_set is not None else include_layers} cigar={include_cigar} "
            f"total={total:.4f}s phases={phase_payload} counts={profile_counts}"
        )

    return reads.finish() if isinstance(reads, PackedReadBuilder) else reads


# Tags whose offsets a hard clip would put out of frame (see supplementary_decodable).
_ANNOTATION_TAGS = ("MA", "Ma", "ns", "as", "MM", "Mm")


def supplementary_decodable(read) -> bool:
    """Whether a supplementary record can be decoded on its own: soft-clipped,
    or carrying no annotation tags. The loader flips molecular-frame tags by
    SEQ length, which a hard clip shortens (FiberHMM's lift scopes annotations
    per record instead; live lift hides these and counts them)."""
    if not any(op == 5 for op, _length in (read.cigartuples or ())):
        return True
    return not any(read.has_tag(tag) for tag in _ANNOTATION_TAGS)


def _hard_clip_lengths(read) -> tuple:
    cigar = read.cigartuples or ()
    left = int(cigar[0][1]) if cigar and cigar[0][0] == 5 else 0
    right = int(cigar[-1][1]) if len(cigar) > 1 and cigar[-1][0] == 5 else 0
    return left, right


def annotation_scope(read, partial: int, total: int) -> Optional[str]:
    """``'partial'`` (the record's stored SEQ), ``'whole'`` (the molecule),
    ``'none'`` (no footprint tags) or None (undecidable) for a hard-clipped
    record's footprint tags. Vendored from FiberHMM's lift
    (``fiberhmm.io.graph_lift.annotation_scope``), so the browser decides each
    record exactly as ``fiberhmm-lift`` does.

    MA's (else Ma's) read length decides; legacy tags follow it. A record with
    legacy tags only: partial when every interval fits its stored SEQ, whole
    when one does not but all fit the molecule."""
    for tag in ("MA", "Ma"):
        if read.has_tag(tag):
            try:
                length = int(str(read.get_tag(tag)).split(";", 1)[0])
            except ValueError:
                return None
            return "partial" if length == partial else "whole" if length == total else None
    ends = []
    for start_tag, size_tag in (("ns", "nl"), ("as", "al")):
        if read.has_tag(start_tag) and read.has_tag(size_tag):
            ends += [int(s) + int(n) for s, n in zip(read.get_tag(start_tag), read.get_tag(size_tag))]
        elif read.has_tag(start_tag) or read.has_tag(size_tag):
            return None
    if not ends:
        return "none"
    if max(ends) <= partial:
        return "partial"
    return "whole" if max(ends) <= total else None


_MOD_TAG_NAMES = ("MM", "ML", "Mm", "Ml", "MN", "Mn")
_COMPLEMENT = str.maketrans("ACGTN", "TGCAN")


def _mods_fit_stored_seq(read) -> bool:
    """Whether the record's MM/ML describe its stored SEQ: MN (when present)
    equals the stored length, and every MM group's skip counts fit the bases
    the stored SEQ has (FiberHMM's "valid on the stored SEQ")."""
    seq = read.query_sequence or ""
    for tag in ("MN", "Mn"):
        if read.has_tag(tag):
            try:
                return int(read.get_tag(tag)) == len(seq)
            except (TypeError, ValueError):
                return False
    mm = read.get_tag("MM") if read.has_tag("MM") else read.get_tag("Mm") if read.has_tag("Mm") else ""
    molecule = seq[::-1].translate(_COMPLEMENT) if read.is_reverse else seq
    for group in str(mm).split(";"):
        fields = group.split(",")
        head = fields[0]
        if len(head) < 2:
            continue
        base, strand = head[0].upper(), head[1]
        # htslib counts the named base in the read's original orientation for
        # either strand ('-' says only which strand carries the modification).
        available = len(molecule) if base == "N" else molecule.upper().count(base)
        try:
            needed = sum(int(v) + 1 for v in fields[1:] if v != "")
        except ValueError:
            return False
        if needed > available:
            return False
    return True


def scope_hard_clipped_supplementary(read, counts: Optional[dict] = None):
    """A supplementary record ready for record-scoped (live-lift) decoding, or
    None when it must be hidden (counted in ``counts['hard_clipped_supplementary']``).

    Soft-clipped records pass unchanged. A hard-clipped one follows
    :func:`annotation_scope`: ``partial``/``none`` decode as they are (the
    loader's frame handling is the stored SEQ's, and call metadata adds the
    leading clip); ``whole`` tags describe the molecule, so they decode on a
    copy whose hard clips become soft clips of unknown bases (``N``), which is
    exactly the soft-clipped record's layout. Modification calls are kept only
    when they describe the stored SEQ (no ``N`` counts as a modifiable base, so
    they stay valid after padding); otherwise they are dropped and counted in
    ``counts['hard_clip_mods_dropped']``. ``counts['hard_clipped_scoped']``
    tallies the scopes of the records kept."""
    left, right = _hard_clip_lengths(read)
    if not (left or right):
        return read
    seq = read.query_sequence or ""
    partial = len(seq) or int(read.query_length or 0)
    total = left + partial + right
    scope = annotation_scope(read, partial, total)
    if scope is None or (scope == "whole" and not seq):
        if counts is not None:
            counts["hard_clipped_supplementary"] = counts.get("hard_clipped_supplementary", 0) + 1
        return None
    has_mods = read.has_tag("MM") or read.has_tag("Mm")
    drop_mods = has_mods and not _mods_fit_stored_seq(read)
    if counts is not None:
        scoped = counts.setdefault("hard_clipped_scoped", {"partial": 0, "whole": 0, "none": 0})
        scoped[scope] = scoped.get(scope, 0) + 1
    if scope != "whole" and not drop_mods:
        return read
    import array as _array
    import pysam
    copy = pysam.AlignedSegment.fromstring(read.to_string(), read.header)
    if drop_mods:
        for tag in _MOD_TAG_NAMES:
            if copy.has_tag(tag):
                copy.set_tag(tag, None)
        if counts is not None:
            counts["hard_clip_mods_dropped"] = counts.get("hard_clip_mods_dropped", 0) + 1
    if scope == "whole":
        quals = copy.query_qualities
        cigar = list(copy.cigartuples)
        if left:
            cigar[0] = (4, left)
        if right:
            cigar[-1] = (4, right)
        copy.cigartuples = cigar
        copy.query_sequence = "N" * left + seq + "N" * right
        if quals is not None:
            copy.query_qualities = _array.array("B", [0] * left + list(quals) + [0] * right)
        for tag in ("MN", "Mn"):
            if copy.has_tag(tag):
                copy.set_tag(tag, len(copy.query_sequence), value_type="i")
        for tag in ("MM", "Mm"):
            if copy.has_tag(tag):
                # The pad at the molecule's 5' end: the SEQ's right one on a reverse record.
                copy.set_tag(tag, _pad_any_base_mm(str(copy.get_tag(tag)), right if read.is_reverse else left),
                             value_type="Z")
    return copy


def _pad_any_base_mm(mm: str, pad5: int) -> str:
    """MM after padding the stored SEQ with ``N``: groups of base ``N`` (any
    base) count the pad too, so their first skip count moves past the
    ``pad5`` bases at the molecule's 5' end, and an implicit ('.') group
    becomes explicit ('?'): the padded bases were never assessed. Groups of a
    named base never see an ``N`` and stay as they are."""
    out = []
    for group in mm.split(";"):
        if not group:
            continue
        fields = group.split(",")
        head = fields[0]
        if head[:1].upper() == "N":
            mode = head[-1] if head[-1] in "?." else ""
            head = (head[:-1] if mode else head) + "?"
            calls = fields[1:]
            if calls and calls[0] != "":
                calls[0] = str(int(calls[0]) + pad5)
            fields = [head, *calls]
        out.append(",".join(fields))
    return "".join(g + ";" for g in out)


def record_call_meta(read) -> tuple:
    """``(read_length, lead_hard_clip, is_reverse)``: what turns SEQ-frame query
    spans into molecular spans (``bam_tags.seq_span_to_molecular``)."""
    cigar = read.cigartuples or ()
    lead = int(cigar[0][1]) if cigar and cigar[0][0] == 5 else 0
    try:
        length = int(read.infer_read_length() or 0)
    except Exception:
        length = 0
    return (length or int(read.query_length or 0) + lead, lead, bool(read.is_reverse))


def lift_meta_fields(read, coord_mapper, call_meta, *, interval_calls=None, fire_calls=None,
                     edge_qualities=None, legacy=None) -> dict:
    """Internal fields live lift (services/lift) needs from a decoded record,
    never sent to a client (``_fiberbrowser_`` prefix):

    ``_fiberbrowser_aligned_runs``: ``[ref_start, mol_start, len]`` per aligned
    CIGAR run (M/=/X), absolute reference; ``mol_start`` is the molecular index
    of the run's first reference base (on a reverse record the run goes down
    the molecule from there);
    ``_fiberbrowser_calls``: ``{'intervals': [...], 'fire': [...]}`` parallel to
    those lists (layers carry their own ``_fiberbrowser_calls``): per call
    ``[call_id, mol_start, mol_end]`` (``None`` for gaps and neutral rows), with
    ``call_id`` ``'<group>:<tag index>'`` stable for the record;
    ``_fiberbrowser_primary``: ``{is_supplementary, sa}``;
    ``_fiberbrowser_lift_record``: ``{contig, reverse, length}``;
    ``_fiberbrowser_edge_qualities``: ``{call_id: [lq, rq]}`` of ns/nl calls;
    ``_fiberbrowser_legacy``: what legacy layer inference after lifting needs.
    Only with include_cigar the loader also retains ``_fiberbrowser_sequence``,
    ``_fiberbrowser_md`` and ``_fiberbrowser_sequence_lead`` (leading hard-clip
    length), so live lift can compare view bases with the target FASTA."""
    length, lead, reverse = call_meta
    import numpy as np
    from services.read_columns import owned
    # These blocks survive until composition: one compact column avoids a
    # tracked Python list for every CIGAR block and repeated scalar conversion.
    q0 = np.asarray(coord_mapper._aligned_starts, dtype=np.int64)
    q1 = np.asarray(coord_mapper._aligned_ends, dtype=np.int64)
    offsets = np.asarray(coord_mapper._aligned_offsets, dtype=np.int64)
    mol = length - 1 - (q0 + lead) if reverse else q0 + lead
    runs = owned(np.column_stack((q0 + offsets, mol, q1 - q0)))
    sa = read.get_tag("SA") if read.has_tag("SA") else None
    fields = {
        "_fiberbrowser_aligned_runs": runs,
        "_fiberbrowser_calls": {"intervals": interval_calls, "fire": fire_calls},
        "_fiberbrowser_primary": {"is_supplementary": bool(read.is_supplementary), "sa": sa},
        "_fiberbrowser_lift_record": {"contig": read.reference_name, "reverse": reverse, "length": int(length)},
    }
    if edge_qualities:
        fields["_fiberbrowser_edge_qualities"] = edge_qualities
    if legacy is not None:
        fields["_fiberbrowser_legacy"] = legacy
    return fields


def _footprint_interval_calls(intervals, footprints, region_start, region_end, starts, lengths, call_meta):
    """Per-interval ``[call_id, mol_start, mol_end]`` of the ns/nl footprints
    ``build_intervals_from_footprints`` drew (gaps and a neutral row: None)."""
    from services.bam_tags import seq_span_to_molecular
    drawn = [fp for fp in sorted(footprints, key=lambda item: item[0])
             if fp[1] > region_start and fp[0] < region_end]
    if sum(1 for iv in intervals if iv[2] >= 0) != len(drawn):
        return [None] * len(intervals)
    calls, it = [], iter(drawn)
    for iv in intervals:
        if iv[2] < 0:
            calls.append(None)
            continue
        tag = next(it)[4]
        start = int(starts[tag])
        calls.append([f"ns:{tag}", *seq_span_to_molecular(start, start + int(lengths[tag]), *call_meta)])
    return calls


def _footprint_edge_qualities(footprints, lq_qualities, rq_qualities):
    if lq_qualities is None and rq_qualities is None:
        return None
    out = {}
    for fp in footprints:
        tag = fp[4]
        out[f"ns:{tag}"] = [
            int(lq_qualities[tag]) if lq_qualities is not None and tag < len(lq_qualities) else 0,
            int(rq_qualities[tag]) if rq_qualities is not None and tag < len(rq_qualities) else 0,
        ]
    return out


def _attach_sv_events(read_data, read, region_start, sv_min_len, include_sv_seq=False, mapper=None,
                      molecule_records=None, reference=None):
    """``sv`` on a compact read, and its calls split at the deletions. A record
    the extraction can't read (a test double without a CIGAR string) keeps
    none: SV events never cost a read its row."""
    try:
        from services.sv_events import alignment_evidence
        read_data.update(alignment_evidence(read))
        events = extract_sv_events(read, sv_extraction_floor(sv_min_len), include_seq=include_sv_seq, mapper=mapper,
                                    reference=reference)
        if molecule_records and len(molecule_records) > 1:
            from services.sv_molecules import consolidate_evidence
            parts = [dict(id=record.query_name, reference_start=int(record.reference_start),
                          reference_end=int(record.reference_end), **alignment_evidence(record),
                          sv=extract_sv_events(record, sv_extraction_floor(sv_min_len), include_seq=include_sv_seq,
                                               reference=reference) or [])
                     for record in molecule_records]
            combined = consolidate_evidence(parts)
            for key in ('sv_alignments', 'sv_segments', 'aligned_blocks', 'alignment_spans'):
                read_data[key] = combined[key]
            events = combined['sv']
    except Exception:
        return
    if events:
        read_data["sv"] = events
    # Cuts belong to the drawn anchor CIGAR, independently of canonical allele
    # anchors and of other alignments retained in its evidence bundle.
    from services.sv_events import read_deletion_cuts
    cuts = [(a - region_start, b - region_start) for a, b in read_deletion_cuts(read, sv_min_len, mapper=mapper)]
    if cuts:
        split_compact_read_at_deletions(read_data, cuts)


def extract_cigar_events(read, region_start, region_end):
    """
    Extract CIGAR events (mismatches, insertions, deletions) for visualization.

    Returns list of events: {type: 'M'|'I'|'D', pos: int, len: int, seq?: string}
    where pos is relative to region_start.
    """
    events = []

    if not read.cigartuples or not read.query_sequence:
        return events

    ref_pos = read.reference_start
    query_pos = 0
    query_seq = read.query_sequence

    md_tag = None
    try:
        md_tag = read.get_tag('MD')
    except KeyError:
        pass

    for op, length in read.cigartuples:
        if op == 0:  # M - alignment match/mismatch
            if md_tag:
                pass
            ref_pos += length
            query_pos += length

        elif op == 7:  # = (sequence match)
            ref_pos += length
            query_pos += length

        elif op == 8:  # X (sequence mismatch)
            if region_start <= ref_pos < region_end:
                mismatch_seq = query_seq[query_pos:query_pos + length]
                for i in range(length):
                    pos = ref_pos + i
                    if region_start <= pos < region_end:
                        events.append({
                            'type': 'M',
                            'pos': int(pos - region_start),
                            'len': 1,
                            'seq': mismatch_seq[i] if i < len(mismatch_seq) else '?'
                        })
            ref_pos += length
            query_pos += length

        elif op == 1:  # I - insertion
            if region_start <= ref_pos < region_end:
                ins_seq = query_seq[query_pos:query_pos + length]
                events.append({
                    'type': 'I',
                    'pos': int(ref_pos - region_start),
                    'len': length,
                    'seq': ins_seq
                })
            query_pos += length

        elif op == 2:  # D - deletion
            if ref_pos >= region_start and ref_pos + length <= region_end:
                events.append({
                    'type': 'D',
                    'pos': int(ref_pos - region_start),
                    'len': length
                })
            elif ref_pos < region_end and ref_pos + length > region_start:
                clip_start = max(ref_pos, region_start)
                clip_end = min(ref_pos + length, region_end)
                events.append({
                    'type': 'D',
                    'pos': int(clip_start - region_start),
                    'len': int(clip_end - clip_start)
                })
            ref_pos += length

        elif op == 3:  # N - skipped region
            ref_pos += length

        elif op == 4:  # S - soft clip
            query_pos += length

        elif op == 5:  # H - hard clip
            pass

    return events


def build_cigar_coord_mapper(cigartuples, ref_start):
    """Build efficient CIGAR coordinate mapper."""
    return CigarCoordMapper(cigartuples, ref_start)
