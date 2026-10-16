#!/usr/bin/env python3
"""Align FASTQ reads to a plasmid map for viewing in FiberBrowser.

Generates a reference FASTA whose contig name matches how FiberBrowser
registers the plasmid (the map's filename stem, sanitized), then runs
minimap2 + samtools to produce a sorted, indexed BAM you can load alongside
the plasmid map.

Requirements (must be on your PATH):
    - minimap2   (conda install -c bioconda minimap2)
    - samtools   (conda install -c bioconda samtools)
Only the Python standard library is used otherwise.

Typical use (Nanopore):
    python align_plasmid_reads.py L-HH.dna reads.fastq.gz
    # -> writes L-HH.fa and L-HH.aligned.bam (+ .bai) next to the map

Then in FiberBrowser: Regions -> Open plasmid dataset..., and choose the map
and the .aligned.bam (the BAM's contig is matched to the map by sequence, so
its name does not have to match).

Supports plasmid maps as .dna (SnapGene), .gb/.gbk/.genbank (GenBank), or
.fa/.fasta/.fna (plain FASTA). Pass multiple FASTQ files to merge them into
one BAM. Use --name to choose another contig name.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys


def _safe_name_from_filename(path: str) -> str:
    """Mirror FiberBrowser's plasmid naming: sanitized filename stem."""
    stem = os.path.splitext(os.path.basename(path))[0] or "plasmid"
    stem = stem.split()[0] or "plasmid"
    cleaned = re.sub(r"[^0-9A-Za-z_.-]+", "_", stem).strip("_")
    return cleaned or "plasmid"


def _sequence_from_snapgene(path: str) -> str:
    """Extract the longest ACGTN run from a SnapGene .dna binary file."""
    data = open(path, "rb").read()
    matches = re.findall(rb"[ACGTNacgtn]{50,}", data)
    if not matches:
        raise ValueError(f"No DNA sequence found in SnapGene file: {path}")
    return max(matches, key=len).decode("ascii").upper()


def _sequence_from_genbank(path: str) -> tuple[str, str | None]:
    """Return (sequence, locus_name) from a GenBank file's ORIGIN block."""
    text = open(path, "rt", encoding="utf-8", errors="replace").read()
    parts = text.split("ORIGIN", 1)
    if len(parts) < 2:
        raise ValueError(f"No ORIGIN sequence block in GenBank file: {path}")
    sequence = re.sub(r"[^ACGTNacgtn]", "", parts[1].split("//", 1)[0]).upper()
    if not sequence:
        raise ValueError(f"Empty sequence in GenBank ORIGIN block: {path}")
    locus = re.search(r"^LOCUS\s+(\S+)", text, re.MULTILINE)
    name = re.sub(r"[^0-9A-Za-z_.-]+", "_", locus.group(1)).strip("_") if locus else None
    return sequence, (name or None)


def _sequence_from_fasta(path: str) -> tuple[str, str | None]:
    """Return (sequence, header_name) from the first record of a FASTA file."""
    name = None
    seen = False
    lines: list[str] = []
    with open(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            s = line.strip()
            if not s:
                continue
            if s.startswith(">"):
                if seen:
                    break
                seen = True
                token = s[1:].split()[0] if len(s) > 1 else ""
                name = re.sub(r"[^0-9A-Za-z_.-]+", "_", token).strip("_") or None
                continue
            if seen or not lines:
                lines.append(s)
    sequence = re.sub(r"[^ACGTNacgtn]", "", "".join(lines)).upper()
    if not sequence:
        raise ValueError(f"No DNA sequence found in FASTA file: {path}")
    return sequence, name


def extract_plasmid(path: str, override_name: str | None) -> tuple[str, str]:
    """Return (contig_name, sequence) matching how FiberBrowser registers it."""
    lower = path.lower()
    filename_name = _safe_name_from_filename(path)
    if lower.endswith(".dna"):
        sequence = _sequence_from_snapgene(path)
        name = filename_name
    elif lower.endswith((".gb", ".gbk", ".genbank")):
        sequence, locus = _sequence_from_genbank(path)
        name = locus or filename_name
    elif lower.endswith((".fa", ".fasta", ".fna")):
        sequence, header = _sequence_from_fasta(path)
        name = header or filename_name
    else:
        raise ValueError(
            f"Unsupported map format: {path}\n"
            "Expected .dna (SnapGene), .gb/.gbk/.genbank, or .fa/.fasta/.fna"
        )
    return (override_name or name), sequence


def write_fasta(name: str, sequence: str, out_path: str, wrap: int = 60) -> None:
    with open(out_path, "w", encoding="ascii") as handle:
        handle.write(f">{name}\n")
        for i in range(0, len(sequence), wrap):
            handle.write(sequence[i:i + wrap] + "\n")


def require_tool(tool: str) -> str:
    found = shutil.which(tool)
    if not found:
        sys.exit(
            f"ERROR: '{tool}' not found on PATH.\n"
            f"Install it, e.g.:  conda install -c bioconda {tool}"
        )
    return found


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Align FASTQ to a plasmid map for FiberBrowser.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("map", help="Plasmid map: .dna / .gb / .gbk / .fa / .fasta")
    parser.add_argument("fastq", nargs="+", help="One or more FASTQ files (.fastq/.fq/.gz)")
    parser.add_argument("--name", help="Contig name (default: the name FiberBrowser gives the map; any name works, the browser matches by sequence)")
    parser.add_argument("--preset", default="map-ont",
                        help="minimap2 preset (default: map-ont for Nanopore; use map-hifi/map-pb for PacBio)")
    parser.add_argument("-o", "--outdir", help="Output directory (default: next to the map file)")
    parser.add_argument("-t", "--threads", type=int, default=4, help="Threads (default: 4)")
    args = parser.parse_args()

    require_tool("minimap2")
    require_tool("samtools")

    for path in [args.map, *args.fastq]:
        if not os.path.isfile(path):
            sys.exit(f"ERROR: file not found: {path}")

    name, sequence = extract_plasmid(args.map, args.name)
    outdir = args.outdir or os.path.dirname(os.path.abspath(args.map))
    os.makedirs(outdir, exist_ok=True)
    fasta_path = os.path.join(outdir, f"{name}.fa")
    bam_path = os.path.join(outdir, f"{name}.aligned.bam")

    write_fasta(name, sequence, fasta_path)
    print(f"Reference : {fasta_path}")
    print(f"Contig    : {name}  ({len(sequence):,} bp)")
    print(f"Reads     : {', '.join(args.fastq)}")
    print(f"Preset    : {args.preset}")
    print(f"Output    : {bam_path}")
    print("-" * 60)

    # minimap2 -> samtools sort, in a pipe. --MD adds MD tags for mismatch display.
    minimap = subprocess.Popen(
        ["minimap2", "-ax", args.preset, "--MD", "-t", str(args.threads), fasta_path, *args.fastq],
        stdout=subprocess.PIPE,
    )
    sort = subprocess.Popen(
        ["samtools", "sort", "-@", str(max(1, args.threads - 1)), "-o", bam_path, "-"],
        stdin=minimap.stdout,
    )
    minimap.stdout.close()  # let minimap2 receive SIGPIPE if sort exits
    sort.communicate()
    if minimap.wait() != 0 or sort.returncode != 0:
        sys.exit("ERROR: minimap2/samtools sort failed (see messages above).")

    subprocess.run(["samtools", "index", bam_path], check=True)

    print("-" * 60)
    print("Alignment summary:")
    subprocess.run(["samtools", "flagstat", bam_path], check=True)
    print("-" * 60)
    print("Done. In FiberBrowser:")
    print(f"  1. Load the plasmid map ({os.path.basename(args.map)})")
    print(f"  2. Add the BAM ({os.path.basename(bam_path)})")
    print(f"  Contig name '{name}' must match the chromosome FiberBrowser shows;")
    print("  if it differs, re-run with --name <that name>.")


if __name__ == "__main__":
    main()
