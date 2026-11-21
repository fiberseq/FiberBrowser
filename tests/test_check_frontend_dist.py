"""The release guard for the tracked frontend build (packaging/check_frontend_dist.py).

Release builds ship the committed browser/frontend/dist. The guard fails when a commit after the dist's last
one changed the frontend source (git history, not file times), or the source has uncommitted changes; a
shallow clone that cannot see the dist's commit cannot tell. Exercised on throwaway repositories; the check
of this tree is opt-in (FIBERBROWSER_RELEASE_CHECK=1), since the dev line's dist is rebuilt only at release.
"""
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_frontend_dist", ROOT / "packaging" / "check_frontend_dist.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def _git(repo, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.org", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.org"}
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout


def _write(repo, rel, text):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _commit(repo, message):
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)


@pytest.fixture
def repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _write(repo, "browser/frontend/src/main.ts", "v1")
    _write(repo, "browser/frontend/index.html", "<html>")
    _commit(repo, "source")
    _write(repo, "browser/frontend/dist/index.js", "built v1")
    _commit(repo, "build")
    return repo


def test_current_dist_passes(repo):
    code, message = guard.check(repo)
    assert code == 0 and "is current" in message


def test_a_later_source_commit_fails(repo):
    _write(repo, "browser/frontend/src/main.ts", "v2")
    _commit(repo, "change the UI")
    code, message = guard.check(repo)
    assert code == 1 and "1 commit(s) changed the frontend source" in message and "change the UI" in message
    _write(repo, "browser/frontend/dist/index.js", "built v2")
    _commit(repo, "rebuild")
    assert guard.check(repo)[0] == 0


def test_tests_and_other_files_do_not_count(repo):
    _write(repo, "browser/frontend/src/main.test.ts", "test")
    _write(repo, "browser/services/x.py", "backend")
    _commit(repo, "tests and backend")
    assert guard.check(repo)[0] == 0


def test_uncommitted_source_fails(repo):
    _write(repo, "browser/frontend/index.html", "<html lang=en>")
    code, message = guard.check(repo)
    assert code == 1 and "uncommitted changes" in message


def test_untracked_dist_fails(tmp_path):
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q")
    _write(repo, "browser/frontend/src/main.ts", "v1")
    _commit(repo, "source")
    code, message = guard.check(repo)
    assert code == 1 and "not tracked" in message


def test_shallow_clone_that_misses_the_dist_cannot_tell(repo, tmp_path):
    _write(repo, "browser/frontend/src/main.ts", "v2")
    _commit(repo, "change")
    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth", "1", f"file://{repo}", str(shallow)], check=True)
    code, message = guard.check(shallow)
    assert code == 2 and "Shallow clone" in message


def test_not_a_checkout_passes_with_a_note(tmp_path):
    code, message = guard.check(tmp_path)
    assert code == 0 and "not a git checkout" in message


def test_command_line_exit_codes(repo):
    assert guard.main(["--repo", str(repo)]) == 0
    _write(repo, "browser/frontend/src/main.ts", "v2")
    _commit(repo, "change")
    assert guard.main(["--repo", str(repo)]) == 1
    assert guard.main(["--repo", str(repo), "--source", "browser/frontend/index.html"]) == 0


@pytest.mark.skipif(os.environ.get("FIBERBROWSER_RELEASE_CHECK") != "1",
                    reason="release check: set FIBERBROWSER_RELEASE_CHECK=1 (the dev line's dist is rebuilt at release)")
def test_this_trees_tracked_dist_is_current():
    code, message = guard.check(ROOT)
    assert code == 0, message
