"""The S3 source behind the same browse/open UI (no network: a stub boto3 client)."""
from __future__ import annotations

import datetime

import pytest


class _StubClient:
    def __init__(self, objects):
        self.objects = objects  # key -> bytes

    def list_objects_v2(self, Bucket, Prefix, Delimiter, MaxKeys):
        prefixes, contents = set(), []
        for key, data in sorted(self.objects.items()):
            if not key.startswith(Prefix):
                continue
            rest = key[len(Prefix):]
            if Delimiter in rest:
                prefixes.add(Prefix + rest.split(Delimiter, 1)[0] + Delimiter)
            else:
                contents.append({"Key": key, "Size": len(data),
                                 "LastModified": datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)})
        return {"CommonPrefixes": [{"Prefix": p} for p in sorted(prefixes)], "Contents": contents, "IsTruncated": False}


@pytest.fixture
def s3(monkeypatch, tmp_path):
    from services import s3_support
    if not s3_support.is_available():
        pytest.skip("boto3 not installed")
    manager = s3_support.s3_manager
    objects = {
        "runs/a.bam": b"BAM", "runs/a.bam.bai": b"BAI", "runs/ref.fa": b">x\nACGT\n", "runs/ref.fa.fai": b"x\t4\n",
        "runs/sub/b.bb": b"BB", "maps/p.gb": b"MAP",
    }
    monkeypatch.setattr(manager, "_client", _StubClient(objects))
    monkeypatch.setattr(manager, "_configured", True)
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(tmp_path / "cache"))
    from services.remote_sources import get_source
    source = get_source("s3")
    monkeypatch.setattr(source, "stat", lambda ref: {"type": "file", "size": len(objects[ref.split("/", 3)[3]]),
                                                     "mtime": "2026-09-01"} if ref.split("/", 3)[3] in objects else None)
    monkeypatch.setattr(source, "fetch_bytes", lambda ref, max_bytes=0: objects[ref.split("/", 3)[3]])
    return source


def test_s3_listing_has_folders_kinds_and_index_presence(s3):
    from services.remote_endpoint import list_folder
    listing = list_folder("s3://lab/runs/")
    assert listing["success"], listing
    entries = {e["name"]: e for e in listing["entries"]}
    assert entries["sub"]["kind"] == "dir" and entries["sub"]["ref"] == "s3://lab/runs/sub"
    assert entries["a.bam"]["kind"] == "bam" and entries["a.bam"]["has_index"] is True
    assert entries["a.bam"]["ref"] == "s3://lab/runs/a.bam"
    assert entries["ref.fa"]["openable"] is False  # FASTA by range is an SSH feature
    assert listing["parent_ref"] == "s3://lab/"


def test_s3_plasmid_maps_are_fetched_whole(s3):
    from services.remote_sources.opening import local_copy
    local = local_copy("s3://lab/maps/p.gb")
    assert local.endswith("/p.gb") and open(local, "rb").read() == b"MAP"
    assert local_copy("/local/x.gb") == "/local/x.gb"


def test_s3_refs_count_as_reachable_for_path_checks(s3):
    from services.local_paths import path_access_error
    assert path_access_error("s3://lab/maps/p.gb") is None
    assert "not found" in path_access_error("s3://lab/maps/missing.gb")
