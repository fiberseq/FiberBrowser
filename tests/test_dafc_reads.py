"""Smoke tests for browser/services/dafc_reads.py.

Heavy I/O paths (BAM/BigBed parsing) are mocked at the boundary; the goal is
to verify the helpers' wiring and the pure numeric `build_read_footprint_array`.
"""

from __future__ import annotations

import numpy as np
import pytest

from models.domain import ContactMode
from services import dafc_reads


# ---------------------------------------------------------------------------
# get_base_read_id
# ---------------------------------------------------------------------------

def test_get_base_read_id_strips_numeric_suffix():
    assert dafc_reads.get_base_read_id("read123_1") == "read123"
    assert dafc_reads.get_base_read_id("abc_42") == "abc"


def test_get_base_read_id_keeps_non_numeric_suffix():
    assert dafc_reads.get_base_read_id("read_abc") == "read_abc"
    assert dafc_reads.get_base_read_id("plain") == "plain"


def test_get_base_read_id_handles_multiple_underscores():
    # Only the last segment is split — earlier underscores are preserved.
    assert dafc_reads.get_base_read_id("foo_bar_3") == "foo_bar"


# ---------------------------------------------------------------------------
# query_bigbed_for_dafc — BigBed boundary mocked
# ---------------------------------------------------------------------------

class _FakeBB:
    def __init__(self, chroms_dict, entries_by_chrom):
        self._chroms = chroms_dict
        self._entries = entries_by_chrom

    def chroms(self):
        return self._chroms

    def entries(self, chrom, start, end):
        return self._entries.get(chrom)


def test_query_bigbed_for_dafc_returns_empty_for_none_handle():
    assert dafc_reads.query_bigbed_for_dafc(None, "chr1", 0, 1000) == []


def test_query_bigbed_for_dafc_handles_chrom_aliases():
    # Caller passes chr2R but the file uses 2R — should normalize.
    bb = _FakeBB(
        {"2R": 25_000_000},
        {"2R": [(100, 200, "read1\t30\t+\t100\t200\t0,128,0\t2\t10,20,\t0,80,")]},
    )
    rows = dafc_reads.query_bigbed_for_dafc(bb, "chr2R", 0, 1000)
    assert len(rows) == 1
    row = rows[0]
    assert row["chrom"] == "2R"
    assert row["start"] == 100
    assert row["end"] == 200
    assert row["name"] == "read1"
    assert row["strand"] == "+"
    assert row["blockCount"] == 2
    assert row["blockSizes"] == "10,20,"
    assert row["blockStarts"] == "0,80,"


def test_query_bigbed_for_dafc_returns_empty_when_chrom_missing():
    bb = _FakeBB({"2L": 0}, {})
    assert dafc_reads.query_bigbed_for_dafc(bb, "chr3R", 0, 1000) == []


def test_query_bigbed_for_dafc_returns_empty_when_no_entries():
    bb = _FakeBB({"2R": 100}, {"2R": None})
    assert dafc_reads.query_bigbed_for_dafc(bb, "2R", 0, 100) == []


def test_query_bigbed_for_dafc_swallows_query_errors_quietly_by_default(capsys, monkeypatch):
    monkeypatch.delenv(dafc_reads.DAFC_DIAGNOSTICS_ENV, raising=False)

    class BoomBB(_FakeBB):
        def entries(self, chrom, start, end):
            raise RuntimeError("kaboom")

    bb = BoomBB({"2R": 0}, {})
    rows = dafc_reads.query_bigbed_for_dafc(bb, "2R", 0, 100)
    assert rows == []
    captured = capsys.readouterr()
    assert captured.out == ""


def test_query_bigbed_for_dafc_logs_query_errors_when_diagnostics_enabled(capsys, monkeypatch):
    monkeypatch.setenv(dafc_reads.DAFC_DIAGNOSTICS_ENV, "1")

    class BoomBB(_FakeBB):
        def entries(self, chrom, start, end):
            raise RuntimeError("kaboom")

    bb = BoomBB({"2R": 0}, {})
    rows = dafc_reads.query_bigbed_for_dafc(bb, "2R", 0, 100)
    assert rows == []
    captured = capsys.readouterr()
    assert "Error querying BigBed" in captured.out


def test_query_bigbed_for_dafc_handles_short_field_rows():
    # Entries with only a few tab-separated fields shouldn't crash; missing
    # fields fall back to defaults.
    bb = _FakeBB({"2R": 0}, {"2R": [(10, 20, "only_name")]})
    rows = dafc_reads.query_bigbed_for_dafc(bb, "2R", 0, 100)
    assert rows[0]["name"] == "only_name"
    assert rows[0]["score"] == "0"
    assert rows[0]["strand"] == "+"
    assert rows[0]["blockCount"] == 0


# ---------------------------------------------------------------------------
# query_bam_for_dafc — accepts missing files quietly
# ---------------------------------------------------------------------------

def test_query_bam_for_dafc_returns_empty_when_path_missing(tmp_path):
    missing = tmp_path / "absent.bam"
    assert dafc_reads.query_bam_for_dafc(str(missing), "chr1", 0, 100) == []


def test_query_bam_for_dafc_returns_empty_for_blank_path():
    assert dafc_reads.query_bam_for_dafc("", "chr1", 0, 100) == []


# ---------------------------------------------------------------------------
# detect_contact_mode
# ---------------------------------------------------------------------------

def test_detect_contact_mode_dafc_when_shared_ratio_above_threshold():
    x = [{"name": "r1_1"}, {"name": "r2_1"}, {"name": "r3_1"}]
    y = [{"name": "r1_2"}, {"name": "r2_2"}, {"name": "r4_1"}]
    # Shared base ids: r1, r2 (2 of 4 total) → 0.5 > default 0.1 threshold.
    assert dafc_reads.detect_contact_mode(x, y) is ContactMode.DAFC


def test_detect_contact_mode_microc_when_no_shared_reads():
    x = [{"name": "r1_1"}]
    y = [{"name": "r2_1"}]
    assert dafc_reads.detect_contact_mode(x, y) is ContactMode.MICROC


def test_detect_contact_mode_microc_when_both_sides_empty():
    assert dafc_reads.detect_contact_mode([], []) is ContactMode.MICROC


def test_detect_contact_mode_threshold_respected():
    # 1 of 5 shared = 0.2 — above 0.1 default but below custom 0.5.
    x = [{"name": f"r{i}_1"} for i in range(3)]  # r0, r1, r2
    y = [{"name": "r0_2"}, {"name": "r9_1"}, {"name": "r8_1"}]  # only r0 shared
    assert dafc_reads.detect_contact_mode(x, y, threshold=0.5) is ContactMode.MICROC
    assert dafc_reads.detect_contact_mode(x, y, threshold=0.1) is ContactMode.DAFC


# ---------------------------------------------------------------------------
# find_ligated_reads
# ---------------------------------------------------------------------------

def test_find_ligated_reads_pairs_segments_by_base_id(monkeypatch):
    fake_x = [{"name": "rA_1", "start": 100, "end": 150}]
    fake_y = [{"name": "rA_2", "start": 500, "end": 550}, {"name": "rB_1", "start": 600, "end": 650}]

    def fake_query(chrom, start, end, state=None, dafc_state=None):
        if start == 100:
            return fake_x
        if start == 500:
            return fake_y
        return []

    monkeypatch.setattr(dafc_reads, "query_reads_for_dafc", fake_query)
    ligated = dafc_reads.find_ligated_reads("chr1", 100, 200, 500, 700)
    assert len(ligated) == 1
    assert ligated[0]["read_id"] == "rA"
    assert ligated[0]["x_segments"] == fake_x
    assert ligated[0]["y_segments"] == [fake_y[0]]


def test_find_ligated_reads_empty_when_no_matches(monkeypatch):
    monkeypatch.setattr(dafc_reads, "query_reads_for_dafc", lambda *a, **k: [])
    assert dafc_reads.find_ligated_reads("chr1", 0, 100, 200, 300) == []


# ---------------------------------------------------------------------------
# build_read_footprint_array — pure numeric
# ---------------------------------------------------------------------------

def test_build_read_footprint_array_empty_segments():
    arr = dafc_reads.build_read_footprint_array([], region_start=0, region_end=100)
    assert arr.shape == (100,)
    assert arr.dtype == np.int32
    assert np.all(arr == 0)


def test_build_read_footprint_array_marks_footprints_and_gaps():
    # One segment 0..100 with two footprints: 10..30 (size 20) and 60..80 (size 20).
    # The gaps 0..10, 30..60, 80..100 should be filled with -gap_size.
    seg = {
        "start": 0,
        "end": 100,
        "blockSizes": "20,20,",
        "blockStarts": "10,60,",
    }
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    assert arr.shape == (100,)
    # Footprint blocks
    assert np.all(arr[10:30] == 20)
    assert np.all(arr[60:80] == 20)
    # Leading gap (size 10)
    assert np.all(arr[0:10] == -10)
    # Middle gap (size 30)
    assert np.all(arr[30:60] == -30)
    # Trailing gap (size 20)
    assert np.all(arr[80:100] == -20)


def test_build_read_footprint_array_skips_segment_with_malformed_blocks():
    # Non-numeric block sizes should be ignored without crashing.
    seg = {
        "start": 0,
        "end": 100,
        "blockSizes": "abc,",
        "blockStarts": "10,",
    }
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    assert arr.shape == (100,)
    assert np.all(arr == 0)


def test_build_read_footprint_array_handles_segment_outside_region():
    # Segment lives at 200..300 but caller asks about 0..100 — output stays zero.
    seg = {
        "start": 200,
        "end": 300,
        "blockSizes": "20,",
        "blockStarts": "10,",
    }
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    assert arr.shape == (100,)
    assert np.all(arr == 0)


def test_build_read_footprint_array_clips_segment_partially_in_region():
    # Segment at 50..150 with footprint at 60..80; region is 0..100.
    seg = {
        "start": 50,
        "end": 150,
        "blockSizes": "20,",
        "blockStarts": "10,",  # 10bp into segment → absolute 60..80
    }
    arr = dafc_reads.build_read_footprint_array([seg], region_start=0, region_end=100)
    # The footprint at 60..80 should be visible.
    assert np.all(arr[60:80] == 20)
    # Outside footprint within visible region — gap markers (negative) are fine,
    # we just assert the footprint region is correct without over-specifying.
