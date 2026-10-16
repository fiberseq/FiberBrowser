"""FiberBrowser's Jupyter client under its historical name.

``pip install fiberbrowser`` installs the client as ``fiberbrowser.browser_client``;
this module makes ``from browser_client import BrowserClient`` (as in the docs
and older notebooks) keep working. It is the same module object.
"""
import importlib as _importlib
import sys as _sys

_sys.modules[__name__] = _importlib.import_module("fiberbrowser.browser_client")
