#!/usr/bin/env python3
"""
FiberHMM Browser - Genome browser for fiber-seq footprint visualization

Launch the browser with:
    python browser.py -b footprints.bam -g genes.gtf
    python browser.py -b footprints.bb -g genes.gtf

Or in standalone mode (add files via UI):
    python browser.py
"""

import sys
import os

# Single-threaded BLAS before numpy loads anywhere in this process. The FiberHMM
# consensus kernel's frozen reference was produced with OPENBLAS_NUM_THREADS=1; a
# multi-threaded pool here oversubscribes the kernel's own single-threaded workers
# (measured ~4,000x slower dot products on a 32-thread host) and changes last-ulp
# results, so run digests stop reproducing. setdefault keeps an explicit operator
# override. OMP_NUM_THREADS is deliberately left alone so Numba's parallel layer
# and the copilot subprocess are unaffected.
for _name in ('OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
    os.environ.setdefault(_name, '1')
del _name

# Add browser directory to path
browser_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'browser')
sys.path.insert(0, browser_dir)

# Before anything heavy is imported: a too-old Python fails with a plain
# message instead of a TypeError from deep inside the server's imports.
if sys.version_info < (3, 10):
    sys.stderr.write(
        "FiberBrowser needs Python 3.10 or newer; this is Python %s (%s).\n"
        "Install a current Python (e.g. `brew install python@3.12`, python.org's installer, or Miniforge),\n"
        "then: python3.12 -m pip install -r requirements.txt && python3.12 browser.py\n"
        % (sys.version.split()[0], sys.executable))
    sys.exit(1)

# Launcher flags (--app, --install-shortcut, --uninstall-shortcut) are the
# fiberbrowser package's (fiberbrowser/cli.py), which sits next to this file in
# a checkout and in site-packages when installed with pip.
if any(flag in sys.argv[1:] for flag in ("--app", "--install-shortcut", "--uninstall-shortcut")):
    _here = os.path.dirname(os.path.abspath(__file__))
    if os.path.isdir(os.path.join(_here, "fiberbrowser")) and _here not in sys.path:
        sys.path.insert(1, _here)
    from fiberbrowser.cli import main as _launcher_main
    sys.exit(_launcher_main(sys.argv[1:]))

# `python browser.py --copilot-doctor`: check the install and the Copilot setup,
# print what's wrong and how to fix it, and exit. Runs even when the server's
# own imports would fail.
if "--copilot-doctor" in sys.argv[1:]:
    from services.copilot_doctor import main as _doctor_main
    sys.exit(_doctor_main(sys.argv[1:]))


def _preflight_core_imports():
    """Name the broken package and its fix, rather than a raw ImportError."""
    try:
        from services.copilot_doctor import core_dependency_problems
    except Exception:
        return
    problems = core_dependency_problems()
    if not problems:
        return
    sys.stderr.write("FiberBrowser can't start: some required packages won't load in %s\n\n" % sys.executable)
    for problem in problems:
        sys.stderr.write("  %s\n    %s\n    fix: %s\n\n" % (problem["package"], problem["detail"], problem["fix"]))
    sys.stderr.write("`python browser.py --copilot-doctor` checks the whole setup.\n")
    sys.exit(1)


try:
    from server import main
except ImportError:
    _preflight_core_imports()
    raise

if __name__ == "__main__":
    main()
