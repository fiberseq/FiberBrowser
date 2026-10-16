"""Stage test data in a real S3-compatible server (MinIO, or any store you point it at).

Opt-in: nothing here runs unless ``FIBERBROWSER_TEST_S3_ENDPOINT`` is set, and
it never touches AWS by default. Start a throwaway MinIO bound to this computer
only, for example::

    docker run -d --name fb-minio -p 127.0.0.1:9000:9000 \\
        -e MINIO_ROOT_USER=fbtest -e MINIO_ROOT_PASSWORD=fbtest-secret pgsty/minio server /data

(any MinIO image you can pull: Docker Hub's ``minio/minio`` was unavailable
in Oct 2026; the community build ``pgsty/minio`` worked.)
    export FIBERBROWSER_TEST_S3_ENDPOINT=http://127.0.0.1:9000
    export FIBERBROWSER_TEST_S3_ACCESS_KEY=fbtest FIBERBROWSER_TEST_S3_SECRET_KEY=fbtest-secret
    python -m pytest tests/test_s3_minio_integration.py
    (cd browser/frontend && npx playwright test tests/e2e/s3-remote.spec.ts)

``stage()`` creates two fresh buckets (``fbtest-<id>-private`` and a public
``fbtest-<id>-public``) with the demo BAM in several layouts; ``cleanup()``
deletes them. ``python tests/s3_minio.py stage`` prints the staged URLs as
JSON (the Playwright spec uses it); ``python tests/s3_minio.py cleanup <id>``.
"""
from __future__ import annotations

import json
import os
import sys
import uuid

ENDPOINT_ENV = "FIBERBROWSER_TEST_S3_ENDPOINT"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO_BAM = os.path.join(REPO, "browser", "data", "demo", "napa_ddda.bam")
DEMO_REGION = ("chr19", 47_514_000, 47_518_000)
DEMO_READS = 3202


def endpoint() -> str | None:
    return (os.environ.get(ENDPOINT_ENV) or "").strip() or None


def credentials() -> tuple[str, str]:
    return (os.environ.get("FIBERBROWSER_TEST_S3_ACCESS_KEY") or "minioadmin",
            os.environ.get("FIBERBROWSER_TEST_S3_SECRET_KEY") or "minioadmin")


def client():
    import boto3
    from botocore.client import Config
    key, secret = credentials()
    return boto3.client("s3", endpoint_url=endpoint(), aws_access_key_id=key, aws_secret_access_key=secret,
                        region_name=os.environ.get("FIBERBROWSER_TEST_S3_REGION") or "us-east-1",
                        config=Config(signature_version="s3v4"))


def _tiny_mcool(path: str) -> bool:
    try:
        import cooler
        import numpy as np
        import pandas as pd
    except ImportError:
        return False
    bins = cooler.binnify(pd.Series({"chr19": 1_000_000}), 10_000)
    rng = np.random.default_rng(7)
    i, j = rng.integers(0, len(bins), 2000), rng.integers(0, len(bins), 2000)
    pixels = pd.DataFrame({"bin1_id": np.minimum(i, j), "bin2_id": np.maximum(i, j), "count": 1})
    pixels = pixels.groupby(["bin1_id", "bin2_id"]).sum().reset_index()
    single = path[:-len(".mcool")] + ".cool"
    cooler.create_cooler(single, bins, pixels)
    cooler.zoomify_cooler(single, path, [10_000, 50_000], chunksize=100_000)
    os.remove(single)
    return True


def stage(workdir: str | None = None) -> dict:
    """Upload the demo BAM in every layout the tests need; returns their URLs."""
    import tempfile
    import pysam
    s3 = client()
    run = uuid.uuid4().hex[:10]
    private, public = f"fbtest-{run}-private", f"fbtest-{run}-public"
    for bucket in (private, public):
        s3.create_bucket(Bucket=bucket)
    s3.put_bucket_policy(Bucket=public, Policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{"Effect": "Allow", "Principal": {"AWS": ["*"]}, "Action": ["s3:GetObject"],
                       "Resource": [f"arn:aws:s3:::{public}/*"]}],
    }))
    workdir = workdir or tempfile.mkdtemp(prefix="fbtest-s3-")
    csi_bam = os.path.join(workdir, "napa_csi.bam")
    with open(DEMO_BAM, "rb") as src, open(csi_bam, "wb") as out:
        out.write(src.read())
    pysam.index(csi_bam, "-c")
    uploads = {
        (private, "lab/napa.bam"): DEMO_BAM,
        (private, "lab/napa.bam.bai"): DEMO_BAM + ".bai",
        (private, "lab/napa_csi.bam"): csi_bam,
        (private, "lab/napa_csi.bam.csi"): csi_bam + ".csi",
        (private, "lab/napa_noidx.bam"): DEMO_BAM,
        (private, "lab/napa_sep.bam"): DEMO_BAM,
        (private, "indexes/napa_sep_index.bai"): DEMO_BAM + ".bai",
        (public, "demo/napa.bam"): DEMO_BAM,
        (public, "demo/napa.bam.bai"): DEMO_BAM + ".bai",
    }
    mcool = os.path.join(workdir, "tiny.mcool")
    if _tiny_mcool(mcool):
        uploads[(private, "maps/tiny.mcool")] = mcool
    for (bucket, key), path in uploads.items():
        s3.upload_file(path, bucket, key)
    return {
        "run": run, "endpoint": endpoint(), "private": private, "public": public,
        "bam": f"s3://{private}/lab/napa.bam",
        "csi_bam": f"s3://{private}/lab/napa_csi.bam",
        "noidx_bam": f"s3://{private}/lab/napa_noidx.bam",
        "sep_bam": f"s3://{private}/lab/napa_sep.bam##idx##s3://{private}/indexes/napa_sep_index.bai",
        "missing_bam": f"s3://{private}/lab/missing.bam",
        "public_bam": f"s3://{public}/demo/napa.bam",
        "mcool": f"s3://{private}/maps/tiny.mcool" if (private, "maps/tiny.mcool") in uploads else None,
        "region": list(DEMO_REGION), "reads": DEMO_READS,
    }


def cleanup(run: str) -> None:
    s3 = client()
    for bucket in (f"fbtest-{run}-private", f"fbtest-{run}-public"):
        try:
            for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
                for obj in page.get("Contents", []) or []:
                    s3.delete_object(Bucket=bucket, Key=obj["Key"])
            s3.delete_bucket(Bucket=bucket)
        except Exception as exc:  # already gone
            print(f"cleanup {bucket}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    if not endpoint():
        sys.exit(f"Set {ENDPOINT_ENV} (an S3-compatible server you control, e.g. a local MinIO).")
    if sys.argv[1:2] == ["stage"]:
        print(json.dumps(stage()))
    elif sys.argv[1:2] == ["cleanup"] and len(sys.argv) == 3:
        cleanup(sys.argv[2])
    else:
        sys.exit("usage: s3_minio.py stage | cleanup <run>")
