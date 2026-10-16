"""Library re-run badge: confirmed advisories vs ones that only may apply."""
from services.library_inspect import needs_rerun


def test_confirmed_required_wins():
    adv = {"items": [{"severity": "rerun-required", "status": "affected"},
                     {"severity": "rerun-recommended", "status": "possibly_affected"}]}
    assert needs_rerun(adv) == "rerun-required"


def test_only_possibly_affected_is_possible():
    adv = {"items": [{"severity": "rerun-required", "status": "possibly_affected", "confidence": "low"}]}
    assert needs_rerun(adv) == "possible"


def test_info_and_empty_show_nothing():
    assert needs_rerun({"items": [{"severity": "info", "status": "affected"}]}) is None
    assert needs_rerun(None) is None
