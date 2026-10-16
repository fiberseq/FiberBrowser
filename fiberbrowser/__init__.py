"""FiberBrowser: an interactive genome browser for fiber-seq and DAF-seq footprints.

Start it with the ``fiberbrowser`` command (``fiberbrowser --help``), or from
Python / Jupyter::

    from fiberbrowser.browser_client import BrowserClient   # the Jupyter client

(``import browser_client`` works too.) The package mirrors the source tree:
the server lives in ``fiberbrowser/browser`` and imports its modules from that
folder, so it is started through the command rather than imported.
"""
from ._paths import app_root, version

__version__ = version()

__all__ = ["__version__", "app_root"]
