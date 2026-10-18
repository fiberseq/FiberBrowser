"""Work bounds for insertion lookup and visible-window mismatch rendering."""
import pytest

from test_live_lift_differences import evidence
from live_lift_fixtures import TARGET, MAT
from services.lift import differences as diff
from services.lift.reads import lifted_reads_for_region


def test_gap_lookup_uses_index(evidence, monkeypatch):
    _, ds, _ = evidence
    handle = ds.live_lift.handle
    original = handle.map.chain_data

    class IndexedOnly(list):
        def __iter__(self):
            pytest.fail("insertion lookup scanned chromosome gaps")

    def indexed(ci):
        data = original(ci)
        return dict(data, gaps=IndexedOnly(data['gaps']))

    monkeypatch.setattr(handle.map, 'chain_data', indexed)
    assert diff.insertion_span(handle, MAT, 5010, 5050, 0) == (5000, 5100)


def test_mismatches_fetch_only_requested_window_once(evidence, monkeypatch):
    state, ds, _ = evidence
    calls, inferred = [], []
    original, runs = diff.fasta_bases, ds.live_lift.handle.map.inferred_runs

    def fetch(fasta, chrom, start, end):
        if fasta is state.fasta:
            calls.append((start, end))
        return original(fasta, chrom, start, end)

    def fills(ci, start, end):
        inferred.append((ci, start, end))
        return runs(ci, start, end)

    monkeypatch.setattr(diff, 'fasta_bases', fetch)
    monkeypatch.setattr(ds.live_lift.handle.map, 'inferred_runs', fills)
    lifted_reads_for_region(ds, TARGET, 1090, 1120, dict(target_fasta=state.fasta))
    assert calls == [] and inferred == []
    lifted_reads_for_region(ds, TARGET, 1090, 1120, dict(include_cigar=True, include_mismatches=False, target_fasta=state.fasta))
    assert calls == [] and inferred == []
    rows = lifted_reads_for_region(ds, TARGET, 1090, 1120, dict(include_cigar=True, target_fasta=state.fasta))
    assert calls == [(1090, 1120)]
    assert len(inferred) == 1
    assert all(0 <= e['pos'] < 30 for r in rows for e in r.get('cigar', []) if e['type'] == 'X')
    assert any(e['source'] == 'assembly' for r in rows for e in r.get('cigar', []) if e['type'] == 'X')
