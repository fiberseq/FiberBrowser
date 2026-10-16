"""URL validation, path detection, and data format utilities."""

import os
import urllib.parse
import urllib.request
import urllib.error


def is_url(path: str) -> bool:
    """Check if a path is remote: an HTTP/HTTPS or S3 URL, or a source reference
    such as ``ssh://host/abs/path`` (services/remote_sources)."""
    if not path or not isinstance(path, str):
        return False
    parsed = urllib.parse.urlparse(path)
    return parsed.scheme in ('http', 'https', 's3') or is_source_ref(path)


def is_source_ref(path) -> bool:
    """A reference a remote source opens at read time (``ssh://...``)."""
    from services.remote_sources import is_source_ref as _is_source_ref
    return _is_source_ref(path)


def validate_source_ref(path: str, data_format: str) -> dict:
    """Validate a source reference: connected, the file exists, BAMs have an index."""
    from services.remote_sources import source_for_ref
    from services.remote_sources.base import RemoteSourceError

    result = {'valid': False, 'has_index': False, 'error': None, 'supports_range': True}
    source = source_for_ref(path)
    if source is None:
        result['error'] = 'No remote source handles this reference'
        return result
    try:
        info = source.stat(path)
    except RemoteSourceError as exc:
        result['error'] = str(exc)
        return result
    if not info or info.get('type') != 'file':
        result['error'] = 'File not found under the shared cluster folders'
        return result
    result['content_length'] = info.get('size')
    if data_format == 'bam':
        from services.remote_sources.opening import cached_index_for
        try:
            result['has_index'] = cached_index_for(path) is not None
        except RemoteSourceError as exc:
            result['error'] = str(exc)
            return result
        if not result['has_index']:
            result['error'] = 'No BAM index (.bai or .csi) next to the BAM on the cluster (run samtools index there)'
            return result
    result['valid'] = True
    return result


def is_s3_url(path: str) -> bool:
    """Check if a path is an S3 URL."""
    if not path:
        return False
    return path.startswith('s3://')


def validate_remote_url(url: str, timeout: int = 10) -> dict:
    """Validate a remote URL is accessible and supports required features."""
    result = {
        'valid': False,
        'supports_range': False,
        'content_length': None,
        'content_type': None,
        'error': None
    }
    try:
        req = urllib.request.Request(url, method='HEAD')
        req.add_header('User-Agent', 'FiberHMM/1.0')
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result['valid'] = response.status == 200
            result['content_type'] = response.headers.get('Content-Type')
            accept_ranges = response.headers.get('Accept-Ranges', '')
            result['supports_range'] = accept_ranges.lower() == 'bytes'
            content_length = response.headers.get('Content-Length')
            if content_length:
                result['content_length'] = int(content_length)
    except urllib.error.HTTPError as e:
        result['error'] = f"HTTP {e.code}: {e.reason}"
        if e.code in (403, 405, 501):
            # A pre-signed URL is signed for GET only (HEAD gets 403), and some
            # servers refuse HEAD: ask for the first byte instead.
            ranged = _validate_with_range_get(url, timeout)
            if ranged is not None:
                return ranged
    except urllib.error.URLError as e:
        result['error'] = f"URL error: {e.reason}"
    except Exception as e:
        result['error'] = str(e)
    return result


def _validate_with_range_get(url: str, timeout: int) -> dict | None:
    """validate_remote_url's answer from a one-byte ranged GET (None: no better answer)."""
    req = urllib.request.Request(url, headers={'Range': 'bytes=0-0', 'User-Agent': 'FiberHMM/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_range = response.headers.get('Content-Range') or ''
            total = content_range.rsplit('/', 1)[-1] if '/' in content_range else ''
            return {
                'valid': response.status in (200, 206),
                'supports_range': response.status == 206,
                'content_length': int(total) if total.isdigit() else None,
                'content_type': response.headers.get('Content-Type'),
                'error': None,
            }
    except Exception:
        return None


def get_remote_bam_index_url(bam_url: str) -> str:
    """Get the expected index URL for a remote BAM file."""
    return bam_url + '.bai'


def validate_s3_url(url: str) -> dict:
    """Validate an S3 URL is accessible."""
    try:
        from s3_utils import s3_manager
        HAS_S3 = s3_manager.is_available
    except ImportError:
        HAS_S3 = False
        s3_manager = None

    if not HAS_S3:
        return {'valid': False, 'error': 'S3 support not available (install boto3)'}

    result = s3_manager.test_access(url)
    return {
        'valid': result.get('accessible', False),
        'size': result.get('size'),
        'error': result.get('error')
    }


def validate_s3_bam(url: str) -> dict:
    """Validate an S3 BAM URL: the object, its index, and that it opens.

    Tries authenticated access first (via the configured S3Manager) and
    falls back to anonymous/public access. The index may sit beside the BAM
    (``x.bam.bai``, ``x.bai``, ``x.bam.csi``, ``x.csi``) or be named
    explicitly as ``s3://.../x.bam##idx##s3://.../x.bai`` (or an https URL).
    The BAM is then opened the way the reads will be (an HTTPS URL made by
    boto3), so a file htslib can't read is refused here with the reason
    instead of loading as a dataset with no reads.
    """
    from services.signed_urls import split_index
    result = {'valid': False, 'has_index': False, 'index_url': None, 'error': None, 'anonymous': None}
    data, explicit = split_index(url)

    bam_info = validate_s3_url(data)
    if not bam_info['valid']:
        result['error'] = bam_info.get('error') or 'BAM file not accessible'
        return result

    from services.remote_sources.base import RemoteSourceError
    from services.remote_sources.opening import url_index_for, open_alignment_file
    try:
        index = url_index_for(url)
    except RemoteSourceError as exc:
        result['error'] = str(exc)
        return result
    if not index:
        result['error'] = ('No BAM index (.bai or .csi) found next to the BAM. Upload one '
                           '(samtools index), or name it: <bam URL>##idx##<index URL>')
        return result
    result['has_index'] = True
    result['index_url'] = explicit or None
    try:
        with open_alignment_file(url, "rb") as bam:
            if not bam.references:
                result['error'] = 'The BAM has no reference sequences in its header'
                return result
    except (OSError, ValueError) as exc:
        result['error'] = f"Could not read the BAM: {exc}"
        return result
    result['valid'] = True
    return result


def validate_remote_bam(url: str) -> dict:
    """Validate a remote BAM URL (HTTP/HTTPS or S3) or source reference."""
    if is_s3_url(url):
        return validate_s3_bam(url)
    if is_source_ref(url):
        return validate_source_ref(url, 'bam')

    result = {'valid': False, 'has_index': False, 'index_url': None, 'error': None}

    if '##idx##' in url:
        # htslib's "<bam>##idx##<index>" form: a separately named (e.g. pre-signed) index.
        bam_url, _, index_url = url.partition('##idx##')
        bam_info = validate_remote_url(bam_url)
        if not bam_info['valid']:
            result['error'] = bam_info['error'] or 'BAM file not accessible'
            return result
        index_info = validate_remote_url(index_url)
        if not index_info['valid']:
            result['error'] = f"BAM index not accessible: {index_info['error'] or 'unknown error'}"
            return result
        result.update(valid=True, has_index=True, index_url=index_url)
        return result

    bam_info = validate_remote_url(url)
    if not bam_info['valid']:
        result['error'] = bam_info['error'] or 'BAM file not accessible'
        return result

    if not bam_info['supports_range']:
        result['error'] = 'Server does not support byte-range requests (required for remote BAM)'
        return result

    result['valid'] = True
    from services.remote_sources.opening import _url_index_candidates
    for index_url in _url_index_candidates(url):
        index_info = validate_remote_url(index_url)
        if index_info['valid']:
            result['has_index'] = True
            result['index_url'] = index_url
            break

    if not result['has_index']:
        result['error'] = 'No BAM index (.bai or .csi) found next to the BAM'
        from services.signed_urls import looks_signed
        if looks_signed(url):
            result['error'] += (' (a pre-signed link covers one file only: add the index\'s own link as '
                                '<BAM link>##idx##<index link>)')
        result['valid'] = False
    return result


def detect_path_type(path: str) -> str:
    """Detect: 'local_file', 'local_dir', 'remote_url', or 'unknown'."""
    if is_url(path):
        return 'remote_url'
    if os.path.isfile(path):
        return 'local_file'
    if os.path.isdir(path):
        return 'local_dir'
    return 'unknown'


def detect_data_format(path: str) -> str:
    """Detect: 'bam', 'bigbed', or 'unknown'.

    A URL's format is its path's: a signed ``https://host/s.bb?token=...`` is a
    BigBed (the full URL is still what gets opened).
    """
    if is_url(path):
        path = urllib.parse.urlparse(path).path
    lower_path = path.lower()
    if lower_path.endswith('.bam'):
        return 'bam'
    if lower_path.endswith(('.bb', '.bigbed')):
        return 'bigbed'
    return 'unknown'
