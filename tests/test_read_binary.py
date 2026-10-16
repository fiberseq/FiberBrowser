"""Compact transport schema equivalence, including real indexed alignments."""
import json
import os
import struct

import numpy as np
import pytest
from services.read_binary import encode_reads, reads_response, MEDIA_TYPE


def decode(blob):
    assert blob[:4] == b'FBR1'
    size = struct.unpack_from('<I', blob, 4)[0]
    data = json.loads(blob[8:8 + size])
    base = 8 + (size + 7) // 8 * 8
    missing = object()

    def vector(desc):
        offset, n, dtype = desc
        return np.frombuffer(blob, dtype=dtype, count=n, offset=base + offset)

    def column(node, i):
        valid = vector(node['valid'])[i] if 'valid' in node else 2
        if valid == 0:
            return missing
        if valid == 1 or node['kind'] == 'null':
            return None
        if node['kind'] == 'object':
            return {k: v for k, child in node['fields'].items() if (v := column(child, i)) is not missing}
        if node['kind'] == 'list':
            if 'stride' in node:
                start, end = i * node['stride'], (i+1) * node['stride']
            else:
                start, end = vector(node['offsets'])[i:i+2]
            return [column(node['items'], j) for j in range(start, end)]
        value = vector(node['values'])[i].item()
        return node['dictionary'][value] if node['kind'] == 'dictionary' else value

    def dataset(d):
        return {**d, 'reads': [column(d['reads'], i) for i in range(d['reads']['n'])]}
    return dataset(data) if 'reads' in data else {**data, 'datasets': {k: dataset(v) for k, v in data['datasets'].items()}}


def test_binary_schema_and_json_fallback():
    payload = {'reads': [
        {'id': 'a', 'intervals': [[-20, 200, 240]], 'layers': {'tf': {'intervals': [], 'qualities': None}}, 'duplicate': False},
        {'id': 'b', 'intervals': [], 'methyl': [1, 12], 'deam': [[1, 0], [12, 1]], 'score': 0.123456789},
    ], 'count': 2, 'width': 200}
    assert decode(encode_reads(payload)) == payload
    assert decode(encode_reads({'datasets': {'one': payload, 'two': {'reads': []}}})) == {'datasets': {'one': payload, 'two': {'reads': []}}}
    assert json.loads(reads_response(payload).body) == payload
    from starlette.requests import Request
    request = Request({'type': 'http', 'headers': [(b'accept', MEDIA_TYPE.encode())]})
    assert decode(reads_response(payload, request).body) == payload


@pytest.mark.parametrize('start,end', [(47514150, 47516150), (47515150, 47517150)])
def test_binary_real_bam_equivalence(start, end):
    path = os.environ.get('FIBERBROWSER_TEST_TRANSPORT_BAM')
    if not path:
        pytest.skip('Set FIBERBROWSER_TEST_TRANSPORT_BAM to an indexed chr19 evidence BAM')
    from services.compact_read_loader import build_compact_reads_from_bam
    reads = build_compact_reads_from_bam(path, 'chr19', start, end, spanning_only=False,
        include_methylation=True, include_layers=True, requested_layers={'nuc', 'tf'},
        hide_terminal_gaps=False, min_footprints=0, short_terminal_footprint_bp=30)
    assert reads
    payload = {'reads': reads, 'width': end-start}
    assert decode(encode_reads(payload)) == payload


def test_direct_cache_retention():
    from services.read_endpoint import _store_direct_reads_cache
    cache = {}
    for i in range(5):
        _store_direct_reads_cache(cache, i, ([{}] * 3, set()), max_reads=7)
    assert list(cache) == [3, 4]
    _store_direct_reads_cache(cache, 5, ([{}] * 10, set()), max_reads=7)
    assert list(cache) == [5]


def test_binary_nonfinite_values_follow_json_null_semantics():
    payload = {'reads': [{'id': 'a', 'qualities': [float('nan'), 0.5, float('inf')]}]}
    assert decode(encode_reads(payload)) == {'reads': [{'id': 'a', 'qualities': [None, 0.5, None]}]}


def test_binary_alignment_metadata_does_not_change_json_read_schema():
    from services.read_binary import binary_read_context
    from services.read_response_payloads import compact_reads_response_payload
    read = {'id': 'one', 'intervals': [[0, 100, 100]], 'reference_start': 50, 'reference_end': 250}
    kwargs = dict(display_reads=[read], width=100, dataset_id='one', working_count=1,
                  total_in_scope=1, total_spanning=1)
    plain = compact_reads_response_payload(**kwargs)
    token = binary_read_context.set(True)
    try:
        binary = compact_reads_response_payload(**kwargs)
    finally:
        binary_read_context.reset(token)
    assert binary.pop('_read_bounds') == [[50, 250]]
    assert binary == plain


def test_wire_payload_omits_internal_indexes_without_mutating_cached_reads():
    read = {'id': 'one', 'intervals': [[0, 100, 100]],
            '_fiberbrowser_interval_index': ((123456, 1), [0], [100]),
            'layers': {'tf': {'intervals': [[20, 40, 20]],
                              '_fiberbrowser_interval_index': ((654321, 1), [20], [40])}}}
    payload = {'reads': [read]}
    wire = json.loads(reads_response(payload).body)
    assert wire == {'reads': [{'id': 'one', 'intervals': [[0, 100, 100]],
                              'layers': {'tf': {'intervals': [[20, 40, 20]]}}}]}
    assert '_fiberbrowser_interval_index' in read
    assert '_fiberbrowser_interval_index' in read['layers']['tf']


def test_empty_view_does_not_discard_the_only_oversized_region():
    from services.read_endpoint import _store_direct_reads_cache
    cache = {}
    value = ([{}] * 10, set())
    _store_direct_reads_cache(cache, 'full', value, max_reads=7)
    _store_direct_reads_cache(cache, 'empty', ([], set()), max_reads=7)
    assert cache == {'full': value}


def test_stream_sends_before_cohort_completion_and_cancels_worker():
    import asyncio
    import threading
    from services.read_stream import stream_reads_response, read_sink
    from services.background_work import checkpoint
    finished = threading.Event()
    def build(**_):
        try:
            stream = read_sink.get()
            for i in range(256):
                stream.append({'id': str(i), 'intervals': [[0, 100, 100]],
                               'reference_start': 0, 'reference_end': 100})
            while True:
                checkpoint()
                finished.wait(0.01)
        finally:
            finished.set()
    async def check():
        response = stream_reads_response(build, dict(start=0, end=100, dataset_id='a', min_sv_len=50))
        first = await asyncio.wait_for(anext(response.body_iterator), 2)
        assert decode(first[4:])['reads'][0]['id'] == '0'
        assert not finished.is_set()
        await response.body_iterator.aclose()
        assert await asyncio.to_thread(finished.wait, 2)
    asyncio.run(check())


def test_stream_preserves_duplicate_alignment_order_and_complete_metadata():
    from services.read_stream import ReadStream, read_sink
    from services.read_binary import binary_read_context
    from services.read_response_payloads import compact_reads_response_payload
    from services.sv_events import finalize_sv_payload
    frames = []
    stream = ReadStream(frames.append, dict(start=100, end=200, dataset_id='a', min_sv_len=50))
    reads = [{'id': name, 'reference_start': lo, 'reference_end': 220,
              'intervals': [[0, 100, size]], 'sv': [{'t': 'I', 'ref': 150, 'len': 20, 'q': 0}]}
             for name, lo, size in [('same', 90, 10), ('other', 80, 20), ('same', 90, 30)]]
    token = binary_read_context.set(True)
    stream_token = read_sink.set(stream)
    try:
        for read in reads:
            stream.append(read)
        final = compact_reads_response_payload(display_reads=[reads[2], reads[1], reads[0]],
            width=100, dataset_id='a', working_count=3, total_in_scope=3, total_spanning=3)
        stream.finish(final)
    finally:
        read_sink.reset(stream_token)
        binary_read_context.reset(token)
    assert frames[-1]['_stream_complete'] is True
    assert frames[-1]['_stream_order'] == [2, 1, 0]
    actual = [frames[0]['reads'][i] for i in frames[-1]['_stream_order']]
    assert actual == finalize_sv_payload(final['reads'], 100, 200, 50)
    assert frames[-1]['working_count'] == 3
    assert frames[-1]['reads'] == []


def test_prefetch_survives_interactive_reads_but_explicit_cancel_still_stops_it():
    import threading
    from services.read_stream import prefetch_scope, cancel_prefetches
    from services.background_work import interactive_read, reads_in_flight
    event = threading.Event()
    with prefetch_scope(event):
        assert reads_in_flight() == 0
        with interactive_read():
            assert not event.is_set()
            assert reads_in_flight() == 1
        cancel_prefetches()
        assert event.is_set()
    assert reads_in_flight() == 0


def test_read_frames_bypass_compression_buffering():
    import asyncio
    from services.offloop_gzip import OffloopGZipMiddleware
    from services.read_stream import MEDIA_TYPE as STREAM_TYPE
    messages = []
    frame = encode_reads({'reads': []})
    async def send(message):
        messages.append(message)
    async def app(scope, receive, send):
        await send({'type': 'http.response.start', 'status': 200,
                    'headers': [(b'content-type', STREAM_TYPE.encode())]})
        await send({'type': 'http.response.body', 'body': frame, 'more_body': True})
        assert messages[-1]['body'] == frame
        assert b'content-encoding' not in dict(messages[0]['headers'])
        await send({'type': 'http.response.body', 'body': b'', 'more_body': False})
    asyncio.run(OffloopGZipMiddleware(app)({'type': 'http', 'headers': [(b'accept-encoding', b'gzip')]}, None, send))


def test_stream_uses_the_endpoints_normalized_event_threshold():
    from services.read_stream import ReadStream
    from services.sv_events import normalize_min_sv_len
    frames = []
    stream = ReadStream(frames.append, dict(start=100, end=200, dataset_id='a', min_sv_len=10**9))
    event = {'t': 'I', 'ref': 150, 'len': normalize_min_sv_len(10**9) + 1, 'q': 0}
    stream.append({'id': 'one', 'intervals': [[0, 100, 100]], 'sv': [event]})
    stream.flush()
    assert frames[0]['reads'][0]['sv'] == [event]
