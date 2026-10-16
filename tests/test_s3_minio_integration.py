"""S3 end to end against a real S3-compatible server (opt-in).

Skipped unless FIBERBROWSER_TEST_S3_ENDPOINT is set (see tests/s3_minio.py
for a one-line local MinIO). Creates its own buckets, and deletes them after.
Exercises the code a user's s3:// file goes through: validation, the boto3
URL htslib reads, the cached index, BAM handles, the read loader, anonymous
public buckets, wrong keys, and s3:// contact maps.
"""
from __future__ import annotations

import os

import pytest

import s3_minio

pytestmark = pytest.mark.skipif(not s3_minio.endpoint(), reason=f"set {s3_minio.ENDPOINT_ENV} to run")


@pytest.fixture(scope="module")
def staged(tmp_path_factory):
    data = s3_minio.stage(str(tmp_path_factory.mktemp("s3stage")))
    yield data
    s3_minio.cleanup(data["run"])


@pytest.fixture
def manager(monkeypatch, tmp_path, staged):
    """A fresh S3Manager with the test keys and endpoint, used everywhere."""
    import s3_utils
    from services import s3_support
    from services.remote_sources import opening
    for name in ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "no-aws-config"))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "no-aws-credentials"))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(tmp_path / "cache"))
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    fresh = s3_utils.S3Manager()
    key, secret = s3_minio.credentials()
    assert fresh.configure(access_key=key, secret_key=secret, endpoint_url=staged["endpoint"])["success"]
    monkeypatch.setattr(s3_utils, "s3_manager", fresh)
    monkeypatch.setattr(s3_support, "s3_manager", fresh)
    monkeypatch.setattr(s3_support, "_S3_LOADED", True)
    monkeypatch.setattr(s3_support, "HAS_S3", True)
    opening.forget_remote_state()
    yield fresh
    opening.forget_remote_state()
    assert os.listdir(cwd) == []  # htslib never saves an index beside the server


def _reads(path, region):
    from services.remote_sources.opening import open_alignment_file
    chrom, start, end = region
    with open_alignment_file(path) as bam:
        return sum(1 for _ in bam.fetch(chrom, start, end))


def test_private_bam_bai_csi_and_separate_index(manager, staged):
    from utils.validation import validate_remote_bam
    for key in ("bam", "csi_bam", "sep_bam"):
        result = validate_remote_bam(staged[key])
        assert result["valid"], (key, result)
        assert _reads(staged[key], staged["region"]) == staged["reads"], key


def test_missing_index_and_object_are_named(manager, staged):
    from utils.validation import validate_remote_bam
    noidx = validate_remote_bam(staged["noidx_bam"])
    assert not noidx["valid"] and "No BAM index (.bai or .csi)" in noidx["error"]
    missing = validate_remote_bam(staged["missing_bam"])
    assert not missing["valid"] and missing["error"].startswith(f"Object not found: {staged['missing_bam']}")


def test_public_bucket_without_credentials_and_with_wrong_ones(manager, staged, monkeypatch):
    import s3_utils
    anonymous = s3_utils.S3Manager()
    assert anonymous.configure(endpoint_url=staged["endpoint"])["success"]  # no keys anywhere
    monkeypatch.setattr(s3_utils, "s3_manager", anonymous)
    from services import s3_support
    monkeypatch.setattr(s3_support, "s3_manager", anonymous)
    assert _reads(staged["public_bam"], staged["region"]) == staged["reads"]
    denied = anonymous.test_access(staged["bam"])
    assert denied["error"] == "Access denied: the bucket is not public and no credentials are configured"

    wrong = s3_utils.S3Manager()
    wrong.configure(access_key=s3_minio.credentials()[0], secret_key="not-the-secret", endpoint_url=staged["endpoint"])
    monkeypatch.setattr(s3_utils, "s3_manager", wrong)
    monkeypatch.setattr(s3_support, "s3_manager", wrong)
    assert "SignatureDoesNotMatch" in wrong.test_access(staged["bam"])["error"]
    # A public object still opens (by its plain URL) with refused keys.
    assert _reads(staged["public_bam"], staged["region"]) == staged["reads"]


def test_read_loader_and_handles(manager, staged):
    from services.bam_handles import get_bam_handle
    from services.compact_read_loader import _build_compact_reads_from_bam_region
    handle = get_bam_handle(staged["bam"])
    assert handle is not None and get_bam_handle(staged["bam"]) is handle
    chrom, start, end = staged["region"]
    reads = _build_compact_reads_from_bam_region(staged["bam"], chrom, start, end, spanning_only=False)
    assert len(reads) == staged["reads"]


def test_index_is_downloaded_once(manager, staged, tmp_path):
    for _ in range(3):
        assert _reads(staged["bam"], staged["region"]) == staged["reads"]
    index_dir = tmp_path / "cache" / "index"
    assert len(os.listdir(index_dir)) == 1


def test_contact_map(manager, staged):
    if not staged["mcool"]:
        pytest.skip("cooler not installed")
    import cooler
    from services.cooler_open import forget_remote_maps, mcool_resolutions, open_cooler
    try:
        assert mcool_resolutions(staged["mcool"]) == [10_000, 50_000]
        clr = open_cooler(cooler, staged["mcool"], 50_000)
        assert clr.chromsizes.to_dict() == {"chr19": 1_000_000}
        assert clr.matrix(balance=False)[:].sum() > 0
    finally:
        forget_remote_maps(close=True)
