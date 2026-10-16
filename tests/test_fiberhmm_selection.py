"""Which FiberHMM a process runs: packaged apps (bundled by default) vs source runs (the settings file), and the
capability check that never lets a build run without the FiberHMM features it declares."""
import json

import pytest

from services import app_build, app_settings, user_settings
from services import fiberhmm_runtime as runtime

LAB_LIKE = [
    {"min_version": "3.0", "features": [{"label": "FiberHMM 3.0 core (strand rescue)",
                                         "module": "fiberhmm.inference.strand_rescue"}]},
    {"features": [
        {"label": "the preview engine", "module": "fiberhmm.inference.preview",
         "schema": {"module": "fiberhmm.inference.preview.workflow", "name": "SCHEMA",
                    "min": "fiberhmm.preview.v1"}},
        {"label": "the provenance API", "module": "fiberhmm.io.provenance",
         "names": ["basecaller_provenance", "parse_ds_tokens"]},
    ]},
]


def make_tree(root, version="3.0.0", engine=True, provenance=True, schema="fiberhmm.preview.v1"):
    pkg = root / "fiberhmm"
    (pkg / "inference").mkdir(parents=True)
    (pkg / "io").mkdir()
    (pkg / "__init__.py").write_text(f'"""FiberHMM"""\n\n__version__ = "{version}"\n')
    (pkg / "inference" / "__init__.py").write_text("")
    (pkg / "inference" / "strand_rescue.py").write_text("")
    if engine:
        (pkg / "inference" / "preview").mkdir()
        (pkg / "inference" / "preview" / "__init__.py").write_text("from .workflow import SCHEMA\n")
        (pkg / "inference" / "preview" / "workflow.py").write_text(f"SCHEMA = '{schema}'\n")
    if provenance:
        (pkg / "io" / "provenance.py").write_text("def basecaller_provenance(h):\n    pass\n\n"
                                                  "def parse_ds_tokens(ds):\n    pass\n")
    return root


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A clean selection environment: no env var, empty settings files, a fake bundled FiberHMM with everything."""
    monkeypatch.delenv("FIBERHMM_SOURCE_DIR", raising=False)
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(tmp_path / "browser_settings.json"))
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(tmp_path / "app_settings.json"))
    monkeypatch.setattr(user_settings, "_cache", None)
    monkeypatch.setattr(app_settings, "_cache", None)
    monkeypatch.setattr(runtime, "_APP_CHOICE", None)
    monkeypatch.setattr(runtime, "_CONFIGURED_ROOT", None)
    bundled = make_tree(tmp_path / "bundle", version="3.0.1")
    monkeypatch.setattr(runtime, "default_package_dir", lambda exclude=(): bundled / "fiberhmm")
    monkeypatch.setattr(runtime, "required_features", lambda: LAB_LIKE)

    class Env:
        root = tmp_path
        bundled_dir = bundled / "fiberhmm"

        @staticmethod
        def packaged(value):
            monkeypatch.setattr(app_build, "is_packaged", lambda: value)

        @staticmethod
        def settings_file(data):
            (tmp_path / "browser_settings.json").write_text(json.dumps(data))
            monkeypatch.setattr(user_settings, "_cache", None)

        @staticmethod
        def app_choice(source, path=""):
            app_settings.update("fiberhmm", {"source": source, "custom_path": path})
            monkeypatch.setattr(runtime, "_APP_CHOICE", None)
    return Env


# --- packaged apps ------------------------------------------------------------------------------------------------

def test_packaged_app_ignores_the_settings_file_and_runs_its_bundled_fiberhmm(env):
    env.packaged(True)
    release = make_tree(env.root / "Release", engine=False)
    env.settings_file({"fiberhmm_source_dir": str(release)})
    sel = runtime.fiberhmm_selection()
    assert sel["packaged"] and sel["source"] == "bundled" and sel["root"] is None
    assert sel["version"] == "3.0.1" and sel["missing"] == [] and sel["notices"] == []
    assert runtime.bundled_fiberhmm_root() is None


def test_packaged_app_custom_choice_is_used_when_it_has_the_features(env):
    env.packaged(True)
    custom = make_tree(env.root / "custom", version="3.0.2")
    env.app_choice("custom", str(custom))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "app" and sel["root"] == str(custom.resolve()) and sel["version"] == "3.0.2"
    assert sel["notices"] == []


def test_packaged_app_env_beats_the_app_choice(env, monkeypatch):
    env.packaged(True)
    env.app_choice("custom", str(make_tree(env.root / "custom")))
    from_env = make_tree(env.root / "from_env")
    monkeypatch.setenv("FIBERHMM_SOURCE_DIR", str(from_env))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "env" and sel["root"] == str(from_env.resolve())


def test_custom_fiberhmm_without_a_declared_engine_falls_back_to_the_bundled_one_with_a_notice(env):
    env.packaged(True)
    custom = make_tree(env.root / "Release", engine=False)
    env.app_choice("custom", str(custom))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled" and sel["root"] is None
    assert sel["requested"] == {"source": "app", "path": str(custom)}
    assert sel["notices"] == [f"Custom FiberHMM at {custom.resolve()} lacks the preview engine; "
                              "using the bundled FiberHMM 3.0.1."]
    assert runtime.bundled_fiberhmm_root() is None


def test_env_fiberhmm_lacking_features_also_falls_back_in_a_packaged_app(env, monkeypatch):
    env.packaged(True)
    old = make_tree(env.root / "old", engine=False, provenance=False)
    monkeypatch.setenv("FIBERHMM_SOURCE_DIR", str(old))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled"
    assert "lacks the preview engine and the provenance API; using the bundled FiberHMM 3.0.1" in sel["notices"][0]


def test_an_older_schema_or_version_counts_as_missing(env):
    env.packaged(True)
    custom = make_tree(env.root / "c", schema="fiberhmm.preview.v0")
    env.app_choice("custom", str(custom))
    assert "the preview engine" in runtime.fiberhmm_selection()["notices"][0]
    newer = make_tree(env.root / "n", schema="fiberhmm.preview.v2")
    assert runtime.missing_features(newer / "fiberhmm", LAB_LIKE) == []
    two = make_tree(env.root / "two", version="2.16.8")
    assert runtime.missing_features(two / "fiberhmm", LAB_LIKE) == ["FiberHMM 3.0 or newer"]


def test_custom_path_that_is_not_a_source_tree_falls_back_with_a_notice(env):
    env.packaged(True)
    env.app_choice("custom", str(env.root / "nowhere"))
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled" and "is not a FiberHMM source tree" in sel["notices"][0]


def test_the_app_choice_is_read_once_per_process(env):
    env.packaged(True)
    custom = make_tree(env.root / "custom")
    assert runtime.fiberhmm_selection()["source"] == "bundled"
    app_settings.update("fiberhmm", {"source": "custom", "custom_path": str(custom)})
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled"  # never swapped under a running server
    assert sel["app_choice"]["restart_needed"] is True and sel["app_choice"]["source"] == "custom"


def test_bundled_fiberhmm_lacking_a_feature_is_reported_never_silent(env, monkeypatch, tmp_path):
    env.packaged(True)
    thin = make_tree(tmp_path / "thin", engine=False)
    monkeypatch.setattr(runtime, "default_package_dir", lambda exclude=(): thin / "fiberhmm")
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "bundled" and sel["missing"] == ["the preview engine"]
    assert "lacks the preview engine; what needs it won't work" in sel["notices"][0]


# --- source runs --------------------------------------------------------------------------------------------------

def test_source_run_still_honours_the_settings_file_key(env):
    """The paper scripts start FiberBrowser from source and rely on fiberhmm_source_dir (a release tree)."""
    env.packaged(False)
    release = make_tree(env.root / "Release")
    env.settings_file({"fiberhmm_source_dir": str(release)})
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "settings" and sel["root"] == str(release.resolve())
    assert runtime.bundled_fiberhmm_root() == release.resolve()


def test_source_run_keeps_its_tree_even_without_a_declared_engine(env):
    """No fallback for source runs (the installed package may be FiberHMM 2.x): a notice says what won't work."""
    env.packaged(False)
    release = make_tree(env.root / "Release", engine=False)
    env.settings_file({"fiberhmm_source_dir": str(release)})
    sel = runtime.fiberhmm_selection()
    assert sel["root"] == str(release.resolve()) and sel["missing"] == ["the preview engine"]
    assert sel["notices"] == [f"Custom FiberHMM 3.0.0 at {release.resolve()} lacks the preview engine; "
                              "what needs it won't work."]


def test_source_run_env_beats_the_settings_file_and_ignores_the_app_choice(env, monkeypatch):
    env.packaged(False)
    env.settings_file({"fiberhmm_source_dir": str(make_tree(env.root / "Release"))})
    env.app_choice("custom", str(make_tree(env.root / "app")))
    assert runtime.fiberhmm_selection()["source"] == "settings"
    from_env = make_tree(env.root / "env")
    monkeypatch.setenv("FIBERHMM_SOURCE_DIR", str(from_env))
    assert runtime.fiberhmm_selection()["root"] == str(from_env.resolve())


def test_source_run_without_a_tree_uses_the_installed_package(env):
    env.packaged(False)
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "installed" and sel["root"] is None and sel["version"] == "3.0.1"


# --- declarations and build detection --------------------------------------------------------------------------------

def test_requirements_come_from_core_and_the_pack_manifests(tmp_path, monkeypatch):
    pack = tmp_path / "browser" / "extra"
    pack.mkdir(parents=True)
    (pack / "fiberbrowser-pack.json").write_text(json.dumps(
        {"name": "extra", "label": "Extra", "flavor": "extra", "module": "extra.pack",
         "fiberhmm": {"features": [{"label": "the extra engine", "module": "fiberhmm.extra"}]}}))
    monkeypatch.setattr(runtime, "BROWSER_DIR", tmp_path / "browser")
    reqs = runtime.required_features()
    assert reqs[0] is not None and reqs[0]["features"] == runtime.CORE_REQUIREMENTS["features"]
    assert reqs[1]["features"][0]["label"] == "the extra engine" and reqs[1]["pack"] == "Extra"


def test_this_builds_pack_declares_what_it_needs():
    labels = [f["label"] for r in runtime.required_features() for f in r.get("features") or []]
    assert labels[:2] == [f["label"] for f in runtime.CORE_REQUIREMENTS["features"]]


def test_packaged_means_frozen_or_a_build_file(tmp_path, monkeypatch):
    monkeypatch.setattr(app_build, "build_info_candidates", lambda: [tmp_path / "build.json"])
    monkeypatch.setattr(app_build, "is_frozen", lambda: False)
    assert app_build.build_info() is None and app_build.is_packaged() is False
    (tmp_path / "build.json").write_text(json.dumps({"schema": app_build.BUILD_INFO_SCHEMA, "flavor": "lab",
                                                     "version": "3.0.0", "platform": "windows-x64"}))
    assert app_build.is_packaged() is True and app_build.platform_key() == "windows-x64"
    (tmp_path / "build.json").unlink()
    monkeypatch.setattr(app_build, "is_frozen", lambda: True)
    assert app_build.is_packaged() is True


def test_build_info_candidates_name_the_mac_bundle_and_the_wsl_prefix(monkeypatch, tmp_path):
    import sys
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "FiberBrowser.app/Contents/MacOS/FiberBrowser"))
    monkeypatch.setattr(sys, "prefix", "/opt/fiberbrowser")
    paths = [str(p) for p in app_build.build_info_candidates()]
    assert paths[0].endswith("FiberBrowser.app/Contents/Resources/fiberbrowser-build.json")
    assert paths[1] == "/opt/fiberbrowser/share/fiberbrowser/build.json"


def test_app_settings_file_is_separate_private_and_validated(tmp_path, monkeypatch):
    path = tmp_path / "app_settings.json"
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(path))
    monkeypatch.setattr(app_settings, "_cache", None)
    assert app_settings.load()["fiberhmm"] == {"source": "bundled", "custom_path": ""}
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    assert app_settings.load()["updates"]["check_at_startup"] is True
    app_settings.update("updates", {"check_at_startup": False, "manifest_url": "file:///Volumes/lab/update.json"})
    assert (path.stat().st_mode & 0o777) == 0o600
    assert json.loads(path.read_text())["updates"]["check_at_startup"] is False
    for bad in ({"check_at_startup": "no"}, {"manifest_url": "http://example.org/u.json"}, {"repo": "not a repo"}):
        with pytest.raises(ValueError):
            app_settings.update("updates", bad)
    with pytest.raises(ValueError):
        app_settings.update("fiberhmm", {"source": "elsewhere"})


def test_source_run_keeps_a_fiberhmm_package_that_lacks_even_core_files(env):
    """Only a folder with no FiberHMM package in it is passed over (with a notice)."""
    env.packaged(False)
    thin = env.root / "thin"
    (thin / "fiberhmm").mkdir(parents=True)
    (thin / "fiberhmm" / "__init__.py").write_text('__version__ = "3.0.0"\n')
    env.settings_file({"fiberhmm_source_dir": str(thin)})
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "settings" and sel["root"] == str(thin.resolve())
    assert "FiberHMM 3.0 core (strand rescue)" in sel["missing"]
    env.settings_file({"fiberhmm_source_dir": str(env.root / "nothing-here")})
    sel = runtime.fiberhmm_selection()
    assert sel["source"] == "installed" and "is not a FiberHMM source tree" in sel["notices"][0]


def test_a_save_within_one_clock_tick_is_seen(tmp_path, monkeypatch):
    """Linux (WSL) file times move in ticks of a few ms: two saves in one tick
    share an mtime, and load() served the settings from before the second."""
    import os
    path = tmp_path / "app_settings.json"
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(path))
    monkeypatch.setattr(app_settings, "_cache", None)
    app_settings.update("updates", {"repo": "lab/builds"})
    first = path.stat().st_mtime_ns
    assert app_settings.load()["updates"]["repo"] == "lab/builds"
    app_settings.update("updates", {"repo": "lab/other"})
    os.utime(path, ns=(first, first))  # the same tick
    assert app_settings.load()["updates"]["repo"] == "lab/other"


def test_check_at_startup_is_on_in_apps_and_off_in_source_runs_unless_set(tmp_path, monkeypatch):
    """Unset, the quiet update check at startup follows the kind of run; a value set in Settings applies to both."""
    path = tmp_path / "app_settings.json"
    monkeypatch.setenv("FIBERBROWSER_APP_SETTINGS", str(path))
    monkeypatch.setattr(app_settings, "_cache", None)
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    assert app_settings.load()["updates"]["check_at_startup"] is False
    assert app_settings.check_at_startup_is_set() is False
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    assert app_settings.load()["updates"]["check_at_startup"] is True  # same file, cached: still follows the run
    # Another setting saved doesn't pin the check at startup.
    app_settings.update("updates", {"repo": "lab/builds"})
    assert "check_at_startup" not in json.loads(path.read_text())["updates"]
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    assert app_settings.load()["updates"]["check_at_startup"] is False
    # Set in Settings: every run follows it.
    app_settings.update("updates", {"check_at_startup": True})
    assert app_settings.load()["updates"]["check_at_startup"] is True and app_settings.check_at_startup_is_set()
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    app_settings.update("updates", {"check_at_startup": False})
    assert app_settings.load()["updates"]["check_at_startup"] is False
