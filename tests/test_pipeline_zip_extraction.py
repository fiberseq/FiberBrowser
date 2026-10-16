"""Zip deliveries extract into a folder of their own and never write through a symlink.

Reproductions from the 29 Sep review: two archives with the same member name
(and equal byte length) shared one extracted path, so the second sample was
run on the first sample's reads; an existing symlink inside the run's reads
folder let extraction overwrite a file outside it.
"""
from __future__ import annotations

import os
import zipfile

import pytest

from test_pipeline_jobs import fake_env  # noqa: F401  (fixture)

MEMBER = "fastq_pass/barcode01/chunk.fastq"


def _zip(path, members: dict):
    with zipfile.ZipFile(path, "w") as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
    return str(path)


def test_archives_with_the_same_member_name_keep_their_own_reads(tmp_path):
    from services.pipeline_inputs import extract_zip_members

    payloads = ["@r1\nAAAA\n+\nIIII\n", "@r2\nCCCC\n+\nIIII\n"]  # same length, different reads
    dest = tmp_path / "output" / "reads"
    paths = []
    for i, payload in enumerate(payloads):
        archive = _zip(tmp_path / f"delivery{i}.zip", {MEMBER: payload})
        paths.append(extract_zip_members(archive, [MEMBER], str(dest))[MEMBER])
    assert paths[0] != paths[1]
    assert [open(p).read() for p in paths] == payloads
    for path in paths:
        assert os.path.commonpath([path, str(dest)]) == str(dest)


def test_same_named_archives_in_different_folders_do_not_collide(tmp_path):
    from services.pipeline_inputs import extract_zip_members

    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    first = _zip(tmp_path / "a" / "run.zip", {MEMBER: "@r1\nAAAA\n+\nIIII\n"})
    second = _zip(tmp_path / "b" / "run.zip", {MEMBER: "@r2\nCCCC\n+\nIIII\n"})
    dest = str(tmp_path / "reads")
    one = extract_zip_members(first, [MEMBER], dest)[MEMBER]
    two = extract_zip_members(second, [MEMBER], dest)[MEMBER]
    assert one != two and open(one).read() != open(two).read()


def test_a_reused_file_must_match_the_members_crc(tmp_path):
    from services.pipeline_inputs import extract_zip_members

    archive = _zip(tmp_path / "delivery.zip", {MEMBER: "@r1\nAAAA\n+\nIIII\n"})
    dest = str(tmp_path / "reads")
    path = extract_zip_members(archive, [MEMBER], dest)[MEMBER]
    with open(path, "w") as handle:  # same size, other bytes (a stale or damaged copy)
        handle.write("@r9\nGGGG\n+\nIIII\n")
    assert extract_zip_members(archive, [MEMBER], dest)[MEMBER] == path
    assert open(path).read() == "@r1\nAAAA\n+\nIIII\n"


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks")
def test_an_existing_symlink_in_the_reads_folder_is_never_followed(tmp_path):
    from services.pipeline_inputs import InputError, extract_zip_members, zip_namespace

    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / "sample.fastq"
    victim.write_text("original")
    archive = _zip(tmp_path / "reads.zip", {"delivery/sample.fastq": "OVERWRITTEN BY ZIP"})
    dest = tmp_path / "run" / "reads"
    with zipfile.ZipFile(archive) as handle:
        namespace = dest / zip_namespace(archive, handle)
    namespace.mkdir(parents=True)

    # A symlinked folder on the member's path.
    (namespace / "delivery").symlink_to(outside, target_is_directory=True)
    with pytest.raises(InputError):
        extract_zip_members(archive, ["delivery/sample.fastq"], str(dest))
    assert victim.read_text() == "original"

    # A symlink in place of the file itself.
    (namespace / "delivery").unlink()
    (namespace / "delivery").mkdir()
    (namespace / "delivery" / "sample.fastq").symlink_to(victim)
    with pytest.raises(InputError):
        extract_zip_members(archive, ["delivery/sample.fastq"], str(dest))
    assert victim.read_text() == "original"

    # The archive's own folder, or the reads folder, being a symlink.
    (namespace / "delivery" / "sample.fastq").unlink()
    for link in (namespace, dest):
        target = tmp_path / f"elsewhere-{link.name}"
        os.rename(link, target)
        link.symlink_to(target, target_is_directory=True)
        with pytest.raises(InputError):
            extract_zip_members(archive, ["delivery/sample.fastq"], str(dest))
        link.unlink()
        os.rename(target, link)
    assert victim.read_text() == "original"
    assert not any(p.name.endswith(".partial") for p in outside.iterdir())

    out = extract_zip_members(archive, ["delivery/sample.fastq"], str(dest))
    assert open(out["delivery/sample.fastq"]).read() == "OVERWRITTEN BY ZIP"
    assert out["delivery/sample.fastq"] == str(namespace / "delivery" / "sample.fastq")


def test_submit_extracts_every_archive_before_any_job_starts(fake_env, client, monkeypatch):
    """Two samples, two archives with the same member name: distinct reads, and no job is
    registered (started) while another sample's archive is still being extracted."""
    from test_pipeline_jobs import _fasta
    from services import pipeline_inputs, pipeline_jobs

    archives = [_zip(fake_env / f"delivery{i}.zip", {MEMBER: payload})
                for i, payload in enumerate(["@r1\nAAAA\n+\nIIII\n", "@r2\nCCCC\n+\nIIII\n"])]
    events = []
    real_extract = pipeline_inputs.extract_zip_members
    real_create = pipeline_jobs.JobManager.create

    def extract(*args, **kwargs):
        events.append("extract")
        return real_extract(*args, **kwargs)

    def create(self, spec, admit=None):
        events.append("create")
        return real_create(self, spec)

    monkeypatch.setattr(pipeline_inputs, "extract_zip_members", extract)
    monkeypatch.setattr(pipeline_jobs.JobManager, "create", create)
    body = {"samples": [{"name": f"s{i}", "files": [{"path": MEMBER, "zip": archive, "member": MEMBER,
                                                      "kind": "fastq"}]}
                        for i, archive in enumerate(archives)],
            "reference": {"kind": "file", "path": _fasta(fake_env / "ref.fa")},
            "enzyme": "dddb", "output_root": str(fake_env / "runs" / "r1"), "cores": 1,
            "options": {"dedup": "off"}}
    result = client.post("/api/pipeline/jobs", json=body).json()
    assert result["success"], result
    assert events == ["extract", "extract", "create", "create"]
    reads = [job["reads"][0] for job in result["jobs"]]
    assert reads[0] != reads[1]
    assert [open(path).read() for path in reads] == ["@r1\nAAAA\n+\nIIII\n", "@r2\nCCCC\n+\nIIII\n"]
    manager = pipeline_jobs.get_job_manager()
    for job in result["jobs"]:
        manager.cancel(job["id"])
    manager.stop()
