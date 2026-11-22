"""A panel genome's annotation over the download warning size (3.1.1 deferred MED).

The attach flow had no confirmation: the attach endpoint set no download policy (so a large annotation was
downloaded without asking), and a caller that did set one got a sequence-only reference it could never confirm.
The endpoint now takes ``confirm_large`` like /api/load_genome: unconfirmed, a download over the warning size is
answered ``needs_confirmation`` with ``download``; the confirmed retry downloads it into the same reference.
"""
from __future__ import annotations

import pysam
import pytest

from state.browser_state import BrowserState


def _fasta(tmp_path, name, length):
    path = tmp_path / name
    path.write_text(">chr1\n" + "A" * length + "\n")
    pysam.faidx(str(path))
    return str(path)


GTF = 'chr1\tsrc\ttranscript\t10\t50\t.\t+\t.\tgene_id "PG"; transcript_id "tPG"; gene_name "PG";\n'
BIG = 10_000


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A registry genome whose FASTA opens locally (unless ``fasta_big``: its download is over the warning size)
    and whose annotation is BIG bytes, over a 5 kB warning size. Downloads go through a fake ``fetch`` that obeys
    the request's download policy as the real one does (no policy: never refused)."""
    from models.domain import Dataset
    from services import genome_registry, http_download
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    monkeypatch.setenv("FIBERBROWSER_DOWNLOAD_WARN_BYTES", "5000")
    good = _fasta(tmp_path, "pg.fa", 300)
    downloads, refused = [], []
    opts = {"fasta_big": False}

    def asks(url):
        policy = http_download._policy.get()
        if policy is not None and not policy.get("confirmed"):
            event = {"kind": "confirm", "url": url, "bytes": BIG, "threshold": 5_000}
            if policy.get("events") is not None:
                policy["events"].append(event)
            refused.append(url)
            return True
        return False

    def fetch(url, dest, *a, **k):
        if asks(url):
            raise http_download.LargeDownload(url, BIG, 5_000)
        downloads.append(url)
        with open(dest, "w") as fh:
            fh.write(GTF)
    monkeypatch.setattr(http_download, "fetch", fetch)
    real = BrowserState._load_fasta

    def load_fasta(self, path, **k):
        if opts["fasta_big"] and asks(str(path)):
            return "Download over the warning size"
        return real(self, good)
    monkeypatch.setattr(BrowserState, "_load_fasta", load_fasta)
    info = {"name": "Pending GTF", "fasta_url": "https://example.invalid/pg.fa",
            "gtf_url": "https://example.invalid/pg.gtf"}
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, "pg", info)
    state = BrowserState(None)
    state.datasets["ds"] = Dataset("ds", [str(tmp_path / "x.bam")], "ds", data_type="bam")
    return state, downloads, refused, opts


def _attach(state, confirm_large=False):
    # Every argument given: called directly, an omitted one would be FastAPI's Body() marker.
    from routers.genome import attach_panel_genome_endpoint
    return attach_panel_genome_endpoint(dataset_ids=["ds"], genome_id="pg", fasta_path=None, gtf_path=None,
                                        contigs=False, span=0, confirm_large=confirm_large, state=state)


def test_the_attach_endpoint_asks_then_the_confirmed_retry_loads_the_annotation(env):
    from services import panel_genomes
    state, downloads, refused, _ = env
    first = _attach(state)
    assert first["success"] and first.get("needs_confirmation"), first
    assert first["download"]["url"].endswith("pg.gtf") and first["download"]["bytes"] == BIG
    assert first["genome"]["annotation_pending"] and not first["genome"]["has_gtf"]
    assert downloads == [] and len(refused) == 1                     # asked, nothing downloaded
    ctx = panel_genomes.contexts(state)["pg"]

    confirmed = _attach(state, confirm_large=True)
    assert confirmed["success"] and not confirmed.get("needs_confirmation"), confirmed
    assert confirmed["genome"]["has_gtf"] and confirmed["genome"]["annotation_pending"] is None
    assert downloads == ["https://example.invalid/pg.gtf"]
    assert panel_genomes.contexts(state)["pg"] is ctx                 # the same reference, completed

    again = _attach(state)                                            # complete: reused, nothing asked
    assert again["genome"]["has_gtf"] and not again.get("needs_confirmation") and len(downloads) == 1


def test_a_registry_fasta_over_the_warning_size_asks_and_attaches_nothing(env):
    from services import panel_genomes
    state, downloads, refused, opts = env
    opts["fasta_big"] = True
    first = _attach(state)
    assert not first["success"] and first.get("needs_confirmation"), first
    assert first["download"]["url"].endswith("pg.fa") and "error" not in first
    assert panel_genomes.assignments(state) == {} and panel_genomes.contexts(state) == {}
    confirmed = _attach(state, confirm_large=True)
    assert confirmed["success"] and confirmed["genome"]["has_fasta"] and confirmed["genome"]["has_gtf"]
    assert panel_genomes.assignments(state) == {"ds": "pg"}


def test_the_python_client_passes_the_confirmation():
    from browser_client import BrowserClient

    class Recorder(BrowserClient):
        def __init__(self):
            self.url = "http://test"
            self.calls = []

        def _post_response(self, endpoint, data=None, params=None, timeout=60, files=None):
            self.calls.append((endpoint, data))

            class R:
                def json(self_inner):
                    return {"success": True}
            return R()

    c = Recorder()
    c.attach_panel_genome(["ds"], genome_id="dm6")
    assert c.calls[-1] == ("/api/panel_genomes/attach",
                           {"dataset_ids": ["ds"], "genome_id": "dm6", "contigs": False, "span": 10_000,
                            "confirm_large": False})
    c.attach_panel_genome("ds", genome_id="dm6", confirm_large=True)
    assert c.calls[-1][1]["dataset_ids"] == ["ds"] and c.calls[-1][1]["confirm_large"] is True
    c.attach_panel_genome(["ds"], fasta_path="/x.fa", gtf_path="/x.gtf")
    assert c.calls[-1][1]["fasta_path"] == "/x.fa" and c.calls[-1][1]["gtf_path"] == "/x.gtf"
    c.detach_panel_genome(["ds"])
    assert c.calls[-1] == ("/api/panel_genomes/detach", {"dataset_ids": ["ds"]})


def test_a_failed_confirmed_annotation_download_keeps_it_pending_and_says_why(env, monkeypatch):
    # Codex R23: a confirmed retry whose download failed reported the genome complete (no pending notice, no error).
    from services import http_download
    state, downloads, refused, _ = env
    first = _attach(state)
    assert first.get("needs_confirmation") and first["genome"]["annotation_pending"]

    def broken(url, dest, *a, **k):
        raise OSError("connection reset")
    monkeypatch.setattr(http_download, "fetch", broken)
    failed = _attach(state, confirm_large=True)
    assert failed["success"] and not failed["genome"]["has_gtf"], failed
    assert failed["genome"]["annotation_pending"], failed           # still waits
    assert failed.get("annotation_error") and failed["genome"]["annotation_error"], failed
    assert failed.get("needs_confirmation")                           # the next confirmed retry may load it
