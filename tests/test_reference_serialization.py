"""Reference replacement is serialized per reference owner and never on the event loop (Codex round 2, fb62).

1. A session import (clear, annotation, genome id, FASTA) interleaved with a registry genome load: the import
   restored hg19 sequence under hg38's newly installed annotation and id.
2. Two requests on one panel genome get different GenomeView objects over one context: they took different
   locks and ended with mm10 sequence under hg38's annotation and id.
3. The async session-import route waited for the reference lock on the event loop: every other request stalled.
"""
import asyncio
import json
import threading
import time

import pytest

from state.browser_state import BrowserState


def _fasta(tmp_path, name, length):
    import pysam
    path = tmp_path / name
    path.write_text(">chr1\n" + "A" * length + "\n")
    pysam.faidx(str(path))
    return str(path)


def _gtf(tmp_path, name, gene):
    path = tmp_path / name
    path.write_text(f'chr1\tsrc\ttranscript\t10\t50\t.\t+\t.\tgene_id "{gene}"; transcript_id "t{gene}"; gene_name "{gene}";\n')
    return str(path)


def _paused_registry_load(state, monkeypatch, tmp_path, genome, fasta, gtf_gene):
    """A registry load of ``genome`` that pauses after installing its FASTA until ``release`` is set."""
    import services.genome_loading as gl
    installed, release = threading.Event(), threading.Event()
    real = state._load_fasta

    def load_fasta(path, **k):
        if str(path).startswith("https://"):
            err = real(fasta)
            installed.set()
            release.wait(10)
            return err
        return real(path, **k)
    monkeypatch.setattr(state, "_load_fasta", load_fasta)
    monkeypatch.setattr(gl, "_download_gtf", lambda url, path: open(path, "w").write(
        open(_gtf(tmp_path, f"{genome}.src.gtf", gtf_gene)).read()))
    info = {"name": genome, "fasta_url": f"https://example.invalid/{genome}.fa",
            "gtf_url": f"https://example.invalid/{genome}.gtf"}
    thread = threading.Thread(target=gl.load_genome_blocking, args=(state, genome, info))
    return thread, installed, release


def _genes(state):
    tx = (state.gtf_data or {}).get("transcripts")
    return set(tx["gene_name"]) if tx is not None and len(tx) else set()


def test_a_session_import_never_interleaves_with_a_genome_load(tmp_path, monkeypatch):
    from models.requests import SessionImportRequest
    from services.sessions_endpoint import import_session_for_request
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    state = BrowserState(None)
    hg38_fa = _fasta(tmp_path, "hg38_download.fa", 300)
    hg19_fa = _fasta(tmp_path, "hg19_session.fa", 200)
    hg19_gtf = _gtf(tmp_path, "hg19.gtf", "HG19GENE")
    load, installed, release = _paused_registry_load(state, monkeypatch, tmp_path, "hg38", hg38_fa, "HG38GENE")
    load.start()
    assert installed.wait(5)
    session = {"version": "2.0", "datasets": [], "reference": {"genome": "hg19", "fasta_path": hg19_fa},
               "gtf": {"path": hg19_gtf}}
    importer = threading.Thread(target=import_session_for_request, args=(state, SessionImportRequest(session=session)))
    importer.start()
    time.sleep(0.3)
    release.set()
    load.join(10)
    importer.join(10)
    # The import ran after the load, whole: the session's reference, coherently.
    assert (state.current_genome, state.fasta_path) == ("hg19", hg19_fa)
    assert state.fasta.get_reference_length("chr1") == 200
    assert _genes(state) == {"HG19GENE"}


def test_two_views_of_one_panel_genome_share_its_lock(tmp_path, monkeypatch):
    from services import panel_genomes
    from services.genome_loading import reference_lock, reference_owner
    state = BrowserState(None)
    ctx = BrowserState(None)
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    a = panel_genomes.genome_view(state, "other")
    b = panel_genomes.genome_view(state, "other")
    assert a is not b and reference_owner(a) is ctx is reference_owner(b)
    assert reference_lock(a) is reference_lock(b) is reference_lock(ctx)
    assert reference_lock(state) is not reference_lock(ctx)


def test_two_views_loading_genomes_into_one_panel_genome_end_coherent(tmp_path, monkeypatch):
    from services import panel_genomes
    from services.genome_loading import load_genome_blocking
    import services.genome_loading as gl
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    state = BrowserState(None)
    ctx = BrowserState(None)
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    fastas = {"hg38": _fasta(tmp_path, "hg38.fa", 300), "mm10": _fasta(tmp_path, "mm10.fa", 200)}

    def slow_gtf(url, path):
        time.sleep(0.4 if "hg38" in url else 0)
        gene = "HG38GENE" if "hg38" in url else "MM10GENE"
        open(path, "w").write(open(_gtf(tmp_path, f"src_{gene}.gtf", gene)).read())
    monkeypatch.setattr(gl, "_download_gtf", slow_gtf)
    real = BrowserState._load_fasta

    def load_fasta(self, path, **k):
        genome = "hg38" if "hg38" in str(path) else "mm10"
        return real(self, fastas[genome])
    monkeypatch.setattr(BrowserState, "_load_fasta", load_fasta)

    def info(g):
        return {"name": g, "fasta_url": f"https://example.invalid/{g}.fa", "gtf_url": f"https://example.invalid/{g}.gtf"}
    first = threading.Thread(target=load_genome_blocking, args=(panel_genomes.genome_view(state, "other"), "hg38", info("hg38")))
    first.start()
    time.sleep(0.1)
    second = threading.Thread(target=load_genome_blocking, args=(panel_genomes.genome_view(state, "other"), "mm10", info("mm10")))
    second.start()
    first.join(10)
    second.join(10)
    assert ctx.current_genome == "mm10" and ctx.fasta.get_reference_length("chr1") == 200
    assert _genes(ctx) == {"MM10GENE"}


def test_session_import_waits_for_the_reference_lock_off_the_event_loop(tmp_path):
    """While the reference lock is held (a genome download), a session import waits in a worker: another
    request on the same event loop is served on time."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from routers.sessions import router
    from services.genome_loading import reference_lock
    from state.dependencies import get_dafc_state, get_state
    state = BrowserState(None)
    app = FastAPI()
    app.include_router(router)

    @app.get("/ping")
    async def ping():
        return {"ok": True}
    app.dependency_overrides[get_state] = lambda: state
    app.dependency_overrides[get_dafc_state] = lambda: None
    holding, done = threading.Event(), threading.Event()

    def hold():
        with reference_lock(state):
            holding.set()
            done.wait(5)
    holder = threading.Thread(target=hold)
    holder.start()
    assert holding.wait(5)

    async def run():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
            importing = asyncio.create_task(client.post("/api/session/import", json={"session": {"version": "2.0", "datasets": []}}))
            await asyncio.sleep(0.05)
            started = time.perf_counter()
            pong = await client.get("/ping")
            waited = time.perf_counter() - started
            assert pong.status_code == 200 and waited < 0.3, waited
            assert not importing.done()          # still waiting for the lock, in its worker
            done.set()
            result = await importing
            assert result.status_code == 200
    try:
        asyncio.run(run())
    finally:
        done.set()
        holder.join(5)


# --- Codex round 3 ---------------------------------------------------------------------------------------


def test_a_panel_view_reads_its_context_live(tmp_path, monkeypatch):
    """Codex round 3, second reproduction: a view made while its context held hg38 answered already_loaded for
    hg38 after the context had become mm10."""
    from services import panel_genomes
    from services.genome_loading import genome_already_loaded
    state = BrowserState(None)
    ctx = BrowserState(None)
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    ctx._load_fasta(_fasta(tmp_path, "hg38.fa", 300))
    ctx.current_genome = "hg38"
    view = panel_genomes.genome_view(state, "other")
    assert genome_already_loaded(view, "hg38")
    ctx._load_fasta(_fasta(tmp_path, "mm10.fa", 200))
    ctx.current_genome = "mm10"
    assert view.fasta_path.endswith("mm10.fa") and view.current_genome == "mm10"
    assert not genome_already_loaded(view, "hg38")
    view.gtf_path = "/x/a.gtf"                       # writes still go to the context only
    assert ctx.gtf_path == "/x/a.gtf" and "gtf_path" not in view.__dict__


def test_a_queued_fasta_load_on_a_panel_view_sees_the_finished_genome_load(tmp_path, monkeypatch):
    """Codex round 3, first reproduction: view B, made while hg38 was half installed, waited for the lock and
    then loaded mm10 without seeing hg38's new annotation: mm10 sequence under hg38's annotation."""
    from services import panel_genomes
    from services.genome_loading import reference_lock
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    state = BrowserState(None)
    ctx = BrowserState(None)
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    view_a = panel_genomes.genome_view(state, "other")
    load, installed, release = _paused_registry_load(view_a, monkeypatch, tmp_path, "hg38",
                                                     _fasta(tmp_path, "hg38_dl.fa", 300), "HG38GENE")
    load.start()
    assert installed.wait(5)
    view_b = panel_genomes.genome_view(state, "other")
    mm10 = _fasta(tmp_path, "mm10.fa", 200)

    def load_mm10():
        with reference_lock(view_b):
            view_b._load_fasta(mm10)
    second = threading.Thread(target=load_mm10)
    second.start()
    time.sleep(0.2)
    release.set()
    load.join(10)
    second.join(10)
    assert ctx.fasta.get_reference_length("chr1") == 200
    assert _genes(ctx) != {"HG38GENE"}            # hg38's annotation went with its sequence
    assert ctx.current_genome != "hg38"


def test_a_panel_genome_download_does_not_stall_other_sessions_or_the_event_loop(tmp_path, monkeypatch):
    """Codex round 3: attaching a registry genome held the process-wide panel registry lock during its download,
    and another session's dataset removal (an async route) waited for it on the event loop."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from services import panel_genomes
    from routers.datasets import router
    from state.dependencies import get_state
    import pysam
    downloading, finish = threading.Event(), threading.Event()

    def slow_registry(genome_id):
        downloading.set()
        finish.wait(5)
        return BrowserState(None)
    monkeypatch.setattr(panel_genomes, "_load_registry", slow_registry)

    def bam(path):
        with pysam.AlignmentFile(str(path), "wb", header={"HD": {"VN": "1.6"}, "SQ": [{"SN": "chr1", "LN": 1000}]}):
            pass
        pysam.index(str(path))
        return str(path)
    a, b = BrowserState(None), BrowserState(None)
    a.add_dataset("x", bam(tmp_path / "x.bam"))
    b.add_dataset("y", bam(tmp_path / "y.bam"))
    attach = threading.Thread(target=panel_genomes.attach, args=(a, ["x"]), kwargs={"genome_id": "mm10", "span": 0})
    attach.start()
    assert downloading.wait(5)
    app = FastAPI()
    app.include_router(router)

    @app.get("/ping")
    async def ping():
        return {"ok": True}
    app.dependency_overrides[get_state] = lambda: b

    async def run():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
            started = time.perf_counter()
            removed = await client.delete("/api/datasets/y")
            assert removed.json()["success"] and time.perf_counter() - started < 0.5
            started = time.perf_counter()
            assert (await client.get("/ping")).status_code == 200 and time.perf_counter() - started < 0.3
    try:
        asyncio.run(run())
        assert "y" not in b.datasets
    finally:
        finish.set()
        attach.join(10)
    assert panel_genomes.assignments(a).get("x") == "mm10"


def test_public_visitor_forks_share_the_templates_reference_lock(tmp_path, monkeypatch):
    """Codex round 3: two public visitors (sessions forked from one template, writes routed to it) loaded hg38
    under their own locks; A's failure cleanup cleared B's newly installed FASTA."""
    import services.genome_loading as gl
    from services.genome_loading import load_genome_blocking, reference_lock, reference_owner
    from services.runtime import allow_shared_writes
    template = BrowserState(None)
    a = BrowserState.fork_for_session(template)
    b = BrowserState.fork_for_session(template)
    tour = BrowserState.fork_for_session(template, copy_shared=True, include_data=False)
    assert reference_owner(a) is reference_owner(b) is template
    assert reference_lock(a) is reference_lock(b) is reference_lock(template)
    assert reference_owner(tour) is tour and reference_lock(tour) is not reference_lock(template)

    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    good = _fasta(tmp_path, "hg38.fa", 300)
    calls = []
    real = BrowserState._load_fasta

    def flaky(self, path, **k):
        calls.append(path)
        if len(calls) == 1:
            return "temporary download failure"          # visitor A's FASTA fails ...
        return real(self, good)
    monkeypatch.setattr(BrowserState, "_load_fasta", flaky)
    parse_a = threading.Event()

    def gtf(url, path):
        if len(calls) == 1:
            parse_a.wait(1)                                 # ... and its annotation step is slow
        open(path, "w").write(open(_gtf(tmp_path, "hg38.src.gtf", "HG38GENE")).read())
    monkeypatch.setattr(gl, "_download_gtf", gtf)
    info = {"name": "hg38", "fasta_url": "https://example.invalid/hg38.fa", "gtf_url": "https://example.invalid/hg38.gtf"}
    results = {}

    def visit(name, state):
        with allow_shared_writes():
            results[name] = load_genome_blocking(state, "hg38", info)
    ta = threading.Thread(target=visit, args=("a", a))
    ta.start()
    time.sleep(0.1)
    tb = threading.Thread(target=visit, args=("b", b))
    tb.start()
    time.sleep(0.2)
    parse_a.set()
    ta.join(10)
    tb.join(10)
    assert results["b"]["fasta_loaded"] is True
    assert template.fasta is not None and template.fasta_path == good


def _pending_gtf_env(tmp_path, monkeypatch):
    """A registry genome whose FASTA loads locally and whose annotation is over the download warning size
    until confirmed (the first ``_download_gtf`` raises LargeDownload, later ones write it)."""
    import services.genome_loading as gl
    from services.http_download import LargeDownload
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".fiberhmm" / "genomes").mkdir(parents=True)
    good = _fasta(tmp_path, "pg.fa", 300)
    real = BrowserState._load_fasta
    monkeypatch.setattr(BrowserState, "_load_fasta", lambda self, path, **k: real(self, good))
    attempts = []

    def gtf(url, path):
        attempts.append(url)
        if len(attempts) == 1:
            raise LargeDownload(url, 10_000, 5_000)
        open(path, "w").write(open(_gtf(tmp_path, "pg.src.gtf", "PGGENE")).read())
    monkeypatch.setattr(gl, "_download_gtf", gtf)
    info = {"name": "Pending GTF", "fasta_url": "https://example.invalid/pg.fa", "gtf_url": "https://example.invalid/pg.gtf"}
    return info, attempts


def test_a_pending_annotation_belongs_to_the_panel_genomes_context(tmp_path, monkeypatch):
    """3.1.0 re-check N4: the pending-annotation mark sat on the state object it was written through; a panel
    view (one per request) wrote it on itself, so the next view found the genome "already loaded"."""
    from services import panel_genomes
    from services.genome_loading import genome_already_loaded, load_genome_blocking
    info, attempts = _pending_gtf_env(tmp_path, monkeypatch)
    state = BrowserState(None)
    ctx = BrowserState(None)
    monkeypatch.setattr(panel_genomes, "contexts", lambda s: {"other": ctx})
    first = load_genome_blocking(panel_genomes.genome_view(state, "other"), "pg", info)
    assert first.get("needs_confirmation") and first.get("fasta_loaded")
    retry_view = panel_genomes.genome_view(state, "other")
    assert not genome_already_loaded(retry_view, "pg") and not genome_already_loaded(ctx, "pg")
    assert getattr(state, "__dict__", {}).get("pending_annotation") is None     # the main reference is untouched
    second = load_genome_blocking(retry_view, "pg", info)
    assert second.get("gtf_loaded") and not second.get("needs_confirmation") and len(attempts) == 2
    assert genome_already_loaded(panel_genomes.genome_view(state, "other"), "pg")


def test_a_pending_annotation_is_shared_by_forks_of_one_reference(tmp_path, monkeypatch):
    from services.genome_loading import genome_already_loaded, load_genome_blocking
    from services.runtime import allow_shared_writes
    info, attempts = _pending_gtf_env(tmp_path, monkeypatch)
    template = BrowserState(None)
    a = BrowserState.fork_for_session(template)
    b = BrowserState.fork_for_session(template)
    with allow_shared_writes():
        first = load_genome_blocking(a, "pg", info)
        assert first.get("needs_confirmation")
        assert not genome_already_loaded(b, "pg") and not genome_already_loaded(template, "pg")
        second = load_genome_blocking(b, "pg", info)
    assert second.get("gtf_loaded") and len(attempts) == 2
    assert genome_already_loaded(a, "pg") and genome_already_loaded(template, "pg")


def test_a_copy_of_a_pending_reference_keeps_its_pending_annotation(tmp_path, monkeypatch):
    """3.1.0 re-check 2 (item 4): a copy_shared fork (a tour tab) copied the FASTA and genome id of a reference
    whose annotation waited for confirmation, but not the mark: the copy's retry answered "already loaded"."""
    from services.genome_loading import genome_already_loaded, load_genome_blocking
    from services.runtime import allow_shared_writes
    info, attempts = _pending_gtf_env(tmp_path, monkeypatch)
    template = BrowserState(None)
    with allow_shared_writes():
        assert load_genome_blocking(template, "pg", info).get("needs_confirmation")
    tour = BrowserState.fork_for_session(template, copy_shared=True, include_data=False)
    assert not genome_already_loaded(tour, "pg")
    assert load_genome_blocking(tour, "pg", info).get("gtf_loaded") and len(attempts) == 2
    # The copy owns its reference: the template's annotation still waits.
    assert not genome_already_loaded(template, "pg") and genome_already_loaded(tour, "pg")


def test_the_public_routes_confirmed_retry_finishes_the_annotation(tmp_path, monkeypatch):
    """3.1.0 re-check 2 (item 3): on a public server the route's own "already loaded" shortcut (genome id and a
    FASTA) answered the confirmed retry without loading the pending annotation."""
    import asyncio
    from routers import genome as route
    from services import catalog_endpoint, genome_registry, runtime
    from services.genome_loading import genome_already_loaded
    info, attempts = _pending_gtf_env(tmp_path, monkeypatch)
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, "pg", info)
    monkeypatch.setitem(route.GENOME_REGISTRY, "pg", info)
    monkeypatch.setattr(runtime, "get_public_mode", lambda: True)
    monkeypatch.setattr(catalog_endpoint, "catalog_genome", lambda: "pg")
    state = BrowserState(None)
    first = asyncio.run(route.load_genome(genome_id="pg", confirm_large=False, state=state))
    assert first.get("needs_confirmation")
    second = asyncio.run(route.load_genome(genome_id="pg", confirm_large=True, state=state))
    assert second.get("gtf_loaded") and len(attempts) == 2, second
    assert genome_already_loaded(state, "pg")


def test_a_panel_genome_with_a_pending_annotation_is_not_reused(tmp_path, monkeypatch):
    """3.1.0 re-check 2 (item 2), mitigation: attaching a registry genome whose annotation is over the download
    warning size made a sequence-only context, and every later attachment reused it (the annotation was never
    tried again). The attachment now says the annotation is pending, and the next one loads the context again."""
    from models.domain import Dataset
    from services import genome_registry, panel_genomes
    info, attempts = _pending_gtf_env(tmp_path, monkeypatch)
    monkeypatch.setitem(genome_registry.GENOME_REGISTRY, "pg", info)
    state = BrowserState(None)
    state.datasets["ds"] = Dataset("ds", [str(tmp_path / "x.bam")], "ds", data_type="bam")
    first = panel_genomes.attach(state, ["ds"], genome_id="pg", span=0)
    assert first["genome"]["annotation_pending"]["url"].endswith("pg.gtf") and not first["genome"]["has_gtf"]
    second = panel_genomes.attach(state, ["ds"], genome_id="pg", span=0)
    assert len(attempts) == 2 and second["genome"]["has_gtf"] and second["genome"]["annotation_pending"] is None
    third = panel_genomes.attach(state, ["ds"], genome_id="pg", span=0)
    assert len(attempts) == 2 and third["genome"]["has_gtf"]      # a complete context is reused
