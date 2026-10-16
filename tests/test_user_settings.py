"""~/.fiberhmm/browser_settings.json: machine-level FiberHMM source and token opt-out."""
import json

import pytest

from services import user_settings


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    path = tmp_path / "browser_settings.json"
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(path))
    monkeypatch.delenv("FIBERBROWSER_NO_TOKEN", raising=False)
    monkeypatch.delenv("FIBERHMM_SOURCE_DIR", raising=False)
    monkeypatch.setattr(user_settings, "_cache", None)

    def write(data):
        path.write_text(json.dumps(data) if not isinstance(data, str) else data)
        monkeypatch.setattr(user_settings, "_cache", None)
    return write


def test_defaults_without_a_settings_file(settings_file):
    assert user_settings.token_disabled_by_user() is False
    assert user_settings.fiberhmm_source_dir() is None


def test_settings_file_turns_the_token_off_only_when_explicitly_false(settings_file):
    settings_file({"require_token": False})
    assert user_settings.token_disabled_by_user() is True
    settings_file({"require_token": "false"})       # a string is not an explicit JSON false
    assert user_settings.token_disabled_by_user() is False


def test_env_var_turns_the_token_off(settings_file, monkeypatch):
    monkeypatch.setenv("FIBERBROWSER_NO_TOKEN", "1")
    assert user_settings.token_disabled_by_user() is True


def test_fiberhmm_source_dir_env_wins_over_settings(settings_file, monkeypatch, tmp_path):
    settings_file({"fiberhmm_source_dir": "/from/settings"})
    assert user_settings.fiberhmm_source_dir() == "/from/settings"
    monkeypatch.setenv("FIBERHMM_SOURCE_DIR", "/from/env")
    assert user_settings.fiberhmm_source_dir() == "/from/env"


def test_settings_source_dir_feeds_fiberhmm_discovery(settings_file, tmp_path):
    tree = tmp_path / "FiberHMM"
    (tree / "fiberhmm" / "inference").mkdir(parents=True)
    (tree / "fiberhmm" / "inference" / "strand_rescue.py").write_text("")
    settings_file({"fiberhmm_source_dir": str(tree)})
    from services.fiberhmm_runtime import bundled_fiberhmm_root
    assert bundled_fiberhmm_root() == tree.resolve()


def test_invalid_settings_file_is_ignored(settings_file, capsys):
    settings_file("{not json")
    assert user_settings.load_user_settings() == {}
    assert "ignoring it" in capsys.readouterr().err
