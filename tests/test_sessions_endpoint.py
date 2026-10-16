from datetime import datetime, timezone
from types import SimpleNamespace

from models.requests import SessionExportRequest, SessionImportRequest
from services import sessions_endpoint
from services.sessions_endpoint import build_session_export_for_request, import_session_for_request


def test_session_export_helper_merges_server_and_frontend_state():
    dataset = SimpleNamespace(
        id="ds1",
        label="Sample 1",
        paths=["/data/sample.bb"],
        color="#123456",
        data_type="bigbed",
        is_remote=False,
        layer_type="tf",
        available_layers={"tf": True},
        derived_layers={"pol2": {"label": "Pol II"}},
        cluster_assignments={"r1": 2},
        cluster_peak_regions=[{"start": 100, "end": 120}],
    )
    state = SimpleNamespace(
        chroms=[SimpleNamespace(name="chr2L")],
        datasets={"ds1": dataset},
        dataset_order=["ds1"],
        modification_overlays={
            "ov1": {"label": "m6A", "path": "/data/m6a.bb", "type": "m6a", "color": "#f00"}
        },
        orthogonal_tracks=[
            {"path": "/data/signal.bw", "label": "Signal"},
            {
                "path": "motif://sequence/GAGA",
                "label": "GAF",
                "format": "custom_motif",
                "category": "motif",
                "counts": {"A": [1], "C": [0], "G": [0], "T": [0]},
                "threshold": 0.8,
                "motif_name": "GAGA",
                "motif_type": "sequence",
                "motif_source": None,
                "render_mode": "annotation",
            },
        ],
        gtf_data={"transcripts": [{"id": "tx1"}]},
        gtf_path="/refs/dm6.gtf",
        current_genome="dm6",
        fasta_path="/refs/dm6.fa",
    )

    export = build_session_export_for_request(
        state,
        SessionExportRequest(
            chrom="chr2R",
            start=10,
            end=20,
            frontend_state={"analysisSampleSeed": "paper-seed"},
        ),
        now=datetime(2026, 5, 5, 12, 30, 0, tzinfo=timezone.utc),
    )

    assert export["filename"] == "fiberhmm_session_20260505_123000.json"
    session = export["session"]
    assert session["timestamp"] == "2026-05-05T12:30:00+00:00"
    assert session["viewport"] == {"chrom": "chr2R", "start": 10, "end": 20}
    assert session["datasets"][0]["derived_layers"] == {"pol2": {"label": "Pol II"}}
    assert session["overlays"][0]["id"] == "ov1"
    assert session["orthogonal_tracks"][1]["motif_name"] == "GAGA"
    assert session["gtf"]["gene_count"] == 1
    assert session["reference"] == {"genome": "dm6", "fasta_path": "/refs/dm6.fa"}
    assert session["clustering"]["ds1"]["assignments"] == {"r1": 2}
    assert session["frontend"] == {"analysisSampleSeed": "paper-seed"}


def test_session_export_preserves_contact_source_but_not_live_linked_sessions():
    state = SimpleNamespace(
        chroms=[SimpleNamespace(name="chr2L")], datasets={}, dataset_order=[],
        modification_overlays={}, orthogonal_tracks=[], gtf_data=None,
        current_genome=None, fasta_path=None,
    )
    dafc = SimpleNamespace(
        cool_file="/data/contacts.mcool", bigbed_file="/data/reads.bb",
        current_resolution=5000, linked_sessions={"linked-1": {"version": 3}},
    )
    exported = build_session_export_for_request(
        state, SessionExportRequest(), dafc_state=dafc,
        now=datetime(2026, 5, 5, tzinfo=timezone.utc),
    )["session"]
    assert exported["contact_map"] == {
        "cool_file": "/data/contacts.mcool",
        "bigbed_file": "/data/reads.bb",
        "current_resolution": 5000,
    }

def test_session_export_helper_uses_viewport_defaults():
    state = SimpleNamespace(
        chroms=[SimpleNamespace(name="chr2L")],
        datasets={},
        dataset_order=[],
        modification_overlays={},
        orthogonal_tracks=[],
        gtf_data=None,
        current_genome=None,
        fasta_path=None,
    )

    session = build_session_export_for_request(
        state,
        SessionExportRequest(),
        now=datetime(2026, 5, 5, tzinfo=timezone.utc),
    )["session"]

    assert session["viewport"] == {"chrom": "chr2L", "start": 0, "end": 10000}
    assert session["datasets"] == []
    assert "frontend" not in session
    assert "clustering" not in session


class _ImportState:
    def __init__(self):
        self.datasets = {"old": SimpleNamespace(id="old")}
        self.dataset_order = ["old"]
        self.modification_overlays = {"old": {"label": "old"}}
        self.orthogonal_tracks = [{"path": "old"}]
        self._broad_cache = {"old": ([], 0)}
        self._meta_profile_cache = {"old": []}
        self.gtf_data = None
        self.gtf_path = None
        self.current_genome = None
        self.fasta_path = None
        self.fasta = None
        self.annotation_state = SimpleNamespace()

    def add_dataset(self, dataset_id, path_arg, label=None):
        paths = path_arg if isinstance(path_arg, list) else [path_arg]
        dataset = SimpleNamespace(
            id=dataset_id,
            label=label or dataset_id,
            paths=paths,
            color="#000000",
            data_type="bigbed",
            layer_type="footprint",
            available_layers={"footprint": True},
            derived_layers={},
            cluster_assignments={},
            cluster_peak_regions=None,
        )
        self.datasets[dataset_id] = dataset
        self.dataset_order.append(dataset_id)
        return dataset

    def _load_fasta(self, fasta_path):
        self.fasta_path = fasta_path
        self.fasta = {"path": fasta_path}
        return None


def test_import_session_helper_restores_session_state(tmp_path, monkeypatch):
    state = _ImportState()
    overlay = tmp_path / "overlay.bb"
    overlay.write_text("overlay")
    track = tmp_path / "track.bw"
    track.write_text("track")
    gtf = tmp_path / "genes.gtf"
    gtf.write_text("gtf")
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    monkeypatch.setattr(sessions_endpoint, "load_gtf", lambda path: {"transcripts": [{"path": path}]})
    import services.tracks_endpoint as tracks_endpoint

    def fake_add_track(st, *, path, label=None, **settings):
        st.orthogonal_tracks.append({"path": path, "label": label, **{k: v for k, v in settings.items() if v}})
        return {"success": True}

    monkeypatch.setattr(tracks_endpoint, "add_track_for_request", fake_add_track)

    result = import_session_for_request(
        state,
        SessionImportRequest(session={
            "version": "2.0",
            "viewport": {"chrom": "chr2L", "start": 10, "end": 20},
            "datasets": [{"id": "ds1", "label": "Sample 1", "paths": [str(track)], "color": "#abcdef"}],
            "overlays": [
                {"id": "ov1", "label": "m6A", "path": str(overlay), "type": "m6a", "color": "#f00"},
                {"id": "missing", "label": "missing", "path": str(tmp_path / "missing.bb")},
            ],
            "orthogonal_tracks": [
                {"path": str(track), "label": "Signal"},
                {
                    "path": "motif://sequence/GAGA",
                    "label": "GAF",
                    "format": "custom_motif",
                    "counts": {"A": [1, 0], "C": [0, 1], "G": [0, 0], "T": [0, 0]},
                    "motif_name": "GAGA",
                    "motif_type": "sequence",
                },
            ],
            "gtf": {"path": str(gtf)},
            "reference": {"genome": "dm6", "fasta_path": str(fasta)},
            "clustering": {"ds1": {"assignments": {"r1": 1}, "peak_regions": [{"start": 1}]}},
            "frontend": {"analysisSampleSeed": "paper-seed"},
        }),
    )

    assert result["success"] is True
    assert result["results"]["datasets_loaded"] == 1
    assert result["results"]["overlays_loaded"] == 1
    assert result["results"]["overlays_failed"] == [{"id": "missing", "error": "File not found"}]
    assert result["results"]["clustering_restored"] is True
    assert result["viewport"] == {"chrom": "chr2L", "start": 10, "end": 20}
    assert result["datasets"][0]["id"] == "ds1"
    assert result["datasets"][0]["color"] == "#abcdef"
    assert result["overlays"][0]["id"] == "ov1"
    assert len(state.orthogonal_tracks) == 2
    assert state.orthogonal_tracks[1]["motif_name"] == "GAGA"
    assert "pssm" in state.orthogonal_tracks[1]
    assert state.gtf_data == {"transcripts": [{"path": str(gtf)}]}
    assert state.current_genome == "dm6"
    assert state.fasta == {"path": str(fasta)}
    assert state.datasets["ds1"].cluster_assignments == {"r1": 1}
    assert state._broad_cache == {}
    assert state._meta_profile_cache == {}
    assert result["frontend"] == {"analysisSampleSeed": "paper-seed"}


def test_import_session_does_not_replace_live_linked_session_registry():
    state = _ImportState()
    dafc = SimpleNamespace(linked_sessions={"live": {"version": 7}})

    import_session_for_request(
        state,
        SessionImportRequest(session={
            "version": "2.0",
            "contact_map": {
                "cool_file": "/stale/contacts.mcool",
                "linked_sessions": {"stale": {"version": 1}},
            },
        }),
        dafc_state=dafc,
    )

    assert dafc.linked_sessions == {"live": {"version": 7}}


def test_import_session_reports_missing_annotations_and_returns_only_restored_files(tmp_path):
    state = _ImportState()
    present = tmp_path / "annotations.bb"
    present.write_text("placeholder")

    result = import_session_for_request(
        state,
        SessionImportRequest(session={
            "version": "2.0",
            "annotations": {
                "files": [
                    {"id": "present", "path": str(present), "label": "Present", "active": True},
                    {"id": "missing", "path": str(tmp_path / "missing.bb"), "label": "Missing"},
                ],
            },
        }),
    )

    assert result["results"]["annotations_failed"] == [
        {"id": "missing", "error": "File not found"}
    ]
    assert [item["id"] for item in result["annotations"]] == ["present"]


def test_import_session_helper_validates_empty_and_unsupported_sessions():
    state = _ImportState()

    assert import_session_for_request(state, SessionImportRequest(session={})) == {
        "success": False,
        "error": "Empty session data",
    }
    assert import_session_for_request(state, SessionImportRequest(session={"version": "9.9"})) == {
        "success": False,
        "error": "Unsupported session version: 9.9",
    }


def _reference_state():
    state = _ImportState()
    closed = []
    state.fasta = SimpleNamespace(close=lambda: closed.append(True))
    state.fasta_path = "/refs/hg38.fa"
    state.gtf_data = {"transcripts": [{"id": "tx"}]}
    state.gtf_path = "/refs/hg38.gtf"
    state.current_genome = "hg38"
    state.reference_pairs = None
    state.plasmid_sequences = {}
    state.plasmid_metadata = {}
    state.circular_chroms = {}
    state.chroms = [SimpleNamespace(name="chr1")]
    state.chrom_map = {"chr1": "chr1"}
    return state, closed


def test_import_of_a_reference_free_session_drops_the_previous_reference():
    state, closed = _reference_state()
    result = import_session_for_request(state, SessionImportRequest(session={
        "version": "2.0", "datasets": [],
        "gtf": {"loaded": False, "path": None}, "reference": {"genome": None, "fasta_path": None},
    }))
    assert result["success"] is True
    assert (state.fasta, state.gtf_data, state.current_genome, state.chroms) == (None, None, None, [])
    assert closed == [True]


def test_import_of_an_old_session_without_reference_keys_keeps_the_reference():
    state, closed = _reference_state()
    import_session_for_request(state, SessionImportRequest(session={"version": "2.0", "datasets": []}))
    assert state.current_genome == "hg38" and state.gtf_data and closed == []


def test_tracks_round_trip_through_the_normal_loader(tmp_path):
    bed = tmp_path / "peaks.bed"
    bed.write_text("chr1\t10\t20\tp1\n")
    exported = build_session_export_for_request(
        SimpleNamespace(
            chroms=[], datasets={}, dataset_order=[], modification_overlays={}, gtf_data=None,
            current_genome=None, fasta_path=None,
            orthogonal_tracks=[{"path": str(bed), "label": "Peaks", "format": "bed", "render_mode": "annotation",
                                "intervals": {"chr1": [[10, 20]]}}],
        ),
        SessionExportRequest(), now=datetime(2026, 5, 5, tzinfo=timezone.utc),
    )["session"]
    saved = exported["orthogonal_tracks"][0]
    assert saved["format"] == "bed" and saved["render_mode"] == "annotation" and "intervals" not in saved

    state = _ImportState()
    state.orthogonal_tracks = []
    result = import_session_for_request(state, SessionImportRequest(session={
        "version": "2.0", "orthogonal_tracks": exported["orthogonal_tracks"] + [{"path": str(tmp_path / "gone.bw"), "label": "Gone"}],
    }))
    restored = state.orthogonal_tracks
    assert len(restored) == 1 and restored[0]["format"] == "bed" and restored[0].get("render_mode") == "annotation"
    assert [f["path"] for f in result["results"]["tracks_failed"]] == [str(tmp_path / "gone.bw")]


def test_remote_tracks_are_restored(monkeypatch):
    import services.tracks_endpoint as tracks_endpoint
    calls = []
    monkeypatch.setattr(tracks_endpoint, "add_track_for_request",
                        lambda st, **kw: calls.append(kw) or {"success": True})
    state = _ImportState()
    import_session_for_request(state, SessionImportRequest(session={
        "version": "2.0", "orthogonal_tracks": [{"path": "https://example.org/x.bw", "label": "X", "render_mode": "signal"}],
    }))
    assert calls and calls[0]["path"] == "https://example.org/x.bw" and calls[0]["render_mode"] == "signal"


def test_import_reattaches_derived_layer_bundles_from_elsewhere(monkeypatch, tmp_path):
    import services.dataset_registration as registration
    from services.session_files import session_file_refs
    attached = []

    def fake_register(dataset, path, primary_path=None):
        if path.endswith("gone.fiberlayers"):
            raise FileNotFoundError(path)
        attached.append(path)
        dataset.derived_layers = {**(getattr(dataset, "derived_layers", None) or {}), "pol2": {"bundle_path": path}}
        dataset.available_layers["pol2"] = True
        return ["pol2"]

    monkeypatch.setattr(registration, "register_derived_layer_file", fake_register)
    bundle = "/results/elsewhere/sample.fiberlayers"
    session = {"version": "2.0", "datasets": [
        {"id": "ds1", "paths": [str(tmp_path / "reads.bb")],
         "derived_layers": {"pol2": {"bundle_path": bundle}, "x": {"bundle_paths": ["/gone/gone.fiberlayers"]}}},
    ]}
    state = _ImportState()
    result = import_session_for_request(state, SessionImportRequest(session=session))
    assert attached == [bundle]
    assert state.datasets["ds1"].available_layers.get("pol2") is True
    assert [f["path"] for f in result["results"]["derived_layers_failed"]] == ["/gone/gone.fiberlayers"]
    # Relinking can find them too.
    assert {r["path"] for r in session_file_refs(session) if r["kind"] == "derived layers"} == {bundle, "/gone/gone.fiberlayers"}


def test_import_drops_catalog_registrations_for_data_it_replaced(tmp_path):
    from services.catalog_endpoint import _catalog_members, _member, set_catalog
    state = _ImportState()
    reads = tmp_path / "kept.bb"
    reads.write_text("x")
    old_a = SimpleNamespace(id="cat_a", paths=[str(tmp_path / "a.bb")])
    old_kept = SimpleNamespace(id="kept", paths=[str(reads)])
    state.datasets.update({"cat_a": old_a, "kept": old_kept})
    _catalog_members(state).update({0: {0: _member(old_a, "cat_a")}, 1: {0: _member(old_kept, "kept")}})
    state._catalog_loaded = {0: ["cat_a"], 1: ["kept"]}
    state._catalog_loaded_tracks = {3}
    set_catalog({"groups": [{"datasets": [{"path": "a.bb"}]}, {"datasets": [{"path": str(reads)}]}]})
    try:
        import_session_for_request(state, SessionImportRequest(session={
            "version": "2.0", "datasets": [{"id": "kept", "paths": [str(reads)]}],
        }))
    finally:
        set_catalog(None)
    # Group 0's dataset is gone, so reloading it must load again; group 1 came back.
    assert state._catalog_loaded == {1: ["kept"]}
    assert state._catalog_loaded_tracks == set()
