"""BAM molecular tag parsing helpers."""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional

from services.diagnostics import env_flag_enabled, log_if_enabled


BAM_DIAGNOSTICS_ENV = "FIBERBROWSER_BAM_DIAGNOSTICS"
_mm_tag_warning_count = 0
_ry_detection_logged = False
_daf_mismatch_detection_logged = False
_IUPAC_RY_RE = re.compile("[RYry]")
_MM_SECTION_RE = re.compile(r"^([ACGTUN])([+-])([A-Za-z]+|[0-9]+)([.?]?)$")
_REVERSE_COMPLEMENT = str.maketrans(
    "ACGTRYMKBDHVNacgtrymkbdhvn",
    "TGCAYRKMVHDBNtgcayrkmvhdbn",
)


def _header_declares_coord_molecular(hdr: dict) -> bool:
    """Return True when @PG/@CO explicitly declares molecular coordinates."""
    for pg in hdr.get("PG", []) or []:
        try:
            text = " ".join(str(v) for v in pg.values())
        except AttributeError:
            text = str(pg)
        if "coord=molecular" in text.lower():
            return True
    for comment in hdr.get("CO", []) or []:
        if "coord=molecular" in str(comment).lower():
            return True
    return False


def _mm_base_position_array(sequence: str, bases: str):
    import numpy as np

    data = np.frombuffer(sequence.encode("ascii", "replace").upper(), dtype=np.uint8)
    mask = data == ord(bases[0].upper())
    for base in bases[1:]:
        mask |= data == ord(base.upper())
    return np.flatnonzero(mask)


def mm_base_positions(sequence: str, bases: str) -> list[int]:
    """Indexes of ``sequence`` whose base (case-insensitive) is one of
    ``bases``: an MM tag's candidate positions. Vectorised: a per-base Python
    loop cost ~5 ms per 20 kb read, a large share of loading deep long-read
    data with marks."""
    return _mm_base_position_array(sequence, bases).tolist()


def _coerce_header_dict(header) -> Optional[dict]:
    try:
        return header.to_dict() if hasattr(header, "to_dict") else dict(header or {})
    except Exception:
        return None


def bam_tag_diagnostics_enabled() -> bool:
    return env_flag_enabled(BAM_DIAGNOSTICS_ENV)


def log_bam_tag_diagnostic(message: str) -> None:
    log_if_enabled(BAM_DIAGNOSTICS_ENV, message)


# ---------------------------------------------------------------------------
# Frame of the legacy ns/nl/as/al (and nq/aq/lq/rq) tags.
# The rule is specified in docs/reference/footprint-tag-frame.md; FiberHMM's
# `recall-tfs --input-frame auto` implements the same rule. Keep them in step.
# ---------------------------------------------------------------------------

# fibertools-rs subcommands that (re)write ns/nl/as/al: predict-m6a (aliases
# m6a/m6A; `ft predict` in fibertools-rs 0.1-0.3), add-nucleosomes (`ft add`
# in 0.2), fire, fiber-hmm; plus their unambiguous prefixes (below).
FIBERTOOLS_FOOTPRINT_SUBCOMMANDS = frozenset(
    {"predict", "predict-m6a", "m6a", "add", "add-nucleosomes", "add-nucleosome", "fire", "fiber-hmm"})
_FIBERTOOLS_PROGRAMS = frozenset({"ft", "fibertools", "fibertools-rs"})
# fibertools accepts any unambiguous subcommand prefix (`ft add-nuc` is in real
# headers); the shortest unambiguous prefix of each footprint writer.
_FIBERTOOLS_FOOTPRINT_PREFIXES = (("add-nucleosomes", 3), ("predict-m6a", 4), ("fire", 3), ("fiber-hmm", 5))


def _is_fibertools_footprint_subcommand(token: str) -> bool:
    if token in FIBERTOOLS_FOOTPRINT_SUBCOMMANDS:
        return True
    return any(len(token) >= n and full.startswith(token) for full, n in _FIBERTOOLS_FOOTPRINT_PREFIXES)
# FiberHMM programs that write the legacy tags. Every other fiberhmm-* program
# (tag-m5c, call-m5c, dedup, merge, pair, strand-rescue-annotate, tag-consensus,
# pipeline, ...) passes them through unchanged.
FIBERHMM_FOOTPRINT_PROGRAMS = frozenset(
    {"fiberhmm-apply", "fiberhmm-call", "fiberhmm-recall-tfs", "fiberhmm-recall-nucs"})
_FIBERHMM_NAME_RE = re.compile(r"^fiberhmm(?:-[a-z0-9-]+)?$")
# @PG ID collision suffixes added by samtools/pysam when headers are merged
# (`ID.1`, `ID-61483E4`); stripped for classification only.
_PG_ID_SUFFIX_RE = re.compile(r"(?:\.\d+|-[0-9a-f]{6,8})$")
_COORD_MOLECULAR = "coord=molecular"


def _pg_id_base(ident: str) -> str:
    base = ident.lower()
    while True:
        stripped = _PG_ID_SUFFIX_RE.sub("", base)
        if stripped == base or not stripped:
            return base
        base = stripped


def _cl_tokens(cl: str) -> List[str]:
    return [token for token in str(cl or "").lower().split() if token]


def _basename(token: str) -> str:
    return token.rstrip("/").rsplit("/", 1)[-1]


def _pg_family(pg: dict) -> Optional[str]:
    """``'fibertools'``, ``'fiberhmm'`` or None (any other program).

    PN decides when present; else the ID with collision suffixes stripped; else
    the program named by the first CL token. A PN such as ``samtools`` is never
    overridden by an ID or CL that happens to mention a producer."""
    pn = str(pg.get("PN", "") or "").strip().lower()
    if pn:
        if "fibertools" in pn:
            return "fibertools"
        return "fiberhmm" if _FIBERHMM_NAME_RE.match(pn) else None
    base = _pg_id_base(str(pg.get("ID", "") or "").strip())
    if base in _FIBERTOOLS_PROGRAMS or base.startswith("fibertools"):
        return "fibertools"
    if _FIBERHMM_NAME_RE.match(base):
        return "fiberhmm"
    tokens = _cl_tokens(pg.get("CL", ""))
    program = _basename(tokens[0]) if tokens else ""
    if program in _FIBERTOOLS_PROGRAMS:
        return "fibertools"
    if _FIBERHMM_NAME_RE.match(program):
        return "fiberhmm"
    return None


def _pg_text(pg: dict) -> str:
    try:
        return " ".join(str(v) for v in pg.values()).lower()
    except AttributeError:
        return str(pg).lower()


def _pg_writer_frame(pg: dict, header_marker: bool) -> Optional[str]:
    """Frame of the legacy tags this @PG record wrote, or None if it wrote none."""
    family = _pg_family(pg)
    if family == "fibertools":
        tokens = _cl_tokens(pg.get("CL", ""))
        start = next((i + 1 for i, t in enumerate(tokens) if _basename(t) in _FIBERTOOLS_PROGRAMS), 1)
        if any(_is_fibertools_footprint_subcommand(t) for t in tokens[start:]):
            return "molecular"   # fibertools only ever writes molecular frame
        return None
    if family == "fiberhmm":
        record_marker = _COORD_MOLECULAR in _pg_text(pg)
        tokens = _cl_tokens(pg.get("CL", ""))
        names = {
            str(pg.get("PN", "") or "").strip().lower(),
            _pg_id_base(str(pg.get("ID", "") or "").strip()),
            _basename(tokens[0]) if tokens else "",
        }
        if record_marker or names & FIBERHMM_FOOTPRINT_PROGRAMS:
            return "molecular" if (record_marker or header_marker) else "seq"
    return None


def legacy_tag_frame_report(header) -> dict:
    """How the legacy ns/nl/as/al tags' frame was decided (see
    docs/reference/footprint-tag-frame.md).

    Each @PG leaf (a record no other record names as PP) starts a chain that is
    walked up through PP. The chain's frame is that of the first footprint
    writer met (the last one to run). Writers: fibertools-rs nucleosome
    commands (molecular) and FiberHMM apply/call/recall-tfs/recall-nucs
    (molecular when the record or an @CO declares coord=molecular, else SEQ).
    Header order is used as the chain only when no record has a PP field.
    Chains without a writer do not vote. Agreeing votes decide; with no votes
    an explicit coord=molecular anywhere means molecular, else SEQ (unmarked
    legacy FiberHMM). Conflicting votes (merged files) resolve to molecular
    when coord=molecular is declared anywhere, else to the majority (ties:
    SEQ), and are reported as ambiguous.
    """
    report = {"frame": "seq", "source": "default", "ambiguous": False,
              "votes": {"molecular": 0, "seq": 0}, "writers": [], "chains": 0}
    hdr = _coerce_header_dict(header)
    if hdr is None:
        return report
    pgs = [pg for pg in (hdr.get("PG", []) or []) if isinstance(pg, dict)]
    comments = [str(c).lower() for c in (hdr.get("CO", []) or [])]
    header_marker = any(_COORD_MOLECULAR in c for c in comments)
    declared = header_marker or any(_COORD_MOLECULAR in _pg_text(pg) for pg in pgs)

    frames = [_pg_writer_frame(pg, header_marker) for pg in pgs]
    ids = [str(pg.get("ID", "") or "") for pg in pgs]
    parent: List[Optional[int]] = [None] * len(pgs)
    if any("PP" in pg for pg in pgs):
        by_id: Dict[str, List[int]] = {}
        for i, ident in enumerate(ids):
            by_id.setdefault(ident, []).append(i)
        for i, pg in enumerate(pgs):
            pp = str(pg.get("PP", "") or "")
            candidates = [j for j in by_id.get(pp, []) if j != i] if pp else []
            if candidates:
                earlier = [j for j in candidates if j < i]
                parent[i] = earlier[-1] if earlier else candidates[-1]
    else:
        parent = [i - 1 if i > 0 else None for i in range(len(pgs))]
    referenced = {j for j in parent if j is not None}
    leaves = [i for i in range(len(pgs)) if i not in referenced]
    if pgs and not leaves:          # every record is someone's parent: a PP cycle
        leaves = [len(pgs) - 1]
    report["chains"] = len(leaves)

    for leaf in leaves:
        node, seen = leaf, set()
        while node is not None and node not in seen:
            seen.add(node)
            if frames[node] is not None:
                report["votes"][frames[node]] += 1
                report["writers"].append({"id": ids[node], "frame": frames[node]})
                break
            node = parent[node]

    mol, seq = report["votes"]["molecular"], report["votes"]["seq"]
    if mol and seq:
        report["ambiguous"] = True
        report["source"] = "declared" if declared else "majority"
        report["frame"] = "molecular" if (declared or mol > seq) else "seq"
    elif mol or seq:
        report["source"] = "provenance"
        report["frame"] = "molecular" if mol else "seq"
    elif declared:
        report["source"] = "declared"
        report["frame"] = "molecular"
    # No @PG evidence: FIBERHMM-CHEMISTRY does not decide (merge and pair add it while passing historical reads
    # through); the reads' own "." footprint groups do (read_legacy_tags_are_molecular).
    return report


def bam_legacy_tags_are_molecular(header) -> bool:
    """Whether a BAM's *legacy* ns/nl/as/al tags are in molecular (original
    fiber) frame rather than SEQ (query) frame; see ``legacy_tag_frame_report``.

    fibertools is molecular-native (``add_nucleosomes_to_record`` gets the m6A
    calls in original-read orientation and ``bamranges.rs`` flips ns/nl back
    for reverse reads); FiberHMM >= 2.x writes molecular frame and declares
    ``coord=molecular``; unmarked FiberHMM v1.0 output is SEQ frame. MA/AQ
    frame detection is separate (``bam_ma_aq_tags_are_molecular``).
    """
    return legacy_tag_frame_report(header)["frame"] == "molecular"


def bam_legacy_frame(header) -> tuple[bool, bool]:
    """``(molecular, unknown)`` for a BAM's legacy ns/nl/as/al tags: the header's frame
    (``legacy_tag_frame_report``) and whether the header gave no evidence at all (SEQ assumed)."""
    report = legacy_tag_frame_report(header)
    return report["frame"] == "molecular", report["source"] == "default"


def read_legacy_tags_are_molecular(read, frame: tuple[bool, bool]) -> bool:
    """A read's legacy tags' frame: the header's (the @PG chain rule). Without @PG evidence, a read whose ``MA``
    has ``.`` footprint groups (FiberHMM >= 2.13.2, which writes its legacy tags in molecular frame too) is
    molecular; otherwise SEQ (and the file check says the frame was assumed). FIBERHMM-CHEMISTRY never decides:
    merge and pair add it while passing historical reads through (FiberHMM's rule)."""
    molecular, unknown = frame
    if molecular or not unknown:
        return molecular
    try:
        return read.has_tag("MA") and ma_footprint_groups_are_molecular(read.get_tag("MA"))
    except (AttributeError, KeyError):
        return False


# FiberHMM's warning (fiberhmm.io.annotation_frame.UNVERIFIABLE_FRAME_WARNING, 3.0.1), for a BAM whose header gives
# no frame evidence while its reads carry footprints whose frame depends on it.
UNVERIFIABLE_FRAME_WARNING = ("The header has no FiberHMM/fibertools provenance, so footprint coordinates on "
                              "reverse reads can't be confirmed; re-call with FiberHMM 3.0.")
FRAME_SCAN_RECORDS = 2000
_MA_GROUP_HEAD_RE = re.compile(r"^([A-Za-z0-9_]+?)([.+-])([A-Za-z]*)$")
_frame_unverifiable_cache: Dict[tuple, bool] = {}


def read_has_frame_dependent_annotations(read) -> bool:
    """Whether ``read`` carries footprint annotations whose frame depends on the header (FiberHMM's rule of the same
    name): legacy ns/nl or as/al arrays, or MA groups other than m5C (always molecular). fibertools ``Ma`` is always
    molecular."""
    try:
        for start_tag, length_tag in (("ns", "nl"), ("as", "al")):
            if read.has_tag(start_tag) and read.has_tag(length_tag):
                value = read.get_tag(start_tag)
                if hasattr(value, "__len__") and len(value):
                    return True
        if read.has_tag("MA"):
            for group in str(read.get_tag("MA")).split(";")[1:]:
                head, _, body = group.partition(":")
                match = _MA_GROUP_HEAD_RE.match(head)
                if match and match.group(1) not in M5C_GROUPS and body.strip(","):
                    return True
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
    return False


class _Descriptor:
    """An OS file descriptor with ``close()`` (pysam leaves a descriptor it was given open)."""

    def __init__(self, fd: int):
        self.fd = fd

    def close(self) -> None:
        import os
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None


def open_bam_without_index(path):
    """A BAM opened on a bare OS file descriptor, so htslib has no file name to look an index up by: not beside the
    BAM (the Library refuses some indexes: online-only, outside the folder) and not ``<fd>.bai`` / ``<fd>.csi`` in the
    working directory either (a Python file object's numeric name would be probed so). Returns ``(bam, descriptor)``;
    close both."""
    import os
    import pysam
    descriptor = _Descriptor(os.open(os.fspath(path), os.O_RDONLY))
    try:
        return pysam.AlignmentFile(descriptor.fd, "rb", check_sq=False), descriptor
    except Exception:
        descriptor.close()
        raise


def _frame_unverifiable_in(bam, scan_records: int) -> bool:
    if legacy_tag_frame_report(bam.header.to_dict())["source"] != "default":
        return False
    for index, read in enumerate(bam.fetch(until_eof=True)):
        if index >= scan_records:
            return False
        if read_has_frame_dependent_annotations(read):
            return True
    return False


def bam_frame_unverifiable(path, scan_records: int = FRAME_SCAN_RECORDS) -> bool:
    """A local BAM whose header gives no frame evidence (no footprint writer on a @PG chain, no coord=molecular) and
    whose first ``scan_records`` records carry frame-dependent footprint annotations: FiberHMM 3.0.1 warns about such
    files (``warn_if_frames_unverifiable``), and so does FiberBrowser. A warning only: nothing is drawn differently.
    Remote and unreadable files are never flagged. Cached per file (path, size, modification time). The BAM is
    opened without any index (``open_bam_without_index``): only the file itself is read."""
    import os
    if not isinstance(path, (str, os.PathLike)) or "://" in os.fspath(path):
        return False
    try:
        real = os.path.realpath(os.fspath(path))
        st = os.stat(real)
    except OSError:
        return False
    key = (real, st.st_size, st.st_mtime_ns)
    cached = _frame_unverifiable_cache.get(key)
    if cached is not None:
        return cached
    found = False
    try:
        from services.htslib_quiet import quiet_htslib
        with quiet_htslib():
            opened, handle = open_bam_without_index(real)
            try:
                found = _frame_unverifiable_in(opened, scan_records)
            finally:
                opened.close()
                handle.close()
    except Exception:
        found = False
    if len(_frame_unverifiable_cache) > 256:
        _frame_unverifiable_cache.clear()
    _frame_unverifiable_cache[key] = found
    return found


def bam_consensus_contracts(header):
    """Per-layer producer semantics; do not reinterpret preserved native layers."""
    import json
    result={}
    for comment in (_coerce_header_dict(header) or {}).get('CO',[]):
        prefix='FIBERHMM-CONSENSUS-MA:v1:'
        if comment.startswith(prefix):
            try:
                value=json.loads(comment[len(prefix):])
            except ValueError:
                continue  # a malformed contract is skipped, as FiberHMM's consensus_molecular_layers does
            if not isinstance(value, dict):
                continue
            for layer in value.get('layers',[]) or []:
                result[str(layer)]=value
    return result


def legacy_starts_in_seq_frame(starts, lengths, read, legacy_molecular: bool) -> list:
    """Legacy ns/nl (and as/al) starts in SEQ frame, ready for CIGAR mapping.

    Files whose legacy tags are molecular (``bam_legacy_tags_are_molecular``)
    count a reverse read's intervals from the molecule's own start, the genomic
    right end: flip them as the compact loader does
    (``seq_start = read_length - (start + length)``). SEQ-frame files and
    forward reads are unchanged.
    """
    read_length = getattr(read, 'query_length', 0) or 0
    if not (legacy_molecular and getattr(read, 'is_reverse', False) and read_length > 0):
        return [int(s) for s in starts]
    return [read_length - (int(s) + int(l)) for s, l in zip(starts, lengths)]


# A footprint group (nuc/msp/tf) written with the "." (unknown) strand, e.g. ``;nuc.QQQ:`` or ``;msp.:``.
_MA_DOT_FOOTPRINT_RE = re.compile(r";(?:nuc|msp|tf)\.[A-Za-z]*:")


# DddA m5C groups. Their producers (FiberHMM tag-m5c, call-m5c, pair) write every qualifier ('.', '+', '-') in
# molecular frame, whatever frame the footprint tags use.
M5C_GROUPS = frozenset({"ddda_mcg", "ddda_ucg", "ddda_mcg_hemi"})
CONSENSUS_MOLECULAR_COORDINATES = "original_source_call_in_molecular_frame"


SCAN_CONTRACT_PREFIX = "FIBERHMM-SCAN-MA:v1:"


def scan_ma_contracts(header) -> dict:
    """``group -> contract`` of the fiberhmm-scan MA groups a header declares (``@CO FIBERHMM-SCAN-MA:v1:<json>``;
    the last valid line of a group wins)."""
    try:
        hd = header if isinstance(header, dict) else header.to_dict()
    except Exception:
        return {}
    out = {}
    for comment in hd.get("CO", []) or []:
        text = str(comment)
        if not text.startswith(SCAN_CONTRACT_PREFIX):
            continue
        try:
            value = json.loads(text[len(SCAN_CONTRACT_PREFIX):])
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("group"), str):
            out[value["group"]] = value
    return out


def scan_molecular_groups(header) -> frozenset:
    """The scan groups a header declares molecular (every scan group is, unless its contract says otherwise)."""
    return frozenset(g for g, v in scan_ma_contracts(header).items() if v.get("coordinates", "molecular") == "molecular")


class MAGroupFrame:
    """The frame of each ``MA`` group of a BAM: FiberHMM's ``fiberhmm.io.annotation_frame.MAGroupFrame`` (3.0.1),
    kept here so FiberBrowser reads the same with FiberHMM 3.0.0 (docs/reference/footprint-tag-frame.md).

    m5C groups and consensus family layers are molecular; every other group follows the header rule
    (``coord=molecular`` anywhere: molecular, else SEQ), except that a header without frame evidence (no footprint
    writer on a ``@PG`` chain and no declaration: stripped ``@PG``) makes a ``.`` group molecular.
    """

    __slots__ = ("header_molecular", "evidence", "molecular_layers")

    def __init__(self, header_molecular: bool, evidence: bool, molecular_layers=frozenset()):
        self.header_molecular = bool(header_molecular)
        self.evidence = bool(evidence)
        self.molecular_layers = frozenset(molecular_layers) | M5C_GROUPS

    @classmethod
    def of_header(cls, header) -> "MAGroupFrame":
        layers = {layer for layer, contract in bam_consensus_contracts(header).items()
                  if isinstance(contract, dict) and contract.get("coordinates") == CONSENSUS_MOLECULAR_COORDINATES}
        # fiberhmm-scan groups (fpcls, nfrvar, nfrmol, nucsz, ...) are molecular whatever the header rule says
        # (contract fiberhmm.scan.v1 §6.2): a group named in a FIBERHMM-SCAN-MA line is never mirrored.
        layers |= scan_molecular_groups(header)
        return cls(bam_ma_aq_tags_are_molecular(header), legacy_tag_frame_report(header)["source"] != "default", layers)

    def is_molecular(self, name: str, strand: str) -> bool:
        return name in self.molecular_layers or ma_group_is_molecular(strand, self.header_molecular, self.evidence)

    def __bool__(self) -> bool:
        return self.header_molecular

    def __repr__(self) -> str:
        return f"MAGroupFrame(header_molecular={self.header_molecular}, evidence={self.evidence})"


# fibertools-rs Ma/Aq/An: always molecular.
MA_ALL_MOLECULAR = MAGroupFrame(True, True)


def ma_group_frame(value) -> MAGroupFrame:
    """A frame for ``value``: a :class:`MAGroupFrame` as it is; a bare header flag (callers without the header) as a
    header without frame evidence, so a ``.`` group is molecular and a ``+``/``-`` group follows the flag."""
    return value if isinstance(value, MAGroupFrame) else MAGroupFrame(bool(value), False)


class FramePolicyError(RuntimeError):
    """The annotation coordinate policy could not be determined safely."""


def bam_ma_group_frame(header) -> MAGroupFrame:
    """Read the header frame; policy/import failures must not silently mirror reads.

    Missing optional FiberHMM helpers have their own declared-header fallback.
    Unexpected runtime errors propagate rather than changing molecular to SEQ.
    """
    try:
        return MAGroupFrame.of_header(header)
    except Exception as exc:
        raise FramePolicyError(str(exc)) from exc


def ma_group_is_molecular(strand: str, header_molecular: bool, header_evidence: bool = False) -> bool:
    """One MA group's frame by the header rule, except that without header evidence a ``.`` group is molecular
    (FiberHMM's ``ma_group_is_molecular``). FiberHMM >= 2.13.2 writes every group with ``.``, always molecular, and
    declares it; FiberHMM <= 2.12 wrote SEQ-frame ``+`` groups, and tag-m5c may append groups to those strings."""
    if header_molecular:
        return True
    return (not header_evidence) and strand == "."


def ma_footprint_groups_are_molecular(ma) -> bool:
    """Whether a read's ``MA`` carries ``.`` footprint groups (nuc/msp/tf): written by FiberHMM >= 2.13.2, which
    writes the read's legacy ns/nl/as/al in molecular frame too. m5C groups (``ddda_mcg.``, appended by tag-m5c
    to historical reads) do not count."""
    return isinstance(ma, str) and _MA_DOT_FOOTPRINT_RE.search(ma) is not None


def bam_ma_aq_tags_are_molecular(header) -> bool:
    """Decide whether MA/AQ tags should be interpreted as molecular frame.

    MA/AQ tags have appeared in both SEQ-frame and molecular-frame files. Unlike
    legacy fibertools ns/nl provenance, an MA tag by itself is not a frame
    signal: current daf_timecourse BAMs carry MA intervals that match their
    unflipped ns/nl tags on reverse reads. Only honor explicit coord=molecular
    provenance for MA/AQ so unmarked files stay in SEQ/query coordinates.

    FiberHMM's shared policy (``fiberhmm.io.annotation_frame``) is used when it
    can be imported. Without it (not installed, or an older release) the same
    rule is applied here, so reverse reads in molecular files still flip instead
    of the import error silently making every file SEQ frame.
    """
    hdr = _coerce_header_dict(header)
    if hdr is None:
        return False
    try:
        from fiberhmm.io.annotation_frame import ma_annotation_frame
    except ImportError:
        return _header_declares_coord_molecular(hdr)
    return ma_annotation_frame(hdr) == 'molecular'


def _empty_mm_layers() -> Dict[str, List]:
    return {"m6a": [], "m5c": [], "deam": []}


def _warn_bad_mm_tag(read, reason: str) -> None:
    global _mm_tag_warning_count

    if bam_tag_diagnostics_enabled() and _mm_tag_warning_count < 5:
        _mm_tag_warning_count += 1
        read_name = getattr(read, "query_name", "<unnamed>")
        log_bam_tag_diagnostic(
            f"  WARNING: Corrupt MM/ML tag in read {read_name} "
            f"({reason}; skipping methylation)"
        )


def _get_optional_tag(read, primary: str, legacy: str):
    """Get a SAM tag while accepting its historical mixed-case spelling."""
    for tag in (primary, legacy):
        try:
            if read.has_tag(tag):
                return read.get_tag(tag)
        except Exception:
            continue
    return None


def _original_sequence(read) -> Optional[str]:
    """Return SEQ in the original as-sequenced orientation used by MM tags."""
    sequence = getattr(read, "query_sequence", None)
    if not isinstance(sequence, str) or not sequence:
        return None
    try:
        is_reverse = bool(read.is_reverse)
    except Exception:
        is_reverse = False
    if is_reverse:
        return sequence.translate(_REVERSE_COMPLEMENT)[::-1]
    return sequence


def _decode_mm_ml_calls(read):
    """Decode raw MM/ML tags (query/SEQ coordinates, as get_aligned_pairs).

    Each MM section is decoded with numpy (cumulative deltas into the
    candidate-base array); the outcome, including every ``None`` for a corrupt
    tag, is the same as ``_decode_mm_ml_calls_reference``, which still runs
    for anything outside this path's assumptions (an ML tag that is not a
    uint8 array, a delta written with leading zeros or too many digits).
    """
    import array
    from itertools import repeat

    import numpy as np

    mm_tag = _get_optional_tag(read, "MM", "Mm")
    if not isinstance(mm_tag, str) or not mm_tag:
        return []
    ml_values = _get_optional_tag(read, "ML", "Ml")
    if ml_values is not None and not (isinstance(ml_values, array.array) and ml_values.typecode == "B"):
        return _decode_mm_ml_calls_reference(read)  # not the pysam uint8 array the fast path assumes

    original_sequence = _original_sequence(read)
    if original_sequence is None:
        _warn_bad_mm_tag(read, "missing query sequence")
        return None
    sequence_length = len(original_sequence)
    try:
        is_reverse = bool(read.is_reverse)
    except Exception:
        is_reverse = False
    try:
        query_length = read.query_length
    except Exception:
        query_length = None
    if query_length is not None:
        try:
            query_length = int(query_length)
        except (TypeError, ValueError, OverflowError):
            _warn_bad_mm_tag(read, "invalid query length")
            return None
        if query_length != sequence_length:
            _warn_bad_mm_tag(read, "query length does not match SEQ")
            return None
    mn_tag = _get_optional_tag(read, "MN", "Mn")
    if mn_tag is not None:
        try:
            if int(mn_tag) != sequence_length:
                _warn_bad_mm_tag(read, "MN does not match SEQ length")
                return None
        except (TypeError, ValueError, OverflowError):
            _warn_bad_mm_tag(read, "invalid MN tag")
            return None

    if ml_values is not None:
        ml_array = np.frombuffer(ml_values, dtype=np.uint8) if len(ml_values) else np.zeros(0, dtype=np.uint8)
        ml_length = len(ml_array)
    else:
        ml_array = None
        ml_length = 0

    max_delta_digits = len(str(sequence_length))
    candidate_cache = {}
    calls = []
    ml_index = 0
    for raw_section in mm_tag.split(";"):
        section = raw_section.strip()
        if not section:
            continue
        fields = section.split(",")
        match = _MM_SECTION_RE.fullmatch(fields[0])
        if match is None:
            _warn_bad_mm_tag(read, "invalid MM section header")
            return None
        fundamental_base, _strand, raw_codes, _skip_mode = match.groups()
        if raw_codes.isdigit():
            if len(raw_codes.lstrip("0")) > 10:
                _warn_bad_mm_tag(read, "numeric modification code is too large")
                return None
            modification_codes = (int(raw_codes),)
        else:
            modification_codes = tuple(raw_codes)

        delta_fields = fields[1:]
        n = len(delta_fields)
        if n:
            # == any(not f.isascii() or not f.isdigit() for f in delta_fields)
            joined = "".join(delta_fields)
            if "" in delta_fields or not (joined.isascii() and joined.isdigit()):
                _warn_bad_mm_tag(read, "invalid MM delta")
                return None
        if n > sequence_length:
            _warn_bad_mm_tag(read, "too many MM positions")
            return None
        if n and max(map(len, delta_fields)) > max_delta_digits:
            return _decode_mm_ml_calls_reference(read)  # leading zeros or an oversized delta: the original decides

        if fundamental_base not in candidate_cache:
            if fundamental_base == "N":
                candidates = np.arange(sequence_length)
            elif fundamental_base == "U":
                candidates = _mm_base_position_array(original_sequence, "TU")
            else:
                candidates = _mm_base_position_array(original_sequence, fundamental_base)
            candidate_cache[fundamental_base] = candidates
        candidates = candidate_cache[fundamental_base]
        if not n:
            continue

        deltas = np.fromiter(map(int, delta_fields), dtype=np.int64, count=n)
        if int(deltas.max()) > sequence_length:
            _warn_bad_mm_tag(read, "MM delta exceeds sequence length")
            return None
        index = np.cumsum(deltas + 1) - 1  # candidate_index after each delta (increasing)
        if int(index[-1]) >= len(candidates):
            _warn_bad_mm_tag(read, "MM delta exceeds available bases")
            return None
        positions = candidates[index]
        if is_reverse:
            positions = sequence_length - positions - 1

        n_codes = len(modification_codes)
        total = n * n_codes
        if ml_array is not None:
            probs = np.full(total, -1, dtype=np.int64)
            available = ml_array[ml_index:ml_index + total]
            probs[:len(available)] = available
            prob_list = probs.tolist()
        else:
            prob_list = [-1] * total
        ml_index += total
        if n_codes == 1:
            calls.extend(zip(repeat(fundamental_base, total), repeat(modification_codes[0], total),
                             positions.tolist(), prob_list))
        else:
            calls.extend(zip(repeat(fundamental_base, total), modification_codes * n,
                             np.repeat(positions, n_codes).tolist(), prob_list))

    if ml_values is not None and ml_index != ml_length:
        _warn_bad_mm_tag(read, "ML length does not match MM calls")
        return None
    return calls


def _decode_mm_ml_calls_reference(read):
    """Decode raw MM/ML tags without invoking pysam's native decoder.

    Returned call coordinates are query/SEQ coordinates, matching
    ``AlignedSegment.get_aligned_pairs`` on both forward and reverse reads.
    """
    mm_tag = _get_optional_tag(read, "MM", "Mm")
    if not isinstance(mm_tag, str) or not mm_tag:
        return []

    original_sequence = _original_sequence(read)
    if original_sequence is None:
        _warn_bad_mm_tag(read, "missing query sequence")
        return None
    sequence_length = len(original_sequence)
    try:
        is_reverse = bool(read.is_reverse)
    except Exception:
        is_reverse = False

    try:
        query_length = read.query_length
    except Exception:
        query_length = None
    if query_length is not None:
        try:
            query_length = int(query_length)
        except (TypeError, ValueError, OverflowError):
            _warn_bad_mm_tag(read, "invalid query length")
            return None
        if query_length != sequence_length:
            _warn_bad_mm_tag(read, "query length does not match SEQ")
            return None

    mn_tag = _get_optional_tag(read, "MN", "Mn")
    if mn_tag is not None:
        try:
            if int(mn_tag) != sequence_length:
                _warn_bad_mm_tag(read, "MN does not match SEQ length")
                return None
        except (TypeError, ValueError, OverflowError):
            _warn_bad_mm_tag(read, "invalid MN tag")
            return None

    ml_values = _get_optional_tag(read, "ML", "Ml")
    if ml_values is not None:
        try:
            ml_length = len(ml_values)
        except (TypeError, ValueError, OverflowError):
            _warn_bad_mm_tag(read, "invalid ML tag")
            return None
    else:
        ml_length = 0

    candidate_cache = {}
    calls = []
    ml_index = 0

    for raw_section in mm_tag.split(";"):
        section = raw_section.strip()
        if not section:
            continue

        fields = section.split(",")
        match = _MM_SECTION_RE.fullmatch(fields[0])
        if match is None:
            _warn_bad_mm_tag(read, "invalid MM section header")
            return None

        fundamental_base, _strand, raw_codes, _skip_mode = match.groups()
        if raw_codes.isdigit():
            if len(raw_codes.lstrip("0")) > 10:
                _warn_bad_mm_tag(read, "numeric modification code is too large")
                return None
            modification_codes = (int(raw_codes),)
        else:
            modification_codes = tuple(raw_codes)

        delta_fields = fields[1:]
        if any(not field.isascii() or not field.isdigit() for field in delta_fields):
            _warn_bad_mm_tag(read, "invalid MM delta")
            return None
        if len(delta_fields) > sequence_length:
            _warn_bad_mm_tag(read, "too many MM positions")
            return None
        max_delta_digits = len(str(sequence_length))
        if any(len(field.lstrip("0") or "0") > max_delta_digits for field in delta_fields):
            _warn_bad_mm_tag(read, "MM delta exceeds sequence length")
            return None

        if fundamental_base not in candidate_cache:
            if fundamental_base == "N":
                candidates = list(range(sequence_length))
            elif fundamental_base == "U":
                candidates = mm_base_positions(original_sequence, "TU")
            else:
                candidates = mm_base_positions(original_sequence, fundamental_base)
            candidate_cache[fundamental_base] = candidates
        candidates = candidate_cache[fundamental_base]

        candidate_index = -1
        for field in delta_fields:
            delta = int(field)
            if delta > sequence_length:
                _warn_bad_mm_tag(read, "MM delta exceeds sequence length")
                return None
            candidate_index += delta + 1
            if candidate_index >= len(candidates):
                _warn_bad_mm_tag(read, "MM delta exceeds available bases")
                return None

            original_query_pos = candidates[candidate_index]
            if is_reverse:
                query_pos = sequence_length - original_query_pos - 1
            else:
                query_pos = original_query_pos

            for modification_code in modification_codes:
                probability = -1
                if ml_values is not None and ml_index < ml_length:
                    try:
                        candidate_probability = int(ml_values[ml_index])
                        if 0 <= candidate_probability <= 255:
                            probability = candidate_probability
                    except (TypeError, ValueError, OverflowError):
                        pass
                calls.append(
                    (
                        fundamental_base,
                        modification_code,
                        query_pos,
                        probability,
                    )
                )
                ml_index += 1

    if ml_values is not None and ml_index != ml_length:
        _warn_bad_mm_tag(read, "ML length does not match MM calls")
        return None
    return calls


def parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold=125):
    """
    Parse methylation positions from BAM MM/ML tags, split by modification type.

    Returns a dict with m6a, m5c, and deam layer positions in region-relative
    reference coordinates.
    """
    calls = _decode_mm_ml_calls(read)
    if not calls:
        return _empty_mm_layers()

    try:
        # SEQ index -> reference position (None for soft-clipped/inserted bases):
        # the aligned pairs, as one list built in C. A padded CIGAR (P) keeps the
        # aligned-pairs walk, whose query index pysam advances across padding.
        if any(op == 6 for op, _length in (getattr(read, "cigartuples", None) or ())):
            pairs = {q: int(r) for q, r in read.get_aligned_pairs() if q is not None and r is not None}
            ref_positions = [pairs.get(q) for q in range(max(pairs, default=-1) + 1)]
        else:
            ref_positions = read.get_reference_positions(full_length=True)
    except Exception:
        return _empty_mm_layers()
    n_positions = len(ref_positions)

    by_type = _empty_mm_layers()
    deam_letter_codes = {"u"}
    deam_chebi_codes = {55797}

    for base, mod_type, query_pos, prob in calls:
        flavor = None
        if mod_type == "a":
            key = "m6a"
        elif mod_type == "m":
            key = "m5c"
        elif mod_type in deam_letter_codes or mod_type in deam_chebi_codes:
            key = "deam"
            flavor = 0 if (isinstance(base, str) and base.upper() == "G") else 1
            if getattr(read, "is_reverse", False):
                flavor = 1 - flavor
        else:
            continue

        if prob < ml_threshold:
            continue
        ref_pos = ref_positions[query_pos] if 0 <= query_pos < n_positions else None
        if ref_pos is None:
            continue
        if region_start <= ref_pos < region_end:
            rel = int(ref_pos - region_start)
            if key == "deam":
                by_type["deam"].append([rel, flavor])
            else:
                by_type[key].append(rel)

    by_type["m6a"].sort()
    by_type["m5c"].sort()
    if by_type["deam"]:
        by_type["deam"].sort(key=lambda x: x[0])
    return by_type


def parse_mm_ml_tags(read, region_start, region_end, ml_threshold=125):
    """Back-compat wrapper returning m6A-only positions as a flat list."""
    return parse_mm_ml_tags_by_type(read, region_start, region_end, ml_threshold).get("m6a", [])


def parse_iupac_ry_positions(read, region_start, region_end):
    """Extract DAF deamination events from IUPAC R/Y codes in read sequence."""
    global _ry_detection_logged

    seq = read.query_sequence
    if not seq:
        return []
    # Substring scans (memchr) rule out most reads far faster than a regex search.
    if "R" not in seq and "Y" not in seq and "r" not in seq and "y" not in seq:
        return []

    # Walk only aligned query slices intersecting the viewport. Building a
    # Python reference-position object for every query base and scanning marks
    # outside the viewport dominates deep DAF loads. SEQ and CIGAR are already
    # in alignment orientation, including for reverse-strand BAM records.
    cigar = getattr(read, "cigartuples", None)
    ref_start = getattr(read, "reference_start", None)
    if cigar and ref_start is not None and all(op in range(9) for op, _ in cigar):
        query_pos, ref_pos = 0, int(ref_start)
        events = []
        for op, length in cigar:
            if op in (0, 7, 8):  # M, =, X consume both coordinates
                lo = query_pos + max(0, region_start - ref_pos)
                hi = min(query_pos + length, query_pos + region_end - ref_pos, len(seq))
                if lo < hi:
                    for mark in _IUPAC_RY_RE.finditer(seq, lo, hi):
                        events.append([ref_pos + mark.start() - query_pos - region_start,
                                       0 if mark.group(0).upper() == "R" else 1])
                query_pos += length
                ref_pos += length
            elif op in (1, 4):  # insertion, soft clip
                query_pos += length
            elif op in (2, 3):  # deletion, reference skip
                ref_pos += length
            # Hard clips and padding consume neither coordinate.
            if ref_pos >= region_end:
                break
        return events

    # Lightweight read adapters without CIGAR retain the original fallback.
    match = _IUPAC_RY_RE.search(seq)
    if match is None:
        return []

    if not _ry_detection_logged and bam_tag_diagnostics_enabled():
        _ry_detection_logged = True
        log_bam_tag_diagnostic(f"  Detected IUPAC R/Y encoding in read {read.query_name} (DAF-seq deamination marks)")

    try:
        ref_positions = read.get_reference_positions(full_length=True)
    except Exception:
        try:
            aligned_pairs = {}
            for q, r in read.get_aligned_pairs():
                if q is not None and r is not None:
                    aligned_pairs[q] = int(r)
        except Exception:
            return []

        events = []
        while match is not None:
            query_pos = match.start()
            ref_pos = aligned_pairs.get(query_pos)
            if ref_pos is not None and region_start <= ref_pos < region_end:
                flavor = 0 if match.group(0).upper() == "R" else 1
                events.append([int(ref_pos - region_start), flavor])
            match = _IUPAC_RY_RE.search(seq, match.end())

        events.sort(key=lambda x: x[0])
        return events

    events = []
    while match is not None:
        query_pos = match.start()
        ref_pos = ref_positions[query_pos] if query_pos < len(ref_positions) else None
        if ref_pos is not None and region_start <= ref_pos < region_end:
            flavor = 0 if match.group(0).upper() == "R" else 1
            events.append([int(ref_pos - region_start), flavor])
        match = _IUPAC_RY_RE.search(seq, match.end())

    events.sort(key=lambda x: x[0])
    return events


_MD_TOKEN = re.compile(r"\d+|\^[A-Za-z]+|[A-Za-z]")


def _daf_mismatches_from_md(read, region_start, region_end):
    """Walk MD mismatches and CIGAR runs, without expanding every aligned base.

    MD consumes matches and deletions, but not CIGAR N skips. Keep its offset
    separate from both query and reference coordinates. Return None for an
    unsupported/inconsistent record so the established pysam path handles it.
    """
    try:
        md = read.get_tag('MD')
        cigar = read.cigartuples
        reference = read.reference_start
        sequence = read.query_sequence
    except (AttributeError, KeyError, ValueError):
        return None
    if not isinstance(md, str) or not cigar or not sequence or reference < 0:
        return None
    segments, deletions = [], []
    md_length = query = 0
    for op, length in cigar:
        if length <= 0:
            return None
        if op in (0, 7, 8):  # M, =, X
            segments.append((md_length, md_length + length, query, reference))
            md_length += length
            query += length
            reference += length
        elif op == 2:  # D: present in MD, absent from the query
            if deletions and deletions[-1][1] == md_length:
                deletions[-1] = (deletions[-1][0], md_length + length)
            else:
                deletions.append((md_length, md_length + length))
            md_length += length
            reference += length
        elif op == 3:  # N: absent from MD and the query
            reference += length
        elif op in (1, 4):  # I, S
            query += length
        elif op != 5:  # H consumes neither; unusual operators use pysam
            return None
    if query != len(sequence):
        return None
    events, md_deletions = [], []
    position = segment_index = text_end = 0
    for match in _MD_TOKEN.finditer(md):
        if match.start() != text_end:
            return None
        text_end = match.end()
        token = match.group()
        if token[0].isdigit():
            position += int(token)
            continue
        if token[0] == '^':
            deletion_end = position + len(token) - 1
            if md_deletions and md_deletions[-1][1] == position:
                md_deletions[-1] = (md_deletions[-1][0], deletion_end)
            else:
                md_deletions.append((position, deletion_end))
            position = deletion_end
            continue
        while segment_index < len(segments) and position >= segments[segment_index][1]:
            segment_index += 1
        if segment_index == len(segments):
            return None
        lo, hi, query_start, ref_start = segments[segment_index]
        if position < lo:
            return None
        offset = position - lo
        ref_position = ref_start + offset
        if region_start <= ref_position < region_end:
            ref_base = token.upper()
            read_base = sequence[query_start + offset].upper()
            if ref_base == 'C' and read_base == 'T':
                events.append([int(ref_position - region_start), 1])
            elif ref_base == 'G' and read_base == 'A':
                events.append([int(ref_position - region_start), 0])
        position += 1
    if text_end != len(md) or position != md_length or md_deletions != deletions:
        return None
    return events


def parse_daf_mismatches(read, region_start, region_end):
    """Extract DAF deamination events from C-to-T and G-to-A mismatches."""
    global _daf_mismatch_detection_logged

    events = _daf_mismatches_from_md(read, region_start, region_end)
    if events is None:
        try:
            pairs = read.get_aligned_pairs(with_seq=True)
        except Exception:
            return []

        query_seq = read.query_sequence
        if not query_seq:
            return []

        events = []
        for qp, rp, rb in pairs:
            if qp is None or rp is None or rb is None:
                continue
            if not (region_start <= rp < region_end):
                continue
            ref_base = rb.upper()
            read_base = query_seq[qp].upper() if qp < len(query_seq) else None
            if read_base is None:
                continue
            if ref_base == "C" and read_base == "T":
                events.append([int(rp - region_start), 1])
            elif ref_base == "G" and read_base == "A":
                events.append([int(rp - region_start), 0])

    if events and not _daf_mismatch_detection_logged and bam_tag_diagnostics_enabled():
        _daf_mismatch_detection_logged = True
        log_bam_tag_diagnostic(
            f"  Detected DAF C-to-T/G-to-A mismatches in read {read.query_name} "
            f"(iter17-style reference-aligned deamination encoding)"
        )

    events.sort(key=lambda x: x[0])
    return events


def parse_deamination_opportunities(read, region_start, region_end, deam_events=None):
    """Return aligned, strand-informative C/G sites for a DAF read.

    The result is region-relative ``{"ct": [...], "ga": [...]}``. Only
    aligned query bases contribute, so a source deletion is missing evidence,
    not a protected target. Observed IUPAC Y/R or mismatch-derived events are
    restored to their canonical C/G opportunity and remain in the rug.

    ``st:Z:CT`` / ``st:Z:GA`` (FiberHMM's spelling; ``ST`` is also accepted)
    restrict the result to the assayed channel. For older files without it, the IUPAC alphabet or an observed event
    flavor can resolve a single channel. Ambiguous reads emit no opportunity
    rug rather than claiming that both strands were assayable.
    """
    sequence = (getattr(read, "query_sequence", None) or "").upper()
    if not sequence:
        return {"ct": [], "ga": []}

    joint_masks = None
    if read.has_tag('cs') and read.has_tag('MA'):
        sources = str(read.get_tag('cs')).split(';')
        if len(sources) == 2 and len(set(sources)) == 2:
            # fiberhmm-merge emits forward reference-frame SEQ and query-frame
            # deam coverage. Missing coverage is not a protection observation.
            if getattr(read, 'is_reverse', False):
                return {"ct": [], "ga": []}
            joint_masks = {'ct': set(), 'ga': set()}
            try:
                for group in str(read.get_tag('MA')).split(';')[1:]:
                    head, sep, body = group.partition(':')
                    if head not in ('deam+', 'deam-') or not sep: continue
                    target = joint_masks['ct' if head == 'deam+' else 'ga']
                    for interval in body.split(','):
                        start, length = map(int, interval.split('-'))
                        target.update(range(max(0,start-1),min(len(sequence),start-1+length)))
            except ValueError:
                return {"ct": [], "ga": []}

    # FiberHMM writes the strand tag as ``st:Z`` (fiberhmm-daf-encode); ``ST`` is the older spelling.
    strand_tag = str(_get_optional_tag(read, "ST", "st") or "").strip().upper()

    if joint_masks is not None:
        include_ct = include_ga = True
    elif strand_tag in {"CT", "C>T", "Y"}:
        include_ct, include_ga = True, False
    elif strand_tag in {"GA", "G>A", "R"}:
        include_ct, include_ga = False, True
    else:
        has_y = "Y" in sequence
        has_r = "R" in sequence
        event_flavors = {
            int(event[1]) if len(event) > 1 else 0
            for event in (deam_events or [])
            if event
        }
        if has_y and not has_r:
            include_ct, include_ga = True, False
        elif has_r and not has_y:
            include_ct, include_ga = False, True
        elif event_flavors == {1}:
            include_ct, include_ga = True, False
        elif event_flavors == {0}:
            include_ct, include_ga = False, True
        else:
            include_ct = include_ga = False

    try:
        reference_positions = read.get_reference_positions(full_length=True)
    except Exception:
        try:
            reference_positions = [None] * len(sequence)
            for query_pos, reference_pos in read.get_aligned_pairs():
                if (
                    query_pos is not None
                    and reference_pos is not None
                    and 0 <= query_pos < len(reference_positions)
                ):
                    reference_positions[query_pos] = int(reference_pos)
        except Exception:
            return {"ct": [], "ga": []}

    ct_sites = set()
    ga_sites = set()
    for query_pos, base in enumerate(sequence):
        reference_pos = (
            reference_positions[query_pos]
            if query_pos < len(reference_positions)
            else None
        )
        if reference_pos is None or not (region_start <= reference_pos < region_end):
            continue
        relative_pos = int(reference_pos - region_start)
        if include_ct and base in {"C", "Y"} and (joint_masks is None or query_pos in joint_masks["ct"]):
            ct_sites.add(relative_pos)
        if include_ga and base in {"G", "R"} and (joint_masks is None or query_pos in joint_masks["ga"]):
            ga_sites.add(relative_pos)

    if joint_masks is not None:
        return {"ct": sorted(ct_sites), "ga": sorted(ga_sites)}

    for event in deam_events or []:
        if not event:
            continue
        relative_pos = int(event[0])
        if not (0 <= relative_pos < region_end - region_start):
            continue
        flavor = int(event[1]) if len(event) > 1 else 0
        if flavor == 1 and include_ct:
            ct_sites.add(relative_pos)
        elif flavor == 0 and include_ga:
            ga_sites.add(relative_pos)

    return {"ct": sorted(ct_sites), "ga": sorted(ga_sites)}


# Cross-strand DAF consensus reads (fiberhmm-merge / fiberhmm-pair) record the
# reference span each strand covered as MA deam+ (CT, C->T) and deam- (GA,
# G->A). Besides the merged "deam" layer, each strand is its own layer so the
# browser can show where both strands (or only one) support the molecule.
DEAM_STRAND_LAYERS = {"+": "deam_ct", "-": "deam_ga"}


def parse_ma_aq_tags_into_layers(ma_str: str, aq_values, coord_mapper,
                                 region_start: int, region_end: int,
                                 include_names=None,
                                 an_str: str | None = None,
                                 include_qualities: bool = True,
                                 read_length: int = 0,
                                 is_reverse: bool = False,
                                 tags_are_molecular: "bool | MAGroupFrame" = False,
                                 family_contracts=None,
                                 skip_query_spans=None,
                                 skip_span_layers=(),
                                 skipped_in_region=None,
                                 present_names=None,
                                 call_meta=None) -> Dict[str, Dict]:
    """Parse fiberseq MA:Z + AQ:B:C tags into a layers dict.

    By default MA/AQ intervals are treated as SEQ/query-frame offsets, matching
    the legacy ns/nl frame used by unmarked FiberHMM BAMs. If the BAM declares
    molecular coordinates, reverse-mapped reads are flipped to SEQ frame before
    CIGAR mapping (``seq_start = read_length - (mol_start + length)``) and their
    left/right edge-sharpness bytes (el/er, lq/rq) are swapped because the
    molecular-left edge is the genomic-right edge.

    ``an_str`` carries optional per-interval annotation names (AN:Z), surfaced as
    ``annotation_name`` on each parsed layer interval.

    ``skip_query_spans``: SEQ-frame query ``(start, end)`` calls of the
    ``skip_span_layers`` sections that are left out (dropped read-end
    footprints); their quality bytes and names are still stepped over.
    ``skipped_in_region``: a list that receives the layer name of each skipped
    call that would have been drawn in the region.
    ``present_names``: a set receiving mapped layer names before viewport clipping.
    ``call_meta``: ``(read_length, lead_hard_clip, is_reverse)`` of the record, for
    live lift (services/lift): each layer then carries ``_fiberbrowser_calls``,
    parallel to its intervals, ``[call_id, mol_start, mol_end)`` with the stable
    ``call_id`` ``"MA<section>:<index>"`` and the call's molecular span.
    """
    group_frame = ma_group_frame(tags_are_molecular)
    if not ma_str or not isinstance(ma_str, str):
        return {}
    parts = ma_str.split(";")
    if len(parts) < 2:
        return {}

    aq_list = list(aq_values) if include_qualities and aq_values is not None else []
    aq_cursor = 0
    annotation_names = (
        [name if name != "." else "" for name in an_str.split(",")]
        if an_str and isinstance(an_str, str)
        else []
    )
    ann_cursor = 0
    layers: Dict[str, Dict] = {}
    include_set = set(include_names) if include_names is not None else None
    query_interval_to_ref = getattr(coord_mapper, "aligned_query_interval_to_ref", None) or getattr(coord_mapper, "query_interval_to_ref", None)

    known_qual_names = {
        ("nuc", 3): ["nq", "lq", "rq"],
        ("tf", 3): ["tq", "el", "er"],
        ("nuc_sr", 3): ["q0", "q1", "q2"],
        ("tf_sr", 3): ["q0", "q1", "q2"],
        ("tf_sr", 5): ["q0", "q1", "q2", "fi", "fq"],
        # Frozen derivative BAMs use the same byte order as the temporary
        # consensus overlay projected onto live Browser reads.
        ("tf_consensus", 4): ["tq", "fi", "fq", "op"],
        ("tf_cross_consensus", 4): ["tq", "fi", "fq", "op"],
        # sq: DAF molecule's core protection ceiling for the family (1+LLR*10;
        # 0 = not DAF). Family-level trusted strand is in the header catalog.
        ("tf_consensus", 5): ["tq", "fi", "fq", "op", "sq"],
        ("tf_cross_consensus", 5): ["tq", "fi", "fq", "op", "sq"],
        # q0: class support, the assigned class's share of the evidence among
        # all scored classes (x255), written by FiberHMM's class export.
        ("tf_consensus", 6): ["tq", "fi", "fq", "op", "sq", "q0"],
        ("tf_cross_consensus", 6): ["tq", "fi", "fq", "op", "sq", "q0"],
        ("msp", 1): ["aq"],
        ("fp_v2", 1): ["nq"],
    }

    # One logical MA type may be written as several strand sections (e.g.
    # fiberhmm-merge's deam+/deam-, or ctcf+Q/ctcf-Q). They are one layer:
    # later sections are merged into the first. A section whose quality spec
    # differs from the first one's cannot share its quality tracks and is
    # skipped (its AQ bytes and AN names are still stepped over).
    spec_by_name: Dict[str, str] = {}

    for section_index, part in enumerate(parts[1:]):
        if ":" not in part:
            continue
        type_sig, intervals_str = part.split(":", 1)
        strand_chars = ("+", "-", ".")
        strand_idx = -1
        for sc in strand_chars:
            idx = type_sig.find(sc)
            if idx >= 0:
                strand_idx = idx
                break
        if strand_idx < 0:
            continue
        name = type_sig[:strand_idx]
        qualspec = type_sig[strand_idx + 1:]
        if not name:
            continue
        strand_layer = DEAM_STRAND_LAYERS.get(type_sig[strand_idx]) if name == "deam" else None
        want_strand_layer = strand_layer is not None and (include_set is None or strand_layer in include_set)
        n_qual_per = len(qualspec)
        qual_names = known_qual_names.get(
            (name, n_qual_per),
            [f"q{i}" for i in range(n_qual_per)],
        )
        # Left/right edge-sharpness byte indices, swapped when molecular-frame
        # reverse reads are flipped so the renderer's genomic-left/right hold.
        edge_l_idx = qual_names.index('el') if 'el' in qual_names else (
            qual_names.index('lq') if 'lq' in qual_names else (
                qual_names.index('q1') if name in {'nuc_sr', 'tf_sr'} and 'q1' in qual_names else -1
            )
        )
        edge_r_idx = qual_names.index('er') if 'er' in qual_names else (
            qual_names.index('rq') if 'rq' in qual_names else (
                qual_names.index('q2') if name in {'nuc_sr', 'tf_sr'} and 'q2' in qual_names else -1
            )
        )

        ivs = []
        layer_intervals = []
        layer_source_intervals = []
        keep_layer = include_set is None or name in include_set or want_strand_layer
        if keep_layer:
            first_spec = spec_by_name.setdefault(name, qualspec)
            if first_spec != qualspec:
                log_bam_tag_diagnostic(
                    f"MA type {name!r}: section quality spec {qualspec!r} differs from "
                    f"{first_spec!r}; skipping that section"
                )
                keep_layer = False
        if not keep_layer:
            interval_count = sum(
                1
                for iv_str in intervals_str.split(",")
                if iv_str.strip() and "-" in iv_str
            )
            if include_qualities and n_qual_per > 0:
                aq_cursor += n_qual_per * interval_count
            ann_cursor += interval_count
            continue

        parsed_intervals = []
        for iv_str in intervals_str.split(","):
            iv_str = iv_str.strip()
            if not iv_str or "-" not in iv_str:
                continue
            ann_name = annotation_names[ann_cursor] if ann_cursor < len(annotation_names) else ""
            ann_cursor += 1
            try:
                s_str, l_str = iv_str.split("-", 1)
                s_one = int(s_str)
                l = int(l_str)
            except ValueError:
                continue

            if not keep_layer:
                aq_cursor += n_qual_per
                continue

            query_start = s_one - 1
            query_end = query_start + l
            parsed_intervals.append((query_start, query_end, l, aq_cursor, ann_name, len(parsed_intervals)))
            if include_qualities:
                aq_cursor += n_qual_per

        # Molecular -> SEQ frame for reverse reads. Flipping reverses interval
        # order, so re-sort by SEQ start (the qual cursor rides along with each
        # interval, and the el/er swap happens at qual-extraction below) to keep
        # the downstream genomic mapping ascending.
        contract=(family_contracts or {}).get(name,{})
        # Per group (MAGroupFrame): m5C groups and consensus layers molecular; others the header rule, a "." group
        # molecular only when the header has no frame evidence.
        molecular=(group_frame.is_molecular(name, type_sig[strand_idx])
                   or contract.get('coordinates')==CONSENSUS_MOLECULAR_COORDINATES)
        flip_molecular_reverse = bool(molecular and is_reverse and read_length)
        if flip_molecular_reverse:
            parsed_intervals = sorted(
                (
                    (read_length - qe, read_length - qs, l, qstart, ann, k)
                    for (qs, qe, l, qstart, ann, k) in parsed_intervals
                ),
                key=lambda t: t[0],
            )

        query_positions = []
        if not callable(query_interval_to_ref):
            for (q_start, q_end, _l, _qstart, _ann, _k) in parsed_intervals:
                query_positions.extend([q_start, q_end - 1])

        if parsed_intervals and not callable(query_interval_to_ref):
            query_to_ref_many = getattr(coord_mapper, "query_to_ref_many", None)
            if callable(query_to_ref_many):
                mapped_positions = query_to_ref_many(query_positions)
            else:
                mapped_positions = [
                    coord_mapper.query_to_ref(query_pos)
                    for query_pos in query_positions
                ]
        else:
            mapped_positions = []

        layer_annotation_names = []
        layer_calls = []
        keep_source_intervals = "fi" in qual_names
        skip_here = skip_query_spans if skip_query_spans and name in skip_span_layers else None
        for interval_index, (query_start, query_end, l, qual_start, ann_name, call_index) in enumerate(parsed_intervals):
            if callable(query_interval_to_ref):
                ref_start, ref_end = query_interval_to_ref(query_start, query_end - 1)
                if ref_start is None or ref_end is None:
                    continue
            else:
                ref_start = mapped_positions[interval_index * 2]
                ref_end = mapped_positions[interval_index * 2 + 1]
                if ref_start is None:
                    continue
                if ref_end is not None:
                    ref_end += 1
                else:
                    ref_end = ref_start + l

            if present_names is not None and ref_end > ref_start:
                present_names.add(name)
            cs = max(ref_start, region_start)
            ce = min(ref_end, region_end)
            if ce <= cs:
                continue
            if skip_here and (query_start, query_end) in skip_here:
                if skipped_in_region is not None:
                    skipped_in_region.append(name)
                continue
            interval = [int(cs - region_start), int(ce - region_start), int(l)]
            if call_meta is not None:
                layer_calls.append([f"MA{section_index}:{call_index}",
                                    *seq_span_to_molecular(query_start, query_end, *call_meta)])
            source_interval = [
                int(ref_start - region_start),
                int(ref_end - region_start),
                int(l),
            ] if keep_source_intervals else None
            if include_qualities and n_qual_per > 0:
                qual_slice = list(aq_list[qual_start:qual_start + n_qual_per])
                # Reverse molecular read: molecular-left is genomic-right.
                if (flip_molecular_reverse and edge_l_idx >= 0 and edge_r_idx >= 0
                        and edge_l_idx < len(qual_slice) and edge_r_idx < len(qual_slice)):
                    qual_slice[edge_l_idx], qual_slice[edge_r_idx] = (
                        qual_slice[edge_r_idx], qual_slice[edge_l_idx])
                ivs.append((interval, source_interval, qual_slice, ann_name))
            else:
                layer_intervals.append(interval)
                if keep_source_intervals:
                    layer_source_intervals.append(source_interval)
                layer_annotation_names.append(str(ann_name or ""))

        if not ivs and not layer_intervals:
            continue

        if include_qualities and n_qual_per > 0:
            layer_intervals = [x[0] for x in ivs]
            if keep_source_intervals:
                layer_source_intervals = [x[1] for x in ivs]
            layer_annotation_names = [str(x[3] or "") for x in ivs]
            qualities = [
                [int(x[2][i]) if i < len(x[2]) else 0 for x in ivs]
                for i in range(n_qual_per)
            ]
        else:
            qualities = None

        layer_payload = {
            "intervals": layer_intervals,
            "qualities": qualities,
            "quality_names": qual_names if include_qualities and n_qual_per > 0 else [],
        }
        if keep_source_intervals:
            # Unclipped bounds are needed only to keep family identity stable
            # at viewport edges; avoid doubling every ordinary layer payload.
            layer_payload["source_intervals"] = layer_source_intervals
        if any(layer_annotation_names):
            layer_payload["annotation_names"] = layer_annotation_names
            layer_payload["circular_ids"] = layer_annotation_names
        if call_meta is not None:
            layer_payload["_fiberbrowser_calls"] = layer_calls

        if (family_contracts or {}).get(name,{}).get('fq','').startswith('zero_unavailable'):
            layer_payload['family_confidence_kind']='unavailable'
        if want_strand_layer:
            copy = {key: (list(value) if isinstance(value, list) else value) for key, value in layer_payload.items()}
            if strand_layer in layers:
                _merge_layer_sections(layers[strand_layer], copy)
            else:
                layers[strand_layer] = copy
        if include_set is not None and name not in include_set:
            continue
        if name in layers:
            _merge_layer_sections(layers[name], layer_payload)
        else:
            layers[name] = layer_payload

    return layers


def seq_span_to_molecular(seq_start: int, seq_end: int, read_length: int, lead_hard_clip: int,
                          is_reverse: bool) -> list:
    """A half-open SEQ-frame query span as a half-open molecular span (the
    original read, hard clips included; reverse records count from the read's
    other end)."""
    a, b = int(seq_start) + int(lead_hard_clip), int(seq_end) + int(lead_hard_clip)
    if is_reverse:
        return [int(read_length) - b, int(read_length) - a]
    return [a, b]


def _merge_layer_sections(existing: Dict, section: Dict) -> None:
    """Merge a later MA section of the same type (same quality spec) into ``existing``.

    Intervals and every list parallel to them (quality tracks, annotation
    names / circular ids, unclipped source intervals) are concatenated and
    re-sorted together by genomic position.
    """
    old_n = len(existing.get("intervals") or [])
    new_n = len(section.get("intervals") or [])
    intervals = list(existing.get("intervals") or []) + list(section.get("intervals") or [])
    order = sorted(range(len(intervals)), key=lambda i: (intervals[i][0], intervals[i][1]))
    existing["intervals"] = [intervals[i] for i in order]

    if existing.get("qualities") is not None and section.get("qualities") is not None:
        existing["qualities"] = [
            [(list(old) + list(new))[i] for i in order]
            for old, new in zip(existing["qualities"], section["qualities"])
        ]

    if "source_intervals" in existing or "source_intervals" in section:
        old_sources = list(existing.get("source_intervals") or []) if "source_intervals" in existing else []
        new_sources = list(section.get("source_intervals") or []) if "source_intervals" in section else []
        # A side without unclipped bounds uses its clipped intervals.
        if len(old_sources) != old_n:
            old_sources = [list(iv) for iv in intervals[:old_n]]
        if len(new_sources) != new_n:
            new_sources = [list(iv) for iv in intervals[old_n:]]
        sources = old_sources + new_sources
        existing["source_intervals"] = [sources[i] for i in order]

    old_names = list(existing.get("annotation_names") or [""] * old_n)
    new_names = list(section.get("annotation_names") or [""] * new_n)
    names = old_names + new_names
    if any(names):
        merged_names = [names[i] for i in order]
        existing["annotation_names"] = merged_names
        existing["circular_ids"] = merged_names

    if "_fiberbrowser_calls" in existing or "_fiberbrowser_calls" in section:
        calls = (list(existing.get("_fiberbrowser_calls") or [None] * old_n)
                 + list(section.get("_fiberbrowser_calls") or [None] * new_n))
        existing["_fiberbrowser_calls"] = [calls[i] for i in order]


def generate_msp_from_nuc_gaps(intervals, min_nuc_size: int = 90) -> List:
    """Generate MSP intervals from gaps between adjacent nucleosomes.

    TF-sized footprints inside the linker should not break the MSP/FIRE span:
    infer nucs first, then take the remaining gap between consecutive nucs.
    """
    msp_intervals = []
    nuc_intervals = [
        [int(iv[0]), int(iv[1]), int(iv[2])]
        for iv in intervals or []
        if len(iv) >= 3 and int(iv[2]) >= min_nuc_size
    ]
    nuc_intervals.sort(key=lambda iv: (iv[0], iv[1]))
    for prev, cur in zip(nuc_intervals, nuc_intervals[1:]):
        gs = prev[1]
        ge = cur[0]
        if ge > gs:
            msp_intervals.append([gs, ge, ge - gs])
    return msp_intervals


def _split_quality_payload(indices: list[int], quality_names=None, qualities=None):
    if not indices or not quality_names or not qualities:
        return None, []

    out_qualities = []
    out_names = []
    for qname, qarr in zip(quality_names, qualities):
        if not qarr:
            continue
        values = [int(qarr[i]) if i < len(qarr) else 0 for i in indices]
        out_names.append(str(qname))
        out_qualities.append(values)

    return (out_qualities if out_qualities else None), out_names


def infer_legacy_layers_from_intervals(
    intervals,
    *,
    quality_names=None,
    qualities=None,
    nuc_min_size: int = 90,
    infer_tf: bool = True,
    infer_nuc: bool = True,
    infer_msp: bool = True,
) -> Dict[str, Dict]:
    """Infer canonical layers from legacy footprint intervals.

    Legacy BAM/BigBed payloads store one primary footprint stream. We split it
    into TF-sized footprints (< cutoff), nucleosomes (>= cutoff), and MSP/FIRE
    intervals as any inter-footprint gap whose two flanking footprints are both
    nucleosome-sized.
    """
    cutoff = max(1, int(nuc_min_size or 90))
    tf_intervals = []
    tf_indices: list[int] = []
    nuc_intervals = []
    nuc_indices: list[int] = []
    footprint_index = 0

    for iv in intervals or []:
        if len(iv) < 3 or iv[2] <= 0:
            continue
        if iv[2] >= cutoff:
            nuc_intervals.append(iv)
            nuc_indices.append(footprint_index)
        else:
            tf_intervals.append(iv)
            tf_indices.append(footprint_index)
        footprint_index += 1

    layers: Dict[str, Dict] = {}
    if infer_tf and tf_intervals:
        tf_qualities, tf_qnames = _split_quality_payload(tf_indices, quality_names, qualities)
        layers["tf"] = {
            "intervals": tf_intervals,
            "qualities": tf_qualities,
            "quality_names": tf_qnames,
        }
    if infer_nuc and nuc_intervals:
        nuc_qualities, nuc_qnames = _split_quality_payload(nuc_indices, quality_names, qualities)
        layers["nuc"] = {
            "intervals": nuc_intervals,
            "qualities": nuc_qualities,
            "quality_names": nuc_qnames,
        }
    if infer_msp:
        msp_intervals = generate_msp_from_nuc_gaps(intervals or [], min_nuc_size=cutoff)
        if msp_intervals:
            layers["msp"] = {
                "intervals": msp_intervals,
                "qualities": None,
                "quality_names": [],
            }

    return layers


def build_legacy_layers(intervals,
                        fp_quality_list, lq_quality_list, rq_quality_list,
                        fire_intervals,
                        region_start: int, region_end: int,
                        *,
                        infer_layers: bool = True,
                        nuc_min_size: int = 90,
                        include_qualities: bool = True,
                        infer_tf: bool = True,
                        infer_nuc: bool = True,
                        infer_msp: bool = True,
                        fire_sizes=None,
                        fire_qualities_available=None) -> Dict[str, Dict]:
    """Build layers dict from legacy tag-convention data."""
    _ = (region_start, region_end)
    layers: Dict[str, Dict] = {}

    if infer_layers:
        quality_names = []
        qualities = []
        if include_qualities and fp_quality_list:
            quality_names.append("nq")
            qualities.append(fp_quality_list)
        if include_qualities and lq_quality_list:
            quality_names.append("lq")
            qualities.append(lq_quality_list)
        if include_qualities and rq_quality_list:
            quality_names.append("rq")
            qualities.append(rq_quality_list)
        layers.update(
            infer_legacy_layers_from_intervals(
                intervals,
                quality_names=quality_names,
                qualities=qualities,
                nuc_min_size=nuc_min_size,
                infer_tf=infer_tf,
                infer_nuc=infer_nuc,
                infer_msp=infer_msp,
            )
        )

    if fire_intervals:
        has_qual = include_qualities and (
            any(iv[2] not in (0, 128) for iv in fire_intervals)
            if fire_qualities_available is None else fire_qualities_available
        )
        # Explicit as/al/aq accessibility tags win over inferred nucleosome gaps.
        layers["msp"] = {
            "intervals": [[iv[0], iv[1], fire_sizes[i] if fire_sizes is not None else iv[1] - iv[0]]
                          for i, iv in enumerate(fire_intervals)],
            "qualities": [[iv[2] for iv in fire_intervals]] if has_qual else None,
            "quality_names": ["aq"] if has_qual else [],
        }

    return layers
