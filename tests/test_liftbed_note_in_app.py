"""Scan hits onto live-lifted datasets in the Mac app (clean-Mac audit, 3.1.1): liftbed is not bundled yet, so the
app says so plainly instead of pointing to a build folder."""
import sys

from services.scan import lift


def test_the_app_says_liftbed_is_not_included(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    note = lift.unavailable_note()
    assert "does not include yet" in note and "source coordinates" in note


def test_a_source_install_is_told_how_to_provide_it(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert "FIBERBROWSER_LIFTBED" in lift.unavailable_note()
