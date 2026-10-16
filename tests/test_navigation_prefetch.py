"""A nearby fill must load the same annotation dependencies as the visible batch."""
import asyncio
import inspect
import json
from pathlib import Path
import pytest

from fastapi.params import Param
from starlette.requests import Request
from state.browser_state import BrowserState
from routers.reads import get_reads_compact, get_reads_compact_all
from services import working_sets
from services.read_stream import MEDIA_TYPE


@pytest.mark.parametrize('filename', ['fiberhmm3.0.0_call.bam', 'ft0.6.2_addnuc_fire.bam'])
@pytest.mark.parametrize('start,end', [(200, 1200), (300, 500), (600, 800), (900, 1300)])
def test_batch_prefetch_reuses_bam_decode_with_a_hidden_quality_layer(monkeypatch, filename, start, end):
    fixture = Path(__file__).parent / 'fixtures/fibertools_frame' / filename

    def state():
        result = BrowserState(None, reference_only=True)
        result.add_dataset('one', str(fixture))
        result.set_quality_filters([{'layer': 'fire', 'quality_name': 'aq', 'min_value': 230}])
        return result

    options = dict(chrom='chrT', start=start, end=end, dataset_ids='one', max_reads=1000,
        spanning=False, include_layers=True, layer_names='nuc,tf', include_layer_qualities=True,
        hide_terminal_gaps=True, terminal_gap_threshold=500, include_metaprofile=False)

    async def request(route, **kwargs):
        defaults = {name: p.default.default for name, p in inspect.signature(route).parameters.items()
                    if isinstance(p.default, Param)}
        return await route(**{**defaults, **kwargs})

    async def batch(current):
        response = await request(get_reads_compact_all, state=current, **options)
        payload = json.loads(response.body)['datasets']['one']
        for key in ('server_elapsed_ms', 'server_timings'):
            payload.pop(key, None)
        return payload

    expected = asyncio.run(batch(state()))
    assert expected['reads']
    calls = []
    load = working_sets._load_broad_reads

    def counted(**kwargs):
        calls.append(kwargs)
        return load(**kwargs)

    monkeypatch.setattr(working_sets, '_load_broad_reads', counted)
    current = state()

    async def check():
        response = await request(get_reads_compact, state=current, chrom='chrT', start=0, end=2000,
            dataset_id='one', max_reads=1, full_working_set=True, prefetch=True, prefetch_batch=True,
            prefetch_sample_level=0, spanning=False, include_layers=True, layer_names='nuc,tf',
            include_layer_qualities=True, hide_terminal_gaps=True, terminal_gap_threshold=500,
            request=Request({'type': 'http', 'headers': [(b'accept', MEDIA_TYPE.encode())]}))
        async for _chunk in response.body_iterator:
            pass
        assert len(calls) == 1
        actual = await batch(current)
        assert len(calls) == 1, 'The neighboring batch decoded the BAM again after a completed fill'
        for observed, reference in zip(actual['reads'], expected['reads']):
            for field in observed.keys() | reference.keys():
                assert observed.get(field) == reference.get(field), field
        assert actual == expected

    asyncio.run(check())
