"""Portable browser scans (D10): at most 25 MiB total uncompressed per session."""
from __future__ import annotations
import base64
import copy
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tempfile
import zipfile

EMBED_LIMIT = 25 * 1024 * 1024
MAX_FILES = 10000


def export_scans(state, frontend):
    from .registry import list_scans
    saved = copy.deepcopy(frontend)
    refs = (saved.get('featureHub') or {}).get('scans') or []
    opened = {str(s.path): s for s in list_scans(state)}
    bundles, used = [], 0
    for ref in refs:
        scan = opened.get(ref.get('path'))
        if scan is None or scan.source != 'cache':
            continue
        files, size, unsafe = [], 0, False
        for p in scan.path.rglob('*'):
            if p.is_symlink():
                unsafe = True
                break
            if p.is_file():
                size += p.stat().st_size
                files.append(p)
                if size + used > EMBED_LIMIT or len(files) > MAX_FILES:
                    break
        ref['embedding'] = 'reference'
        if unsafe or size + used > EMBED_LIMIT or len(files) > MAX_FILES:
            ref['rescanPrompt'] = 'Browser scan saved by reference; locate its directory or re-scan if unavailable.'
            continue
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for p in sorted(files):
                rel = p.relative_to(scan.path).as_posix()
                if rel == 'manifest.json':
                    manifest = dict(scan.manifest, browser_set_identity=scan.manifest.get('browser_set_identity') or f'cache:{scan.path}')
                    archive.writestr(rel, json.dumps(manifest))
                    from .registry import _digest
                    ref['manifestDigest'] = _digest(manifest, 32)
                else:
                    archive.write(p, rel)
        raw = data.getvalue()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            size = sum(entry.file_size for entry in archive.infolist())
        if used + size > EMBED_LIMIT:
            ref['manifestDigest'] = scan.manifest_digest
            ref['rescanPrompt'] = 'Browser scan saved by reference; locate its directory or re-scan if unavailable.'
            continue
        bundles.append(dict(scanId=scan.scan_id, path=str(scan.path), size=size,
                            sha256=hashlib.sha256(raw).hexdigest(), archive=base64.b64encode(raw).decode('ascii')))
        ref['embedding'] = 'embedded'
        ref.pop('rescanPrompt', None)
        used += size
    return saved, bundles


def restore_scans(state, session):
    """Validate every archive before extracting; rewrite references to temporary session directories."""
    refs = ((session.get('frontend') or {}).get('featureHub') or {}).get('scans') or []
    problems, restored, used = [], [], 0
    roots = []
    for bundle in session.get('hub_scans') or []:
        root = None
        try:
            text = bundle.get('archive', '')
            if not isinstance(text, str) or len(text) > (EMBED_LIMIT * 2):
                raise ValueError('Scan archive exceeds the session limit')
            raw = base64.b64decode(text, validate=True)
            if hashlib.sha256(raw).hexdigest() != bundle.get('sha256'):
                raise ValueError('Scan archive checksum mismatch')
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                entries = archive.infolist()
                names = [e.filename for e in entries]
                size = sum(e.file_size for e in entries)
                if len(entries) > MAX_FILES or used + size > EMBED_LIMIT or len(set(names)) != len(names):
                    raise ValueError('Scan archive exceeds the session limit or repeats entries')
                for e in entries:
                    name = PurePosixPath(e.filename)
                    if name.is_absolute() or '..' in name.parts or '\\' in e.filename or ':' in e.filename or (e.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError('Unsafe scan archive member')
                if 'manifest.json' not in names:
                    raise ValueError('Scan archive has no manifest')
                root = tempfile.TemporaryDirectory(prefix='hub-session-scan-')
                archive.extractall(root.name)
            from .registry import open_scan
            scan = open_scan(state, root.name, source='cache')
            for ref in refs:
                if ref.get('path') == bundle.get('path') and ref.get('scanId') == bundle.get('scanId'):
                    ref['path'] = str(scan.path)
                    ref['embedding'] = 'embedded'
                    ref.pop('rescanPrompt', None)
            used += size
            restored.append(scan.scan_id)
            roots.append(root)
        except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
            if root:
                root.cleanup()
            problems.append(dict(scanId=bundle.get('scanId'), error=str(error)))
    # Keep extracted directories alive for this workspace; old roots can be released after scans were disposed.
    state._hub_session_scan_roots = roots
    return restored, problems
