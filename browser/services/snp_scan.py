"""SNPs and SNP combinations in a view (the Variants panel).

Pure functions over pysam records, so the endpoint, the tests and scratch
scripts share them:

- ``pileup(records, ...)``: allele counts per position in ``[start, end)``,
  per strand class (alignment strand x DAF conversion direction), with small
  insertions and deletions counted at their anchor, base quality and mapping
  quality filters, and each read's HP tag.
- ``call_snps(pile, ...)``: candidate SNVs and small indels (minor-allele
  fraction, depth, strand presence) and, on DAF data, which calls are
  DAF-safe.
- ``read_alleles(records, candidates, ...)``: each read's allele at the
  candidate positions (a compact matrix).
- ``combinations(...)``: reads grouped by their allele string at selected
  SNPs (local read-supported allele patterns, not a phasing), rare strings
  merged into "Other", two complementary patterns labelled H1 / H2 (local
  labels) when they look diploid, or grouped by HP tag.

DAF-seq (DddA / DddB) deaminates C to T on one strand of each molecule (G to A
read on the other): on the deaminated strand those changes look like SNPs.
The DAF-safe rule is FiberHMM's ``bidirectional_five_fiber_v1``
(fiberhmm/daf/snps.py ``call_opposite_conversion_snps``), re-implemented here
on view-local counts so FiberBrowser does not need FiberHMM for it: a read's
conversion direction is CT or GA when at least ``DAF_MIN_EVENTS`` of its
C->T / G->A changes go that way at ``DAF_MIN_PURITY``; a C/T or G/A SNP is
DAF-safe when its minor allele shows in both direction classes (depth,
supporting reads and fraction each at least the policy's), so it is also seen
on the strand that cannot deaminate that base. Deamination varies from read to
read and from site to site; a deamination "SNP" is confined to one direction
class, which is what the rule rejects.
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

import numpy as np

# Base codes in the pileup: A C G T, N (low quality / ambiguous), deletion.
A, C, G, T, N, DEL = 0, 1, 2, 3, 4, 5
NCODES = 6
BASES = "ACGTN-"
MISSING = 255
# Per-read allele codes for indel candidates.
HAS_EVENT = 6
NO_EVENT = 7

# FiberHMM bidirectional_five_fiber_v1 (fiberhmm/daf/snps.py).
DAF_POLICY = "bidirectional_five_fiber_v1"
DAF_MIN_EVENTS = 5
DAF_MIN_PURITY = 0.80
DAF_MIN_DEPTH = 5
DAF_MIN_ALT_READS = 5
DAF_MIN_FRACTION = 0.20

# Strand classes: alignment strand (0 forward, 1 reverse) x conversion direction (0 CT, 1 GA, 2 none).
DIR_CT, DIR_GA, DIR_NONE = 0, 1, 2
NCLASSES = 6

_LUT = np.full(256, N, dtype=np.uint8)
for _i, _b in enumerate("ACGT"):
    _LUT[ord(_b)] = _i
    _LUT[ord(_b.lower())] = _i
# DAF encoders may write a deaminated C as Y and a deaminated G as R: FiberHMM
# counts them as the conversion (T, A), and so do we.
_LUT[ord("Y")] = T
_LUT[ord("y")] = T
_LUT[ord("R")] = A
_LUT[ord("r")] = A


def encode(seq: str) -> np.ndarray:
    return _LUT[np.frombuffer(seq.encode("ascii", "replace"), dtype=np.uint8)]


def class_index(reverse: bool, direction: int) -> int:
    return direction * 2 + (1 if reverse else 0)


def dominant_direction(ct: int, ga: int, min_events: int = DAF_MIN_EVENTS,
                       min_purity: float = DAF_MIN_PURITY) -> int:
    """FiberHMM's ``_dominant_direction``: CT, GA or none."""
    total = ct + ga
    if total == 0:
        return DIR_NONE
    if ct >= min_events and ct / total >= min_purity:
        return DIR_CT
    if ga >= min_events and ga / total >= min_purity:
        return DIR_GA
    return DIR_NONE


@dataclass
class ReadWalk:
    """One read's aligned positions inside the window."""
    qi: np.ndarray            # query indices of aligned (M/=/X) bases in the window
    ri: np.ndarray            # their window offsets (sorted)
    dels: list                # (window offset start, end, length, reference start) of deletions overlapping the window
    ins: list                 # (anchor reference position, length): insertion after the anchor base
    span: tuple               # (first, last + 1) window offsets the read covers
    skips: list = field(default_factory=list)   # (window offset start, end) of reference skips (CIGAR N)


def walk(read, start: int, end: int) -> Optional[ReadWalk]:
    cigar = read.cigartuples
    if not cigar:
        return None
    rp = int(read.reference_start)
    qp = 0
    qs, rs, dels, ins, skips = [], [], [], [], []
    for op, n in cigar:
        if op in (0, 7, 8):
            a, b = max(rp, start), min(rp + n, end)
            if b > a:
                qs.append(np.arange(qp + a - rp, qp + b - rp, dtype=np.int64))
                rs.append(np.arange(a - start, b - start, dtype=np.int64))
            rp += n
            qp += n
        elif op == 1:
            if start <= rp - 1 < end:
                ins.append((rp - 1, n))
            qp += n
        elif op == 4:
            qp += n
        elif op == 2:
            a, b = max(rp, start), min(rp + n, end)
            if b > a:
                dels.append((a - start, b - start, n, rp))
            rp += n
        elif op == 3:
            a, b = max(rp, start), min(rp + n, end)
            if b > a:
                skips.append((a - start, b - start))
            rp += n
        if rp > end:
            break
    first = max(int(read.reference_start), start) - start
    last = min(int(read.reference_end or rp), end) - start
    if last <= first:
        return None
    qi = np.concatenate(qs) if qs else np.zeros(0, dtype=np.int64)
    ri = np.concatenate(rs) if rs else np.zeros(0, dtype=np.int64)
    return ReadWalk(qi=qi, ri=ri, dels=dels, ins=ins, span=(first, last), skips=skips)


def keep_record(read, min_mapq: int, include_duplicates: bool) -> bool:
    if read.is_unmapped or read.is_secondary or read.is_supplementary:
        return False
    if read.is_duplicate and not include_duplicates:
        return False
    return int(read.mapping_quality) >= min_mapq


def read_bases(read, w: ReadWalk, min_bq: int) -> Optional[np.ndarray]:
    seq = read.query_sequence
    if not seq:
        return None
    codes = encode(seq)
    bases = codes[w.qi] if w.qi.size else np.zeros(0, dtype=np.uint8)
    if min_bq > 0:
        quals = read.query_qualities
        if quals is not None and len(quals) == len(codes) and w.qi.size:
            q = np.frombuffer(bytes(quals), dtype=np.uint8) if not isinstance(quals, np.ndarray) else quals
            bases = np.where(q[w.qi] < min_bq, N, bases).astype(np.uint8)
    return bases


@dataclass
class ReadDiff:
    """A read's differences from the reference inside the window (window offsets)."""
    name: str
    reverse: bool
    hp: Optional[str]
    span: tuple
    pos: np.ndarray          # offsets where its base differs from the reference (N: low quality)
    base: np.ndarray         # its base there
    dels: list               # (offset start, offset end, reference start, length)
    ins: list                # (anchor, length) of its insertions
    skips: list = field(default_factory=list)   # (offset start, end): reference skips (CIGAR N), not covered


@dataclass
class Pileup:
    chrom: str
    start: int
    end: int
    counts: np.ndarray                 # (NCLASSES, NCODES, W) int32
    # Small indels, one allele per (reference position, 'ins' | 'del', length): reads per strand class
    # (an insertion is anchored at the base before it, a deletion at its first deleted base).
    indel_events: dict
    ref: Optional[np.ndarray]          # (W,) codes of the reference, or None
    n_reads: int = 0
    directions: Counter = field(default_factory=Counter)
    hp: Counter = field(default_factory=Counter)
    cancelled: bool = False
    # Per read (with a reference only): how it differs from the reference in the window, so its alleles at any
    # position can be read back without the BAM (``alleles_from_pileup``).
    reads: Optional[list] = None

    @property
    def width(self) -> int:
        return self.end - self.start


def pileup(records: Iterable, chrom: str, start: int, end: int, *, ref: Optional[np.ndarray] = None,
           min_bq: int = 20, min_mapq: int = 0, max_indel: int = 30, include_duplicates: bool = False,
           cancelled: Optional[Callable[[], bool]] = None) -> Pileup:
    """Allele counts per position, strand class and base over ``[start, end)``.

    ``records``: pysam records (or tuples whose first item is one). ``ref``:
    the window's reference as codes (``encode``), needed for DAF conversion
    directions; without it every read's direction is 'none'.
    """
    width = end - start
    acc = np.zeros(NCLASSES * NCODES * width, dtype=np.int64)
    events: dict = {}
    pile = Pileup(chrom, start, end, np.zeros(0), events, ref, reads=[] if ref is not None else None)
    seen: set = set()
    buf: list = []
    buffered = 0
    for n, item in enumerate(records):
        read = item[0] if isinstance(item, tuple) else item
        if cancelled is not None and n % 200 == 0 and cancelled():
            pile.cancelled = True
            break
        if not keep_record(read, min_mapq, include_duplicates):
            continue
        name = read.query_name
        if name in seen:
            continue
        w = walk(read, start, end)
        if w is None:
            continue
        bases = read_bases(read, w, min_bq)
        if bases is None:
            continue
        seen.add(name)
        direction = DIR_NONE
        if ref is not None and bases.size:
            rc = ref[w.ri]
            ct = int(np.count_nonzero((rc == C) & (bases == T)))
            ga = int(np.count_nonzero((rc == G) & (bases == A)))
            direction = dominant_direction(ct, ga)
        cls = class_index(read.is_reverse, direction)
        pile.directions[direction] += 1
        hp = str(read.get_tag("HP")) if read.has_tag("HP") else None
        pile.hp[hp if hp is not None else "untagged"] += 1
        if pile.reads is not None:
            diff = np.flatnonzero(bases != ref[w.ri]) if bases.size else np.zeros(0, dtype=np.int64)
            pile.reads.append(ReadDiff(name, bool(read.is_reverse), hp, w.span, w.ri[diff].astype(np.int32),
                                       bases[diff].copy(), [(a, b, r, length) for a, b, length, r in w.dels],
                                       list(w.ins), list(w.skips)))
        base = cls * NCODES
        if bases.size:
            buf.append((base + bases.astype(np.int64)) * width + w.ri)
            buffered += bases.size
        for a, b, length, rstart in w.dels:
            buf.append(np.arange(a, b, dtype=np.int64) + (base + DEL) * width)
            buffered += b - a
            if length <= max_indel and start <= rstart < end:
                events.setdefault((rstart, "del", length), np.zeros(NCLASSES, dtype=np.int32))[cls] += 1
        for anchor, length in w.ins:
            if length <= max_indel:
                events.setdefault((anchor, "ins", length), np.zeros(NCLASSES, dtype=np.int32))[cls] += 1
        pile.n_reads += 1
        if buffered > 4_000_000:
            acc += np.bincount(np.concatenate(buf), minlength=acc.size)
            buf, buffered = [], 0
    if buf:
        acc += np.bincount(np.concatenate(buf), minlength=acc.size)
    pile.counts = acc.reshape(NCLASSES, NCODES, width).astype(np.int32)
    return pile


# ---------------------------------------------------------------------------
# Calling

_FWD = [0, 2, 4]
_REV = [1, 3, 5]
_CT = [0, 1]
_GA = [2, 3]


def _strand_groups(mode: str) -> dict[str, list[int]]:
    return {"CT": _CT, "GA": _GA} if mode == "daf" else {"fwd": _FWD, "rev": _REV}


def detect_mode(pile: Pileup, chemistry: Optional[str]) -> str:
    """'daf' for DddA/DddB data (declared, or most reads carry one conversion
    direction), else 'basecall'."""
    chem = (chemistry or "").lower()
    if chem in ("ddda", "dddb"):
        return "daf"
    if chem.startswith("hia5"):
        return "basecall"
    total = sum(pile.directions.values())
    directional = pile.directions.get(DIR_CT, 0) + pile.directions.get(DIR_GA, 0)
    return "daf" if total >= 10 and directional / total >= 0.5 else "basecall"


def daf_verdict(alleles: tuple[str, str], product_by_dir: dict[str, dict], min_fraction: float = DAF_MIN_FRACTION) -> tuple[bool, str]:
    """FiberHMM's bidirectional rule for one SNV (its two alleles).

    Deamination only makes T from C (read on CT-direction reads) and A from G (GA reads). For a C/T or G/A SNP the
    deamination product (T, A) must also be seen on the direction that cannot make it, and on the other:
    ``product_by_dir`` = {'CT': {'depth', 'product'}, 'GA': {...}}, the product allele's reads in each direction
    class; each needs depth >= 5, product reads >= 5 and fraction >= 0.20 (``min_fraction`` is accepted for callers
    and not used: the policy's threshold is FiberHMM's).
    """
    pair = set(alleles)
    if pair not in ({"C", "T"}, {"G", "A"}):
        return True, "Not a C>T / G>A change: deamination cannot make it."
    product = "T" if pair == {"C", "T"} else "A"
    clean = "GA" if product == "T" else "CT"
    deam = "CT" if clean == "GA" else "GA"
    frac = DAF_MIN_FRACTION   # FiberHMM's, whatever the discovery MAF
    failures = []
    only_fraction = True      # seen on both directions (5+ reads), but under 20% on one
    for direction in (clean, deam):
        c = product_by_dir.get(direction, {"depth": 0, "product": 0})
        depth, n = int(c["depth"]), int(c["product"])
        f = n / depth if depth else 0.0
        if depth < DAF_MIN_DEPTH or n < DAF_MIN_ALT_READS or f < frac:
            failures.append(f"{product} on {n}/{depth} {direction} reads")
            only_fraction = only_fraction and depth >= DAF_MIN_DEPTH and n >= DAF_MIN_ALT_READS
    pretty = "C>T" if product == "T" else "G>A"
    if not failures:
        return True, (f"{pretty}: {product} on both conversion directions, also on the {clean} strand, which cannot "
                      f"make it by deamination ({DAF_POLICY}).")
    if only_fraction:
        return False, (f"{pretty}: {'; '.join(failures)}: on both conversion directions but under the policy's "
                       f"{frac:.0%} on each (a rare allele, or deamination; {DAF_POLICY}).")
    return False, (f"{pretty}: {'; '.join(failures)} (needs {DAF_MIN_ALT_READS}+ reads and {frac:.0%} on each): "
                   f"looks like deamination on the {deam} strand ({DAF_POLICY}).")


def call_snps(pile: Pileup, *, min_maf: float = 0.1, min_depth: int = 20, both_strands: bool = True,
              mode: str = "basecall", min_strand_reads: int = 2, max_calls: int = 2000) -> dict:
    """Candidate SNVs and small indels; each with its counts and flags.

    MAF is the minor (second most common) allele's fraction of the reads that
    call a base or a deletion there, so a site where the sample differs from
    the reference on every read is "fixed", not informative.
    """
    counts = pile.counts
    tot = counts.sum(axis=0)                      # (NCODES, W)
    acgt = tot[:4]
    depth = acgt.sum(axis=0) + tot[DEL]
    order = np.argsort(-acgt, axis=0, kind="stable")
    major, minor = order[0], order[1]
    cols = np.arange(pile.width)
    major_n = acgt[major, cols]
    minor_n = acgt[minor, cols]
    safe_depth = np.maximum(depth, 1)
    maf = minor_n / safe_depth
    groups = _strand_groups(mode)
    ref = pile.ref
    covered = depth[depth > 0]
    median_depth = float(np.median(covered)) if covered.size else 0.0
    fixed = 0
    if ref is not None:
        fixed = int(np.count_nonzero((ref < 4) & (major != ref) & (major_n / safe_depth >= 1 - min_maf)
                                     & (depth >= min_depth)))
    snps = []
    sites = np.flatnonzero((depth >= min_depth) & (maf >= min_maf) & (minor_n > 0))
    for i in sites.tolist():
        a1, a2 = int(major[i]), int(minor[i])
        strand = {}
        for name, cls in groups.items():
            d = int(counts[cls][:, :4, i].sum() + counts[cls][:, DEL, i].sum())
            strand[name] = {"depth": d, "minor": int(counts[cls][:, a2, i].sum()), "major": int(counts[cls][:, a1, i].sum())}
        product = {}
        if mode == "daf":
            prod = T if {a1, a2} == {C, T} else A
            for name, cls in (("CT", _CT), ("GA", _GA)):
                product[name] = {"depth": int(counts[cls][:, :4, i].sum() + counts[cls][:, DEL, i].sum()),
                                 "product": int(counts[cls][:, prod, i].sum())}
        snps.append(_snp_entry(pile, i, "snv", (BASES[a1], BASES[a2]), int(depth[i]),
                               {BASES[b]: int(acgt[b, i]) for b in range(4) if acgt[b, i]} | ({"-": int(tot[DEL, i])} if tot[DEL, i] else {}),
                               int(minor_n[i]), strand, mode, min_maf, both_strands, min_strand_reads, median_depth,
                               product=product))
    # Indels: one allele per (position, kind, length); every read covering the anchor counts (low-quality bases
    # too: indels sit next to them). Another indel at the same anchor is neither this allele nor the reference.
    depth_all = depth + tot[N]
    for (p, kind, length), by_class in sorted(pile.indel_events.items()):
        i = p - pile.start
        if not (0 <= i < pile.width):
            continue
        d_i = int(depth_all[i])
        if d_i < min_depth or d_i == 0:
            continue
        n_event = min(int(by_class.sum()), d_i)
        if n_event == 0:
            continue
        if (d_i - n_event) / d_i < min_maf:
            fixed += 1          # (nearly) every read has it
            continue
        if min(n_event, d_i - n_event) / d_i < min_maf:
            continue
        event_minor = n_event <= d_i - n_event
        strand = {}
        for name, cls in groups.items():
            d = int(counts[cls][:, :, i].sum())
            ev = min(int(by_class[cls].sum()), d)
            strand[name] = {"depth": d, "minor": ev if event_minor else d - ev, "major": d - ev if event_minor else ev}
        label = f"+{length}" if kind == "ins" else f"-{length}"
        alleles = ("ref", label) if event_minor else (label, "ref")
        snps.append(_snp_entry(pile, i, kind, alleles, d_i, {"ref": d_i - n_event, label: n_event},
                               min(n_event, d_i - n_event), strand, mode, min_maf, both_strands,
                               min_strand_reads, median_depth, length=length, event=n_event))
    snps.sort(key=lambda s: (s["pos"], s["kind"]))
    if len(snps) > max_calls:
        keep = sorted(snps, key=lambda s: -s["maf"] * s["depth"])[:max_calls]
        snps = sorted(keep, key=lambda s: (s["pos"], s["kind"]))
    return {"snps": snps, "fixed": fixed, "median_depth": median_depth, "mode": mode}


def _snp_entry(pile: Pileup, i: int, kind: str, alleles: tuple, depth: int, counts: dict, minor_n: int,
               strand: dict, mode: str, min_maf: float, both_strands: bool, min_strand_reads: int,
               median_depth: float, length: int = 0, event: int = 0, product: Optional[dict] = None) -> dict:
    pos = pile.start + i
    ref_base = BASES[int(pile.ref[i])] if pile.ref is not None and pile.ref[i] < 4 else None
    if kind == "snv":
        if ref_base is not None and ref_base in alleles:
            alt = alleles[1] if alleles[0] == ref_base else alleles[0]
        else:
            alt = alleles[1]
    else:
        alt = alleles[0] if alleles[0] != "ref" else alleles[1]
    names = list(strand)
    present = all(strand[n]["minor"] >= min_strand_reads for n in names)
    m0, m1 = (strand[names[0]]["minor"], strand[names[1]]["minor"])
    balance = m0 / (m0 + m1) if (m0 + m1) else None
    daf_safe: Optional[bool] = None
    daf_reason = "Not DAF data: basecalls are used as they are." if mode != "daf" else ""
    if mode == "daf":
        if kind != "snv":
            daf_safe, daf_reason = True, "An indel: deamination cannot make it."
        elif pile.ref is None:
            daf_safe, daf_reason = None, "No reference: the reads' conversion directions are unknown."
        else:
            daf_safe, daf_reason = daf_verdict(alleles, product, min_maf)
    low_depth = depth < 0.5 * median_depth
    # DAF data: a call passes only when it is known to be DAF-safe (no reference: directions unknown, not safe).
    passes = (present or not both_strands) and (daf_safe is True if mode == "daf" else True)
    sid = f"{pos}:{kind}:{alleles[0]}/{alleles[1]}"
    return {
        "id": sid, "pos": pos, "kind": kind, "ref": ref_base, "alleles": list(alleles), "alt": alt,
        "length": length, "depth": depth, "counts": counts, "minor": minor_n,
        "maf": round(minor_n / depth, 4) if depth else 0.0,
        "strands": strand, "strand_balance": None if balance is None else round(balance, 3),
        "both_strands": present, "daf_safe": daf_safe, "daf_reason": daf_reason,
        "low_depth": bool(low_depth), "passes": bool(passes),
    }


# ---------------------------------------------------------------------------
# Per-read alleles

@dataclass
class AlleleMatrix:
    names: list
    codes: np.ndarray        # (reads, candidates) uint8
    reverse: np.ndarray      # (reads,) bool
    hp: list                 # per read: HP tag as str, or None
    positions: list          # candidate positions
    kinds: list              # 'snv' | 'ins' | 'del'
    ids: list                # candidate ids
    cancelled: bool = False


def read_alleles(records: Iterable, chrom: str, start: int, end: int, candidates: list[dict], *,
                 min_bq: int = 20, min_mapq: int = 0, include_duplicates: bool = False,
                 cancelled: Optional[Callable[[], bool]] = None) -> AlleleMatrix:
    """Each read's allele code at each candidate (``MISSING`` where it does not cover it)."""
    pos = np.array([c["pos"] for c in candidates], dtype=np.int64)
    kinds = [c["kind"] for c in candidates]
    snv = np.array([k == "snv" for k in kinds], dtype=bool)
    offs = pos - start
    order = np.argsort(offs, kind="stable")
    sorted_offs = offs[order]
    names, rows, rev, hps = [], [], [], []
    seen: set = set()
    stopped = False
    indel_cols = [j for j, k in enumerate(kinds) if k != "snv"]
    lengths = [int(c.get("length") or 0) for c in candidates]
    for n, item in enumerate(records):
        read = item[0] if isinstance(item, tuple) else item
        if cancelled is not None and n % 200 == 0 and cancelled():
            stopped = True
            break
        if not keep_record(read, min_mapq, include_duplicates):
            continue
        if read.query_name in seen:
            continue
        w = walk(read, start, end)
        if w is None:
            continue
        bases = read_bases(read, w, min_bq)
        if bases is None:
            continue
        seen.add(read.query_name)
        row = np.full(len(candidates), MISSING, dtype=np.uint8)
        lo, hi = w.span
        inside = (offs >= lo) & (offs < hi)
        if w.ri.size and snv.any():
            k = np.searchsorted(w.ri, sorted_offs)
            k2 = np.minimum(k, w.ri.size - 1)
            hit = (w.ri[k2] == sorted_offs)
            cols = order[hit]
            row[cols] = bases[k2[hit]]
        for a, b, _length, _r in w.dels:
            row[order[(sorted_offs >= a) & (sorted_offs < b)]] = DEL
        if indel_cols:
            events = _read_events(w.ins, [(r, length) for _a, _b, length, r in w.dels])
            for j in indel_cols:
                if inside[j]:
                    row[j] = _indel_code(events, kinds[j], int(pos[j]), lengths[j])
        for a, b in w.skips:
            row[(offs >= a) & (offs < b)] = MISSING
        # an SNV inside the read's span but not aligned (inside an insertion-free gap such as N): stays missing
        names.append(read.query_name)
        rows.append(row)
        rev.append(bool(read.is_reverse))
        hps.append(str(read.get_tag("HP")) if read.has_tag("HP") else None)
    codes = np.vstack(rows) if rows else np.zeros((0, len(candidates)), dtype=np.uint8)
    return AlleleMatrix(names, codes, np.array(rev, dtype=bool), hps, pos.tolist(), kinds,
                        [c["id"] for c in candidates], cancelled=stopped)


def _read_events(ins: list, dels: list) -> dict:
    """{(kind, anchor): {lengths}} of a read's insertions and deletions."""
    out: dict = {}
    for anchor, length in ins:
        out.setdefault(("ins", anchor), set()).add(int(length))
    for rstart, length in dels:
        out.setdefault(("del", rstart), set()).add(int(length))
    return out


def _indel_code(events: dict, kind: str, pos: int, length: int) -> int:
    """This indel allele, the reference, or another indel at the same anchor (N: neither allele)."""
    here = events.get((kind, pos))
    if not here:
        return NO_EVENT
    return HAS_EVENT if length in here else N


def alleles_from_pileup(pile: Pileup, candidates: list[dict]) -> AlleleMatrix:
    """``read_alleles`` without reading the BAM again: from the reads' differences kept by ``pileup`` (needs the
    reference). A covered position where a read has no difference has the reference base."""
    if pile.reads is None or pile.ref is None:
        raise ValueError("the pileup kept no per-read differences (no reference)")
    start = pile.start
    pos = np.array([c["pos"] for c in candidates], dtype=np.int64)
    kinds = [c["kind"] for c in candidates]
    offs = pos - start
    snv_cols = np.array([j for j, k in enumerate(kinds) if k == "snv"], dtype=np.int64)
    indel_cols = [j for j, k in enumerate(kinds) if k != "snv"]
    lengths = [int(c.get("length") or 0) for c in candidates]
    ref_at = np.where((offs >= 0) & (offs < pile.width), pile.ref[np.clip(offs, 0, max(0, pile.width - 1))], N)
    codes = np.full((len(pile.reads), len(candidates)), MISSING, dtype=np.uint8)
    for r, rd in enumerate(pile.reads):
        lo, hi = rd.span
        inside = (offs >= lo) & (offs < hi)
        row = codes[r]
        if snv_cols.size:
            cols = snv_cols[inside[snv_cols]]
            row[cols] = ref_at[cols]
            if rd.pos.size and cols.size:
                k = np.searchsorted(rd.pos, offs[cols])
                k2 = np.minimum(k, rd.pos.size - 1)
                hit = rd.pos[k2] == offs[cols]
                row[cols[hit]] = rd.base[k2[hit]]
            for a, b, _r, _l in rd.dels:
                row[cols[(offs[cols] >= a) & (offs[cols] < b)]] = DEL
        if indel_cols:
            events = _read_events(rd.ins, [(rstart, length) for _a, _b, rstart, length in rd.dels])
            for j in indel_cols:
                if inside[j]:
                    row[j] = _indel_code(events, kinds[j], int(pos[j]), lengths[j])
        for a, b in rd.skips:
            row[(offs >= a) & (offs < b)] = MISSING
    return AlleleMatrix([rd.name for rd in pile.reads], codes, np.array([rd.reverse for rd in pile.reads], dtype=bool),
                        [rd.hp for rd in pile.reads], pos.tolist(), kinds, [c["id"] for c in candidates])


def allele_letters(matrix: AlleleMatrix, candidates: list[dict], cols: list[int]) -> list[list[Optional[str]]]:
    """Per read, the allele at each column: one of the SNP's two alleles, 'x' (another base, N or a
    deletion) or None (not covered)."""
    out = []
    lookup = []
    for j in cols:
        cand = candidates[j]
        if cand["kind"] == "snv":
            lookup.append(("snv", {BASES.index(a): a for a in cand["alleles"] if a in "ACGT"}))
        else:
            label = cand["alleles"][0] if cand["alleles"][0] != "ref" else cand["alleles"][1]
            lookup.append(("indel", {HAS_EVENT: label, NO_EVENT: "ref"}))
    for row in matrix.codes:
        letters = []
        for (kind, table), j in zip(lookup, cols):
            code = int(row[j])
            if code == MISSING:
                letters.append(None)
            else:
                letters.append(table.get(code, "x"))
        out.append(letters)
    return out


# ---------------------------------------------------------------------------
# Combinations

def informative_columns(candidates: list[dict], median_depth: float, *, min_depth_fraction: float = 0.5,
                        include_indels: bool = False) -> list[int]:
    """Columns of the SNPs that pass their filters and have at least ``min_depth_fraction`` of the median depth
    (a SNP at a breakpoint or in a repeat few reads cover would leave no read covering every SNP)."""
    floor = min_depth_fraction * median_depth
    return [j for j, c in enumerate(candidates) if c.get("passes", True) and c["depth"] >= floor
            and (include_indels or c["kind"] == "snv")]


def ld_tags(matrix: AlleleMatrix, candidates: list[dict], cols: list[int], *, r2_min: float = 0.8,
            min_pair_reads: int = 20) -> tuple[list[int], dict[int, list[int]]]:
    """Linked SNPs collapsed to one tag each: greedy, deepest SNP first, every SNP with r^2 >= ``r2_min``
    to it (on reads covering both) joins its block. Returns (tags in position order, tag -> members)."""
    if not cols:
        return [], {}
    letters = allele_letters(matrix, candidates, cols)
    X = np.full((len(letters), len(cols)), -1, dtype=np.int8)
    for r, row in enumerate(letters):
        for k, (j, a) in enumerate(zip(cols, row)):
            if a is None or a == "x":
                continue
            X[r, k] = 0 if a == candidates[j]["alleles"][0] else 1
    valid = X >= 0
    order = sorted(range(len(cols)), key=lambda k: -int(valid[:, k].sum()))
    block = [-1] * len(cols)
    tags: list[int] = []
    members: dict[int, list[int]] = {}
    for k in order:
        if block[k] >= 0:
            continue
        block[k] = k
        tags.append(k)
        members[k] = [k]
        for m in range(len(cols)):
            if block[m] >= 0:
                continue
            both = valid[:, k] & valid[:, m]
            if int(both.sum()) < min_pair_reads:
                continue
            a = X[both, k].astype(float)
            b = X[both, m].astype(float)
            if a.std() == 0 or b.std() == 0:
                continue
            r = float(np.corrcoef(a, b)[0, 1])
            if r * r >= r2_min:
                block[m] = k
                members[k].append(m)
    tag_cols = sorted((cols[k] for k in tags), key=lambda j: candidates[j]["pos"])
    by_col = {cols[k]: sorted((cols[m] for m in members[k]), key=lambda j: candidates[j]["pos"]) for k in tags}
    return tag_cols, by_col


def combinations(matrix: AlleleMatrix, candidates: list[dict], cols: list[int], *, partial: bool = False,
                 min_fraction: float = 0.02, min_reads: int = 3, auto_phase: bool = True,
                 max_mismatch: float = 0.1) -> dict:
    """Reads grouped by their allele string at ``cols``.

    Without ``partial``: complete reads (one of the SNP's two alleles at
    every column) form the combinations; reads missing any column are "Not
    informative". With ``partial``, long reads seldom span every SNP of a
    wide view, so the combinations are assembled from overlapping reads
    (``assemble``): reads with the most SNPs first, each joining the one
    combination it agrees with where both have alleles (up to
    ``max_mismatch`` of the shared SNPs differ: sequencing errors), else
    starting one; a read that agrees with several is placed at the end if
    only one of the kept combinations fits, else it is "Not informative".
    Combinations below ``max(min_reads, min_fraction x placed reads)`` merge
    into "Other".
    """
    letters = allele_letters(matrix, candidates, cols)
    k = len(cols)
    complete = Counter()
    for row in letters:
        if all(a is not None and a != "x" for a in row):
            complete[tuple(row)] += 1
    n_complete = sum(complete.values())
    if partial:
        combos, member = assemble(letters, max_mismatch=max_mismatch)
    else:
        combos = [list(c) for c, _n in complete.most_common()]
        index0 = {tuple(c): g for g, c in enumerate(combos)}
        member = [index0[tuple(r)] if all(a is not None and a != "x" for a in r) else -1 for r in letters]
    sizes0 = Counter(g for g in member if g >= 0)
    placed = sum(sizes0.values())
    threshold = max(int(min_reads), int(math.ceil(min_fraction * placed)))
    kept_ids = [g for g, n in sorted(sizes0.items(), key=lambda kv: (-kv[1], kv[0])) if n >= threshold]
    phase = None
    if auto_phase and k >= 2:
        phase = _phase([combos[g] for g in kept_ids], [sizes0[g] for g in kept_ids], placed)
    new_id = {g: i for i, g in enumerate(kept_ids)}
    other_id, ni_id = len(kept_ids), len(kept_ids) + 1
    if phase and phase["diploid"]:
        # Two haplotypes: every other read joins the one it agrees with (if only one), else Other.
        haps = [combos[kept_ids[0]], combos[kept_ids[1]]]
        new_id = {kept_ids[0]: 0, kept_ids[1]: 1}
        other_id, ni_id = 2, 3
    assignments: dict[str, int] = {}
    sizes = Counter()
    rescued = 0
    for name, row, g in zip(matrix.names, letters, member):
        observed = any(a is not None and a != "x" for a in row)
        if g >= 0 and g in new_id:
            gid = new_id[g]
        elif phase and phase["diploid"] and observed:
            fits = [h for h, hap in enumerate(haps) if _agrees(row, hap, max_mismatch)]
            gid = fits[0] if len(fits) == 1 else other_id
            rescued += len(fits) == 1
        elif g >= 0:
            gid = other_id
        else:
            gid = ni_id
        assignments[name] = gid
        sizes[gid] += 1
    diploid = bool(phase and phase.get("diploid"))
    groups = []
    for g, i in sorted(new_id.items(), key=lambda kv: kv[1]):
        combo = combos[g]
        key = "-".join(a if a is not None else "?" for a in combo)
        label = f"H{i + 1} {key}" if diploid else key
        groups.append({"id": i, "key": key, "label": label, "alleles": [a for a in combo], "count": sizes[i],
                       "complete": complete.get(tuple(combo), 0), "kind": "combo"})
    merged = len([g for g in sizes0 if g not in new_id])
    groups.append({"id": other_id, "key": "other", "label": f"Other ({merged} rare)" if merged else "Other",
                   "alleles": [], "count": sizes[other_id], "kind": "other", "merged": merged})
    groups.append({"id": ni_id, "key": "not-informative", "label": "Not informative", "alleles": [],
                   "count": sizes[ni_id], "kind": "not-informative"})
    return {
        "groups": groups, "assignments": assignments, "n_reads": len(matrix.names), "covering": n_complete,
        "placed": placed, "partial": bool(partial), "threshold": threshold, "distinct": len(sizes0),
        "rescued": rescued, "snps": [candidates[j]["id"] for j in cols], "phase": phase,
    }


MINUS = "\u2212"


def genotype_groups(names: list, letters: list, columns: list[dict], *, partial: bool = False,
                    min_fraction: float = 0.02, min_reads: int = 3) -> dict:
    """Reads grouped by their genotype at SVs (and SNPs): each read's string of calls, e.g. ``roo+ hobo−
    jockey+``. ``columns``: per column ``{"id", "name", "kind": "sv" | "snv"}``; ``letters``: per read, per
    column: an SV's ``"+"`` (carrier), ``"-"`` (reference) or None (not informative), a SNP's base or None.

    Without ``partial`` only reads informative at every column are grouped; with it a read informative at
    some shows ``?`` at the others (its own pattern). Patterns under ``max(min_reads, min_fraction x
    grouped reads)`` merge into Other; reads informative nowhere (or, without partial, not everywhere) are
    Not informative. Same shape as ``combinations``."""
    def token(col: dict, a) -> str:
        if col["kind"] == "sv":
            return f"{col['name']}{'+' if a == '+' else MINUS if a == '-' else '?'}"
        return f"{col['name']} {a if a else '?'}"

    patterns: list = []
    for row in letters:
        clean = [a if a not in (None, "x") else None for a in row]
        if not any(a is not None for a in clean) or (not partial and any(a is None for a in clean)):
            patterns.append(None)
        else:
            patterns.append(tuple(a if a is not None else "?" for a in clean))
    sizes0 = Counter(p for p in patterns if p is not None)
    placed = sum(sizes0.values())
    threshold = max(int(min_reads), int(math.ceil(min_fraction * placed)))
    kept = [p for p, n in sorted(sizes0.items(), key=lambda kv: (-kv[1], kv[0])) if n >= threshold]
    new_id = {p: i for i, p in enumerate(kept)}
    other_id, ni_id = len(kept), len(kept) + 1
    assignments: dict[str, int] = {}
    sizes = Counter()
    for name, p in zip(names, patterns):
        gid = ni_id if p is None else new_id.get(p, other_id)
        assignments[name] = gid
        sizes[gid] += 1
    groups = []
    for p, i in new_id.items():
        groups.append({"id": i, "key": "-".join(p), "label": " \u00b7 ".join(token(c, None if a == "?" else a) for c, a in zip(columns, p)),
                       "alleles": [None if a == "?" else a for a in p], "count": sizes[i],
                       "complete": sizes[i] if "?" not in p else 0, "kind": "combo"})
    merged = len([p for p in sizes0 if p not in new_id])
    groups.append({"id": other_id, "key": "other", "label": f"Other ({merged} rare)" if merged else "Other",
                   "alleles": [], "count": sizes[other_id], "kind": "other", "merged": merged})
    groups.append({"id": ni_id, "key": "not-informative", "label": "Not informative", "alleles": [],
                   "count": sizes[ni_id], "kind": "not-informative"})
    complete = sum(n for p, n in sizes0.items() if "?" not in p)
    return {
        "groups": groups, "assignments": assignments, "n_reads": len(names), "covering": complete,
        "placed": placed, "partial": bool(partial), "threshold": threshold, "distinct": len(sizes0),
        "snps": [c["id"] for c in columns if c["kind"] != "sv"], "svs": [c["id"] for c in columns if c["kind"] == "sv"],
        "columns": [{"id": c["id"], "name": c["name"], "kind": c["kind"]} for c in columns], "phase": None,
    }


def _agrees(row, combo, max_mismatch: float) -> bool:
    shared = mismatch = 0
    for a, b in zip(row, combo):
        if a is None or a == "x" or b is None:
            continue
        shared += 1
        mismatch += a != b
    return shared > 0 and mismatch <= int(max_mismatch * shared)


def assemble(letters: list[list[Optional[str]]], *, max_mismatch: float = 0.1) -> tuple[list[list], list[int]]:
    """Combinations from reads that each cover some of the SNPs (greedy, reads with the most SNPs first).

    Returns (combinations: the majority allele per SNP, None where no member covers it; each read's
    combination index, -1 for reads with no allele or that fit several)."""
    k = len(letters[0]) if letters else 0
    alle: list[dict] = []
    obs = []
    for row in letters:
        vec = np.full(k, -1, dtype=np.int8)
        for j, a in enumerate(row):
            if a is None or a == "x":
                continue
            table = alle[j] if j < len(alle) else None
            if table is None:
                while len(alle) <= j:
                    alle.append({})
                table = alle[j]
            vec[j] = table.setdefault(a, len(table))
        obs.append(vec)
    width = max([len(t) for t in alle] + [2])
    counts: list[np.ndarray] = []       # per combination: (k, width) allele counts
    member = [-1] * len(letters)
    order = sorted(range(len(letters)), key=lambda r: -int((obs[r] >= 0).sum()))
    deferred = []
    cols = np.arange(k)
    for r in order:
        v = obs[r]
        seen = v >= 0
        if not seen.any():
            continue
        fits = []
        for g, c in enumerate(counts):
            cons = np.where(c.sum(axis=1) > 0, c.argmax(axis=1), -1)
            shared = seen & (cons >= 0)
            n = int(shared.sum())
            if n == 0:
                continue
            bad = int((cons[shared] != v[shared]).sum())
            if bad <= int(max_mismatch * n):
                fits.append((g, n))
        if not fits:
            c = np.zeros((k, width), dtype=np.int32)
            c[cols[seen], v[seen]] += 1
            counts.append(c)
            member[r] = len(counts) - 1
        elif len(fits) == 1:
            g = fits[0][0]
            counts[g][cols[seen], v[seen]] += 1
            member[r] = g
        else:
            deferred.append(r)
    sizes = Counter(g for g in member if g >= 0)
    for r in deferred:
        v = obs[r]
        seen = v >= 0
        fits = []
        for g, c in enumerate(counts):
            cons = np.where(c.sum(axis=1) > 0, c.argmax(axis=1), -1)
            shared = seen & (cons >= 0)
            n = int(shared.sum())
            if n and int((cons[shared] != v[shared]).sum()) <= int(max_mismatch * n):
                fits.append(g)
        # Several fit: the read only spans SNPs those combinations share. Joins the largest when it is the only
        # one of real size; else it stays unplaced.
        big = [g for g in fits if sizes[g] >= 3]
        if len(big) == 1:
            member[r] = big[0]
            sizes[big[0]] += 1
            counts[big[0]][cols[seen], v[seen]] += 1   # its alleles count towards the combination too
    names = [{i: a for a, i in t.items()} for t in alle] + [{}] * (k - len(alle))
    combos = []
    for c in counts:
        total = c.sum(axis=1)
        combos.append([names[j].get(int(c[j].argmax())) if total[j] > 0 else None for j in range(k)])
    return combos, member


def _phase(kept: list, sizes: list, placed: int) -> dict:
    """Two complementary combinations holding most placed reads look like the two alleles of a diploid here: labelled
    H1 / H2. Local labels (these SNPs, this view), not a phasing across loci."""
    if placed == 0 or len(kept) < 2:
        return {"diploid": False, "message": "Too few reads carry these SNPs to label two local patterns."}
    a, b = kept[0], kept[1]
    fa, fb = sizes[0] / placed, sizes[1] / placed
    complementary = all(x is not None and y is not None and x != y for x, y in zip(a, b))
    if complementary and fa + fb >= 0.8 and min(fa, fb) >= 0.15:
        return {"diploid": True,
                "message": (f"Looks diploid here: two complementary combinations hold {fa + fb:.0%} of the reads, so "
                            "they are labelled H1 and H2 (local labels for these SNPs in this view, not a phasing "
                            "across loci); other reads join the one they agree with.")}
    above = len(kept)
    # Which of the three criteria failed, each with its value (usability audit VAR-6).
    failed = []
    if not complementary:
        failed.append("the top two combinations are not complementary (they share an allele at some SNP)")
    if fa + fb < 0.8:
        failed.append(f"the top two hold {fa + fb:.0%} of the placed reads (needs at least 80%)")
    if min(fa, fb) < 0.15:
        failed.append(f"the smaller of the two holds {min(fa, fb):.0%} (needs at least 15%)")
    return {"diploid": False,
            "failed": failed,
            "message": (f"Not a two-haplotype pattern: {'; '.join(failed)}. "
                        f"{above} combination{'s' if above != 1 else ''} above the threshold, top two {fa:.0%} + {fb:.0%} "
                        "(a pooled or polyploid sample?). Grouped by combination (local read-supported patterns), "
                        "with no H1 / H2.")}


def single_snp_groups(matrix: AlleleMatrix, candidates: list[dict], col: int) -> dict:
    """One SNP: reference vs alternate allele (+ other, not informative)."""
    cand = candidates[col]
    letters = allele_letters(matrix, candidates, [col])
    if cand["kind"] == "snv":
        ref = cand.get("ref")
        a1, a2 = cand["alleles"]
        first = ref if ref in (a1, a2) else a1
        second = a2 if first == a1 else a1
        names = {first: f"{'ref' if first == ref else 'major'} {first}", second: f"alt {second}"}
    else:
        label = cand["alleles"][0] if cand["alleles"][0] != "ref" else cand["alleles"][1]
        first, second = "ref", label
        names = {"ref": "ref", label: f"alt {cand['kind']} {label}"}
    gid = {first: 0, second: 1}
    assignments, sizes = {}, Counter()
    for name, (a,) in zip(matrix.names, letters):
        g = gid.get(a, 2 if a == "x" else 3)
        assignments[name] = g
        sizes[g] += 1
    groups = [
        {"id": 0, "key": first, "label": names[first], "alleles": [first], "count": sizes[0], "kind": "combo"},
        {"id": 1, "key": second, "label": names[second], "alleles": [second], "count": sizes[1], "kind": "combo"},
        {"id": 2, "key": "other", "label": "Other allele", "alleles": [], "count": sizes[2], "kind": "other"},
        {"id": 3, "key": "not-informative", "label": "Not informative", "alleles": [], "count": sizes[3],
         "kind": "not-informative"},
    ]
    return {"groups": groups, "assignments": assignments, "n_reads": len(matrix.names),
            "covering": sizes[0] + sizes[1] + sizes[2], "snps": [cand["id"]], "phase": None,
            "partial_assigned": 0, "threshold": 0, "distinct": 2}


def hp_groups(matrix: AlleleMatrix) -> dict:
    """Reads by their HP tag (haplotype phasing done upstream, e.g. by WhatsHap or HiPhase)."""
    values = sorted({v for v in matrix.hp if v is not None}, key=lambda v: (len(v), v))
    gid = {v: g for g, v in enumerate(values)}
    untagged = len(values)
    assignments, sizes = {}, Counter()
    for name, v in zip(matrix.names, matrix.hp):
        g = gid.get(v, untagged) if v is not None else untagged
        assignments[name] = g
        sizes[g] += 1
    groups = [{"id": g, "key": f"HP{v}", "label": f"HP {v}", "alleles": [], "count": sizes[g], "kind": "combo"}
              for v, g in gid.items()]
    groups.append({"id": untagged, "key": "not-informative", "label": "No HP tag", "alleles": [],
                   "count": sizes[untagged], "kind": "not-informative"})
    return {"groups": groups, "assignments": assignments, "n_reads": len(matrix.names),
            "covering": len(matrix.names) - sizes[untagged], "snps": [], "phase": None,
            "partial_assigned": 0, "threshold": 0, "distinct": len(values)}
