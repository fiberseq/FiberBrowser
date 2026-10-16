"""Open a set of remote files from a link: stage -> preview -> confirm -> open.

Another web page (a portal, a sample dashboard) links to FiberBrowser with a
session document (``?session=<URL>`` or inline ``?session=data:...``) or a
UCSC-style track hub (``?hub=<hub.txt URL>``). Nothing is loaded until the
user confirms:

1. **stage** — the link's raw value is stored as a *pending link* with a
   random, short-lived, single-use id. Nothing is fetched. This is the only
   step a page without the access token can reach (``GET /open``, the landing
   page of a local server), because a link from another site arrives without
   the SameSite=Strict token cookie.
2. **preview** — in an authenticated tab, the dialog first shows only what
   the link itself says (the kind of link and its host); nothing is fetched,
   not even a DNS lookup, until the user chooses "Review the link". Then the
   document (or hub) is fetched under the server's link policy and validated,
   and the dialog shows the source host, genome, locus and tracks. The track
   files are never touched at this point. An inline document (the list is in
   the link) is previewed at once, as there is nothing to fetch.
3. **open** — on confirmation, the previewed document (not a new fetch) is
   applied: the pending id is consumed first, so it can't be replayed.

Public servers accept links only from the hosts the operator lists in
``FIBERBROWSER_LINK_HOSTS`` (https only, public addresses only, no s3://);
with no list, links are off. Tour tabs never open links.
"""
from __future__ import annotations

import os
import re
import secrets
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional

from services import signed_urls
from services.link_fetch import (
    LinkError, LinkPolicy, check_url, fetch, needs_pinned_transport, policy_for_server, probe_status,
)
from services.session_link_format import (
    SessionLinkError,
    decode_inline,
    is_inline,
    normalize_session,
    parse_json_text,
)

PENDING_TTL_S = 15 * 60
MAX_PENDING = 64
MAX_RAW_CHARS = 512 * 1024
MAX_DOCUMENT_BYTES = 1024 * 1024
MAX_HUB_FILE_BYTES = 2 * 1024 * 1024
MAX_SMALL_FILE_BYTES = 20 * 1024 * 1024  # BED files and plasmid maps are downloaded
DEFAULT_MAX_TRACKS_LOCAL = 100
DEFAULT_MAX_TRACKS_PUBLIC = 20
MAX_TRACKS_ENV = "FIBERBROWSER_LINK_MAX_TRACKS"
DISABLE_ENV = "FIBERBROWSER_LINKS_DISABLE"
KINDS = ("session", "hub")


class PendingLinkError(Exception):
    def __init__(self, message: str, status: int = 400, body: Optional[dict] = None):
        super().__init__(message)
        self.status = status
        self.body = body  # extra fields for the response (e.g. the preview's id and source)


@dataclass
class PendingLink:
    id: str
    kind: str
    raw: str
    genome: Optional[str]
    created: float
    expires: float
    origin: str = "link"
    session: Optional[dict] = None  # the validated document the preview showed
    fetch_confirmed: bool = False
    info: dict = field(default_factory=dict)


_pending: "OrderedDict[str, PendingLink]" = OrderedDict()
_lock = threading.Lock()


# ---------------------------------------------------------------------------- policy

def shared_server() -> bool:
    """A server others use (--public, or the lab profile): public link rules."""
    from services.runtime import get_host_public_mode, get_lab_mode
    return bool(get_host_public_mode() or get_lab_mode())


def links_enabled() -> tuple[bool, Optional[str]]:
    from services.runtime import current_sandbox_id
    if os.environ.get(DISABLE_ENV):
        return False, "Opening links is turned off on this server."
    if current_sandbox_id() is not None:
        return False, "Links can't be opened in a tour tab."
    if shared_server() and not policy_for_server(public=True).allowed_hosts:
        return False, ("Opening links is turned off on this shared server (the operator allows "
                       "no link hosts).")
    return True, None


def current_policy() -> LinkPolicy:
    return policy_for_server(public=shared_server())


def max_tracks(policy: Optional[LinkPolicy] = None) -> int:
    policy = policy or current_policy()
    default = DEFAULT_MAX_TRACKS_PUBLIC if policy.public else DEFAULT_MAX_TRACKS_LOCAL
    try:
        configured = int(os.environ.get(MAX_TRACKS_ENV, "") or default)
    except ValueError:
        configured = default
    return max(1, min(configured, 1000))


# ---------------------------------------------------------------------------- pending store

def _expire_locked(now: float) -> None:
    for key in [k for k, p in _pending.items() if p.expires <= now]:
        _pending.pop(key, None)


def stage(kind: str, raw: str, *, genome: Optional[str] = None, origin: str = "link") -> PendingLink:
    """Remember a link's raw value (nothing fetched). Returns the pending link."""
    if kind not in KINDS:
        raise PendingLinkError("A link names a session (?session=) or a track hub (?hub=).")
    raw = (raw or "").strip()
    if not raw:
        raise PendingLinkError("The link names no session or hub.")
    if len(raw) > MAX_RAW_CHARS:
        raise PendingLinkError("The link is too long; host the session as a JSON file and link to that.")
    if kind == "hub" and "://" not in raw:
        raise PendingLinkError("?hub= needs the URL of a hub.txt file.")
    if genome is not None and not re.fullmatch(r"[A-Za-z0-9_.\-]{1,64}", genome):
        genome = None
    now = time.time()
    link = PendingLink(id=secrets.token_urlsafe(18), kind=kind, raw=raw, genome=genome,
                       created=now, expires=now + PENDING_TTL_S, origin=origin)
    with _lock:
        _expire_locked(now)
        while len(_pending) >= MAX_PENDING:
            _pending.popitem(last=False)
        _pending[link.id] = link
    return link


def get_pending(link_id: str) -> PendingLink:
    with _lock:
        _expire_locked(time.time())
        link = _pending.get(link_id or "")
    if link is None:
        raise PendingLinkError("This link has expired or was already opened. Open it again from its source.",
                               status=404)
    return link


def discard(link_id: str) -> bool:
    with _lock:
        return _pending.pop(link_id or "", None) is not None


def _consume(link_id: str) -> PendingLink:
    with _lock:
        _expire_locked(time.time())
        link = _pending.pop(link_id or "", None)
    if link is None:
        raise PendingLinkError("This link has expired or was already opened. Open it again from its source.",
                               status=404)
    return link


def clear_pending() -> None:
    with _lock:
        _pending.clear()


def source_description(link: PendingLink) -> dict:
    if link.kind == "session" and is_inline(link.raw):
        return {"kind": "inline", "host": None, "url": None}
    return {"kind": link.kind, "host": signed_urls.host_of(link.raw), "url": signed_urls.display_url(link.raw)}


# ---------------------------------------------------------------------------- preview

def _fetch_text(url: str, policy: LinkPolicy, *, max_bytes: int, what: str) -> tuple[str, str]:
    """(text, the URL it was read from after redirects: the base for its relative names)."""
    result = fetch(url, policy, max_bytes=max_bytes, what=what)
    try:
        return result.body.decode("utf-8-sig"), (result.url or url)
    except UnicodeDecodeError as exc:
        raise LinkError(f"{signed_urls.display_url(url)} is not a text file.") from exc


def needs_fetch_confirmation(link: PendingLink, policy: LinkPolicy) -> Optional[str]:
    """Why the document needs the user's go-ahead before it is fetched (None: already given).

    Every hosted document (session JSON or hub) waits for it, on local and
    public servers alike: before the user confirms, FiberBrowser contacts
    nothing (no fetch, no DNS lookup). Only an inline document, which is in
    the link itself, is previewed at once."""
    if link.kind == "session" and is_inline(link.raw):
        return None
    if link.fetch_confirmed:
        return None
    what = "track hub" if link.kind == "hub" else "list of files"
    reason = f"FiberBrowser reads the {what} from {signed_urls.host_of(link.raw) or 'that address'} only after you confirm."
    if link.raw.lower().startswith("http://"):
        reason += " The address uses plain http (not encrypted)."
    return reason


def _load_document(link: PendingLink, policy: LinkPolicy, state=None) -> dict:
    from services.track_hub import import_hub

    fetch_policy = policy  # only reached once the user confirmed the fetch (needs_fetch_confirmation)
    if link.kind == "hub":
        state_genome = getattr(state, "current_genome", None) if state is not None else None
        doc = import_hub(
            link.raw,
            lambda url: _fetch_text(url, fetch_policy, max_bytes=MAX_HUB_FILE_BYTES, what="hub file"),
            genome=link.genome, current_genome=state_genome)
        link.info["hub"] = doc.pop("hub", {})
        return normalize_session(doc, base_url=link.raw)  # hub track URLs are already absolute
    if is_inline(link.raw):
        return normalize_session(parse_json_text(decode_inline(link.raw)))
    text, final_url = _fetch_text(link.raw, fetch_policy, max_bytes=MAX_DOCUMENT_BYTES, what="session link")
    if final_url != link.raw:
        link.info["final_url"] = final_url
    # Relative names resolve against where the document was read, after redirects.
    return normalize_session(parse_json_text(text), base_url=final_url)


def track_problem(track: dict, policy: LinkPolicy) -> Optional[str]:
    """Why this track can't be opened here (None: it can)."""
    if track.get("cluster"):
        return _cluster_problem(track, policy)
    for key, what in (("url", "track URL"), ("index_url", "index URL")):
        if track.get(key):
            try:
                check_url(track[key], policy, what=what)
            except LinkError as exc:
                return str(exc)
    if policy.public and track["type"] in ("plasmid",):
        return "Plasmid maps can't be opened from a link on a public server."
    return None


def _cluster_problem(track: dict, policy: LinkPolicy) -> Optional[str]:
    """ssh:// files open only when the user has connected to that cluster themselves."""
    if policy.public:
        return "Files on a cluster can't be opened on this server."
    try:
        from services.remote_sources import source_for_ref
        source = source_for_ref(track["url"])
        connected = bool(source is not None and source.is_connected(track["url"]))
    except Exception:
        connected = False
    if connected:
        return None
    return (f"On the cluster {track['cluster']}: FiberBrowser never connects from a link. "
            "Connect to it yourself (Connect to cluster…), then review the link again.")


def preview(link_id: str, *, fetch_confirmed: bool = False, state=None) -> dict:
    enabled, reason = links_enabled()
    if not enabled:
        raise PendingLinkError(reason or "Opening links is turned off.", status=403)
    link = get_pending(link_id)
    policy = current_policy()
    if fetch_confirmed:
        link.fetch_confirmed = True
    base = {"id": link.id, "source": source_description(link), "expires_in": max(0, int(link.expires - time.time()))}
    if link.kind != "session" or not is_inline(link.raw):
        try:
            check_url(link.raw, policy, what="link")
        except LinkError as exc:
            raise PendingLinkError(str(exc), status=403)
    if link.session is None:
        question = needs_fetch_confirmation(link, policy)
        if question:
            return {**base, "success": True, "needs_fetch_confirmation": True, "reason": question}
        try:
            link.session = _load_document(link, policy, state)
        except SessionLinkError as exc:  # the document itself is invalid
            raise PendingLinkError(str(exc), status=400, body=base) from exc
        except LinkError as exc:  # it can't be fetched under this server's link rules
            raise PendingLinkError(str(exc), status=422, body=base) from exc
    session = link.session
    limit = max_tracks(policy)
    tracks = []
    for track in session["tracks"]:
        problem = track_problem(track, policy)
        tracks.append({
            "index": track["index"], "name": track["name"], "type": track["type"], "as": track["as"],
            "host": track["host"], "url": track["display_url"], "size": track["size"],
            "sample": track["sample"], "group": track["group"], "color": track["color"],
            "visible": track["visible"] and problem is None, "signed": track["signed"],
            "problem": problem, "cluster": track.get("cluster"),
        })
    hosts = sorted({t["host"] for t in tracks if t["host"]})
    warnings = list(session.get("warnings") or [])
    if any(t["signed"] for t in session["tracks"]):
        warnings.append("Some files use pre-signed links: they work only until the link expires, and "
                        "are never saved with the session (reopen the link from its source later).")
    if any(t["url"].startswith("http://") for t in session["tracks"]) or link.raw.startswith("http://"):
        warnings.append("Some addresses use plain http (not encrypted).")
    genome = session.get("genome")
    genome_note = _genome_note(genome, state, policy)
    if genome_note:
        warnings.append(genome_note)
    genome = _genome_for_display(genome, policy)
    final_url = link.info.get("final_url")
    if final_url and signed_urls.host_of(final_url) != signed_urls.host_of(link.raw):
        warnings.append(f"The link redirected to {signed_urls.host_of(final_url)}; its files are read from there.")
    hub = link.info.get("hub") or {}
    if hub.get("skipped"):
        warnings.append(f"{len(hub['skipped'])} hub entries can't be shown and are left out.")
    return {
        **base,
        "success": True,
        "title": session.get("title"),
        "genome": genome,
        "locus": session.get("locus"),
        "tracks": tracks,
        "hosts": hosts,
        "warnings": warnings,
        "max_tracks": limit,
        "public": policy.public,
        "hub": hub or None,
    }


def genome_problem(genome: Optional[dict], policy: LinkPolicy) -> Optional[str]:
    """Why a FASTA reference named by a link can't be loaded here (None: it can)."""
    if not genome or genome.get("kind") != "fasta":
        return None
    if policy.public:
        return "A FASTA reference can't be loaded from a link on a public server."
    for key, what in (("url", "reference FASTA URL"), ("fai", "reference index URL")):
        if genome.get(key):
            try:
                check_url(genome[key], policy, what=what)
            except LinkError as exc:
                return str(exc)
    return None


def _genome_for_display(genome: Optional[dict], policy: LinkPolicy) -> Optional[dict]:
    """The genome as the preview shows it: reference URLs in their display form
    (a pre-signed query is a credential and never leaves the server)."""
    if not genome or genome.get("kind") != "fasta":
        return genome
    url, fai = genome.get("url"), genome.get("fai")
    return {**genome, "url": signed_urls.display_url(url), "fai": signed_urls.display_url(fai) if fai else None,
            "signed": bool(signed_urls.looks_signed(url) or (fai and signed_urls.looks_signed(fai))),
            "problem": genome_problem(genome, policy)}


def _genome_note(genome: Optional[dict], state, policy: LinkPolicy) -> Optional[str]:
    if not genome:
        return None
    current = getattr(state, "current_genome", None) if state is not None else None
    if genome.get("kind") == "catalog" and current and current != genome.get("id"):
        if policy.public:
            return f"This server shows {current}; the link's genome ({genome['id']}) can't be loaded here."
        return f"Opening replaces the current genome ({current}) with {genome['id']}."
    if genome.get("kind") == "fasta":
        if policy.public:
            return "A FASTA reference can't be loaded from a link on a public server; the current genome is kept."
        problem = genome_problem(genome, policy)
        if problem:
            return f"The reference FASTA can't be loaded ({problem}); the current genome is kept."
        return "The reference FASTA is downloaded to this computer's genome cache."
    return None


# ---------------------------------------------------------------------------- open

def _unique_dataset_id(state, base: str) -> str:
    from services.dataset_registration import dataset_id_from_source
    stem = "link_" + dataset_id_from_source(base, fallback="dataset")
    candidate, n = stem, 2
    while candidate in state.datasets:
        candidate, n = f"{stem}_{n}", n + 1
    return candidate


def _bigbed_is_reads(url: str) -> bool:
    """A bigBed of per-read records (FiberHMM layers, fibertools/FIRE per-fiber
    bigBeds), opened as a dataset of reads."""
    try:
        from services.bigbed_detection import detect_bigbed_autosql_type, detect_fire_bigbed_kind
        return (detect_bigbed_autosql_type(url) is not None
                or detect_fire_bigbed_kind(url) in ("fibers", "decorators"))
    except Exception:
        return False


def _download(url: str, policy: LinkPolicy, suffix: str, name: str) -> str:
    """A small remote file (BED, plasmid map) into a private temp folder; its path."""
    if url.startswith("s3://"):
        raise LinkError("BED files and plasmid maps must be https URLs.")
    result = fetch(url, policy, max_bytes=MAX_SMALL_FILE_BYTES, what="file")
    folder = tempfile.mkdtemp(prefix="fiberbrowser-link-")
    safe = re.sub(r"[^A-Za-z0-9_.\-]+", "_", name).strip("._") or "file"
    if not safe.lower().endswith(suffix):
        safe += suffix
    path = os.path.join(folder, safe)
    with open(path, "wb") as handle:
        handle.write(result.body)
    return path


MAX_INDEX_BYTES = 512 * 1024 * 1024
_index_dir: Optional[str] = None


def _local_bam_index(track: dict, policy: LinkPolicy) -> str:
    """The BAM's index (index_url, else <bam>.bai / <stem>.bai / <bam>.csi next to it),
    downloaded into this process's private folder; its path."""
    global _index_dir
    url = track["url"]
    if track.get("index_url"):
        candidates = [track["index_url"]]
    else:
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(url)
        stem = parts.path[:-4] if parts.path.lower().endswith(".bam") else parts.path
        candidates = [urlunsplit(parts._replace(path=p)) for p in (parts.path + ".bai", stem + ".bai", parts.path + ".csi")]
    last: Optional[Exception] = None
    for candidate in candidates:
        try:
            result = fetch(candidate, policy, max_bytes=MAX_INDEX_BYTES, what="BAM index")
        except LinkError as exc:
            last = exc
            continue
        if _index_dir is None:
            _index_dir = tempfile.mkdtemp(prefix="fiberbrowser-link-index-")
            import atexit
            import shutil
            atexit.register(shutil.rmtree, _index_dir, True)
        suffix = ".csi" if signed_urls.display_url(candidate).lower().endswith(".csi") else ".bai"
        path = os.path.join(_index_dir, secrets.token_hex(8) + suffix)
        with open(path, "wb") as handle:
            handle.write(result.body)
        return path
    raise LinkError(f"no BAM index found ({last})" if last else "no BAM index found")


def _probe(url: str, policy: LinkPolicy) -> Optional[int]:
    """HTTP status of a one-byte read of a link's file, under the link policy
    (the pinned transport where the policy needs it; LinkError when it refuses)."""
    if needs_pinned_transport(policy):
        return probe_status(url, policy)
    return signed_urls.probe_status(url)


def _failure(track: dict, exc: Exception, policy: LinkPolicy) -> str:
    message = signed_urls.redact_text(str(exc)) or type(exc).__name__
    hint = None
    if not isinstance(exc, LinkError) and track["url"].startswith(("http://", "https://")):
        try:
            code = _probe(track["url"], policy)
        except LinkError:
            code = None
        if code in (401, 403):
            if track["signed"]:
                signed_urls.mark_expired(track["display_url"])
                hint = signed_urls.expired_message(track["display_url"])
            else:
                hint = (f"{track['display_url']}: access denied (HTTP {code}). If this came from a pre-signed "
                        "or session link, the link has expired: reopen it from the source.")
    return f"{track['name']}: {hint or message}"


def _apply_genome(state, genome: Optional[dict], policy: LinkPolicy, result: dict) -> None:
    if not genome:
        return
    current = getattr(state, "current_genome", None)
    if genome["kind"] == "catalog":
        if current == genome["id"] and getattr(state, "fasta", None) is not None:
            result["genome"] = {"kind": "catalog", "id": genome["id"], "loaded": False, "has_fasta": True}
            return
        if policy.public:
            result["warnings"].append(f"The link's genome ({genome['id']}) isn't this server's; kept {current}.")
            return
        from services.genome_loading import load_genome_blocking
        from services.genome_registry import GENOME_REGISTRY
        from services.runtime import allow_shared_writes
        with allow_shared_writes():
            loaded = load_genome_blocking(state, genome["id"], GENOME_REGISTRY[genome["id"]])
        if not loaded.get("success"):
            result["errors"].append(f"Genome {genome['id']}: "
                                    f"{loaded.get('fasta_error') or loaded.get('error') or 'could not load'}")
            return
        result["genome"] = {"kind": "catalog", "id": genome["id"], "loaded": True,
                            "has_fasta": bool(loaded.get("fasta_loaded", getattr(state, "fasta", None) is not None)),
                            "load": loaded}
        return
    if policy.public:
        result["warnings"].append("A FASTA reference can't be loaded from a link on a public server.")
        return
    problem = genome_problem(genome, policy)
    if problem:  # the same host, scheme and allowlist rules as the tracks
        result["errors"].append(f"Reference {genome.get('label')}: {problem}")
        return
    # Downloaded by the reference loader: through the pinned relay where the
    # policy needs it (a relayed FASTA's derived .fai is relayed too).
    try:
        opened, opened_fai = _transport(genome["url"], policy), (
            _transport(genome["fai"], policy) if genome.get("fai") else None)
    except LinkError as exc:
        result["errors"].append(f"Reference {genome.get('label')}: {exc}")
        return
    real = signed_urls.register(genome["url"], label=genome.get("label"), open_url=opened)
    fai = signed_urls.register(genome["fai"], open_url=opened_fai) if genome.get("fai") else None
    from services.genome_loading import reference_lock
    with reference_lock(state):
        error = state._load_fasta(real, fai_url=fai)
        if not error:
            state.fasta_error = None
            state.reference_pairs = None
    if error:
        result["errors"].append(f"Reference {genome.get('label')}: {signed_urls.redact_text(error)}")
        return
    result["genome"] = {"kind": "fasta", "label": genome.get("label"), "url": signed_urls.display_url(genome["url"]),
                        "loaded": True, "has_fasta": True, "inferred_genome": getattr(state, "current_genome", None)}


def open_link(state, link_id: str, *, selected: Optional[list[int]] = None) -> dict:
    """Apply a previewed link to ``state`` (the id is consumed first). A link opens into the whole workspace:
    a panel genome's view resolves to its base state (lock hierarchy: services/genome_loading)."""
    from services.sessions_endpoint import workspace_state
    state = workspace_state(state)
    enabled, reason = links_enabled()
    if not enabled:
        raise PendingLinkError(reason or "Opening links is turned off.", status=403)
    link = get_pending(link_id)
    if link.session is None:
        raise PendingLinkError("Review the link before opening it.", status=409)
    link = _consume(link_id)
    session = link.session
    policy = current_policy()
    tracks = session["tracks"]
    if selected is None:
        chosen = [t for t in tracks if t["visible"]]
    else:
        wanted = {int(i) for i in selected}
        chosen = [t for t in tracks if t["index"] in wanted]
    limit = max_tracks(policy)
    result: dict[str, Any] = {"success": True, "title": session.get("title"), "genome": None,
                              "locus": session.get("locus"), "datasets": [], "tracks": [], "plasmids": [],
                              "errors": [], "warnings": [], "source": source_description(link)}
    if len(chosen) > limit:
        result["warnings"].append(f"Opened the first {limit} of {len(chosen)} selected tracks (this server's limit).")
        chosen = chosen[:limit]

    _apply_genome(state, session.get("genome"), policy, result)

    from services.htslib_quiet import quiet_htslib
    with quiet_htslib():  # htslib would print the full (signed) URL on errors
        for track in chosen:
            problem = track_problem(track, policy)
            if problem:
                result["errors"].append(f"{track['name']}: {problem}")
                continue
            try:
                _open_track(state, track, policy, result)
            except Exception as exc:  # one bad file doesn't stop the rest
                result["errors"].append(_failure(track, exc, policy))

    opened = len(result["datasets"]) + len(result["tracks"]) + len(result["plasmids"])
    result["opened"] = opened
    if opened == 0 and chosen:
        result["success"] = False
    parts = []
    if result["datasets"]:
        parts.append(f"{len(result['datasets'])} dataset{'s' if len(result['datasets']) != 1 else ''}")
    if result["tracks"]:
        parts.append(f"{len(result['tracks'])} track{'s' if len(result['tracks']) != 1 else ''}")
    if result["plasmids"]:
        parts.append(f"{len(result['plasmids'])} plasmid map{'s' if len(result['plasmids']) != 1 else ''}")
    host = result["source"].get("host")
    result["message"] = (f"Opened {' and '.join(parts) or 'nothing'}" + (f" from {host}" if host else "")
                         + (f"; {len(result['errors'])} failed" if result["errors"] else "") + ".")
    return result


def _open_track(state, track: dict, policy: LinkPolicy, result: dict) -> None:
    kind = track["type"]
    display = track["display_url"]
    if track.get("cluster"):
        _open_cluster_track(state, track, result)
        return
    if kind == "bam" and track["url"].startswith(("http://", "https://")) and not track.get("index_url") \
            and track["signed"]:
        raise LinkError("a pre-signed BAM needs its own index_url (the .bai can't be derived from a signed URL)")
    remote = track["url"].startswith(("http://", "https://"))
    # What htslib / pyBigWig open: the pinned relay where the policy needs it
    # (services.link_proxy), so they never resolve or follow redirects themselves.
    opened = _transport(track["url"], policy) if kind in ("bam", "bigbed", "bigwig") else None
    if kind == "bam" and remote:
        # htslib would save a remote index in the server's working folder (and
        # reuse a stale one of the same name later): fetch it into a private one.
        real = signed_urls.register(track["url"], _local_bam_index(track, policy), label=track["name"],
                                    open_url=opened)
    else:
        real = signed_urls.register(track["url"], track.get("index_url") if kind == "bam" else None,
                                    label=track["name"], open_url=opened)
    if kind in ("bigbed", "bigwig") and remote:
        _fail_fast(track["url"], policy)  # before anything native reads it

    if kind == "plasmid":
        from routers.genome import _load_plasmid_into_state, _reconcile_loaded_maps
        from services.plasmid_maps import parse_plasmid_map
        suffix = "." + display.rsplit(".", 1)[-1].lower() if "." in display.rsplit("/", 1)[-1] else ".gb"
        path = _download(real, policy, suffix, display.rsplit("/", 1)[-1])
        plasmid = parse_plasmid_map(path)
        loaded = _load_plasmid_into_state(state, plasmid, path)
        reconcile = _reconcile_loaded_maps(state, [plasmid.name])
        result["plasmids"].append({"name": loaded.get("name"), "label": track["name"],
                                   "links": reconcile.get("links"), "problems": reconcile.get("problems")})
        return

    if kind == "bed":
        from services.orthogonal_tracks import parse_bed_file
        suffix = ".bed.gz" if display.lower().endswith(".gz") else ".bed"
        path = _download(real, policy, suffix, display.rsplit("/", 1)[-1])
        _check_track_cap(state, policy)
        intervals = parse_bed_file(path)
        track_dict = {"path": display, "label": track["name"], "format": "bed", "render_mode": "annotation",
                      "bed_intervals": intervals, "source_link": True}
        if track["color"]:
            track_dict["color"] = track["color"]
        state.orthogonal_tracks.append(track_dict)
        result["tracks"].append(_track_result(state, track, "bigbed", "annotation"))
        return

    as_reads = kind == "bam" or (kind == "bigbed" and (track["as"] == "reads"
                                                       or (track["as"] is None and _bigbed_is_reads(real))))
    if as_reads:
        dataset_id = _unique_dataset_id(state, display)
        dataset = state.add_dataset(dataset_id, real, label=track["name"])
        if track["color"]:
            dataset.color = track["color"]
        result["datasets"].append(dataset.to_dict())
        return

    _check_track_cap(state, policy)
    import pyBigWig
    from services.pybigwig_support import check_target
    try:
        check_target(real)
    except RuntimeError as exc:
        raise LinkError(str(exc)) from None
    handle = pyBigWig.open(real)
    if handle is None:
        raise LinkError("not a bigWig/bigBed file")
    try:
        is_bigbed = bool(handle.isBigBed())
        handle.chroms()
    finally:
        handle.close()
    if kind == "bigwig" and is_bigbed:
        kind = "bigbed"
    render_mode = "annotation" if is_bigbed else "signal"
    track_dict = {"path": real, "label": track["name"], "format": "bigBed" if is_bigbed else "bigWig",
                  "render_mode": render_mode, "source_link": True}
    if track["color"]:
        track_dict["color"] = track["color"]
    state.orthogonal_tracks.append(track_dict)
    result["tracks"].append(_track_result(state, track, "bigbed" if is_bigbed else "bigwig", render_mode))


def _open_cluster_track(state, track: dict, result: dict) -> None:
    """An ssh:// file on a cluster the user connected to: the usual loaders open it."""
    kind, ref = track["type"], track["url"]
    if kind in ("bed", "plasmid"):
        raise LinkError("BED files and plasmid maps on a cluster can't be opened from a link.")
    if kind == "bam" or (kind == "bigbed" and (track["as"] == "reads"
                                               or (track["as"] is None and _bigbed_is_reads(ref)))):
        dataset = state.add_dataset(_unique_dataset_id(state, ref), ref, label=track["name"])
        if track["color"]:
            dataset.color = track["color"]
        result["datasets"].append(dataset.to_dict())
        return
    from services.tracks_endpoint import add_track_for_request
    added = add_track_for_request(state, path=ref, label=track["name"])
    if not added.get("success"):
        raise LinkError(added.get("message") or "could not open the file")
    index = added["track_index"]
    if track["color"]:
        state.orthogonal_tracks[index]["color"] = track["color"]
    render_mode = added.get("render_mode") or "signal"
    result["tracks"].append({"track_index": index, "label": track["name"], "url": ref,
                             "kind": "bigbed" if render_mode == "annotation" else "bigwig",
                             "render_mode": render_mode, "color": track["color"], "group": track["group"],
                             "sample": track["sample"]})


def _check_track_cap(state, policy: LinkPolicy) -> None:
    """A public server's per-visitor track limit (PublicLimits.session_max_tracks)."""
    if not policy.public:
        return
    from services.public_limits import get_public_limits
    cap = get_public_limits().session_max_tracks
    if len(state.orthogonal_tracks) >= cap:
        raise LinkError(f"at most {cap} tracks on this server; remove one first")


def _fail_fast(url: str, policy: LinkPolicy) -> None:
    """A refused, missing or policy-forbidden remote file fails here, before
    pyBigWig (which can wait forever on an empty error reply, holding the GIL)."""
    if not url.startswith(("http://", "https://")):
        return
    code = _probe(url, policy)
    if code in (401, 403):
        if signed_urls.looks_signed(url) or signed_urls.is_registered(url):
            signed_urls.mark_expired(url)
            raise LinkError(signed_urls.expired_message(url))
        raise LinkError(f"{signed_urls.display_url(url)}: access denied (HTTP {code}). If this came from a "
                        "pre-signed or session link, the link has expired: reopen it from the source.")
    if code == 404:
        raise LinkError(f"{signed_urls.display_url(url)}: not found (HTTP 404).")


def _transport(url: str, policy: LinkPolicy) -> Optional[str]:
    """The relay URL native readers open for ``url`` where the policy needs the
    pinned transport (None: they open ``url`` itself)."""
    from services.link_proxy import RelayError, transport_url
    try:
        opened = transport_url(url, policy)
    except RelayError as exc:
        raise LinkError(str(exc)) from exc
    return opened if opened != url else None


def _track_result(state, track: dict, kind: str, render_mode: str) -> dict:
    return {"track_index": len(state.orthogonal_tracks) - 1, "label": track["name"], "url": track["display_url"],
            "kind": kind, "render_mode": render_mode, "color": track["color"], "group": track["group"],
            "sample": track["sample"]}


def link_status() -> dict:
    """Held pre-signed links (expiry) for the page's warning banner.

    Not on a shared server: the links held there belong to many visitors."""
    if shared_server():
        return {"links": [], "expired": [], "expiring_soon": []}
    items = signed_urls.status()
    for item in items:
        if not item["expired"]:
            item["expired"] = signed_urls.probe_expired(item["url"])
    return {"links": items, "expired": [i for i in items if i["expired"]],
            "expiring_soon": [i for i in items if i["expiring_soon"]]}
