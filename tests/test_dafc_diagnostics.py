from services.dafc_diagnostics import (
    DAFC_DIAGNOSTICS_ENV,
    dafc_diagnostics_enabled,
    log_dafc_diagnostic,
)


def test_dafc_diagnostics_are_opt_in(capsys, monkeypatch):
    monkeypatch.delenv(DAFC_DIAGNOSTICS_ENV, raising=False)
    assert dafc_diagnostics_enabled() is False
    log_dafc_diagnostic("hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(DAFC_DIAGNOSTICS_ENV, "1")
    assert dafc_diagnostics_enabled() is True
    log_dafc_diagnostic("visible")
    assert capsys.readouterr().out == "visible\n"
