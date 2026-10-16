"""B3 round 6: consensus source fingerprints include companion files; expired sessions clean up."""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'browser'))

from services import consensus_workflow as cw


class _State:
    def __init__(self, datasets):
        self._ds = datasets

    def get_dataset(self, dsid):
        return self._ds.get(dsid)


def test_changed_companion_file_changes_the_snapshot(tmp_path):
    primary = tmp_path / 'a.fp.bb'; primary.write_bytes(b'x')
    tf = tmp_path / 'a.tf.bb'; tf.write_bytes(b'tf')
    ds = SimpleNamespace(path=str(primary), paths=[str(primary)], companion_layers={'tf': [str(tf)]})
    state = _State({'a': ds})
    before = cw._snapshot(state, ['a'])
    assert [row[0] for row in before['a']['files']] == [str(primary), str(tf)]
    tf.write_bytes(b'replaced tf layer')
    os.utime(tf, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
    assert not cw._same_sources(before, cw._snapshot(state, ['a']))


def test_snapshot_without_companions_is_unchanged(tmp_path):
    primary = tmp_path / 'a.bam'; primary.write_bytes(b'x')
    ds = SimpleNamespace(path=str(primary), paths=[str(primary)])
    snap = cw._snapshot(_State({'a': ds}), ['a'])
    assert snap['a']['files'] == [[str(primary), 1, primary.stat().st_mtime_ns]]


def test_dispose_session_removes_owned_directories_only(tmp_path):
    artifact = Path(tempfile.mkdtemp(prefix='fiberbrowser-consensus-'))
    cache = Path(tempfile.mkdtemp(prefix='fiberbrowser-family-cache-'))
    user_cache = tmp_path / 'my-cache'; user_cache.mkdir()
    state = SimpleNamespace()
    jobs, _ = cw._session(state)
    cancel = threading.Event()
    jobs['j'] = dict(job_id='j', status='complete', artifact_dir=str(artifact), _cancel=cancel,
                     request=dict(parameters=dict(compute=dict(fit_cache_dir=str(user_cache)))))
    state.consensus_family_cache_dir = str(cache)
    cw.dispose_session(state)
    deadline = time.time() + 5
    while (artifact.exists() or cache.exists()) and time.time() < deadline:
        time.sleep(0.05)
    assert not artifact.exists() and not cache.exists()
    assert user_cache.exists()
    assert cancel.is_set() and jobs == {}
