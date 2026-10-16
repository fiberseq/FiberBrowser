from types import SimpleNamespace

import pandas as pd

from models.domain import WorkingSet
from models.requests import Pol2COMRequest
from services.pol2_endpoint import pol2_com_for_request


class FakePol2State:
    dataset_order = ["ds1"]

    def __init__(self):
        self.datasets = {"ds1": SimpleNamespace(paths=["reads.bam"])}
        self.gtf_data = {
            "transcripts": pd.DataFrame([
                {
                    "transcript_id": "gene1",
                    "gene_name": "Gene1",
                    "start": 100,
                    "end": 200,
                    "strand": "+",
                }
            ])
        }

    def translate_chrom(self, chrom):
        return chrom

    def get_dataset(self, dataset_id):
        return self.datasets.get(dataset_id)

    def build_working_set(self, dataset_id, chrom, start, end, spanning, *args, **kwargs):
        return WorkingSet(
            [
                {
                    "id": "r1",
                    "intervals": [[0, 300, 150]],
                    "layers": {"tf": {"intervals": [[120, 160, 40]]}},
                }
            ],
            total_overlapping=1,
            total_spanning=1,
            chrom=chrom,
            start=start,
            end=end,
        )


def test_pol2_com_uses_explicit_tf_layer_and_reports_com():
    result = pol2_com_for_request(
        FakePol2State(),
        Pol2COMRequest(
            dataset_ids=["ds1"],
            gene_ids=["gene1"],
            fp_size_min=35,
            fp_size_max=65,
            n_bins=10,
            smoothing_sigma=0,
            sample_seed="seed-pol2",
        ),
        chrom="chr2L",
        start=0,
        end=300,
        spanning=True,
    )

    ds_result = result["results"]["ds1"]
    assert result["sample_seed"] == "seed-pol2"
    assert ds_result["read_ids"] == ["r1"]
    assert ds_result["com_values"] == [0.4]
    assert ds_result["n_bins"] == 10
    assert ds_result["gene_body_size"] == 100
    # Footprint [120, 160) of gene [100, 200) in 10-bp bins: bins 2-5 (half-open).
    assert ds_result["binary_matrix"][0][2:7] == [1, 1, 1, 1, 0]
    # The read is one 300-bp nucleosome: nothing accessible.
    assert all(value == 0.0 for value in ds_result["smoothed_matrix"][0])


def _accessibility_row(read):
    state = FakePol2State()
    state.build_working_set = lambda *a, **k: WorkingSet([read], total_overlapping=1, total_spanning=1,
                                                          chrom="chr2L", start=0, end=300)
    result = pol2_com_for_request(state, Pol2COMRequest(dataset_ids=["ds1"], gene_ids=["gene1"], n_bins=10,
                                                        smoothing_sigma=0), chrom="chr2L", start=0, end=300, spanning=True)
    return result["results"]["ds1"]["smoothed_matrix"][0]


def test_pol2_accessibility_marks_gaps_not_nucleosomes():
    # Nucleosome 0-150, accessible gap 150-300 (negative size), TF footprint for the COM.
    row = _accessibility_row({"id": "r1", "intervals": [[0, 150, 150], [150, 300, -150]],
                              "layers": {"tf": {"intervals": [[120, 160, 40]]}}})
    assert row[:5] == [0.0] * 5 and row[5:] == [1.0] * 5


def test_pol2_accessibility_prefers_the_msp_layer():
    row = _accessibility_row({"id": "r1", "intervals": [[0, 300, 150]],
                              "layers": {"tf": {"intervals": [[120, 160, 40]]},
                                         "msp": {"intervals": [[0, 60, 60]]}}})
    assert row[:2] == [1.0, 1.0] and row[2:] == [0.0] * 8


def test_pol2_accessibility_reads_top_level_fire_calls():
    # A BAM read without layers: its FIRE/MSP calls are at top level.
    row = _accessibility_row({"id": "r1", "intervals": [[0, 300, 150]], "fire": [[0, 60, 200]],
                              "layers": {"tf": {"intervals": [[120, 160, 40]]}}})
    assert row[:2] == [1.0, 1.0] and row[2:] == [0.0] * 8


def test_fire_peak_scans_read_top_level_fire_calls():
    from services.peak_scanning import compute_scan_counts
    reads = [{"id": "r1", "intervals": [[0, 100, 150]], "fire": [[20, 40, 200]]}]
    fire, _ = compute_scan_counts(reads, "fire", 100)
    msp, _ = compute_scan_counts(reads, "msp", 100)
    assert fire.tolist() == msp.tolist() and fire[20:40].sum() == 20 and fire[:20].sum() == 0
