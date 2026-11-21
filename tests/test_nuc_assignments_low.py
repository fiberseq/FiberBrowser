"""Geometry assignments: with low calling on, every read gets a low group even when no low geometry is shared."""
from services.nuc import nucgeo


def test_group_low_is_present_with_low_calling_and_no_low_geometry():
    metas = [{'ds': 'a', 'qname': 'r1'}, {'ds': 'a', 'qname': 'r2'}]
    states = [{}, {}]
    out = nucgeo._assignments([], metas, states, 'C', 'P', kinds=('high', 'low'))
    assert out['a']['groupLow'] == {'r1': 0, 'r2': 0}
    assert out['a']['group'] == {'r1': 0, 'r2': 0}
    off = nucgeo._assignments([], metas, states, 'C', 'P', kinds=('high',))
    assert 'groupLow' not in off['a']
