"""Write the synthetic two-SNP Fiber-seq BAM (tests/snp_fixtures.py) to a fresh path (and its FASTA beside it).

usage: python tests/make_snp_demo_bam.py <out.bam> [--fasta]
"""
from pathlib import Path
import sys

# This folder (snp_fixtures) and tests/ (sv_fixtures, which it builds on).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from snp_fixtures import write_snp_bam, write_snp_fasta  # noqa: E402


def main():
    out = Path(sys.argv[1])
    if out.exists():
        raise ValueError("Use a fresh test BAM path")
    write_snp_bam(out)
    if "--fasta" in sys.argv[2:]:
        write_snp_fasta(out.with_suffix(".fa"))


if __name__ == "__main__":
    main()
