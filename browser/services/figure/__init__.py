"""Headless figure renderer: the browser's view drawn in Python.

No browser, Node or Playwright: tracks are ports of the browser's canvas
drawing, fed the browser's own state (a session, the open tab, or defaults)
and the same server data. See spec.py (what to draw), surface.py (SVG, PDF,
PNG), compose.py (layout) and tracks/ (one module per browser track).
"""
