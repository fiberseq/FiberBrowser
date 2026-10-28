"""Validate only the cache guard, without executing the e2e runner or servers."""
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize('location', ['scratch', 'checkout', 'home_cache', 'linked_child', 'persistent'])
def test_identify_cache_guard(tmp_path, location):
    script = (Path(__file__).resolve().parents[1] / 'browser/frontend/scripts/e2e-full.sh').read_text()
    guard = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
    home, repo = tmp_path / 'work/home', tmp_path / 'checkout'
    home.mkdir(parents=True)
    repo.mkdir()
    cache = tmp_path / 'persistent'
    if location == 'scratch':
        cache = home / 'cache'
    elif location == 'checkout':
        cache = repo / 'cache'
    elif location == 'home_cache':
        cache = tmp_path / '.fiberhmm/cache'
    elif location == 'linked_child':
        cache.mkdir()
        (cache / 'blast').symlink_to(home, target_is_directory=True)
    result = subprocess.run([sys.executable, '-', str(cache), str(home), str(repo)], input=guard,
                            text=True, capture_output=True)
    assert (result.returncode == 0) is (location == 'persistent')
    assert not (home / '.fiberhmm').exists()
