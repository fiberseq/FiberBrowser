"""S3 and https:// BAM/contact-map access end to end, with no cloud account.

Objects are served by the range-capable test server (``link_fixtures``); for
``s3://`` a fake boto3 client answers HEAD/GET from the same folder and
"pre-signs" by handing out the server's URL, so the real path is exercised:
``s3://`` -> boto3 URL -> htslib/h5py range reads, indexes in the cache.
The opt-in test against a real S3-compatible server is
``test_s3_minio_integration.py``.
"""
from __future__ import annotations

import datetime
import os
import shutil

import pysam
import pytest

from link_fixtures import LinkServer, needs_pybigwig_urls

botocore_exceptions = pytest.importorskip("botocore.exceptions")
ClientError = botocore_exceptions.ClientError


# ---------------------------------------------------------------- fixtures

def _write_bam(path: str, chrom: str, n: int, *, csi: bool = False, start: int = 1000) -> str:
    header = {"HD": {"VN": "1.6", "SO": "coordinate"},
              "SQ": [{"SN": "chr1", "LN": 5_000_000}, {"SN": "chr2", "LN": 5_000_000}]}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with pysam.AlignmentFile(path, "wb", header=header) as out:
        for i in range(n):
            read = pysam.AlignedSegment(out.header)
            read.query_name = f"{chrom}_r{i}"
            read.reference_id = out.header.get_tid(chrom)
            read.reference_start = start + i * 100
            read.query_sequence = "A" * 50
            read.query_qualities = pysam.qualitystring_to_array("I" * 50)
            read.cigartuples = [(0, 50)]
            read.mapping_quality = 60
            out.write(read)
    if csi:
        pysam.index(path, "-c")
    else:
        pysam.index(path)
    return path


def _count(bam, chrom: str) -> int:
    return sum(1 for _ in bam.fetch(chrom))


@pytest.fixture
def served(tmp_path, monkeypatch):
    """Two BAMs both named sample.bam (different contigs), a .csi-only BAM, one
    without an index, one whose index lives elsewhere; served over HTTP."""
    root = tmp_path / "srv"
    _write_bam(str(root / "runA" / "sample.bam"), "chr1", 30)
    _write_bam(str(root / "runB" / "sample.bam"), "chr2", 7)
    _write_bam(str(root / "lab" / "csi_only.bam"), "chr1", 11, csi=True)
    _write_bam(str(root / "lab" / "noidx.bam"), "chr1", 5)
    os.remove(str(root / "lab" / "noidx.bam.bai"))
    _write_bam(str(root / "lab" / "sep.bam"), "chr2", 9)
    os.makedirs(root / "indexes")
    shutil.move(str(root / "lab" / "sep.bam.bai"), str(root / "indexes" / "sep_index.bai"))
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)  # htslib used to save remote indexes here
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(tmp_path / "cache"))
    from services.remote_sources import opening
    opening.forget_remote_state()
    server = LinkServer(str(root))
    try:
        yield server, root, cwd, tmp_path / "cache"
    finally:
        server.close()
        opening.forget_remote_state()


class _FakeS3Client:
    """head/get/presign over a local folder; ``public`` keys are readable anonymously."""

    def __init__(self, root, base_url, *, anonymous=False, bad_keys=False, public=(), endpoint=None):
        self.root, self.base_url = str(root), base_url
        self.anonymous, self.bad_keys, self.public = anonymous, bad_keys, set(public)
        self.calls = []

        class _Meta:
            endpoint_url = endpoint or "https://s3.amazonaws.com"
            region_name = "us-east-1"
        self.meta = _Meta()

    def _check(self, op, Bucket, Key):
        self.calls.append((op, Bucket, Key))
        if self.bad_keys:
            raise ClientError({"Error": {"Code": "403" if op == "HeadObject" else "SignatureDoesNotMatch"}}, op)
        if self.anonymous and f"{Bucket}/{Key}" not in self.public and Bucket not in self.public:
            raise ClientError({"Error": {"Code": "403"}}, op)
        path = os.path.join(self.root, Key)
        if not os.path.isfile(path):
            raise ClientError({"Error": {"Code": "404"}}, op)
        return path

    def head_object(self, Bucket, Key):
        path = self._check("HeadObject", Bucket, Key)
        stat = os.stat(path)
        return {"ContentLength": stat.st_size, "ETag": f'"{stat.st_mtime_ns}-{stat.st_size}"',
                "LastModified": datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc)}

    def get_object(self, Bucket, Key, Range=None):
        path = self._check("GetObject", Bucket, Key)
        import io
        data = open(path, "rb").read()
        return {"Body": io.BytesIO(data[:1] if Range else data)}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        if self.anonymous:
            raise botocore_exceptions.NoCredentialsError()
        return f"{self.base_url}/{Params['Key']}?X-Amz-Expires={ExpiresIn}&X-Amz-Signature=secret"


@pytest.fixture
def fake_s3(served, monkeypatch):
    """The global S3Manager wired to the served folder (bucket name ignored)."""
    server, root, cwd, cache = served
    from s3_utils import s3_manager
    signed = _FakeS3Client(root, server.base)
    anon = _FakeS3Client(root, server.base, anonymous=True)
    for name, value in {"_client": signed, "_anon_client": anon, "_configured": True,
                        "_endpoint_url": server.base, "_presigned_cache": {}, "_access_mode": {},
                        "_bucket_regions": {}, "_regional_clients": {}, "_method": "profile",
                        "_profile": "lab", "_session": None}.items():
        monkeypatch.setattr(s3_manager, name, value, raising=False)
    return s3_manager, signed, anon, served


# ---------------------------------------------------------------- https://

def test_same_named_https_bams_each_read_with_their_own_index(served):
    """htslib saved a remote index into the working directory under its basename
    and reused it for the next BAM of that name: runB/sample.bam read with
    runA's index gave 0 reads, silently."""
    server, _root, cwd, cache = served
    from services.remote_sources.opening import open_alignment_file
    with open_alignment_file(server.url("runA/sample.bam")) as bam:
        assert _count(bam, "chr1") == 30
    with open_alignment_file(server.url("runB/sample.bam")) as bam:
        assert _count(bam, "chr2") == 7
    assert os.listdir(cwd) == []  # nothing written beside the server
    assert len(os.listdir(cache / "index")) == 2


def test_https_index_is_downloaded_once_and_renewed_when_the_bam_changes(served):
    server, root, _cwd, cache = served
    from services.remote_sources import opening
    url = server.url("runA/sample.bam")
    with opening.open_alignment_file(url) as bam:
        assert _count(bam, "chr1") == 30
    index_hits = sum(1 for hit in server.hits if hit.endswith(".bai"))
    for _ in range(2):
        with opening.open_alignment_file(url) as bam:
            assert _count(bam, "chr1") == 30
    assert sum(1 for hit in server.hits if hit.endswith(".bai")) == index_hits  # not fetched again
    # The BAM is rewritten in place (another sample, other contig, same name).
    _write_bam(str(root / "runA" / "sample.bam"), "chr2", 12, start=5000)
    opening.forget_remote_state()  # (the 30 s memo)
    with opening.open_alignment_file(url) as bam:
        assert _count(bam, "chr2") == 12 and _count(bam, "chr1") == 0
    assert len(os.listdir(cache / "index")) == 2


def test_https_csi_only_bam_validates_and_opens(served):
    server, *_ = served
    from utils.validation import validate_remote_bam
    from services.remote_sources.opening import open_alignment_file
    result = validate_remote_bam(server.url("lab/csi_only.bam"))
    assert result["valid"] and result["index_url"].endswith("csi_only.bam.csi"), result
    with open_alignment_file(server.url("lab/csi_only.bam")) as bam:
        assert _count(bam, "chr1") == 11


def test_https_bam_with_its_index_at_another_url(served):
    server, *_ = served
    from services.remote_sources.opening import open_alignment_file
    path = f"{server.url('lab/sep.bam')}##idx##{server.url('indexes/sep_index.bai')}"
    with open_alignment_file(path) as bam:
        assert _count(bam, "chr2") == 9


def test_presigned_https_bam_without_its_index_link_says_how_to_add_it(served):
    server, *_ = served
    server.signed["lab/sep.bam"] = "abc"
    from utils.validation import validate_remote_bam
    result = validate_remote_bam(server.url("lab/sep.bam"))
    assert not result["valid"] and "##idx##" in result["error"]
    both = validate_remote_bam(f"{server.url('lab/sep.bam')}##idx##{server.url('indexes/sep_index.bai')}")
    assert both["valid"], both


def test_an_unwritable_index_cache_is_named_not_a_crash(fake_s3, monkeypatch, tmp_path):
    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the cache folder should be")
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(blocked))
    from utils.validation import validate_remote_bam
    result = validate_remote_bam("s3://lab/runA/sample.bam")
    assert not result["valid"] and "FIBERBROWSER_REMOTE_CACHE" in result["error"]


# ---------------------------------------------------------------- s3://

def test_s3_bam_opens_through_boto3_url_with_cached_index(fake_s3):
    """htslib was handed the bare s3:// URL: without HTS_S3_HOST / s3+http:// it
    went to AWS, so a bucket on any other endpoint loaded as a dataset with no
    contigs and no reads, and no error."""
    manager, signed, _anon, (server, _root, cwd, cache) = fake_s3
    from services.remote_sources.opening import open_alignment_file
    with open_alignment_file("s3://lab/runA/sample.bam") as bam:
        assert _count(bam, "chr1") == 30
    with open_alignment_file("s3://lab/runB/sample.bam") as bam:
        assert _count(bam, "chr2") == 7
    assert os.listdir(cwd) == []
    # The data went through pre-signed URLs; the indexes through boto3 GETs.
    assert any("X-Amz-Signature" in hit for hit in server.hits if "runA/sample.bam" in hit)
    assert ("GetObject", "lab", "runA/sample.bam.bai") in signed.calls


def test_s3_bam_handles_and_errors_never_show_the_signed_url(fake_s3, caplog):
    from services.bam_handles import get_bam_handle
    handle = get_bam_handle("s3://lab/runA/sample.bam")
    assert handle is not None and _count(handle, "chr1") == 30
    assert get_bam_handle("s3://lab/runA/sample.bam") is handle  # cached
    assert get_bam_handle("s3://lab/missing.bam") is None
    out = caplog.text
    assert "s3://lab/missing.bam" in out and "X-Amz-Signature" not in out


def test_s3_validation_accepts_csi_and_separate_index_and_names_problems(fake_s3):
    from utils.validation import validate_remote_bam
    assert validate_remote_bam("s3://lab/lab/csi_only.bam")["valid"]
    sep = validate_remote_bam("s3://lab/lab/sep.bam##idx##s3://lab/indexes/sep_index.bai")
    assert sep["valid"], sep
    missing_index = validate_remote_bam("s3://lab/lab/noidx.bam")
    assert not missing_index["valid"] and ".csi" in missing_index["error"] and "##idx##" in missing_index["error"]
    missing = validate_remote_bam("s3://lab/lab/nothing.bam")
    assert not missing["valid"] and missing["error"].startswith("Object not found: s3://lab/lab/nothing.bam (on ")
    wrong_index = validate_remote_bam("s3://lab/lab/sep.bam##idx##s3://lab/indexes/nope.bai")
    assert not wrong_index["valid"] and "nope.bai" in wrong_index["error"]


def test_s3_separate_index_opens(fake_s3):
    from services.remote_sources.opening import open_alignment_file
    with open_alignment_file("s3://lab/lab/sep.bam##idx##s3://lab/indexes/sep_index.bai") as bam:
        assert _count(bam, "chr2") == 9


def test_public_object_is_opened_by_plain_url_when_the_credentials_are_refused(fake_s3, monkeypatch):
    """A pre-signed URL made from credentials the bucket refuses is refused too,
    even for a public object: such objects are read by their plain URL."""
    manager, _signed, _anon, (server, root, _cwd, _cache) = fake_s3
    monkeypatch.setattr(manager, "_client", _FakeS3Client(root, server.base, bad_keys=True))
    monkeypatch.setattr(manager, "_anon_client", _FakeS3Client(root, server.base, anonymous=True, public={"lab"}))
    url = manager.open_url("s3://lab/runA/sample.bam")
    assert url == f"{server.base}/lab/runA/sample.bam"
    assert "Signature" not in url


def test_wrong_keys_are_named_as_wrong_keys(fake_s3, monkeypatch):
    manager, _signed, _anon, (server, root, _cwd, _cache) = fake_s3
    monkeypatch.setattr(manager, "_client", _FakeS3Client(root, server.base, bad_keys=True))
    result = manager.test_access("s3://lab/runA/sample.bam")
    assert not result["accessible"]
    assert "rejected profile 'lab'" in result["error"] and "SignatureDoesNotMatch" in result["error"]


def test_no_credentials_and_private_bucket_says_so(fake_s3, monkeypatch):
    manager, _signed, _anon, (server, root, _cwd, _cache) = fake_s3

    class _NoCreds(_FakeS3Client):
        def head_object(self, Bucket, Key):
            raise botocore_exceptions.NoCredentialsError()

    monkeypatch.setattr(manager, "_client", _NoCreds(root, server.base))
    result = manager.test_access("s3://lab/runA/sample.bam")
    assert result["error"] == "Access denied: the bucket is not public and no credentials are configured"


# ---------------------------------------------------------------- S3Manager configuration

@pytest.fixture
def aws_files(tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.write_text(
        "[profile lab]\nregion = eu-west-2\nendpoint_url = http://127.0.0.1:9\n\n"
        "[profile eu]\nregion = eu-west-2\n")
    creds = tmp_path / "credentials"
    creds.write_text("[lab]\naws_access_key_id = AKIDLAB\naws_secret_access_key = s3cret\n\n"
                     "[eu]\naws_access_key_id = AKIDEU\naws_secret_access_key = s3cret\n")
    monkeypatch.setenv("AWS_CONFIG_FILE", str(config))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(creds))
    for name in ("AWS_PROFILE", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                 "AWS_S3_ENDPOINT_URL", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    from s3_utils import S3Manager
    return S3Manager()


def test_endpoint_and_region_set_in_the_profile_are_used(aws_files):
    """An endpoint_url in the AWS profile reached boto3 but not the anonymous
    client or the public URLs, and the profile's region was overridden to us-east-1."""
    manager = aws_files
    result = manager.configure(profile="lab")
    assert result["endpoint_url"] == "http://127.0.0.1:9" and result["region"] == "eu-west-2"
    assert manager._get_anon_client().meta.endpoint_url == "http://127.0.0.1:9"
    assert manager.public_url("s3://b/k.bam") == "http://127.0.0.1:9/b/k.bam"
    assert manager.configure(profile="eu")["region"] == "eu-west-2"


def test_reconfiguring_the_endpoint_rebuilds_the_anonymous_client(aws_files):
    """configure() kept the anonymous client built before it, so public buckets
    kept going to AWS after an endpoint was set (until a restart)."""
    manager = aws_files
    manager.configure()
    assert "amazonaws.com" in manager._get_anon_client().meta.endpoint_url
    manager.configure(endpoint_url="http://127.0.0.1:19")
    assert manager._get_anon_client().meta.endpoint_url == "http://127.0.0.1:19"


def test_configure_does_not_leak_the_profile_into_the_environment(aws_files):
    """setup_s3_environment exported AWS_PROFILE, so a later default-chain
    configuration silently kept the old profile."""
    from services import s3_support
    import s3_utils
    original = s3_utils.s3_manager
    s3_utils.s3_manager = aws_files
    s3_support._S3_LOADED = False
    try:
        assert s3_support.configure(profile="lab")["success"]
        assert "AWS_PROFILE" not in os.environ
    finally:
        s3_utils.s3_manager = original
        s3_support._S3_LOADED = False


def test_keys_with_hash_and_spaces(aws_files):
    from s3_utils import S3Manager
    assert S3Manager.parse_s3_url("s3://b/x.bam##idx##s3://b/x.bai") == ("b", "x.bam##idx##s3://b/x.bai")
    manager = aws_files
    manager.configure(region="us-east-1")
    assert manager.public_url("s3://lab-data/run 1/a#b.bam") == "https://lab-data.s3.amazonaws.com/run%201/a%23b.bam"
    assert manager.public_url("s3://lab.data/a.bam") == "https://s3.amazonaws.com/lab.data/a.bam"


def test_presigned_urls_name_the_buckets_own_region(aws_files, monkeypatch):
    """A URL signed for us-east-1 is refused by a bucket in another region."""
    manager = aws_files
    manager.configure(profile="eu", region="us-east-1")

    def head_bucket(Bucket):
        raise ClientError({"Error": {"Code": "403"}, "ResponseMetadata": {
            "HTTPHeaders": {"x-amz-bucket-region": "ap-southeast-2"}}}, "HeadBucket")

    monkeypatch.setattr(manager._client, "head_bucket", head_bucket)
    url = manager.get_presigned_url("s3://lab-sydney/a.bam")
    assert "ap-southeast-2" in url and "X-Amz-Signature" in url


# ---------------------------------------------------------------- footprint classes

def test_footprint_class_runs_refuse_remote_bams_with_guidance():
    """FiberHMM opens the BAM by name: an s3:// dataset failed inside the job with
    "Could not open alignment file ... 's3:/lab/x.bam'" (and https:// the same way)."""
    from types import SimpleNamespace
    from services import consensus_workflow as cw

    class _State:
        def __init__(self, datasets):
            self._ds = datasets

        def get_dataset(self, dsid):
            return self._ds.get(dsid)

    for url in ("s3://lab/run1.bam", "https://data.example.org/run1.bam"):
        ds = SimpleNamespace(path=url, paths=[url], label="run1", data_type="bam")
        with pytest.raises(ValueError, match="read over the network.*samtools view -b"):
            cw._snapshot(_State({"a": ds}), ["a"])


# ---------------------------------------------------------------- network down mid-browse

class _BrokenBam:
    references = ("chr1",)
    header = {}

    def fetch(self, *args):
        raise OSError("truncated file")


def test_a_remote_read_that_breaks_is_an_error_not_an_empty_region(monkeypatch):
    """The read loader swallowed the error: the region showed no reads (cached),
    and the broken htslib handle kept failing after the network came back."""
    from services import compact_read_loader as loader
    from services import bam_handles
    from services.remote_sources.base import RemoteReadError
    monkeypatch.setattr(loader, "bam_consensus_contracts", lambda header: {}, raising=False)
    discarded = []
    monkeypatch.setattr(bam_handles, "discard_bam_handle", lambda path: discarded.append(path))
    with pytest.raises(RemoteReadError, match="s3://lab/run1.bam failed at chr1:0-1000.*truncated file"):
        loader._build_compact_reads_from_bam_region(
            "s3://lab/run1.bam", "chr1", 0, 1000, bam_handle_getter=lambda path: _BrokenBam())
    assert discarded == ["s3://lab/run1.bam"]
    with pytest.raises(RemoteReadError, match="Could not open https://data.example.org/x.bam"):
        loader._build_compact_reads_from_bam_region(
            "https://data.example.org/x.bam", "chr1", 0, 1000, bam_handle_getter=lambda path: None)
    # A local file keeps the old behaviour (nothing to reconnect to).
    assert loader._build_compact_reads_from_bam_region(
        __file__, "chr1", 0, 1000, bam_handle_getter=lambda path: None) == []


def test_discarding_a_remote_handle_reopens_it_next_time(fake_s3):
    from services.bam_handles import discard_bam_handle, get_bam_handle
    first = get_bam_handle("s3://lab/runA/sample.bam")
    discard_bam_handle("s3://lab/runA/sample.bam")
    second = get_bam_handle("s3://lab/runA/sample.bam")
    assert second is not first and _count(second, "chr1") == 30


@needs_pybigwig_urls
def test_s3_bigwig_and_bigbed_tracks_open(fake_s3):
    """Tracks went to pyBigWig as s3:// ("Received an error during file opening")."""
    from link_fixtures import write_bigwig
    _manager, _signed, _anon, (server, root, _cwd, _cache) = fake_s3
    os.makedirs(root / "tracks", exist_ok=True)
    write_bigwig(str(root / "tracks" / "signal.bw"))
    from services.remote_sources.opening import open_bigwig
    handle = open_bigwig("s3://lab/tracks/signal.bw")
    try:
        assert "chr19" in handle.chroms()
    finally:
        handle.close()
    with pytest.raises(RuntimeError, match="Object not found: s3://lab/tracks/none.bw"):
        open_bigwig("s3://lab/tracks/none.bw")


def test_cached_copies_keep_their_names(fake_s3):
    """A plasmid map's loader looks at its extension: '#' in an s3:// key is part of the name."""
    _manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    os.makedirs(root / "maps", exist_ok=True)
    (root / "maps" / "p#1.gb").write_bytes(b"LOCUS x")
    from services.remote_sources.opening import local_copy
    local = local_copy("s3://lab/maps/p#1.gb")
    assert local.endswith("/p#1.gb") and open(local, "rb").read() == b"LOCUS x"


# ---------------------------------------------------------------- Codex review follow-ups

def test_an_explicit_index_is_part_of_the_handle(fake_s3):
    """The handle cache keyed s3 handles by the BAM alone: correcting the index
    (##idx##) on the same worker kept the handle opened with the old one."""
    from services.bam_handles import get_bam_handle
    _manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    shutil.copy(str(root / "runB" / "sample.bam.bai"), str(root / "indexes" / "wrong.bai"))
    wrong = get_bam_handle("s3://lab/lab/sep.bam##idx##s3://lab/indexes/wrong.bai")
    right = get_bam_handle("s3://lab/lab/sep.bam##idx##s3://lab/indexes/sep_index.bai")
    assert right is not wrong and _count(right, "chr2") == 9


def test_a_replaced_remote_bam_gets_a_fresh_handle(fake_s3, monkeypatch):
    """A handle in use was reused forever: a public object's URL never changes,
    so a BAM replaced in the bucket kept being read with its old index."""
    from services import bam_handles
    _manager, _signed, _anon, (_server, root, _cwd, _cache) = fake_s3
    first = bam_handles.get_bam_handle("s3://lab/runA/sample.bam")
    assert _count(first, "chr1") == 30
    _write_bam(str(root / "runA" / "sample.bam"), "chr2", 12, start=5000)
    from services.remote_sources import opening
    opening.forget_remote_state()
    assert bam_handles.get_bam_handle("s3://lab/runA/sample.bam") is first  # checked every 30 s, not every call
    monkeypatch.setattr(bam_handles, "REMOTE_VERSION_CHECK_S", -1.0)
    fresh = bam_handles.get_bam_handle("s3://lab/runA/sample.bam")
    assert fresh is not first and _count(fresh, "chr2") == 12 and _count(fresh, "chr1") == 0


def test_https_never_falls_back_to_htslibs_working_directory_index(served, monkeypatch, tmp_path):
    """When the index couldn't be cached, an https:// BAM was opened by htslib,
    which reuses a same-named index in the working directory (another run's)."""
    server, root, cwd, _cache = served
    shutil.copy(str(root / "runA" / "sample.bam.bai"), str(cwd / "sample.bam.bai"))  # another run's
    blocked = tmp_path / "blocked"
    blocked.write_text("not a folder")
    monkeypatch.setenv("FIBERBROWSER_REMOTE_CACHE", str(blocked))
    from services.remote_sources.opening import open_alignment_file
    with pytest.raises(OSError, match="FIBERBROWSER_REMOTE_CACHE"):
        open_alignment_file(server.url("runB/sample.bam"))


def test_urls_signed_under_old_settings_are_not_cached_after_a_reconfigure(aws_files):
    manager = aws_files
    manager.configure(endpoint_url="http://127.0.0.1:1")
    started = manager.generation

    class _SlowSigner:
        def generate_presigned_url(self, *args, **kwargs):
            manager.configure(endpoint_url="http://127.0.0.1:2")  # another request, meanwhile
            return "http://127.0.0.1:1/b/k.bam?X-Amz-Signature=old"

    manager._signing_client = lambda bucket: _SlowSigner()
    manager.get_presigned_url("s3://b/k.bam")
    assert manager.generation == started + 1
    assert "s3://b/k.bam" not in manager._presigned_cache


def test_a_dropped_s3_download_is_a_named_error(fake_s3, monkeypatch):
    manager, signed, _anon, _served = fake_s3

    class _Body:
        def read(self, n):
            raise botocore_exceptions.ResponseStreamingError(error="connection reset")

        def close(self):
            pass

    monkeypatch.setattr(signed, "get_object", lambda **kw: {"Body": _Body()})
    with pytest.raises(OSError, match="Reading s3://lab/runA/sample.bam.bai failed"):
        manager.get_object_bytes("s3://lab/runA/sample.bam.bai", 1000)
