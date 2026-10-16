"""B1 round 9: S3 handle expiry, concurrent cache expiry, plasmid reloads.

(The narrow-window gap fix is tested in test_compact_read_loader.py.)
"""
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))


def test_s3_bigbed_handles_reopen_before_their_presigned_url_expires(monkeypatch):
    from services import bigbed_handles

    opened = []

    class Handle:
        def __init__(self, url):
            self.url = url
            self.closed = False

        def close(self):
            self.closed = True

    class Signer:
        calls = 0

        def open_url(self, url):  # S3Manager.open_url: pre-signed for a private object
            Signer.calls += 1
            return f"https://signed/{Signer.calls}"

    def fake_open(url):
        handle = Handle(url)
        opened.append(handle)
        return handle

    clock = [1000.0]
    monkeypatch.setattr(bigbed_handles.pyBigWig, "open", fake_open)
    monkeypatch.setattr(bigbed_handles, "_load_s3_manager", lambda: True)
    monkeypatch.setattr(bigbed_handles, "s3_manager", Signer())
    from services import file_handles
    monkeypatch.setattr(file_handles.time, "monotonic", lambda: clock[0])

    result = {}

    def run():
        first = bigbed_handles.get_bigbed_handle("s3://bucket/a.bb")
        again = bigbed_handles.get_bigbed_handle("s3://bucket/a.bb")
        clock[0] += bigbed_handles.S3_HANDLE_MAX_AGE_S + 1
        later = bigbed_handles.get_bigbed_handle("s3://bucket/a.bb")
        result.update(first=first, again=again, later=later)

    # A worker shares the process cache; URL expiry still replaces its reader.
    worker = threading.Thread(target=run)
    worker.start()
    worker.join()

    assert result["again"] is result["first"]
    assert result["later"] is not result["first"]
    assert result["first"].closed
    assert [h.url for h in opened] == ["https://signed/1", "https://signed/2"]


def _broad_state():
    return SimpleNamespace(
        _broad_cache=OrderedDict(),
        _broad_cache_timeout=300,
        _broad_cache_schema_version=None,
    )


def test_concurrent_lookups_pruning_the_same_expired_entry_do_not_crash(monkeypatch):
    from services import working_sets

    monkeypatch.setattr(working_sets, "ensure_broad_cache_schema", lambda state: None)
    state = _broad_state()
    key = ("ds", "chr1", 0, 1000, True, None, True, True, 90, 0)
    state._broad_cache[key] = ([{"id": "r"}], 0.0)  # long expired

    # Both callers take the list snapshot before either deletes: the real
    # interleaving the lock must make harmless.
    barrier = threading.Barrier(2)
    real_list = list

    def synced_list(items):
        out = real_list(items)
        if items is not None and hasattr(items, "mapping"):
            try:
                barrier.wait(timeout=0.2)
            except threading.BrokenBarrierError:
                pass
        return out

    monkeypatch.setattr(working_sets, "list", synced_list, raising=False)
    errors = []

    def lookup():
        try:
            working_sets.find_broad_cache_entry(state, "ds", "chr1", 100, 200, False, None, time.time())
        except Exception as exc:  # pragma: no cover - the bug
            errors.append(exc)

    threads = [threading.Thread(target=lookup) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert key not in state._broad_cache


def test_reloading_a_plasmid_replaces_its_annotations():
    from routers.genome import _merge_gtf_data
    from services.plasmid_maps import PlasmidFeature, PlasmidMap, plasmid_features_to_gtf_data

    v1 = PlasmidMap("pX", "A" * 500, features=[
        PlasmidFeature("old", 10, 50), PlasmidFeature("gone", 100, 150),
    ])
    v2 = PlasmidMap("pX", "C" * 600, features=[PlasmidFeature("new", 20, 80)])
    gtf = _merge_gtf_data(None, plasmid_features_to_gtf_data(v1))
    gtf = _merge_gtf_data(gtf, plasmid_features_to_gtf_data(v2))

    tx = gtf["transcripts"]
    assert list(tx["gene_name"]) == ["new"]
    assert list(tx["transcript_id"]) == ["pX:feature:0"]
    exons = gtf["exons"]
    assert [(int(r.start), int(r.end)) for r in exons.itertuples()] == [(20, 80)]


def test_reloading_a_plasmid_keeps_other_contigs_annotations():
    from routers.genome import _merge_gtf_data
    from services.plasmid_maps import PlasmidFeature, PlasmidMap, plasmid_features_to_gtf_data

    a = PlasmidMap("pA", "A" * 300, features=[PlasmidFeature("a1", 1, 20)])
    b = PlasmidMap("pB", "A" * 300, features=[PlasmidFeature("b1", 5, 30)])
    gtf = _merge_gtf_data(None, plasmid_features_to_gtf_data(a))
    gtf = _merge_gtf_data(gtf, plasmid_features_to_gtf_data(b))
    gtf = _merge_gtf_data(gtf, plasmid_features_to_gtf_data(a))
    assert sorted(gtf["transcripts"]["gene_name"]) == ["a1", "b1"]
