"""Import a UCSC-style track hub (hub.txt -> genomes.txt -> trackDb.txt) as a session link.

Reads the common trackDb settings: ``track``, ``bigDataUrl``,
``bigDataIndex``, ``type``, ``shortLabel``, ``longLabel``, ``color``,
``visibility``, ``parent`` (``parent X [on|off]``), ``compositeTrack on``,
``superTrack on`` (and the older ``superTrack <name> [show|hide]`` child
form), ``container multiWig``, ``view`` subgroups, ``include`` lines and
``useOneFile on`` hubs. Settings are inherited from parents, as in the UCSC
browser. bigBed-based types (``bigBed``, ``bigNarrowPeak``, ``bigGenePred``,
...) become bigBed tracks, ``bigWig`` bigWig tracks and ``bam`` BAM datasets;
a ``decorator.default.bigDataUrl`` becomes an extra (unticked) bigBed track.
Other types (VCF, hic, bigChain, bigMaf, ...) are listed as skipped.
Assembly hubs (a ``twoBitPath`` genome FiberBrowser doesn't know) are refused.

The fetching is injected (``fetch_text(url) -> str``, or ``(str, final URL)``
when the fetch followed redirects: relative names then resolve against the
final URL), so the same parser runs under the SSRF-checked fetcher and in tests.
"""
from __future__ import annotations

from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

from services.session_link_format import SCHEMA, SessionLinkError, normalize_color

MAX_HUB_FILES = 24
MAX_INCLUDE_DEPTH = 3
MAX_STANZAS = 5000

_BIGBED_TYPES = {
    "bigbed", "bignarrowpeak", "biggenepred", "bigpsl", "biglolly", "bigbarchart",
    "bigrmsk", "bigdbsnp", "bigmethyl", "bigseqtype", "bigbroadpeak", "bigpeak",
}
_BIGWIG_TYPES = {"bigwig"}
_BAM_TYPES = {"bam"}
_CONTAINER_KEYS = ("compositeTrack", "superTrack", "container")


def parse_stanzas(text: str) -> list[dict]:
    """Blank-line separated ``key value`` stanzas (comments and ``\\`` continuations handled).

    An ``include <file>`` line becomes its own stanza ``{"__include__": file}``.
    """
    stanzas: list[dict] = []
    current: dict = {}
    pending = ""
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = pending + raw_line.strip()
        pending = ""
        if line.endswith("\\"):
            pending = line[:-1].rstrip() + " "
            continue
        if not line:
            if current:
                stanzas.append(current)
                current = {}
            continue
        if line.startswith("#"):
            continue
        key, _, value = line.partition(" ")
        value = value.strip()
        if key == "include":
            if current:
                stanzas.append(current)
                current = {}
            stanzas.append({"__include__": value.split()[0] if value else ""})
            continue
        current[key] = value
        if len(stanzas) > MAX_STANZAS:
            raise SessionLinkError("The hub has too many entries.")
    if current:
        stanzas.append(current)
    return stanzas


class _HubReader:
    def __init__(self, fetch_text: Callable[[str], str]):
        self._fetch_text = fetch_text
        self.files = 0

    def read(self, url: str) -> tuple[str, str]:
        """(text, the URL it was read from after any redirects)."""
        self.files += 1
        if self.files > MAX_HUB_FILES:
            raise SessionLinkError(f"The hub needs more than {MAX_HUB_FILES} files.")
        got = self._fetch_text(url)
        if isinstance(got, tuple):
            text, final = got
            return text, final or url
        return got, url

    def stanzas(self, url: str, depth: int = 0) -> list[tuple[dict, str]]:
        """``(stanza, the file URL it came from)``, with includes expanded.

        That URL is where the file was finally read (after redirects): relative
        names in it resolve against it, as a web browser resolves a page's links."""
        out: list[tuple[dict, str]] = []
        text, url = self.read(url)
        for stanza in parse_stanzas(text):
            if "__include__" in stanza:
                if depth >= MAX_INCLUDE_DEPTH:
                    raise SessionLinkError("The hub's trackDb includes are nested too deeply.")
                target = stanza["__include__"]
                if target:
                    out.extend(self.stanzas(_join(url, target), depth + 1))
                continue
            out.append((stanza, url))
        return out


def _join(base: str, ref: str) -> str:
    """``ref`` resolved against the URL of the file it came from; a malformed
    address (``https://[bad/x.bw``, a port out of range) is a SessionLinkError."""
    try:
        url = urljoin(base, (ref or "").strip())
        parts = urlsplit(url)
        parts.port
        parts.hostname
    except ValueError as exc:
        raise SessionLinkError(f"{ref!r} is not a valid address") from exc
    return url


def _first_word(value: Optional[str]) -> str:
    return (value or "").split()[0] if value else ""


def _parent_name(stanza: dict) -> tuple[Optional[str], bool]:
    """(parent track, whether this child is on by default)."""
    parent = stanza.get("parent")
    if parent:
        words = parent.split()
        on = not (len(words) > 1 and words[1].lower() in ("off", "hide"))
        return words[0], on
    sup = stanza.get("superTrack")
    if sup and _first_word(sup).lower() != "on":
        words = sup.split()
        on = not (len(words) > 1 and words[1].lower() == "hide")
        return words[0], on
    return None, True


def _is_container(stanza: dict) -> bool:
    return (_first_word(stanza.get("compositeTrack")).lower() == "on"
            or _first_word(stanza.get("superTrack")).lower() == "on"
            or _first_word(stanza.get("container")).lower() == "multiwig"
            or ("view" in stanza and "bigDataUrl" not in stanza))


def tracks_from_trackdb(entries: list[tuple[dict, str]]) -> tuple[list[dict], list[str]]:
    """Session-link track dicts and the skipped entries' reasons."""
    by_name: dict[str, dict] = {}
    base_of: dict[str, str] = {}
    order: list[str] = []
    for stanza, base in entries:
        name = stanza.get("track")
        if not name:
            continue
        name = _first_word(name)
        by_name[name] = stanza
        base_of[name] = base
        order.append(name)

    def chain(name: str) -> list[dict]:
        seen, out = set(), []
        while name and name in by_name and name not in seen:
            seen.add(name)
            stanza = by_name[name]
            out.append(stanza)
            name, _ = _parent_name(stanza)
        return out

    def setting(name: str, key: str) -> Optional[str]:
        for stanza in chain(name):
            if stanza.get(key):
                return stanza[key]
        return None

    def visible(name: str) -> bool:
        for stanza in chain(name):
            vis = (stanza.get("visibility") or "").lower()
            if vis == "hide":
                return False
            _, on = _parent_name(stanza)
            if not on:
                return False
        return True

    def group_of(name: str) -> Optional[str]:
        containers = [s for s in chain(name)[1:] if _is_container(s) and "view" not in s]
        if not containers:
            return None
        top = containers[-1]
        return top.get("shortLabel") or _first_word(top.get("track"))

    tracks: list[dict] = []
    skipped: list[str] = []
    for name in order:
        stanza = by_name[name]
        url = stanza.get("bigDataUrl")
        label = stanza.get("shortLabel") or name
        if not url:
            if not _is_container(stanza) and stanza.get("type"):
                skipped.append(f"{label}: no bigDataUrl (tracks built into a UCSC database can't be opened)")
            continue
        type_word = _first_word(setting(name, "type")).lower()
        base = base_of[name]
        try:
            url = _join(base, url)
            index = _join(base, stanza["bigDataIndex"]) if stanza.get("bigDataIndex") else None
            decorator = (_join(base, stanza["decorator.default.bigDataUrl"])
                         if stanza.get("decorator.default.bigDataUrl") else None)
        except SessionLinkError as exc:
            skipped.append(f"{label}: {exc}")
            continue
        if type_word in _BIGBED_TYPES:
            kind = "bigbed"
        elif type_word in _BIGWIG_TYPES:
            kind = "bigwig"
        elif type_word in _BAM_TYPES:
            kind = "bam"
        else:
            skipped.append(f"{label}: type {type_word or '(none)'} is not supported")
            continue
        track = {
            "url": url,
            "type": kind,
            "name": label,
            "group": group_of(name),
            "color": normalize_color(setting(name, "color")),
            "visible": visible(name),
            "hub_track": name,
        }
        if stanza.get("longLabel"):
            track["description"] = stanza["longLabel"]
        if index:
            track["index_url"] = index
        # A bigBed's "as" (reads or annotation) is decided when it is opened, from
        # its autoSql: FiberHMM layers and fibertools/FIRE per-fiber bigBeds are reads.
        tracks.append(track)
        if decorator:
            tracks.append({
                "url": decorator,
                "type": "bigbed",
                "name": f"{label} (decorations)",
                "group": track["group"],
                "visible": False,
                "hub_track": f"{name}.decorator",
            })
    return _merge_same_file(tracks), skipped


def _merge_same_file(tracks: list[dict]) -> list[dict]:
    """One track per file: stanzas that show the same file (a FIRE hub's H1/H2/UNK
    fiber tracks filter one bigBed) become one, named after their group."""
    merged: dict[tuple, dict] = {}
    names: dict[tuple, list[str]] = {}
    out: list[dict] = []
    for track in tracks:
        key = (track["url"], track["type"])
        if key not in merged:
            merged[key] = track
            names[key] = [track["name"]]
            out.append(track)
            continue
        first = merged[key]
        names[key].append(track["name"])
        first["visible"] = first["visible"] or track["visible"]
        first["name"] = first.get("group") or first["name"]
    return out


def import_hub(hub_url: str, fetch_text: Callable[[str], str], *, genome: Optional[str] = None,
               current_genome: Optional[str] = None) -> dict:
    """A session-link document (schema v1) for one genome of the hub at ``hub_url``.

    The genome is ``genome`` if given, else the loaded genome if the hub has
    it, else the hub's first. Adds ``hub`` info: name, genomes, skipped entries.
    """
    from services.genome_registry import GENOME_REGISTRY

    reader = _HubReader(fetch_text)
    hub_stanzas = reader.stanzas(hub_url)
    if not hub_stanzas or "hub" not in hub_stanzas[0][0]:
        raise SessionLinkError("This is not a track hub: hub.txt must start with a `hub` line.")
    hub, hub_url = hub_stanzas[0]  # hub_url: where hub.txt was read (after redirects)
    use_one_file = _first_word(hub.get("useOneFile")).lower() == "on"

    genomes: list[tuple[dict, str]] = []
    trackdb_entries_by_genome: dict[str, list[tuple[dict, str]]] = {}
    if use_one_file:
        current: Optional[str] = None
        for stanza, base in hub_stanzas[1:]:
            if "genome" in stanza and "track" not in stanza:
                genomes.append((stanza, base))
                current = _first_word(stanza["genome"])
                trackdb_entries_by_genome.setdefault(current, [])
            elif current is not None:
                trackdb_entries_by_genome[current].append((stanza, base))
    else:
        genomes_file = hub.get("genomesFile")
        if not genomes_file:
            raise SessionLinkError("hub.txt has no genomesFile (and is not a useOneFile hub).")
        genomes_url = _join(hub_url, genomes_file)
        genomes = [(s, b) for s, b in reader.stanzas(genomes_url) if "genome" in s]
    if not genomes:
        raise SessionLinkError("The hub lists no genomes.")

    names = [_first_word(s["genome"]) for s, _ in genomes]
    wanted = genome or (current_genome if current_genome in names else None) or names[0]
    if wanted not in names:
        raise SessionLinkError(f"The hub has no {wanted} tracks (it has {', '.join(names)}).")
    stanza, base = genomes[names.index(wanted)]
    known = {k.lower(): k for k in GENOME_REGISTRY}
    if wanted.lower() not in known:
        if stanza.get("twoBitPath"):
            raise SessionLinkError(f"{wanted} is an assembly hub genome; FiberBrowser opens hubs for the "
                                   f"genomes it knows ({', '.join(GENOME_REGISTRY)}).")
        raise SessionLinkError(f"FiberBrowser doesn't know the genome {wanted}.")

    if use_one_file:
        entries = trackdb_entries_by_genome.get(wanted, [])
    else:
        trackdb = stanza.get("trackDb")
        if not trackdb:
            raise SessionLinkError(f"genomes.txt has no trackDb for {wanted}.")
        entries = reader.stanzas(_join(base, trackdb))
    tracks, skipped = tracks_from_trackdb(entries)
    if not tracks:
        raise SessionLinkError("The hub has no bigBed, bigWig or BAM tracks for "
                               f"{wanted}" + (f" ({len(skipped)} skipped)." if skipped else "."))
    locus = stanza.get("defaultPos")
    return {
        "schema": SCHEMA,
        "title": hub.get("shortLabel") or hub.get("longLabel") or _first_word(hub.get("hub")),
        "genome": known[wanted.lower()],
        **({"locus": locus} if locus else {}),
        "tracks": tracks,
        "hub": {"name": _first_word(hub.get("hub")), "genomes": names, "genome": wanted,
                "skipped": skipped, "files_read": reader.files},
    }
