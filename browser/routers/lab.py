"""Lab server routes (profile "lab", services/lab/): sign in/out, invites,
the admin page and API, and the lab's shared saved-session shelf.

Every route here answers 404 on a server that isn't running the lab profile.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

router = APIRouter(tags=["lab"])

SESSION_SCHEMA = "fiberbrowser.lab_session.v1"
MAX_SESSION_BYTES = 32 << 20
_SESSION_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$")


def _cfg():
    from services.lab import get_config
    cfg = get_config()
    if cfg is None:
        raise HTTPException(status_code=404, detail="Not Found")
    return cfg


def _user(required: bool = True):
    _cfg()  # 404 off the lab profile
    from services.runtime import current_lab_user
    user = current_lab_user()
    if user is None and required:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return user


def _admin():
    user = _user()
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Only lab admins can do this.")
    return user


def _ip(request: Request) -> str:
    from services.lab.auth import client_ip
    return client_ip(request)


def _safe_next(value: Optional[str]) -> str:
    """A local path to return to after signing in (never another site)."""
    value = (value or "/").strip()
    if not value.startswith("/") or value.startswith("//") or "\\" in value or value.startswith("/auth/"):
        return "/"
    return value


def _set_pre_login_csrf(response, request: Request, token: str) -> None:
    from services.lab.auth import cookies_secure
    from services.lab.logins import CSRF_COOKIE
    from services.root_path import cookie_path
    response.set_cookie(CSRF_COOKIE, token, httponly=False, samesite="strict",
                        secure=cookies_secure(request), path=cookie_path())


def _form_csrf_ok(request: Request, form) -> bool:
    import hmac
    from services.lab.auth import _origin_ok
    from services.lab.logins import CSRF_COOKIE
    field = str(form.get("csrf") or "")
    cookie = request.cookies.get(CSRF_COOKIE) or ""
    if field and cookie and hmac.compare_digest(field.encode(), cookie.encode()):
        return True
    return _origin_ok(request)


def _html(content: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(content, status_code=status, headers={"Cache-Control": "no-store"})


def _sign_in(request: Request, user, target: str):
    """Start a signed-in session for ``user`` and redirect to ``target``."""
    from services.lab.auth import cookies_secure
    from services.lab.logins import COOKIE, CSRF_COOKIE, get_store
    from services.lab.auth import users_file
    from services.root_path import cookie_path, url_for_path
    cfg = _cfg()
    token, login = get_store().create(user.name, users_file().generation(user.name), cfg.auth.session_hours)
    response = RedirectResponse(url_for_path(target), status_code=303)
    secure = cookies_secure(request)
    max_age = int(cfg.auth.session_hours * 3600)
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=secure, path=cookie_path(),
                        max_age=max_age)
    response.set_cookie(CSRF_COOKIE, login.csrf, httponly=False, samesite="strict", secure=secure,
                        path=cookie_path(), max_age=max_age)
    return response


# ---------------------------------------------------------------------------
# Sign in / out, invites
# ---------------------------------------------------------------------------

@router.get("/auth/login", include_in_schema=False)
async def login_form(request: Request, next: str = "/"):
    from services.lab.pages import login_page
    cfg = _cfg()
    if cfg.auth.mode == "accounts":
        from services.lab.auth import identify
        if identify(request)[0] is not None:
            # Already signed in: don't replace this browser's CSRF cookie.
            from services.root_path import url_for_path
            return RedirectResponse(url_for_path(_safe_next(next)), status_code=303)
    csrf = secrets.token_urlsafe(24)
    notice = "You are signed out." if request.query_params.get("signed_out") else None
    response = _html(login_page(csrf=csrf, next_path=_safe_next(next), mode=cfg.auth.mode,
                                catalog=cfg.public_catalog.enabled, notice=notice))
    _set_pre_login_csrf(response, request, csrf)
    return response


@router.post("/auth/login", include_in_schema=False)
async def login_submit(request: Request):
    from services.lab.audit import audit
    from services.lab.auth import limiter, users_file
    from services.lab.pages import login_page
    cfg = _cfg()
    if cfg.auth.mode != "accounts":
        raise HTTPException(status_code=404, detail="Not Found")
    form = await request.form()
    username = str(form.get("username") or "").strip().lower()[:128]
    password = str(form.get("password") or "")
    target = _safe_next(str(form.get("next") or "/"))
    ip = _ip(request)

    def again(message: str, status: int):
        csrf = secrets.token_urlsafe(24)
        response = _html(login_page(csrf=csrf, next_path=target, error=message, catalog=cfg.public_catalog.enabled,
                                    username=username), status)
        _set_pre_login_csrf(response, request, csrf)
        return response

    if not _form_csrf_ok(request, form):
        return again("The sign-in form expired. Try again.", 403)
    keys = (f"user:{username}", f"ip:{ip}")
    wait = limiter().locked(*keys)
    if wait > 0:
        audit("login_locked", user=username or None, ip=ip)
        return again(f"Too many failed sign-ins. Try again in {max(1, round(wait / 60))} minute(s).", 429)
    user = users_file().authenticate(username, password) if username and password else None
    if user is None:
        locked = limiter().fail(*keys)
        audit("login_failed", user=username or None, ip=ip)
        if locked:
            audit("login_lockout", user=username or None, ip=ip, minutes=cfg.auth.lockout_minutes)
        return again("Wrong user name or password.", 401)
    limiter().succeed(f"user:{username}")
    audit("login", user=user.name, ip=ip, role=user.role)
    return _sign_in(request, user, target)


@router.post("/auth/logout", include_in_schema=False)
async def logout(request: Request):
    from services.lab.audit import audit
    from services.lab.logins import COOKIE, CSRF_COOKIE, get_store
    from services.root_path import cookie_path, url_for_path
    cfg = _cfg()
    form = await request.form()
    if not _form_csrf_ok(request, form):
        raise HTTPException(status_code=403, detail="Refused a cross-site sign-out.")
    login = get_store().delete(request.cookies.get(COOKIE))
    if login is not None:
        audit("logout", user=login.user, ip=_ip(request))
    target = "/" if cfg.public_catalog.enabled else "/auth/login?signed_out=1"
    response = RedirectResponse(url_for_path(target), status_code=303)
    response.delete_cookie(COOKIE, path=cookie_path())
    response.delete_cookie(CSRF_COOKIE, path=cookie_path())
    return response


@router.get("/auth/invite", include_in_schema=False)
async def invite_form(request: Request, user: str = "", code: str = ""):
    from services.lab.pages import invite_page
    cfg = _cfg()
    if cfg.auth.mode != "accounts":
        raise HTTPException(status_code=404, detail="Not Found")
    csrf = secrets.token_urlsafe(24)
    response = _html(invite_page(csrf=csrf, username=user[:64], code=code[:64]))
    _set_pre_login_csrf(response, request, csrf)
    return response


@router.post("/auth/invite", include_in_schema=False)
async def invite_submit(request: Request):
    from services.lab.audit import audit
    from services.lab.auth import limiter, users_file
    from services.lab.pages import invite_page
    from services.lab.users import UserError
    cfg = _cfg()
    if cfg.auth.mode != "accounts":
        raise HTTPException(status_code=404, detail="Not Found")
    form = await request.form()
    username = str(form.get("username") or "").strip().lower()[:128]
    ip = _ip(request)

    def again(message: str, status: int):
        csrf = secrets.token_urlsafe(24)
        response = _html(invite_page(csrf=csrf, username=username, error=message), status)
        _set_pre_login_csrf(response, request, csrf)
        return response

    if not _form_csrf_ok(request, form):
        return again("The form expired. Try again.", 403)
    keys = (f"user:{username}", f"ip:{ip}")
    if limiter().locked(*keys) > 0:
        return again("Too many failed attempts. Try again later.", 429)
    if str(form.get("password") or "") != str(form.get("password2") or ""):
        return again("The two passwords differ.", 400)
    try:
        user = users_file().accept_invite(username, str(form.get("code") or "").strip(), str(form.get("password") or ""))
    except UserError as exc:
        if "invite code" in str(exc):
            limiter().fail(*keys)
            audit("invite_failed", user=username or None, ip=ip)
        return again(str(exc), 400)
    audit("invite_accepted", user=user.name, ip=ip)
    return _sign_in(request, user, "/")


@router.get("/api/auth/me")
async def whoami():
    cfg = _cfg()
    from services.runtime import is_anonymous_visitor
    user = _user(required=False)
    return {"lab": True, "user": user.as_dict() if user else None, "anonymous": is_anonymous_visitor(),
            "auth": cfg.auth.mode, "jobs": cfg.jobs.enabled}


# ---------------------------------------------------------------------------
# Lab information for members
# ---------------------------------------------------------------------------

@router.get("/api/lab/info")
async def lab_info():
    cfg = _cfg()
    from services.lab.paths import roots_listing
    user = _user()
    return {"user": user.as_dict(), "roots": roots_listing(), "jobs": {
        "enabled": cfg.jobs.enabled, "max_cores_per_user": cfg.jobs.max_cores_per_user,
        "max_concurrent_per_user": cfg.jobs.max_concurrent_per_user},
        "public_catalog": cfg.public_catalog.enabled, "copilot": bool(cfg.copilot)}


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

class NewUser(BaseModel):
    name: str
    role: str = "member"


class RoleChange(BaseModel):
    role: str


@router.get("/admin", include_in_schema=False)
async def admin_page_route():
    _cfg()
    _admin()
    from services.lab.pages import admin_page
    return _html(admin_page())


def _users_or_error():
    cfg = _cfg()
    if cfg.auth.mode != "accounts":
        raise HTTPException(status_code=409, detail=f"Accounts are managed by the sign-in proxy (auth.mode = {cfg.auth.mode}).")
    from services.lab.auth import users_file
    return users_file()


@router.get("/api/admin/users")
async def admin_users():
    _admin()
    return {"success": True, "users": _users_or_error().listing()}


@router.post("/api/admin/users")
async def admin_add_user(req: NewUser, request: Request):
    from services.lab.audit import audit
    from services.lab.users import UserError
    admin = _admin()
    try:
        code = _users_or_error().add(req.name, role=req.role)
    except UserError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    name = req.name.strip().lower()
    audit("admin_user_add", user=admin.name, ip=_ip(request), target=name, role=req.role)
    return {"success": True, "name": name, "code": code}


@router.delete("/api/admin/users/{name}")
async def admin_remove_user(name: str, request: Request):
    from services.lab.audit import audit
    from services.lab.logins import get_store
    from services.lab.users import UserError
    admin = _admin()
    if name == admin.name:
        raise HTTPException(status_code=400, detail="You can't remove your own account here (use the CLI).")
    try:
        _users_or_error().remove(name)
    except UserError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    get_store().end_user(name)
    audit("admin_user_remove", user=admin.name, ip=_ip(request), target=name)
    return {"success": True}


@router.post("/api/admin/users/{name}/reset")
async def admin_reset_user(name: str, request: Request):
    from services.lab.audit import audit
    from services.lab.logins import get_store
    from services.lab.users import UserError
    admin = _admin()
    try:
        code = _users_or_error().reset(name)
    except UserError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    get_store().end_user(name)
    audit("admin_user_reset", user=admin.name, ip=_ip(request), target=name)
    return {"success": True, "name": name, "code": code}


@router.post("/api/admin/users/{name}/role")
async def admin_set_role(name: str, req: RoleChange, request: Request):
    from services.lab.audit import audit
    from services.lab.users import UserError
    admin = _admin()
    try:
        _users_or_error().set_role(name, req.role)
    except UserError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit("admin_user_role", user=admin.name, ip=_ip(request), target=name, role=req.role)
    return {"success": True}


@router.get("/api/admin/audit")
async def admin_audit(limit: int = 200, event: Optional[str] = None, user: Optional[str] = None):
    _admin()
    _cfg()
    from services.lab.audit import tail
    return {"success": True, "events": tail(limit, event=event, user=user)}


@router.get("/api/admin/members")
async def admin_members():
    _admin()
    from services.lab.logins import get_store
    from services.lab.members import get_member_manager
    manager = get_member_manager()
    return {"success": True, "active_states": manager.members() if manager else [],
            "signed_in": sorted({login.user for login in get_store().active()})}


# ---------------------------------------------------------------------------
# The lab's saved-session shelf (<state dir>/sessions)
# ---------------------------------------------------------------------------

class LabSessionSave(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    session: dict[str, Any]
    replace: Optional[str] = None


def _sessions_dir() -> str:
    cfg = _cfg()
    os.makedirs(cfg.sessions_dir, exist_ok=True)
    return cfg.sessions_dir


def _session_path(session_id: str) -> str:
    if not _SESSION_ID.match(session_id or ""):
        raise HTTPException(status_code=400, detail="Malformed session id.")
    return os.path.join(_sessions_dir(), session_id + ".json")


def _read_session(path: str) -> Optional[dict]:
    """A shelf entry: a regular file in the real sessions folder (a symlink, or
    anything resolving outside it, is not one)."""
    from services.lab.paths import open_confined
    opened = open_confined(path, [_sessions_dir()], lab_roots=False)
    if opened is None:
        return None
    handle, _real, size = opened
    try:
        with handle:
            if size > MAX_SESSION_BYTES + (1 << 20):
                return None
            data = json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("schema") == SESSION_SCHEMA else None


def _summary(data: dict) -> dict:
    session = data.get("session") or {}
    datasets = session.get("datasets") if isinstance(session, dict) else None
    viewport = session.get("viewport") if isinstance(session, dict) else None
    return {"id": data.get("id"), "name": data.get("name"), "user": data.get("user"),
            "created": data.get("created"), "updated": data.get("updated"),
            "datasets": len(datasets) if isinstance(datasets, list) else None,
            "viewport": viewport if isinstance(viewport, dict) else None}


@router.get("/api/lab/sessions")
async def lab_sessions():
    _user()
    folder = _sessions_dir()
    rows = []
    for name in os.listdir(folder):
        if not name.endswith(".json"):
            continue
        data = _read_session(os.path.join(folder, name))
        if data is not None:
            rows.append(_summary(data))
    rows.sort(key=lambda row: row.get("updated") or 0, reverse=True)
    return {"success": True, "sessions": rows}


@router.get("/api/lab/sessions/{session_id}")
async def lab_session(session_id: str):
    _user()
    data = _read_session(_session_path(session_id))
    if data is None:
        raise HTTPException(status_code=404, detail="No such saved session.")
    return {"success": True, **_summary(data), "session": data.get("session")}


@router.post("/api/lab/sessions")
async def lab_session_save(req: LabSessionSave):
    user = _user()
    body = json.dumps(req.session)
    if len(body) > MAX_SESSION_BYTES:
        raise HTTPException(status_code=413, detail="That session is too large to keep on the lab shelf.")
    now = time.time()
    created = now
    if req.replace:
        path = _session_path(req.replace)
        old = _read_session(path)
        if old is None:
            raise HTTPException(status_code=404, detail="No such saved session.")
        if old.get("user") != user.name and not user.is_admin:
            raise HTTPException(status_code=403, detail="Only its owner or an admin can replace a saved session.")
        session_id, created = req.replace, old.get("created") or now
    else:
        session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)
        path = _session_path(session_id)
    record = {"schema": SESSION_SCHEMA, "id": session_id, "name": req.name.strip(), "user": user.name,
              "created": created, "updated": now, "session": req.session}
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
    os.replace(tmp, path)
    return {"success": True, **_summary(record)}


@router.delete("/api/lab/sessions/{session_id}")
async def lab_session_delete(session_id: str):
    user = _user()
    path = _session_path(session_id)
    data = _read_session(path)
    if data is None:
        raise HTTPException(status_code=404, detail="No such saved session.")
    if data.get("user") != user.name and not user.is_admin:
        raise HTTPException(status_code=403, detail="Only its owner or an admin can delete a saved session.")
    os.unlink(path)
    return {"success": True}
