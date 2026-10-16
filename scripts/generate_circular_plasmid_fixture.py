#!/usr/bin/env python3
"""Generate a small circular plasmid Fiber-seq fixture.

The fixture is intended for browser testing, not biological analysis. It writes
a circular GenBank map plus a coordinate-sorted/indexed BAM with full-length
plasmid reads carrying FiberHMM-style MA/AQ/AN tags. Reads are split into two
phase classes with offset nucleosome arrays, and each read includes an
origin-spanning nucleosome represented by two MA intervals with the same AN
identifier.
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
BROWSER_DIR = REPO_ROOT / "browser"
if str(BROWSER_DIR) not in sys.path:
    sys.path.insert(0, str(BROWSER_DIR))

from services.plasmid_maps import PlasmidFeature, PlasmidMap, parse_plasmid_map  # noqa: E402


DEFAULT_LENGTH = 5_054
DEFAULT_NAME = "pPhased"


@dataclass(frozen=True)
class FixturePaths:
    out_dir: Path
    plasmid_map: Path
    fasta: Path
    bam: Path
    bai: Path
    manifest: Path
    source_map: Path | None = None


def _synthetic_sequence(length: int, rng: random.Random) -> str:
    bases = ["A", "C", "G", "T"]
    seq = [rng.choice(bases) for _ in range(length)]
    motifs = {
        120: "GGGCGG",
        880: "CCAAT",
        1_540: "TATAAA",
        2_420: "CACGTG",
        max(0, length - 96): "GGGCGG",
    }
    for start, motif in motifs.items():
        if 0 <= start < length:
            seq[start:min(length, start + len(motif))] = list(motif[:max(0, length - start)])
    return "".join(seq)


def _default_features(length: int) -> list[PlasmidFeature]:
    return [
        PlasmidFeature("EF1a_promoter_like", 90, min(length, 680), "+", "promoter"),
        PlasmidFeature("GFP_orf_like", 840, min(length, 1_560), "+", "CDS"),
        PlasmidFeature("SV40_polyA_like", 1_720, min(length, 2_020), "+", "terminator"),
        PlasmidFeature("bacterial_backbone", 2_200, min(length, 3_850), "-", "backbone"),
        PlasmidFeature("origin_spanning_feature", max(0, length - 80), length + 80, "+", "misc_feature"),
    ]


def _feature_location(feature: PlasmidFeature, length: int) -> str:
    start = int(feature.start)
    end = int(feature.end)
    if start < length and end > length:
        left = f"{start + 1}..{length}"
        right = f"1..{end - length}"
        loc = f"join({left},{right})"
    else:
        loc = f"{max(1, start + 1)}..{max(start + 1, min(length, end))}"
    if feature.strand == "-":
        loc = f"complement({loc})"
    return loc


def _write_genbank(path: Path, plasmid: PlasmidMap) -> None:
    sequence = plasmid.sequence.upper()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        handle.write(f"LOCUS       {plasmid.name:<16}{len(sequence):>8} bp    DNA     circular SYN 01-JAN-2026\n")
        handle.write("FEATURES             Location/Qualifiers\n")
        for feature in plasmid.features or _default_features(len(sequence)):
            handle.write(f"     {feature.kind:<15} {_feature_location(feature, len(sequence))}\n")
            handle.write(f"                     /label=\"{feature.name}\"\n")
        handle.write("ORIGIN\n")
        for offset in range(0, len(sequence), 60):
            chunk = sequence[offset:offset + 60].lower()
            groups = " ".join(chunk[i:i + 10] for i in range(0, len(chunk), 10))
            handle.write(f"{offset + 1:>9} {groups}\n")
        handle.write("//\n")


def _write_fasta(path: Path, name: str, sequence: str) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write(f">{name} circular synthetic phased Fiber-seq fixture\n")
        for offset in range(0, len(sequence), 80):
            handle.write(sequence[offset:offset + 80] + "\n")


def _clamp_interval(start: int, length: int, chrom_len: int) -> tuple[int, int] | None:
    start = max(0, int(start))
    end = min(chrom_len, start + int(length))
    if end <= start:
        return None
    return start, end - start


def _add_interval(
    intervals: list[tuple[int, int, str]],
    start: int,
    length: int,
    chrom_len: int,
    name: str,
) -> None:
    interval = _clamp_interval(start, length, chrom_len)
    if interval:
        intervals.append((interval[0], interval[1], name))


def _read_annotation_layout(chrom_len: int, phase_offset: int, read_index: int) -> tuple[str, list[int], str, dict[str, list[int]]]:
    jitter = (read_index % 5) - 2
    nucs: list[tuple[int, int, str]] = []
    msps: list[tuple[int, int, str]] = []
    tfs: list[tuple[int, int, str]] = []

    # Biological nucleosome across the arbitrary circular origin: two MA
    # intervals, one AN id.
    origin_name = f"phase{phase_offset}_origin_nuc"
    _add_interval(nucs, 0, 72, chrom_len, origin_name)
    _add_interval(nucs, chrom_len - 72, 72, chrom_len, origin_name)

    for center in range(phase_offset + 210, chrom_len - 120, 190):
        start = center - 73 + jitter
        _add_interval(nucs, start, 146, chrom_len, f"phase{phase_offset}_nuc_{center}")

    for start, length, label in (
        (720 + jitter, 95, "promoter_msp"),
        (1_570 + jitter, 115, "sv40_msp"),
        (2_410 + jitter, 105, "backbone_msp"),
    ):
        _add_interval(msps, start, length, chrom_len, f"phase{phase_offset}_{label}")

    for start, length, label in (
        (875 + jitter, 32, "CCAAT_tf"),
        (1_535 + jitter, 28, "TATA_tf"),
        (2_425 + jitter, 34, "Ebox_tf"),
    ):
        _add_interval(tfs, start, length, chrom_len, f"phase{phase_offset}_{label}")
    origin_tf = f"phase{phase_offset}_origin_tf"
    _add_interval(tfs, 8, 26, chrom_len, origin_tf)
    _add_interval(tfs, chrom_len - 34, 26, chrom_len, origin_tf)

    parts: list[str] = ["v1"]
    aq: list[int] = []
    names: list[str] = []
    legacy: dict[str, list[int]] = {"ns": [], "nl": [], "nq": [], "lq": [], "rq": [], "as": [], "al": [], "aq": []}

    if nucs:
        parts.append("nuc+QQQ:" + ",".join(f"{start + 1}-{length}" for start, length, _name in nucs))
        for idx, (start, length, name) in enumerate(nucs):
            aq.extend([225 - (idx % 20), 180, 180])
            names.append(name)
            legacy["ns"].append(start)
            legacy["nl"].append(length)
            legacy["nq"].append(225 - (idx % 20))
            legacy["lq"].append(180)
            legacy["rq"].append(180)
    if msps:
        parts.append("msp.P:" + ",".join(f"{start + 1}-{length}" for start, length, _name in msps))
        for idx, (start, length, name) in enumerate(msps):
            aq.append(190 - (idx % 10))
            names.append(name)
            legacy["as"].append(start)
            legacy["al"].append(length)
            legacy["aq"].append(190 - (idx % 10))
    if tfs:
        parts.append("tf+QQQ:" + ",".join(f"{start + 1}-{length}" for start, length, _name in tfs))
        for idx, (_start, _length, name) in enumerate(tfs):
            aq.extend([215 - (idx % 20), 155, 155])
            names.append(name)

    return ";".join(parts), aq, ",".join(names), legacy


def _set_array_tag(read, tag: str, values: Iterable[int], code: str = "i") -> None:
    vals = list(int(value) for value in values)
    if vals:
        read.set_tag(tag, array(code, vals))


def _write_bam(path: Path, name: str, sequence: str, read_count: int, seed: int) -> None:
    import pysam

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".unsorted.bam")
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": name, "LN": len(sequence)}],
        "RG": [{"ID": "phaseA", "SM": "phaseA"}, {"ID": "phaseB", "SM": "phaseB"}],
    }
    rng = random.Random(seed)
    with pysam.AlignmentFile(tmp_path, "wb", header=header) as out:
        for idx in range(read_count):
            phase = 1 if idx % 2 == 0 else 2
            phase_offset = 0 if phase == 1 else 95
            read = pysam.AlignedSegment()
            read.query_name = f"phased_{'A' if phase == 1 else 'B'}_{idx:04d}"
            read.query_sequence = sequence
            read.flag = 0 if rng.random() > 0.2 else 16
            read.reference_id = 0
            read.reference_start = 0
            read.mapping_quality = 60
            read.cigar = [(0, len(sequence))]
            read.query_qualities = pysam.qualitystring_to_array("I" * len(sequence))
            ma, aq, an, legacy = _read_annotation_layout(len(sequence), phase_offset, idx)
            read.set_tag("MA", ma)
            read.set_tag("AN", an)
            read.set_tag("AQ", array("B", aq))
            read.set_tag("HP", phase)
            read.set_tag("PS", 1)
            read.set_tag("RG", "phaseA" if phase == 1 else "phaseB")
            for tag, values in legacy.items():
                _set_array_tag(read, tag, values, "B" if tag in {"nq", "lq", "rq", "aq"} else "i")
            out.write(read)

    pysam.sort("-o", str(path), str(tmp_path))
    tmp_path.unlink(missing_ok=True)
    pysam.index(str(path))


def generate_fixture(
    out_dir: Path,
    *,
    name: str = DEFAULT_NAME,
    length: int = DEFAULT_LENGTH,
    read_count: int = 96,
    seed: int = 7,
    plasmid_map: Path | None = None,
) -> FixturePaths:
    rng = random.Random(seed)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    source_copy: Path | None = None
    if plasmid_map:
        parsed = parse_plasmid_map(str(plasmid_map))
        name = parsed.name
        sequence = parsed.sequence.upper()
        features = parsed.features or _default_features(len(sequence))
        source_copy = out_dir / Path(plasmid_map).name
        if Path(plasmid_map).resolve() != source_copy.resolve():
            shutil.copy2(plasmid_map, source_copy)
    else:
        sequence = _synthetic_sequence(length, rng)
        features = _default_features(len(sequence))

    plasmid = PlasmidMap(name=name, sequence=sequence, circular=True, features=features)
    genbank_path = out_dir / f"{name}.gbk"
    fasta_path = out_dir / f"{name}.fa"
    bam_path = out_dir / f"{name}.phased.bam"
    manifest_path = out_dir / "manifest.json"

    _write_genbank(genbank_path, plasmid)
    _write_fasta(fasta_path, name, sequence)
    _write_bam(bam_path, name, sequence, read_count, seed)

    manifest = {
        "name": name,
        "length": len(sequence),
        "reads": read_count,
        "plasmid_map": str(genbank_path),
        "source_map": str(source_copy) if source_copy else None,
        "fasta": str(fasta_path),
        "bam": str(bam_path),
        "bai": str(bam_path) + ".bai",
        "suggested_launch": f"python browser.py -b {bam_path} --no-open --copilot off",
        "suggested_load_plasmid_path": str(genbank_path),
        "wrap_test_region": f"{name}:{max(0, len(sequence) - 250)}-{len(sequence) + 250}",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return FixturePaths(
        out_dir=out_dir,
        plasmid_map=genbank_path,
        fasta=fasta_path,
        bam=bam_path,
        bai=Path(str(bam_path) + ".bai"),
        manifest=manifest_path,
        source_map=source_copy,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=Path("/tmp/fiberbrowser-circular-fixture"))
    parser.add_argument("--plasmid-map", type=Path, default=None, help="Optional .dna/.gbk/.fa plasmid map to seed the fixture.")
    parser.add_argument("--name", default=DEFAULT_NAME, help="Reference name for synthetic-only generation.")
    parser.add_argument("--length", type=int, default=DEFAULT_LENGTH, help="Synthetic plasmid length when --plasmid-map is not supplied.")
    parser.add_argument("--reads", type=int, default=96, help="Number of full-length synthetic reads.")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    paths = generate_fixture(
        args.out_dir,
        name=args.name,
        length=args.length,
        read_count=args.reads,
        seed=args.seed,
        plasmid_map=args.plasmid_map,
    )
    print(paths.manifest)
    print(paths.manifest.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
