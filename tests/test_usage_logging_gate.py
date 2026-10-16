import asyncio

from routers import natural_language as nl


def _log(tmp_path, monkeypatch, **fields):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    return asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, **fields)))


def test_automatic_logs_are_skipped_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_USAGE_LOG", raising=False)
    result = _log(tmp_path, monkeypatch)
    assert result["skipped"] is True
    assert not (tmp_path / "usage_logs").exists()


def test_operator_can_enable_local_logging(tmp_path, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_USAGE_LOG", "1")
    result = _log(tmp_path, monkeypatch)
    assert "skipped" not in result
    assert list((tmp_path / "usage_logs").glob("session_*.json"))


def test_explicit_save_and_sharing_always_write(tmp_path, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_USAGE_LOG", raising=False)
    assert "skipped" not in _log(tmp_path, monkeypatch, explicit=True)
    assert "skipped" not in _log(tmp_path, monkeypatch, share=True)
