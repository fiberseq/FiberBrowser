"""Optional S3 support boundary for API routers."""
from __future__ import annotations

HAS_S3 = False
s3_manager = None
setup_s3_environment = None
_S3_LOADED = False


def _load_s3_support() -> bool:
    global HAS_S3, _S3_LOADED, s3_manager, setup_s3_environment
    if _S3_LOADED:
        return HAS_S3
    try:
        from s3_utils import s3_manager as manager
        from s3_utils import setup_s3_environment as setup_environment
    except ImportError:
        HAS_S3 = False
        s3_manager = None
        setup_s3_environment = None
    else:
        s3_manager = manager
        setup_s3_environment = setup_environment
        HAS_S3 = bool(manager.is_available)
    _S3_LOADED = True
    return HAS_S3


def is_available() -> bool:
    return _load_s3_support()


def credentials_info() -> dict:
    if not _load_s3_support():
        return {
            "available": False,
            "configured": False,
            "error": "S3 support not available. Install boto3: pip install boto3",
        }
    return {"available": True, **s3_manager.get_credentials_info()}


def configure(profile=None, region=None, endpoint_url=None) -> dict:
    if not _load_s3_support():
        return {"success": False, "error": "S3 support not available. Install boto3: pip install boto3"}

    result = s3_manager.configure(
        profile=profile,
        region=region,
        endpoint_url=endpoint_url,
    )
    if result.get("success"):
        if setup_s3_environment:
            setup_s3_environment()
        # Index lookups remembered under the old settings (a "no index" or an
        # access failure) must not outlive them.
        from services.remote_sources.opening import forget_remote_state
        forget_remote_state()
    return result


def test_access(url: str) -> dict:
    if not _load_s3_support():
        return {"accessible": False, "error": "S3 support not available"}
    return s3_manager.test_access(url)


def list_bucket(bucket: str, prefix: str = "", max_keys: int = 100) -> dict:
    if not _load_s3_support():
        return {"success": False, "error": "S3 support not available"}
    return s3_manager.list_bucket(bucket, prefix=prefix, max_keys=max_keys)


def get_presigned_url(url: str, expiration: int = 3600) -> str:
    if not _load_s3_support():
        raise RuntimeError("S3 support not available")
    return s3_manager.get_presigned_url(url, expiration=expiration)
