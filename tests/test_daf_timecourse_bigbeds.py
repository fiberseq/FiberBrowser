"""Integration smoke tests for daf_timecourse companion BigBeds."""

from pathlib import Path

import pytest

from conftest import UPDATED_BIGBED_DIR, require_data_file
from services import compact_read_loader


pytestmark = pytest.mark.integration

# The per-stage BigBeds live flat in daf_timecourse/bigbed_update/ as
# <stage>_footprint.bb with _tf/_msp companions (the old bigbeds/<stage>/
# directories, which also held _deam.bb, are gone). Set
# FIBERBROWSER_TEST_DATA_DIR (see tests/conftest.py) to run these.
STAGE = "stage_d_recalled"
LAYERS = ("footprint", "tf", "msp")

# Region used during DAF browser testing; has good sna/eve/ftz coverage.
TEST_CHROM = "2R"
TEST_START = 9_975_125
TEST_END = 9_983_365


def _stage_files(name: str) -> list[str]:
    return [require_data_file(UPDATED_BIGBED_DIR / f"{name}_{layer}.bb", f"daf_timecourse {layer} BigBed")
            for layer in LAYERS]


def _stage_dir(name: str, tmp_path: Path) -> Path:
    """One stage's BigBeds on their own (bigbed_update/ holds every stage side by side)."""
    stage_dir = tmp_path / name
    stage_dir.mkdir()
    for path in _stage_files(name):
        (stage_dir / Path(path).name).symlink_to(path)
    return stage_dir


def test_daf_timecourse_companion_bigbeds_load_all_layers(tmp_path):
    dataset_dir = _stage_dir(STAGE, tmp_path)

    reads = compact_read_loader.build_compact_reads_from_bigbed(
        str(dataset_dir),
        TEST_CHROM,
        TEST_START,
        TEST_END,
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc", "tf", "msp"],
    )

    assert reads
    assert any("nuc" in read.get("layers", {}) for read in reads)
    assert any("tf" in read.get("layers", {}) for read in reads)
    assert any("msp" in read.get("layers", {}) for read in reads)


def test_daf_timecourse_directory_and_explicit_file_list_match_read_ids(tmp_path):
    dataset_dir = _stage_dir(STAGE, tmp_path)
    file_list = _stage_files(STAGE)

    from_dir = compact_read_loader.build_compact_reads_from_bigbed(
        str(dataset_dir),
        TEST_CHROM,
        TEST_START,
        TEST_END,
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc", "tf", "msp"],
    )
    from_files = compact_read_loader.build_compact_reads_from_bigbed(
        file_list,
        TEST_CHROM,
        TEST_START,
        TEST_END,
        spanning_only=False,
        include_layers=True,
        requested_layers=["nuc", "tf", "msp"],
    )

    assert {read["id"] for read in from_dir} == {read["id"] for read in from_files}
