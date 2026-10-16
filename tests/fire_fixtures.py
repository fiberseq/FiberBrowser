"""Synthetic fibertools-rs / FIRE track-hub files for tests.

The rows follow what `ft track-decorators` writes (fibertools-rs
src/subcommands/decorator.rs: `bed12_from_fiber` and `Decorator`'s Display)
and the FIRE workflow turns into bigBeds with its own autoSql templates
(workflow/templates/{bed12_filter,decoration,fire_peak,bed3,bed9}.as, copied
verbatim below). BigBeds need UCSC ``bedToBigBed``; callers skip without it.
"""
from __future__ import annotations

import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

CHROM = "chr1"
CHROM_SIZE = 50_000

# fibertools-rs src/lib.rs FIRE_COLORS: (max FDR %, colour); LINKER and NUC last.
FIRE_COLORS = [
    (1.0, "139,0,0"),
    (2.0, "175,0,0"),
    (3.0, "200,0,0"),
    (4.0, "225,0,0"),
    (5.0, "255,0,0"),
    (10.0, "255,140,0"),
    (25.0, "225,225,0"),
    (100.0, "147,112,219"),
]
LINKER_COLOR = "147,112,219"
NUC_COLOR = "169,169,169"
M6A_COLOR = "128,0,128"
CPG_COLOR = "139,69,19"

BED12_FILTER_AS = '''table decoration
"Browser extensible data (12 fields) plus information about what item this decorates and how."
    (
    string chrom;      "Chromosome (or contig, scaffold, etc.)"
    uint   chromStart; "Start position in chromosome"
    uint   chromEnd;   "End position in chromosome"
    string name;       "Name of item"
    uint   score;      "Score from 0-1000"
    char[1] strand;    "+ or -"
    uint thickStart;   "Start of where display should be thick (start codon)"
    uint thickEnd;     "End of where display should be thick (stop codon)"
    uint color;        "Primary RGB color for the decoration"
    int blockCount;    "Number of blocks"
    int[blockCount] blockSizes; "Comma separated list of block sizes"
    int[blockCount] chromStarts; "Start positions relative to chromStart"
    lstring keywords;  "hap associated with the record"
    )
'''

DECORATION_AS = '''table decoration
"Browser extensible data (12 fields) plus information about what item this decorates and how."
    (
    string chrom;      "Chromosome (or contig, scaffold, etc.)"
    uint   chromStart; "Start position in chromosome"
    uint   chromEnd;   "End position in chromosome"
    string name;       "Name of item"
    uint   score;      "Score from 0-1000"
    char[1] strand;    "+ or -"
    uint thickStart;   "Start of where display should be thick (start codon)"
    uint thickEnd;     "End of where display should be thick (stop codon)"
    uint color;        "Primary RGB color for the decoration"
    int blockCount;    "Number of blocks"
    int[blockCount] blockSizes; "Comma separated list of block sizes"
    int[blockCount] chromStarts; "Start positions relative to chromStart"
    string decoratedItem; "Identity of the decorated item in chr:start-end:item_name format"
    string style;      "Draw style for the decoration (e.g. block, glyph)"
    string fillColor;  "Secondary color to use for filling decoration, blocks, supports RGBA"
    string glyph;  "The glyph to draw in glyph mode; ignored for other styles"
    lstring keywords;  "Keywords associated with the decoration"
    )
'''

FIRE_PEAK_AS = '''table fire_peaks "FIRE Peaks"
(
string  chrom;  "Reference sequence chromosome or scaffold"
uint    chromStart; "Start position in chromosome"
uint    chromEnd;   "End position in chromosome"
string  name;   "Name given to a region (preferably unique). Use . if no name is assigned"
uint    score;  "Indicates how dark the peak will be displayed in the browser (0-1000)"
char[1] strand; "+ or - or . for unknown"
float   signalValue;    "Measurement of average enrichment for the region"
float   pValue; "Statistical significance of signal value (-log10). Set to -1 if not used."
float   qValue; "Statistical significance with multiple-test correction applied (FDR -log10) Set to -1 if not used."
uint    peak;   "Point-source called for this peak; 0-based offset from chromStart. Set to -1 if no point-source called."
)
'''

BED3_AS = '''table bed3 "bed3"
(
string  chrom;  "Reference sequence chromosome or scaffold"
uint    chromStart; "Start position in chromosome"
uint    chromEnd;   "End position in chromosome"
)'''

BED9_AS = '''table bed9
"Bed9"
(
string chrom;      "Chromosome (or contig, scaffold, etc.)"
uint   chromStart; "Start position in chromosome"
uint   chromEnd;   "End position in chromosome"
string name;       "Name of item"
uint   score;      "Score from 0-1000"
char[1] strand;    "+ or -"
uint thickStart;   "Start of where display should be thick (start codon)"
uint thickEnd;     "End of where display should be thick (stop codon)"
uint color;        "Primary RGB color for the decoration"
)'''


def bed_to_bigbed_tool() -> Optional[str]:
    return shutil.which("bedToBigBed") or next(
        (p for p in (os.path.expanduser("~/ucsc_tools/bedToBigBed"),) if os.path.isfile(p)), None)


def fire_color(fdr_percent: float) -> str:
    for max_fdr, color in FIRE_COLORS:
        if fdr_percent <= max_fdr:
            return color
    return LINKER_COLOR


def make_fiber(qname, start, end, strand="+", hap="H1", *, fire_msps=None, nuc_len=147, linker_len=53):
    """One fiber: tiled nucleosomes and linker MSPs; ``fire_msps`` replaces
    stretches with one MSP each, given as (abs_start, abs_end, fdr_percent)."""
    fire_msps = sorted(fire_msps or [])
    nucs, msps = [], []  # msps: (start, length, fdr%)
    pos = start
    fire_iter = iter(fire_msps)
    next_fire = next(fire_iter, None)
    while pos < end:
        fire_start = next_fire[0] if next_fire is not None else end
        n_end = min(pos + nuc_len, end, fire_start)
        if n_end > pos:
            nucs.append((pos, n_end - pos))
            pos = n_end
        if pos >= end:
            break
        if next_fire is not None and pos >= fire_start:
            msps.append((pos, next_fire[1] - pos, next_fire[2]))
            pos = next_fire[1]
            next_fire = next(fire_iter, None)
            continue
        l_end = min(pos + linker_len, end, fire_start)
        msps.append((pos, l_end - pos, 100.0))
        pos = l_end
    m6a = sorted({s + k for s, length, _ in msps for k in range(0, length, 7)})
    cpg = sorted({s + 20 for s, _length in nucs})
    return {
        "qname": qname, "start": start, "end": end, "strand": strand, "hap": hap,
        "nucs": nucs, "msps": msps, "m6a": m6a, "cpg": cpg,
    }


def fiber_bed12_row(fiber) -> list:
    """`bed12_from_fiber`: two 1-bp blocks at the fiber's ends, then the hap."""
    s, e = fiber["start"], fiber["end"]
    return [CHROM, s, e, fiber["qname"], 0, fiber["strand"], s, e, "0,0,0", 2, "1,1",
            f"0,{e - s - 1}", fiber["hap"]]


def _decorator_row(fiber, starts, lengths, color, element_type):
    if not starts:
        return None
    order = sorted(range(len(starts)), key=lambda i: starts[i])
    starts = [starts[i] for i in order]
    lengths = [lengths[i] for i in order]
    d_start = starts[0]
    d_end = starts[-1] + lengths[-1]
    tag = f"{CHROM}:{fiber['start']}-{fiber['end']}:{fiber['qname']}"
    return [
        CHROM, d_start, d_end, element_type, 0, fiber["strand"],
        d_start, d_end, color + ",1", len(starts),
        ",".join(str(x) for x in lengths) + ",",
        ",".join(str(x - d_start) for x in starts) + ",",
        tag, "block", color + ",0", "Ignored", element_type,
    ]


def fiber_decorator_rows(fiber, *, include_nuc=True, legacy_fire_names=False) -> list:
    """`decorator_from_bam` rows: m6A, 5mC, NUC, then one row per FIRE colour.

    ``legacy_fire_names`` reproduces older fibertools output, which named
    every MSP row ``FIRE`` (linker-coloured ones too).
    """
    rows = [
        _decorator_row(fiber, fiber["m6a"], [1] * len(fiber["m6a"]), M6A_COLOR, "m6A"),
        _decorator_row(fiber, fiber["cpg"], [1] * len(fiber["cpg"]), CPG_COLOR, "5mC"),
    ]
    if include_nuc:
        rows.append(_decorator_row(fiber, [s for s, _ in fiber["nucs"]], [n for _, n in fiber["nucs"]],
                                   NUC_COLOR, "NUC"))
    by_color: dict = {}
    for s, length, fdr in fiber["msps"]:
        by_color.setdefault(fire_color(fdr), []).append((s, length))
    for _max_fdr, color in FIRE_COLORS:
        items = by_color.get(color)
        if not items:
            continue
        name = "LINKER" if color == LINKER_COLOR and not legacy_fire_names else "FIRE"
        rows.append(_decorator_row(fiber, [s for s, _ in items], [n for _, n in items], color, name))
    return [row for row in rows if row is not None]


def _write_bigbed(tool, rows, autosql, out_path: Path, bed_type: str) -> Path:
    work = out_path.parent
    bed = work / (out_path.name + ".bed")
    rows = sorted(rows, key=lambda r: (r[0], int(r[1]), int(r[2])))
    bed.write_text("".join("\t".join(str(x) for x in row) + "\n" for row in rows))
    as_path = work / (out_path.name + ".as")
    as_path.write_text(autosql)
    sizes = work / "chrom.sizes"
    sizes.write_text(f"{CHROM}\t{CHROM_SIZE}\n")
    subprocess.run(
        [tool, "-allow1bpOverlap", f"-type={bed_type}", f"-as={as_path}", str(bed), str(sizes), str(out_path)],
        check=True, capture_output=True,
    )
    bed.unlink()
    as_path.unlink()
    return out_path


def default_fibers() -> list:
    return [
        make_fiber("m1/100/ccs", 1_000, 6_000, "+", "H1", fire_msps=[(2_000, 2_300, 0.5), (4_000, 4_200, 8.0)]),
        make_fiber("m1/200/ccs", 1_500, 7_000, "-", "H2", fire_msps=[(3_000, 3_250, 20.0)]),
        make_fiber("m1/300/ccs", 2_200, 9_000, "+", "UNK"),
    ]


def write_fire_trackhub(root: Path, *, fibers=None, include_nuc=False, legacy_fire_names=False) -> dict:
    """Write a FIRE-style ``trackHub/`` layout (bb/ and bw/) under ``root``.

    ``include_nuc`` defaults to False because the FIRE workflow strips NUC rows
    (``rg -vw NUC``) from fire-fiber-decorators.bb.
    """
    import pyBigWig

    tool = bed_to_bigbed_tool()
    if tool is None:
        raise RuntimeError("bedToBigBed is not installed")
    fibers = default_fibers() if fibers is None else fibers
    bb = root / "bb"
    bw = root / "bw"
    bb.mkdir(parents=True, exist_ok=True)
    bw.mkdir(parents=True, exist_ok=True)
    out = {"fibers": fibers}
    out["fire-fibers"] = _write_bigbed(
        tool, [fiber_bed12_row(f) for f in fibers], BED12_FILTER_AS, bb / "fire-fibers.bb", "bed12+")
    dec_rows = [row for f in fibers for row in fiber_decorator_rows(
        f, include_nuc=include_nuc, legacy_fire_names=legacy_fire_names)]
    out["fire-fiber-decorators"] = _write_bigbed(
        tool, dec_rows, DECORATION_AS, bb / "fire-fiber-decorators.bb", "bed12+")
    peaks = [
        [CHROM, 2_000, 2_300, "peak-1", 229, ".", 22.9, -1, 31.6, 150],
        [CHROM, 4_000, 4_200, "peak-2", 330, ".", 33.1, -1, 37.6, 90],
    ]
    out["fire-peaks"] = _write_bigbed(tool, peaks, FIRE_PEAK_AS, bb / "fire-peaks.bb", "bed6+4")
    out["fire-wide-peaks"] = _write_bigbed(
        tool, [[CHROM, 1_900, 2_400], [CHROM, 3_950, 4_300]], BED3_AS, bb / "fire-wide-peaks.bb", "bed3")
    hap = [[CHROM, 0, 1, "fake", 100, "+", 0, 1, "230,230,230"],
           [CHROM, 2_000, 2_300, "hap-diff-1", 500, "+", 2_000, 2_300, "0,0,255"]]
    out["hap_differences"] = _write_bigbed(tool, hap, BED9_AS, bb / "hap_differences.bb", "bed9")

    def _bigwig(name, value_fn):
        path = bw / name
        handle = pyBigWig.open(str(path), "w")
        handle.addHeader([(CHROM, CHROM_SIZE)])
        starts = list(range(0, 10_000, 100))
        handle.addEntries([CHROM] * len(starts), starts, ends=[s + 100 for s in starts],
                          values=[float(value_fn(s)) for s in starts])
        handle.close()
        return path

    for hp in ("all", "hap1", "hap2", "unk"):
        out[f"{hp}.percent.accessible"] = _bigwig(
            f"{hp}.percent.accessible.bw", lambda s: 80.0 if 2_000 <= s < 2_300 else 10.0)
        if hp == "all":
            for el in ("fire", "linker", "nucleosome"):
                out[f"{hp}.{el}.coverage"] = _bigwig(f"{hp}.{el}.coverage.bw", lambda s: 3.0)
    out["log_FDR"] = _bigwig("log_FDR.bw", lambda s: 30.0 if 2_000 <= s < 2_300 else 1.0)
    return out


def min_aq_for_fdr(fdr_percent: float) -> int:
    """Smallest FIRE quality (0-255) that fibertools colours at this FDR bin."""
    return int(math.ceil(255 * (1 - fdr_percent / 100) - 1e-9))


def aq_floor_for_msp(fdr_percent: float) -> int:
    """The aq FiberBrowser gives an MSP of this FDR: its colour bin's floor (linker: 0)."""
    for max_fdr, color in FIRE_COLORS:
        if fdr_percent <= max_fdr:
            return 0 if color == LINKER_COLOR else min_aq_for_fdr(max_fdr)
    return 0
