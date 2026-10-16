"""The lab build declares the FiberHMM it needs (browser/lab/fiberbrowser-pack.json): the NFR engine with a minimum
schema and the provenance API. A lab app pointed at a FiberHMM without them (a release checkout) runs its bundled
one and says so; a source run keeps the tree it was given and says what won't work."""
import json

import pytest

from services import app_build, app_settings, user_settings
from services import fiberhmm_runtime as runtime


def tree(root, engine=True, schema="fiberhmm.accessibility.preview.v1"):
    pkg = root / "fiberhmm"
    for sub in ("inference/consensus", "io"):
        (pkg / sub).mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text('__version__ = "3.0.0"\n')
    (pkg / "inference" / "strand_rescue.py").write_text("")
    (pkg / "inference" / "consensus" / "workflow.py").write_text("")
    (pkg / "io" / "provenance.py").write_text("def basecaller_provenance(h):\n    pass\ndef parse_ds_tokens(d):\n"
                                              "    pass\ndef parse_override(b=None):\n    pass\n")
    if engine:
        (pkg / "inference" / "accessibility").mkdir()
        (pkg / "inference" / "accessibility" / "__init__.py").write_text("from .workflow import SCHEMA\n")
        (pkg / "inference" / "accessibility" / "workflow.py").write_text(f"SCHEMA = '{schema}'\n")
    return root


@pytest.fixture
def lab(tmp_path, monkeypatch):
    monkeypatch.delenv("FIBERHMM_SOURCE_DIR", raising=False)
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(tmp_path / "browser_settings.json"))
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(tmp_path / "app_settings.json"))
    for module in (user_settings, app_settings):
        monkeypatch.setattr(module, "_cache", None)
    monkeypatch.setattr(runtime, "_APP_CHOICE", None)
    bundled = tree(tmp_path / "bundle")
    monkeypatch.setattr(runtime, "default_package_dir", lambda exclude=(): bundled / "fiberhmm")
    monkeypatch.setattr(runtime, "_default_version", lambda d: "3.0.0")
    return tmp_path


def test_the_lab_manifest_declares_the_nfr_engine_and_the_provenance_api():
    labels = [f["label"] for r in runtime.required_features() for f in r.get("features") or []]
    assert "the NFR engine" in labels and "the provenance API" in labels


def test_lab_app_with_a_release_checkout_falls_back_to_its_bundled_fiberhmm(lab, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    release = tree(lab / "Release v2.0.0", engine=False)
    app_settings.update("fiberhmm", {"source": "custom", "custom_path": str(release)})
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled" and sel["root"] is None and sel["missing"] == []
    assert sel["notices"] == [f"Custom FiberHMM at {release.resolve()} lacks the NFR engine; "
                              "using the bundled FiberHMM 3.0.0."]


def test_lab_app_ignores_the_settings_file_release_checkout(lab, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    release = tree(lab / "Release v2.0.0", engine=False)
    (lab / "browser_settings.json").write_text(json.dumps({"fiberhmm_source_dir": str(release)}))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled" and sel["notices"] == []


def test_lab_source_run_keeps_the_release_checkout_and_says_what_wont_work(lab, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    release = tree(lab / "Release v2.0.0", engine=False)
    (lab / "browser_settings.json").write_text(json.dumps({"fiberhmm_source_dir": str(release)}))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "settings" and sel["root"] == str(release.resolve())
    assert sel["missing"] == ["the NFR engine"] and "lacks the NFR engine" in sel["notices"][0]


def test_an_older_nfr_schema_is_not_enough(lab, monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    old = tree(lab / "old", schema="fiberhmm.accessibility.preview.v0")
    app_settings.update("fiberhmm", {"source": "custom", "custom_path": str(old)})
    assert runtime.fiberhmm_selection()["source"] == "bundled"
