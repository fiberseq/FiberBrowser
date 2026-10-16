"""Read-window limits on a lab server.

Anonymous catalog visitors always get the public-mode limits
(``services/public_limits.py``). Members get them only when the lab config
sets ``[limits] max_span_bp`` or ``max_reads`` (a small shared machine); the
configured values then apply to visitors too.
"""
from __future__ import annotations

_members_limited = False


def configure_lab_limits(cfg) -> None:
    global _members_limited
    from services.public_limits import configure_public_limits, reset_public_limits
    limits = cfg.limits
    _members_limited = bool(limits.max_span_bp or limits.max_reads)
    if _members_limited:
        configure_public_limits(max_span_bp=limits.max_span_bp or None, max_reads=limits.max_reads or None)
    else:
        reset_public_limits()


def request_limits_apply() -> bool:
    """Whether the read-window limits apply to this request."""
    from services.runtime import current_lab_user, get_lab_mode, get_visitor_public_mode
    if get_visitor_public_mode():
        return True
    return _members_limited and get_lab_mode() and current_lab_user() is not None
