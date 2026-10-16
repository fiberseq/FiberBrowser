import subprocess
import sys
import threading

import pytest

from services import file_picker


@pytest.fixture
def on_mac(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")


def test_second_dialog_is_refused_while_one_is_open(on_mac, monkeypatch):
    opened = threading.Event()
    release = threading.Event()
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        opened.set()
        release.wait(5)
        return subprocess.CompletedProcess(cmd, 0, stdout="/data/a.bam\n", stderr="")

    monkeypatch.setattr(file_picker.subprocess, "run", fake_run)
    first = {}
    worker = threading.Thread(target=lambda: first.update(file_picker.pick_file_payload("bam")))
    worker.start()
    assert opened.wait(5)
    second = file_picker.pick_file_payload("bam")
    release.set()
    worker.join(5)
    assert second["success"] is False and second["cancelled"] is True
    assert "already open" in second["message"]
    assert first["path"] == "/data/a.bam"
    assert len(calls) == 1


def test_timed_out_dialog_is_closed(on_mac, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if "choose file" in cmd[2]:  # osascript -e <script> <prompt> [types...]
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(file_picker.subprocess, "run", fake_run)
    result = file_picker.pick_file_payload("bam")
    assert result["success"] is False and "timed out" in result["message"]
    assert any('"System Events" to quit' in cmd[-1] for cmd in calls)
    # The lock is released: the next dialog opens.
    monkeypatch.setattr(file_picker.subprocess, "run",
                        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="/x.bam\n", stderr=""))
    assert file_picker.pick_file_payload("bam")["path"] == "/x.bam"


def test_load_file_dialog_offers_only_supported_files_on_macos(on_mac, monkeypatch):
    """Audit L14: the macOS chooser for Load File had no Supported-files filter."""
    calls = []
    monkeypatch.setattr(file_picker.subprocess, "run",
                        lambda cmd, **kw: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, stdout="/d/a.bam\n", stderr=""))
    assert file_picker.pick_file_payload("open", multiple=True)["paths"] == ["/d/a.bam"]
    script, prompt, *types = calls[-1][2:]
    assert "of type theTypes" in script and "with multiple selections allowed" in script
    # macOS matches last extensions; .bed.gz -> gz; a .txt motif matrix stays pickable.
    assert {"bam", "bb", "bigbed", "bw", "bed", "gz", "gtf", "fa", "json", "txt"} <= set(types)
    assert "bai" not in types and "sam" not in types
    assert prompt.startswith("Select Files to Open") and prompt not in script  # an argument, not source

    file_picker.pick_file_payload("dataset", multiple=True)
    assert calls[-1][4:] == ["bam", "bb", "bigbed"]
    # "any" (run inputs, relinking...) stays unfiltered.
    file_picker.pick_file_payload("any", multiple=True)
    assert len(calls[-1]) == 4
