"""The app window's menu bar (``fiberbrowser --app`` and FiberBrowser.app).

The menus are plain data (``MENUS``) so they can be checked without a GUI.
Every item does one of four things:

- ``command``: runs a command of the page's command bus,
  ``window.fiberbrowserCommand(name)`` (browser/frontend/src/utils/appCommands.ts),
  in the window in front: the same store action or dialog as the in-app control;
- ``app``: a method of ``fiberbrowser.desktop.DesktopApp`` (windows, About, ...);
- ``selector``: a standard AppKit action sent to the focused view or window
  (Cut/Copy/Paste in text fields, Close Window, Minimize, Quit, ...);
- ``url``: opens a web page (documentation, issues) in the default browser.

On macOS the menu bar is built natively (``build_native_menu``) because
pywebview's menus have no keyboard shortcuts and no Edit menu with Undo/Redo;
elsewhere ``pywebview_menus`` gives pywebview the same items without shortcuts.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Sequence, Union

APP_NAME = "FiberBrowser"
DOCS_URL = "https://github.com/fiberseq/FiberBrowser/blob/main/docs/index.md"
ISSUES_URL = "https://github.com/fiberseq/FiberBrowser/issues"
URLS = {"docs": DOCS_URL, "issues": ISSUES_URL}

KINDS = ("command", "app", "selector", "url", "services")


@dataclass(frozen=True)
class Item:
    title: str
    kind: str
    target: str = ""
    key: str = ""            # key equivalent, lower case ("" = none)
    shift: bool = False
    alt: bool = False
    ctrl: bool = False       # Command is implied whenever ``key`` is set

    @property
    def shortcut(self) -> Optional[tuple]:
        return (self.key, self.shift, self.alt, self.ctrl) if self.key else None

    def shortcut_label(self) -> str:
        if not self.key:
            return ""
        mods = ("⌃" if self.ctrl else "") + ("⌥" if self.alt else "") + ("⇧" if self.shift else "")
        return f"{mods}⌘{self.key.upper() if len(self.key) == 1 else self.key}"


@dataclass(frozen=True)
class Submenu:
    title: str
    items: tuple


@dataclass(frozen=True)
class Menu:
    title: str
    items: tuple
    role: str = ""           # "app" | "window" | "help" | ""


SEP = None
Entry = Union[Item, Submenu, None]


def _cmd(title: str, name: str, key: str = "", **mods) -> Item:
    return Item(title, "command", name, key, **mods)


def _app(title: str, method: str, key: str = "", **mods) -> Item:
    return Item(title, "app", method, key, **mods)


def _sel(title: str, selector: str, key: str = "", **mods) -> Item:
    return Item(title, "selector", selector, key, **mods)


MENUS: tuple = (
    Menu(APP_NAME, (
        _app(f"About {APP_NAME}", "show_about"),
        _cmd("Check for Updates…", "check-updates"),
        SEP,
        _cmd("Settings…", "settings", ","),
        SEP,
        Item("Services", "services"),
        SEP,
        _sel(f"Hide {APP_NAME}", "hide:", "h"),
        _sel("Hide Others", "hideOtherApplications:", "h", alt=True),
        _sel("Show All", "unhideAllApplications:"),
        SEP,
        # terminate: -> NSApplicationWillTerminate -> DesktopApp.stop_server
        _sel(f"Quit {APP_NAME}", "terminate:", "q"),
    ), role="app"),
    Menu("File", (
        _app("New Window", "new_window", "n"),
        _app("New Independent Workspace", "new_workspace", "n", shift=True),
        SEP,
        # As the top bar's Open ▾ menu (browser/frontend/src/utils/openMenu.ts).
        _cmd("Open File…", "open-file", "o"),
        _cmd("Open from Library", "library"),
        _cmd("Load by Path / URL…", "load-by-path"),
        _cmd("Connect to Cluster…", "connect-cluster"),
        _cmd("Open Session…", "open-session"),
        SEP,
        _cmd("Process Raw Data (New DAF-seq Run)…", "new-daf-run"),
        _cmd("Data Quality (QC a Dataset)…", "dataset-qc"),
        SEP,
        _cmd("Save Session", "save-session", "s"),
        _cmd("Export Figure…", "export-figure", "e"),
        _cmd("Export Data…", "export-data", "e", shift=True),
        SEP,
        _app("Open in Web Browser", "open_in_browser"),
        SEP,
        _sel("Close Window", "performClose:", "w"),
    )),
    Menu("Edit", (
        _cmd("Undo", "undo", "z"),
        _cmd("Redo", "redo", "z", shift=True),
        SEP,
        _sel("Cut", "cut:", "x"),
        _sel("Copy", "copy:", "c"),
        _sel("Paste", "paste:", "v"),
        _sel("Select All", "selectAll:", "a"),
        SEP,
        _app("Copy Locus", "copy_locus", "c", shift=True),
    )),
    Menu("View", (
        _cmd("Zoom In", "zoom-in", "="),
        _cmd("Zoom Out", "zoom-out", "-"),
        _cmd("Back", "back", "["),
        _cmd("Forward", "forward", "]"),
        _cmd("Go to Locus…", "go-to-locus", "l"),
        _cmd("Search Commands and Settings…", "command-palette", "k"),
        SEP,
        _cmd("Show/Hide Sidebar", "toggle-sidebar", "b"),
        _cmd("Footprints Panel", "toggle-footprints"),
        _cmd("Clusters Panel", "toggle-clusters"),
        _cmd("Tutorial Panel", "toggle-tutorial"),
        SEP,
        Submenu("Appearance", (
            _cmd("Light", "appearance-light"),
            _cmd("Dark", "appearance-dark"),
        )),
        SEP,
        _sel("Enter Full Screen", "toggleFullScreen:", "f", ctrl=True),
    )),
    Menu("Window", (
        _sel("Minimize", "performMiniaturize:", "m"),
        _sel("Zoom", "performZoom:"),
        SEP,
        _sel("Bring All to Front", "arrangeInFront:"),
    ), role="window"),
    Menu("Help", (
        Item(f"{APP_NAME} Documentation", "url", "docs"),
        _cmd("Start Tour", "start-tour"),
        _cmd("Keyboard Shortcuts", "keyboard-shortcuts", "/"),
        SEP,
        Item("Report an Issue…", "url", "issues"),
    ), role="help"),
)


def iter_items(entries: Sequence[Entry] = ()) -> list:
    """Every Item of the menus (or of ``entries``), submenus included."""
    out: list = []
    for entry in (entries or [i for m in MENUS for i in m.items]):
        if isinstance(entry, Submenu):
            out.extend(iter_items(entry.items))
        elif isinstance(entry, Item):
            out.append(entry)
    return out


def command_script(name: str, args: object = None) -> str:
    """JavaScript that runs a page command and evaluates to its result (null
    on a page without the command bus: the splash and error pages)."""
    import json
    call = f"f({json.dumps(name)}{', ' + json.dumps(args) if args is not None else ''})"
    return ("(function(){var f=window.fiberbrowserCommand;"
            f"if(typeof f!=='function')return null;try{{var r={call};"
            "return (typeof r==='string'||typeof r==='boolean')?r:(r==null?null:true);}"
            "catch(e){return false;}})()")


# --- pywebview menus (Windows/Linux: no shortcuts, no AppKit selectors) --------------
def pywebview_menus(dispatch: Callable[[Item], None]):
    """pywebview Menus for the platforms without a native build: every item
    that isn't an AppKit action (Quit is handled by ``dispatch``)."""
    from webview.menu import Menu as WMenu, MenuAction, MenuSeparator

    def convert(entries):
        out = []
        for entry in entries:
            if entry is None:
                if out and not isinstance(out[-1], MenuSeparator):
                    out.append(MenuSeparator())
            elif isinstance(entry, Submenu):
                out.append(WMenu(entry.title, convert(entry.items)))
            elif entry.kind in ("command", "app", "url") or entry.target == "terminate:":
                out.append(MenuAction(entry.title, (lambda item=entry: dispatch(item))))
        while out and isinstance(out[-1], MenuSeparator):
            out.pop()
        return out

    menus = []
    for menu in MENUS:
        items = convert(menu.items)
        if items:
            menus.append(WMenu(menu.title, items))
    return menus


# --- macOS: a native menu bar with key equivalents ------------------------------------
_TARGET_CLASS = None


def _target_class():
    """The NSObject subclass that receives the menu's actions (defined once:
    Objective-C class names are global)."""
    global _TARGET_CLASS
    if _TARGET_CLASS is None:
        import Foundation
        import objc

        class FiberBrowserMenuTarget(Foundation.NSObject):
            @objc.typedSelector(b"v@:@")
            def fiberbrowserMenuAction_(self, sender):
                callback = getattr(self, "_callback", None)
                item = getattr(self, "_items", {}).get(str(sender.representedObject()))
                if callback is not None and item is not None:
                    callback(item)

        _TARGET_CLASS = FiberBrowserMenuTarget
    return _TARGET_CLASS


def make_target(callback: Callable[[Item], None]):
    target = _target_class().alloc().init()
    target._callback = callback
    target._items = {}
    return target


def build_native_menu(target, app=None):
    """The main menu (NSMenu) for ``MENUS``. ``target`` comes from ``make_target``;
    the caller keeps a reference to it (menu items hold their target weakly).
    With ``app`` (NSApplication), also registers the Services, Windows and Help menus."""
    import AppKit

    mask = {"shift": AppKit.NSEventModifierFlagShift, "alt": AppKit.NSEventModifierFlagOption,
            "ctrl": AppKit.NSEventModifierFlagControl, "cmd": AppKit.NSEventModifierFlagCommand}

    def fill(menu, entries):
        for entry in entries:
            if entry is None:
                menu.addItem_(AppKit.NSMenuItem.separatorItem())
                continue
            if isinstance(entry, Submenu):
                sub = AppKit.NSMenu.alloc().initWithTitle_(entry.title)
                fill(sub, entry.items)
                holder = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(entry.title, None, "")
                holder.setSubmenu_(sub)
                menu.addItem_(holder)
                continue
            if entry.kind == "services":
                services = AppKit.NSMenu.alloc().initWithTitle_(entry.title)
                holder = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(entry.title, None, "")
                holder.setSubmenu_(services)
                menu.addItem_(holder)
                if app is not None:
                    app.setServicesMenu_(services)
                continue
            if entry.kind == "selector":
                ns_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                    entry.title, entry.target, entry.key)
                ns_item.setTarget_(None)  # the responder chain: focused view, window, app
            else:
                ns_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                    entry.title, "fiberbrowserMenuAction:", entry.key)
                ns_item.setTarget_(target)
                ident = f"{entry.kind}:{entry.target}"
                ns_item.setRepresentedObject_(ident)
                target._items[ident] = entry
            if entry.key:
                flags = mask["cmd"]
                for name in ("shift", "alt", "ctrl"):
                    if getattr(entry, name):
                        flags |= mask[name]
                ns_item.setKeyEquivalentModifierMask_(flags)
            menu.addItem_(ns_item)

    main = AppKit.NSMenu.alloc().initWithTitle_("MainMenu")
    for spec in MENUS:
        menu = AppKit.NSMenu.alloc().initWithTitle_(spec.title)
        fill(menu, spec.items)
        holder = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(spec.title, None, "")
        holder.setSubmenu_(menu)
        main.addItem_(holder)
        if app is not None and spec.role == "window":
            app.setWindowsMenu_(menu)
        if app is not None and spec.role == "help":
            app.setHelpMenu_(menu)
    return main
