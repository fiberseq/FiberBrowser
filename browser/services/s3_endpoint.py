"""Endpoint orchestration helpers for optional S3 dataset support."""
from __future__ import annotations

from fastapi import HTTPException

from services import s3_support
from utils.validation import is_s3_url


def get_s3_status_payload() -> dict:
    return s3_support.credentials_info()


def configure_s3_for_request(profile=None, region=None, endpoint_url=None) -> dict:
    if not s3_support.is_available():
        raise HTTPException(
            status_code=400,
            detail="S3 support not available. Install boto3: pip install boto3",
        )

    result = s3_support.configure(
        profile=profile,
        region=region,
        endpoint_url=endpoint_url,
    )
    if result.get("success"):
        return result
    raise HTTPException(status_code=400, detail=result.get("error", "Configuration failed"))


def test_s3_access_for_request(url: str) -> dict:
    if not s3_support.is_available():
        return {"accessible": False, "error": "S3 support not available"}

    if not is_s3_url(url):
        return {"accessible": False, "error": "Not an S3 URL. Must start with s3://"}

    return s3_support.test_access(url)


def list_s3_bucket_for_request(bucket: str, prefix: str = "", max_keys: int = 100) -> dict:
    if not s3_support.is_available():
        raise HTTPException(status_code=400, detail="S3 support not available")

    result = s3_support.list_bucket(bucket, prefix=prefix, max_keys=max_keys)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "List failed"))
    return result


def get_presigned_url_for_request(url: str, expiration: int = 3600) -> dict:
    if not s3_support.is_available():
        raise HTTPException(status_code=400, detail="S3 support not available")

    if not is_s3_url(url):
        raise HTTPException(status_code=400, detail="Not an S3 URL")

    try:
        presigned = s3_support.get_presigned_url(url, expiration=expiration)
        return {"success": True, "url": presigned, "expiration_seconds": expiration}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
