"""fiberbrowser --install-shortcut: Linux .desktop entry and Windows Start-menu shortcut.

Neither OS is available in CI's macOS/Linux runs for the Windows part, so the
PowerShell script is checked as text."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from fiberbrowser import shortcut  # noqa: E402


def test_linux_desktop_entry(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.setattr(shortcut.shutil, "which", lambda name: None)
    written = shortcut.install_linux(["/opt/my env/bin/fiberbrowser", "--app"])
    entry = tmp_path / "applications" / "fiberbrowser.desktop"
    assert entry in written
    text = entry.read_text()
    assert 'Exec="/opt/my env/bin/fiberbrowser" --app' in text
    assert "Icon=fiberbrowser" in text and "Terminal=false" in text and "Type=Application" in text
    assert (tmp_path / "icons" / "hicolor" / "256x256" / "apps" / "fiberbrowser.png").is_file()
    removed = shortcut.uninstall_linux()
    assert entry in removed and not entry.exists()


def test_windows_shortcut_script():
    script = shortcut.windows_shortcut_script(
        Path(r"C:\Users\me\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\FiberBrowser.lnk"),
        [r"C:\Users\me\venv\Scripts\fiberbrowser-app.exe"], Path(r"C:\x\fiberbrowser.ico"))
    assert "WScript.Shell" in script and "CreateShortcut('C:\\Users\\me\\AppData" in script
    assert "TargetPath = 'C:\\Users\\me\\venv\\Scripts\\fiberbrowser-app.exe'" in script
    assert "IconLocation = 'C:\\x\\fiberbrowser.ico,0'" in script and script.endswith("$link.Save()")
    quoted = shortcut.windows_shortcut_script(Path("C:/a.lnk"), ["C:/p/pythonw.exe", "-m", "fiberbrowser", "--app"],
                                              Path("C:/i.ico"))
    assert "Arguments = '-m fiberbrowser --app'" in quoted


def test_shortcut_on_macos_points_to_the_app(monkeypatch, capsys):
    monkeypatch.setattr(shortcut.sys, "platform", "darwin")
    assert shortcut.main(["--install-shortcut"]) == 0
    assert "FiberBrowser app" in capsys.readouterr().out
