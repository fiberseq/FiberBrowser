"""Write the synthetic SV Fiber-seq BAM (tests/sv_fixtures.py) to a fresh path.

usage: python tests/make_sv_demo_bam.py <out.bam>
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sv_fixtures import write_sv_bam  # noqa: E402


def main():
    out = Path(sys.argv[1])
    if out.exists():
        raise ValueError("Use a fresh test BAM path")
    write_sv_bam(out)


if __name__ == "__main__":
    main()
