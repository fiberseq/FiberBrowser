"""Runtime flags shared across routers without importing server.py."""
from __future__ import annotations

import contextlib
import contextvars
from typing import Optional

_public_mode = False
# The Copilot is part of this install (False in FiberBrowser.app: --no-copilot).
_copilot_included = True

COPILOT_NOT_INCLUDED_MESSAGE = (
    "The Copilot is not included in FiberBrowser.app (the app window); it remains "
    "available in the pip install, in a web browser."
)
_COPILOT_OFF_VALUES = {"off", "0", "false", "no", "none", "disabled"}

# The sandbox (a tour tab) this request belongs to, set by the sandbox
# middleware (state/sandbox.py). A sandbox request is treated exactly like a
# public-mode visitor: the route allowlist, the in-route checks and the
# frontend's public UI all apply, and it sees only its own forked state.
_sandbox_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("fiberbrowser_sandbox_id", default=None)

# Lab server (profile "lab", services/lab/): the signed-in member this request
# belongs to (None: no member), and whether it is an anonymous visitor of the
# lab's optional public catalog (public-mode rules for that request).
_lab_mode = False
_lab_user: contextvars.ContextVar[Optional[object]] = contextvars.ContextVar("fiberbrowser_lab_user", default=None)
_anonymous_visitor: contextvars.ContextVar[bool] = contextvars.ContextVar("fiberbrowser_anonymous", default=False)


def set_lab_mode(enabled: bool) -> None:
    global _lab_mode
    _lab_mode = bool(enabled)


def get_lab_mode() -> bool:
    """The server runs the shared lab profile (accounts, data roots, shared stores)."""
    return _lab_mode


def current_lab_user():
    """The lab member (services.lab.users.LabUser) of this request, or None."""
    return _lab_user.get()


def is_anonymous_visitor() -> bool:
    return _anonymous_visitor.get()


@contextlib.contextmanager
def lab_request_context(user=None, anonymous: bool = False):
    user_token = _lab_user.set(user)
    anon_token = _anonymous_visitor.set(bool(anonymous))
    try:
        yield
    finally:
        _anonymous_visitor.reset(anon_token)
        _lab_user.reset(user_token)


def set_public_mode(enabled: bool) -> None:
    global _public_mode
    _public_mode = bool(enabled)


def get_public_mode() -> bool:
    """Public-mode rules apply to this request: a --public server, a sandbox tab,
    or an anonymous visitor of a lab server's public catalog."""
    return _public_mode or _sandbox_id.get() is not None or _anonymous_visitor.get()


def get_visitor_public_mode() -> bool:
    """This request comes from an anonymous visitor: a --public server, or a lab
    server's public catalog (sandbox tabs, the owner's own, excluded). Resource
    limits and path redaction apply to these requests."""
    return _public_mode or _anonymous_visitor.get()


def get_host_public_mode() -> bool:
    """The server itself runs with --public (sandbox requests aside)."""
    return _public_mode


def current_sandbox_id() -> Optional[str]:
    return _sandbox_id.get()


# The independent workspace (another tab's own full session on a local
# server, state/workspace.py) this request belongs to. Unlike a sandbox it
# runs under the normal local rules: public mode stays off.
_workspace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("fiberbrowser_workspace_id", default=None)


def current_workspace_id() -> Optional[str]:
    return _workspace_id.get()


@contextlib.contextmanager
def workspace_context(workspace_id: Optional[str]):
    token = _workspace_id.set(workspace_id)
    try:
        yield
    finally:
        _workspace_id.reset(token)


@contextlib.contextmanager
def sandbox_context(sandbox_id: Optional[str]):
    token = _sandbox_id.set(sandbox_id)
    try:
        yield
    finally:
        _sandbox_id.reset(token)


# On a public server the reference (GTF, FASTA, chroms, genome) is shared by
# every visitor. A visitor's session may fill an empty shared field (e.g. the
# chromosomes of the first catalog dataset) but may only replace one inside
# allow_shared_writes(), which the catalog-genome load uses. Sandbox sessions
# never write the shared reference: they own copies of it (copy-on-write).

_shared_writes_allowed = contextvars.ContextVar("fiberbrowser_shared_writes_allowed", default=False)


@contextlib.contextmanager
def allow_shared_writes():
    token = _shared_writes_allowed.set(True)
    try:
        yield
    finally:
        _shared_writes_allowed.reset(token)


def shared_write_allowed(current) -> bool:
    # Anonymous visitors of a lab server's public catalog share the template
    # reference exactly like --public visitors do.
    if not (_public_mode or _anonymous_visitor.get()) or _shared_writes_allowed.get():
        return True
    if current is None:
        return True
    try:
        return len(current) == 0
    except TypeError:
        return False


def copilot_left_out(args=None, environ=None) -> bool:
    """The Copilot is left out of this server: ``--no-copilot`` (the desktop
    app passes it) or ``FIBERBROWSER_COPILOT=off`` in the environment."""
    import os
    env = os.environ if environ is None else environ
    if getattr(args, "no_copilot", False):
        return True
    return str(env.get("FIBERBROWSER_COPILOT", "")).strip().lower() in _COPILOT_OFF_VALUES


def set_copilot_included(included: bool) -> None:
    global _copilot_included
    _copilot_included = bool(included)


def copilot_included() -> bool:
    """False when this server runs without the Copilot (FiberBrowser.app): the
    page hides it, /api/status says so and the /api/nl routes refuse."""
    return _copilot_included


def apply_copilot_inclusion(args, environ=None) -> bool:
    """At startup: record whether this server includes the Copilot, and when it
    is left out turn its backend off (nothing checked, downloaded or started).
    True when the Copilot is included."""
    included = not copilot_left_out(args, environ)
    set_copilot_included(included)
    if not included:
        args.copilot = "off"
    return included
