from types import SimpleNamespace

from services.read_compile import compile_reads_from_regions


class _FakeWorkingSet:
    def __init__(self, reads):
        self.reads = reads


class _FakeState:
    datasets = {"ds1": SimpleNamespace(available_layers={
        "tf_sr": True,
        "deam": True,
        "deam_opportunity": True,
    })}

    def translate_chrom(self, chrom):
        return chrom

    def build_working_set(self, dataset_id, chrom, start, end, spanning=True, _min_footprints=0, **kwargs):
        assert dataset_id == "ds1"
        assert chrom == "chr2L"
        assert start == 100
        assert end == 200
        assert spanning is True
        assert kwargs["sample_seed"] == "seed-compile"
        assert kwargs["include_methylation"] is True
        assert kwargs["include_layers"] is True
        assert kwargs["requested_layers"] == (
            "deam",
            "deam_opportunity",
            "tf_sr",
        )
        return _FakeWorkingSet([
            {
                "id": "read1",
                "intervals": [[0, 25, 20], [25, 50, -25]],
                "methyl": [10, 80],
                "methyl_m6a": [10],
                "methyl_m5c": [12],
                "deam": [[10, 1], [80, 0]],
                "possible_deam_ct": [10, 80],
                "possible_deam_ga": [20],
                "fire": [[5, 15, 0.8]],
                "qualities": [0.5],
                "layers": {
                    "tf_sr": {
                        "intervals": [[10, 20, 10]],
                        "qualities": [0.9],
                        "quality_names": ["edge"],
                        "annotation_names": ["site_R0"],
                    }
                },
            },
        ])


def test_compile_reads_from_regions_remaps_all_read_payloads():
    result = compile_reads_from_regions(
        _FakeState(),
        [SimpleNamespace(chrom="chr2L", start=100, end=200, label="region")],
        dataset_ids=["ds1"],
        spanning=True,
        max_reads_per_region=10,
        anchor="start",
        target_width=200,
        sample_seed="seed-compile",
        include_deam_opportunities=True,
    )

    read = result["reads"][0]

    assert result["success"] is True
    assert result["n_reads"] == 1
    assert result["target_width"] == 200
    assert result["read_counts"] == [1]
    assert result["regions"][0]["scale"] == 2
    assert read["id"] == "r0_ds1_read1"
    assert read["intervals"] == [[0, 50, 20], [50, 100, -25]]
    assert read["methyl"] == [20, 160]
    assert read["methyl_m6a"] == [20]
    assert read["methyl_m5c"] == [24]
    assert read["deam"] == [[20, 1], [160, 0]]
    assert read["possible_deam_ct"] == [20, 160]
    assert read["possible_deam_ga"] == [40]
    assert read["fire"] == [[10, 30, 0.8]]
    assert read["qualities"] == [0.5]
    assert read["layers"]["tf_sr"]["intervals"] == [[20, 40, 10]]
    assert read["layers"]["tf_sr"]["qualities"] == [0.9]
    assert read["layers"]["tf_sr"]["annotation_names"] == ["site_R0"]


def test_compile_reads_from_regions_applies_per_region_cap():
    class ManyReadState(_FakeState):
        def build_working_set(self, *args, **kwargs):
            return _FakeWorkingSet([
                {"id": f"read{i}", "intervals": [[0, 10, 10]]}
                for i in range(5)
            ])

    result = compile_reads_from_regions(
        ManyReadState(),
        [SimpleNamespace(chrom="chr2L", start=100, end=200, label=None)],
        dataset_ids=["ds1"],
        max_reads_per_region=2,
    )

    assert [read["_original_id"] for read in result["reads"]] == ["read0", "read2"]
    assert result["read_counts"] == [2]
