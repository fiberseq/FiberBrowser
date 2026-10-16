"""Which genome assembly a file's contigs belong to, from their lengths.

A BAM header (``@SQ SN/LN``, sometimes ``AS``/``UR``/``M5``), a BigBed's
chromosome list and a FASTA index all carry contig lengths. Names don't tell
assemblies apart (hg19 and hg38 both call it ``chr1``) and differ between
conventions for one assembly (``chr1``, ``1``, ``NC_000001.11``); the lengths
of a few large chromosomes identify it whatever the names.

Only large nuclear chromosomes are fingerprinted: mitochondria (hg19's UCSC
chrM is 16,571 bp, GRCh37's MT 16,569 bp, the same as GRCh38's) and small
contigs are shared or ambiguous between assemblies.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Iterable, Optional

from utils.chrom import same_chrom

# Canonical (UCSC-style) names and lengths. hg38, hg19, mm39, mm10 and dm6 are
# checked against the registry downloads (~/.fiberhmm/genomes).
ASSEMBLIES: dict[str, dict] = {
    "hg38": {
        "name": "GRCh38/hg38", "species": "human",
        "contigs": {"chr1": 248_956_422, "chr2": 242_193_529, "chr3": 198_295_559,
                    "chr4": 190_214_555, "chr5": 181_538_259, "chrX": 156_040_895},
    },
    "hg19": {
        "name": "GRCh37/hg19", "species": "human",
        "contigs": {"chr1": 249_250_621, "chr2": 243_199_373, "chr3": 198_022_430,
                    "chr4": 191_154_276, "chr5": 180_915_260, "chrX": 155_270_560},
    },
    "chm13": {
        "name": "T2T-CHM13 (hs1)", "short": "T2T-CHM13", "species": "human",
        "contigs": {"chr1": 248_387_328, "chr2": 242_696_752, "chr3": 201_105_948,
                    "chr4": 193_574_945, "chr5": 182_045_439, "chrX": 154_259_566},
    },
    "mm39": {
        "name": "GRCm39/mm39", "species": "mouse",
        "contigs": {"chr1": 195_154_279, "chr2": 181_755_017, "chr3": 159_745_316,
                    "chr4": 156_860_686, "chr5": 151_758_149, "chrX": 169_476_592},
    },
    "mm10": {
        "name": "GRCm38/mm10", "species": "mouse",
        "contigs": {"chr1": 195_471_971, "chr2": 182_113_224, "chr3": 160_039_680,
                    "chr4": 156_508_116, "chr5": 151_834_684, "chrX": 171_031_299},
    },
    "dm6": {
        "name": "D. melanogaster dm6 (BDGP6)", "species": "fly",
        "contigs": {"chr2L": 23_513_712, "chr2R": 25_286_936, "chr3L": 28_110_227,
                    "chr3R": 32_079_331, "chrX": 23_542_271, "chr4": 1_348_131},
    },
    "dm3": {
        "name": "D. melanogaster dm3 (BDGP5)", "species": "fly",
        "contigs": {"chr2L": 23_011_544, "chr2R": 21_146_708, "chr3L": 24_543_557,
                    "chr3R": 27_905_053, "chrX": 22_422_827},
    },
    "sacCer3": {
        "name": "S. cerevisiae sacCer3 (R64)", "species": "yeast",
        "contigs": {"chrII": 813_184, "chrIV": 1_531_933, "chrVII": 1_090_940,
                    "chrXII": 1_078_177, "chrXV": 1_091_291},
    },
    "ce11": {
        "name": "C. elegans ce11 (WBcel235)", "species": "worm",
        "contigs": {"chrI": 15_072_434, "chrII": 15_279_421, "chrV": 20_924_180, "chrX": 17_718_942},
    },
}

# Names an ``AS`` tag, a ``UR`` path or a FASTA file name gives an assembly.
# Checked in order: the more specific patterns first.
_LABEL_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"t2t|chm13|\bhs1\b|gca_009914755"), "chm13"),
    (re.compile(r"grch38|\bhg38\b|hs38|gca_000001405\.(1[5-9]|[2-9]\d)"), "hg38"),
    (re.compile(r"grch37|\bhg19\b|\bb37\b|hs37|human_g1k_v37|gca_000001405\.([1-9]|1[0-4])\b"), "hg19"),
    (re.compile(r"grcm39|\bmm39\b"), "mm39"),
    (re.compile(r"grcm38|\bmm10\b"), "mm10"),
    (re.compile(r"\bdm6\b|bdgp6"), "dm6"),
    (re.compile(r"\bdm3\b|bdgp5"), "dm3"),
    (re.compile(r"saccer3|\br64\b"), "sacCer3"),
    (re.compile(r"\bce11\b|wbcel235"), "ce11"),
]

# Unplaced, alt, fix, decoy and viral contigs: they differ between releases of
# one assembly (and between analysis sets), so they never decide a mismatch.
UNPLACED_RE = re.compile(
    r"(_random$|_alt$|_fix$|_decoy$|_hap\d*$|^chrun|^un_|_un_|chrun_|^hla[-_]|ebv$|^chrebv$|"
    r"^gl\d|^kn\d|^ki\d|^jh\d|^jtfh|^nt_|^nw_|^aaaa|^ds\d|^211000022|^rdna|^chr\w*_gl\d)",
    re.IGNORECASE,
)
_MITO = {"m", "mt", "chrm", "chrmt", "mito", "mitochondrion", "mitochondrion_genome", "chrmito", "2micron"}
_NCBI_RE = re.compile(r"^(nc_|cm\d|nt_|nw_|cp\d)", re.IGNORECASE)

# A small-contig header (all contigs this short, and few of them) is a
# plasmid/amplicon reference rather than a genome.
PLASMID_MAX_CONTIG = 500_000
PLASMID_MAX_CONTIGS = 20

REGISTRY_IDS = ("hg38", "hg19", "mm39", "mm10", "dm6", "sacCer3")


def assembly_name(assembly_id: Optional[str]) -> Optional[str]:
    info = ASSEMBLIES.get(assembly_id or "")
    return info["name"] if info else assembly_id


def short_name(assembly_id: Optional[str]) -> Optional[str]:
    """How messages name an assembly: its registry id (hg38, dm6), else a short name."""
    info = ASSEMBLIES.get(assembly_id or "")
    return (info or {}).get("short") or assembly_id


def is_mito(name: str) -> bool:
    return str(name or "").lower() in _MITO


def is_unplaced(name: str) -> bool:
    """An unplaced/alt/decoy/viral contig (never decides a mismatch)."""
    return bool(UNPLACED_RE.search(str(name or "")))


def assembly_from_label(text: Optional[str]) -> Optional[str]:
    """The assembly an ``AS`` tag, ``UR`` path or FASTA file name names, if any."""
    if not text:
        return None
    lower = os.path.basename(str(text).rstrip("/")).lower() if ("/" in str(text)) else str(text).lower()
    for pattern, assembly in _LABEL_PATTERNS:
        if pattern.search(lower):
            return assembly
    return None


def naming_style(name: str, canonical: str) -> str:
    """How a file names a canonical contig: 'ucsc' (chr1), 'ensembl' (1),
    'ncbi' (NC_000001.11) or 'other'."""
    if name == canonical:
        return "ucsc"
    if _NCBI_RE.match(name):
        return "ncbi"
    if same_chrom(name, canonical) or name.lower() == canonical.lower():
        return "ensembl"
    stripped = canonical[3:] if canonical.lower().startswith("chr") else canonical
    from utils.chrom import normalize_chrom_name
    if normalize_chrom_name(name) == normalize_chrom_name(stripped):
        return "ensembl"
    return "other"


def _length_index() -> dict[int, list[tuple[str, str]]]:
    index: dict[int, list[tuple[str, str]]] = {}
    for assembly_id, info in ASSEMBLIES.items():
        for contig, length in info["contigs"].items():
            index.setdefault(int(length), []).append((assembly_id, contig))
    return index


_BY_LENGTH = _length_index()


@dataclass
class Contig:
    name: str
    length: int
    md5: Optional[str] = None


@dataclass
class Fingerprint:
    """What a contig list looks like: an assembly (with a confidence), a plasmid set, or unknown."""
    assembly: Optional[str] = None
    confidence: str = "none"          # high | medium | low | none
    kind: str = "unknown"             # genome | plasmid | unknown | empty
    naming: Optional[str] = None      # ucsc | ensembl | ncbi | other | mixed
    matched: list = field(default_factory=list)  # [{name, canonical, length}]
    declared: Optional[str] = None    # the AS / UR / file name's assembly
    conflicts: list = field(default_factory=list)
    others: list = field(default_factory=list)  # other assemblies with matches (a hybrid reference)
    n_contigs: int = 0

    @property
    def in_registry(self) -> bool:
        return self.assembly in REGISTRY_IDS

    def to_dict(self) -> dict:
        return {
            "assembly": self.assembly,
            "name": assembly_name(self.assembly),
            "short": short_name(self.assembly),
            "confidence": self.confidence,
            "kind": self.kind,
            "naming": self.naming,
            "in_registry": self.in_registry,
            "declared": self.declared,
            "matched": list(self.matched),
            "conflicts": list(self.conflicts),
            "others": list(self.others),
            "n_contigs": self.n_contigs,
        }


def _looks_like_plasmids(contigs: list[Contig]) -> bool:
    return bool(contigs) and len(contigs) <= PLASMID_MAX_CONTIGS \
        and max(c.length for c in contigs) <= PLASMID_MAX_CONTIG


def fingerprint(contigs: Iterable, *, labels: Iterable[Optional[str]] = ()) -> Fingerprint:
    """Identify the assembly of a contig list.

    ``contigs``: ``Contig`` objects or ``(name, length)`` / ``(name, length, md5)``
    tuples. ``labels``: ``AS`` tags, ``UR`` paths or file names that may name
    the assembly (used when the lengths say nothing, and checked against them).

    Exact lengths of two or more fingerprinted chromosomes: high confidence.
    One: medium. None, but a label names it: medium ("declared"). Lengths win
    over a label that disagrees (the reads were aligned to those contigs); the
    disagreement is listed in ``conflicts``.
    """
    items = [c if isinstance(c, Contig) else Contig(str(c[0]), int(c[1]), (c[2] if len(c) > 2 else None))
             for c in contigs or ()]
    fp = Fingerprint(n_contigs=len(items))
    if not items:
        fp.kind = "empty"
    hits: dict[str, dict[str, Contig]] = {}
    for contig in items:
        if is_mito(contig.name) or is_unplaced(contig.name):
            continue
        for assembly_id, canonical in _BY_LENGTH.get(int(contig.length), ()):
            hits.setdefault(assembly_id, {}).setdefault(canonical, contig)

    declared = None
    for label in labels or ():
        declared = assembly_from_label(label)
        if declared:
            break
    fp.declared = declared

    ranked = sorted(hits.items(), key=lambda kv: (-len(kv[1]), kv[0] != declared, kv[0]))
    if ranked:
        best, matched = ranked[0]
        fp.assembly = best
        fp.kind = "genome"
        fp.confidence = "high" if len(matched) >= 2 else "medium"
        fp.matched = [{"name": c.name, "canonical": canonical, "length": c.length}
                      for canonical, c in sorted(matched.items())]
        fp.others = [a for a, m in ranked[1:]]
        if fp.others and len(ranked[1][1]) == len(matched):
            fp.confidence = "low"  # as many matches for another assembly
        styles = {naming_style(c.name, canonical) for canonical, c in matched.items()}
        fp.naming = styles.pop() if len(styles) == 1 else "mixed"
        if declared and declared != best:
            fp.conflicts.append(
                f"The header names {assembly_name(declared)}, but the contig lengths are {assembly_name(best)}'s.")
        return fp

    if _looks_like_plasmids(items):
        fp.kind = "plasmid"
        return fp
    if declared:
        fp.assembly = declared
        fp.confidence = "medium"
        fp.kind = "genome"
        return fp
    if items:
        fp.kind = "unknown"
    return fp


def canonical_contigs(assembly_id: str) -> dict[str, int]:
    """The fingerprinted chromosomes of an assembly (names as UCSC spells them)."""
    return dict((ASSEMBLIES.get(assembly_id) or {}).get("contigs") or {})


def header_contigs(header: dict) -> tuple[list[Contig], list[str]]:
    """``@SQ`` rows as contigs, plus their ``AS`` tags and ``UR`` values (labels)."""
    contigs, labels = [], []
    for row in (header or {}).get("SQ", []) or []:
        name = str(row.get("SN", ""))
        if not name:
            continue
        md5 = str(row.get("M5", "") or "").lower() or None
        contigs.append(Contig(name, int(row.get("LN", 0) or 0), md5))
        for tag in ("AS", "UR"):
            value = row.get(tag)
            if value and str(value) not in labels:
                labels.append(str(value))
    return contigs, labels
