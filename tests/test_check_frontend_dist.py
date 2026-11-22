"""The release guard for the tracked frontend build (packaging/check_frontend_dist.py).

Release builds ship the committed browser/frontend/dist. A build records what it was made from
(dist/build-inputs.json, written by scripts/build-inputs.mjs from vite.config.ts); the guard recomputes those hashes
in Python. A dist without the manifest falls back to git history: it fails when a commit after the dist's last
one changed the frontend source (not file times), or the source has uncommitted changes; a
shallow clone that cannot see the dist's commit cannot tell. Exercised on throwaway repositories; the check
of this tree is opt-in (FIBERBROWSER_RELEASE_CHECK=1), since the dev line's dist is rebuilt only at release.
"""
import importlib.util
import json
import os
import shutil
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


# --- The build-inputs manifest (dist/build-inputs.json) ---

HASHER = ROOT / "browser" / "frontend" / "scripts" / "build-inputs.mjs"
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed: the Node/Python hash parity needs it")


def _manifest(repo, inputs=None, outputs=None):
    """What a build of the repo's current frontend source into its dist writes (the Python twin of the Node hasher)."""
    frontend = repo / "browser" / "frontend"
    return {"version": 1,
            "inputs": {"base": "browser/frontend", "paths": list(guard.INPUTS), **(inputs or guard.hash_inputs(frontend))},
            "outputs": outputs or guard.hash_outputs(frontend / "dist")}


def _build(repo, text):
    _write(repo, "browser/frontend/dist/index.js", text)
    (repo / "browser/frontend/dist/build-inputs.json").write_text(json.dumps(_manifest(repo)))


def test_an_identical_rebuild_after_a_comment_only_change_passes(repo):
    """Audit 3.1.0 (readpaths 7): a comment-only change leaves the build byte-identical, so nothing in dist changes to
    commit; the commit history alone kept rejecting it."""
    _build(repo, "built v1")
    _commit(repo, "build with its manifest")
    _write(repo, "browser/frontend/src/main.ts", "v1 // a comment")
    _commit(repo, "comment only")
    _build(repo, "built v1")  # the same bundle; only the manifest records the commented source
    code, message = guard.check(repo)
    assert code == 0 and "built from this source" in message, message
    _commit(repo, "rebuild (only the manifest changes)")
    assert guard.check(repo)[0] == 0


def test_a_dist_not_built_from_this_source_fails(repo):
    """Audit 3.1.0 (readpaths 7): a source change committed with an unrelated dist change (an icon) passed the
    commit-history check while the JavaScript stayed stale."""
    _build(repo, "built v1")
    _commit(repo, "build")
    _write(repo, "browser/frontend/src/main.ts", "v2")
    _write(repo, "browser/frontend/dist/icon.svg", "<svg/>")
    _commit(repo, "change the UI and the icon")
    code, message = guard.check(repo)
    assert code == 1 and "not built from this source" in message, message


def test_dist_files_changed_after_the_build_fail(repo):
    _build(repo, "built v1")
    _commit(repo, "build")
    _write(repo, "browser/frontend/dist/index.js", "hand-edited")
    code, message = guard.check(repo)
    assert code == 1 and "changed after the build" in message, message


def test_the_manifest_decides_a_shallow_clone(repo, tmp_path):
    _build(repo, "built v1")
    _commit(repo, "build")
    _write(repo, "browser/services/x.py", "backend")
    _commit(repo, "backend")
    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "-q", "--depth", "1", f"file://{repo}", str(shallow)], check=True)
    assert guard.check(shallow)[0] == 0


def test_a_manifest_of_another_algorithm_or_input_list_cannot_tell(repo):
    _build(repo, "built v1")
    path = repo / "browser/frontend/dist/build-inputs.json"
    data = json.loads(path.read_text())
    path.write_text(json.dumps({**data, "version": 99}))
    code, message = guard.check(repo)
    assert code == 2 and "version" in message
    path.write_text(json.dumps({**data, "inputs": {**data["inputs"], "paths": ["src"]}}))
    code, message = guard.check(repo)
    assert code == 2 and "input list" in message
    path.write_text("{not json")
    assert guard.check(repo)[0] == 2


def test_the_input_hash_counts_the_build_inputs_only(tmp_path):
    front = tmp_path / "browser/frontend"
    for rel, text in {"src/a.ts": "a", "src/b/c.tsx": "c", "index.html": "<html>", "README.md": "not an input"}.items():
        (front / rel).parent.mkdir(parents=True, exist_ok=True)
        (front / rel).write_text(text)
    before = guard.hash_inputs(front)
    assert before["files"] == 3
    # Tests, fixtures, dot files and files outside the inputs do not count.
    for rel in ("src/a.test.ts", "src/b/c.test.tsx", "src/__fixtures__/x.json", "src/.DS_Store", "scripts/x.mjs"):
        (front / rel).parent.mkdir(parents=True, exist_ok=True)
        (front / rel).write_text("x")
    assert guard.hash_inputs(front) == before
    # Content, a new input file and a rename do.
    (front / "src/a.ts").write_text("a2")
    changed = guard.hash_inputs(front)
    assert changed["sha256"] != before["sha256"]
    (front / "src/a.ts").write_text("a")
    (front / "src/b/c.tsx").rename(front / "src/b/d.tsx")
    assert guard.hash_inputs(front)["sha256"] != before["sha256"]
    # Bytes as read: CRLF line endings hash differently.
    (front / "src/b/d.tsx").rename(front / "src/b/c.tsx")
    assert guard.hash_inputs(front) == before
    (front / "index.html").write_bytes(b"<html>\r\n")
    assert guard.hash_inputs(front)["sha256"] != before["sha256"]


def _node_hashes(frontend, outputs=None):
    args = [NODE, str(HASHER), "--frontend", str(frontend)] + (["--outputs", str(outputs)] if outputs else [])
    return json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)


@needs_node
def test_node_and_python_hash_a_tree_alike(tmp_path):
    front = tmp_path / "browser/frontend"
    files = {"src/main.ts": b"line\r\nline\n", "src/\u00e9t\u00e9/caf\u00e9.tsx": "\u00e9".encode(), "src/Zed.ts": b"z",
             "src/a_b.ts": b"_", "src/a-b.ts": b"-", "public/img.bin": bytes(range(256)), "index.html": b"<html>",
             "package.json": b"{}", "src/x.test.ts": b"t", "src/__fixtures__/f.json": b"f", "src/.DS_Store": b"d",
             "src/api/sv.fixture.json": b"kept", "dist/index.html": b"<built>", "dist/assets/i.js": b"js",
             "dist/build-inputs.json": b"ignored", "dist/.DS_Store": b"ignored"}
    for rel, data in files.items():
        (front / rel).parent.mkdir(parents=True, exist_ok=True)
        (front / rel).write_bytes(data)
    node = _node_hashes(front, front / "dist")
    assert node["version"] == guard.MANIFEST_VERSION
    assert tuple(node["inputs"]["paths"]) == guard.INPUTS
    assert {k: node["inputs"][k] for k in ("files", "sha256")} == guard.hash_inputs(front)
    assert node["inputs"]["files"] == 9
    assert node["outputs"] == guard.hash_outputs(front / "dist") and node["outputs"]["files"] == 2


@needs_node
def test_node_and_python_hash_this_tree_alike():
    front = ROOT / "browser" / "frontend"
    node = _node_hashes(front, front / "dist")
    assert tuple(node["inputs"]["paths"]) == guard.INPUTS
    assert {k: node["inputs"][k] for k in ("files", "sha256")} == guard.hash_inputs(front)
    assert node["outputs"] == guard.hash_outputs(front / "dist")


@needs_node
def test_the_manifest_the_build_writes_passes_the_check(repo):
    """The Node writer (what vite.config.ts calls after a build) and the Python check agree end to end."""
    _write(repo, "browser/frontend/dist/index.js", "built v1")
    script = ("import { manifest } from %s; import { writeFileSync } from 'node:fs';"
              "writeFileSync(process.argv[2], JSON.stringify(manifest(process.argv[1], process.argv[1] + '/dist')));"
              % json.dumps(HASHER.as_uri()))
    front = repo / "browser" / "frontend"
    subprocess.run([NODE, "--input-type=module", "-e", script, str(front), str(front / "dist/build-inputs.json")],
                   check=True)
    code, message = guard.check(repo)
    assert code == 0 and "built from this source" in message, message
    _write(repo, "browser/frontend/src/main.ts", "v2")
    assert guard.check(repo)[0] == 1


def test_the_build_writes_the_manifest():
    """vite.config.ts bundles the hasher into its config: a "#!" line there breaks every build (esbuild)."""
    config = (ROOT / "browser" / "frontend" / "vite.config.ts").read_text()
    assert "writeManifest" in config and "buildInputs()" in config
    assert not HASHER.read_text().startswith("#!")


def test_a_dist_outside_the_checkout_cannot_tell_instead_of_crashing(repo, tmp_path):
    """3.1.0 LOW: a --dist outside the repository (no manifest) made the git-history fallback raise a traceback."""
    outside = tmp_path / "elsewhere" / "dist"
    outside.mkdir(parents=True)
    (outside / "index.js").write_text("built")
    code, message = guard.check(repo, str(outside))
    assert code == 2 and "outside" in message
