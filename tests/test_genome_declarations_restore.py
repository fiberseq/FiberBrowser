"""Genome declarations survive Reopen/Restore (Codex MED, fb62): listed for the autosave, put back on restore."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from state.browser_state import BrowserState


def _client(state):
    from routers.genome import router
    from state.dependencies import get_state
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_state] = lambda: state
    return TestClient(app)


def test_declarations_are_listed_and_put_back(tmp_path):
    from services.motifs import declared_genome, declaration_revision
    state = BrowserState(None)
    client = _client(state)
    assert client.get("/api/reference/genome_declarations").json()["declarations"] == []
    fasta = str(tmp_path / "custom_reference.fa")
    saved = [{"fasta_path": fasta, "genome": "dm6"}, {"fasta_path": "/x/y.fa", "genome": "not-a-genome"}]
    res = client.post("/api/reference/genome_declarations", json={"declarations": saved}).json()
    assert res["success"] and res["changed"]
    assert res["declarations"] == [{"fasta_path": fasta, "genome": "dm6"}]   # unknown genomes are not taken
    state.fasta_path = fasta
    assert declared_genome(state) == "dm6"
    revision = declaration_revision(state)
    # Again: nothing changes, the revision (genome-keyed caches) stays.
    assert not client.post("/api/reference/genome_declarations", json={"declarations": saved}).json()["changed"]
    assert declaration_revision(state) == revision
    assert client.get("/api/reference/genome_declarations").json()["declarations"] == [{"fasta_path": fasta, "genome": "dm6"}]
