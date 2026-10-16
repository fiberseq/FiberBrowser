"""S3 source: browse and open ``s3://bucket/key`` with the existing S3 support.

Wraps ``browser/s3_utils.py`` (boto3 credentials: profile / env / IAM role,
anonymous fallback for public buckets, ``endpoint_url`` for S3-compatible
stores such as MinIO or Cloudflare R2). Readers open an HTTPS URL made by
boto3 (pre-signed for private objects, plain for public ones): htslib's own
``s3://`` support does not read boto3's settings. BAM indexes are fetched
once into the private cache (``opening.cached_index_for``).
"""
from __future__ import annotations

from typing import Any, Optional

from services.remote_sources.base import RemoteSource, RemoteSourceError

MAX_FETCH_BYTES = 256 * 1024 * 1024


def _parse(ref: str) -> tuple[str, str]:
    if not isinstance(ref, str) or not ref.startswith("s3://"):
        raise RemoteSourceError(f"Not an s3:// reference: {ref!r}")
    bucket, _slash, key = ref[len("s3://"):].partition("/")
    if not bucket:
        raise RemoteSourceError("An s3:// reference needs a bucket")
    return bucket, key


class S3Source(RemoteSource):
    scheme = "s3"
    label = "S3 bucket"

    def _manager(self):
        from services import s3_support
        if not s3_support.is_available():
            raise RemoteSourceError("S3 support is not installed (pip install boto3).")
        return s3_support.s3_manager

    def describe(self, *, probe: bool = False) -> dict[str, Any]:
        from services import s3_support
        info = s3_support.credentials_info()
        return {
            "scheme": self.scheme,
            "label": self.label,
            "available": bool(info.get("available")),
            "problem": None if info.get("available") else info.get("error"),
            "configured": bool(info.get("configured")),
            "profile": info.get("profile"),
            "region": info.get("region"),
            "connections": [],
        }

    def connect(self, params: dict[str, Any]) -> dict[str, Any]:
        from services import s3_support
        result = s3_support.configure(
            profile=(params.get("profile") or None),
            region=(params.get("region") or None),
            endpoint_url=(params.get("endpoint_url") or None),
        )
        if not result.get("success"):
            raise RemoteSourceError(result.get("error") or "S3 configuration failed")
        return {"source": "s3", "state": "connected", "profile": result.get("profile"),
                "region": result.get("region"), "endpoint_url": result.get("endpoint_url")}

    def disconnect(self, target: str, **options) -> dict[str, Any]:
        return {"success": True, "target": target}

    def is_connected(self, ref: str) -> bool:
        # Public buckets need no configuration; boto3 decides at request time.
        from services import s3_support
        return s3_support.is_available()

    def list(self, ref: str) -> dict[str, Any]:
        bucket, key = _parse(ref)
        prefix = key if (not key or key.endswith("/")) else key + "/"
        manager = self._manager()
        if not manager.is_configured:
            manager.configure()
        client = manager._client or manager._get_anon_client()
        if client is None:
            raise RemoteSourceError("No S3 client (configure a profile or use a public bucket).")
        entries: list[dict] = []
        truncated = False
        where = f"s3://{bucket}/{prefix}"
        kwargs = dict(Bucket=bucket, Prefix=prefix, Delimiter="/", MaxKeys=1000)
        response, _anonymous, error = manager._try_with_fallback(
            lambda: manager._client.list_objects_v2(**kwargs), lambda anon: anon.list_objects_v2(**kwargs))
        if error is not None:
            message = manager.describe_error(error, where)
            from s3_utils import _AUTH_CODES, _error_code
            if _error_code(error) in _AUTH_CODES or "Access denied" in message:
                # Read-only keys often may read objects but not list them (s3:ListBucket).
                message += (". Keys that may read files but not list the bucket can still open a file: "
                            "type its s3:// path under Load Remote URL")
            raise RemoteSourceError(f"Cannot list {where}: {message}")
        for common in response.get("CommonPrefixes", []) or []:
            name = common.get("Prefix", "")[len(prefix):].rstrip("/")
            if name:
                entries.append({"name": name, "type": "dir", "size": None, "mtime": None})
        for obj in response.get("Contents", []) or []:
            name = obj.get("Key", "")[len(prefix):]
            if not name or "/" in name:
                continue
            modified = obj.get("LastModified")
            entries.append({
                "name": name, "type": "file", "size": int(obj.get("Size") or 0),
                "mtime": int(modified.timestamp()) if hasattr(modified, "timestamp") else None,
            })
        truncated = bool(response.get("IsTruncated"))
        return {"path": "/" + prefix, "ref": f"s3://{bucket}/{prefix}", "entries": entries, "truncated": truncated}

    def stat(self, ref: str, max_age=None) -> Optional[dict[str, Any]]:
        manager = self._manager()
        try:
            _parse(ref)
        except RemoteSourceError:
            return None
        result = manager.test_access(ref)
        if not result.get("accessible"):
            if result.get("code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise RemoteSourceError(result.get("error") or f"{ref} is not accessible")
        # The version keys cached copies (indexes, plasmid maps): a replaced
        # object has a new ETag even at the same size and second.
        version = f"{result.get('etag')}:{result.get('size')}:{result.get('last_modified')}"
        return {"type": "file", "size": result.get("size"), "mtime": result.get("last_modified"),
                "version": version}

    def open_url(self, ref: str) -> str:
        try:
            return self._manager().open_url(ref)
        except (OSError, ValueError) as exc:
            raise RemoteSourceError(str(exc)) from None

    def fetch_bytes(self, ref: str, max_bytes: int = MAX_FETCH_BYTES) -> bytes:
        try:
            return self._manager().get_object_bytes(ref, max_bytes)
        except (OSError, ValueError) as exc:
            raise RemoteSourceError(str(exc)) from None
