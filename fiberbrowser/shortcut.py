"""``fiberbrowser --install-shortcut``: FiberBrowser in the application menu.

- Linux: ``~/.local/share/applications/fiberbrowser.desktop`` (XDG), with the
  icon copied to ``~/.local/share/icons/hicolor/<size>/apps/fiberbrowser.png``.
- Windows: ``FiberBrowser.lnk`` in the user's Start menu (made with PowerShell's
  WScript.Shell), pointing at ``fiberbrowser-app.exe`` (no console window).
- macOS: use the FiberBrowser app (packaging/macos); nothing to install here.

The entry starts FiberBrowser in its app window (``fiberbrowser --app``;
without pywebview it opens the default web browser instead).
``--uninstall-shortcut`` removes what this made.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path
from typing import Optional, Sequence

from ._paths import icons_dir

DESKTOP_ID = "fiberbrowser"
ICON_SIZES = (48, 128, 256, 512)


def _scripts_dir() -> Path:
    return Path(sysconfig.get_path("scripts") or os.path.dirname(sys.executable))


def launcher_command() -> list[str]:
    """The command the menu entry runs."""
    scripts = _scripts_dir()
    if sys.platform == "win32":
        gui = scripts / "fiberbrowser-app.exe"
        if gui.is_file():
            return [str(gui)]
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        return [str(pythonw if pythonw.is_file() else sys.executable), "-m", "fiberbrowser", "--app"]
    script = scripts / "fiberbrowser"
    if script.is_file():
        return [str(script), "--app"]
    return [sys.executable, "-m", "fiberbrowser", "--app"]


# --- Linux ------------------------------------------------------------------------

def _xdg_data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def _desktop_quote(arg: str) -> str:
    # Desktop Entry spec: quote arguments with reserved characters; escape " ` $ \.
    if not any(ch in arg for ch in ' \t\n"\'\\><~|&;$*?#()`'):
        return arg
    escaped = arg.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")
    return f'"{escaped}"'


def desktop_entry(command: Sequence[str], icon: str) -> str:
    exec_line = " ".join(_desktop_quote(a) for a in command)
    return "\n".join([
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.5",
        "Name=FiberBrowser",
        "GenericName=Genome Browser",
        "Comment=Fiber-seq and DAF-seq footprints at single-molecule resolution",
        f"Exec={exec_line}",
        f"Icon={icon}",
        "Terminal=false",
        "Categories=Science;Biology;Education;",
        "Keywords=fiber-seq;DAF-seq;chromatin;genome;browser;FiberHMM;",
        "StartupWMClass=FiberBrowser",
        "",
    ])


def install_linux(command: Optional[Sequence[str]] = None) -> list[Path]:
    data = _xdg_data_home()
    written: list[Path] = []
    for size in ICON_SIZES:
        source = icons_dir() / f"fiberbrowser-{size}.png"
        if not source.is_file():
            continue
        target = data / "icons" / "hicolor" / f"{size}x{size}" / "apps" / f"{DESKTOP_ID}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        written.append(target)
    entry = data / "applications" / f"{DESKTOP_ID}.desktop"
    entry.parent.mkdir(parents=True, exist_ok=True)
    # The icon theme name when the copies above exist, else the packaged file.
    icon = DESKTOP_ID if written else str(icons_dir() / "fiberbrowser-512.png")
    entry.write_text(desktop_entry(command or launcher_command(), icon))
    entry.chmod(0o755)
    written.append(entry)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(entry.parent)], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return written


def uninstall_linux() -> list[Path]:
    data = _xdg_data_home()
    removed = []
    for path in [data / "applications" / f"{DESKTOP_ID}.desktop",
                 *[data / "icons" / "hicolor" / f"{s}x{s}" / "apps" / f"{DESKTOP_ID}.png" for s in ICON_SIZES]]:
        if path.exists():
            path.unlink()
            removed.append(path)
    return removed


# --- Windows ----------------------------------------------------------------------

def _start_menu_dir() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def windows_shortcut_script(link: Path, command: Sequence[str], icon: Path) -> str:
    target, arguments = command[0], " ".join(f'"{a}"' if " " in a else a for a in command[1:])
    return "; ".join([
        "$shell = New-Object -ComObject WScript.Shell",
        f"$link = $shell.CreateShortcut({_ps_quote(str(link))})",
        f"$link.TargetPath = {_ps_quote(target)}",
        f"$link.Arguments = {_ps_quote(arguments)}",
        f"$link.WorkingDirectory = {_ps_quote(str(Path.home()))}",
        f"$link.IconLocation = {_ps_quote(str(icon) + ',0')}",
        "$link.Description = 'FiberBrowser: fiber-seq and DAF-seq footprints'",
        "$link.Save()",
    ])


def install_windows(command: Optional[Sequence[str]] = None) -> list[Path]:
    link = _start_menu_dir() / "FiberBrowser.lnk"
    link.parent.mkdir(parents=True, exist_ok=True)
    script = windows_shortcut_script(link, command or launcher_command(), icons_dir() / "fiberbrowser.ico")
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-Command", script], check=True)
    return [link]


def uninstall_windows() -> list[Path]:
    link = _start_menu_dir() / "FiberBrowser.lnk"
    if link.exists():
        link.unlink()
        return [link]
    return []


# --- command ----------------------------------------------------------------------

def main(argv: Sequence[str] = ()) -> int:
    remove = "--uninstall-shortcut" in argv
    if sys.platform == "darwin":
        print("On a Mac, use the FiberBrowser app (see docs/install.md): drag it to Applications, "
              "and it is in Launchpad and Spotlight.")
        return 0
    try:
        if sys.platform == "win32":
            paths = uninstall_windows() if remove else install_windows()
        else:
            paths = uninstall_linux() if remove else install_linux()
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Could not {'remove' if remove else 'create'} the FiberBrowser shortcut: {exc}", file=sys.stderr)
        return 1
    verb = "Removed" if remove else "Created"
    for path in paths:
        print(f"{verb} {path}")
    if not paths:
        print("No FiberBrowser shortcut was installed.")
    elif not remove:
        print("FiberBrowser is in your applications menu; it opens in its own window "
              '(install pywebview for that: pip install "fiberbrowser[app]").')
    return 0
