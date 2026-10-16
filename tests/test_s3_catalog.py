"""Catalog entries on S3: checked before they load, and the catalog can say where its bucket is."""
from __future__ import annotations

import asyncio

from routers.catalog import catalog_load, set_catalog
from test_catalog_router import DummyCatalogState


def teardown_function():
    set_catalog(None)


def test_unreadable_remote_entries_are_reported_not_loaded_empty(monkeypatch):
    """A missing object or index loaded as a dataset with no contigs and no
    reads, and the load said "Loaded 2 dataset(s)"."""
    import services.dataset_endpoint as dataset_endpoint
    checked = []

    def validate(paths, original_paths=None):
        checked.extend(paths)
        return [f"{p}: Object not found" for p in paths if "missing" in p]

    monkeypatch.setattr(dataset_endpoint, "validate_dataset_paths", validate)
    state = DummyCatalogState()
    set_catalog({"groups": [{"datasets": [
        {"url": "s3://lab/ok.bam", "label": "OK"},
        {"url": "s3://lab/missing.bam", "label": "Gone"},
        {"path": "/local/file.bam", "label": "Local"},
    ]}]})
    result = asyncio.run(catalog_load(0, state))
    assert result["dataset_ids"] == ["catalog_0_0", "catalog_0_2"]
    assert "Gone: s3://lab/missing.bam: Object not found" in result["message"]
    assert checked == ["s3://lab/ok.bam", "s3://lab/missing.bam"]  # local paths load as before
    assert 0 not in state._catalog_loaded  # can be retried


def test_merged_group_with_an_unreadable_member_is_not_loaded(monkeypatch):
    import services.dataset_endpoint as dataset_endpoint
    monkeypatch.setattr(dataset_endpoint, "validate_dataset_paths",
                        lambda paths, original_paths=None: [f"{p}: Access denied" for p in paths if "private" in p])
    state = DummyCatalogState()
    set_catalog({"groups": [{"name": "Reps", "merge": True, "datasets": [
        {"url": "s3://lab/rep1.bam"}, {"url": "s3://private/rep2.bam"}]}]})
    result = asyncio.run(catalog_load(0, state))
    assert result["success"] is False and "Access denied" in result["message"]
    assert state.datasets == {}


def test_catalog_s3_block_configures_the_endpoint(monkeypatch):
    from services import s3_support
    calls = []
    monkeypatch.setattr(s3_support, "configure", lambda **kw: calls.append(kw) or {"success": True})
    set_catalog({"s3": {"endpoint_url": "https://acct.r2.cloudflarestorage.com", "region": "auto",
                        "secret": "ignored"}, "groups": []})
    assert calls == [{"endpoint_url": "https://acct.r2.cloudflarestorage.com", "region": "auto"}]
    set_catalog({"groups": []})  # no block: nothing changes
    assert len(calls) == 1


def test_remote_bam_on_the_command_line_is_opened_and_checked(monkeypatch, capsys):
    """`-b s3://...` (or https://) was silently ignored: the primary source had
    to be a local file or folder. Remote --dataset entries were not checked."""
    from services import startup_datasets
    import services.dataset_endpoint as dataset_endpoint
    assert startup_datasets.split_remote_primary("s3://lab/run1.bam") == (None, ["s3://lab/run1.bam"])
    assert startup_datasets.split_remote_primary("/data/run1.bam") == ("/data/run1.bam", [])
    assert startup_datasets.split_remote_primary(["a.bam", "b.bam"]) == (["a.bam", "b.bam"], [])

    monkeypatch.setattr(dataset_endpoint, "validate_dataset_paths",
                        lambda paths, original_paths=None: [f"{p}: Object not found" for p in paths if "gone" in p])
    state = DummyCatalogState()
    startup_datasets.add_cli_datasets(state, ["s3://lab/run1.bam", "s3://lab/gone.bam:Gone"])
    assert [ds.path for ds in state.datasets.values()] == ["s3://lab/run1.bam"]
    assert "s3://lab/gone.bam: Object not found" in capsys.readouterr().out
