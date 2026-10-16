from services.diagnostics import env_flag_enabled, log_if_enabled


def test_env_flag_enabled_accepts_common_truthy_values(monkeypatch):
    for value in ["1", "true", "TRUE", " yes ", "on"]:
        monkeypatch.setenv("FIBERBROWSER_TEST_FLAG", value)
        assert env_flag_enabled("FIBERBROWSER_TEST_FLAG") is True


def test_env_flag_enabled_rejects_missing_and_falsey_values(monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_TEST_FLAG", raising=False)
    assert env_flag_enabled("FIBERBROWSER_TEST_FLAG") is False

    for value in ["", "0", "false", "no", "off"]:
        monkeypatch.setenv("FIBERBROWSER_TEST_FLAG", value)
        assert env_flag_enabled("FIBERBROWSER_TEST_FLAG") is False


def test_log_if_enabled_is_quiet_by_default(capsys, monkeypatch):
    monkeypatch.delenv("FIBERBROWSER_TEST_FLAG", raising=False)
    log_if_enabled("FIBERBROWSER_TEST_FLAG", "hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv("FIBERBROWSER_TEST_FLAG", "1")
    log_if_enabled("FIBERBROWSER_TEST_FLAG", "visible")
    assert capsys.readouterr().out == "visible\n"
