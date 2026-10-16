"""Signed-in browser sessions of a lab server (built-in accounts).

Signing in makes a random token: the browser keeps it in an HttpOnly,
SameSite=Lax cookie scoped to the server's root path (Secure over HTTPS);
the server keeps only its SHA-256, the user, the user's account generation,
the CSRF token and the expiry, in memory and in ``<state dir>/logins.json``
(0600) so a restart doesn't sign everyone out. A session ends at its expiry
(``auth.session_hours`` after sign-in), at sign-out, or when an admin resets
or removes the account or changes its role (the generation no longer matches).
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Optional

COOKIE = "fiberbrowser_lab"
CSRF_COOKIE = "fiberbrowser_csrf"
_MAX_SESSIONS = 5000


@dataclass
class Login:
    user: str
    generation: int
    csrf: str
    created: float
    expires: float


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginStore:
    def __init__(self, path: Optional[str] = None):
        self.path = path
        self._lock = threading.RLock()
        self._logins: dict[str, Login] = {}
        self._load()

    def _load(self) -> None:
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError):
            return
        now = time.time()
        for key, value in (raw.get("logins") or {}).items():
            try:
                login = Login(**value)
            except TypeError:
                continue
            if login.expires > now:
                self._logins[key] = login

    def _save(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"logins": {k: vars(v) for k, v in self._logins.items()}}, handle)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def create(self, user: str, generation: int, hours: float) -> tuple[str, Login]:
        token = secrets.token_urlsafe(32)
        now = time.time()
        login = Login(user=user, generation=generation, csrf=secrets.token_urlsafe(24),
                      created=now, expires=now + hours * 3600)
        with self._lock:
            self._expire(now)
            if len(self._logins) >= _MAX_SESSIONS:
                oldest = min(self._logins, key=lambda k: self._logins[k].created)
                self._logins.pop(oldest, None)
            self._logins[_digest(token)] = login
            self._save()
        return token, login

    def get(self, token: Optional[str]) -> Optional[Login]:
        if not token:
            return None
        with self._lock:
            key = _digest(token)
            login = self._logins.get(key)
            if login is None:
                return None
            if login.expires <= time.time():
                self._logins.pop(key, None)
                self._save()
                return None
            return login

    def delete(self, token: Optional[str]) -> Optional[Login]:
        if not token:
            return None
        with self._lock:
            login = self._logins.pop(_digest(token), None)
            if login is not None:
                self._save()
            return login

    def end_user(self, user: str) -> int:
        """Sign a user out everywhere."""
        with self._lock:
            keys = [k for k, v in self._logins.items() if v.user == user]
            for key in keys:
                del self._logins[key]
            if keys:
                self._save()
            return len(keys)

    def active(self) -> list[Login]:
        with self._lock:
            self._expire(time.time())
            return list(self._logins.values())

    def _expire(self, now: float) -> None:
        stale = [k for k, v in self._logins.items() if v.expires <= now]
        for key in stale:
            del self._logins[key]


_store: Optional[LoginStore] = None
_store_lock = threading.Lock()


def reset_store() -> None:
    global _store
    with _store_lock:
        _store = None


def get_store() -> LoginStore:
    global _store
    with _store_lock:
        if _store is None:
            from services.lab import get_config
            cfg = get_config()
            _store = LoginStore(cfg.logins_file if cfg is not None else None)
        return _store
