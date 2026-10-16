"""``fiberbrowser users ...``, ``fiberbrowser audit`` and ``fiberbrowser check-config``:
managing a lab server (``profile = "lab"``) from the command line.

    fiberbrowser users list    --config fiberbrowser-server.toml
    fiberbrowser users invite  alice [--role admin]     one-time code alice uses to set her password
    fiberbrowser users add     alice [--role admin] [--password]   (--password prompts; else an invite)
    fiberbrowser users reset   alice [--password]       new invite code (or password); ends her sign-ins
    fiberbrowser users role    alice admin|member
    fiberbrowser users remove  alice
    fiberbrowser audit         [--tail 50] [--event login_failed] [--user alice] [--json]
    fiberbrowser check-config  fiberbrowser-server.toml

The accounts file is the config's ``auth.users_file`` (default
``<state dir>/users.json``); ``--users-file`` names one directly. The config
can also come from ``FIBERBROWSER_CONFIG``. Every change is written to the
lab's audit log. A running server picks changes up at once.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from typing import Optional, Sequence

from ._paths import browser_dir


def _backend() -> None:
    path = str(browser_dir())
    if path not in sys.path:
        sys.path.insert(0, path)


def _load_config(path: Optional[str]):
    _backend()
    from services.server_config import ConfigError, load_config
    path = path or os.environ.get("FIBERBROWSER_CONFIG")
    if not path:
        return None
    try:
        return load_config(path)
    except ConfigError as exc:
        raise SystemExit(f"fiberbrowser: {exc}") from exc


def _read_password(args, name: str) -> str:
    if getattr(args, "password_stdin", False):
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass(f"Password for {name}: ")
        if getpass.getpass("Repeat it: ") != password:
            raise SystemExit("fiberbrowser: the passwords differ.")
    return password


def _audit(cfg, event: str, **fields) -> None:
    if cfg is None or not cfg.is_lab:
        return
    from services.lab.audit import audit
    try:
        operator = getpass.getuser()
    except Exception:  # pragma: no cover
        operator = None
    audit(event, user=operator, ip="cli", path=cfg.audit_log, **fields)


def _print_code(name: str, code: str, cfg) -> None:
    where = (cfg.public_url + "/auth/invite") if cfg is not None and cfg.public_url else "the sign-in page (Choose your password)"
    print(f"One-time invite code for {name}: {code}")
    print(f"  {name} opens {where}, enters the user name and this code, and chooses a password.")
    print("  It works once and expires in 72 hours.")


def users_main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(prog="fiberbrowser users",
                                     description="Manage the accounts of a FiberBrowser lab server.")
    # --config / --users-file work before or after the command.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", default=argparse.SUPPRESS,
                        help="Server config (profile = lab); default FIBERBROWSER_CONFIG")
    common.add_argument("--users-file", default=argparse.SUPPRESS,
                        help="The accounts file itself (instead of the config's)")
    parser.add_argument("--config", default=None, help="Server config (profile = lab); default FIBERBROWSER_CONFIG")
    parser.add_argument("--users-file", default=None, help="The accounts file itself (instead of the config's)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="List accounts", parents=[common])
    for command, text in (("add", "Add an account (an invite code unless --password)"),
                          ("invite", "Add an account with a one-time invite code")):
        p = sub.add_parser(command, help=text, parents=[common])
        p.add_argument("name")
        p.add_argument("--role", choices=("member", "admin"), default="member")
        if command == "add":
            p.add_argument("--password", action="store_true", help="Set a password now (prompted)")
            p.add_argument("--password-stdin", action="store_true", help="Read the password from stdin")
    p = sub.add_parser("reset", parents=[common], help="New invite code (or --password); ends the user's sign-ins")
    p.add_argument("name")
    p.add_argument("--password", action="store_true")
    p.add_argument("--password-stdin", action="store_true")
    p = sub.add_parser("role", parents=[common], help="Make an account admin or member")
    p.add_argument("name")
    p.add_argument("role", choices=("member", "admin"))
    p = sub.add_parser("remove", parents=[common], help="Remove an account")
    p.add_argument("name")
    args = parser.parse_args(list(argv))

    cfg = _load_config(args.config)
    _backend()
    from services.lab.users import UserError, UsersFile
    if args.users_file:
        path = args.users_file
    elif cfg is not None and cfg.is_lab:
        if cfg.auth.mode != "accounts":
            print(f"Note: this server signs members in with auth.mode = {cfg.auth.mode}; "
                  "accounts here only set roles (proxy mode) or are unused.", file=sys.stderr)
        path = cfg.users_file
    else:
        parser.error("name a lab server config (--config, FIBERBROWSER_CONFIG) or --users-file")
    users = UsersFile(path)
    try:
        if args.command == "list":
            rows = users.listing()
            if not rows:
                print(f"No accounts yet in {path}. Add one: fiberbrowser users invite <name> --role admin")
            for row in rows:
                status = "active" if row["has_password"] else ("invited" if row["invite_pending"] else "no password")
                print(f"{row['name']:<24} {row['role']:<7} {status}")
            return 0
        if args.command in ("add", "invite"):
            password = None
            if args.command == "add" and (args.password or args.password_stdin):
                password = _read_password(args, args.name)
            code = users.add(args.name, role=args.role, password=password)
            _audit(cfg, "admin_user_add", target=args.name.lower(), role=args.role, via="cli")
            print(f"Added {args.name.lower()} ({args.role}) to {path}.")
            if code:
                _print_code(args.name.lower(), code, cfg)
            return 0
        if args.command == "reset":
            password = _read_password(args, args.name) if (args.password or args.password_stdin) else None
            code = users.reset(args.name, password=password)
            _audit(cfg, "admin_user_reset", target=args.name.lower(), via="cli")
            print(f"Reset {args.name.lower()}: their current sign-ins end.")
            if code:
                _print_code(args.name.lower(), code, cfg)
            return 0
        if args.command == "role":
            users.set_role(args.name, args.role)
            _audit(cfg, "admin_user_role", target=args.name.lower(), role=args.role, via="cli")
            print(f"{args.name.lower()} is now {args.role}.")
            return 0
        if args.command == "remove":
            users.remove(args.name)
            _audit(cfg, "admin_user_remove", target=args.name.lower(), via="cli")
            print(f"Removed {args.name.lower()}.")
            return 0
    except UserError as exc:
        print(f"fiberbrowser users: {exc}", file=sys.stderr)
        return 1
    return 2


def audit_main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(prog="fiberbrowser audit", description="Show a lab server's audit log.")
    parser.add_argument("--config", help="Server config (profile = lab); default FIBERBROWSER_CONFIG")
    parser.add_argument("--tail", type=int, default=50, help="How many of the latest events (default 50)")
    parser.add_argument("--event", help="Only this event type (login, login_failed, upload, run_submit, ...)")
    parser.add_argument("--user", help="Only this user's events")
    parser.add_argument("--json", action="store_true", help="JSON lines, as stored")
    args = parser.parse_args(list(argv))
    cfg = _load_config(args.config)
    if cfg is None or not cfg.is_lab:
        parser.error("name a lab server config (--config or FIBERBROWSER_CONFIG)")
    from services.lab.audit import tail
    for event in tail(args.tail, path=cfg.audit_log, event=args.event, user=args.user):
        if args.json:
            print(json.dumps(event))
            continue
        extra = {k: v for k, v in event.items() if k not in ("ts", "event", "user", "ip")}
        print(f"{event.get('ts', ''):<26} {event.get('event', ''):<18} {str(event.get('user') or '-'):<16} "
              f"{str(event.get('ip') or '-'):<16} {json.dumps(extra) if extra else ''}")
    return 0


def check_config_main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(prog="fiberbrowser check-config",
                                     description="Validate a server configuration file and summarise it.")
    parser.add_argument("config")
    args = parser.parse_args(list(argv))
    cfg = _load_config(args.config)
    from services.server_config import describe
    for line in describe(cfg):
        print(line)
    problems = []
    for root in cfg.data_roots:
        if not os.path.isdir(root.path):
            problems.append(f"data root {root.path} does not exist (yet)")
    if cfg.is_lab and cfg.auth.mode == "accounts":
        from services.lab.users import UsersFile
        if not UsersFile(cfg.users_file).exists():
            problems.append(f"no accounts yet: fiberbrowser users invite <name> --role admin --config {args.config}")
    for problem in problems:
        print(f"warning: {problem}")
    print("OK" if not problems else "OK (with warnings)")
    return 0
