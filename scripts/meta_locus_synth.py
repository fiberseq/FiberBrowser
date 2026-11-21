"""Synthetic data for the meta-locus spike (scripts/benchmark_meta_locus.py): sites on synthetic contigs and
Fiber-seq-like BAMs with reads placed around them. Engineering data only, no biological inference.

Each site has an oriented pattern at its anchor (mirrored on minus-strand sites, so it lines up only after the
virtual contig's strand flip): class "open" (NFR centred on the anchor), "nuc" (a nucleosome on the anchor) and a
rare class "rare" (NFR plus a short footprint at +150 and an extra open stretch at -400..-250, oriented). The
class mix is a parameter; the truth per read is in the read name suffix (o / n / r), so the benchmark can check
that found/scanned estimates the planted frequency.

    python scripts/meta_locus_synth.py OUT_DIR --sites 20000 --spacing 7000 --reads-per-site 20 --datasets 3
"""
from __future__ import annotations

import argparse
from array import array
import random
from pathlib import Path

import pysam

NUC, LINK = 147, 40


def footprints(read_start: int, read_end: int, anchor: int, strand: str, cls: str, rng: random.Random) -> list[tuple[int, int]]:
    """Footprints (reference start, length) of one read: a nucleosome array with the class pattern at the anchor."""
    def oriented(rel_a: int, rel_b: int) -> tuple[int, int]:
        # A pattern interval relative to the anchor in site orientation -> reference interval.
        return (anchor + rel_a, anchor + rel_b) if strand != "-" else (anchor - rel_b, anchor - rel_a)

    opens = []
    if cls in ("open", "rare"):
        opens.append(oriented(-100, 100))
    if cls == "rare":
        opens.append(oriented(-400, -250))
    out = []
    phase = rng.randrange(NUC + LINK)
    pos = read_start + phase
    while pos + NUC < read_end:
        a, b = pos, pos + NUC
        if not any(a < ob and b > oa for oa, ob in opens):
            out.append((a, NUC + rng.randrange(-6, 7)))
        pos += NUC + LINK + rng.randrange(-10, 11)
    if cls == "rare":
        a, b = oriented(140, 170)
        out.append((a, b - a))
    if cls == "nuc":
        # A nucleosome exactly on the anchor (replace any array nucleosome that overlaps it).
        a, b = anchor - NUC // 2, anchor + NUC // 2 + 1
        out = [f for f in out if not (f[0] < b and f[0] + f[1] > a)] + [(a, b - a)]
    return sorted(f for f in out if f[0] >= read_start and f[0] + f[1] <= read_end)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("out", type=Path)
    p.add_argument("--sites", type=int, default=20000)
    p.add_argument("--spacing", type=int, default=7000, help="bp between anchors (fly-like gene density)")
    p.add_argument("--contigs", type=int, default=4)
    p.add_argument("--reads-per-site", type=int, default=20)
    p.add_argument("--datasets", type=int, default=3)
    p.add_argument("--rare", type=float, default=0.02)
    p.add_argument("--nuc", type=float, default=0.38)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--seq", action="store_true", help="write SEQ and QUAL (default: none, smaller files)")
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    per_contig = (a.sites + a.contigs - 1) // a.contigs
    length = per_contig * a.spacing + 40_000
    contigs = [f"synth{i + 1}" for i in range(a.contigs)]
    sites = []
    for i in range(a.sites):
        c, j = divmod(i, per_contig)
        anchor = 20_000 + j * a.spacing
        strand = "+" if (i * 2654435761) & 1 else "-"
        sites.append((contigs[c], anchor, strand, f"s{i}"))
    with open(a.out / f"sites_{a.sites}.bed", "w") as fh:
        for chrom, anchor, strand, name in sites:
            fh.write(f"{chrom}\t{anchor - 100}\t{anchor + 100}\t{name}\t0\t{strand}\n")
    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": c, "LN": length} for c in contigs]}
    for d in range(a.datasets):
        rng = random.Random(a.seed * 1000 + d)
        path = a.out / f"synth_d{d + 1}.bam"
        n = 0
        with pysam.AlignmentFile(str(path), "wb", header=header) as out:
            for ci, chrom in enumerate(contigs):
                recs = []
                for chrom_s, anchor, strand, name in sites:
                    if chrom_s != chrom:
                        continue
                    for _ in range(rng.randint(a.reads_per_site // 2, a.reads_per_site * 3 // 2)):
                        L = rng.randint(3000, 12000)
                        s = rng.randint(anchor - L - 800, anchor + 800)
                        s = max(1, s)
                        u = rng.random()
                        cls = "rare" if u < a.rare else "nuc" if u < a.rare + a.nuc else "open"
                        recs.append((s, L, anchor, strand, cls))
                recs.sort()
                for s, L, anchor, strand, cls in recs:
                    r = pysam.AlignedSegment(out.header)
                    r.query_name = f"d{d + 1}r{n:08d}{cls[0]}"
                    r.reference_id = ci
                    r.reference_start = s
                    r.flag = 0
                    r.mapping_quality = 60
                    if a.seq:
                        r.query_sequence = "ACGT" * (L // 4) + "ACGT"[: L % 4]
                        r.query_qualities = pysam.qualitystring_to_array("I" * L)
                    r.cigartuples = [(0, L)]
                    fps = footprints(s, s + L, anchor, strand, cls, rng)
                    r.set_tag("ns", array("I", [f[0] - s for f in fps]))
                    r.set_tag("nl", array("I", [f[1] for f in fps]))
                    r.set_tag("nq", array("B", [255] * len(fps)))
                    out.write(r)
                    n += 1
        pysam.index(str(path))
        print(path, n, "reads", flush=True)


if __name__ == "__main__":
    main()
