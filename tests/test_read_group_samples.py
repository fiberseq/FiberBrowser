"""Read-group sample names on the dataset payload: they match a native dataset with the lifted dataset of its sample."""
from types import SimpleNamespace

import pysam

from services.read_group_samples import read_group_samples


def _bam(path, samples):
    header = {"HD": {"VN": "1.6"}, "SQ": [{"SN": "chrT", "LN": 1000}],
              "RG": [{"ID": f"rg{i}", "SM": s} for i, s in enumerate(samples)]}
    with pysam.AlignmentFile(str(path), "wb", header=header):
        pass
    return str(path)


def test_samples_from_every_file_sorted_and_unique(tmp_path):
    a = _bam(tmp_path / "a.bam", ["sampleB", "sampleA"])
    b = _bam(tmp_path / "b.bam", ["sampleA", "sampleC"])
    ds = SimpleNamespace(data_type="bam_livelift", is_remote=False, paths=[a, b], path=a)
    assert read_group_samples(ds) == ["sampleA", "sampleB", "sampleC"]


def test_no_samples_for_other_data_remote_files_or_missing_files(tmp_path):
    a = _bam(tmp_path / "a.bam", ["sampleA"])
    assert read_group_samples(SimpleNamespace(data_type="bigbed", is_remote=False, paths=[a], path=a)) == []
    assert read_group_samples(SimpleNamespace(data_type="bam", is_remote=True, paths=[a], path=a)) == []
    gone = str(tmp_path / "gone.bam")
    assert read_group_samples(SimpleNamespace(data_type="bam", is_remote=False, paths=[gone], path=gone)) == []
    assert read_group_samples(SimpleNamespace(data_type="bam", is_remote=False, paths=[_bam(tmp_path / "n.bam", [])], path=None)) == []
