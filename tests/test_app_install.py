"""Installation unit tests: no signing, OS installation, GUI, server, or ports."""
import hashlib
import os
import stat
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import app_build, app_install, app_update
from test_app_update import updates, shared_folder, client, manifest


class Runner:
    def __init__(self, fail=None, other_team=False):
        self.calls = []
        self.fail = fail
        self.other_team = other_team

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        assert kwargs["timeout"] == 180
        if self.fail and self.fail in " ".join(argv):
            return SimpleNamespace(returncode=1, stdout="", stderr="verification refused")
        if argv[0].endswith("ditto"):
            with zipfile.ZipFile(argv[-2]) as archive:
                archive.extractall(argv[-1])
        team = "OTHERTEAM" if self.other_team and "new.app" in argv[-1] else "D57M2AHZJ2"
        return SimpleNamespace(returncode=0, stdout="", stderr=f"TeamIdentifier={team}\n")


@pytest.fixture
def bundles(tmp_path):
    running = tmp_path / "Apps with spaces" / "FiberBrowser.app"
    (running / "Contents" / "MacOS").mkdir(parents=True)
    (running / "Contents" / "MacOS" / "FiberBrowser").write_text("old")
    archive = tmp_path / "update.zip"
    with zipfile.ZipFile(archive, "w") as out:
        out.writestr("new.app/Contents/MacOS/FiberBrowser", "new")
    return running, archive


def test_stage_next_to_app_and_verify_all_gates(bundles):
    running, archive = bundles
    runner = Runner()
    plan = app_install.stage_mac(archive, running, runner=runner)
    assert Path(plan["stage"]).parent == running.parent
    assert Path(plan["stage"]).stat().st_mode & 0o777 == 0o700
    assert (Path(plan["staged"]) / "Contents/MacOS/FiberBrowser").read_text() == "new"
    assert [c[1] for c in runner.calls] == ["-x", "--verify", "-dv", "-dv", "--assess"]
    assert runner.calls[1][1:4] == ["--verify", "--deep", "--strict"]
    assert runner.calls[-1][1:4] == ["--assess", "--type", "execute"]
    assert plan["team"] == "D57M2AHZJ2"
    assert (running / "Contents/MacOS/FiberBrowser").read_text() == "old"


@pytest.mark.parametrize("gate", ["--verify", "-dv", "--assess", "ditto"])
def test_failed_verification_removes_staging_and_keeps_old_bundle(bundles, gate):
    running, archive = bundles
    with pytest.raises(app_install.InstallError, match="failed"):
        app_install.stage_mac(archive, running, runner=Runner(fail=gate))
    assert not list(running.parent.glob(".fiberbrowser-update-*"))
    assert running.is_dir()


def test_team_id_is_compared_to_running_bundle(bundles):
    with pytest.raises(app_install.InstallError, match="Team ID differs"):
        app_install.stage_mac(bundles[1], bundles[0], runner=Runner(other_team=True))


def test_matching_but_untrusted_team_is_refused(bundles):
    def runner(argv, **kwargs):
        result = Runner()(argv, **kwargs)
        result.stderr = result.stderr.replace("D57M2AHZJ2", "OTHERTEAM")
        return result
    with pytest.raises(app_install.InstallError, match="FiberBrowser's Team ID"):
        app_install.stage_mac(bundles[1], bundles[0], runner=runner)
    assert not list(bundles[0].parent.glob(".fiberbrowser-update-*"))
    assert (bundles[0] / "Contents/MacOS/FiberBrowser").read_text() == "old"


def test_missing_team_id_is_refused(bundles):
    runner = lambda *a, **kw: SimpleNamespace(returncode=0, stdout="", stderr="TeamIdentifier=not set")
    with pytest.raises(app_install.InstallError, match="Team ID"):
        app_install.team_id(bundles[0], runner=runner)


def test_non_writable_folder_never_stages(bundles, monkeypatch):
    monkeypatch.setattr(os, "access", lambda *args: False)
    runner = Runner()
    with pytest.raises(app_install.InstallError, match="not writable"):
        app_install.stage_mac(bundles[1], bundles[0], runner=runner)
    assert runner.calls == []


@pytest.mark.parametrize("unsafe", ["../escape", "/absolute", "new.app/../../escape", "new.app\\escape"])
def test_archive_traversal_refused(tmp_path, unsafe):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as out:
        out.writestr(unsafe, "bad")
    with pytest.raises(app_install.InstallError, match="unsafe path"):
        app_install.check_archive(archive)


def test_archive_escaping_symlink_refused(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as out:
        link = zipfile.ZipInfo("new.app/link")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        out.writestr(link, "../../../escape")
    with pytest.raises(app_install.InstallError, match="unsafe symbolic link"):
        app_install.check_archive(archive)


def test_mac_helper_waits_for_both_pids_and_keeps_rollback(bundles, tmp_path):
    plan = app_install.stage_mac(bundles[1], bundles[0], runner=Runner())
    script = app_install.mac_helper(plan, 12345, 12346)
    assert "while kill -0" in script and "sleep 1" in script
    assert "wait_for_exit 12345" in script and "wait_for_exit 12346" in script
    assert script.index("wait_for_exit 12346") < script.index("codesign --verify")
    assert "team=D57M2AHZJ2" in script and '[ "$actual" = "$team" ]' in script
    assert script.index("spctl --assess") < script.index('mv "$running" "$old"') < script.index("xattr -dr")
    assert '$HOME/.Trash' in script and 'mv "$old" "$running"' in script
    assert 'open "$running"' in script
    helper = tmp_path / "check.sh"
    helper.write_text(script)
    # Execution with OS stubs is covered below.
    assert subprocess.run(["/bin/sh", "-n", str(helper)], capture_output=True).returncode == 0


def test_helper_is_detached_and_reverified_before_launch(bundles, monkeypatch):
    plan = app_install.stage_mac(bundles[1], bundles[0], runner=Runner())
    monkeypatch.setenv("FIBERBROWSER_EXIT_WITH_PARENT", "12346")
    calls = []
    runner = Runner()
    app_install.launch_helper(plan, "a" * 64, runner=runner, popen=lambda a, **kw: calls.append((a, kw)))
    assert len(runner.calls) == 4
    argv, options = calls[0]
    assert argv[0] == "/bin/sh" and options["start_new_session"] is True
    assert options['env']['PATH'] == '/usr/bin:/bin:/usr/sbin:/sbin'
    assert Path(argv[1]).stat().st_mode & 0o777 == 0o700
    calls.clear()
    with pytest.raises(app_install.InstallError):
        app_install.launch_helper(plan, "a" * 64, runner=Runner(fail="--assess"), popen=lambda *a, **kw: calls.append(a))
    assert calls == []


@pytest.mark.parametrize('failure', ['', 'codesign', 'team', 'spctl', 'replacement', 'relaunch', 'timeout'])
def test_execute_real_mac_helper(bundles, tmp_path, failure):
    """Execute the production script; every OS integration is a PATH stub.

    mv really moves the temporary bundles, except for an injected replacement
    failure. No real macOS verification, disk mounting, alert or launch occurs.
    """
    import json
    running, archive = bundles
    stage = tmp_path / "staging ' with spaces"
    stage.mkdir()
    staged = stage / 'new.app'
    with zipfile.ZipFile(archive) as source:
        source.extractall(stage)
    plan = dict(stage=str(stage), staged=str(staged), running=str(running), team=app_install.MAC_TEAM_ID)
    bindir = tmp_path / 'bin'
    bindir.mkdir()
    calls = tmp_path / 'calls.jsonl'
    stub = f'''#!{sys.executable}
import json, os, pathlib, shutil, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as out:
    out.write(json.dumps([name, *args]) + '\\n')
failure = os.environ['FAILURE']
if name == 'sleep':
    time.sleep(.005)
elif name == 'codesign':
    if failure == name: sys.exit(1)
    if '-dv' in args:
        print('TeamIdentifier=' + ('OTHER' if failure == 'team' else '{app_install.MAC_TEAM_ID}'), file=sys.stderr)
elif name == 'spctl' and failure == name:
    sys.exit(1)
elif name == 'mv':
    if failure == 'replacement' and args[0] == os.environ['STAGED']: sys.exit(1)
    shutil.move(*args)
elif name == 'open' and failure == 'relaunch':
    bundle = pathlib.Path(args[-1])
    if (bundle / 'Contents/MacOS/FiberBrowser').read_text() == 'new': sys.exit(1)
elif name == 'ditto':
    shutil.copytree(args[-2], args[-1])
elif name == 'hdiutil' and failure == name:
    sys.exit(1)
elif name in ('xattr', 'osascript') and failure == name:
    sys.exit(1)
'''
    for name in ['codesign', 'spctl', 'xattr', 'ditto', 'hdiutil', 'open', 'osascript', 'mv', 'sleep']:
        path = bindir / name
        path.write_text(stub)
        path.chmod(0o755)
    home = tmp_path / 'home'
    home.mkdir()
    env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'], HOME=str(home),
               CALLS=str(calls), FAILURE=failure, STAGED=str(staged))
    # A real disposable process is the parent being waited on. Reap it in a
    # thread so kill -0 stops seeing it after it exits (no lingering zombie).
    import threading
    parent = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    waiter = threading.Thread(target=parent.wait)
    waiter.start()
    if failure != 'timeout':
        timer = threading.Timer(.15, parent.terminate)
        timer.start()
    helper = stage / 'install.sh'
    helper.write_text(app_install.mac_helper(plan, parent.pid, parent.pid))
    try:
        parsed = subprocess.run(['bash', '-n', str(helper)], capture_output=True, text=True)
        assert parsed.returncode == 0, parsed.stderr
        result = subprocess.run(['bash', str(helper)], env=env, capture_output=True, text=True, timeout=30)
    finally:
        if parent.poll() is None:
            parent.terminate()
        waiter.join(timeout=5)
    log = (stage / 'install.log').read_text()
    recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
    assert result.returncode == (1 if failure else 0), log
    assert (running / 'Contents/MacOS/FiberBrowser').read_text() == ('old' if failure else 'new'), log
    if not failure:
        assert ['open', str(running)] in recorded
        assert not any(call[0] == 'osascript' for call in recorded)
        assert next(home.glob('.Trash/*/FiberBrowser.app/Contents/MacOS/FiberBrowser')).read_text() == 'old'
    else:
        alerts = [call for call in recorded if call[0] == 'osascript']
        assert len(alerts) == 1, log
        assert 'disk image' in alerts[0][-1]  # manual DMG fallback after the server exits
        if failure in ('codesign', 'team', 'spctl', 'timeout'):
            assert not any(call[0] == 'xattr' for call in recorded)
    if failure == 'timeout':
        assert not any(call[0] in ('codesign', 'mv', 'open') for call in recorded)
    if failure in ('replacement', 'relaunch'):
        assert ['open', str(running)] in recorded  # working old app is relaunched


def test_source_cannot_install_or_restart(monkeypatch):
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    assert '"fiberhmm[consensus]>=3.0.3,<4"' in app_update.PIP_COMMAND
    with pytest.raises(app_update.UpdateError, match="pip install"):
        app_update.start_install()
    with pytest.raises(app_update.UpdateError, match="pip install"):
        app_update.restart_install()


def test_running_bundle_uses_existing_packaged_detection(bundles, monkeypatch):
    running, _ = bundles
    monkeypatch.setattr(app_install.sys, "executable", str(running / "Contents/MacOS/FiberBrowser"))
    monkeypatch.setattr(app_install.sys, "platform", "darwin")
    monkeypatch.setattr(app_build, "is_packaged", lambda: True)
    assert app_install.running_bundle() == running
    monkeypatch.setattr(app_build, "is_packaged", lambda: False)
    assert app_install.running_bundle() is None


@pytest.fixture
def install_offer(updates, bundles, monkeypatch):
    folder = shared_folder(updates["tmp"])
    archive = bundles[1]
    zip_entry = {"kind": "zip", "name": "update.zip", "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    private = {"entry": {"kind": "dmg", "name": "FiberBrowser-3.0.1-arm64.dmg", "sha256": hashlib.sha256((folder / "FiberBrowser-3.0.1-arm64.dmg").read_bytes()).hexdigest()},
               "install_entry": zip_entry, "platform": "macos-arm64", "origin": {"kind": "file", "base": str(folder)}, "version": "3.0.1"}
    (folder / "update.zip").write_bytes(archive.read_bytes())
    monkeypatch.setattr(app_update, "_last_private", private)
    monkeypatch.setattr(app_install, "running_bundle", lambda: bundles[0])
    monkeypatch.setattr(app_install.subprocess, "run", Runner())
    class ImmediateThread:
        def __init__(self, target, args, **kw):
            self.target, self.args = target, args
        def start(self):
            self.target(*self.args)
    monkeypatch.setattr(app_update.threading, "Thread", ImmediateThread)
    opened = []
    monkeypatch.setattr(app_update, "open_download", lambda: opened.append("dmg"))
    return private, opened


def test_install_pipeline_ready_then_cancel_discards_stage(install_offer):
    assert app_update.start_install()["state"] == "ready"
    stage = Path(app_update._install_plan["stage"])
    assert stage.is_dir()
    assert app_update.cancel_download()["state"] == "cancelled"
    assert not stage.exists()
    with pytest.raises(app_update.UpdateError, match="no verified update"):
        app_update.restart_install()


@pytest.mark.parametrize("failure", ["--verify", "--assess", "writable", "sha256"])
def test_pipeline_failure_opens_dmg_with_reason(install_offer, monkeypatch, failure):
    private, opened = install_offer
    if failure == "writable":
        monkeypatch.setattr(os, "access", lambda *a: False)
    elif failure == "sha256":
        private["install_entry"]["sha256"] = "0" * 64
    else:
        monkeypatch.setattr(app_install.subprocess, "run", Runner(fail=failure))
    result = app_update.start_install()
    assert result["state"] == "done" and result["fallback"] is True
    assert "Install failed:" in result["error"] and "disk image has been opened" in result["error"]
    assert opened == ["dmg"] and not app_update._install_plan


def test_restart_rechecks_sha_and_only_launches_once(install_offer, monkeypatch):
    assert app_update.start_install()["state"] == "ready"
    launched = []
    monkeypatch.setattr(app_install, "launch_helper", lambda *a: launched.append(a))
    assert app_update.restart_install()["state"] == "restarting"
    assert app_update.restart_install()["state"] == "restarting"
    assert len(launched) == 1
    with pytest.raises(app_update.UpdateError, match="cannot be cancelled"):
        app_update.cancel_download()


def test_restart_rejects_payload_changed_since_ready(install_offer, monkeypatch):
    assert app_update.start_install()["state"] == "ready"
    Path(app_update.download_status()["path"]).write_bytes(b"changed")
    monkeypatch.setattr(app_install, "launch_helper", lambda *a: pytest.fail("must not launch"))
    with pytest.raises(app_update.UpdateError, match="sha256"):
        app_update.restart_install()
    assert app_update.download_status()["fallback"] is True


def test_cancel_during_verification_cannot_become_ready(install_offer, monkeypatch):
    real = app_install.stage_mac
    def cancel(*args):
        plan = real(*args)
        app_update.cancel_download()
        return plan
    monkeypatch.setattr(app_install, "stage_mac", cancel)
    assert app_update.start_install()["state"] == "cancelled"
    assert not app_update._install_plan


@pytest.fixture
def windows(monkeypatch, tmp_path):
    monkeypatch.setattr(app_install, "powershell", lambda: "powershell.exe")
    monkeypatch.setattr(app_install, "windows_path", lambda p: "C:\\Downloads\\" + p.name)
    monkeypatch.setattr(app_build, 'build_info', lambda: {
        'windows_update_signer': {'subject': 'CN=FiberBrowser Release', 'thumbprint': 'AB' * 20}})
    installer = tmp_path / "Setup.exe"
    installer.write_bytes(b"installer")
    return installer


def test_windows_authenticode_and_launcher_state_use_runner(windows):
    calls = []
    def runner(argv, **kw):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout='{"root":"C:\\\\Apps\\\\FiberBrowser","launcher":42}', stderr="")
    plan = app_install.stage_windows(windows, runner=runner)
    assert plan["launcher"] == 42
    assert "Get-AuthenticodeSignature -LiteralPath" in calls[0][-1] and "'Valid'" in calls[0][-1]
    assert "server.json" in calls[1][-1]


def test_windows_invalid_signature_stops_before_install(windows):
    with pytest.raises(app_install.InstallError, match="powershell.exe failed"):
        app_install.stage_windows(windows, runner=Runner(fail="Get-AuthenticodeSignature"))


def test_windows_helper_waits_checks_hash_and_signature_then_silent_nsis(windows):
    plan = {"platform": "windows", "installer": str(windows), "root": "C:\\Apps\\FiberBrowser", "launcher": 42}
    script = app_install.windows_helper(plan, "a" * 64)
    assert "Wait-Process -Timeout 300" in script
    assert script.index("Wait-Process") < script.index("Get-FileHash") < script.index("Get-AuthenticodeSignature") < script.index("@('/S'")
    assert "-Wait -PassThru" in script and "$process.ExitCode -ne 0" in script
    assert "app\\FiberBrowser.exe" in script and "RemoveData" not in script
    calls = []
    app_install.launch_helper(plan, "a" * 64, runner=lambda a, **kw: (calls.append(a) or SimpleNamespace(returncode=0, stdout="", stderr="")))
    assert "Start-Process powershell.exe -WindowStyle Hidden" in calls[-1][-1]
    assert windows.with_name("Setup.exe.install.ps1").is_file()


def test_windows_helper_snapshots_before_installer_and_restores_on_install_or_launch_failure(windows):
    script = app_install.windows_helper(dict(installer=str(windows), root=r"C:\Apps\FiberBrowser", launcher=42), 'a' * 64)
    assert script.index('--export') < script.index("@('/S'")
    assert script.index('$snapshotReady = $true') < script.index('$replacementStarted = $true')
    assert script.index('$replacementStarted = $true') < script.index("@('/S'")
    catch = script[script.index('} catch {'):]
    assert '$snapshotReady -and $replacementStarted' in catch
    assert catch.index('--unregister') < catch.index('--import')
    assert 'rollback.tar' in script and 'Copy-Item' in script
    assert 'UserData' not in catch and 'RemoveData' not in script
    assert script.index('/usr/local/bin/fiberbrowser') < script.index('Start-Process -FilePath (Join-Path')
    assert 'exit 1' in catch and 'Rollback failed' in catch
    assert "'run\\server.json'" in script
    assert script.index('$state.ready') < script.index('Remove-Item -LiteralPath $backupDir')
    assert '$app.HasExited' in script and 'AddSeconds(360)' in script
    assert 'taskkill.exe /PID $app.Id /T /F' in catch


@pytest.mark.parametrize('failure', ['import', 'first_start'])
def test_windows_rollback_command_plan_restores_application_and_home(tmp_path, failure):
    """Run the helper's exact native argv against an in-memory WSL stand-in.

    This covers argv/data preservation in Python; PowerShell control flow is
    separately checked above and executed below when pwsh is available.
    """
    root = r"C:\Apps with spaces\FiberBrowser's app"
    archive = root + r'\snapshot\rollback.tar'
    commands = app_install.windows_distro_commands(root, archive)
    state = {'registered': {'application': 'old', 'home': b'unchanged user sessions'}, 'archive': None}
    calls = []
    def wsl(argv):
        calls.append(argv)
        if argv[:2] == ['--export', 'FiberBrowser']:
            assert argv[2] == archive
            state['archive'] = dict(state['registered'])
        elif argv == ['--unregister', 'FiberBrowser']:
            state['registered'] = None
        elif argv[:2] == ['--import', 'FiberBrowser']:
            assert argv[2:] == [root + r'\distro', archive, '--version', '2']
            state['registered'] = dict(state['archive'])
        else:
            assert argv == ['-d', 'FiberBrowser', '-u', 'fiberbrowser', '-e', '/usr/local/bin/fiberbrowser', '--version']
            assert state['registered']['application'] == 'old'
    wsl(commands['export'])
    # The existing installer unregisters the old distro. A failed import can
    # leave it absent; a failed first start leaves the new one registered.
    state['registered'] = None if failure == 'import' else {'application': 'broken new', 'home': b'unchanged user sessions'}
    for step in ('unregister', 'restore', 'probe'):
        wsl(commands[step])
    assert state['registered'] == state['archive'] == {'application': 'old', 'home': b'unchanged user sessions'}
    assert len(calls) == 4


@pytest.mark.skipif(not shutil.which('pwsh'), reason='PowerShell unavailable: generated helper cannot be executed locally')
@pytest.mark.parametrize('failure', ['', 'export', 'install', 'first_start', 'launch', 'late_start', 'restore'])
def test_execute_windows_helper_with_stubbed_native_commands(windows, tmp_path, failure):
    import json
    calls = tmp_path / 'powershell-calls.jsonl'
    # No real filesystem mutation, installer, WSL, or Windows GUI. Only this
    # temporary calls file is written by the harness. The scenario variable must
    # not be named $failure: the helper's catch block sets $failure (script scope).
    prelude = r'''
$script:registered = 'old'
$script:snapshot = ''
$script:startupReads = 0
$script:scenario = FAILURE
$script:calls = CALLS
function Record($name) {
    [ordered]@{ call=$name; registered=$script:registered; snapshot=$script:snapshot } | ConvertTo-Json -Compress | Add-Content -LiteralPath $script:calls
}
Add-Type 'namespace System.Windows.Forms { public class MessageBox { public static string Show(string a, string b) { return "ok"; } } }'
function Add-Type { param($AssemblyName) }
function Join-Path($Path, $ChildPath) { return ($Path + '\' + $ChildPath) }
function Get-Process { return $null }
function Get-FileHash { return @{ Hash=('a' * 64) } }
function Get-AuthenticodeSignature { return @{ Status='Valid'; SignerCertificate=@{ Subject='CN=FiberBrowser Release'; Thumbprint=('AB' * 20) } } }
function New-Item { }
function Copy-Item {
    param($LiteralPath, $Path, $Destination, [switch]$Recurse, [switch]$Force)
    # Backup: the installed app folder; rollback: its saved copy back over app.
    if ($LiteralPath) { Record 'backup-app' } else { Record 'restore-app' }
}
function Remove-Item {
    param($LiteralPath, [switch]$Recurse, [switch]$Force, $ErrorAction)
    if ($LiteralPath -like '*server.json') { Record 'clear-state' } else { Record 'cleanup' }
}
function Out-File { }
function Get-Content {
    $script:startupReads += 1
    return (@{ready=($script:scenario -ne 'late_start'); launcher=43} | ConvertTo-Json -Compress)
}
function Start-Sleep { }
function wsl.exe {
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        '--export' {
            Record 'export'
            if ($script:scenario -eq 'export') { $global:LASTEXITCODE=1 }
            else { $script:snapshot=$script:registered }
        }
        '--unregister' { $script:registered=''; Record 'unregister' }
        '--import' {
            if ($script:scenario -eq 'restore') { $global:LASTEXITCODE=1 }
            else { $script:registered=$script:snapshot }
            Record 'restore'
        }
        '-d' {
            Record 'probe'
            if ($script:registered -eq 'new' -and $script:scenario -in @('first_start', 'restore')) { $global:LASTEXITCODE=1 }
        }
        default { throw 'Unexpected WSL argv' }
    }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    if ($FilePath -like '*Setup.exe') {
        $script:registered=''
        Record 'install'
        if ($script:scenario -eq 'install') { return @{ ExitCode=1 } }
        $script:registered='new'
        return @{ ExitCode=0 }
    }
    Record 'launch'
    if ($script:scenario -eq 'launch' -and $script:registered -eq 'new') { throw 'launch refused' }
    $process = [pscustomobject]@{ ExitCode=0; Id=43 }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
    $process | Add-Member -MemberType ScriptProperty -Name HasExited -Value { return ($script:scenario -eq 'late_start' -and $script:startupReads -ge 3) }
    return $process
}
'''.replace('FAILURE', app_install.ps_quote(failure)).replace('CALLS', app_install.ps_quote(str(calls)))
    script = tmp_path / 'test-helper.ps1'
    script.write_text(prelude + app_install.windows_helper(dict(installer=str(windows), root=r'C:\FakeApp', launcher=42), 'a' * 64))
    ran = subprocess.run([shutil.which('pwsh'), '-NoProfile', '-NonInteractive', '-File', str(script)],
                         capture_output=True, text=True, timeout=30)
    assert ran.returncode == (1 if failure else 0), ran.stdout + ran.stderr
    rows = [json.loads(line) for line in calls.read_text().splitlines()]
    names = [row['call'] for row in rows]
    # The application folder is copied before the distro is exported.
    assert names[:2] == ['backup-app', 'export']
    if failure == 'export':
        assert names == ['backup-app', 'export']
    elif not failure:
        assert names == ['backup-app', 'export', 'install', 'probe', 'clear-state', 'launch', 'cleanup']
    elif failure == 'restore':
        assert rows[-1]['call'] == 'restore' and rows[-1]['snapshot'] == 'old'
        assert 'cleanup' not in names and 'restore-app' not in names
    else:
        # Rollback: old distro back, then the old application files, then a probe and relaunch of the old app.
        tail = names[names.index('unregister'):]
        assert tail == ['unregister', 'restore', 'restore-app', 'probe', 'launch']
        assert rows[-1]['call'] == 'launch' and rows[-1]['registered'] == 'old'


def test_nsis_silent_failures_abort_before_interactive_or_destructive_prompts():
    script = (Path(__file__).resolve().parents[1] / "packaging/windows/installer.nsi").read_text()
    assert script.index('Abort "Silent update failed') < script.index('${If} $Code == 40')
    assert 'SetErrorLevel $Code' in script


def test_check_offers_zip_for_install_and_dmg_for_download(updates, bundles, monkeypatch):
    from services import app_settings
    folder = shared_folder(updates["tmp"])
    app_settings.update("updates", {"manifest_url": str(folder / "fiberbrowser-update-lab.json")})
    monkeypatch.setattr(app_install, "running_bundle", lambda: bundles[0])
    result = app_update.check(force=True)
    assert result["installable"] is True
    assert result["install_download"]["kind"] == "zip"
    assert set(result["install_download"]) == {"name", "kind", "size", "sha256"}
    assert result["download"]["kind"] == "dmg"
    monkeypatch.setattr(app_install, "running_bundle", lambda: None)
    assert app_update.check(force=True)["installable"] is False


def test_install_routes_require_ready_and_do_not_quit(client, updates, monkeypatch):
    assert client.post("/api/app/update/install").status_code == 409
    assert client.post("/api/app/update/restart").status_code == 409
    monkeypatch.setattr(app_update, "start_install", lambda: {"state": "verifying"})
    assert client.post("/api/app/update/install").json() == {"state": "verifying"}
    monkeypatch.setattr(app_update, "restart_install", lambda: {"state": "restarting"})
    assert client.post("/api/app/update/restart").json() == {"state": "restarting"}


def test_command_timeout_is_a_clear_install_error():
    def runner(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 180)
    with pytest.raises(app_install.InstallError, match="codesign failed"):
        app_install.team_id(Path("example.app"), runner=runner)


def test_windows_download_folder_uses_utf8_profile_path(monkeypatch):
    from services import wsl_interop
    monkeypatch.setattr(wsl_interop, 'is_wsl', lambda: True)
    monkeypatch.setattr(wsl_interop, 'windows_program', lambda name: 'powershell.exe')
    monkeypatch.setattr(wsl_interop, 'to_wsl_path', lambda value, wsl: '/mnt/c/Profiles/Zoë')
    calls = []
    def runner(argv, **kw):
        calls.append((argv, kw))
        return SimpleNamespace(returncode=0, stdout='C:\\Profiles\\Zoë\n', stderr='')
    monkeypatch.setattr(app_install.subprocess, 'run', runner)
    assert app_update.downloads_dir() == Path('/mnt/c/Profiles/Zoë/Downloads')
    assert 'OutputEncoding' in calls[0][0][-1] and calls[0][1]['encoding'] == 'utf-8'


@pytest.mark.parametrize('subject,thumbprint', [
    ('CN=Unrelated Publisher', 'CD' * 20),
    ('CN=FiberBrowser Release', 'CD' * 20),
    ('CN=Unrelated Publisher', 'AB' * 20),
    ('CN=FiberBrowser Release', 'AB' * 20),
])
def test_windows_valid_signature_requires_own_publisher(windows, subject, thumbprint):
    """Mock a Valid Authenticode signature, evaluating the emitted publisher gates."""
    import re
    def runner(argv, **kwargs):
        script = argv[-1]
        expected_subject = re.search(r"SignerCertificate.Subject -cne '([^']+)'", script)
        expected_key = re.search(r"SignerCertificate.Thumbprint -ne '([^']+)'", script)
        rejected = ((expected_subject and subject != expected_subject[1]) or
                    (expected_key and thumbprint != expected_key[1]))
        return SimpleNamespace(returncode=int(bool(rejected)), stdout='', stderr='publisher refused')
    trusted = subject == 'CN=FiberBrowser Release' and thumbprint == 'AB' * 20
    if trusted:
        app_install.verify_installer(windows, runner=runner)
    else:
        with pytest.raises(app_install.InstallError, match='publisher refused'):
            app_install.stage_windows(windows, runner=runner)
    plan = dict(installer=str(windows), root='C:\\Apps', launcher=42)
    helper = app_install.windows_helper(plan, 'a' * 64)
    assert "SignerCertificate.Subject -cne 'CN=FiberBrowser Release'" in helper
    assert "SignerCertificate.Thumbprint -ne '" + 'AB' * 20 + "'" in helper
    assert helper.index('SignerCertificate.Thumbprint') < helper.index('Start-Process -FilePath $installer')


@pytest.mark.parametrize('signer', [None, {}, {'subject': 'CN=FiberBrowser'},
                                  {'subject': 'CN=FiberBrowser', 'thumbprint': 'bad'}])
def test_windows_unconfigured_publisher_refuses_staging_and_helper(windows, monkeypatch, signer):
    monkeypatch.setattr(app_build, 'build_info', lambda: {'windows_update_signer': signer})
    runner = Runner()
    with pytest.raises(app_install.InstallError, match='no trusted FiberBrowser'):
        app_install.stage_windows(windows, runner=runner)
    with pytest.raises(app_install.InstallError, match='no trusted FiberBrowser'):
        app_install.windows_helper(dict(installer=str(windows), root='C:\\Apps', launcher=42), 'a' * 64)
    assert not runner.calls


def test_mac_restart_retains_desktop_pid_after_parent_watcher(bundles, monkeypatch):
    from fiberbrowser import cli
    # No watcher loop, process signal or helper execution occurs in this test.
    monkeypatch.setattr(cli.threading, 'Thread', lambda **kw: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(cli, 'desktop_parent_pid', None, raising=False)
    monkeypatch.setenv(cli.EXIT_WITH_PARENT_ENV, '12346')
    cli.watch_parent_process()
    assert cli.EXIT_WITH_PARENT_ENV not in os.environ
    plan = app_install.stage_mac(bundles[1], bundles[0], runner=Runner())
    calls = []
    monkeypatch.setattr(app_install.os, 'getpid', lambda: 12345)
    app_install.launch_helper(plan, 'a' * 64, runner=Runner(), popen=lambda *a, **kw: calls.append(a))
    helper = Path(calls[0][0][1]).read_text()
    assert 'wait_for_exit 12345\nwait_for_exit 12346' in helper
    assert helper.index('wait_for_exit 12346') < helper.rindex('open "$running"')
