"""Entry point of the frozen Mac app (PyInstaller): one binary, several roles.

In the app, ``sys.executable`` is the app binary, not a Python interpreter,
yet the server and FiberHMM start child processes the Python way. This
dispatcher gives the binary those roles:

    FiberBrowser                          the app window (fiberbrowser.desktop)
    FiberBrowser --serve [options]        the server (what `fiberbrowser [options]` runs)
    FiberBrowser -m module [args]         `python -m module` (FiberHMM's pipeline runs
                                          `sys.executable -m fiberhmm.cli.call`; joblib/loky
                                          workers run `-m ...popen_loky_posix`)
    FiberBrowser -c code [args]           `python -c code` (multiprocessing helpers)
    FiberBrowser script.py [args]         `python script.py` (/api/new-window restarts
                                          browser.py; the drop-window helper script)
    FiberBrowser --entry-point NAME [args]  a console script of an installed package
                                          (bin/fiberhmm-* in the bundle call this)

Python's own start-up flags (-u, -B, -E, -s, -I, -O, -W x, -X x) that
multiprocessing adds are accepted and ignored.
"""
from __future__ import annotations

import os
import runpy
import sys
from typing import Callable, Optional, Sequence

_FLAGS_NO_VALUE = {"-u", "-B", "-E", "-s", "-S", "-I", "-O", "-OO", "-q", "-b", "-bb", "-d", "-v", "-P"}
_FLAGS_WITH_VALUE = {"-W", "-X"}


def split_python_flags(args: Sequence[str]) -> list[str]:
    """Drop leading interpreter flags."""
    args = list(args)
    while args:
        head = args[0]
        if head in _FLAGS_NO_VALUE:
            args.pop(0)
        elif head in _FLAGS_WITH_VALUE and len(args) > 1:
            del args[:2]
        elif len(head) > 2 and head[:2] in _FLAGS_WITH_VALUE:
            args.pop(0)  # -Wignore, -Xfrozen_modules=off
        else:
            break
    return args


def classify(argv: Sequence[str], executable: str) -> tuple[str, list[str]]:
    """(role, remaining args) for this process's command line (argv without argv[0])."""
    args = list(argv)
    # /api/new-window runs [sys.executable, sys.argv[0], ...]; argv[0] may be the binary.
    while args and os.path.abspath(args[0]) == os.path.abspath(executable):
        args.pop(0)
    if args and args[0].startswith("-psn_"):
        args.pop(0)  # Finder's process serial number (old macOS)
    if args[:1] == ["--multiprocessing-fork"]:
        return "mp-fork", args
    args = split_python_flags(args)
    if not args:
        return "app", []
    head = args[0]
    if head == "--serve":
        return "serve", args[1:]
    if head == "--entry-point" and len(args) > 1:
        return "entry-point", args[1:]
    if head == "-m" and len(args) > 1:
        return "module", args[1:]
    if head.startswith("-m") and len(head) > 2:
        return "module", [head[2:], *args[1:]]
    if head == "-c" and len(args) > 1:
        return "code", args[1:]
    if not head.startswith("-") and head.endswith((".py", ".pyw")):
        return "script", args
    return "app", args


def _console_script(name: str) -> Callable[[], object]:
    from importlib.metadata import entry_points
    for entry in entry_points(group="console_scripts"):
        if entry.name == name:
            return entry.load()
    raise SystemExit(f"{name}: no such command in this FiberBrowser app")


def configure_frozen_process() -> None:
    """Keep caches out of the signed bundle and put helper programs on PATH."""
    # The frozen interpreter ignores PYTHON* variables (PYTHONUNBUFFERED,
    # PYTHONPYCACHEPREFIX): apply them here. Line-buffered output keeps the
    # server log current (it is a file, not a terminal).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)
        except (AttributeError, ValueError):
            pass
    from .desktop import user_cache_dir
    cache = user_cache_dir()
    os.environ.setdefault("NUMBA_CACHE_DIR", str(cache / "numba"))
    os.environ.setdefault("PYTHONPYCACHEPREFIX", str(cache / "pycache"))
    sys.pycache_prefix = os.environ["PYTHONPYCACHEPREFIX"]
    # FiberBrowser.app leaves the Copilot out (the pip install keeps it): every
    # server this binary runs (the app's own, `--serve`) starts without it.
    os.environ["FIBERBROWSER_COPILOT"] = "off"
    from .cli import prepare_process_environment
    prepare_process_environment()


def run(argv: Optional[Sequence[str]] = None) -> int:
    import multiprocessing
    multiprocessing.freeze_support()  # spawn workers (--multiprocessing-fork) end here
    role, args = classify(sys.argv[1:] if argv is None else argv, sys.executable)
    if role == "mp-fork":
        return 0  # freeze_support() has run the worker by now
    configure_frozen_process()
    if role == "serve":
        from .cli import run_server
        return run_server(args)
    if role == "module":
        # As `python -m`: the working directory comes first on sys.path. The
        # link relay (services.link_proxy) is started this way from browser/.
        if os.getcwd() not in sys.path:
            sys.path.insert(0, os.getcwd())
        sys.argv = [args[0], *args[1:]]
        runpy.run_module(args[0], run_name="__main__", alter_sys=True)
        return 0
    if role == "code":
        sys.argv = ["-c", *args[1:]]
        exec(compile(args[0], "<string>", "exec"), {"__name__": "__main__"})
        return 0
    if role == "script":
        sys.argv = list(args)
        script_dir = os.path.dirname(os.path.abspath(args[0]))
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
        runpy.run_path(args[0], run_name="__main__")
        return 0
    if role == "entry-point":
        name = args[0]
        sys.argv = [name, *args[1:]]
        result = _console_script(name)()
        return result if isinstance(result, int) else 0
    from .cli import main
    return main(["--app", *args])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run())
