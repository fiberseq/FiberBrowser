"""The app window's menu bar (fiberbrowser.app_menu) and how the app runs its items.

The native build runs where PyObjC is installed (the Mac app's build venv);
the rest runs anywhere."""
import re
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from fiberbrowser import app_menu, desktop  # noqa: E402

APP_COMMANDS_TS = ROOT / "browser" / "frontend" / "src" / "utils" / "appCommands.ts"


def frontend_commands() -> set:
    source = APP_COMMANDS_TS.read_text()
    block = re.search(r"export const APP_COMMANDS = \[(.*?)\] as const;", source, re.S)
    assert block, "APP_COMMANDS not found in appCommands.ts"
    return set(re.findall(r"'([a-z0-9-]+)'", re.sub(r"//[^\n]*", "", block.group(1))))


def test_every_page_command_exists_in_the_command_bus():
    known = frontend_commands()
    assert {"open-file", "save-session", "undo", "zoom-in", "go-to-locus"} <= known
    used = {item.target for item in app_menu.iter_items() if item.kind == "command"}
    assert used - known == set()
    # Copy Locus asks the page for the locus (then writes the clipboard natively).
    assert "locus" in known


def test_every_item_maps_to_a_known_action():
    for item in app_menu.iter_items():
        assert item.kind in app_menu.KINDS, item
        if item.kind == "app":
            assert callable(getattr(desktop.DesktopApp, item.target, None)), item
        elif item.kind == "url":
            assert item.target in app_menu.URLS, item
        elif item.kind == "selector":
            assert re.fullmatch(r"[A-Za-z]+:", item.target), item


def test_shortcuts_are_unique_and_standard():
    items = [i for i in app_menu.iter_items() if i.shortcut]
    shortcuts = [i.shortcut for i in items]
    assert len(shortcuts) == len(set(shortcuts)), sorted(i.shortcut_label() for i in items)
    by_title = {i.title: i.shortcut_label() for i in items}
    assert by_title["Quit FiberBrowser"] == "⌘Q"
    assert by_title["Settings…"] == "⌘,"
    assert by_title["Open File…"] == "⌘O"
    assert by_title["Save Session"] == "⌘S"
    assert by_title["Export Figure…"] == "⌘E"
    assert by_title["New Independent Workspace"] == "⇧⌘N"
    assert by_title["Close Window"] == "⌘W"
    assert by_title["Undo"] == "⌘Z" and by_title["Redo"] == "⇧⌘Z"
    assert by_title["Copy"] == "⌘C" and by_title["Paste"] == "⌘V"
    assert by_title["Zoom In"] == "⌘=" and by_title["Zoom Out"] == "⌘-"
    assert by_title["Go to Locus…"] == "⌘L"
    assert by_title["Minimize"] == "⌘M"



def frontend_label(name: str) -> str:
    """A command's label in the command palette (APP_COMMAND_INFO in appCommands.ts)."""
    source = APP_COMMANDS_TS.read_text()
    key = re.escape(name) if re.fullmatch(r"[a-z]+", name) else f"'{re.escape(name)}'"
    found = re.search(rf"\n\s*(?:{key}|'{re.escape(name)}'):\s*\{{\s*label:\s*'([^']+)'", source)
    assert found, f"no palette label for {name}"
    return found.group(1)


def test_file_menu_groups_the_ways_in_as_the_top_bar_open_menu():
    """Owner, 2 Oct: the Library and processing raw data were hard to find.
    File lists every way in as the top bar's Open menu does, then making or
    checking data, with the command palette's words (in title case)."""
    file_menu = next(m for m in app_menu.MENUS if m.title == "File")
    entries = list(file_menu.items)
    open_at = next(i for i, e in enumerate(entries) if e is not None and e.target == "open-file")
    end = entries.index(None, open_at)
    assert [e.target for e in entries[open_at:end]] == [
        "open-file", "library", "load-by-path", "connect-cluster", "open-session"]
    make_end = entries.index(None, end + 1)
    assert [e.target for e in entries[end + 1:make_end]] == ["new-daf-run", "dataset-qc"]
    for item in entries[open_at:make_end]:
        if item is None or item.target == "open-session":
            continue
        assert item.title.lower() == frontend_label(item.target).lower(), item
    # The Library is opened from File now, not listed twice.
    assert [m.title for m in app_menu.MENUS for i in app_menu.iter_items(m.items) if i.target == "library"] == ["File"]

def test_edit_menu_has_the_text_field_actions():
    """Without an Edit menu, Cmd+C/Cmd+V do nothing in a macOS web view."""
    edit = next(m for m in app_menu.MENUS if m.title == "Edit")
    selectors = {i.target for i in edit.items if i is not None and i.kind == "selector"}
    assert {"cut:", "copy:", "paste:", "selectAll:"} <= selectors


def test_links_match_the_project_urls():
    text = (ROOT / "pyproject.toml").read_text()
    assert f'Documentation = "{app_menu.DOCS_URL}"' in text
    assert f'Issues = "{app_menu.ISSUES_URL}"' in text


def test_command_script_is_guarded_for_pages_without_the_bus():
    script = app_menu.command_script("save-session")
    assert "window.fiberbrowserCommand" in script and "typeof f!=='function'" in script
    assert 'f("save-session")' in script
    assert 'f("x", {"a": 1})' in app_menu.command_script("x", {"a": 1})


class FakeWindow:
    def __init__(self, result=True):
        self.result, self.scripts = result, []

    def evaluate_js(self, script):
        self.scripts.append(script)
        return self.result


def test_menu_items_dispatch(monkeypatch):
    app = desktop.DesktopApp([], port=8756)
    window = FakeWindow()
    app.windows.append(window)
    monkeypatch.setattr(app, "front_window", lambda: window)
    opened, calls = [], []
    monkeypatch.setattr(desktop.webbrowser, "open", lambda url: opened.append(url))
    monkeypatch.setattr(app, "new_workspace", lambda: calls.append("workspace"))
    items = {i.title: i for i in app_menu.iter_items()}

    app.menu_action(items["Report an Issue…"])
    assert opened == [app_menu.ISSUES_URL]
    app.menu_action(items["New Independent Workspace"])
    assert calls == ["workspace"]

    done = threading.Event()
    real = app.run_command
    monkeypatch.setattr(app, "run_command", lambda w, name, args=None: (real(w, name, args), done.set()))
    app.menu_action(items["Save Session"])
    assert done.wait(5)
    assert 'f("save-session")' in window.scripts[-1]


def test_copy_locus_asks_the_page_and_writes_the_clipboard(monkeypatch):
    app = desktop.DesktopApp([], port=8756)
    window = FakeWindow("chr7:5529000-5531500")
    monkeypatch.setattr(app, "front_window", lambda: window)
    done, clip = threading.Event(), []
    monkeypatch.setattr(app, "_set_clipboard", lambda text: (clip.append(text), done.set()))
    app.copy_locus()
    assert done.wait(5)
    assert clip == ["chr7:5529000-5531500"] and 'f("locus")' in window.scripts[0]


@pytest.fixture(autouse=True)
def _no_server_for_about(monkeypatch):
    # About asks the app's server which FiberHMM it runs (/api/app/info); these tests never reach a real one (an
    # app may be listening on 8756).
    monkeypatch.setattr(desktop.DesktopApp, "server_fiberhmm", lambda self: None)


def test_about_names_both_versions(monkeypatch):
    monkeypatch.setattr(desktop, "fiberhmm_version", lambda: "3.0.0")
    text = desktop.DesktopApp([], port=8756).about_text()
    assert text.startswith("FiberBrowser ") and "FiberHMM 3.0.0" in text


def test_about_says_how_to_cite():
    # The About box's citation block (macOS: its credits; elsewhere the About window's last paragraph).
    from fiberbrowser import _paths
    text = desktop.citation_text()
    assert text.startswith(f"How to cite: FiberBrowser {_paths.version()}") and "CITATION.cff" in text
    assert "FiberHMM (github.com/fiberseq/FiberHMM)" in text
    assert "{cite}" in desktop._ABOUT_HTML


def test_about_window_shows_the_fiberhmm_line_and_the_citation(monkeypatch):
    # The About window (Windows/Linux; macOS falls back to it): the server's FiberHMM line, the update menu item,
    # and the citation paragraph together.
    from fiberbrowser.app_menu import iter_items
    app = desktop.DesktopApp([], port=8756)
    monkeypatch.setattr(desktop.DesktopApp, "server_fiberhmm", lambda self: {
        "source": "bundled", "running": {"version": "3.0.0", "path": "/App/fiberhmm"}, "notices": []})
    monkeypatch.setattr(desktop.sys, "platform", "linux")
    shown = {}
    monkeypatch.setattr(app, "create_window", lambda **kw: shown.update(kw))
    app.show_about()
    page = shown["html"]
    assert "FiberHMM 3.0.0 (bundled) at /App/fiberhmm" in page
    assert "How to cite: FiberBrowser" in page and "CITATION.cff" in page and "{cite}" not in page
    assert any(i.kind == "command" and i.target == "check-updates" for i in iter_items())


def test_about_says_the_build_flavour(monkeypatch):
    from fiberbrowser import _paths
    monkeypatch.setattr(desktop, "fiberhmm_version", lambda: "3.0.0")
    # The flavour of this tree's plugin packs (lab), else public.
    assert f"({_paths.build_flavor()} build)" in desktop.DesktopApp([], port=8756).about_text()
    monkeypatch.setattr(desktop, "build_flavor", lambda: "public")
    assert "(public build)" in desktop.DesktopApp([], port=8756).about_text()


def test_build_flavor_reads_the_pack_manifests(tmp_path, monkeypatch):
    from fiberbrowser import _paths
    monkeypatch.setattr(_paths, "browser_dir", lambda: tmp_path)
    assert _paths.build_flavor() == "public"
    (tmp_path / "somepack").mkdir()
    (tmp_path / "somepack" / "fiberbrowser-pack.json").write_text('{"name": "somepack", "flavor": "special"}')
    assert _paths.build_flavor() == "special"


def test_pywebview_menus_without_appkit_actions():
    pytest.importorskip("webview")
    menus = app_menu.pywebview_menus(lambda item: None)
    titles = [m.title for m in menus]
    assert titles[:3] == ["FiberBrowser", "File", "Edit"]
    file_titles = [getattr(i, "title", None) for i in menus[1].items]
    assert "Save Session" in file_titles and "Close Window" not in file_titles


def test_native_menu_bar_builds_with_key_equivalents():
    """Smoke test of the real NSMenu (macOS, PyObjC): titles, shortcuts, targets."""
    AppKit = pytest.importorskip("AppKit")
    chosen = []
    target = app_menu.make_target(chosen.append)
    main = app_menu.build_native_menu(target)
    titles = [main.itemAtIndex_(i).title() for i in range(main.numberOfItems())]
    assert titles == ["FiberBrowser", "File", "Edit", "View", "Window", "Help"]

    def find(menu_title, item_title):
        menu = main.itemWithTitle_(menu_title).submenu()
        return menu.itemWithTitle_(item_title)

    save = find("File", "Save Session")
    assert save.keyEquivalent() == "s"
    assert save.keyEquivalentModifierMask() == AppKit.NSEventModifierFlagCommand
    workspace = find("File", "New Independent Workspace")
    assert workspace.keyEquivalentModifierMask() == (AppKit.NSEventModifierFlagCommand
                                                     | AppKit.NSEventModifierFlagShift)
    copy = find("Edit", "Copy")
    assert copy.action() == "copy:" and copy.target() is None
    assert find("FiberBrowser", "Quit FiberBrowser").action() == "terminate:"
    appearance = find("View", "Appearance").submenu()
    assert [appearance.itemAtIndex_(i).title() for i in range(appearance.numberOfItems())] == ["Light", "Dark"]

    # Choosing an item reaches the callback with its spec.
    target.fiberbrowserMenuAction_(save)
    assert chosen and chosen[0].target == "save-session"
