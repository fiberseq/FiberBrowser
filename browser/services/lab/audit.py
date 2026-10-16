"""The lab server's audit log: ``<state dir>/audit.log``, one JSON object per line.

Recorded: sign-ins (and failures, lockouts), sign-outs, invites accepted,
uploads, runs started/cancelled/removed, footprint-class runs, shared sessions
saved or deleted, and every admin action. Each line has ``ts`` (ISO 8601,
UTC), ``event``, ``user`` and ``ip``, plus the event's own fields. Passwords,
invite codes and tokens are never written.

``fiberbrowser audit --config <file>`` (or the admin page) shows the tail.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import threading
from collections import deque
from typing import Any, Optional

_LOCK = threading.Lock()
_SECRET_KEYS = {"password", "new_password", "code", "invite", "token", "csrf", "secret"}


def _log_path() -> Optional[str]:
    from services.lab import get_config
    cfg = get_config()
    return cfg.audit_log if cfg is not None else None


def audit(event: str, *, user: Optional[str] = None, ip: Optional[str] = None,
          path: Optional[str] = None, **fields: Any) -> None:
    """Append one event (no-op when the lab profile is off). Never raises."""
    log = path or _log_path()
    if not log:
        return
    record = {"ts": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"), "event": event,
              "user": user, "ip": ip}
    for key, value in fields.items():
        if key.lower() in _SECRET_KEYS:
            continue
        record[key] = value
    line = json.dumps(record, default=str, sort_keys=False) + "\n"
    try:
        with _LOCK:
            os.makedirs(os.path.dirname(log), exist_ok=True)
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
            with os.fdopen(fd, "a", encoding="utf-8") as handle:
                handle.write(line)
    except OSError as exc:
        print(f"  [audit] could not write {log}: {exc}")


def tail(limit: int = 200, *, path: Optional[str] = None, event: Optional[str] = None,
         user: Optional[str] = None) -> list[dict]:
    """The last ``limit`` events (optionally of one event type or user), oldest first."""
    log = path or _log_path()
    if not log:
        return []
    rows: deque = deque(maxlen=max(1, min(int(limit), 10_000)))
    try:
        with open(log, encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if event and record.get("event") != event:
                    continue
                if user and record.get("user") != user:
                    continue
                rows.append(record)
    except OSError:
        return []
    return list(rows)
