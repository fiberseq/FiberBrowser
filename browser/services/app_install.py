"""Verified update staging and detached installers. No replacement happens in the server.

All verification commands use ``runner`` (subprocess.run by default). Helpers are
created only after verification; they recheck the payload after the app exits.
"""
from __future__ import annotations

import json
import ntpath
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
import uuid
from pathlib import Path, PurePosixPath

MAC_TEAM_ID = "D57M2AHZJ2"


class InstallError(Exception):
    pass


def command(argv, *, runner=None):
    argv = list(argv)
    if Path(argv[0]).name.lower() == "powershell.exe" and "-Command" in argv:
        index = argv.index("-Command") + 1
        argv[index] = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; " + argv[index]
    try:
        result = (runner or subprocess.run)(argv, capture_output=True, text=True,
                                            encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL, timeout=180)
    except (OSError, subprocess.SubprocessError) as error:
        raise InstallError(f"{Path(argv[0]).name} failed: {error}") from None
    if result.returncode:
        detail = (result.stderr or result.stdout or "no details").strip()[-1200:]
        raise InstallError(f"{Path(argv[0]).name} failed: {detail}")
    return result


def running_bundle() -> Path | None:
    from services.app_build import is_packaged
    if sys.platform != "darwin" or not is_packaged():
        return None
    for parent in Path(sys.executable).resolve().parents:
        if parent.suffix == ".app" and (parent / "Contents" / "MacOS").is_dir():
            return parent
    return None


def team_id(bundle: Path, *, runner=None) -> str:
    result = command(["/usr/bin/codesign", "-dv", str(bundle)], runner=runner)
    match = re.search(r"^TeamIdentifier=([A-Z0-9]+)$", result.stderr + "\n" + result.stdout, re.M)
    if not match:
        raise InstallError("codesign did not report a Team ID.")
    return match[1]


def verify_bundle(staged: Path, running: Path, *, runner=None) -> str:
    command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(staged)], runner=runner)
    expected = team_id(running, runner=runner)
    if expected != MAC_TEAM_ID:
        raise InstallError(f"The running app is not signed by FiberBrowser's Team ID ({MAC_TEAM_ID}).")
    if team_id(staged, runner=runner) != expected:
        raise InstallError("The update's Team ID differs from the running app's Team ID.")
    command(["/usr/sbin/spctl", "--assess", "--type", "execute", str(staged)], runner=runner)
    return expected


def check_archive(archive: Path) -> None:
    """Preflight ditto's input, including links (PyInstaller bundles contain them)."""
    try:
        with zipfile.ZipFile(archive) as source:
            links = set()
            paths = []
            total = 0
            for entry in source.infolist():
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or ".." in path.parts or "\\" in entry.filename:
                    raise InstallError("The update zip contains an unsafe path.")
                paths.append(path)
                total += entry.file_size
                if total > 12 << 30:
                    raise InstallError("The update zip expands beyond the staging limit.")
                if stat.S_ISLNK(entry.external_attr >> 16):
                    links.add(path)
                    target = source.read(entry).decode("utf-8")
                    resolved = os.path.normpath(str(path.parent / target))
                    if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                        raise InstallError("The update zip contains an unsafe symbolic link.")
            if any(parent in links for path in paths for parent in path.parents):
                raise InstallError("The update zip writes through a symbolic link.")
    except (zipfile.BadZipFile, UnicodeError, ValueError) as error:
        raise InstallError(f"The update zip could not be read: {error}") from None


def stage_mac(archive: Path, running: Path, *, runner=None) -> dict:
    if not os.access(running.parent, os.W_OK):
        raise InstallError("The app's folder is not writable. Move FiberBrowser to a writable Applications folder.")
    stage = None
    try:
        stage = Path(tempfile.mkdtemp(prefix=".fiberbrowser-update-", dir=running.parent))
        check_archive(archive)
        command(["/usr/bin/ditto", "-x", "-k", str(archive), str(stage)], runner=runner)
        bundles = list(stage.glob("*.app"))
        if len(bundles) != 1 or bundles[0].is_symlink() or not (bundles[0] / "Contents" / "MacOS").is_dir():
            raise InstallError("The update zip must contain one application bundle.")
        team = verify_bundle(bundles[0], running, runner=runner)
        return {"platform": "macos", "stage": str(stage), "staged": str(bundles[0]),
                "running": str(running), "team": team}
    except Exception:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        raise


def mac_helper(plan: dict, pid: int, app_pid: int) -> str:
    """Wait for both the server and its desktop host; keep the old bundle in Trash."""
    q = shlex.quote
    return f'''#!/bin/sh
set -eu
stage={q(plan['stage'])}
staged={q(plan['staged'])}
running={q(plan['running'])}
team={q(plan['team'])}
exec >> "$stage/install.log" 2>&1
old=''
update_failed() {{
  # Also restore after a failed relaunch. Keep the rejected bundle in staging.
  if [ -n "$old" ] && [ -d "$old" ]; then
    if [ ! -e "$running" ] || mv "$running" "$staged"; then
      if mv "$old" "$running"; then
        open "$running" || true
      fi
    fi
  fi
  osascript -e 'display alert "FiberBrowser update failed" message "The previous app is kept. See install.log in the update staging folder, or use the downloaded disk image."' || true
}}
trap update_failed EXIT
wait_for_exit() {{
  attempts=0
  while kill -0 "$1" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 300 ] || exit 1
    sleep 1
  done
}}
wait_for_exit {int(pid)}
wait_for_exit {int(app_pid)}
# Recheck after waiting: quarantine is cleared only beyond these gates.
codesign --verify --deep --strict "$staged"
actual=$(codesign -dv "$staged" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p')
[ "$actual" = "$team" ]
spctl --assess --type execute "$staged"
/bin/mkdir -p "$HOME/.Trash"
trash=$(/usr/bin/mktemp -d "$HOME/.Trash/FiberBrowser-update.XXXXXX")
old="$trash/$(/usr/bin/basename "$running")"
mv "$running" "$old"
mv "$staged" "$running"
xattr -dr com.apple.quarantine "$running" || true
open "$running"
trap - EXIT
'''


def powershell() -> str:
    if sys.platform == "win32":
        return shutil.which("powershell.exe") or "powershell.exe"
    from services.wsl_interop import windows_program
    ps = windows_program("powershell.exe")
    if not ps:
        raise InstallError("Windows PowerShell is unavailable.")
    return ps


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def windows_path(path: Path) -> str:
    if sys.platform == "win32":
        return str(path)
    from services.wsl_interop import to_windows_path
    target = to_windows_path(str(path))
    # A helper must survive replacement of the WSL distribution.
    if not target or not re.match(r"^[A-Za-z]:\\", target):
        raise InstallError("The installer must be downloaded onto a Windows drive.")
    return target


def windows_publisher() -> tuple[str, str]:
    """Release constants in the installed build, never supplied by an update."""
    from services.app_build import build_info
    signer = (build_info() or {}).get('windows_update_signer') or {}
    if not isinstance(signer, dict):
        raise InstallError('The build has no trusted FiberBrowser Authenticode publisher configured.')
    subject = signer.get('subject', '')
    thumbprint = signer.get('thumbprint', '')
    if (not isinstance(subject, str) or not subject.strip() or
            not isinstance(thumbprint, str) or not re.fullmatch(r'[A-Fa-f0-9]{40}', thumbprint)):
        raise InstallError('The build has no trusted FiberBrowser Authenticode publisher configured.')
    return subject, thumbprint.upper()


def publisher_check(variable: str) -> str:
    subject, thumbprint = windows_publisher()
    return (f"if ({variable}.SignerCertificate.Subject -cne {ps_quote(subject)} -or "
            f"{variable}.SignerCertificate.Thumbprint -ne {ps_quote(thumbprint)}) {{ "
            "throw 'The installer is not signed by the trusted FiberBrowser publisher.' }")


def verify_installer(path: Path, *, runner=None) -> None:
    check = publisher_check('$s')
    command([powershell(), "-NoProfile", "-NonInteractive", "-Command",
             "$ErrorActionPreference='Stop'; "
             f"$s=Get-AuthenticodeSignature -LiteralPath {ps_quote(windows_path(path))}; "
             "if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { "
             "throw ('Authenticode verification failed: ' + $s.Status) }; " + check], runner=runner)


def stage_windows(installer: Path, *, runner=None) -> dict:
    verify_installer(installer, runner=runner)
    # Read launcher state on Windows, never a Linux pid interpreted as a Windows pid.
    result = command([powershell(), "-NoProfile", "-NonInteractive", "-Command",
                      "$ErrorActionPreference='Stop'; $root=Join-Path $env:LOCALAPPDATA 'FiberBrowser'; "
                      "$s=Get-Content -LiteralPath (Join-Path $root 'run\\server.json') -Raw | ConvertFrom-Json; "
                      "@{root=$root; launcher=$s.launcher} | ConvertTo-Json -Compress"], runner=runner)
    try:
        info = json.loads(result.stdout)
        launcher = int(info["launcher"])
        root = str(info["root"])
        if launcher <= 0 or not re.match(r"^[A-Za-z]:\\", root):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise InstallError("The Windows launcher's state could not be read.") from None
    return {"platform": "windows", "installer": str(installer), "launcher": launcher, "root": root}


def windows_distro_commands(root: str, archive: str) -> dict[str, list[str]]:
    """Native argv shared by the detached helper and disposable WSL tests.

    The archive contains the entire old application and home. Rollback never
    restores a home backup into a different application or edits UserData.
    """
    return {
        'export': ['--export', 'FiberBrowser', archive],
        'unregister': ['--unregister', 'FiberBrowser'],
        'restore': ['--import', 'FiberBrowser', ntpath.join(root, 'distro'), archive, '--version', '2'],
        'probe': ['-d', 'FiberBrowser', '-u', 'fiberbrowser', '-e', '/usr/local/bin/fiberbrowser', '--version'],
    }


def windows_helper(plan: dict, sha256: str) -> str:
    backup_dir = ntpath.join(plan['root'], 'UpdateRollback', uuid.uuid4().hex)
    commands = windows_distro_commands(plan['root'], ntpath.join(backup_dir, 'rollback.tar'))
    def wsl(action: str) -> str:
        return ' '.join(ps_quote(arg) for arg in commands[action])
    return f'''$ErrorActionPreference = 'Stop'
$installer = {ps_quote(windows_path(Path(plan['installer'])))}
$root = {ps_quote(plan['root'])}
$log = $installer + '.install.log'
$backupDir = {ps_quote(backup_dir)}
$snapshotReady = $false
$replacementStarted = $false
$app = $null
function Invoke-UpdateWsl {{
    param([string[]]$Arguments)
    & wsl.exe @Arguments >> $log 2>&1
    if ($LASTEXITCODE -ne 0) {{ throw ('wsl failed: ' + ($Arguments -join ' ')) }}
}}
try {{
    $launcher = Get-Process -Id {int(plan['launcher'])} -ErrorAction SilentlyContinue
    if ($null -ne $launcher) {{ $launcher | Wait-Process -Timeout 300 }}
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne {ps_quote(sha256)}) {{
        throw 'The installer changed after download (sha256).'
    }}
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {{
        throw ('Authenticode verification failed: ' + $signature.Status)
    }}
    {publisher_check('$signature')}
    # Snapshot before NSIS can unregister the working distro. Export failure
    # (including disk full) leaves the old application registered and intact.
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'app') -Destination (Join-Path $backupDir 'app') -Recurse
    Invoke-UpdateWsl -Arguments @({', '.join(ps_quote(a) for a in commands['export'])})
    $snapshotReady = $true
    # NSIS: /S is case sensitive. Keep the existing per-user installation.
    $replacementStarted = $true
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $root)) -Wait -PassThru
    if ($process.ExitCode -ne 0) {{ throw ('Installer failed with exit code ' + $process.ExitCode) }}
    # Exercise the new distro's first start before committing the transaction.
    Invoke-UpdateWsl -Arguments @({', '.join(ps_quote(a) for a in commands['probe'])})
    $stateFile = Join-Path $root 'run\\server.json'
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
    $app = Start-Process -FilePath (Join-Path $root 'app\\FiberBrowser.exe') -PassThru
    # The launcher can spend minutes compiling on first start. Its NSIS shim
    # can also exit zero when PowerShell fails, so a short exit-code check is
    # insufficient. A fresh ready state is written only after /api/status works.
    $deadline = (Get-Date).AddSeconds(360)
    $ready = $false
    while ((Get-Date) -lt $deadline) {{
        $app.Refresh()
        if ($app.HasExited) {{ throw 'The updated launcher stopped before the server was ready.' }}
        try {{
            $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            if ($state.ready -and [int]$state.launcher -gt 0 -and [int]$state.launcher -ne {int(plan['launcher'])}) {{ $ready = $true; break }}
        }} catch {{ # The launcher writes its state atomically; retry until ready.
        }}
        Start-Sleep -Milliseconds 500
    }}
    if (-not $ready) {{ throw 'The updated application did not become ready within 360 seconds.' }}
    # Cleanup failure must not roll back an already running new application.
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
}} catch {{
    $failure = $_.Exception.Message
    $_ | Out-File -LiteralPath $log -Encoding UTF8 -Append
    if ($snapshotReady -and $replacementStarted) {{
        try {{
            if ($null -ne $app -and -not $app.HasExited) {{
                & taskkill.exe /PID $app.Id /T /F >> $log 2>&1
            }}
            # A failed import may leave a partial registration; remove it first.
            # An absent distro is harmless here. A failed restore keeps the tar.
            & wsl.exe {wsl('unregister')} >> $log 2>&1
            Invoke-UpdateWsl -Arguments @({', '.join(ps_quote(a) for a in commands['restore'])})
            Copy-Item -Path (Join-Path $backupDir 'app\\*') -Destination (Join-Path $root 'app') -Recurse -Force
            Invoke-UpdateWsl -Arguments @({', '.join(ps_quote(a) for a in commands['probe'])})
            Start-Process -FilePath (Join-Path $root 'app\\FiberBrowser.exe')
        }} catch {{
            $failure += ('; Rollback failed: ' + $_.Exception.Message + '; old application kept at ' + $backupDir)
            $_ | Out-File -LiteralPath $log -Encoding UTF8 -Append
        }}
    }}
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(('Update failed: ' + $failure + "`nDetails: " + $log), 'FiberBrowser update') | Out-Null
    exit 1
}}
'''


def launch_helper(plan: dict, sha256: str, *, runner=None, popen=None) -> None:
    if plan["platform"] == "macos":
        verify_bundle(Path(plan["staged"]), Path(plan["running"]), runner=runner)
        from fiberbrowser.cli import desktop_parent_pid
        app_pid = desktop_parent_pid or os.getpid()
        helper = Path(plan["stage"]) / "install.sh"
        helper.write_text(mac_helper(plan, os.getpid(), app_pid))
        helper.chmod(0o700)
        # The helper uses command names so execution tests can stub the OS.
        # A real handoff must resolve verification and replacement tools only
        # from the system directories, never the user's or bundled tools PATH.
        helper_env = dict(os.environ, PATH='/usr/bin:/bin:/usr/sbin:/sbin')
        (popen or subprocess.Popen)(["/bin/sh", str(helper)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                                   env=helper_env)
    else:
        installer = Path(plan["installer"])
        verify_installer(installer, runner=runner)
        helper = installer.with_name(installer.name + ".install.ps1")
        helper.write_text(windows_helper(plan, sha256), encoding="utf-8-sig")
        # Start a native detached process: it survives the WSL distro being unregistered.
        command([powershell(), "-NoProfile", "-NonInteractive", "-Command",
                 "$ErrorActionPreference='Stop'; Start-Process powershell.exe -WindowStyle Hidden "
                 "-ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + "
                 f"{ps_quote(windows_path(helper))} + '\"')"], runner=runner)


def discard(plan: dict) -> None:
    if plan.get("platform") == "macos":
        shutil.rmtree(plan["stage"], ignore_errors=True)


def launch_restart(*, runner=None, popen=None) -> None:
    """Relaunch the installed app after normal Quit, without changing the bundle.

    The page uses the updater's required autosave and session-reopen marker before
    requesting this handoff. Both desktop owners must exit before relaunch.
    """
    bundle = running_bundle()
    if bundle:
        from fiberbrowser.cli import desktop_parent_pid
        app_pid = desktop_parent_pid or os.getpid()
        script = f'''wait_for_exit() {{
    n=0
    while kill -0 "$1" 2>/dev/null; do
        n=$((n + 1))
        [ "$n" -lt 300 ] || exit 1
        sleep 1
    done
}}
wait_for_exit {os.getpid()}
wait_for_exit {int(app_pid)}
exec /usr/bin/open {shlex.quote(str(bundle))}
'''
        env = dict(os.environ)
        if getattr(sys, "frozen", False):
            env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        (popen or subprocess.Popen)(["/bin/sh", "-c", script], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True, env=env)
        return
    from services.app_build import platform_key
    if platform_key() != "windows-x64":
        raise InstallError("Restart FiberBrowser manually to use the selected FiberHMM.")
    # The WSL server's pid is not the Windows launcher's pid. Read native state,
    # as the app updater does, and wait in a detached native process.
    script = ("$ErrorActionPreference='Stop'; $root=Join-Path $env:LOCALAPPDATA 'FiberBrowser'; "
              "$s=Get-Content -LiteralPath (Join-Path $root 'run\\server.json') -Raw | ConvertFrom-Json; "
              "$id=[int]$s.launcher; if ($id -le 0) { throw 'No running launcher' }; "
              "$child='$ErrorActionPreference=\"Stop\"; $p=Get-Process -Id ' + $id + ' -ErrorAction SilentlyContinue; "
              "if ($null -ne $p) { $p | Wait-Process -Timeout 300 }; Start-Process -FilePath ' + "
              "([char]39) + (Join-Path $root 'app\\FiberBrowser.exe').Replace([string][char]39, "
              "([string][char]39 + [char]39)) + ([char]39); "
              "$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child)); "
              "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "
              "('-NoProfile -NonInteractive -EncodedCommand ' + $encoded)")
    command([powershell(), "-NoProfile", "-NonInteractive", "-Command", script], runner=runner)
