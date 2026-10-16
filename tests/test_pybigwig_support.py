"""A pyBigWig built without libcurl can't read URLs: FiberBrowser says so and how to fix it.

PyPI's x86_64 Linux pyBigWig wheels have ``pyBigWig.remote == 0``; before, a
remote bigWig/bigBed (http(s), s3://, ssh://, session links) failed with
libBigWig's "Unknown error during file opening" and nothing else.
"""
from __future__ import annotations

import pyBigWig
import pytest

from link_fixtures import write_bigwig
from services import copilot_doctor as doctor
from services import pybigwig_support
from services.remote_sources.opening import open_bigwig


@pytest.fixture
def no_libcurl(monkeypatch):
    monkeypatch.setattr(pyBigWig, "remote", 0, raising=False)


def test_a_url_names_the_missing_libcurl_and_the_fix(no_libcurl):
    with pytest.raises(RuntimeError, match="built without libcurl") as info:
        open_bigwig("http://127.0.0.1:9/signal.bw")
    assert "--force-reinstall" in str(info.value) or "bioconda" in str(info.value)


def test_local_tracks_still_open_without_libcurl(no_libcurl, tmp_path):
    path = tmp_path / "signal.bw"
    write_bigwig(str(path))
    handle = open_bigwig(str(path))
    try:
        assert "chr19" in handle.chroms()
    finally:
        handle.close()


def test_the_doctor_warns_about_a_pybigwig_without_libcurl(no_libcurl):
    checks = {c["id"]: c for c in doctor.run_doctor(network=False, copilot=False)["checks"]}
    assert checks["pybigwig_remote"]["status"] == "warn"
    assert "can't read" in checks["pybigwig_remote"]["title"]


def test_no_warning_when_pybigwig_reads_urls(monkeypatch):
    monkeypatch.setattr(pyBigWig, "remote", 1, raising=False)
    assert pybigwig_support.url_support_problem() is None
    ids = {c["id"] for c in doctor.run_doctor(network=False, copilot=False)["checks"]}
    assert "pybigwig_remote" not in ids


def test_the_linux_fix_builds_from_source(monkeypatch):
    monkeypatch.delenv("CONDA_PREFIX", raising=False)
    monkeypatch.setattr(doctor.sys, "platform", "linux")
    fix = doctor.pybigwig_fix()
    assert "--no-binary pyBigWig" in fix and "PATH=/usr/bin" in fix and "libcurl" in fix
