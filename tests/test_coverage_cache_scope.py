"""Coverage and FIRE results are cached per session and per data source."""
from types import SimpleNamespace

import numpy as np

import services.read_auxiliary_endpoint as aux


def _state(path):
    ds = SimpleNamespace(id="sample", data_type="bam", paths=[path])
    return SimpleNamespace(
        translate_chrom=lambda c: c, dataset_order=["sample"], datasets={"sample": ds},
        get_dataset=lambda i: ds if i == "sample" else None, chroms=[],
    )


def test_two_sessions_with_the_same_dataset_id_get_their_own_coverage(monkeypatch, tmp_path):
    calls = []

    def fake_coverage(datasets, *a, **k):
        calls.append(datasets[0].paths[0])
        return {"coverage": [len(calls)], "max": len(calls)}

    monkeypatch.setattr(aux, "compute_binned_read_coverage", fake_coverage)
    monkeypatch.setattr(aux, "resolve_dataset_id", lambda state, i: i)
    a, b = tmp_path / "a.bam", tmp_path / "b.bam"
    a.write_text("a"); b.write_text("b")
    first = aux.get_coverage_payload(_state(str(a)), chrom="chr1", end=100, bins=10)
    second = aux.get_coverage_payload(_state(str(b)), chrom="chr1", end=100, bins=10)
    assert calls == [str(a), str(b)] and first != second

    # The same session asking again is served from its cache...
    state = _state(str(a))
    aux.get_coverage_payload(state, chrom="chr1", end=100, bins=10)
    aux.get_coverage_payload(state, chrom="chr1", end=100, bins=10)
    assert calls.count(str(a)) == 2
    # ...until the file under that path changes.
    import os
    os.utime(a, ns=(1, 1))
    aux.get_coverage_payload(state, chrom="chr1", end=100, bins=10)
    assert calls.count(str(a)) == 3


def test_fire_cache_follows_the_loaded_fire_table(monkeypatch):
    tables = []

    def fake_fire_track(df, chrom, start, end, query_segments=None):
        tables.append(df)
        return np.ones(end - start), [], [[0, 10]]

    monkeypatch.setattr(aux, "compute_fire_track", fake_fire_track)
    monkeypatch.setattr("services.circular_genome.circular_query_segments_for_region", lambda *a: None)
    state = SimpleNamespace(fire_df=object(), translate_chrom=lambda c: c)
    aux.get_fire_payload(state, chrom="chr1", start=0, end=100)
    aux.get_fire_payload(state, chrom="chr1", start=0, end=100)
    assert len(tables) == 1
    state.fire_df = object()  # another FIRE table (new data or genome)
    aux.get_fire_payload(state, chrom="chr1", start=0, end=100)
    assert len(tables) == 2
    other = SimpleNamespace(fire_df=object(), translate_chrom=lambda c: c)
    aux.get_fire_payload(other, chrom="chr1", start=0, end=100)
    assert len(tables) == 3
