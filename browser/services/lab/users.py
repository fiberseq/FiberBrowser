"""Lab accounts: ``<state dir>/users.json`` (``auth.users_file`` overrides).

Passwords are stored as scrypt hashes (``hashlib.scrypt``, a per-user random
salt; no extra dependency). The file is written atomically, mode 0600, and
serialised across processes with ``flock`` so the ``fiberbrowser users`` CLI
and a running server can both change it.

An account is added with a password, or with a one-time *invite code* the new
member uses on the sign-in page to choose their own password (``users invite``;
``users reset`` issues a fresh code and signs the member out). Roles:
``member`` (everything the lab shares) and ``admin`` (also manages accounts
and reads the audit log).
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

SCHEMA = "fiberbrowser.users.v1"
ROLES = ("member", "admin")
MIN_PASSWORD = 10
INVITE_HOURS = 72.0
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._@-]{0,63}$")
# scrypt cost: ~16 MiB, ~50 ms. Stored with each hash, so it can be raised later.
_N, _R, _P = 2 ** 14, 8, 1
_LOCK = threading.RLock()


class UserError(ValueError):
    """A request the accounts file refuses (bad name, weak password, unknown user...)."""


@dataclass(frozen=True)
class LabUser:
    name: str
    role: str = "member"
    source: str = "accounts"   # accounts | proxy | none

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def as_dict(self) -> dict:
        return {"name": self.name, "role": self.role, "source": self.source}


def valid_name(name: str) -> bool:
    return isinstance(name, str) and bool(_NAME_RE.match(name))


def normalize_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not valid_name(name):
        raise UserError("User names are 1-64 characters: lowercase letters, digits, and . _ @ - "
                        "(starting with a letter or digit).")
    return name


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def hash_secret(secret: str, *, n: int = _N, r: int = _R, p: int = _P) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt${n}${r}${p}${_b64(salt)}${_b64(digest)}"


def verify_secret(secret: str, stored: Optional[str]) -> bool:
    if not stored or not isinstance(secret, str):
        # Same work as a real check, so timing doesn't reveal unknown users.
        hash_secret(secret if isinstance(secret, str) else "")
        return False
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(secret.encode("utf-8"), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                                maxmem=64 * 1024 * 1024, dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def check_password_strength(password: str, name: str = "") -> None:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise UserError(f"Passwords need at least {MIN_PASSWORD} characters.")
    if name and password.lower() == name.lower():
        raise UserError("The password must not be the user name.")


# ---------------------------------------------------------------------------
# The file
# ---------------------------------------------------------------------------

class UsersFile:
    """The accounts file at ``path``."""

    def __init__(self, path: str):
        self.path = Path(path).expanduser()

    # ----- I/O ----------------------------------------------------------
    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        with _LOCK:
            if fcntl is None:
                yield
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            lock = self.path.with_name(self.path.name + ".lock")
            with open(lock, "a") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle, fcntl.LOCK_UN)

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"schema": SCHEMA, "users": {}}
        except (OSError, ValueError) as exc:
            raise UserError(f"Cannot read the accounts file {self.path}: {exc}") from exc
        if not isinstance(data, dict) or data.get("schema") != SCHEMA or not isinstance(data.get("users"), dict):
            raise UserError(f"{self.path} is not a FiberBrowser accounts file ({SCHEMA}).")
        return data

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=1, sort_keys=True)
                handle.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            if tmp.exists():
                tmp.unlink()

    def exists(self) -> bool:
        return self.path.is_file()

    # ----- queries ------------------------------------------------------
    def users(self) -> dict[str, dict]:
        with self._locked():
            return self._read()["users"]

    def _cached_users(self) -> dict[str, dict]:
        """users(), re-read only when the file changed (called on every request)."""
        try:
            st = self.path.stat()
            key = (st.st_mtime_ns, st.st_size, st.st_ino)
        except FileNotFoundError:
            return {}
        cached = getattr(self, "_cache", None)
        if cached is not None and cached[0] == key:
            return cached[1]
        users = self.users()
        self._cache = (key, users)
        return users

    def get(self, name: str) -> Optional[LabUser]:
        try:
            name = normalize_name(name)
        except UserError:
            return None
        record = self._cached_users().get(name)
        if not record or record.get("disabled"):
            return None
        return LabUser(name=name, role=record.get("role", "member"), source="accounts")

    def listing(self) -> list[dict]:
        """Public view of every account (never a hash)."""
        now = time.time()
        rows = []
        for name, record in sorted(self.users().items()):
            invite = record.get("invite") or {}
            rows.append({
                "name": name, "role": record.get("role", "member"),
                "created": record.get("created"), "last_login": record.get("last_login"),
                "has_password": bool(record.get("password")),
                "invite_pending": bool(invite) and float(invite.get("expires", 0)) > now,
                "generation": int(record.get("generation", 0)),
            })
        return rows

    def generation(self, name: str) -> int:
        """Bumped on reset/removal/role change: older sign-ins of the user end."""
        record = self._cached_users().get(name) or {}
        return int(record.get("generation", 0))

    # ----- changes ------------------------------------------------------
    def add(self, name: str, *, role: str = "member", password: Optional[str] = None,
            invite_hours: float = INVITE_HOURS) -> Optional[str]:
        """Add an account; returns a one-time invite code when no password is given."""
        name = normalize_name(name)
        if role not in ROLES:
            raise UserError(f"Role must be one of {', '.join(ROLES)}.")
        if password is not None:
            check_password_strength(password, name)
        with self._locked():
            data = self._read()
            if name in data["users"]:
                raise UserError(f"{name} already has an account (use reset to issue a new invite).")
            record = {"role": role, "created": time.time(), "generation": 0}
            code = None
            if password is not None:
                record["password"] = hash_secret(password)
            else:
                code = _new_code()
                record["invite"] = {"hash": hash_secret(code), "expires": time.time() + invite_hours * 3600}
            data["users"][name] = record
            self._write(data)
        return code

    def remove(self, name: str) -> None:
        name = normalize_name(name)
        with self._locked():
            data = self._read()
            if name not in data["users"]:
                raise UserError(f"No account named {name}.")
            if data["users"][name].get("role") == "admin" and _admin_count(data) <= 1 and len(data["users"]) > 1:
                raise UserError("That is the last admin; make someone else admin first.")
            del data["users"][name]
            self._write(data)

    def reset(self, name: str, *, password: Optional[str] = None, invite_hours: float = INVITE_HOURS) -> Optional[str]:
        """New password, or (without one) a new invite code; ends the user's sign-ins."""
        name = normalize_name(name)
        if password is not None:
            check_password_strength(password, name)
        with self._locked():
            data = self._read()
            record = data["users"].get(name)
            if record is None:
                raise UserError(f"No account named {name}.")
            record["generation"] = int(record.get("generation", 0)) + 1
            record.pop("failed", None)
            code = None
            if password is not None:
                record["password"] = hash_secret(password)
                record.pop("invite", None)
            else:
                record.pop("password", None)
                code = _new_code()
                record["invite"] = {"hash": hash_secret(code), "expires": time.time() + invite_hours * 3600}
            self._write(data)
        return code

    def set_role(self, name: str, role: str) -> None:
        name = normalize_name(name)
        if role not in ROLES:
            raise UserError(f"Role must be one of {', '.join(ROLES)}.")
        with self._locked():
            data = self._read()
            record = data["users"].get(name)
            if record is None:
                raise UserError(f"No account named {name}.")
            if record.get("role") == "admin" and role != "admin" and _admin_count(data) <= 1:
                raise UserError("That is the last admin; make someone else admin first.")
            record["role"] = role
            record["generation"] = int(record.get("generation", 0)) + 1
            self._write(data)

    def authenticate(self, name: str, password: str) -> Optional[LabUser]:
        """The user when the password matches (constant work either way)."""
        try:
            name = normalize_name(name)
        except UserError:
            verify_secret(password, None)
            return None
        record = self.users().get(name)
        if not record or record.get("disabled") or not record.get("password"):
            verify_secret(password, None)
            return None
        if not verify_secret(password, record["password"]):
            return None
        with contextlib.suppress(UserError, OSError):
            self._touch_login(name)
        return LabUser(name=name, role=record.get("role", "member"), source="accounts")

    def accept_invite(self, name: str, code: str, password: str) -> LabUser:
        """Set a first (or reset) password with a valid invite code."""
        name = normalize_name(name)
        check_password_strength(password, name)
        with self._locked():
            data = self._read()
            record = data["users"].get(name)
            invite = (record or {}).get("invite") or {}
            if not record or not invite or float(invite.get("expires", 0)) < time.time() \
                    or not verify_secret(code or "", invite.get("hash")):
                if not invite:
                    verify_secret(code or "", None)
                raise UserError("That invite code is not valid (wrong, used or expired). Ask an admin for a new one.")
            record.pop("invite", None)
            record["password"] = hash_secret(password)
            record["generation"] = int(record.get("generation", 0)) + 1
            self._write(data)
            return LabUser(name=name, role=record.get("role", "member"), source="accounts")

    def _touch_login(self, name: str) -> None:
        with self._locked():
            data = self._read()
            record = data["users"].get(name)
            if record is not None:
                record["last_login"] = time.time()
                self._write(data)


def _admin_count(data: dict) -> int:
    return sum(1 for record in data["users"].values() if record.get("role") == "admin")


def _new_code() -> str:
    # Short enough to read out, long enough (~80 bits) not to guess.
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(16))
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))
