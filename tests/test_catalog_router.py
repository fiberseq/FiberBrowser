import asyncio
from types import SimpleNamespace

from routers.catalog import (
    CATALOG_DIAGNOSTICS_ENV,
    catalog_load,
    catalog_diagnostics_enabled,
    catalog_track_load,
    catalog_track_unload,
    catalog_unload,
    get_catalog,
    log_catalog_diagnostic,
    set_catalog,
)


class DummyCatalogState:
    def __init__(self):
        self._catalog_loaded = {}
        self._catalog_loaded_tracks = set()
        self.datasets = {}
        self.dataset_order = []
        self.orthogonal_tracks = []
        self._broad_cache = {}
        self._meta_profile_cache = {}
        self._methylation_cache = {}
        self._working_set_cache = {}

    def add_dataset(self, dataset_id, path, label):
        dataset = SimpleNamespace(
            path=path,
            label=label,
            color=None,
            available_layers=None,
        )
        self.datasets[dataset_id] = dataset
        self.dataset_order.append(dataset_id)
        return dataset


def teardown_function():
    set_catalog(None)


def test_get_catalog_includes_loaded_session_state():
    state = DummyCatalogState()
    from services.catalog_endpoint import _catalog_members, _member
    dataset = object()
    state.datasets["catalog_0_0"] = dataset  # its dataset is open, recorded as the very member the group loaded
    _catalog_members(state)[0] = {0: _member(dataset, "catalog_0_0")}
    state._catalog_loaded_tracks.add(0)
    state.orthogonal_tracks.append({"path": "/tracks/tf.bb", "label": "TF", "_catalog_index": 0})
    set_catalog({
        "name": "Review Catalog",
        "genome": "dm6",
        "groups": [{
            "name": "Embryo",
            "description": "early timepoint",
            "datasets": [{"path": "/data/embryo.bam", "label": "Embryo BAM"}],
        }],
        "tracks": [{"path": "/tracks/tf.bb", "label": "TF"}],
    })

    result = asyncio.run(get_catalog(state))

    catalog = result["catalog"]
    assert catalog["name"] == "Review Catalog"
    assert catalog["genome"] == "dm6"
    assert catalog["groups"][0]["loaded"] is True
    assert catalog["groups"][0]["dataset_labels"] == ["Embryo BAM"]
    assert catalog["tracks"][0] == {"label": "TF", "loaded": True}


def test_catalog_diagnostics_are_opt_in(capsys, monkeypatch):
    monkeypatch.delenv(CATALOG_DIAGNOSTICS_ENV, raising=False)
    assert catalog_diagnostics_enabled() is False
    log_catalog_diagnostic("hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(CATALOG_DIAGNOSTICS_ENV, "1")
    assert catalog_diagnostics_enabled() is True
    log_catalog_diagnostic("visible")
    assert capsys.readouterr().out == "visible\n"


def test_catalog_load_and_unload_updates_session_state_and_caches(monkeypatch):
    # Remote entries are now checked before they load (an unreadable one used to
    # load as an empty dataset); this test's URL is a placeholder, so the check
    # is stubbed (test_s3_catalog.py covers it).
    import services.catalog_endpoint as catalog_endpoint
    monkeypatch.setattr(catalog_endpoint, "_remote_entry_problems", lambda locations: [])
    state = DummyCatalogState()
    set_catalog({
        "groups": [{
            "datasets": [{"url": "https://example.test/sample.bb", "label": "Sample", "color": "#123456"}],
        }],
    })

    load_result = asyncio.run(catalog_load(0, state))

    assert load_result["success"] is True
    assert load_result["dataset_ids"] == ["catalog_0_0"]
    assert state._catalog_loaded[0] == ["catalog_0_0"]
    assert state.dataset_order == ["catalog_0_0"]
    assert state.datasets["catalog_0_0"].color == "#123456"
    assert state.datasets["catalog_0_0"].available_layers == {"footprint": True}

    state._working_set_cache[("catalog_0_0", "chr2L")] = object()
    unload_result = asyncio.run(catalog_unload(0, state))

    assert unload_result["success"] is True
    assert unload_result["removed_ids"] == ["catalog_0_0"]
    assert state.datasets == {}
    assert state.dataset_order == []
    assert state._working_set_cache == {}


def test_catalog_track_load_and_unload_preserves_bigbed_mode():
    state = DummyCatalogState()
    set_catalog({
        "tracks": [{
            "path": "/tracks/tf.bigBed",
            "label": "TF motifs",
            "color": "#00aa00",
        }],
    })

    load_result = asyncio.run(catalog_track_load(0, state))

    assert load_result["success"] is True
    assert state._catalog_loaded_tracks == {0}
    assert state.orthogonal_tracks == [{
        "path": "/tracks/tf.bigBed",
        "label": "TF motifs",
        "format": "bigBed",
        "render_mode": "annotation",
        "_catalog_index": 0,
        "color": "#00aa00",
    }]

    unload_result = asyncio.run(catalog_track_unload(0, state))

    assert unload_result["success"] is True
    assert state._catalog_loaded_tracks == set()
    assert state.orthogonal_tracks == []


def test_catalog_paths_expand_env_and_relative_catalog_base(tmp_path, monkeypatch):
    state = DummyCatalogState()
    monkeypatch.setenv("FIBERBROWSER_TEST_ROOT", str(tmp_path / "env-root"))
    set_catalog({
        "groups": [{
            "datasets": [
                {"path": "data/sample.bam", "label": "Relative"},
                {"path": "${FIBERBROWSER_TEST_ROOT}/data/env.bam", "label": "Env"},
            ],
        }],
        "tracks": [{"path": "tracks/tf.bigBed", "label": "TF"}],
    }, base_dir=str(tmp_path / "catalog-dir"))

    load_result = asyncio.run(catalog_load(0, state))
    track_result = asyncio.run(catalog_track_load(0, state))

    assert load_result["success"] is True
    assert track_result["success"] is True
    assert state.datasets["catalog_0_0"].path == str(tmp_path / "catalog-dir" / "data" / "sample.bam")
    assert state.datasets["catalog_0_1"].path == str(tmp_path / "env-root" / "data" / "env.bam")
    assert state.orthogonal_tracks[0]["path"] == str(tmp_path / "catalog-dir" / "tracks" / "tf.bigBed")
