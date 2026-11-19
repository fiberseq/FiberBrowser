"""Synthetic FiberHMM sample with ``fiberhmm_var`` and ``fiberhmm_sv`` layers.

Writes, under a folder, one sample's nucleosome, MSP, var and sv bigBeds laid
out as ``fiberhmm-extract`` (feat/extract-variants-sv) writes them: BED12 plus
the layer's columns plus ``isDuplicate``, chromStart/End = the first block's
start and the last block's end, autoSQL table names, a ``Sample: <name>.``
description and, for var, the ``VCF: name=...; md5=...; sample=...`` marker;
also the VCF the var layer names, and a UCSC chain for lift tests. BigBeds
need UCSC ``bedToBigBed``; callers skip without it.

The sample (chr1, 20 reads r00..r19 over 1,000-9,000):

- site 5,000 (A>G): r00-r07 ALT, r08-r15 REF, r16-r17 ambiguous (DAF), r18 another base; r19 does not cover it;
- site 3,000 (ACG>A, a 2-bp deletion allele): r00-r03 ALT, r04-r09 REF;
- site 7,000 (C>T): every read REF except r19 ALT;
- site 5,550 (G>C, r00 only): falls in the chain's gap, so it does not lift;
- site 3,001 (C>T, r00 only) overlaps the 3,000 site: r00's var record is two rows;
- MSP 4,800-5,200 on the REF reads at 5,000 only (accessible on REF, closed on ALT);
- hp 1 on r00-r07, 2 on r08-r15;
- SV records: r00-r09 a 500-bp deletion at 6,000; r10 a 300-bp insertion before 4,000 (anchor 3,999); r11 a right
  clip of 2,000 bp at its end (9,000) and its supplementary at 20,000-22,000 with a left clip (SA both ways); r12 a
  deletion at mapq 5; r13 a 400-bp insertion before 6,100 and a 60-bp deletion at 6,100 in one record (overlapping
  blocks: two rows).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from fire_fixtures import bed_to_bigbed_tool

CHROM = "chr1"
CHROM_SIZE = 50_000
SAMPLE = "synthetic.sample_A"
VCF_NAME = "synthetic_sites.vcf.gz"
READS = [f"r{i:02d}" for i in range(20)]
READ_START, READ_END = 1_000, 9_000

FOOTPRINT_AS = f'''table fiberhmm_nucleosome
"Sample: {SAMPLE}. FiberHMM nucleosome footprints"
(
string chrom; "Chromosome"
uint chromStart; "Start"
uint chromEnd; "End"
string name; "Read ID"
uint score; "Score"
char[1] strand; "Strand"
uint thickStart; "Thick start"
uint thickEnd; "Thick end"
uint reserved; "Color"
int blockCount; "Number of footprints"
int[blockCount] blockSizes; "Footprint sizes"
int[blockCount] chromStarts; "Footprint starts"
uint isDuplicate; "1 when the source BAM record carried flag 0x400"
)'''

MSP_AS = FOOTPRINT_AS.replace("fiberhmm_nucleosome", "fiberhmm_msp").replace("nucleosome footprints", "MSPs")

VAR_AS = f'''table fiberhmm_var
"Sample: {SAMPLE}. VCF: name={VCF_NAME}; md5=0123456789abcdef; sample=synthetic_B. FiberHMM per-read alleles at VCF sites"
(
string chrom; "Chromosome"
uint chromStart; "Read alignment start"
uint chromEnd; "Read alignment end"
string name; "Read ID"
uint score; "Score"
char[1] strand; "Strand"
uint thickStart; "Thick start"
uint thickEnd; "Thick end"
uint reserved; "Color"
int blockCount; "Number of sites"
int[blockCount] blockSizes; "REF allele lengths"
int[blockCount] chromStarts; "Site starts"
int[blockCount] blockAllele; "VCF allele index; -1 other base, -2 deleted, -3 ambiguous (DAF)"
int[blockCount] blockBq; "Base quality, -1 none"
int hp; "HP tag, -1 absent"
int ps; "PS tag, -1 absent"
uint isDuplicate; "1 when the source BAM record carried flag 0x400"
)'''

SV_AS = f'''table fiberhmm_sv
"Sample: {SAMPLE}. Per-record structural events"
(
string chrom; "Chromosome"
uint chromStart; "Alignment start"
uint chromEnd; "Alignment end"
string name; "Read ID"
uint score; "Score"
char[1] strand; "Strand"
uint thickStart; "Thick start"
uint thickEnd; "Thick end"
uint reserved; "Color"
int blockCount; "Number of events"
int[blockCount] blockSizes; "Event spans"
int[blockCount] chromStarts; "Event starts"
int[blockCount] blockType; "0 DEL, 1 INS, 2 CLIP_LEFT, 3 CLIP_RIGHT"
int[blockCount] blockLen; "Event length"
uint mapq; "Mapping quality"
uint readLen; "Read length incl. clips"
uint flag; "SAM flag"
lstring sa; "SA tag or ."
int hp; "HP tag, -1 absent"
int ps; "PS tag, -1 absent"
uint isDuplicate; "1 when the source BAM record carried flag 0x400"
)'''

# Source chr1 [0, 5,500) -> target chr1 [1,000, 6,500); source [5,500, 5,600) deleted in the target;
# source [5,600, 50,000) -> target [6,500, 50,900).
CHAIN = ("chain 1000 chr1 50000 + 0 50000 chr1 60000 + 1000 50900 1\n"
         "5500 100 0\n"
         "44400\n\n")


def lift_point(pos: int) -> int | None:
    """Where the chain puts a source position (None in its gap)."""
    if pos < 5_500:
        return pos + 1_000
    if pos < 5_600:
        return None
    return pos + 900


def _strand(i: int) -> str:
    return "+" if i % 2 == 0 else "-"


def _bed12(read, strand, blocks):
    """fiberhmm-extract's row: the span is the blocks' hull."""
    blocks = sorted(blocks)
    start, end = blocks[0][0], max(p + z for p, z in blocks)
    return [CHROM, start, end, read, 0, strand, start, end, "0", len(blocks),
            ",".join(str(z) for _p, z in blocks) + ",", ",".join(str(p - start) for p, _z in blocks) + ","]


def footprint_rows():
    rows = []
    for i, read in enumerate(READS):
        blocks = [(p, 147) for p in range(READ_START + 20, READ_END - 200, 200)
                  if not (4_700 <= p <= 5_200 and 8 <= i <= 15)]
        blocks = [(READ_START, 1)] + blocks + [(READ_END - 1, 1)]  # the read's ends, so its extent is known
        rows.append(_bed12(read, _strand(i), blocks) + [0])
    return rows


def msp_rows():
    return [_bed12(read, _strand(i), [(4_800, 400)]) + [0] for i, read in enumerate(READS) if 8 <= i <= 15]


def var_allele(i: int, pos: int):
    if pos == 5_000:
        if i <= 7:
            return 1
        if i <= 15:
            return 0
        if i <= 17:
            return -3
        if i == 18:
            return -1
        return None
    if pos == 3_000:
        return 1 if i <= 3 else 0 if i <= 9 else None
    if pos == 7_000:
        return 1 if i == 19 else 0
    if pos in (5_550, 3_001):
        return 1 if i == 0 else None
    return None


SITES = {3_000: 3, 3_001: 1, 5_000: 1, 5_550: 1, 7_000: 1}


def var_rows():
    rows = []
    for i, read in enumerate(READS):
        sites = [(pos, SITES[pos], var_allele(i, pos)) for pos in sorted(SITES) if var_allele(i, pos) is not None]
        hp = 1 if i <= 7 else 2 if i <= 15 else -1
        # Blocks must not overlap: an overlapping site goes to another row of the same read (as fiberhmm-extract).
        packs: list = []
        for site in sites:
            for pack in packs:
                if pack[-1][0] + pack[-1][1] <= site[0]:
                    pack.append(site)
                    break
            else:
                packs.append([site])
        for pack in packs:
            row = _bed12(read, _strand(i), [(p, z) for p, z, _a in pack])
            row += [",".join(str(a) for _p, _z, a in pack) + ",", ",".join("30" for _ in pack) + ",", hp,
                    7 if hp > 0 else -1, 0]
            rows.append(row)
    return rows


def sv_rows():
    rows = []

    def add(read, strand, events, mapq=60, read_len=8_000, flag=0, sa="."):
        events = sorted(events, key=lambda e: e[1])
        row = _bed12(read, strand, [(p, z) for _t, p, z, _n in events])
        row += [",".join(str(e[0]) for e in events) + ",", ",".join(str(e[3]) for e in events) + ",",
                mapq, read_len, flag, sa, -1, -1, 0]
        rows.append(row)

    for i in range(10):
        add(READS[i], _strand(i), [(0, 6_000, 500, 500)], flag=16 if i % 2 else 0)
    add(READS[10], "+", [(1, 3_999, 1, 300)], read_len=8_300)
    add(READS[11], "+", [(3, READ_END - 1, 1, 2_000)], read_len=10_000, sa=f"{CHROM},20001,+,8000S2000M,60,0;")
    add(READS[11], "+", [(2, 20_000, 1, 8_000)], read_len=10_000, flag=2048, sa=f"{CHROM},1001,+,8000M2000S,60,0;")
    add(READS[12], "-", [(0, 6_000, 500, 500)], mapq=5, flag=16)
    # One record, two rows (its insertion's anchor block overlaps its deletion's first base).
    add(READS[13], "+", [(1, 6_099, 1, 400)], read_len=8_400)
    add(READS[13], "+", [(0, 6_099, 60, 60)], read_len=8_400)
    return rows


def _write_bigbed(tool, rows, autosql, out_path: Path, bed_type: str) -> Path:
    work = out_path.parent
    bed = work / (out_path.name + ".bed")
    rows = sorted(rows, key=lambda r: (r[0], int(r[1]), int(r[2]), str(r[3])))
    bed.write_text("".join("\t".join(str(x) for x in row) + "\n" for row in rows))
    as_path = work / (out_path.name + ".as")
    as_path.write_text(autosql)
    sizes = work / "chrom.sizes"
    sizes.write_text(f"{CHROM}\t{CHROM_SIZE}\n")
    subprocess.run([tool, "-allow1bpOverlap", f"-type={bed_type}", f"-as={as_path}", str(bed), str(sizes), str(out_path)],
                   check=True, capture_output=True)
    bed.unlink()
    as_path.unlink()
    return out_path


def write_vcf(path: Path) -> Path:
    import pysam
    plain = path.with_suffix("")  # .vcf
    plain.write_text(
        "##fileformat=VCFv4.2\n"
        f"##contig=<ID={CHROM},length={CHROM_SIZE}>\n"
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
        f"{CHROM}\t3001\t.\tACG\tA\t.\tPASS\t.\n"
        f"{CHROM}\t3002\t.\tC\tT\t.\tPASS\t.\n"
        f"{CHROM}\t5001\t.\tA\tG\t.\tPASS\t.\n"
        f"{CHROM}\t5551\t.\tG\tC\t.\tPASS\t.\n"
        f"{CHROM}\t7001\t.\tC\tT\t.\tPASS\t.\n")
    pysam.tabix_index(str(plain), preset="vcf", force=True)
    return path


def write_sample(root: Path, *, vcf: bool = True, layers=("footprint", "msp", "var", "sv")) -> dict:
    tool = bed_to_bigbed_tool()
    if tool is None:
        raise RuntimeError("bedToBigBed is not installed")
    root.mkdir(parents=True, exist_ok=True)
    out: dict = {"root": root}
    stem = "sampleA"
    if "footprint" in layers:
        out["footprint"] = _write_bigbed(tool, footprint_rows(), FOOTPRINT_AS, root / f"{stem}_nucleosome.bb", "bed12+1")
    if "msp" in layers:
        out["msp"] = _write_bigbed(tool, msp_rows(), MSP_AS, root / f"{stem}_msp.bb", "bed12+1")
    if "var" in layers:
        out["var"] = _write_bigbed(tool, var_rows(), VAR_AS, root / f"{stem}_var.bb", "bed12+5")
    if "sv" in layers:
        out["sv"] = _write_bigbed(tool, sv_rows(), SV_AS, root / f"{stem}_sv.bb", "bed12+9")
    if vcf:
        out["vcf"] = write_vcf(root / VCF_NAME)
    chain = root / "shift.chain"
    chain.write_text(CHAIN)
    out["chain"] = chain
    return out
