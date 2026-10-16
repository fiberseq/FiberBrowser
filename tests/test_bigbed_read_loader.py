"""Regression tests for legacy BigBed read-table and mark loaders."""

import pandas as pd

from services import bigbed_read_loader


class FakeBigBed:
    def __init__(self, entries_by_chrom):
        self.entries_by_chrom = entries_by_chrom

    def chroms(self):
        return {chrom: 100000 for chrom in self.entries_by_chrom}

    def entries(self, chrom, start, end):
        return [
            (entry_start, entry_end, rest)
            for entry_start, entry_end, rest in self.entries_by_chrom.get(chrom, [])
            if entry_end > start and entry_start < end
        ]


def bed12_rest(read_id, block_sizes, block_starts, *extra_columns):
    columns = [
        read_id,
        "0",
        "+",
        "0",
        "0",
        "0",
        str(len(block_sizes)),
        ",".join(str(v) for v in block_sizes) + ",",
        ",".join(str(v) for v in block_starts) + ",",
    ]
    columns.extend(extra_columns)
    return "\t".join(columns)


def test_build_rd_fast_signed_builds_dense_signed_read_table():
    bed_df = pd.DataFrame(
        [{
            "chrom": "chr2L",
            "start": 100,
            "end": 170,
            "name": "read1",
            "blockCount": "2",
            "blockSizes": "10,20,",
            "blockStarts": "0,50,",
        }]
    )

    result = bigbed_read_loader.build_rd_fast_signed(
        bed_df,
        "chr2L",
        100,
        180,
        spanning_only=False,
    )

    assert result.loc[0, "read_id"] == "read1"
    assert set(result.loc[0, 100:109]) == {10}
    assert set(result.loc[0, 110:149]) == {-40}
    assert set(result.loc[0, 150:169]) == {20}


def test_load_reads_from_bigbed_loads_dense_signed_read_table():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 170, bed12_rest("read1", [10, 20], [0, 50])),
        ],
    })

    result = bigbed_read_loader.load_reads_from_bigbed(
        ["reads.bb"],
        "2L",
        100,
        180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: fake_bigbed,
        format_cache={},
    )

    assert result["read_id"].tolist() == ["read1"]


def test_load_reads_from_bigbed_diagnostics_are_opt_in(capsys, monkeypatch):
    monkeypatch.delenv(bigbed_read_loader.BIGBED_DIAGNOSTICS_ENV, raising=False)

    result = bigbed_read_loader.load_reads_from_bigbed(
        ["broken.bb"],
        "2L",
        100,
        180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: (_ for _ in ()).throw(RuntimeError("boom")),
        format_cache={},
    )

    assert result.empty
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(bigbed_read_loader.BIGBED_DIAGNOSTICS_ENV, "1")
    result = bigbed_read_loader.load_reads_from_bigbed(
        ["broken.bb"],
        "2L",
        100,
        180,
        spanning_only=False,
        bigbed_handle_getter=lambda _path: (_ for _ in ()).throw(RuntimeError("boom")),
        format_cache={},
    )

    assert result.empty
    assert "Failed to read BigBed broken.bb: boom" in capsys.readouterr().out


def test_load_methyl_from_bigbed_handles_deam_and_mod_marks():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 120, bed12_rest("read1", [2, 2], [5, 10], "1,0,")),
        ],
    })

    direct_deam = bigbed_read_loader.load_methyl_from_bigbed(
        "deam.bb",
        "2L",
        100,
        115,
        layer_type="deam",
        bigbed_handle_getter=lambda _path: fake_bigbed,
    )
    direct_m6a = bigbed_read_loader.load_methyl_from_bigbed(
        "m6a.bb",
        "2L",
        100,
        115,
        layer_type="m6a",
        bigbed_handle_getter=lambda _path: fake_bigbed,
    )

    assert direct_deam == {"read1": [[5, 1], [6, 1], [10, 0], [11, 0]]}
    assert direct_m6a == {"read1": [5, 6, 10, 11]}


def test_load_methyl_from_bigbed_diagnostics_are_opt_in(capsys, monkeypatch):
    monkeypatch.delenv(bigbed_read_loader.BIGBED_DIAGNOSTICS_ENV, raising=False)

    result = bigbed_read_loader.load_methyl_from_bigbed(
        "broken.bb",
        "2L",
        100,
        115,
        bigbed_handle_getter=lambda _path: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    assert result == {}
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(bigbed_read_loader.BIGBED_DIAGNOSTICS_ENV, "1")
    result = bigbed_read_loader.load_methyl_from_bigbed(
        "broken.bb",
        "2L",
        100,
        115,
        bigbed_handle_getter=lambda _path: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    assert result == {}
    assert "Error loading methyl from companion BigBed broken.bb: boom" in capsys.readouterr().out


def test_load_methyl_from_bigbed_skips_ddda_mcg_spans_in_m5c():
    fake_bigbed = FakeBigBed({
        "chr2L": [
            (100, 140, bed12_rest("native", [1, 1], [5, 20], "200,180,")),
            (100, 140, bed12_rest("ddda", [12, 1], [2, 30], "0,0,")),
        ],
    })
    marks = bigbed_read_loader.load_methyl_from_bigbed(
        "m5c.bb", "2L", 100, 140, layer_type="m5c", bigbed_handle_getter=lambda _path: fake_bigbed)
    assert marks == {"native": [5, 20]}
