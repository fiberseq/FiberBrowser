"""Tests for BAM-spec chemistry discovery used by family scanning."""
from __future__ import annotations

import pysam
from pathlib import Path

from services.chemistry_metadata import (
    family_scan_chemistry,
    inspect_bam_chemistry,
    inspect_dataset_chemistry,
)


def _write_empty_bam(path, *, comments=(), programs=(), read_groups=()):
    header = {
        "HD": {"VN": "1.6"},
        "SQ": [{"SN": "chr1", "LN": 1000}],
        "CO": list(comments),
        "PG": list(programs),
        "RG": list(read_groups),
    }
    with pysam.AlignmentFile(path, "wb", header=header):
        pass


def test_explicit_v1_declaration_is_authoritative(tmp_path):
    path = tmp_path / "misleading_dddb_name.bam"
    _write_empty_bam(path, comments=[
        (
            "FIBERHMM-CHEMISTRY:v1:assay=fiber-seq;enzyme=hia5;"
            "platform=pacbio;mode=pacbio-fiber;model=hia5_recall"
        ),
    ])

    result = inspect_bam_chemistry(str(path))

    assert result["chemistry"] == "hia5-pacbio"
    assert result["status"] == "declared"
    assert result["source"] == "declared-v1"


def test_semantically_inconsistent_declaration_does_not_select_a_model():
    assert family_scan_chemistry({
        "assay": "daf",
        "enzyme": "hia5",
        "platform": "pacbio",
        "mode": "daf",
    }) is None
    assert family_scan_chemistry({
        "assay": "fiber-seq",
        "enzyme": "hia5",
        "platform": "pacbio",
        "mode": "nanopore-fiber",
    }) is None


def test_legacy_fiberhmm_pg_remains_compatible(tmp_path):
    path = tmp_path / "legacy.bam"
    _write_empty_bam(path, programs=[{
        "ID": "fiberhmm-call",
        "PN": "fiberhmm-call",
        "DS": "FiberHMM; mode=daf enzyme=ddda recall_nucs=True",
        "CL": "fiberhmm-call --enzyme ddda --seq pacbio -i in.bam -o out.bam",
    }])

    result = inspect_bam_chemistry(str(path))

    assert result["chemistry"] == "ddda"
    assert result["status"] == "inferred"
    assert result["source"] == "legacy-fiberhmm-pg"


def test_combined_dataset_rejects_mixed_declared_chemistry(tmp_path):
    ddda = tmp_path / "ddda.bam"
    fiber = tmp_path / "fiber.bam"
    _write_empty_bam(ddda, comments=[
        "FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf",
    ])
    _write_empty_bam(fiber, comments=[
        (
            "FIBERHMM-CHEMISTRY:v1:assay=fiber-seq;enzyme=hia5;"
            "platform=pacbio;mode=pacbio-fiber"
        ),
    ])

    result = inspect_dataset_chemistry([str(ddda), str(fiber)])

    assert result["chemistry"] is None
    assert result["status"] == "conflict"


def test_combined_dataset_does_not_ignore_uninspected_remote_component(tmp_path):
    local = tmp_path / "ddda.bam"
    _write_empty_bam(local, comments=[
        "FIBERHMM-CHEMISTRY:v1:assay=daf;enzyme=ddda;platform=pacbio;mode=daf",
    ])

    result = inspect_dataset_chemistry([
        str(local), "https://example.org/second-library.bam",
    ])

    assert result["chemistry"] is None
    assert result["status"] == "incomplete"


def test_fibertools_and_read_group_supply_narrow_header_fallback(tmp_path):
    path = tmp_path / "raw_fiber.bam"
    _write_empty_bam(
        path,
        programs=[{"ID": "ft", "PN": "fibertools", "CL": "ft predict-m6a in.bam out.bam"}],
        read_groups=[{"ID": "movie", "PL": "PACBIO"}],
    )

    result = inspect_bam_chemistry(str(path))

    assert result["chemistry"] == "hia5-pacbio"
    assert result["status"] == "inferred"
    assert result["source"] == "header-heuristic"


def test_save_bam_chemistry_preserves_records_header_and_indexes(tmp_path):
    from services.chemistry_metadata import save_bam_chemistry
    path = tmp_path / 'input.bam'
    header = {'HD': {'VN': '1.6', 'SO': 'coordinate'}, 'SQ': [{'SN': 'chr1', 'LN': 1000}],
              'CO': ['unrelated comment'], 'RG': [{'ID': 'rg', 'PL': 'PACBIO'}],
              'PG': [{'ID': 'original', 'PN': 'original'}]}
    with pysam.AlignmentFile(path, 'wb', header=header) as out:
        read = pysam.AlignedSegment(out.header)
        read.query_name = 'molecule'; read.query_sequence = 'ACGT' * 10
        read.flag = 0; read.reference_id = 0; read.reference_start = 100
        read.mapping_quality = 60; read.cigarstring = '40M'
        read.query_qualities = pysam.qualitystring_to_array('I' * 40)
        read.set_tag('XX', 'preserved'); out.write(read)
    pysam.index(str(path))
    # Both supported index naming conventions must be updated.
    pysam.index('-c', '-o', str(path.with_suffix('.csi')), str(path))
    with pysam.AlignmentFile(path, 'rb') as bam:
        before = [read.to_string() for read in bam]
        old_header = bam.header.to_dict()
    save_bam_chemistry([str(path)], 'ddda')
    with pysam.AlignmentFile(path, 'rb') as bam:
        assert [read.to_string() for read in bam] == before
        new_header = bam.header.to_dict()
    for key in ('HD', 'SQ', 'RG', 'PG'):
        assert new_header[key] == old_header[key]
    assert new_header['CO'][0] == 'unrelated comment'
    assert new_header['CO'][1].startswith('FIBERHMM-CHEMISTRY:v1:')
    for index in (str(path)+'.bai', str(path.with_suffix('.csi'))):
        with pysam.AlignmentFile(path, 'rb', index_filename=index) as bam:
            assert len(list(bam.fetch('chr1', 100, 140))) == 1
    result = inspect_dataset_chemistry([str(path)])
    assert result['chemistry'] == 'ddda'
    assert result['source'] == 'declared-v1'
    assert result['files'][0]['declaration']['platform'] == 'pacbio'
    saved = path.read_bytes()
    save_bam_chemistry([str(path)], 'ddda')
    assert path.read_bytes() == saved
    assert not list(tmp_path.glob('*.json'))


def test_save_bam_conflict_keeps_all_sources_unchanged(tmp_path):
    import pytest
    from services.chemistry_metadata import save_bam_chemistry
    first, second = tmp_path / 'first.bam', tmp_path / 'second.bam'
    _write_empty_bam(first)
    _write_empty_bam(second, comments=['FIBERHMM-CHEMISTRY:v1:assay=fiber-seq;enzyme=hia5;platform=pacbio;mode=pacbio-fiber'])
    before = [path.read_bytes() for path in (first, second)]
    with pytest.raises(ValueError, match='incompatible'):
        save_bam_chemistry([str(first), str(second)], 'ddda', 'pacbio')
    assert [path.read_bytes() for path in (first, second)] == before
    assert not list(tmp_path.glob('.fiberbrowser-header-*'))


def test_save_bam_install_failure_restores_original(tmp_path, monkeypatch):
    import pytest
    import services.chemistry_metadata as metadata
    path = tmp_path / 'input.bam'
    _write_empty_bam(path)
    pysam.index(str(path))
    original, index = path.read_bytes(), Path(str(path)+'.bai').read_bytes()
    replace = metadata.os.replace
    def fail_install(source, target):
        if Path(source).name.startswith('index-'):
            raise OSError('simulated installation failure')
        return replace(source, target)
    monkeypatch.setattr(metadata.os, 'replace', fail_install)
    with pytest.raises(OSError, match='simulated'):
        metadata.save_bam_chemistry([str(path)], 'ddda', 'pacbio')
    assert path.read_bytes() == original
    assert Path(str(path)+'.bai').read_bytes() == index


def test_save_bam_rejects_remote_and_missing_files(tmp_path):
    import pytest
    from services.chemistry_metadata import save_bam_chemistry
    for path in ('https://example.org/test.bam', str(tmp_path / 'missing.bam')):
        with pytest.raises(ValueError):
            save_bam_chemistry([path], 'ddda')


def test_without_fiberhmm_chemistry_is_unavailable_with_install_help(tmp_path, monkeypatch):
    # Before: the ImportError escaped and dataset registration recorded a raw
    # "No module named 'fiberhmm'" as an "unknown" chemistry.
    import builtins
    import sys
    path = tmp_path / "x.bam"
    _write_empty_bam(path)
    real_import = builtins.__import__

    def no_fiberhmm(name, *args, **kwargs):
        if name == "fiberhmm" or name.startswith("fiberhmm."):
            raise ImportError("No module named 'fiberhmm'")
        return real_import(name, *args, **kwargs)

    for name in [m for m in sys.modules if m == "fiberhmm" or m.startswith("fiberhmm.")]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setattr(builtins, "__import__", no_fiberhmm)

    result = inspect_bam_chemistry(str(path))
    assert result["status"] == "unavailable"
    assert result["chemistry"] is None
    assert 'fiberhmm[consensus]>=3.0.2,<4' in result["message"]

    combined = inspect_dataset_chemistry([str(path)])
    assert combined["status"] == "unavailable"
    assert 'fiberhmm[consensus]>=3.0.2,<4' in combined["message"]
