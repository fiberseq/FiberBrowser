"""Shared BAM readers keep indexed reads valid under cache pressure."""
from types import SimpleNamespace

from services import bam_handles
from services.file_handles import HandleCache


def test_index_open_failure_closes_reader_and_is_negative_cached(monkeypatch, tmp_path):
    path = tmp_path / 'reads.bam'; path.write_bytes(b'BAM')
    (tmp_path / 'reads.bam.bai').write_bytes(b'index')
    closed, opened = [], []
    def open_reader(*args, **kwargs):
        opened.append(1)
        return SimpleNamespace(has_index=lambda: False, close=lambda: closed.append(1))
    from services.remote_sources import opening
    monkeypatch.setattr(opening, 'open_alignment_file', open_reader)
    monkeypatch.setattr(bam_handles, 'handles', HandleCache())
    for _ in range(20):
        assert bam_handles.get_bam_handle(str(path)) is None
    assert len(opened) == len(closed) == 1
