"""The ``fiberbrowser`` command.

``fiberbrowser [options]`` starts the browser exactly like ``python browser.py
[options]`` (same flags, same access token, same runtime file); run
``fiberbrowser --help`` for them. The launcher adds these flags of its own:

    fiberbrowser --app [options]       the browser in its own app window (needs pywebview:
                                       pip install "fiberbrowser[app]"); without pywebview it
                                       opens your web browser as usual
    fiberbrowser --install-shortcut    add FiberBrowser to the Linux application menu or the
                                       Windows Start menu (it opens the app window)
    fiberbrowser --uninstall-shortcut  remove that entry again
    fiberbrowser --open-link URL       hand a fiberbrowser://open?session=... link to your
                                       running FiberBrowser (or a new one), which asks you
                                       to confirm before opening anything

and subcommands for servers (docs/deployment/):

    fiberbrowser serve --config fiberbrowser-server.toml [options]
                                       start a server described by a config file
                                       (profile personal, public or lab); flags win
    fiberbrowser users list|invite|add|reset|role|remove ...
                                       manage a lab server's accounts
    fiberbrowser audit [--tail N]      show a lab server's audit log
    fiberbrowser check-config FILE     validate a config file
"""
from __future__ import annotations

import os
import runpy
import sys
import sysconfig
import threading
import time
from typing import Optional, Sequence

from ._paths import browser_script, bundle_bin_dirs, is_frozen, version

# Retain the desktop identity after removing its environment variable from children.
desktop_parent_pid: Optional[int] = None

LAUNCHER_FLAGS = ("--app", "--install-shortcut", "--uninstall-shortcut", "--open-link")

# Set by the app window (fiberbrowser.desktop) on the server it starts: the
# server stops when the app process is gone, even after a force quit.
EXIT_WITH_PARENT_ENV = "FIBERBROWSER_EXIT_WITH_PARENT"


def helper_program_dirs() -> list[str]:
    """Folders with programs the server runs as subprocesses.

    FiberHMM's console scripts (``fiberhmm-pipeline``, ``fiberhmm-call``, ...)
    live in this Python's scripts folder, which is not on PATH when
    ``fiberbrowser`` is started by its full path, from a shortcut or from the
    Mac app. In the app, the bundle's ``bin`` folder holds minimap2 and the
    fiberhmm-* commands.
    """
    dirs: list[str] = [str(d) for d in bundle_bin_dirs()]
    if not is_frozen():
        for candidate in (sysconfig.get_path("scripts"), os.path.dirname(sys.executable)):
            if candidate and os.path.isdir(candidate) and candidate not in dirs:
                dirs.append(candidate)
    return dirs


def prepare_process_environment(environ: Optional[dict] = None) -> dict:
    """Environment settings every FiberBrowser server process needs."""
    env = os.environ if environ is None else environ
    # Same as browser.py: single-threaded BLAS before numpy loads (FiberHMM's
    # consensus kernel reproduces its frozen digests only that way).
    for name in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        env.setdefault(name, "1")
    # Same as browser/server.py: no BLAST+ usage reports to NCBI unless asked for.
    env.setdefault("BLAST_USAGE_REPORT", "false")
    path_entries = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    missing = [d for d in helper_program_dirs() if d not in path_entries]
    if missing:
        env["PATH"] = os.pathsep.join(missing + path_entries)
    return env


def _parent_alive(pid: int) -> bool:
    if sys.platform != "win32" and os.getppid() != pid:
        return False  # re-parented: the app is gone
    try:
        from services.local_auth import pid_alive  # noqa: WPS433 (backend on sys.path by now)
    except Exception:
        return True
    return pid_alive(pid)


def watch_parent_process(poll_s: float = 2.0) -> Optional[threading.Thread]:
    """Stop this server when the process that started it exits."""
    global desktop_parent_pid
    raw = os.environ.pop(EXIT_WITH_PARENT_ENV, None)
    if not raw:
        return None
    try:
        pid = int(raw)
        if pid <= 0:
            return None
    except ValueError:
        return None
    desktop_parent_pid = pid

    def watch() -> None:
        import signal
        while True:
            time.sleep(poll_s)
            if not _parent_alive(pid):
                print("=== The FiberBrowser app closed; stopping its server ===", flush=True)
                os.kill(os.getpid(), signal.SIGTERM)
                return

    thread = threading.Thread(target=watch, name="fiberbrowser-parent-watch", daemon=True)
    thread.start()
    return thread


def line_buffer_output() -> None:
    """Flush the server's output line by line, also into a file or a pipe.

    Redirected, stdout is block-buffered, and uvicorn ends the process on
    SIGTERM/SIGINT by re-raising the signal, so ``fiberbrowser ... > log &``
    would lose the startup banner (the access link) instead of logging it.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)
        except (AttributeError, ValueError):
            pass


def _stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log_crashes() -> None:
    """Leave a timestamped traceback in the output for whatever ends or breaks the server.

    - an uncaught exception, in the main thread or any other: a timestamped
      header, then the usual traceback;
    - a fatal signal (a crash in pysam/htslib or numba code, SIGSEGV/SIGBUS/
      SIGABRT): every thread's Python stack (``faulthandler``);
    - ``kill -USR1 <pid>`` (POSIX): every thread's stack, while it keeps
      running, to see where a hung request is.
    """
    import faulthandler
    import signal
    import traceback

    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
        if hasattr(signal, "SIGUSR1") and hasattr(faulthandler, "register"):
            faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True, chain=False)
    except (AttributeError, ValueError, OSError, RuntimeError):
        pass  # stderr without a file descriptor (tests, some embedders)

    previous_hook = sys.excepthook

    def excepthook(exc_type, exc, tb):
        if not issubclass(exc_type, KeyboardInterrupt):
            print(f"[{_stamp()}] FiberBrowser server: uncaught {exc_type.__name__}", file=sys.stderr, flush=True)
        previous_hook(exc_type, exc, tb)
        try:
            sys.stderr.flush()
        except Exception:
            pass

    def thread_excepthook(args):
        if args.exc_type is SystemExit:
            return
        name = getattr(args.thread, "name", "?")
        text = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback))
        try:
            sys.stderr.write(f"[{_stamp()}] FiberBrowser server: uncaught {args.exc_type.__name__} "
                             f"in thread {name}\n{text}")
            sys.stderr.flush()
        except Exception:
            pass

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook


def run_server(argv: Sequence[str]) -> int:
    """Run browser.py in this process with ``argv`` (what ``python browser.py argv`` does)."""
    line_buffer_output()
    log_crashes()
    prepare_process_environment()
    watch_parent_process()
    script = browser_script()
    os.environ.setdefault("FIBERBROWSER_PROG", "fiberbrowser")
    # run_path sets sys.argv[0] to browser.py, which is also what
    # /api/new-window restarts ([sys.executable, sys.argv[0], ...]).
    sys.argv = [str(script), *argv]
    runpy.run_path(str(script), run_name="__main__")
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args in (["--version"], ["-V"]):
        print(f"FiberBrowser {version()}")
        return 0
    if "--open-link" in args:
        from .open_link import main as open_link_main
        return open_link_main([a for a in args if a != "--open-link"])
    if args and args[0] == "serve":
        # `serve` is the server itself: `fiberbrowser serve --config x.toml` ==
        # `fiberbrowser --config x.toml`.
        args = args[1:]
    elif args and args[0] in ("users", "audit", "check-config"):
        from . import admin
        handler = {"users": admin.users_main, "audit": admin.audit_main,
                   "check-config": admin.check_config_main}[args[0]]
        return handler(args[1:])
    if "--install-shortcut" in args or "--uninstall-shortcut" in args:
        from .shortcut import main as shortcut_main
        return shortcut_main(args)
    if "--app" in args:
        from .desktop import main as desktop_main
        return desktop_main([a for a in args if a != "--app"])
    return run_server(args)


def app_main() -> int:
    """``fiberbrowser-app``: the app window (a GUI entry point: no console on Windows)."""
    return main(["--app", *sys.argv[1:]])


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
