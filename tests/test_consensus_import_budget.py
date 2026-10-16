"""Explicit local budgets never relax the default HTTP/upload safeguards."""
import gzip
import inspect
from types import SimpleNamespace

import pytest

from services.consensus_workflow import _expanded_import_bytes, import_result


@pytest.mark.parametrize('limit',[0,-1,True,False,1.5,float('inf'),float('nan'),'1024',None])
def test_invalid_expanded_budget_rejected_before_parsing(limit):
    with pytest.raises(ValueError,match='positive integer'):
        import_result(SimpleNamespace(),b'{}',maximum_expanded_import_bytes=limit)


def test_explicit_boundary_is_inclusive_and_large_expansion_stops():
    original=b' '+b'x'*4095
    compressed=gzip.compress(original)
    assert _expanded_import_bytes(compressed,maximum_expanded_import_bytes=4096)==original
    with pytest.raises(ValueError,match='4095 bytes'):
        _expanded_import_bytes(compressed,maximum_expanded_import_bytes=4095)
    # Highly compressible payload: the measured cap concerns expanded bytes.
    with pytest.raises(ValueError,match='17 bytes'):
        _expanded_import_bytes(gzip.compress(b' '*1000000),maximum_expanded_import_bytes=17)


def test_default_limit_remains_512_mib_and_bounded_read(monkeypatch):
    default=512*1024**2
    assert inspect.signature(import_result).parameters['maximum_expanded_import_bytes'].default==default
    assert inspect.signature(_expanded_import_bytes).parameters['maximum_expanded_import_bytes'].default==default
    observed=[]
    class OverBudget(bytes):
        def __len__(self):return default+1
    class Reader:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def read(self,n):observed.append(n);return OverBudget(b'{}')
    monkeypatch.setattr(gzip,'GzipFile',Reader)
    with pytest.raises(ValueError,match=str(default)):
        import_result(SimpleNamespace(),b'\x1f\x8b')
    assert observed==[default+1]


def test_compressed_cap_is_unchanged_even_with_larger_local_budget():
    class OversizedCompressed(bytes):
        def __len__(self):return 128*1024**2+1
    with pytest.raises(ValueError,match='Compressed artifact exceeds 128 MiB'):
        _expanded_import_bytes(OversizedCompressed(b'{}'),maximum_expanded_import_bytes=1024**3)


def test_plain_bytes_use_same_expanded_budget():
    assert _expanded_import_bytes(b'{}',maximum_expanded_import_bytes=2)==b'{}'
    with pytest.raises(ValueError,match='1 bytes'):
        _expanded_import_bytes(b'{}',maximum_expanded_import_bytes=1)
