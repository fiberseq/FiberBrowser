import pytest
from fastapi import HTTPException

from services import s3_endpoint


def test_s3_status_delegates_to_support(monkeypatch):
    monkeypatch.setattr(
        s3_endpoint.s3_support,
        "credentials_info",
        lambda: {"available": True, "configured": False},
    )

    assert s3_endpoint.get_s3_status_payload() == {"available": True, "configured": False}


def test_configure_s3_requires_optional_support(monkeypatch):
    monkeypatch.setattr(s3_endpoint.s3_support, "is_available", lambda: False)

    with pytest.raises(HTTPException) as exc:
        s3_endpoint.configure_s3_for_request(profile="lab")

    assert exc.value.status_code == 400
    assert "S3 support not available" in exc.value.detail


def test_configure_s3_returns_successful_configuration(monkeypatch):
    monkeypatch.setattr(s3_endpoint.s3_support, "is_available", lambda: True)
    monkeypatch.setattr(
        s3_endpoint.s3_support,
        "configure",
        lambda profile=None, region=None, endpoint_url=None: {
            "success": True,
            "profile": profile,
            "region": region,
            "endpoint_url": endpoint_url,
        },
    )

    assert s3_endpoint.configure_s3_for_request("lab", "us-east-1", "https://r2.example") == {
        "success": True,
        "profile": "lab",
        "region": "us-east-1",
        "endpoint_url": "https://r2.example",
    }


def test_s3_access_rejects_non_s3_urls_before_support_call(monkeypatch):
    monkeypatch.setattr(s3_endpoint.s3_support, "is_available", lambda: True)

    assert s3_endpoint.test_s3_access_for_request("https://example.org/file.bam") == {
        "accessible": False,
        "error": "Not an S3 URL. Must start with s3://",
    }


def test_s3_list_and_presign_delegate_when_available(monkeypatch):
    monkeypatch.setattr(s3_endpoint.s3_support, "is_available", lambda: True)
    monkeypatch.setattr(
        s3_endpoint.s3_support,
        "list_bucket",
        lambda bucket, prefix="", max_keys=100: {
            "success": True,
            "bucket": bucket,
            "prefix": prefix,
            "max_keys": max_keys,
        },
    )
    monkeypatch.setattr(
        s3_endpoint.s3_support,
        "get_presigned_url",
        lambda url, expiration=3600: f"https://signed.example/{expiration}",
    )

    assert s3_endpoint.list_s3_bucket_for_request("bucket", prefix="runs/", max_keys=10) == {
        "success": True,
        "bucket": "bucket",
        "prefix": "runs/",
        "max_keys": 10,
    }
    assert s3_endpoint.get_presigned_url_for_request("s3://bucket/file.bam", expiration=60) == {
        "success": True,
        "url": "https://signed.example/60",
        "expiration_seconds": 60,
    }
