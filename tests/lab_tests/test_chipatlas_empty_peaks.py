"""ChIP-Atlas experiments without peaks (the "[bwHdrRead] ... bw is NULL!" noise).

ChIP-Atlas serves a bb05 file for every experiment; for one without a peak at
q < 1e-5 it is an empty bigBed (no chromosomes) or zero-filled. libBigWig
printed "[bwHdrRead] There was an error while reading in the header!" /
"[pyBwOpen] bw is NULL!" for each, the experiment was recorded as failed,
and the file was downloaded and opened again on every run. Now the header is
checked in Python first, the experiment is remembered as having no peaks,
and the run says so once.
"""
from __future__ import annotations

import io
import struct

import pytest


def _empty_bigbed() -> bytes:
    # bbi header (64 bytes) + a chromosome B+ tree header with no items.
    head = struct.pack('<IHHQQQ', 0x8789F2EB, 4, 0, 64, 0, 0).ljust(64, b'\0')
    tree = struct.pack('<IIIIQ', 0x78CA8C91, 256, 8, 8, 0).ljust(32, b'\0')
    return head + tree


class _Resp(io.BytesIO):
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.mark.parametrize('payload', [bytes(667), _empty_bigbed()], ids=['zero-filled', 'no-chromosomes'])
def test_an_experiment_without_peaks_is_remembered_and_never_opened(monkeypatch, tmp_path, capfd, payload):
    from lab.services import chipatlas_peaks as CP
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path))
    downloads = []

    def urlopen(req, timeout=None):
        downloads.append(req.full_url)
        return _Resp(payload)

    monkeypatch.setattr(CP.urllib.request, 'urlopen', urlopen)
    opened = []
    import pyBigWig
    real_open = pyBigWig.open
    monkeypatch.setattr(pyBigWig, 'open', lambda *a: opened.append(a) or real_open(*a))
    for _ in range(3):
        with pytest.raises(CP.NoPeakFile):
            CP.peak_file('dm6', 'SRX111810')
    assert len(downloads) == 1          # once, then remembered
    assert opened == []                 # libBigWig never sees it
    assert 'bw is NULL' not in capfd.readouterr().err
    assert not (tmp_path / 'peaks' / 'dm6' / 'SRX111810.05.bb').exists()


def test_a_real_bigbed_header_passes(tmp_path):
    from lab.services import chipatlas_peaks as CP
    bb = tmp_path / 'x.bb'
    head = struct.pack('<IHHQQQ', 0x8789F2EB, 4, 0, 64, 0, 0).ljust(64, b'\0')
    tree = struct.pack('<IIIIQ', 0x78CA8C91, 256, 8, 8, 3).ljust(32, b'\0')
    bb.write_bytes(head + tree)
    assert CP._bigbed_has_chroms(str(bb))
    bb.write_bytes(_empty_bigbed())
    assert not CP._bigbed_has_chroms(str(bb))


def test_the_run_names_the_experiments_without_peaks(monkeypatch, tmp_path):
    from lab.services import chipatlas_peaks as CP
    monkeypatch.setattr(CP, 'data_dir', lambda: str(tmp_path))
    monkeypatch.setattr(CP, 'antigen_index', lambda genome: {'kr': [['SRX1', 'Kr', 'Embryo', 'x'], ['SRX2', 'Kr', 'Embryo', 'y']]})

    def peak_file(genome, srx, fetch=None):
        if srx == 'SRX2':
            raise CP.NoPeakFile(srx)
        return 'path'

    monkeypatch.setattr(CP, 'peak_file', peak_file)
    monkeypatch.setattr(CP, 'read_peaks', lambda path, c, a, b: [(10, 20, 'p')])
    result = {'region': {'chrom': 'chrT', 'start': 0, 'end': 100}, 'nfrs': []}
    job = CP.submit(None, 'job', result, 'dm6', ['kr'])
    import time
    deadline = time.time() + 5
    while CP.status(job['id'])['status'] == 'running' and time.time() < deadline:
        time.sleep(0.02)
    st = CP.status(job['id'])
    assert st['status'] == 'complete'
    assert st['no_peaks'] == ['SRX2']
    assert 'SRX2' in st['message'] and 'without published peaks' in st['message']
    factor = st['factors_out'][0]
    assert [e['id'] for e in factor['experiments']] == ['SRX1'] and 'failed' not in factor


def test_validation_closes_reader_when_native_header_check_raises(monkeypatch):
    from types import SimpleNamespace
    from lab.services import chipatlas_peaks as CP
    import pyBigWig
    closed = []
    def invalid():
        raise OSError('broken header')
    monkeypatch.setattr(CP, '_bigbed_has_chroms', lambda path: True)
    monkeypatch.setattr(pyBigWig, 'open', lambda path: SimpleNamespace(
        isBigBed=invalid, close=lambda: closed.append(1)))
    assert not CP._valid_bigbed('broken.bb')
    assert closed == [1]
