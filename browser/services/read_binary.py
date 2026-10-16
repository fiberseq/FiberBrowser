"""Versioned columnar transport for compact reads; JSON callers keep their schema."""
from __future__ import annotations

import struct
import math
from contextvars import ContextVar
import numpy as np
from utils.responses import ORJSONResponse
from starlette.responses import Response

MEDIA_TYPE = 'application/vnd.fiberbrowser.reads.v1'
_MISSING = object()
binary_read_context = ContextVar('binary_read_context', default=False)


def encode_reads(payload: dict) -> bytes:
    """Store repeated records as columns and ragged arrays as offsets plus values."""
    chunks = []
    size = 0

    def vector(values, dtype):
        nonlocal size
        data = np.asarray(values, dtype=dtype).tobytes()
        padding = (-size) % 8
        chunks.append(b'\0' * padding)
        size += padding
        result = [size, len(values), dtype]
        chunks.append(data)
        size += len(data)
        return result

    def numbers_column(numbers):
        lo, hi = numbers.min(), numbers.max()
        integral = numbers.dtype.kind in 'iu' or np.all(numbers == np.floor(numbers))
        dtype = ('|u1' if 0 <= lo and hi <= 255 else '<u2' if 0 <= lo and hi <= 65535
                 else '<i2' if -32768 <= lo and hi <= 32767
                 else '<i4' if -2**31 <= lo and hi < 2**31 else '<f8') if integral else '<f8'
        return {'kind': 'number', 'values': vector(numbers, dtype)}

    numeric_fields = {'intervals', 'source_intervals', 'family_intervals', 'fire', 'deam',
                      'methyl', 'methyl_m6a', 'methyl_m5c', 'possible_deam_ct', 'possible_deam_ga', 'qualities'}

    def column(values, numeric=False):
        # Dense evidence already has a numerical schema. Avoid building two
        # extra Python lists of millions of positions before packing it.
        if numeric and values and isinstance(values[0], (int, float, np.number)):
            numbers = np.asarray(values)
            if numbers.dtype.kind == 'f' and not np.all(np.isfinite(numbers)):
                return column([None if not math.isfinite(v) else v for v in numbers], numeric)
            if numbers.dtype.kind in 'iuf':
                return {'n': len(values), **numbers_column(numbers)}
        present = [v for v in values if v is not _MISSING and v is not None]
        node = {'n': len(values)}
        if len(present) != len(values):
            node['valid'] = vector([0 if v is _MISSING else 1 if v is None else 2 for v in values], '|u1')
        if not present:
            return {**node, 'kind': 'null'}
        first = present[0]
        if isinstance(first, dict) and all(isinstance(v, dict) for v in present):
            keys = dict.fromkeys(k for v in present for k in v)
            return {**node, 'kind': 'object', 'fields': {
                k: column([v.get(k, _MISSING) if isinstance(v, dict) else _MISSING for v in values], k in numeric_fields) for k in keys}}
        if isinstance(first, (list, tuple)) and all(isinstance(v, (list, tuple)) for v in present):
            offsets = [0]
            flat = []
            for v in values:
                if isinstance(v, (list, tuple)):
                    flat.extend(v)
                offsets.append(len(flat))
            lengths = {offsets[i+1] - offsets[i] for i in range(len(values))}
            shape = {'stride': lengths.pop()} if len(lengths) == 1 else {'offsets': vector(offsets, '<u4')}
            return {**node, 'kind': 'list', **shape, 'items': column(flat, numeric)}
        if isinstance(first, (int, float, np.number)) and not isinstance(first, bool):
            if all(isinstance(v, (int, float, np.number)) and not isinstance(v, bool) for v in present):
                numbers = np.asarray([v if v is not None and v is not _MISSING else 0 for v in values])
                if numbers.dtype.kind == 'f' and not np.all(np.isfinite(numbers)):
                    return column([None if isinstance(v, (float, np.floating)) and not math.isfinite(v) else v for v in values])
                if numbers.dtype.kind in 'iuf':
                    return {**node, **numbers_column(numbers)}
        # Strings, flags and uncommon mixed metadata share a dictionary.
        dictionary, index, codes = [], {}, []
        for v in values:
            value = None if v is _MISSING else v
            key = (type(value).__name__, value) if isinstance(value, (str, bool, int, float, type(None))) else ORJSONResponse(value).body
            if key not in index:
                index[key] = len(dictionary)
                dictionary.append(value)
            codes.append(index[key])
        return {**node, 'kind': 'dictionary', 'dictionary': dictionary,
                'values': vector(codes, '|u1' if len(dictionary) <= 256 else '<u4')}

    def dataset(data):
        return {**{k: v for k, v in data.items() if k not in {'reads', '_read_bounds', '_read_terminals'}},
                **({'geometry': column(data['_read_bounds'], True)} if '_read_bounds' in data else {}),
                **({'terminals': column(data['_read_terminals'], True)} if '_read_terminals' in data else {}),
                'reads': column(data.get('reads', []))}

    header = dataset(payload) if 'reads' in payload else {
        **payload, 'datasets': {k: dataset(v) for k, v in payload.get('datasets', {}).items()}}
    encoded = ORJSONResponse(header).body
    padding = (-len(encoded)) % 8
    return b'FBR1' + struct.pack('<I', len(encoded)) + encoded + b'\0' * padding + b''.join(chunks)


def _wire_read(read):
    """Do not transfer server-side interval indexes or their Python object IDs."""
    layers = read.get('layers') or {}
    internal = lambda key: key.startswith('_fiberbrowser_')
    if not any(internal(key) for key in read) and not any(
            any(internal(key) for key in layer) for layer in layers.values() if isinstance(layer, dict)):
        return read
    result = {key: value for key, value in read.items() if not internal(key)}
    if layers:
        result['layers'] = {name: ({key: value for key, value in layer.items() if not internal(key)}
                                   if isinstance(layer, dict) else layer)
                            for name, layer in layers.items()}
    return result


def _wire_payload(payload):
    if 'reads' in payload:
        return {**payload, 'reads': [_wire_read(read) for read in payload['reads']]}
    if 'datasets' in payload:
        return {**payload, 'datasets': {key: _wire_payload(value) for key, value in payload['datasets'].items()}}
    return payload


def reads_response(payload: dict, request=None):
    """Negotiate binary explicitly; older and Python clients receive JSON."""
    payload = _wire_payload(payload)
    if request is not None and MEDIA_TYPE in request.headers.get('accept', ''):
        return Response(encode_reads(payload), media_type=MEDIA_TYPE, headers={'Vary': 'Accept'})
    return ORJSONResponse(payload, headers={'Vary': 'Accept'})
