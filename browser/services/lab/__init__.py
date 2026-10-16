"""The shared lab profile (``profile = "lab"`` in the server config).

One lab space on one server: members sign in, see every file under the data
roots, and share one Library, run registry, saved-session shelf and audit log
(all in the config's state folder). Each member keeps their own working view
(loaded datasets, position, filters): a per-member state forked from the
server's reference, so two people never move each other's view.

Modules:
    users     accounts file (scrypt hashes, invites, roles)
    logins    signed-in browser sessions (cookie tokens, expiry)
    auth      the request middleware (accounts / trusted proxy / none), CSRF,
              login rate limiting, route policy by role
    paths     data-root confinement (symlinks resolved)
    audit     JSON-lines audit log
    members   per-member BrowserState
    pages     the login page, the admin page and the bar injected in the app
"""
from __future__ import annotations

from typing import Optional

from services.server_config import ServerConfig

_config: Optional[ServerConfig] = None


def configure(cfg: Optional[ServerConfig]) -> None:
    """Activate (or, with None, deactivate) the lab profile for this process."""
    global _config
    from services.runtime import set_lab_mode
    _config = cfg if (cfg is not None and cfg.is_lab) else None
    set_lab_mode(_config is not None)
    from services.lab import auth, limits, logins, paths
    paths.pin_roots(_config)  # data roots resolved and pinned (device+inode) now
    logins.reset_store()
    auth.reset_rate_limits()
    if _config is None:
        limits._members_limited = False


def get_config() -> Optional[ServerConfig]:
    return _config


def require_config() -> ServerConfig:
    if _config is None:
        raise RuntimeError("The lab profile is not active")
    return _config
