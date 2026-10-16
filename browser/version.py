"""Single source of truth for the FiberBrowser version.

Bump this in lockstep with the git tag (v<__version__>). The frontend
welcome popup reads it via /api/version to surface an "update available"
banner when the GitHub Releases API reports a newer tag.
"""
from __future__ import annotations

__version__ = "3.0.0"
