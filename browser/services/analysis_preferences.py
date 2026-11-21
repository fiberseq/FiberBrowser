"""The user's analysis preferences, kept on this computer (``~/.fiberhmm/analysis_preferences.json``).

Choices that belong to a genome or a species rather than to one session, and that must survive another port, another
app build or a new session (browser storage is per origin, so 8756 and 8757 never shared it):

``pinned_motifs``
    ``{species: [names]}``: the key factors pinned onto the motif views ('fly', 'human', ...); a species without an
    entry uses the server's defaults.
``custom_motifs``
    ``[{"name", "counts": {"A": [...], ...}}]``: the user's own matrices, scanned next to JASPAR's.
``layer_colors``
    ``{layer: "#rrggbb"}``: the user's default layer colours (Labels → Layer colours → Save as my default colours);
    a session's own colours win over them.
``recent_genomes_max``
    How many recent genomes are listed (default 8). Nothing switches the reference on its own: a pinned or recent
    genome that fits the data better is offered in the mismatch banner. (An old ``recent_genomes_autoswitch`` is
    ignored and dropped.)
``show_preview_features``
    Settings → Show preview features (a boolean; absent: off). Not an analysis choice, but an app preference that must
    hold on every port and build the same way.

A plugin pack adds maps of its own (``PackAPI.preference_map``): ``{key: value}`` merged per key like
``pinned_motifs``.

Kept apart from ``browser_settings.json`` (the hand-edited machine configuration). ``FIBERBROWSER_PREFERENCES`` points
at another file. On a lab server each member has their own file (``preferences_path``). Writes merge per genome / species and replace the file atomically; an unreadable file reads as empty
and is replaced on the next write.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

SCHEMA = 'fiberbrowser.analysis_preferences/1'
MAX_PINNED = 100
MAX_CUSTOM = 50
MAX_KEYS = 200
_lock = threading.Lock()


def shared_preferences_path() -> Path:
    override = os.environ.get('FIBERBROWSER_PREFERENCES')
    return Path(override).expanduser() if override else Path.home() / '.fiberhmm' / 'analysis_preferences.json'


def _lab_member() -> str | None:
    """The signed-in member of a lab-server request, else None (the local user, and the server's own work)."""
    try:
        from services.runtime import current_lab_user, get_lab_mode
        user = current_lab_user() if get_lab_mode() else None
    except Exception:
        return None
    if user is None:
        return None
    name = getattr(user, 'name', None) or str(user)
    return str(name) if name else None


def preferences_path() -> Path:
    """The preferences file of this request. On a lab server each member has their own
    (``lab_preferences/<hash of the member>.json`` beside the shared file), so one member's colours, pins or settings
    never replace another's; until a member first saves, they read the shared file."""
    shared = shared_preferences_path()
    member = _lab_member()
    if member is None:
        return shared
    import hashlib
    # Keyed by the shared file too: two servers with their own preference files never share a member's file.
    digest = hashlib.sha256(f'{shared.resolve()}\0{member}'.encode('utf-8')).hexdigest()[:24]
    return shared.parent / 'lab_preferences' / f'{digest}.json'


def unique_names(value: Any, limit: int) -> list[str]:
    """Distinct names (case-insensitive), trimmed, at most ``limit`` (a preference map's lists)."""
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, str):
            continue
        name = raw.strip()[:120]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        out.append(name)
        if len(out) >= limit:
            break
    return out


def _key(value: Any) -> str | None:
    return value.strip()[:80] if isinstance(value, str) and value.strip() else None


def _pinned(value: Any) -> list[str] | None:
    return unique_names(value, MAX_PINNED) if isinstance(value, list) else None


def _hex_color(value: Any) -> str | None:
    """A layer colour (``layer_colors``): ``#rrggbb`` lower case; ``#rgb`` widened; anything else dropped."""
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if len(v) == 4 and v.startswith('#') and all(c in '0123456789abcdef' for c in v[1:]):
        v = '#' + ''.join(c * 2 for c in v[1:])
    return v if len(v) == 7 and v.startswith('#') and all(c in '0123456789abcdef' for c in v[1:]) else None


# Layer aliases (utils/layerColors.ts, services/figure/layer_colours.ALIASES): one stored key per layer.
_LAYER_ALIASES = {'msp': 'fire', 'mod': 'm6a', 'footprint': 'nuc'}


def _map_key(field: str, key: str) -> str:
    return _LAYER_ALIASES.get(key, key) if field == 'layer_colors' else key


def _maps() -> dict[str, Callable[[Any], Any]]:
    """Every per-key map: the packs', then core's (a pack never replaces a core map)."""
    from plugins.packs import preference_maps
    return {**preference_maps(), 'pinned_motifs': _pinned, 'layer_colors': _hex_color}


# Single values: field -> clean(raw) (None: not a valid value, dropped).
SCALARS: dict[str, Callable[[Any], Any]] = {
    'show_preview_features': lambda v: v if isinstance(v, bool) else None,
    # Recent genomes (services/recent_genomes.py): how many are listed.
    'recent_genomes_max': lambda v: v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 50 else None,
}


def _custom(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out = []
    for raw in value:
        if not isinstance(raw, dict) or not isinstance(raw.get('name'), str) or not raw['name'].strip():
            continue
        counts = raw.get('counts')
        if not isinstance(counts, dict):
            continue
        cols = {b: counts.get(b) for b in 'ACGT'}
        if not all(isinstance(c, list) and c and all(isinstance(x, (int, float)) and x >= 0 for x in c) for c in cols.values()):
            continue
        if len({len(c) for c in cols.values()}) != 1 or not 3 <= len(cols['A']) <= 60:
            continue
        if any(c['name'].lower() == raw['name'].strip()[:60].lower() for c in out):
            continue
        out.append({'name': raw['name'].strip()[:60], 'counts': {b: [float(x) for x in cols[b]] for b in 'ACGT'}})
        if len(out) >= MAX_CUSTOM:
            break
    return out


def normalize(value: Any) -> dict[str, Any]:
    """Preferences from untrusted input (the file, a request): unknown keys dropped, lists bounded."""
    v = value if isinstance(value, dict) else {}
    out: dict[str, Any] = {}
    for field, clean in _maps().items():
        out[field] = {}
        raw_map = v.get(field)
        for key, raw in list(raw_map.items())[:MAX_KEYS] if isinstance(raw_map, dict) else []:
            k = _key(key)
            value = clean(raw) if k else None
            if value is not None:
                out[field][_map_key(field, k)] = value
    if isinstance(v.get('custom_motifs'), list):
        out['custom_motifs'] = _custom(v['custom_motifs'])
    for field, clean in SCALARS.items():
        value = clean(v.get(field))
        if value is not None:
            out[field] = value
    return out


def _read_file() -> dict[str, Any]:
    path = preferences_path()
    if not path.exists():
        path = shared_preferences_path()  # a lab member who never saved: the shared file
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def load_preferences() -> dict[str, Any]:
    return normalize(_read_file())


def _kept_maps(raw: dict[str, Any], prefs: dict[str, Any]) -> dict[str, Any]:
    """Maps this build doesn't know (a plugin pack's, written by another build sharing the file): kept as they are."""
    return {k: v for k, v in list(raw.items())[:MAX_KEYS] if k != 'schema' and k not in prefs and isinstance(v, dict)}


def _write(prefs: dict[str, Any]) -> None:
    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.analysis_preferences.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump({'schema': SCHEMA, **prefs}, handle, indent=1, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def update_preferences(patch: Any) -> dict[str, Any]:
    """Merge a change and return the whole: ``pinned_motifs`` (and a pack's maps) per species / genome (a value of
    null forgets that one, so the defaults apply again), ``custom_motifs`` as a whole list. With
    ``only_missing``: keys already stored are kept (the one-time move of a browser's own storage)."""
    if not isinstance(patch, dict):
        raise ValueError('Expected a JSON object')
    only_missing = patch.get('only_missing') is True
    with _lock:
        raw_file = _read_file()
        prefs = normalize(raw_file)
        for field, clean in _maps().items():
            changes = patch.get(field)
            if changes is None:
                continue
            if not isinstance(changes, dict):
                raise ValueError(f'{field} must be an object keyed by genome or species')
            for raw_key, raw in list(changes.items())[:MAX_KEYS]:
                k = _key(raw_key)
                k = _map_key(field, k) if k else k
                if not k or (only_missing and k in prefs[field]):
                    continue
                if raw is None:
                    prefs[field].pop(k, None)
                    continue
                value = clean(raw)
                if value is not None:
                    prefs[field][k] = value
        if 'custom_motifs' in patch and not (only_missing and 'custom_motifs' in prefs):
            if not isinstance(patch['custom_motifs'], list):
                raise ValueError('custom_motifs must be a list')
            prefs['custom_motifs'] = _custom(patch['custom_motifs'])
        for field, clean in SCALARS.items():
            if field not in patch or (only_missing and field in prefs):
                continue
            value = clean(patch[field])
            if value is None:
                raise ValueError(f'{field}: not a valid value')
            prefs[field] = value
        _write({**_kept_maps(raw_file, prefs), **prefs})
        return prefs
