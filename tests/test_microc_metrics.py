import pandas as pd

from services.microc_metrics import clear_bin_accessibility_cache, compute_bin_accessibility


class FakeDataset:
    id = "fake"
    data_type = "bam"

    def get_reads(self, chrom, start, end, spanning=False):
        assert chrom == "chr1"
        assert start == 0
        assert end == 10
        assert spanning is False
        return pd.DataFrame({
            "read_id": ["r1", "r2"],
            0: [50, 50],
            1: [50, 50],
            2: [50, 50],
            3: [50, 50],
            4: [50, 50],
            5: [50, 100],
            6: [50, 100],
            7: [50, 100],
            8: [50, 100],
            9: [50, 100],
        })


class FakeState:
    datasets = {"fake": FakeDataset()}


def test_compute_bin_accessibility_aggregates_dataset_reads():
    clear_bin_accessibility_cache()

    accessibility = compute_bin_accessibility("chr1", 0, 10, 5, state=FakeState())

    assert accessibility.tolist() == [0.99, 0.5]
