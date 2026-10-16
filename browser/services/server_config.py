"""Server configuration file: ``fiberbrowser serve --config fiberbrowser-server.toml``.

One TOML file describes a deployment. Every command-line flag keeps working;
a flag given on the command line wins over the file. Three profiles:

``personal``  today's default: one user, per-launch access token, all features.
``public``    today's ``--public``: anonymous visitors, route allowlist, limits.
``lab``       a shared lab server: members sign in (built-in accounts, a
              trusted proxy's user header, or ``none`` behind an authenticating
              proxy), see everything under the data roots, and share one
              Library, run registry, saved sessions and audit log kept in the
              shared state folder.

A minimal lab file::

    profile = "lab"

    [server]
    host = "0.0.0.0"
    port = 8000

    [[data.roots]]
    path = "/data/lab"

    [state]
    dir = "/srv/fiberbrowser-state"

    [auth]
    mode = "accounts"

See ``deploy/lab/fiberbrowser-server.example.toml`` for every key and
``docs/deployment/`` for the deployments that use them.
"""
from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

try:  # Python 3.11+
    import tomllib as _toml
except ModuleNotFoundError:  # pragma: no cover - Python 3.10
    import tomli as _toml

PROFILES = ("personal", "public", "lab")
AUTH_MODES = ("accounts", "proxy", "none")
CONFIG_ENV = "FIBERBROWSER_CONFIG"


class ConfigError(ValueError):
    """The configuration file is invalid; the message names the key and the fix."""


@dataclass
class DataRoot:
    path: str
    label: str = ""
    writable: bool = False

    @property
    def real(self) -> str:
        return os.path.realpath(self.path)


@dataclass
class AuthConfig:
    mode: str = "accounts"
    users_file: str = ""
    session_hours: float = 12.0
    secure_cookies: str = "auto"          # auto | always | never
    proxy_header: str = "X-Forwarded-User"
    trusted_proxies: list[str] = field(default_factory=lambda: ["127.0.0.1", "::1"])
    trusted_proxies_set: bool = False     # given in the file (any profile), not the lab default
    admins: list[str] = field(default_factory=list)
    allowed_users: list[str] = field(default_factory=list)
    user: str = ""                        # mode "none": who the requests are attributed to
    access_token: Optional[bool] = None   # mode "none": require the launch token (default on)
    max_failed_logins: int = 5
    lockout_minutes: float = 15.0


@dataclass
class JobsConfig:
    enabled: bool = False
    max_cores_total: int = 0              # 0: all of this machine's (or allocation's) cores
    max_cores_per_user: int = 0           # 0: max_cores_total
    max_concurrent_per_user: int = 2
    max_concurrent_total: int = 4
    dir: str = ""                         # run registry; default <state dir>/jobs


@dataclass
class LimitsConfig:
    upload_max_mb: int = 0                # 0: the built-in default
    max_span_bp: int = 0                  # 0: no limit (public profile: its own default)
    max_reads: int = 0
    max_working_reads: int = 0
    max_users: int = 64                   # per-member working states kept in memory
    # profile "public": any other PublicLimits field by name (rate_per_minute,
    # heavy_concurrent, cache_mb, ...; services/public_limits.limit_names()).
    public: dict = field(default_factory=dict)


@dataclass
class PublicCatalogConfig:
    enabled: bool = False
    catalog: str = ""


@dataclass
class ServerConfig:
    profile: str = "personal"
    host: Optional[str] = None
    port: Optional[int] = None
    root_path: str = ""
    public_url: str = ""
    open_browser: Optional[bool] = None
    data_roots: list[DataRoot] = field(default_factory=list)
    catalog: str = ""
    genome: str = ""
    gtf: str = ""
    fasta: str = ""
    state_dir: str = ""
    auth: AuthConfig = field(default_factory=AuthConfig)
    jobs: JobsConfig = field(default_factory=JobsConfig)
    limits: LimitsConfig = field(default_factory=LimitsConfig)
    public_catalog: PublicCatalogConfig = field(default_factory=PublicCatalogConfig)
    copilot: Optional[bool] = None
    source: str = ""

    # ----- derived ------------------------------------------------------
    @property
    def is_lab(self) -> bool:
        return self.profile == "lab"

    def state_path(self, *parts: str) -> str:
        return os.path.join(self.state_dir, *parts)

    @property
    def users_file(self) -> str:
        return self.auth.users_file or self.state_path("users.json")

    @property
    def audit_log(self) -> str:
        return self.state_path("audit.log")

    @property
    def library_file(self) -> str:
        return self.state_path("library.json")

    @property
    def jobs_dir(self) -> str:
        # Several servers sharing one state folder (one per Open OnDemand
        # session, on different nodes) keep one run registry each: a server
        # can only watch the processes of its own machine.
        return self.jobs.dir or self.state_path("jobs")

    @property
    def sessions_dir(self) -> str:
        return self.state_path("sessions")

    @property
    def uploads_dir(self) -> str:
        return self.state_path("uploads")

    @property
    def logins_file(self) -> str:
        return self.state_path("logins.json")

    def writable_roots(self) -> list[DataRoot]:
        return [root for root in self.data_roots if root.writable]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _public_limit_names() -> tuple[str, ...]:
    from services.public_limits import limit_names
    return limit_names()


_KNOWN_TOP = {"profile", "server", "data", "state", "auth", "jobs", "limits", "public_catalog", "copilot"}
_KNOWN = {
    "server": {"host", "port", "root_path", "public_url", "open_browser"},
    "data": {"roots", "catalog", "genome", "gtf", "fasta"},
    "state": {"dir"},
    "auth": {"mode", "users_file", "session_hours", "secure_cookies", "proxy_header", "trusted_proxies",
             "admins", "allowed_users", "user", "access_token", "max_failed_logins", "lockout_minutes"},
    "jobs": {"enabled", "max_cores_total", "max_cores_per_user", "max_concurrent_per_user", "max_concurrent_total",
             "dir"},
    "limits": {"upload_max_mb", "max_span_bp", "max_reads", "max_working_reads", "max_users"}
              | set(_public_limit_names()),
    "public_catalog": {"enabled", "catalog"},
    "copilot": {"enabled"},
}
_HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def _section(raw: dict, name: str) -> dict:
    value = raw.get(name, {})
    if not isinstance(value, dict):
        raise ConfigError(f"[{name}] must be a table (a [{name}] section).")
    unknown = set(value) - _KNOWN[name]
    if unknown:
        raise ConfigError(f"Unknown key(s) in [{name}]: {', '.join(sorted(unknown))}. "
                          f"Known: {', '.join(sorted(_KNOWN[name]))}.")
    return value


def _typed(section: str, key: str, value: Any, kind, *, minimum: Optional[float] = None):
    if kind is bool:
        if not isinstance(value, bool):
            raise ConfigError(f"{section}.{key} must be true or false.")
        return value
    if kind is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"{section}.{key} must be a whole number.")
    elif kind is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"{section}.{key} must be a number.")
        value = float(value)
    elif kind is str:
        if not isinstance(value, str):
            raise ConfigError(f"{section}.{key} must be a string.")
    elif kind is list:
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError(f"{section}.{key} must be a list of strings.")
    if minimum is not None and value < minimum:
        raise ConfigError(f"{section}.{key} must be at least {minimum:g}.")
    return value


def normalize_root_path(value: str) -> str:
    """``/rnode/host/8000/`` -> ``/rnode/host/8000``; ``""`` and ``/`` -> ``""``."""
    value = (value or "").strip()
    if not value or value == "/":
        return ""
    if "://" in value or "?" in value or "#" in value or "\\" in value:
        raise ConfigError(f"server.root_path must be a URL path such as /rnode/host/8000, not {value!r}.")
    if not value.startswith("/"):
        value = "/" + value
    value = re.sub(r"/{2,}", "/", value).rstrip("/")
    if any(part in (".", "..") for part in value.split("/")):
        raise ConfigError("server.root_path must not contain . or .. segments.")
    return value


def _resolve(base: Path, value: str) -> str:
    """A path from the file: ~ expanded, relative to the config file's folder."""
    path = Path(os.path.expandvars(os.path.expanduser(value)))
    if not path.is_absolute():
        path = base / path
    return os.path.abspath(str(path))


def parse_config(raw: dict, *, base_dir: Optional[str] = None, source: str = "") -> ServerConfig:
    """Validate a parsed TOML document into a ServerConfig (raises ConfigError)."""
    if not isinstance(raw, dict):
        raise ConfigError("The configuration must be a TOML document.")
    unknown = set(raw) - _KNOWN_TOP
    if unknown:
        raise ConfigError(f"Unknown top-level key(s): {', '.join(sorted(unknown))}. "
                          f"Known: {', '.join(sorted(_KNOWN_TOP))}.")
    base = Path(base_dir or os.getcwd())
    cfg = ServerConfig(source=source)
    profile = raw.get("profile", "personal")
    if profile not in PROFILES:
        raise ConfigError(f"profile must be one of {', '.join(PROFILES)} (got {profile!r}).")
    cfg.profile = profile

    srv = _section(raw, "server")
    if "host" in srv:
        cfg.host = _typed("server", "host", srv["host"], str)
    if "port" in srv:
        port = _typed("server", "port", srv["port"], int, minimum=0)
        if port > 65535:
            raise ConfigError("server.port must be 0-65535.")
        cfg.port = port
    cfg.root_path = normalize_root_path(_typed("server", "root_path", srv.get("root_path", ""), str))
    cfg.public_url = _typed("server", "public_url", srv.get("public_url", ""), str).rstrip("/")
    if cfg.public_url and not re.match(r"^https?://[^/]+", cfg.public_url):
        raise ConfigError("server.public_url must be an http(s) URL such as https://fiberbrowser.lab.example.org.")
    if "open_browser" in srv:
        cfg.open_browser = _typed("server", "open_browser", srv["open_browser"], bool)

    data = _section(raw, "data")
    roots = data.get("roots", [])
    if not isinstance(roots, list):
        raise ConfigError("data.roots must be a list: [[data.roots]] tables, or a list of paths.")
    for index, entry in enumerate(roots):
        if isinstance(entry, str):
            entry = {"path": entry}
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"].strip():
            raise ConfigError(f"data.roots[{index}] needs a path.")
        extra = set(entry) - {"path", "label", "writable"}
        if extra:
            raise ConfigError(f"data.roots[{index}]: unknown key(s) {', '.join(sorted(extra))} "
                              "(known: path, label, writable).")
        path = _resolve(base, entry["path"])
        label = _typed(f"data.roots[{index}]", "label", entry.get("label", ""), str) or os.path.basename(path) or path
        writable = _typed(f"data.roots[{index}]", "writable", entry.get("writable", False), bool)
        cfg.data_roots.append(DataRoot(path=path, label=label, writable=writable))
    for key in ("catalog", "genome", "gtf", "fasta"):
        value = _typed("data", key, data.get(key, ""), str)
        if value and key != "genome" and "://" not in value:
            value = _resolve(base, value)
        setattr(cfg, key, value)

    state = _section(raw, "state")
    state_dir = _typed("state", "dir", state.get("dir", ""), str)
    cfg.state_dir = _resolve(base, state_dir) if state_dir else ""

    auth = _section(raw, "auth")
    a = cfg.auth
    if "mode" in auth:
        a.mode = _typed("auth", "mode", auth["mode"], str)
        if a.mode not in AUTH_MODES:
            raise ConfigError(f"auth.mode must be one of {', '.join(AUTH_MODES)} (got {a.mode!r}).")
    if auth.get("users_file"):
        a.users_file = _resolve(base, _typed("auth", "users_file", auth["users_file"], str))
    if "session_hours" in auth:
        a.session_hours = _typed("auth", "session_hours", auth["session_hours"], float, minimum=0.05)
    if "secure_cookies" in auth:
        value = auth["secure_cookies"]
        if isinstance(value, bool):
            value = "always" if value else "never"
        if value not in ("auto", "always", "never"):
            raise ConfigError("auth.secure_cookies must be auto, always or never.")
        a.secure_cookies = value
    if "proxy_header" in auth:
        a.proxy_header = _typed("auth", "proxy_header", auth["proxy_header"], str)
        if not _HEADER_RE.match(a.proxy_header):
            raise ConfigError("auth.proxy_header must be an HTTP header name such as X-Forwarded-User.")
    if "trusted_proxies" in auth:
        a.trusted_proxies = _typed("auth", "trusted_proxies", auth["trusted_proxies"], list)
        a.trusted_proxies_set = True
    for proxy in a.trusted_proxies:
        try:
            ipaddress.ip_network(proxy, strict=False)
        except ValueError as exc:
            raise ConfigError(f"auth.trusted_proxies: {proxy!r} is not an IP address or network "
                              "(host names are not accepted: they can be spoofed).") from exc
    for key in ("admins", "allowed_users"):
        if key in auth:
            setattr(a, key, _typed("auth", key, auth[key], list))
    if "user" in auth:
        a.user = _typed("auth", "user", auth["user"], str)
    if "access_token" in auth:
        a.access_token = _typed("auth", "access_token", auth["access_token"], bool)
    if "max_failed_logins" in auth:
        a.max_failed_logins = _typed("auth", "max_failed_logins", auth["max_failed_logins"], int, minimum=1)
    if "lockout_minutes" in auth:
        a.lockout_minutes = _typed("auth", "lockout_minutes", auth["lockout_minutes"], float, minimum=0)

    jobs = _section(raw, "jobs")
    j = cfg.jobs
    if "enabled" in jobs:
        j.enabled = _typed("jobs", "enabled", jobs["enabled"], bool)
    for key in ("max_cores_total", "max_cores_per_user"):
        if key in jobs:
            setattr(j, key, _typed("jobs", key, jobs[key], int, minimum=0))
    for key in ("max_concurrent_per_user", "max_concurrent_total"):
        if key in jobs:
            setattr(j, key, _typed("jobs", key, jobs[key], int, minimum=1))
    if jobs.get("dir"):
        j.dir = _resolve(base, _typed("jobs", "dir", jobs["dir"], str))

    limits = _section(raw, "limits")
    for key in ("upload_max_mb", "max_span_bp", "max_reads", "max_working_reads"):
        if key in limits:
            setattr(cfg.limits, key, _typed("limits", key, limits[key], int, minimum=0))
    if "max_users" in limits:
        cfg.limits.max_users = _typed("limits", "max_users", limits["max_users"], int, minimum=1)
    lab_keys = {"upload_max_mb", "max_span_bp", "max_reads", "max_working_reads", "max_users"}
    for key in sorted(set(limits) - lab_keys):
        cfg.limits.public[key] = _typed("limits", key, limits[key], int, minimum=0)

    catalog = _section(raw, "public_catalog")
    if "enabled" in catalog:
        cfg.public_catalog.enabled = _typed("public_catalog", "enabled", catalog["enabled"], bool)
    if catalog.get("catalog"):
        cfg.public_catalog.catalog = _resolve(base, _typed("public_catalog", "catalog", catalog["catalog"], str))

    copilot = _section(raw, "copilot")
    if "enabled" in copilot:
        cfg.copilot = _typed("copilot", "enabled", copilot["enabled"], bool)

    validate(cfg)
    return cfg


def validate(cfg: ServerConfig) -> None:
    """Cross-key checks (a profile's required keys)."""
    if cfg.profile != "lab":
        lab_only = []
        if cfg.state_dir:
            lab_only.append("state.dir")
        if cfg.public_catalog.enabled:
            lab_only.append("public_catalog")
        if cfg.jobs.enabled and cfg.profile == "public":
            lab_only.append("jobs")
        if lab_only:
            raise ConfigError(f"{', '.join(lab_only)} only apply to profile = \"lab\" "
                              f"(this file says profile = \"{cfg.profile}\").")
        if cfg.limits.public and cfg.profile != "public":
            raise ConfigError(f"[limits] {', '.join(sorted(cfg.limits.public))} only apply to profile = \"public\".")
        if cfg.profile == "public" and cfg.data_roots:
            raise ConfigError("A public server serves its catalog only: use data.catalog, not data.roots.")
        return
    if cfg.limits.public:
        raise ConfigError(f"[limits] {', '.join(sorted(cfg.limits.public))} only apply to profile = \"public\" "
                          "(a lab server's anonymous visitors get the public defaults).")
    if not cfg.data_roots:
        raise ConfigError("A lab server needs at least one data root: add a [[data.roots]] table with a path "
                          "(the folder members may browse; add writable = true where runs may write).")
    if not cfg.state_dir:
        raise ConfigError("A lab server needs [state] dir = \"...\": the shared folder for the Library, runs, "
                          "saved sessions, uploads, accounts and the audit log.")
    for root in cfg.data_roots:
        if root.real == os.path.realpath("/"):
            raise ConfigError(f"data root {root.path} is too broad for a shared server; point it at the lab's data folder.")
    if cfg.public_catalog.enabled and not (cfg.public_catalog.catalog or cfg.catalog):
        raise ConfigError("public_catalog.enabled needs a catalog: public_catalog.catalog = \"catalog.json\".")
    if cfg.jobs.enabled and not cfg.writable_roots():
        raise ConfigError("jobs.enabled needs a writable data root (writable = true) for the runs' output.")
    if cfg.jobs.max_cores_per_user and cfg.jobs.max_cores_total and cfg.jobs.max_cores_per_user > cfg.jobs.max_cores_total:
        raise ConfigError("jobs.max_cores_per_user cannot exceed jobs.max_cores_total.")
    if cfg.auth.mode == "proxy" and not cfg.auth.trusted_proxies:
        raise ConfigError("auth.mode = \"proxy\" needs auth.trusted_proxies: the proxy's IP address(es).")


def load_config(path: str) -> ServerConfig:
    """Read and validate a configuration file."""
    file = Path(path).expanduser()
    try:
        raw = _toml.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"Configuration file not found: {file}") from exc
    except _toml.TOMLDecodeError as exc:
        raise ConfigError(f"{file} is not valid TOML: {exc}") from exc
    return parse_config(raw, base_dir=str(file.resolve().parent), source=str(file.resolve()))


# ---------------------------------------------------------------------------
# Applying a config to a launch
# ---------------------------------------------------------------------------

def _flag_given(argv: list[str], *names: str) -> bool:
    return any(a == n or a.startswith(n + "=") for a in argv for n in names)


def apply_to_args(cfg: ServerConfig, args, argv: list[str]) -> None:
    """Fill the parsed CLI namespace from the file; flags given on the command line win."""
    if cfg.host is not None and not _flag_given(argv, "--host"):
        args.host = cfg.host
    if cfg.port is not None and not _flag_given(argv, "--port", "-p"):
        args.port = cfg.port
    if cfg.root_path and not _flag_given(argv, "--root-path"):
        args.root_path = cfg.root_path
    if cfg.open_browser is not None and not _flag_given(argv, "--open-browser", "--no-open-browser", "--no-open"):
        args.open_browser = cfg.open_browser
    if cfg.profile == "public":
        args.public = True
    elif cfg.profile == "lab" and getattr(args, "public", False):
        raise ConfigError("--public conflicts with profile = \"lab\" (use public_catalog for anonymous visitors).")
    catalog = cfg.catalog or (cfg.public_catalog.catalog if cfg.is_lab else "")
    if catalog and not getattr(args, "catalog", None):
        args.catalog = catalog
    if cfg.gtf and not getattr(args, "gtf", None):
        args.gtf = cfg.gtf
    if cfg.fasta and not getattr(args, "fasta", None):
        args.fasta = cfg.fasta
    if cfg.limits.max_working_reads and not _flag_given(argv, "--max-working-reads"):
        args.max_working_reads = cfg.limits.max_working_reads
    if cfg.profile == "public":
        if cfg.limits.max_span_bp and getattr(args, "public_max_span_bp", None) is None:
            args.public_max_span_bp = cfg.limits.max_span_bp
        if cfg.limits.max_reads and getattr(args, "public_max_reads", None) is None:
            args.public_max_reads = cfg.limits.max_reads
        for key, value in cfg.limits.public.items():
            if getattr(args, f"public_{key}", None) is None:
                setattr(args, f"public_{key}", value)
    # One list of trusted reverse proxies (services/public_protection.py): the
    # file's auth.trusted_proxies (a lab server's default included) joins
    # --trusted-proxy.
    if cfg.is_lab or cfg.auth.trusted_proxies_set:
        args.trusted_proxy = list(getattr(args, "trusted_proxy", None) or []) + list(cfg.auth.trusted_proxies)
    # Copilot: a local LLM is the host's own compute, off on servers unless asked.
    if not _flag_given(argv, "--copilot"):
        if cfg.copilot is False or (cfg.copilot is None and cfg.profile != "personal"):
            args.copilot = "off"
    if cfg.profile != "personal" and not _flag_given(argv, "--open-browser", "--no-open-browser", "--no-open") \
            and cfg.open_browser is None:
        args.open_browser = False


def state_environment(cfg: ServerConfig) -> dict[str, str]:
    """Environment the shared stores read their locations from (lab profile)."""
    if not cfg.is_lab:
        return {}
    env = {
        "FIBERBROWSER_LIBRARY": cfg.library_file,
        "FIBERBROWSER_JOBS_DIR": cfg.jobs_dir,
        "FIBERBROWSER_UPLOAD_DIR": cfg.uploads_dir,
    }
    if cfg.jobs.max_cores_total:
        env["FIBERBROWSER_PIPELINE_CORES"] = str(cfg.jobs.max_cores_total)
    return env


def prepare_state_dir(cfg: ServerConfig) -> None:
    """Create the shared state folder and its subfolders (group-shared, no world access)."""
    if not cfg.is_lab:
        return
    for folder in (cfg.state_dir, cfg.jobs_dir, cfg.sessions_dir, cfg.uploads_dir):
        os.makedirs(folder, exist_ok=True)
        try:
            os.chmod(folder, 0o2770)
        except OSError:
            pass  # not ours (a lab-managed folder): keep its permissions


def describe(cfg: ServerConfig) -> list[str]:
    """Human-readable summary lines for the startup banner."""
    lines = [f"Config: {cfg.source or '(inline)'} (profile {cfg.profile})"]
    if cfg.root_path:
        lines.append(f"Root path: {cfg.root_path}/")
    if cfg.is_lab:
        auth = cfg.auth.mode + (" + access token" if cfg.auth.mode == "none" and cfg.auth.access_token is not False else "")
        lines.append(f"Auth: {auth}")
        for root in cfg.data_roots:
            lines.append(f"Data root: {root.path} ({'writable' if root.writable else 'read-only'})")
        lines.append(f"Shared state: {cfg.state_dir}")
        lines.append(f"Jobs: {'on' if cfg.jobs.enabled else 'off'}"
                     + (f" (per user {cfg.jobs.max_concurrent_per_user} at once)" if cfg.jobs.enabled else ""))
        if cfg.public_catalog.enabled:
            lines.append("Public catalog: anonymous visitors may browse it read-only")
    return lines
