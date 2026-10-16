"""Shared BigBed/BigWig readers, bounded across all worker pools."""
from __future__ import annotations

import pyBigWig

from services.file_handles import handles, file_stamp
from utils.validation import is_s3_url

HAS_S3 = False
s3_manager = None
_S3_LOADED = False


def _load_s3_manager() -> bool:
    global HAS_S3, _S3_LOADED, s3_manager
    if _S3_LOADED:
        return HAS_S3
    try:
        from s3_utils import s3_manager as manager
    except ImportError:
        s3_manager = None
        HAS_S3 = False
    else:
        s3_manager = manager
        HAS_S3 = bool(manager.is_available)
    _S3_LOADED = True
    return HAS_S3


S3_HANDLE_MAX_AGE_S = 40 * 60


def get_bigbed_handle(filepath: str):
    """Get a shared pyBigWig reader whose native operations hold a file lease."""
    from services.remote_sources import is_source_ref
    from services.remote_sources.opening import resolve_open_path

    remote = is_source_ref(filepath)

    def version():
        if remote:
            return resolve_open_path(filepath)
        from services.lab.paths import confine
        confine(filepath, urls=True)
        return file_stamp(filepath)

    def open_reader():
        open_path = resolve_open_path(filepath) if remote else filepath
        if is_s3_url(filepath):
            if not (_load_s3_manager() and s3_manager):
                raise OSError('S3 support not available')
            open_path = s3_manager.open_url(filepath)
            if open_path != filepath:
                from services.signed_urls import register_secret
                register_secret(open_path, filepath)
        elif not remote:
            from services.lab.paths import confine
            confine(filepath, urls=True)
            if '://' not in filepath:
                # Catch missing files and descriptor exhaustion before libBigWig
                # prints its own unthrottled diagnostics to the process stderr.
                from services.lab.paths import open_read
                with open_read(filepath) as probe:
                    if not probe.read(1):
                        raise OSError('Empty BigBed/BigWig file')
        return pyBigWig.open(open_path)

    try:
        return handles.get('bigbed', filepath, open_reader,
                           version,
                           max_age=S3_HANDLE_MAX_AGE_S if is_s3_url(filepath) else None)
    except OSError:
        return None


def get_bigwig_handle(filepath: str):
    """Alias for signal BigWig tracks."""
    return get_bigbed_handle(filepath)


def close_all_bigbed_handles() -> None:
    """Retire every BigBed/BigWig reader after its current operation."""
    handles.discard(kind='bigbed')
