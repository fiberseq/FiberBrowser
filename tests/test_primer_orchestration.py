from types import SimpleNamespace

from services.primer_orchestration import resolve_primer_runtime_config


def test_runtime_config_uses_loaded_fasta_and_requires_blast_db(tmp_path):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    state = SimpleNamespace(
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=None,
        current_genome="dm6",
    )

    runtime, error = resolve_primer_runtime_config(
        state,
        require_blastn=False,
        missing_blast_message="Need a BLAST DB.",
    )

    assert runtime is None
    assert error == {"success": False, "message": "Need a BLAST DB."}
    # The automatic choice isn't persisted as an override (it follows genome loads).
    assert state.primer_fasta is None


def test_runtime_config_reports_missing_blastn(tmp_path, monkeypatch):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=str(tmp_path / "dm6"),
        current_genome="dm6",
    )
    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: None)

    runtime, error = resolve_primer_runtime_config(state)

    assert runtime is None
    assert error["success"] is False
    assert error["missing_dependency"] is True
    assert error["dependency"] == "blastn"


def test_runtime_config_reports_missing_blast_db_files(tmp_path):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    state = SimpleNamespace(
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=str(tmp_path / "dm6"),
        current_genome="dm6",
    )

    runtime, error = resolve_primer_runtime_config(state, require_blastn=False)

    assert runtime is None
    assert error == {"success": False, "message": f"BLAST database not found: {tmp_path / 'dm6'}"}


def test_runtime_config_auto_switches_matching_db_and_returns_paths(tmp_path, monkeypatch):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    (tmp_path / "hg38.nin").write_text("")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=str(tmp_path / "hg38"),
        current_genome="dm6",
    )
    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: "/usr/bin/blastn")

    runtime, error = resolve_primer_runtime_config(state)

    assert error is None
    assert runtime.fasta_path == str(fasta)
    assert runtime.blast_db_path == str(tmp_path / "dm6")
    assert state.primer_fasta is None
    assert state.primer_blast_db == str(tmp_path / "dm6")
