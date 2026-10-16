"""B5 round 9: session chemistry overrides round-trip; figure cart colours stay on their chromosome."""
from types import SimpleNamespace

from models.requests import SessionExportRequest, SessionImportRequest
from services.figure.tracks.reads import _group_on_chrom
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request
from utils.chrom import same_chrom


def _dataset(ds_id, path, chemistry=None, metadata=None):
    return SimpleNamespace(
        id=ds_id, label=ds_id, paths=[path], color="#000", data_type="bam", is_remote=False,
        layer_type="footprint", available_layers={}, derived_layers={},
        cluster_assignments={}, cluster_peak_regions=None,
        family_scan_chemistry=chemistry,
        chemistry_metadata=metadata or {"chemistry": chemistry, "source": "none", "status": "missing"},
    )


class _State:
    def __init__(self, datasets=()):
        self.datasets = {d.id: d for d in datasets}
        self.dataset_order = [d.id for d in datasets]
        self.chroms = [SimpleNamespace(name="chr1")]
        self.modification_overlays = {}
        self.orthogonal_tracks = []
        self.gtf_data = None
        self.gtf_path = None
        self.current_genome = None
        self.fasta_path = None
        self.fasta = None
        self.annotation_state = SimpleNamespace()

    def add_dataset(self, dataset_id, path_arg, label=None):
        paths = path_arg if isinstance(path_arg, list) else [path_arg]
        # As loading does: chemistry comes from the file (here, none declared).
        ds = _dataset(dataset_id, paths[0])
        self.datasets[dataset_id] = ds
        self.dataset_order.append(dataset_id)
        return ds


def test_session_round_trips_a_browser_chosen_chemistry(tmp_path):
    bam = tmp_path / "a.bam"
    bam.write_bytes(b"")
    chosen = {"chemistry": "dddb", "source": "user-selection", "status": "declared",
              "message": "Assay chemistry selected in the Footprints dataset setup tab."}
    exporter = _State([_dataset("a", str(bam), "dddb", chosen)])
    session = build_session_export_for_request(exporter, SessionExportRequest(chrom="chr1", start=0, end=100))["session"]
    assert session["datasets"][0]["family_scan_chemistry"] == "dddb"

    importer = _State()
    out = import_session_for_request(importer, SessionImportRequest(session=session))
    restored = importer.datasets["a"]
    assert restored.family_scan_chemistry == "dddb"
    assert restored.chemistry_metadata["source"] == "user-selection"
    assert out["datasets"][0]["family_scan_chemistry"] == "dddb"


def test_consensus_chemistry_is_the_session_field_and_the_legacy_name_still_restores(tmp_path):
    """family_scan_chemistry (a site-consensus leftover) is now consensus_chemistry; older sessions still load."""
    bam = tmp_path / "a.bam"
    bam.write_bytes(b"")
    chosen = {"chemistry": "dddb", "source": "user-selection", "status": "declared"}
    session = build_session_export_for_request(
        _State([_dataset("a", str(bam), "dddb", chosen)]), SessionExportRequest(chrom="chr1", start=0, end=100),
    )["session"]
    assert session["datasets"][0]["consensus_chemistry"] == "dddb"
    for name in ("consensus_chemistry", "family_scan_chemistry"):
        old = {**session, "datasets": [{k: v for k, v in session["datasets"][0].items()
                                        if k not in ("consensus_chemistry", "family_scan_chemistry")} | {name: "dddb"}]}
        importer = _State()
        out = import_session_for_request(importer, SessionImportRequest(session=old))
        assert importer.datasets["a"].consensus_chemistry == "dddb"
        assert out["datasets"][0]["consensus_chemistry"] == "dddb"


def test_file_declared_chemistry_is_not_frozen_into_the_session(tmp_path):
    bam = tmp_path / "a.bam"
    bam.write_bytes(b"")
    declared = {"chemistry": "ddda", "source": "bam-header", "status": "declared"}
    session = build_session_export_for_request(
        _State([_dataset("a", str(bam), "ddda", declared)]), SessionExportRequest(chrom="chr1", start=0, end=100),
    )["session"]
    assert "family_scan_chemistry" not in session["datasets"][0]
    # An unknown chemistry in a hand-edited session is ignored.
    session["datasets"][0].update(family_scan_chemistry="bogus", chemistry_metadata={"source": "user-selection"})
    importer = _State()
    import_session_for_request(importer, SessionImportRequest(session=session))
    assert importer.datasets["a"].family_scan_chemistry is None


def test_figure_cart_groups_pinned_to_another_chromosome_do_not_apply():
    pinned = {"referenceAbsStart": 1000100, "referenceAbsEnd": 1000250, "referenceChrom": "chr2"}
    assert not _group_on_chrom(pinned, "chr1")
    assert _group_on_chrom(pinned, "2")  # alias-aware, as in the browser
    assert _group_on_chrom({"referenceChrom": "chr2"}, "chr1")  # no position: applies everywhere
    assert _group_on_chrom({"referenceAbsStart": 5}, "chr1")  # no chromosome recorded
    assert same_chrom("chrM", "MT") and not same_chrom("chr1", "chr10")
