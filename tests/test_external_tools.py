"""The shared tool resolver (services/external_tools.py): where BLAST+, minimap2 and
samtools are looked for, in which order, that each candidate must run, and that the
Mac app's minimal launchd PATH still finds a Homebrew/conda install (primer design too)."""
from __future__ import annotations

import os
import stat
from types import SimpleNamespace

import pytest

from services import external_tools as et


def _tool(folder, name, version="2.17.0+", rc=0):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    out = f"{name}: {version}" if name in ("blastn", "makeblastdb") else version
    path.write_text(f"#!/bin/sh\necho '{out}'\nexit {rc}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


@pytest.fixture
def places(tmp_path, monkeypatch):
    """Empty bundle/common folders and settings; PATH without the tools. The system
    folders on PATH are an empty stand-in: a Linux /usr/bin may hold its own
    minimap2 or BLAST+ (apt), which PATH rightly finds before the common folders."""
    monkeypatch.setenv("FIBERBROWSER_SETTINGS", str(tmp_path / "settings.json"))
    import services.user_settings as us
    monkeypatch.setattr(us, "_cache", None)
    bundle, common, onpath, system = (tmp_path / "bundle", tmp_path / "common", tmp_path / "onpath",
                                      tmp_path / "system")
    for d in (bundle, common, onpath, system):
        d.mkdir()
    monkeypatch.setattr(et, "_bundle_dirs", lambda: [str(bundle)])
    monkeypatch.setattr(et, "common_dirs", lambda environ=None: [str(common)])
    monkeypatch.setenv("PATH", f"{onpath}:{system}")
    et.clear_cache()
    yield SimpleNamespace(root=tmp_path, bundle=bundle, common=common, onpath=onpath, system=system)
    et.clear_cache()


def _settings(places, data):
    import json
    import services.user_settings as us
    (places.root / "settings.json").write_text(json.dumps(data))
    us._cache = None
    et.clear_cache()


def test_order_settings_bundle_path_common(places):
    _tool(places.common, "blastn", "2.10.0+")
    assert et.resolve("blastn").source == "common"
    _tool(places.onpath, "blastn", "2.12.0+")
    assert et.resolve("blastn", refresh=True).source == "PATH"
    _tool(places.bundle, "blastn", "2.15.0+")
    info = et.resolve("blastn", refresh=True)
    assert (info.source, info.version) == ("bundle", "2.15.0+")  # the app's own copy beats PATH
    mine = _tool(places.root / "mine", "blastn", "2.17.0+")
    _settings(places, {"tools": {"blastn": mine}})
    assert et.resolve("blastn").path == mine and et.resolve("blastn").source == "settings"
    _settings(places, {"blast_dir": str(places.root / "mine")})
    assert et.resolve("blastn").source == "settings"


def test_a_candidate_must_run(places):
    _tool(places.bundle, "blastn", rc=1)  # present but broken
    good = _tool(places.common, "blastn", "2.17.0+")
    info = et.resolve("blastn")
    assert info.path == good and info.version == "2.17.0+"
    assert info.rejected and info.rejected[0][0].startswith(str(places.bundle))
    (places.bundle / "notexec").write_text("x")
    assert et.verify(str(places.bundle / "notexec"), "blastn") == (None, "not found")


def test_missing_tool_says_how_to_install(places):
    info = et.resolve("makeblastdb")
    assert not info.ok
    d = info.to_dict()
    assert d["ok"] is False and "brew install blast" in d["hint"] and "conda install -c bioconda blast" in d["hint"]
    with pytest.raises(et.ToolMissing, match="brew install blast"):
        et.require("makeblastdb")
    summary = et.blast_summary()
    assert summary["ok"] is False and summary["label"] == "BLAST+ not found"


def test_versions_and_summary(places):
    _tool(places.common, "blastn", "2.17.0+")
    _tool(places.common, "makeblastdb", "2.17.0+")
    s = et.blast_summary()
    assert s["ok"] and s["label"].startswith("BLAST+ 2.17.0+ (") and s["hint"] == ""
    _tool(places.common, "minimap2", "2.30-r1287")
    assert et.resolve("minimap2").version == "2.30-r1287"


def test_cached_until_refresh(places):
    assert not et.resolve("samtools").ok
    _tool(places.common, "samtools", "samtools 1.21")
    assert not et.resolve("samtools").ok  # cached
    assert et.resolve("samtools", refresh=True).ok


def test_minimal_launchd_path_still_finds_homebrew_and_conda(places, monkeypatch):
    """The app from Finder: PATH=/usr/bin:/bin:/usr/sbin:/sbin (the system folders), no bundle BLAST."""
    monkeypatch.setenv("PATH", str(places.system))
    brew = _tool(places.common, "blastn", "2.17.0+")
    et.clear_cache()
    assert et.tool_path("blastn") == brew

def test_common_dirs_cover_homebrew_conda_and_local(monkeypatch, tmp_path):
    real = et
    dirs = real.common_dirs({"CONDA_PREFIX": str(tmp_path / "env")})
    home = os.path.expanduser("~")
    for want in ("/opt/homebrew/bin", "/usr/local/bin", str(tmp_path / "env" / "bin"),
                 f"{home}/miniconda3/bin", f"{home}/miniforge3/bin", f"{home}/anaconda3/bin", f"{home}/.local/bin", "/usr/bin"):
        assert want in dirs


def test_primer_design_finds_blast_with_the_app_path(places, monkeypatch, tmp_path):
    """resolve_primer_runtime_config under launchd's PATH: BLAST found in a common folder."""
    monkeypatch.setenv("PATH", str(places.system))
    _tool(places.common, "blastn", "2.17.0+")
    et.clear_cache()
    from services.primer_orchestration import resolve_primer_runtime_config
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(fasta_path=str(fasta), primer_fasta=None, primer_blast_db=str(tmp_path / "dm6"),
                            current_genome="dm6")
    runtime, error = resolve_primer_runtime_config(state)
    assert error is None and runtime.blast_db_path == str(tmp_path / "dm6")
    # And the BLAST run itself uses that binary.
    import services.primer_blast_runtime as rt
    seen = {}

    class FakeProc:
        returncode = 0

        def communicate(self):
            return b"", b""

        def poll(self):
            return 0
    monkeypatch.setattr(rt.subprocess, "Popen", lambda cmd, **kw: seen.setdefault("cmd", cmd) and FakeProc())
    rt.run_blast("q.fa", str(tmp_path / "dm6"), "out.tsv")
    assert seen["cmd"][0] == str(places.common / "blastn")


def test_primer_config_reports_the_blast_in_use(places, tmp_path):
    _tool(places.common, "blastn", "2.17.0+")
    _tool(places.common, "makeblastdb", "2.17.0+")
    et.clear_cache()
    from services.primer_config import primer_config_payload
    payload = primer_config_payload(SimpleNamespace(primer_fasta=None, fasta_path=None, primer_blast_db=None,
                                                    current_genome=None), validate_blast=False)
    assert payload["blast_tool"]["ok"] and "2.17.0+" in payload["blast_tool"]["label"]


@pytest.mark.skipif(not os.path.exists("/opt/homebrew/bin/blastn"), reason="no Homebrew BLAST+ on this machine")
def test_real_homebrew_blast_found_from_a_minimal_path(monkeypatch):
    real = et
    real.clear_cache()
    info = real.resolve("blastn", environ={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
    assert info.ok and info.version and info.path


def test_subprocess_path_puts_the_resolved_tool_first_and_nothing_else(places, monkeypatch):
    """A different copy earlier on PATH must not win in the pipeline's subprocess, and the
    resolved tool's folder must not shadow other programs (only links to the tools)."""
    other = places.root / "other"
    _tool(other, "minimap2", "2.1-old")
    chosen = _tool(places.common, "minimap2", "2.30")
    _tool(places.common, "python3", "3.99")  # a neighbour in the resolver's folder
    _settings(places, {"tools": {"minimap2": chosen}})
    path = et.path_with_tools(f"{other}:/usr/bin:/bin", names=("minimap2",))
    first = path.split(":")[0]
    assert os.path.realpath(os.path.join(first, "minimap2")) == os.path.realpath(chosen)
    assert not os.path.exists(os.path.join(first, "python3"))
    import shutil
    assert os.path.realpath(shutil.which("minimap2", path=path)) == os.path.realpath(chosen)
    assert et.path_with_tools(path, names=("minimap2",)) == path  # idempotent


def test_a_broken_first_path_entry_does_not_hide_a_later_one(places, monkeypatch):
    broken, good = places.root / "p1", places.root / "p2"
    _tool(broken, "samtools", rc=2)
    want = _tool(good, "samtools", "samtools 1.21")
    monkeypatch.setenv("PATH", f"{broken}:{good}:/usr/bin:/bin")
    et.clear_cache()
    info = et.resolve("samtools")
    assert info.path == want and info.source == "PATH"
    assert [str(broken / "samtools"), "exited 2 without a version"] in info.rejected


def test_pipeline_aligner_check_uses_the_resolver(places, monkeypatch):
    monkeypatch.setenv("PATH", str(places.system))
    _tool(places.common, "minimap2", "2.30-r1287")
    et.clear_cache()
    from services.pipeline_inputs import aligner_status
    status = aligner_status({"source": "module"})
    assert status["ok"] and status["name"] == "minimap2 2.30-r1287"
