"""/api/working_set_info's cluster sizes are plain ints (FastAPI can encode them)."""
import numpy as np
from fastapi.encoders import jsonable_encoder

from services import clustering_endpoint
from test_clustering_endpoint import FakeClusterState


def test_cluster_sizes_are_json_encodable():
    state = FakeClusterState()
    # As clustering stores them: labels can be numpy ints.
    state.datasets["ds1"].cluster_assignments = {"read-a": np.int64(0), "read-b": np.int64(1), "read-c": 1}
    payload = clustering_endpoint.get_working_set_info_payload(
        state=state, chrom="chr2R", start=0, end=30, dataset_id="ds1", spanning=False, sample_seed=None)
    assert payload["cluster_sizes"] == {0: 1, 1: 2}
    assert all(type(k) is int and type(v) is int for k, v in payload["cluster_sizes"].items())
    jsonable_encoder(payload)
