"""Real wheels, a fake PyPI, and disposable runtimes; never the installed app.

Both transports exercise identical bytes and production urllib reads. The HTTP
variant uses only 8880/8881 and explicitly skips if the sandbox forbids bind.
"""
import base64
import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from services import app_build, app_install, app_settings, app_update
from services import fiberhmm_runtime as runtime
from services import fiberhmm_update as updater
from port_list import bind_test_port

_REAL_DEFAULT_PACKAGE_DIR = runtime.default_package_dir


def package_files(version="3.1.0", broken=False, missing=False, broken_feature=False):
    files = {"fiberhmm/__init__.py": f'__version__ = "{version}"\n' +
             ('raise RuntimeError("broken overlay")\n' if broken else '')}
    for req in runtime.required_features():
        for feature in req.get("features", []):
            module = feature["module"].replace('.', '/')
            files[module + '.py'] = '\n'.join(f'def {n}(*args, **kwargs): pass' for n in feature.get('names', []))
            schema = feature.get('schema')
            if schema:
                # A schema in a child module makes its feature a package.
                files[module + '/__init__.py'] = files.pop(module + '.py')
                files[schema['module'].replace('.', '/') + '.py'] = f"{schema['name']} = {schema['min']!r}\n"
    for name in list(files):
        parts = name.split('/')
        for n in range(1, len(parts) - 1):
            files.setdefault('/'.join(parts[:n+1]) + '/__init__.py', '')
    if missing:
        files.pop('fiberhmm/inference/strand_rescue.py')
    if broken_feature:
        files['fiberhmm/inference/strand_rescue.py'] = 'raise ImportError("broken required feature")\n'
    return files


def wheel_bytes(version="3.1.0", requires=(), **kwargs):
    files = package_files(version, **kwargs)
    dist = f'fiberhmm-{version}.dist-info'
    files[f'{dist}/METADATA'] = (f'Metadata-Version: 2.1\nName: fiberhmm\nVersion: {version}\n'
                                'Requires-Python: >=3.10\nProvides-Extra: consensus\n' +
                                ''.join(f'Requires-Dist: {r}\n' for r in requires) + '\n')
    files[f'{dist}/WHEEL'] = 'Wheel-Version: 1.0\nGenerator: FiberBrowser-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
    record = io.StringIO()
    writer = csv.writer(record)
    for name, content in files.items():
        data = content.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
        writer.writerow((name, 'sha256=' + digest, len(data)))
    writer.writerow((f'{dist}/RECORD', '', ''))
    files[f'{dist}/RECORD'] = record.getvalue()
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as wheel:
        for name, data in files.items():
            wheel.writestr(name, data)
    return out.getvalue()


@pytest.fixture(params=['memory', 'http'])
def index(request, tmp_path, monkeypatch):
    monkeypatch.delenv('FIBERBROWSER_NO_UPDATE_CHECK', raising=False)
    monkeypatch.delenv('FIBERHMM_SOURCE_DIR', raising=False)
    monkeypatch.setenv('FIBERBROWSER_APP_SETTINGS', str(tmp_path / 'data/app_settings.json'))
    monkeypatch.setenv('FIBERBROWSER_SETTINGS', str(tmp_path / 'browser_settings.json'))
    monkeypatch.setattr(app_build, 'is_packaged', lambda: True)
    monkeypatch.setattr(app_build, 'build_info', lambda: {'fiberhmm_min_version': '3.0.3'})
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    monkeypatch.setattr(runtime, '_CONFIGURED_ROOT', None)
    monkeypatch.setattr(runtime, '_OVERLAY_CHECKS', {})
    bundled = tmp_path / 'bundle'
    for name, data in package_files('3.0.3').items():
        dest = bundled / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(data)
    monkeypatch.setattr(runtime, 'default_package_dir', lambda exclude=(): bundled / 'fiberhmm')
    routes, requests = {}, []
    server = None
    base = 'http://127.0.0.1:8881'
    if request.param == 'http':
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                data = routes.get(self.path)
                self.send_response(200 if data is not None else 404)
                self.end_headers()
                self.wfile.write(data or b'not found')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 8881), Handler, bind_and_activate=False)
        try:
            port = bind_test_port(server.socket)
            server.server_address = ('127.0.0.1', port)
            server.server_activate()
        except (OSError, RuntimeError) as error:
            server.server_close()
            pytest.skip(f'Local HTTP test server cannot bind authorized ports: {error}')
        base = f'http://127.0.0.1:{port}'
        threading.Thread(target=server.serve_forever, daemon=True).start()
    else:
        class Response(io.BytesIO):
            def geturl(self):
                return self.url
        def open_url(url, timeout):
            assert url.startswith(base + '/')
            path = url[len(base):]
            requests.append(path)
            if path not in routes:
                raise OSError('fake index offline')
            response = Response(routes[path])
            response.url = url
            return response
        monkeypatch.setattr(updater, 'urlopen', open_url)
    monkeypatch.setattr(updater, 'PYPI_JSON_URL', base + '/pypi/fiberhmm/json')
    updater.reset()
    class Index:
        def publish(self, version='3.1.0', digest=None, **kwargs):
            data = wheel_bytes(version, **kwargs)
            path = f'/fiberhmm-{version}-py3-none-any.whl'
            routes[path] = data
            entry = {'filename': path[1:], 'packagetype': 'bdist_wheel', 'yanked': False,
                     'url': base + path, 'digests': {'sha256': digest or hashlib.sha256(data).hexdigest()}}
            self.releases[version] = [entry]
            self.save()
            return entry
        def save(self):
            routes['/pypi/fiberhmm/json'] = json.dumps({'releases': self.releases}).encode()
        releases = None
    obj = Index()
    obj.releases = {}
    obj.requests = requests
    obj.routes = routes
    obj.bundle = bundled
    obj.publish()
    yield obj
    if server:
        server.shutdown()
        server.server_close()
    updater.reset()


def finish_install():
    updater.start_install()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = updater.status()
        if status['state'] != 'installing':
            return status
        time.sleep(.01)
    pytest.fail('FiberHMM installer did not finish')


def test_newest_stable_supported_non_yanked_wheel(index):
    index.publish('3.2.0rc1')
    index.publish('3.3.0.dev1')
    index.publish('3.4.0')['yanked'] = True
    index.publish('4.0.0')
    index.publish('3.0.1')
    index.save()
    check = updater.check(force=True)
    assert check['latest'] == '3.1.0' and check['current'] == '3.0.3'
    assert check['status'] == 'update_available'
    assert index.requests == ['/pypi/fiberhmm/json']
    index.releases = {'3.0.3': index.releases['3.1.0']}
    # No wheel whose filename version matches a release means no usable update.
    index.save()
    assert updater.check(force=True)['status'] == 'up_to_date'
    index.publish('3.0.3')
    assert updater.check(force=True)['status'] == 'up_to_date'


def test_sha_mismatch_is_rejected_without_activation(index):
    index.publish(digest='0' * 64)
    updater.check(force=True)
    job = finish_install()
    assert job['state'] == 'error' and 'SHA-256' in job['message']
    assert app_settings.load()['fiberhmm']['source'] == 'bundled'
    assert not updater.overlay_site('3.1.0').exists()


@pytest.mark.parametrize('requirement', ['nonexistent-fb-test-dependency>=999', 'packaging>=999',
                                          'nonexistent-fb-test-dependency; extra == "consensus"'])
def test_requirements_need_new_app(index, requirement):
    index.publish(requires=[requirement])
    updater.check(force=True)
    job = finish_install()
    assert job['state'] == 'needs_app_update'
    assert job['message'] == 'FiberHMM 3.1.0 needs a newer FiberBrowser app; update the app'
    assert app_settings.load()['fiberhmm']['source'] == 'bundled'
    assert not list(updater.overlays_dir().glob('.install-*'))


@pytest.mark.parametrize('problem', ['broken', 'missing', 'broken_feature'])
def test_failed_compatibility_never_activates(index, problem):
    index.publish(**{problem: True})
    updater.check(force=True)
    job = finish_install()
    assert job['state'] == 'error' and 'compatibility check failed' in job['message']
    assert app_settings.load()['fiberhmm']['source'] == 'bundled'
    assert not updater.overlay_site('3.1.0').exists()


def test_activation_restart_imports_overlay_and_subprocess_uses_it(index, monkeypatch):
    # A satisfied dependency, a false marker, and a non-consensus extra.
    index.publish(requires=['packaging>=1', 'missing-fb; python_version < "2"', 'missing-fb; extra == "other"'])
    assert runtime.fiberhmm_selection()['source'] == 'bundled'
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    assert runtime.fiberhmm_selection()['source'] == 'bundled'  # no hot swap
    assert runtime.fiberhmm_selection()['app_choice']['restart_needed']
    # A new interpreter is the restart boundary, with the packaged build simulated.
    code = '''
import sys, json, subprocess, os
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from services import app_build, fiberhmm_runtime as r
app_build.is_packaged = lambda: True
r.default_package_dir = lambda exclude=(): Path(sys.argv[2]) / 'fiberhmm'
r.configure_fiberhmm_runtime(strict=True)
import fiberhmm
root = r.bundled_fiberhmm_root()
env = dict(os.environ, PYTHONPATH=str(root))
child = subprocess.run([sys.executable, '-c', 'import fiberhmm; print(fiberhmm.__version__)'],
                       env=env, cwd=str(root), capture_output=True, text=True, check=True)
print(json.dumps([fiberhmm.__version__, child.stdout.strip(), r.fiberhmm_selection()['source']]))
'''
    result = subprocess.run([sys.executable, '-c', code, str(runtime.BROWSER_DIR), str(index.bundle)],
                            capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == ['3.1.0', '3.1.0', 'updated']


@pytest.mark.parametrize('damage', ['import', 'features', 'feature_import', 'missing'])
def test_startup_falls_back_with_notice(index, monkeypatch, damage):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    if damage == 'import':
        (site / 'fiberhmm/__init__.py').write_text('raise RuntimeError("broken")')
    elif damage == 'features':
        (site / 'fiberhmm/inference/strand_rescue.py').unlink()
    elif damage == 'feature_import':
        (site / 'fiberhmm/inference/strand_rescue.py').write_text('raise ImportError("broken feature")\n')
    else:
        import shutil
        shutil.rmtree(site)
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    selection = runtime.fiberhmm_selection()
    assert selection['source'] == 'bundled' and selection['root'] is None
    assert selection['version'] == '3.0.3'
    assert 'could not load' in selection['notices'][0]


def test_revert_and_pruning_keep_active_and_previous(index, monkeypatch):
    for version in ['3.1.0', '3.2.0', '3.3.0']:
        index.publish(version)
        updater.check(force=True)
        assert finish_install()['state'] == 'ready'
    assert sorted(p.name for p in updater.overlays_dir().iterdir()) == ['3.2.0', '3.3.0']
    assert updater.revert()['state'] == 'ready'
    assert app_settings.load()['fiberhmm']['source'] == 'bundled'
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    assert runtime.fiberhmm_selection()['source'] == 'bundled'
    assert sorted(p.name for p in updater.overlays_dir().iterdir()) == ['3.3.0']


@pytest.mark.parametrize('override', ['env', 'custom'])
def test_source_overrides_overlay_and_forbids_changes(index, monkeypatch, override):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    if override == 'env':
        monkeypatch.setenv('FIBERHMM_SOURCE_DIR', str(index.bundle))
    else:
        app_settings.update('fiberhmm', {'source': 'custom', 'custom_path': str(index.bundle)})
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    assert runtime.fiberhmm_selection()['source'] == ('env' if override == 'env' else 'app')
    for action in [updater.start_install, updater.revert, updater.restart]:
        with pytest.raises(updater.UpdateError, match='takes precedence'):
            action()


def test_network_failure_is_silent_and_logged(index, caplog):
    del index.routes['/pypi/fiberhmm/json']
    assert updater.check(force=True)['status'] == 'unavailable'
    assert 'FiberHMM update check failed' in caplog.text
    assert 'message' not in updater.check()


def test_settings_cadence_and_source_command(index, monkeypatch):
    app_settings.update('updates', {'check_at_startup': False})
    assert updater.check(startup=True)['status'] == 'disabled'
    assert not index.requests
    updater.check()
    updater.check()
    assert len(index.requests) == 1
    updater.check(force=True)
    assert len(index.requests) == 2
    monkeypatch.setattr(app_build, 'is_packaged', lambda: False)
    assert updater.check()['pip_command'] == 'pip install -U "fiberhmm[consensus]>=3.0.3,<4"'
    for action in [updater.start_install, updater.revert, updater.restart]:
        with pytest.raises(updater.UpdateError, match='pip install'):
            action()


def test_routes_install_activate_only_verified_wheel_and_revert(index, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.app_info import router
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr(app_update, 'check', lambda **kw: {'status': 'up_to_date'})
    with TestClient(app) as client:
        check = client.get('/api/app/update?force=1').json()
        assert check['fiberhmm']['latest'] == '3.1.0'
        assert client.post('/api/app/fiberhmm', json={'source': 'updated', 'overlay_version': '99'}).status_code == 422
        assert client.post('/api/app/fiberhmm/install').status_code == 200
        deadline = time.monotonic() + 10
        while updater.status()['state'] == 'installing' and time.monotonic() < deadline:
            time.sleep(.01)
        assert client.get('/api/app/fiberhmm/update').json()['state'] == 'ready'
        assert client.post('/api/app/fiberhmm/revert').json()['state'] == 'ready'


def test_restart_handoff_reuses_wait_for_server_and_desktop(index, monkeypatch):
    import fiberbrowser.cli as cli
    monkeypatch.setattr(cli, 'desktop_parent_pid', 12345)
    monkeypatch.setattr(app_install, 'running_bundle', lambda: index.bundle.with_name('Test App.app'))
    calls = []
    app_install.launch_restart(popen=lambda *a, **kw: calls.append((a, kw)))
    argv = calls[0][0][0]
    assert argv[:2] == ['/bin/sh', '-c']
    assert f'wait_for_exit {os.getpid()}' in argv[2] and 'wait_for_exit 12345' in argv[2]
    assert "exec /usr/bin/open '" in argv[2]
    assert calls[0][1]['start_new_session'] is True
    assert subprocess.run(['/bin/sh', '-n', '-c', argv[2]], capture_output=True).returncode == 0


@pytest.mark.parametrize("role", ["module", "entry-point"])
def test_frozen_module_child_selects_overlay(index, role):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    script = updater.overlay_site('3.1.0') / 'fiberhmm/overlay_probe.py'
    script.write_text('import fiberhmm\ndef main(): print(fiberhmm.__version__)\nif __name__ == "__main__": main()\n')
    dist = updater.overlay_site('3.1.0') / 'fiberhmm-3.1.0.dist-info'
    (dist / 'entry_points.txt').write_text('[console_scripts]\nfiberhmm-overlay-probe = fiberhmm.overlay_probe:main\n')
    code = '''
import sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from services import app_build, fiberhmm_runtime as runtime
from fiberbrowser import frozen_entry
app_build.is_packaged = lambda: True
runtime.default_package_dir = lambda exclude=(): Path(sys.argv[3]) / 'fiberhmm'
frozen_entry.configure_frozen_process = lambda: None  # never initialize platform cache/GUI in a test
frozen_entry.run(['-m', 'fiberhmm.overlay_probe'] if sys.argv[4] == 'module' else ['--entry-point', 'fiberhmm-overlay-probe'])
'''
    repo = runtime.BROWSER_DIR.parent
    result = subprocess.run([sys.executable, '-c', code, str(repo), str(runtime.BROWSER_DIR), str(index.bundle), role],
                            cwd=str(index.bundle), capture_output=True, text=True, check=True)
    assert result.stdout.strip() == '3.1.0'


@pytest.mark.parametrize("role", ["module", "script", "entry-point"])
def test_frozen_child_roles_find_the_backend_on_their_own(tmp_path, role):
    """Loky workers and the fiberhmm-* commands of the app start with only the app on sys.path (no browser/)."""
    (tmp_path / 'frozen_role_probe.py').write_text(
        'import sys\nprint("services" in sys.modules, sys.path.index(sys.argv[-1]) == len(sys.path) - 1)\n')
    repo = runtime.BROWSER_DIR.parent
    code = f'''
import sys
sys.path[:] = [p for p in sys.path if p not in ("", {str(runtime.BROWSER_DIR)!r})]
sys.path.insert(0, {str(repo)!r})
from fiberbrowser import frozen_entry
frozen_entry.configure_frozen_process = lambda: None
frozen_entry._console_script = lambda name: lambda: __import__("runpy").run_path({str(tmp_path / 'frozen_role_probe.py')!r})
role = sys.argv[1]
probe = {str(tmp_path / 'frozen_role_probe.py')!r}
argv = {{"module": ["-m", "frozen_role_probe"], "script": [probe], "entry-point": ["--entry-point", "probe"]}}[role]
sys.argv = ["app", *argv, {str(runtime.BROWSER_DIR)!r}]
frozen_entry.run([*argv, {str(runtime.BROWSER_DIR)!r}])
'''
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'} | {
        'PYTHONPATH': os.pathsep.join(p for p in os.environ.get('PYTHONPATH', '').split(os.pathsep)
                                      if p and os.path.realpath(p) != os.path.realpath(runtime.BROWSER_DIR))}
    result = subprocess.run([sys.executable, '-c', code, role], cwd=str(tmp_path), capture_output=True, text=True,
                            env=env)
    assert result.returncode == 0, result.stderr
    # services imported (the runtime was selected), and browser/ was appended, not put in front.
    assert result.stdout.split() == ['True', 'True']


def test_bundled_metadata_does_not_resolve_from_active_overlay(index, monkeypatch):
    from email.parser import Parser
    from types import SimpleNamespace
    seen = []
    def distributions(*, path):
        seen.append(path)
        return [SimpleNamespace(metadata=Parser().parsestr('Name: fiberhmm\n'), version='3.0.3')]
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr('importlib.metadata.distributions', distributions)
    assert runtime._default_version(index.bundle / 'fiberhmm') == '3.0.3'
    assert seen == [[str(index.bundle)]]


def test_windows_restart_is_native_detached_and_waits_for_launcher(index, monkeypatch):
    monkeypatch.setattr(app_install, 'running_bundle', lambda: None)
    monkeypatch.setattr(app_build, 'platform_key', lambda: 'windows-x64')
    monkeypatch.setattr(app_install, 'powershell', lambda: 'powershell.exe')
    calls = []
    from types import SimpleNamespace
    app_install.launch_restart(runner=lambda a, **kw: calls.append(a) or SimpleNamespace(returncode=0, stdout='', stderr=''))
    script = calls[0][-1]
    assert 'run\\server.json' in script and '$s.launcher' in script
    assert 'Wait-Process -Timeout 300' in script and '-EncodedCommand' in script
    assert 'Start-Process powershell.exe -WindowStyle Hidden' in script
    assert 'app\\FiberBrowser.exe' in script


def test_bad_wheel_paths_and_declared_python_rejected(index):
    from email.parser import Parser
    info = Parser().parsestr('Requires-Python: <2\n')
    assert updater.unmet_requirements(info) == ['Python <2']
    data = wheel_bytes()
    out = io.BytesIO(data)
    with zipfile.ZipFile(out, 'a') as archive:
        archive.writestr('../escape.py', 'bad')
    with pytest.raises(updater.UpdateError, match='unsafe path'):
        updater._unpack(out.getvalue(), updater.overlay_site('3.1.0'), '3.1.0')
    assert not (updater.overlays_dir() / 'escape.py').exists()


def test_override_during_download_prevents_activation(index, monkeypatch):
    updater.check(force=True)
    original_read = updater._read_url
    def download(url, limit):
        data = original_read(url, limit)
        monkeypatch.setenv('FIBERHMM_SOURCE_DIR', str(index.bundle))
        return data
    monkeypatch.setattr(updater, '_read_url', download)
    assert finish_install()['state'] == 'error'
    assert app_settings.load()['fiberhmm']['source'] == 'bundled'


def test_running_overlay_is_retained_as_previous_across_multiple_updates(index, monkeypatch):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    monkeypatch.setattr(runtime, '_APP_CHOICE', ('updated', '', '3.1.0'))
    for version in ['3.2.0', '3.3.0']:
        index.publish(version)
        updater.check(force=True)
        assert finish_install()['state'] == 'ready'
    assert sorted(p.name for p in updater.overlays_dir().iterdir()) == ['3.1.0', '3.3.0']
    updater.revert()
    # The current process still needs 3.1; bundled startup releases it for pruning.
    assert updater.overlay_site('3.1.0').exists()
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    assert runtime.fiberhmm_selection()['source'] == 'bundled'
    assert sorted(p.name for p in updater.overlays_dir().iterdir()) == ['3.3.0']


def test_fiberhmm_routes_cannot_be_opened_by_public_allowlist(index, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.app_info import router
    from services import public_mode_guard as guard
    app = FastAPI()
    app.include_router(router)
    actions = {('POST', '/api/app/fiberhmm/' + action) for action in ('install', 'revert', 'restart')}
    monkeypatch.setattr(guard, 'PUBLIC_ALLOWED', guard.PUBLIC_ALLOWED | actions)
    guard.install_public_mode_guard(app, lambda: True)
    with TestClient(app) as client:
        for _, path in actions:
            assert client.post(path).status_code == 403
    assert updater.status()['state'] == 'idle'


def test_requirement_versions_ignore_overlay_metadata(index, monkeypatch):
    site = updater.overlay_site('3.1.0')
    dist = site / 'packaging-999.dist-info'
    dist.mkdir(parents=True)
    (dist / 'METADATA').write_text('Metadata-Version: 2.1\nName: packaging\nVersion: 999\n')
    monkeypatch.syspath_prepend(str(site))
    assert updater.bundled_versions()['packaging'] != '999'
    from email.parser import Parser
    assert updater.unmet_requirements(Parser().parsestr('Requires-Dist: packaging>=999\n'))


def test_restart_handoff_is_idempotent(index, monkeypatch):
    calls = []
    monkeypatch.setattr(app_install, 'launch_restart', lambda: calls.append('launch'))
    assert updater.restart()['state'] == 'restarting'
    assert updater.restart()['state'] == 'restarting'
    assert updater.status()['state'] == 'restarting'
    assert calls == ['launch']


def test_fallback_excludes_overlay_already_on_pythonpath(index, monkeypatch):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    (site / 'fiberhmm/__init__.py').write_text('__version__ = "3.1.0"\nraise RuntimeError("broken")\n')
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    monkeypatch.setattr(runtime, 'default_package_dir', _REAL_DEFAULT_PACKAGE_DIR)
    monkeypatch.syspath_prepend(str(index.bundle))
    monkeypatch.syspath_prepend(str(site))
    selection = runtime.fiberhmm_selection()
    assert selection['source'] == 'bundled' and selection['version'] == '3.0.3'
    assert selection['package_dir'] == str(index.bundle / 'fiberhmm')


def test_fallback_import_in_fresh_child_ignores_failed_overlay_on_pythonpath(index):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    (site / 'fiberhmm/__init__.py').write_text('__version__ = "3.1.0"\nraise RuntimeError("broken")\n')
    code = """
import sys
sys.path[:0] = sys.argv[1:]
from services import app_build, fiberhmm_runtime as r
app_build.is_packaged = lambda: True
r.configure_fiberhmm_runtime()
import fiberhmm
print(fiberhmm.__version__)
"""
    result = subprocess.run([sys.executable, '-c', code, str(site), str(index.bundle), str(runtime.BROWSER_DIR)],
                            cwd=str(index.bundle), capture_output=True, text=True, check=True)
    assert result.stdout.strip() == '3.0.3'


def test_frozen_job_fingerprint_matches_the_overlay_it_runs(index, tmp_path):
    from services import library_jobs as jobs
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    cli = site / 'fiberhmm/cli'
    cli.mkdir()
    (cli / '__init__.py').write_text('')
    (cli / 'pipeline.py').write_text('import fiberhmm\nprint(fiberhmm.__version__)\n')
    repo = runtime.BROWSER_DIR.parent
    app = tmp_path / 'frozen-app'
    app.write_text(f"#!{sys.executable}\nimport sys\n"
                   f"sys.path[:0] = {[str(repo), str(runtime.BROWSER_DIR), str(index.bundle)]!r}\n"
                   "sys.frozen = True\nfrom fiberbrowser import frozen_entry\n"
                   "frozen_entry.configure_frozen_process = lambda: None\n"
                   "raise SystemExit(frozen_entry.run())\n")
    app.chmod(0o755)
    command = {'argv': [str(app), '-m', 'fiberhmm.cli.pipeline'], 'env': {}}
    fingerprint = jobs._fiberhmm_identity(command, str(index.bundle))
    ran = subprocess.run(command['argv'], cwd=str(index.bundle), capture_output=True, text=True, check=True)
    assert ran.stdout.strip() == fingerprint['runs']['version'] == '3.1.0'


def test_revert_then_retry_repairs_broken_existing_overlay(index, monkeypatch):
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    (site / 'fiberhmm/inference/strand_rescue.py').write_text('raise ImportError("damage")\n')
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    assert runtime.fiberhmm_selection()['source'] == 'bundled'
    assert updater.revert()['state'] == 'ready'
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    assert runtime.check_overlay(site, '3.1.0') is None
    monkeypatch.setattr(runtime, '_APP_CHOICE', None)
    monkeypatch.setattr(runtime, '_OVERLAY_CHECKS', {})
    assert runtime.fiberhmm_selection()['source'] == 'updated'


@pytest.mark.parametrize('problem', ['active', 'active_version_damaged', 'rename_failure'])
def test_repair_preserves_in_use_overlay_and_rolls_back_failed_rename(index, monkeypatch, problem):
    updater.check(force=True)
    offer = dict(updater._offer)
    assert finish_install()['state'] == 'ready'
    site = updater.overlay_site('3.1.0')
    if problem.startswith('active'):
        monkeypatch.setattr(runtime, '_APP_CHOICE', None)
        assert runtime.fiberhmm_selection()['source'] == 'updated'
        # The running process has loaded this overlay; disk damage must not
        # cause its directory to be replaced under already imported modules.
        if problem == 'active_version_damaged':
            (site / 'fiberhmm/__init__.py').write_text('__version__ = "9.0.0"\n')
    (site / 'fiberhmm/inference/strand_rescue.py').write_text('raise ImportError("damage")\n')
    if problem == 'rename_failure':
        updater.revert()
        original_replace = os.replace
        def replace(source, destination):
            if (str(source).split('/')[-1].startswith('.install-') and not str(source).endswith('.broken')
                    and destination == site.parent):
                raise OSError('simulated replacement failure')
            return original_replace(source, destination)
        monkeypatch.setattr(os, 'replace', replace)
    updater._install(offer)
    assert updater.status()['state'] == 'error'
    assert (site / 'fiberhmm/inference/strand_rescue.py').read_text() == 'raise ImportError("damage")\n'
    assert not list(site.parent.parent.glob('.install-*'))
    if problem.startswith('active'):
        assert 'restart before repairing' in updater.status()['message']
    else:
        assert app_settings.load()['fiberhmm']['source'] == 'bundled'


@pytest.mark.parametrize('command_name', ['pipeline', 'qc', 'call'])
@pytest.mark.parametrize('active', ['bundled', 'updated'])
def test_pending_selection_does_not_activate_in_frozen_job(index, tmp_path, monkeypatch, command_name, active):
    from services import pipeline_inputs as pi, qc_view
    import shutil
    # Real tiny modules on both runtimes. Do not import FiberHMM in this server.
    for name in ('pipeline', 'qc', 'call'):
        cli = index.bundle / 'fiberhmm/cli'
        cli.mkdir(exist_ok=True)
        (cli / '__init__.py').write_text('')
        (cli / (name + '.py')).write_text('import fiberhmm\nprint(fiberhmm.__version__)\n')
    old_version = '3.0.3'
    if active == 'updated':
        updater.check(force=True)
        assert finish_install()['state'] == 'ready'
        old_site = updater.overlay_site('3.1.0')
        shutil.copytree(index.bundle / 'fiberhmm/cli', old_site / 'fiberhmm/cli')
        monkeypatch.setattr(runtime, '_APP_CHOICE', None)
        old_version = '3.1.0'
    assert runtime.fiberhmm_selection()['version'] == old_version
    index.publish('3.2.0')
    updater.check(force=True)
    assert finish_install()['state'] == 'ready'
    shutil.copytree(index.bundle / 'fiberhmm/cli', updater.overlay_site('3.2.0') / 'fiberhmm/cli')
    repo = runtime.BROWSER_DIR.parent
    app = tmp_path / 'frozen-app'
    app.write_text(f'#!{sys.executable}\nimport sys, os\n'
                   f'sys.path[:0] = {[str(repo), str(runtime.BROWSER_DIR), str(index.bundle)]!r}\n'
                   'from services import app_build, app_settings, fiberhmm_runtime as runtime\napp_build.is_packaged = lambda: True\n'
                   'def no_pending_settings(): raise AssertionError("worker read pending settings")\n'
                   'if os.environ.get(runtime.ACTIVE_CHOICE_ENV): app_settings.load = no_pending_settings\n'
                   'from fiberbrowser import frozen_entry\n'
                   'frozen_entry.configure_frozen_process = lambda: None\n'
                   'raise SystemExit(frozen_entry.run())\n')
    app.chmod(0o755)
    monkeypatch.setattr(pi, '_module_available', lambda _: True)
    monkeypatch.setattr(sys, 'executable', str(app))
    command = {'pipeline': pi.pipeline_command, 'qc': qc_view.qc_command, 'call': pi.call_command}[command_name]()
    env = dict(os.environ, **command['env'])
    ran = subprocess.run(command['argv'], env=env, cwd=index.bundle, capture_output=True, text=True, check=True)
    assert ran.stdout.strip() == old_version
    # A real restart without the worker handoff picks up the pending selection.
    restarted = subprocess.run(command['argv'], env=dict(os.environ), cwd=index.bundle,
                               capture_output=True, text=True, check=True)
    assert restarted.stdout.strip() == '3.2.0'
