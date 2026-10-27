"""Feature hub G1: a source-frame scan's hits lifted onto this genome, and hub hits on graph columns.

- Lift statuses from liftbed's three runs (exact / split / partial / unmapped, and the precedence of split), with a
  stand-in liftbed (no binary needed).
- The real liftbed on graphlift's toy ``alu`` package (skipped without liftbed: ``FIBERBROWSER_TEST_LIFTBED``, or
  next to ``FIBERBROWSER_TEST_GRAPH_HELPER``): exact, partial, a zero-width point, and a MAT interval inside the AluY
  insertion that is unmapped and sits at the insertion's junction (target 97,395).
- A source-frame scan's hits in a target view: source coordinates kept, lift status, the target span, haplotype
  columns.
- Graph columns with the real helper (skipped without ``FIBERBROWSER_TEST_GRAPH_HELPER`` and the ``alu`` package in
  ``FIBERBROWSER_TEST_GRAPH_PACKAGES``): a MAT hit inside the insertion is carried by MAT and **absent** on the target
  (never unresolved or unscanned); a target hit's columns are carried by every path.
"""
from __future__ import annotations

import asyncio
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

pysam = pytest.importorskip('pysam')

from scan_fixtures import tiny_bam, write_scan_dir

HELPER = os.environ.get('FIBERBROWSER_TEST_GRAPH_HELPER', '').strip()
PACKAGES = [p for p in os.environ.get('FIBERBROWSER_TEST_GRAPH_PACKAGES', '').split(os.pathsep) if p.strip()]
MAT = 'HG002_MAT#0#chr3_MATERNAL'
ALU_JUNCTION = 97_395
MAT_INSERTION = (94_676, 97_029)


def _liftbed() -> str:
    explicit = os.environ.get('FIBERBROWSER_TEST_LIFTBED', '').strip()
    if explicit and os.path.isfile(explicit):
        return explicit
    if HELPER:
        sibling = os.path.join(os.path.dirname(HELPER), 'liftbed')
        if os.path.isfile(sibling):
            return sibling
    pytest.skip('set FIBERBROWSER_TEST_LIFTBED (graphlift liftbed) or FIBERBROWSER_TEST_GRAPH_HELPER next to it')


def _package(name: str) -> str:
    found = [p for p in PACKAGES if os.path.basename(os.path.normpath(p)) == name]
    if not found:
        pytest.skip(f'no {name} package in FIBERBROWSER_TEST_GRAPH_PACKAGES')
    return found[0]


# ── Statuses from a stand-in liftbed ────────────────────────────────────────

FAKE = r'''#!{python}
import sys
args = sys.argv[1:]
get = lambda flag: args[args.index(flag) + 1] if flag in args else None
split, minimum = get('--split'), float(get('--min-match') or 0)
# name -> placements [(target, start, end, strand, projected)] and the row's length
PLAN = {{'h0': ([('t', 10, 50, '+', 40)], 40), 'h1': ([('t', 100, 120, '+', 20), ('t', 5000, 5010, '+', 10)], 30),
         'h2': ([('t', 200, 230, '+', 25)], 40), 'h3': ([], 40), 'h4': ([('t', 300, 340, '-', 40)], 40)}}
rows = [line.rstrip('\n').split('\t') for line in open(get('-i')) if line.strip()]
out, unl = open(get('-o'), 'w'), open(get('--unlifted'), 'w') if get('--unlifted') else None
for f in rows:
    places, length = PLAN[f[3]]
    if not places:
        if unl: unl.write('#no_projection\n' + '\t'.join(f) + '\n')
        continue
    best = max(places, key=lambda p: p[4])
    keep = places if split == 'all' else [best]
    if sum(p[4] for p in keep) < minimum * length:
        if unl: unl.write('#below_min_match\n' + '\t'.join(f) + '\n')
        continue
    for t, a, b, s, _n in keep:
        out.write('\t'.join([t, str(a), str(b), f[3], f[4], s]) + '\n')
'''


def test_statuses_from_three_liftbed_runs(tmp_path):
    from services.scan.lift import lift_intervals
    fake = tmp_path / 'liftbed'
    fake.write_text(FAKE.format(python=sys.executable))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    got = lift_intervals('map.json', [('s', 0, 40)] * 5, liftbed=str(fake))
    assert [g.status for g in got] == ['exact', 'split', 'partial', 'unmapped', 'exact']
    assert (got[0].chrom, got[0].start, got[0].end, got[0].placements) == ('t', 10, 50, 1)
    # Split: the placement with the most projected bases is kept, and the count says how many there were.
    assert (got[1].start, got[1].end, got[1].placements) == (100, 120, 2)
    assert got[3].reason == 'no_projection' and got[3].chrom is None
    assert got[4].flipped and not got[0].flipped


def test_liftbed_is_found_from_the_environment_and_next_to_the_helper(tmp_path, monkeypatch):
    from services.scan import lift
    exe = tmp_path / 'bin' / 'liftbed'
    exe.parent.mkdir()
    exe.write_text('#!/bin/sh\n')
    exe.chmod(0o755)
    monkeypatch.setenv('FIBERBROWSER_LIFTBED', str(exe))
    assert lift.find_liftbed() == str(exe)
    monkeypatch.delenv('FIBERBROWSER_LIFTBED')
    monkeypatch.setenv('FIBERBROWSER_GRAPH_HELPER', str(tmp_path / 'bin' / 'fiberbrowser-graph'))
    monkeypatch.setenv('PATH', str(tmp_path / 'empty'))
    assert lift.find_liftbed() == str(exe)


# ── The real liftbed on the toy AluY package ────────────────────────────────

def test_real_liftbed_statuses_and_the_insertion_junction(tmp_path):
    from services.lift.live_lift import open_lift_map
    from services.scan.lift import insertion_junction, lift_intervals
    exe = _liftbed()
    manifest = os.path.join(_package('alu'), 'map0', 'map.json')
    rows = [(MAT, 90_000, 90_040), (MAT, 95_000, 95_100), (MAT, 96_990, 97_100), (MAT, 90_100, 90_100)]
    got = lift_intervals(manifest, rows, liftbed=exe)
    assert [g.status for g in got] == ['exact', 'unmapped', 'partial', 'exact']
    assert got[0].end - got[0].start == 40 and got[0].chrom == 'GRCh38#0#chr3'
    assert got[1].reason == 'no_projection'
    # The partial hit keeps only the bases after the insertion: its placement starts at the junction.
    assert got[2].start == ALU_JUNCTION and got[2].end - got[2].start < 110
    assert got[3].start == got[3].end
    target, lo, hi = insertion_junction(open_lift_map(manifest).map, MAT, 95_000, 95_100)
    assert (target, lo, hi) == ('GRCh38#0#chr3', ALU_JUNCTION, ALU_JUNCTION)


# ── A source-frame scan's hits in a target view ─────────────────────────────

def _lifted_state(tmp_path, manifest, chroms=(('GRCh38#0#chr3', 240_000),)):
    from models.domain import Dataset
    from services.lift.dataset import LiveLiftConfig
    bam = tiny_bam(tmp_path / 'mat.bam', contig=MAT, length=240_000, reads=(('m1/1/ccs', 89_000, 0),))
    ds = Dataset('lifted', bam, label='Sample (lifted)')
    ds.data_type = 'bam_livelift'
    ds.live_lift = LiveLiftConfig(manifest, [])
    st = NS(datasets={'lifted': ds}, chroms=[NS(name=n, size=s) for n, s in chroms])
    return st, bam


def test_source_frame_hits_are_lifted_keeping_source_coordinates(tmp_path, monkeypatch):
    from services.scan import registry
    from services.scan.projection import source_hits_for_view
    monkeypatch.setenv('FIBERBROWSER_LIFTBED', _liftbed())
    manifest = os.path.join(_package('alu'), 'map0', 'map.json')
    st, bam = _lifted_state(tmp_path, manifest)
    hits = [(90_000, 90_040, f'fp:class:{MAT}:90020:aaaaaaaa', 'exact'),
            (95_000, 95_100, f'fp:class:{MAT}:95050:bbbbbbbb', 'inside'),
            (96_990, 97_100, f'fp:class:{MAT}:97045:cccccccc', 'partial'),
            (150_000, 150_040, f'fp:class:{MAT}:150020:dddddddd', 'elsewhere')]
    values = [(h, s, e, 'dataset_1::pooled', 'channel', 'prevalence', 0.5, 12) for s, e, h, _l in hits]
    d = write_scan_dir(tmp_path / 'scan', bam, contig=MAT, length=240_000, hits=hits, values=values)
    scan = registry.open_scan(st, d)
    assert scan.frame and scan.frame['kind'] == 'source' and scan.frame['liftedDatasets'] == ['lifted']
    res = source_hits_for_view(st, scan, 'fp', 'GRCh38#0#chr3', 90_000, 100_000)
    by = {h['label']: h for h in res['hits']}
    assert set(by) == {'exact', 'inside', 'partial'}           # 150 kb lifts outside the view
    assert res['liftStatus'] == {'exact': 1, 'unmapped': 1, 'partial': 1}
    for label, h in by.items():
        assert h['chrom'] == MAT and h['source']['chrom'] == MAT           # source coordinates kept
        assert h['frame'] == {'kind': 'source', 'contig': MAT, 'hap': 'HG002_MAT#0', 'hapLabel': 'MAT', 'datasetId': 'lifted'}
        assert 'dataset_1:MAT' in h['columns'] and 'dataset_1' not in h['columns']
    # A one-dataset scan with pooled values only ('all', as peaks write them): the pool fills the haplotype column.
    from services.scan.projection import _annotate
    pooled = _annotate(dict(hitId='p', chrom=MAT, start=1, end=2, anchor=1, columns={'all': {'strength': {'v': 0.3}}}),
                       'lifted', st.datasets['lifted'].live_lift.handle, {'HG002_MAT#0': 'MAT'}, None, None, 'x',
                       scan_datasets=('dataset_1',))
    assert pooled['columns'] == {'all': {'strength': {'v': 0.3}}, 'dataset_1:MAT': {'strength': {'v': 0.3}}}
    assert by['exact']['lift']['status'] == 'exact' and by['exact']['target']['end'] - by['exact']['target']['start'] == 40
    assert by['exact']['target']['start'] <= by['exact']['lift']['anchor'] < by['exact']['target']['end']
    inside = by['inside']
    assert inside['lift']['status'] == 'unmapped' and inside['lift']['junction'] == [ALU_JUNCTION, ALU_JUNCTION]
    assert inside['target'] == {'chrom': 'GRCh38#0#chr3', 'start': ALU_JUNCTION, 'end': ALU_JUNCTION, 'anchor': ALU_JUNCTION,
                                'insertion': True}
    assert by['partial']['lift']['status'] == 'partial'


def test_source_windows_hold_a_point_at_a_projected_stretch_end(tmp_path):
    from services.scan.lift import source_windows
    st, _bam = _lifted_state(tmp_path, os.path.join(_package('alu'), 'map0', 'map.json'))
    config = st.datasets['lifted'].live_lift
    pieces = [p for p in config.handle.map.target_to_source('GRCh38#0#chr3', 200_000, 240_000) if p.primary]
    windows = source_windows(config, 'GRCh38#0#chr3', 200_000, 240_000)
    assert windows[MAT] == (min(p.q_start for p in pieces), max(p.q_end for p in pieces) + 1)


def test_source_frame_scan_without_a_lifted_dataset_says_why(tmp_path):
    from models.domain import Dataset
    from services.scan.projection import source_hits_for_view
    bam = tiny_bam(tmp_path / 'mat.bam', contig=MAT, length=240_000)
    d = write_scan_dir(tmp_path / 'scan', bam, contig=MAT, length=240_000, hits=[(90_000, 90_040, f'fp:class:{MAT}:90020:aaaaaaaa', 'a')])
    from services.scan.registry import OpenScan, read_manifest
    scan = OpenScan(Path(d), read_manifest(d), 'opened', 'scan')
    st = NS(datasets={'native': Dataset('native', bam)}, chroms=[NS(name='chr3', size=240_000)])
    st.datasets['native'].data_type = 'bam'
    scan.bind(st)
    res = source_hits_for_view(st, scan, 'fp', 'chr3', 0, 200_000)
    assert res['hits'] == [] and 'no live-lift dataset' in res['note']


# ── Graph columns (real helper) ─────────────────────────────────────────────

def _arun(fn):
    from services.graph_panel import service
    from services.graph_panel.worker import LIVE_PIDS
    before = set(LIVE_PIDS)

    async def main():
        try:
            return await fn()
        finally:
            await service.shutdown()
    out = asyncio.run(main())
    assert not (LIVE_PIDS - before)
    return out


@pytest.mark.skipif(not (HELPER and os.path.isfile(HELPER)), reason='set FIBERBROWSER_TEST_GRAPH_HELPER')
def test_graph_columns_mat_hit_in_the_insertion_is_absent_on_the_target(tmp_path, monkeypatch):
    from services.graph_panel import analysis, service
    from services.scan.graph_hits import add_graph_aliases
    package = _package('alu')
    monkeypatch.setenv('FIBERBROWSER_GRAPH_HELPER', HELPER)
    monkeypatch.setenv('FIBERBROWSER_GRAPH_REGISTRY', str(tmp_path / 'registry.json'))
    monkeypatch.delenv('FIBERBROWSER_GRAPH_PACKAGES', raising=False)
    service.reset_for_tests()
    analysis.clear_caches()
    st, _bam = _lifted_state(tmp_path, os.path.join(package, 'map0', 'map.json'), chroms=(('chr3', 240_000),))
    inside = dict(hitId='h-in', chrom=MAT, start=95_000, end=95_100, anchor=95_050,
                  frame=dict(kind='source', contig=MAT, hap='HG002_MAT#0', hapLabel='MAT', datasetId='lifted'),
                  source=dict(chrom=MAT, start=95_000, end=95_100, anchor=95_050),
                  lift=dict(status='unmapped', junction=[ALU_JUNCTION, ALU_JUNCTION]))
    on_target = dict(hitId='h-t', chrom='chr3', start=90_000, end=90_050, anchor=90_025)
    # A boundary inside the insertion (zero width): its graph columns are the base after it.
    point = dict(inside, hitId='h-pt', start=95_000, end=95_000, anchor=95_000, source=dict(chrom=MAT, start=95_000, end=95_000, anchor=95_000))

    async def go():
        await service.ensure_ready()
        await asyncio.to_thread(service.registry().register, service.helper_status().path, package)
        hits = [inside, on_target, point]
        note = await add_graph_aliases(st, hits, 'chr3')
        return hits, note
    try:
        (hit_in, hit_t, hit_pt), note = _arun(go)
    finally:
        service.reset_for_tests()
        analysis.clear_caches()
    assert note is None
    g = hit_in['graph']
    assert g['binding'] == 'mat' and g['anchor'] == [ALU_JUNCTION, ALU_JUNCTION]
    assert g['size'] == 100 and g['known'] == 100 and g['columns']
    assert g['paths']['mat']['status'] == 'carried' and g['paths']['mat']['datasets'] == ['lifted']
    assert g['paths']['mat'].get('hap') == 'MAT'
    # The target walks around the insertion: its columns are absent there, never unresolved or "not scanned".
    assert g['paths']['target']['status'] == 'absent'
    assert g['paths']['pat']['status'] in ('carried', 'partial', 'absent')
    pt = hit_pt['graph']
    assert pt['size'] == 1 and pt['known'] == 1 and pt['paths']['target']['status'] == 'absent'
    assert pt['paths']['mat']['status'] == 'carried'
    t = hit_t['graph']
    assert t['binding'] == 'target' and t['size'] == 50
    assert {p['status'] for p in t['paths'].values()} == {'carried'}


def test_graph_aliases_without_a_helper_leave_hits_alone(monkeypatch, tmp_path):
    from services.graph_panel import service
    from services.scan.graph_hits import add_graph_aliases
    monkeypatch.setenv('FIBERBROWSER_GRAPH_HELPER', str(tmp_path / 'missing-helper'))
    monkeypatch.setenv('FIBERBROWSER_GRAPH_REGISTRY', str(tmp_path / 'registry.json'))
    service.reset_for_tests()
    hits = [dict(hitId='h', chrom='chr3', start=10, end=20, anchor=15)]
    try:
        note = asyncio.run(add_graph_aliases(NS(datasets={}, chroms=[]), hits, 'chr3'))
    finally:
        service.reset_for_tests()
    assert note is None and 'graph' not in hits[0]


def test_column_runs_merge_forward_and_reverse_walks():
    from services.scan.graph_hits import _runs
    assert _runs([('a', 0), ('a', 1), ('a', 2), ('b', 5), ('b', 4), ('c', 0)]) == [['a', 0, 3], ['b', 4, 6], ['c', 0, 1]]


# ── Review fixes (Codex group A, round 1) ───────────────────────────────────

class _FakeMap:
    """A lift map of one 2,000 bp source on target 't', chains as (strand, blocks [(q0, q1, t0)], gaps [t, q, tlen,
    qlen, reason index]) in forward source coordinates (a - chain's target runs down as the source runs up):

    0 (+): source [0,100) -> [1000,1100), [150,250) -> [1100,1200): a source insertion [100,150) at target 1,100;
    1 (-): source [400,500) -> target (5100 down to 5000);
    2 (+): source [600,650) -> [2000,2050), [750,800) -> [2150,2200): a conflict gap [650,750);
    3 (+) and 4 (+): both hold source [900,1000) in insertion gaps, attached at target 3,000 and at 7,000."""
    reasons = ['source_insertion', 'target_insertion', 'aligned_indel', 'dissimilar', 'too_big', 'conflict']
    CHAINS = [('+', [(0, 100, 1000), (150, 250, 1100)], [(1100, 100, 0, 50, 0)]),
              ('-', [(400, 500, 5100)], []),
              ('+', [(600, 650, 2000), (750, 800, 2150)], [(2050, 650, 100, 100, 5)]),
              ('+', [(850, 900, 2950), (1000, 1050, 3000)], [(3000, 900, 0, 100, 0)]),
              ('+', [(880, 900, 6980), (1000, 1020, 7000)], [(7000, 900, 0, 100, 0)]),
              # 5 (+, an alternative, never primary): a conflict gap over chain 0's insertion.
              ('+', [(50, 100, 9000), (150, 200, 9100)], [(9050, 100, 50, 50, 5)])]
    ALTERNATIVE = {5}

    def __init__(self):
        self.m = {'targets': [{'name': 't'}], 'sources': [{'name': 's', 'size': 2000}]}
        self.sources = {'s': 0}
        self.by_source = {0: list(range(len(self.CHAINS)))}
        self.chains = [{'target': 0, 'source': 0, 'strand': st, 'q_start_forward': bl[0][0], 'q_end_forward': bl[-1][1]}
                       for st, bl, _g in self.CHAINS]

    def chain_data(self, ci):
        gaps = [list(g) for g in self.CHAINS[ci][2]]
        return {'gaps': gaps, 'gq': [g[1] for g in gaps]}

    def source_to_target(self, contig, a, b):
        out = []
        for ci, (strand, blocks, _g) in enumerate(self.CHAINS):
            for q0, q1, t0 in blocks:
                s0, s1 = max(a, q0), min(b, q1)
                if s1 <= s0:
                    continue
                ts, te = (t0 + (s0 - q0), t0 + (s1 - q0)) if strand == '+' else (t0 - (s1 - q0), t0 - (s0 - q0))
                out.append(NS(chain=ci, t_start=ts, t_end=te, strand=strand, primary=ci not in self.ALTERNATIVE))
        return out


def test_insertion_junction_needs_one_unambiguous_attachment():
    from services.scan.lift import insertion_junction
    lm = _FakeMap()
    # Inside chain 0's source insertion (the alternative chain 5's conflict gap over it neither places nor vetoes it).
    assert insertion_junction(lm, 's', 110, 140) == ('t', 1100, 1100)
    assert insertion_junction(lm, 's', 300, 310) is None                # outside every chain
    assert insertion_junction(lm, 's', 120, 160) is None                # runs past its gap
    assert insertion_junction(lm, 's', 660, 670) is None                # a conflict gap (a possible rearrangement)
    assert insertion_junction(lm, 's', 920, 930) is None                # two chains attach it at different places
    lm.CHAINS = [lm.CHAINS[4], lm.CHAINS[3], *lm.CHAINS[:3]]            # whatever the chain order
    lm.ALTERNATIVE = set()
    lm.__init__()
    assert insertion_junction(lm, 's', 920, 930) is None


def test_junction_overlap_is_half_open_for_replacements_and_a_point_for_insertions():
    from services.scan.lift import HitLift, overlaps_target
    same = lambda c: c == 't'
    rep = HitLift('unmapped', junction=(1100, 1200), junction_chrom='t')
    assert overlaps_target(rep, same, 1150, 1160) and overlaps_target(rep, same, 1000, 1101)
    assert not overlaps_target(rep, same, 1200, 1210)
    ins = HitLift('unmapped', junction=(1100, 1100), junction_chrom='t')
    assert overlaps_target(ins, same, 1100, 1101) and not overlaps_target(ins, same, 1050, 1100)


def test_a_boundary_stands_for_the_base_after_it_except_at_the_path_end():
    from services.scan.graph_hits import point_base
    assert point_base(100, 300) == (100, 101)
    assert point_base(300, 300) == (299, 300)
    assert point_base(0, None) == (0, 1)


def test_a_partly_carrying_path_lists_the_columns_it_carries():
    from services.graph_panel.columns import Occ
    from services.scan.graph_hits import carried_runs, path_status
    cols = [('a', o) for o in range(10)] + [('r', o) for o in range(5)]
    occs = {'1': Occ('1', 'a', 10, False, (0, 10), [(0, 10)]), '2': Occ('2', 'r', 5, False, (10, 15), [(0, 5)]),
            '3': Occ('3', 'r', 5, False, (40, 45), [(0, 5)])}      # r walked twice: a repeat, not carried
    assert path_status(cols, occs, True)['status'] == 'partial'
    assert carried_runs(cols, occs) == [['a', 0, 10]]


def test_incomplete_graph_columns_never_claim_carried_or_absent():
    from services.graph_panel.columns import Occ
    from services.scan.graph_hits import own_columns, path_status
    # The hit's path visits node a over [0, 100) but only [0, 1) is inside the clip: one known column of 100 bases.
    occs = {'o': Occ('o', 'a', 100, False, (0, 100), [(0, 1)])}
    cols, repeats = own_columns(occs, 0, 100)
    assert cols == [('a', 0)] and repeats == 0
    assert path_status(cols, occs, True, total=100)['status'] == 'partial'
    # Another path that doesn't visit node a: with 99 bases unknown, absence isn't proven.
    assert path_status(cols, {}, True, total=100)['status'] == 'unresolved'
    assert path_status(cols, {}, True, total=1)['status'] == 'absent'


def test_lift_cache_follows_the_map_payload(monkeypatch):
    from services.scan import lift
    calls = []

    def fake(path, intervals, split_gap=10_000, liftbed=None):
        calls.append(path)
        return [lift.HitLift('exact', 't', 1, 2, placements=1) for _ in intervals]
    monkeypatch.setattr(lift, 'lift_intervals', fake)
    monkeypatch.setattr(lift, '_map_identity', lambda p: (p, 1, 1))
    lift.clear_cache()
    config = NS(settings=NS(g_split=10_000), handle=NS(path='m.json', plain_chain=False, fingerprint='a', map=None))
    hits = [dict(chrom='s', start=0, end=10)]
    lift.lift_hits(config, hits)
    lift.lift_hits(config, hits)
    assert len(calls) == 1
    config.handle.fingerprint = 'b'          # a target payload file changed: the manifest did not
    lift.lift_hits(config, hits)
    assert len(calls) == 2
    lift.clear_cache()


def test_source_windows_reach_as_far_as_the_split_gap(monkeypatch, tmp_path):
    from services.scan import projection
    seen = []
    monkeypatch.setattr(projection, 'source_windows', lambda config, name, a, b: seen.append((a, b)) or {})
    config = NS(settings=NS(g_split=30_000), handle=NS(map=NS(targets={'chr3': 0}), haplotype_labels={}, source_haplotype={}))
    ds = NS(data_type='bam_livelift', live_lift=config)
    scan = NS(bound_pairs=lambda: [('dataset_1', 'lifted', 'input', {})], manifest={'datasets': [{'dataset_id': 'dataset_1'}]})
    projection.source_hits_for_view(NS(datasets={'lifted': ds}), scan, 'fp', 'chr3', 100_000, 102_000)
    assert seen == [(70_000, 132_000)]


def test_hub_tiles_use_their_own_request_ids_and_the_shared_cache(monkeypatch):
    from services.graph_panel import analysis, service
    from services.scan import graph_hits
    analysis.clear_caches()
    ids = []

    class Pool:
        async def submit(self, reg, kind, payload, request_id, panel_id, generation):
            ids.append(request_id)
            return {'result': {'interval': payload['request']['interval'], 'selected': payload['request']['selected']}}
    monkeypatch.setattr(service, 'pool', lambda: Pool())
    reg = NS(id='g', revisions={'package': 'p', 'graph': 'g', 'db': 'd', 'maps': 'm'}, binding=lambda key: {'size': 100_000})
    first = asyncio.run(graph_hits._fetch(reg, 'target', [None, 'mat'], [1]))
    again = asyncio.run(graph_hits._fetch(reg, 'target', [None, 'mat'], [1]))
    assert len(ids) == 2 and all(i.startswith('hub-cols-') for i in ids) and len(set(ids)) == 2
    assert first == again
    assert first['mat'][1]['selected'] == ['target', 'mat'] and first[None][1]['selected'] == ['target']
    # The same cache graph runs read (analysis.fetch_tiles finds them without a request).
    assert analysis._TILES[analysis._tile_key(reg, 'target', 'mat', 1)] == first['mat'][1]
    analysis.clear_caches()
