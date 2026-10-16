"""B5 round 4: session import drops every dataset-keyed read cache; legacy render metaprofiles honor read_ids."""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))

from models.requests import RenderRequest, SessionImportRequest
from services import analysis_query
from services.render_endpoint import _render_sync
from services.sessions_endpoint import import_session_for_request


class _State:
    def __init__(self):
        self.datasets = {"d": SimpleNamespace(id="d")}
        self.dataset_order = ["d"]
        self.modification_overlays = {}
        self.orthogonal_tracks = []
        self._broad_cache = {("d", "chr1"): ([], 0)}
        self._meta_profile_cache = {}
        self._methylation_cache = {("d", "chr1", 0, 100): [{"id": "old-read"}]}
        self._read_strand_calls = {"d": {"old-read": "CT"}}
        self.gtf_data = None
        self.gtf_path = None
        self.current_genome = None
        self.fasta_path = None
        self.fasta = None
        self.annotation_state = SimpleNamespace()

    def add_dataset(self, dataset_id, path_arg, label=None):
        paths = path_arg if isinstance(path_arg, list) else [path_arg]
        ds = SimpleNamespace(id=dataset_id, label=label or dataset_id, paths=paths, color="#000", data_type="bam",
                             layer_type="footprint", available_layers={}, derived_layers={},
                             cluster_assignments={}, cluster_peak_regions=None)
        self.datasets[dataset_id] = ds
        self.dataset_order.append(dataset_id)
        return ds


def test_session_import_clears_methylation_and_strand_caches(tmp_path):
    new_bam = tmp_path / "new.bam"
    new_bam.write_bytes(b"")
    state = _State()
    import_session_for_request(state, SessionImportRequest(session={
        "version": "2.0",
        "datasets": [{"id": "d", "label": "d", "paths": [str(new_bam)]}],
    }))
    assert state._methylation_cache == {}
    assert state._read_strand_calls == {}


def test_legacy_render_metaprofile_uses_the_requested_reads(monkeypatch):
    seen = []

    def fake_build(self, state, dataset_id):
        seen.append((self.read_ids_for_dataset(dataset_id), self.include_methylation, self.include_layers))
        return None

    monkeypatch.setattr(analysis_query.AnalysisReadQuery, "build_working_set", fake_build)
    dataset = SimpleNamespace(id="d")
    state = SimpleNamespace(
        datasets={"d": dataset}, dataset_order=["d"], orthogonal_tracks=[],
        translate_chrom=lambda c: c, get_dataset=lambda d: dataset if d == "d" else None,
        resolve_dataset_id=lambda d=None: "d" if d in (None, "d") else None,
    )
    _render_sync(RenderRequest(chrom="chr1", start=0, end=1000, tracks=["meta"], width=400,
                               dataset_id="d", read_ids=["keep"]), state)
    assert seen == [(["keep"], False, False)]
