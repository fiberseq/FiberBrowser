"""POST /api/load_genome when the genome is already there, and two loads of one genome at once (3.0.0 audit HIGH-1).

A session restore asked the server for its saved genome (hg38) although the server had the user's --fasta hg38.fa
(genome id inferred from the name) loaded: the load downloaded the 3 GB registry FASTA over it, and a second tab's
restore started a second download into the same .download.tmp.
"""
import threading
import time
import urllib.request

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from state.browser_state import BrowserState


def _user_fasta(tmp_path):
    fa = tmp_path / "hg38.fa"
    fa.write_text(">chr1\n" + "ACGT" * 50 + "\n")
    import pysam
    pysam.faidx(str(fa))
    return fa


def _no_downloads(monkeypatch):
    calls = []

    def refuse(url, *a, **k):
        calls.append(url)
        raise AssertionError(f"downloaded {url}")
    monkeypatch.setattr("services.http_download.fetch", refuse)
    return calls


def _client(state):
    from routers.genome import router
    from state.dependencies import get_state
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    return TestClient(app)


def test_the_current_genome_with_a_user_fasta_is_not_downloaded_again(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    state = BrowserState(None)
    fa = _user_fasta(tmp_path)
    assert state._load_fasta(str(fa)) is None
    state.current_genome = "hg38"  # inferred from hg38.fa at start-up
    handle = state.fasta
    downloads = _no_downloads(monkeypatch)
    monkeypatch.setattr(state, "_load_fasta", lambda *a, **k: pytest.fail("the FASTA was reloaded"))

    res = _client(state).post("/api/load_genome", params={"genome_id": "hg38"})

    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True and body["already_loaded"] is True and body["fasta_loaded"] is True
    assert body["fasta_path"] == str(fa)
    assert state.fasta is handle and state.fasta_path == str(fa) and state.current_genome == "hg38"
    assert downloads == []
    assert not (tmp_path / "home" / ".fiberhmm" / "genomes").exists()


def test_another_genome_still_loads(tmp_path, monkeypatch):
    """Only the loaded genome is a no-op: asking for another one loads it."""
    from services.genome_loading import load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    state = BrowserState(None)
    state._load_fasta(str(_user_fasta(tmp_path)))
    state.current_genome = "hg38"
    asked = []
    monkeypatch.setattr(state, "_load_fasta", lambda path, **k: asked.append(path))
    load_genome_blocking(state, "mm10", {"name": "Mouse", "fasta_url": "https://example.invalid/mm10.fa"})
    assert asked == ["https://example.invalid/mm10.fa"]


def test_a_genome_without_its_fasta_loads(tmp_path, monkeypatch):
    """The genome id alone (annotation only, the FASTA failed before) is not 'loaded': the FASTA is tried again."""
    from services.genome_loading import load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    state = BrowserState(None)
    state.current_genome = "hg38"
    asked = []

    def fake_load(path, **k):
        asked.append(path)
        state.fasta = object()
    monkeypatch.setattr(state, "_load_fasta", fake_load)
    res = load_genome_blocking(state, "hg38", {"name": "Human", "fasta_url": "https://example.invalid/hg38.fa"})
    assert asked == ["https://example.invalid/hg38.fa"] and res["fasta_loaded"] is True
    assert "already_loaded" not in res


def test_two_loads_of_one_genome_at_once_load_it_once(tmp_path, monkeypatch):
    from services.genome_loading import load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    state = BrowserState(None)
    calls, inside, overlap = [], [0], []

    def slow_load(path, **k):
        inside[0] += 1
        overlap.append(inside[0])
        calls.append(path)
        time.sleep(0.3)
        state.fasta = object()
        state.fasta_path = "/cache/hg38.fa"
        inside[0] -= 1
    monkeypatch.setattr(state, "_load_fasta", slow_load)
    info = {"name": "Human", "fasta_url": "https://example.invalid/hg38.fa"}
    results = []
    threads = [threading.Thread(target=lambda: results.append(load_genome_blocking(state, "hg38", info))) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert calls == ["https://example.invalid/hg38.fa"] and max(overlap) == 1
    assert len(results) == 3 and all(r["success"] and r["fasta_loaded"] for r in results)
    assert sum(1 for r in results if r.get("already_loaded")) == 2


def test_two_downloads_of_one_fasta_at_once_share_one_download(tmp_path, monkeypatch):
    """The FASTA cache download itself: one in flight per source, no shared .download.tmp."""
    monkeypatch.setenv("HOME", str(tmp_path))
    fetched, inside, overlap = [], [0], []

    def fake_urlretrieve(url, dest, reporthook=None):
        inside[0] += 1
        overlap.append(inside[0])
        fetched.append(url)
        time.sleep(0.3)
        with open(dest, "w") as fh:
            fh.write("chr1\t200\t6\t200\t201\n" if url.endswith(".fai") else ">chr1\n" + "A" * 200 + "\n")
        inside[0] -= 1
    monkeypatch.setattr("services.http_download.fetch", fake_urlretrieve)
    url = "https://example.invalid/genomes/hg38.fa"
    paths = []
    threads = [threading.Thread(target=lambda: paths.append(BrowserState._download_fasta_to_cache(url, fasta_urls=[url])))
               for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert fetched.count(url) == 1 and max(overlap) == 1
    assert len(paths) == 2 and paths[0] == paths[1] and paths[0].endswith("hg38.fa")
    cache = tmp_path / ".fiberhmm" / "genomes"
    assert not list(cache.glob("*.tmp"))


def test_two_genomes_loaded_at_once_never_mix(tmp_path, monkeypatch):
    """Codex HIGH (fb62): hg38 installs its FASTA, mm10 completes, then hg38 finishes its annotation: the state
    ended as mm10 sequence under hg38's annotation and id, which the no-op then accepted. Loads now take turns."""
    import services.genome_loading as gl
    from services.genome_loading import genome_already_loaded, load_genome_blocking
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = tmp_path / ".fiberhmm" / "genomes"
    cache.mkdir(parents=True)
    state = BrowserState(None)

    def fake_fasta(path, **k):
        state.fasta = object()
        state.fasta_path = f"/cache/{path.rsplit('/', 1)[-1]}"
    monkeypatch.setattr(state, "_load_fasta", fake_fasta)

    def slow_gtf(url, path):
        time.sleep(0.4 if "hg38" in url else 0.0)
        open(path, "w").close()
    monkeypatch.setattr(gl, "_download_gtf", slow_gtf)
    monkeypatch.setattr("services.gene_annotations.load_gtf", lambda path: {"transcripts": [], "source": path})

    def info(g):
        return {"name": g, "fasta_url": f"https://example.invalid/{g}.fa", "gtf_url": f"https://example.invalid/{g}.gtf"}
    threads = [threading.Thread(target=load_genome_blocking, args=(state, "hg38", info("hg38")))]
    threads[0].start()
    time.sleep(0.1)
    threads.append(threading.Thread(target=load_genome_blocking, args=(state, "mm10", info("mm10"))))
    threads[1].start()
    for t in threads:
        t.join(10)
    genome = state.current_genome
    assert state.fasta_path == f"/cache/{genome}.fa"
    assert state.gtf_path.endswith(f"{genome}.gtf") and state.gtf_data["source"].endswith(f"{genome}.gtf")
    assert genome == "mm10"   # the second request ran after the first, whole


def test_the_no_op_refuses_a_mixed_reference(tmp_path, monkeypatch):
    from services.genome_loading import genome_already_loaded
    monkeypatch.setenv("HOME", str(tmp_path))
    state = BrowserState(None)
    state.fasta = object()
    state.current_genome = "hg38"
    state.fasta_path = "/cache/mm10.fa"                    # another genome's sequence under hg38's id
    assert not genome_already_loaded(state, "hg38")
    state.fasta_path = "/data/hg38.fa"                     # the user's FASTA named for it
    assert genome_already_loaded(state, "hg38")
    state.gtf_path = str(tmp_path / ".fiberhmm" / "genomes" / "mm10.gtf")   # another registry genome's annotation
    assert not genome_already_loaded(state, "hg38")
    state.gtf_path = "/data/my_annotation.gtf"             # a user's own annotation
    assert genome_already_loaded(state, "hg38")
    state.fasta_path = "/cache/GRCh38.primary.fa"          # the registry download, stamped when it was installed
    state.registry_fasta = ("hg38", "/cache/GRCh38.primary.fa")
    assert genome_already_loaded(state, "hg38")


def test_two_sources_with_one_file_name_never_share_a_cache_file(tmp_path, monkeypatch):
    """Codex HIGH (fb62): https://a/ref.fa and https://b/ref.fa both picked ref.fa (no .source yet) under
    different locks and wrote one ref.fa.download.tmp. Now one waits; the second takes a source-hashed name."""
    monkeypatch.setenv("HOME", str(tmp_path))
    inside, overlap = [0], []

    def fake_urlretrieve(url, dest, reporthook=None):
        inside[0] += 1
        overlap.append(inside[0])
        time.sleep(0.2)
        with open(dest, "w") as fh:
            if url.endswith(".fai"):
                fh.write("c\t100\t3\t100\t101\n")
            else:
                fh.write(">c\n" + ("A" if "//a" in url else "C") * 100 + "\n")
        inside[0] -= 1
    monkeypatch.setattr("services.http_download.fetch", fake_urlretrieve)
    urls = ["https://a.invalid/ref.fa", "https://b.invalid/ref.fa"]
    paths = {}
    threads = [threading.Thread(target=lambda u=u: paths.__setitem__(u, BrowserState._download_fasta_to_cache(u, fasta_urls=[u])))
               for u in urls]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert max(overlap) == 1
    assert paths[urls[0]] != paths[urls[1]]
    for url, path in paths.items():
        assert open(path).read().splitlines()[1][0] == ("A" if "//a" in url else "C")
        assert open(path + ".source").read().strip() == url
    # The existing cache stays readable under its name.
    assert BrowserState._download_fasta_to_cache(urls[0], fasta_urls=[urls[0]]) == paths[urls[0]]
