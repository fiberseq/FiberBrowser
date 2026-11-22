"""Reads without footprint calls never enter a nucleosome observation, even before analysis."""
from __future__ import annotations

import array
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')
pytest.importorskip('fiberhmm.scan.modules.nuc')

from nuc_fixtures import chromatin_bam
from test_nuc_patches import _state, SETTINGS

CHROM, END = 'chrP', 60_000
OBS = dict(obsId='o', datasetId='ds0', chrom=CHROM, start=0, end=END)


@pytest.fixture(scope='module')
def mixed(tmp_path_factory):
    root = tmp_path_factory.mktemp('without_calls')
    original = chromatin_bam(root / 'original.bam', contig=CHROM, length=END, step=1800)
    with pysam.AlignmentFile(original, 'rb') as bam:
        header, reads = bam.header, list(bam)
    count = len(reads)
    template = reads[0].to_string()
    for name, flag in [('no-calls', 0), ('no-calls-supp', 2048), ('no-calls-dup', 1024), ('no-evidence', 0)]:
        r = pysam.AlignedSegment.fromstring(template, header)
        r.query_name, r.flag, r.reference_start = name, flag, 35_000
        r.set_tag('st', 'CT')
        if name.startswith('no-calls'):
            r.set_tag('MA', str(r.query_length))
            r.set_tag('AQ', None)
        else:
            r.query_sequence = 'C' * r.query_length
            r.set_tag('MM', None)
            r.set_tag('ML', None)
        reads.append(r)
    path = str(root / 'mixed.bam')
    with pysam.AlignmentFile(path, 'wb', header=header) as out:
        for r in sorted(reads, key=lambda r: r.reference_start):
            out.write(r)
    pysam.index(path)
    return path, count


def test_without_calls_before_analysis_including_scoped_observations(mixed):
    from services.nuc.observations import summarize, record_rows
    from services.nuc.store import STORE
    path, count = mixed
    STORE.clear(path)
    st = _state(path)
    obs = [OBS, {**OBS, 'obsId': 'empty', 'readIds': ['no-calls', 'no-calls-supp']},
           {**OBS, 'obsId': 'strand', 'strand': 'CT'},
           {**OBS, 'obsId': 'graph', 'kind': 'graph', 'graph': dict(contig=CHROM, start=0, end=END)}]
    all_, empty, strand, graph = summarize(st, obs)['observations']
    assert (all_['records'], all_['notComputed'], all_['undecodable'], all_['withoutCalls']) == (count + 1, count + 1, 0, 2)
    assert (empty['records'], empty['notComputed'], empty['undecodable'], empty['withoutCalls']) == (0, 0, 0, 2)
    assert (strand['records'], strand['withoutCalls']) == (1, 2)
    assert (graph['records'], graph['withoutCalls']) == (count + 1, 2)
    dup = summarize(st, [OBS], include_duplicates=True)['observations'][0]
    assert (dup['records'], dup['withoutCalls']) == (count + 1, 3)
    rows = record_rows(st, 'ds0', CHROM, 0, END)
    assert len(rows['records']) == count + 1 and rows['withoutCalls'] == 2
    assert not any(r['qname'].startswith('no-calls') for r in rows['records'])


def test_without_calls_after_analysis_and_cached_job(mixed, tmp_path, monkeypatch):
    from services.nuc import jobs
    from services.nuc.observations import summarize, record_rows
    from services.nuc.patches import patch_scores
    from services.nuc.store import STORE
    path, count = mixed
    STORE.clear(path)
    monkeypatch.setenv('FIBERBROWSER_SCAN_CACHE_DIR', str(tmp_path))
    st = _state(path)
    request = dict(datasets=['ds0'], chrom=CHROM, start=0, end=END, parameters=SETTINGS, workers=2)
    for cached in (False, True):
        job = jobs.submit(st, request)
        done = jobs.wait(st, job['job_id'], 120)
        assert done['status'] == 'complete', done
        result = done['results']['ds0']
        assert result['records'] == count + 1 and result['withoutCalls'] == 2
        assert result['undecodable'] == {'no_evidence': 1}
        assert result['cached' if cached else 'computed'] == count
    summary = summarize(st, [OBS])['observations'][0]
    assert (summary['records'], summary['computed'], summary['notComputed'], summary['undecodable'], summary['withoutCalls']) == (count + 1, count, 0, 1, 2)
    rows = record_rows(st, 'ds0', CHROM, 0, END)
    assert rows['withoutCalls'] == 2 and len(rows['records']) == count + 1
    empty = {**OBS, 'readIds': ['no-calls', 'no-calls-supp']}
    patch = patch_scores(st, [empty], [dict(key='p', type='regular', chrom=CHROM, start=0, end=END)])['observations'][0]['patches']['p']
    assert patch['n'] == 0 and patch['notComputed'] == 0 and patch['withoutCalls'] == 2 and patch['fraction'] is None
    # Opening ordinary scan tables still excludes no-calls before any live job in the new session.
    from fiberhmm.scan import run_units
    from fiberhmm.scan.units import plan
    from services.scan.registry import open_scan, close_scan
    scan_path = tmp_path / 'scan'
    run_units([dict(dataset_id='dataset_1', paths=[path])], plan({CHROM: END}, genome=True),
              modules=['nuc'], params={'nuc': SETTINGS}, out=scan_path, annotate=False, cores=2)
    fresh = _state(path)
    opened = open_scan(fresh, scan_path)
    try:
        loaded = summarize(fresh, [OBS])['observations'][0]
        assert loaded['records'] == count + 1 and loaded['computed'] == count and loaded['withoutCalls'] == 2
        assert loaded['notComputed'] == 1  # no_evidence has no table output; no live failure receipt here
    finally:
        close_scan(fresh, opened.scan_id)
        STORE.clear(path)


def test_call_presence_uses_fiberhmm_precedence_and_keeps_other_failures():
    from nuc_fixtures import header
    from fiberhmm.nuc.records import DecodeContext, decode_record
    from services.nuc.scalars import record_without_calls, drop_stale_nuc_groups, molecule_scalars
    h = pysam.AlignmentHeader.from_dict(header(CHROM, END))
    r = pysam.AlignedSegment(h)
    r.query_name, r.reference_id, r.reference_start, r.cigarstring = 'r', 0, 0, '1000M'
    r.query_sequence = 'C' * 1000
    for tag, value in [('1000', True), ('1000;tf.:11-20', False), ('1000;msp.:11-20', False),
                       ('1000;nuc.:11-20', False), ('1200;nuc.:11-20', False)]:
        r.set_tag('MA', tag)
        assert record_without_calls(r) is value
        assert (decode_record(r, DecodeContext(h))[1] == 'no_calls') is value
    r.set_tag('MA', '1000;nucseg.QQQ:11-20')
    assert record_without_calls(r)
    r.set_tag('ns', array.array('I', [10]))
    r.set_tag('nl', array.array('I', [150]))
    assert not record_without_calls(r)  # annotations without footprint groups fall back to legacy calls
    r.set_tag('ns', None)
    r.set_tag('nl', None)
    read = {'layers': {'nucsz': {}, 'nucseg': {}, 'nucmol': {}, 'msp': {}},
            '_fiberbrowser_scalars': {'nuc.nrl': 190., 'nfr.openness': .5}}
    drop_stale_nuc_groups(read, r)
    assert set(read['layers']) == {'msp'} and read['nuc_live']
    assert molecule_scalars(read) == {'nfr.openness': .5}


def test_string_or_scalar_interval_tags_are_no_calls():
    """The array-pair rule (bam_tags.interval_tag_pair): ns/nl or as/al as strings or scalars are not calls,
    and the live compute never hands such a record to FiberHMM's legacy decode."""
    from nuc_fixtures import header
    from services.nuc.scalars import record_without_calls
    from services.nuc.live import record_outputs
    h = pysam.AlignmentHeader.from_dict(header(CHROM, END))
    r = pysam.AlignedSegment(h)
    r.query_name, r.reference_id, r.reference_start, r.cigarstring = 'r', 0, 0, '1000M'
    r.query_sequence = 'C' * 1000
    for start, length in [('100,700', '147,147'), (40000, 147)]:
        for a, b in (('ns', 'nl'), ('as', 'al')):
            r.set_tag(a, start)
            r.set_tag(b, length)
            assert record_without_calls(r)
            assert record_outputs(r, 0, None, None, None)[3] == 'no_calls'
            r.set_tag(a, None)
            r.set_tag(b, None)
    # FiberHMM's order still holds: a marked chimera (kept by choice) stays a chimera, not a record without calls.
    from fiberhmm.inference.chimeras import CHIMERA_REASON, CHIMERA_TAG
    r.set_tag('ns', '100,700')
    r.set_tag('nl', '147,147')
    r.flag |= 0x200
    r.set_tag(CHIMERA_TAG, CHIMERA_REASON)
    assert record_outputs(r, 0, None, None, None)[3] == 'chimera'
    r.set_tag('ns', None)
    r.set_tag('nl', None)
    r.set_tag('as', array.array('I', [10]))
    r.set_tag('al', array.array('I', [150]))
    assert not record_without_calls(r)


def test_nucleosome_clustering_excludes_without_calls_and_remaps_fit_rows(monkeypatch):
    import numpy as np
    from services.nuc.scalars import WITHOUT_CALLS_KEY
    from services.clustering_features import extract_features_grouped
    from services.cluster_assignment import cluster_compact_reads
    reads = [dict(id='a', intervals=[], _fiberbrowser_scalars={'nuc.nrl': 180.}),
             dict(id='no-calls', intervals=[], **{WITHOUT_CALLS_KEY: True}),
             dict(id='no-evidence', intervals=[]),
             dict(id='b', intervals=[], _fiberbrowser_scalars={'nuc.nrl': 200.})]
    terms = [dict(source='molecule_metric', moleculeMetric='nuc.nrl'),
             dict(source='layer', layer='nucseg'),
             dict(source='label_rule', rule=dict(nucCoarse=[2]))]
    for term in terms:
        rule = dict(id='r', enabled=True, terms=[term])
        _, ids, _, _ = extract_features_grouped(reads, [(0, 100)], 0,
            peak_modes=['cluster_rule:r'], cluster_feature_rules=[rule])
        assert ids == ['a', 'no-evidence', 'b']
    _, ids, _, _ = extract_features_grouped(reads, [(0, 100)], 0, peak_modes=['nuc.seg.regular'])
    assert ids == ['a', 'no-evidence', 'b']
    _, ids, _, _ = extract_features_grouped(reads, [(0, 100)], 0, peak_modes=['accessibility'])
    assert ids == ['a', 'no-calls', 'no-evidence', 'b']
    def fit(X, rows, *args, **kwargs):
        assert X.shape[0] == 3 and rows.tolist() == [0, 2]
        return np.array([0, 1, 0])
    monkeypatch.setattr('services.matched_view_clustering._fit_predict', fit)
    assignments, counts, _, _ = cluster_compact_reads(reads, [(0, 100)], 0, 2,
        peak_modes=['nuc.seg.regular'], fit_rows=[0, 3])
    assert assignments == {'a': 0, 'no-evidence': 1, 'b': 0} and counts == {0: 2, 1: 1}


def test_zero_count_nucleosome_filters_also_leave_without_calls_out(mixed):
    from models.requests import AnalysisFilterRequest
    from services.filtering_endpoint import filter_reads_by_analysis_rule_for_request
    path, count = mixed
    req = AnalysisFilterRequest(dataset_ids=['ds0'], metric='count', operator='eq', threshold=0, layer='nucseg')
    result = filter_reads_by_analysis_rule_for_request(_state(path), req, chrom=CHROM, start=0, end=END)['results']['ds0']
    # The fixture's MA nuc groups are the rows' footprints (MA first), so the terminal-gap rule hides the two
    # molecules (and the no-evidence copy of one) whose first or last call lies over 2 kb inside the read, exactly
    # as it does when the same calls are written as ns/nl.
    assert result['total'] == count - 2
    assert not any(name.startswith('no-calls') for name in result['read_ids'])


def test_lifted_rows_keep_call_absence_even_without_a_source_window(monkeypatch):
    from services.nuc.observations import _lifted_records
    from services.nuc.scalars import WITHOUT_CALLS_KEY
    row = dict(id='no-calls', **{WITHOUT_CALLS_KEY: True},
               live_lift=dict(record='abc:0', library=0, molecule='mol', hap='MAT'))
    monkeypatch.setattr('services.lift.reads.lifted_reads_for_region', lambda *args: [row])
    st, source = NS(datasets={'ds': object()}), NS(browser_id='ds', paths=['/fake.bam'])
    recs = _lifted_records(st, source, CHROM, 0, END, 'MAT', [], {})
    assert len(recs) == 1 and recs[0].without_calls


def test_a_valid_array_pair_beside_a_scalar_pair_decodes_without_the_scalar_pair(monkeypatch):
    """Release first look 3.1.0: scalar ns/nl beside valid array as/al passed the no-calls gate, and FiberHMM's
    legacy decode then iterated the scalar pair (TypeError). FiberHMM now gets a copy without the invalid pair."""
    import fiberhmm.nuc as fnuc
    from nuc_fixtures import header
    from services.nuc.live import record_outputs
    from services.nuc.scalars import without_non_array_tag_pairs
    h = pysam.AlignmentHeader.from_dict(header(CHROM, END))
    r = pysam.AlignedSegment(h)
    r.query_name, r.reference_id, r.reference_start, r.cigarstring = 'r', 0, 0, '1000M'
    r.query_sequence = 'C' * 1000
    r.set_tag('ns', 40000)
    r.set_tag('nl', 147)
    r.set_tag('as', array.array('I', [10]))
    r.set_tag('al', array.array('I', [150]))
    clean = without_non_array_tag_pairs(r)
    assert not clean.has_tag('ns') and not clean.has_tag('nl')
    assert list(clean.get_tag('as')) == [10] and list(clean.get_tag('al')) == [150]
    assert r.has_tag('ns')                      # the stored record is untouched
    seen = []

    def fake(read, record, cal, **kw):
        seen.append(read)
        raise RuntimeError('stop')
    monkeypatch.setattr(fnuc, 'record_outputs', fake)
    with pytest.raises(RuntimeError, match='stop'):
        record_outputs(r, 0, None, None, None)
    assert not seen[0].has_tag('ns') and seen[0].has_tag('as')
