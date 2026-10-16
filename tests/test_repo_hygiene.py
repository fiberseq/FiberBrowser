"""No personal paths, local data or retired files in the tracked tree.

The checks here are generic. Terms that identify a person, lab or private data set are kept out of the public tree:
list them one per line in an untracked ``.hygiene-denylist`` at the repository root (ignored by git), or in a file
named by ``FIBERBROWSER_HYGIENE_DENYLIST``. When present, no tracked text file or BAM header may contain them
(matched case-insensitively).
"""
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
# A home folder in a path: only placeholder names (/Users/me, /home/someone, ...) and the container user.
HOME_PATH = re.compile(r"(?<![A-Za-z/])/(?:Users|home)/([A-Za-z0-9._-]+)")
PLACEHOLDER_USERS = {"me", "x", "a", "b", "u", "alice", "someone", "lab", "fiberbrowser", "..."}
REMOVED = ("test_catalog.json", "browser_test.ipynb", "browser/frontend/src/index.original.css",
           "browser/frontend/tailwind.config.original.js",
           "browser/frontend/src/components/charts/SequenceLogoChart.tsx",
           "data/copilot_dataset/seed_v1.jsonl", "CLAUDE.md")


def _tracked():
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
    return [p for p in out.stdout.decode().split("\0") if p]


def _texts():
    for rel in _tracked():
        if rel.startswith("browser/frontend/dist/"):
            continue
        path = ROOT / rel
        if not path.is_file() or path.stat().st_size > 5_000_000 or path.suffix in {".bam", ".bai", ".png", ".icns", ".ico"}:
            continue
        try:
            yield rel, path.read_text(errors="ignore")
        except OSError:
            continue


def _denylist():
    configured = os.environ.get("FIBERBROWSER_HYGIENE_DENYLIST", "").strip()
    path = Path(configured) if configured else ROOT / ".hygiene-denylist"
    if not path.is_file():
        return []
    return [line.strip().lower() for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")]


def _is_placeholder(name: str) -> bool:
    # A file right under /home (/home/a.bam) is not a home folder.
    return name.lower() in PLACEHOLDER_USERS or "." in name.strip(".")


def test_no_personal_home_paths_in_tracked_files():
    leaks = [f"{rel}: {m.group(0)}" for rel, text in _texts() for m in HOME_PATH.finditer(text)
             if rel != "tests/test_repo_hygiene.py" and not _is_placeholder(m.group(1))]
    assert not leaks


def test_no_denylisted_terms_in_tracked_files():
    terms = _denylist()
    if not terms:
        pytest.skip("no local denylist (.hygiene-denylist or FIBERBROWSER_HYGIENE_DENYLIST)")
    leaks = [f"{rel}: {t}" for rel, text in _texts() for t in terms if t in text.lower()]
    assert not leaks


def test_retired_and_generated_files_are_not_tracked():
    tracked = set(_tracked())
    assert not [p for p in REMOVED if p in tracked]


def test_no_tracked_symlinks_or_node_modules():
    # A worktree's node_modules symlink (absolute path to another checkout) was once
    # committed; checking it out replaced the real node_modules with a self-loop.
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-s", "-z"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
    entries = [e.split("\t", 1) for e in out.stdout.decode().split("\0") if e]
    symlinks = [path for meta, path in entries if meta.startswith("120000 ")]
    node_modules = [path for _, path in entries if "node_modules" in path.split("/")]
    assert not symlinks
    assert not node_modules


def test_no_personal_paths_in_bam_headers():
    """Tracked BAMs (the demos, test fixtures) carry no home-folder paths (or denylisted terms) in their headers."""
    pysam = pytest.importorskip("pysam")
    terms = _denylist()
    leaks = []
    for rel in _tracked():
        if not rel.endswith(".bam"):
            continue
        with pysam.AlignmentFile(str(ROOT / rel), "rb", check_sq=False) as bam:
            header = str(bam.header)
        leaks += [f"{rel}: {m.group(0)}" for m in HOME_PATH.finditer(header) if not _is_placeholder(m.group(1))]
        leaks += [f"{rel}: {t}" for t in terms if t in header.lower()]
    assert not leaks
