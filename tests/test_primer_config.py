from types import SimpleNamespace

from services.primer_config import (
    PRIMER_DIAGNOSTICS_ENV,
    auto_detect_blast_db,
    blast_db_exists,
    build_blast_db_from_fasta,
    genome_hints,
    log_primer_diagnostic,
    normalize_blast_db_prefix,
    primer_config_payload,
    prefix_matches_hints,
    resolve_blast_db_for_genome,
    scan_blast_dbs,
)


def test_scan_blast_dbs_uses_nin_prefixes(tmp_path):
    (tmp_path / "dm6.nin").write_text("")
    (tmp_path / "dm6.nsq").write_text("")
    (tmp_path / "hg38.nin").write_text("")

    assert scan_blast_dbs(str(tmp_path)) == [
        str(tmp_path / "dm6"),
        str(tmp_path / "hg38"),
    ]


def test_scan_blast_dbs_handles_alias_v5_and_multivolume_prefixes(tmp_path):
    (tmp_path / "dm6.nal").write_text("")
    (tmp_path / "hg38.ndb").write_text("")
    (tmp_path / "rn6.00.nin").write_text("")
    (tmp_path / "rn6.01.nin").write_text("")
    (tmp_path / "rn6.nal").write_text("")  # makeblastdb writes it next to the volumes
    (tmp_path / "mm10.00.nin").write_text("")  # volumes without their alias

    assert normalize_blast_db_prefix(str(tmp_path / "rn6.00.nin")) == str(tmp_path / "rn6")
    # Only prefixes blastn can open; mm10's volumes need an alias first.
    assert scan_blast_dbs(str(tmp_path)) == [
        str(tmp_path / "dm6"),
        str(tmp_path / "hg38"),
        str(tmp_path / "rn6"),
    ]


def test_volumes_without_alias_explain_the_fix(tmp_path):
    from services.primer_config import blast_db_missing_message, unopenable_blast_dbs
    (tmp_path / "mm10.00.nin").write_text("")
    (tmp_path / "mm10.01.nin").write_text("")
    assert scan_blast_dbs(str(tmp_path)) == []
    assert unopenable_blast_dbs(str(tmp_path)) == [str(tmp_path / "mm10")]
    message = blast_db_missing_message(str(tmp_path / "mm10"))
    assert "incomplete" in message and "mm10.00 mm10.01" in message and "mm10.nal" in message
    assert blast_db_missing_message(str(tmp_path / "nope")).startswith("BLAST database not found")


def test_blast_db_exists_accepts_v5_and_alias_markers(tmp_path):
    alias = tmp_path / "dm6_alias"
    v5 = tmp_path / "hg38_v5"
    (tmp_path / "dm6_alias.nal").write_text("")
    (tmp_path / "hg38_v5.ndb").write_text("")

    assert blast_db_exists(str(alias))
    assert blast_db_exists(str(v5))
    assert not blast_db_exists(str(tmp_path / "missing"))


def test_genome_hints_and_prefix_matching():
    state = SimpleNamespace(current_genome="dm6", fasta_path="/ref/dm6_chr_only.fa")

    assert genome_hints(state) == ["dm6", "dm6_chr_only"]
    assert prefix_matches_hints("/db/dm6_main", genome_hints(state))
    assert not prefix_matches_hints("/db/hg38", genome_hints(state))
    assert auto_detect_blast_db(["/db/hg38", "/db/dm6_main"], state) == "/db/dm6_main"


def test_resolve_blast_db_auto_switches_matching_sibling(tmp_path):
    current = tmp_path / "hg38"
    matching = tmp_path / "dm6"
    (tmp_path / "hg38.nin").write_text("")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(current_genome="dm6", fasta_path=None, primer_blast_db=str(current))

    resolved, error = resolve_blast_db_for_genome(state)

    assert error is None
    assert resolved == str(matching)
    assert state.primer_blast_db == str(matching)


def test_primer_diagnostics_are_opt_in(monkeypatch, capsys):
    monkeypatch.delenv(PRIMER_DIAGNOSTICS_ENV, raising=False)
    log_primer_diagnostic("hidden")
    assert capsys.readouterr().out == ""

    monkeypatch.setenv(PRIMER_DIAGNOSTICS_ENV, "1")
    log_primer_diagnostic("visible")
    assert capsys.readouterr().out == "visible\n"


def test_resolve_blast_db_reports_unmatched_single_db(tmp_path):
    current = tmp_path / "hg38"
    (tmp_path / "hg38.nin").write_text("")
    state = SimpleNamespace(current_genome="dm6", fasta_path=None, primer_blast_db=str(current))

    resolved, error = resolve_blast_db_for_genome(state)

    assert resolved is None
    assert "doesn't match current genome 'dm6'" in error


def test_primer_config_payload_auto_switches_to_current_genome(tmp_path):
    current = tmp_path / "hg38"
    matching = tmp_path / "dm6"
    (tmp_path / "hg38.nin").write_text("")
    (tmp_path / "dm6.nin").write_text("")
    state = SimpleNamespace(
        current_genome="dm6",
        fasta_path=None,
        primer_fasta=None,
        primer_blast_db=str(current),
    )

    payload = primer_config_payload(state)

    assert payload["blast_db"] == str(matching)
    assert payload["blast_db_warning"] is None
    assert state.primer_blast_db == str(matching)


def test_build_blast_db_reports_missing_makeblastdb(tmp_path, monkeypatch):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    state = SimpleNamespace(
        current_genome="dm6",
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=None,
    )
    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: None)

    payload = build_blast_db_from_fasta(state, output_dir=str(tmp_path / "blast"))

    assert payload["success"] is False
    assert payload["missing_dependency"] is True
    assert payload["dependency"] == "makeblastdb"
    assert "conda install -c bioconda blast" in payload["message"]


def test_build_blast_db_reuses_existing_local_db(tmp_path, monkeypatch):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    out_dir = tmp_path / "blast"
    out_dir.mkdir()
    (out_dir / "dm6.nin").write_text("")
    state = SimpleNamespace(
        current_genome="dm6",
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=None,
    )
    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: "/usr/bin/makeblastdb")

    payload = build_blast_db_from_fasta(state, output_dir=str(out_dir))

    assert payload["success"] is True
    assert payload["created"] is False
    assert payload["blast_db"] == str(out_dir / "dm6")
    # The loaded reference was used automatically: no override recorded, and
    # the config reports the FASTA design will use.
    assert state.primer_fasta is None
    assert payload["fasta"] == str(fasta)
    assert state.primer_blast_db == str(out_dir / "dm6")


def test_build_blast_db_runs_makeblastdb_and_sets_config(tmp_path, monkeypatch):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr2L\nACGT\n")
    out_dir = tmp_path / "blast"
    state = SimpleNamespace(
        current_genome="dm6",
        fasta_path=str(fasta),
        primer_fasta=None,
        primer_blast_db=None,
    )
    calls = []

    def fake_run(command, capture_output, text, timeout):
        calls.append({
            "command": command,
            "capture_output": capture_output,
            "text": text,
            "timeout": timeout,
        })
        prefix = command[-1]
        with open(f"{prefix}.nin", "w", encoding="utf-8") as handle:
            handle.write("")
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: "/usr/bin/makeblastdb")
    monkeypatch.setattr("services.primer_config.subprocess.run", fake_run)

    payload = build_blast_db_from_fasta(state, output_dir=str(out_dir))

    assert payload["success"] is True
    assert payload["created"] is True
    assert payload["blast_db"] == str(out_dir / "dm6")
    assert calls[0]["command"] == [
        "/usr/bin/makeblastdb",
        "-in", str(fasta),
        "-dbtype", "nucl",
        "-parse_seqids",
        "-out", str(out_dir / "dm6"),
    ]
    assert state.primer_blast_db == str(out_dir / "dm6")


def test_primer_config_endpoint_refreshes_db_for_current_genome(client, tmp_path):
    import server as srv

    current = tmp_path / "hg38"
    matching = tmp_path / "dm6"
    (tmp_path / "hg38.nin").write_text("")
    (tmp_path / "dm6.nin").write_text("")
    old_values = {
        "current_genome": getattr(srv.state, "current_genome", None),
        "fasta_path": getattr(srv.state, "fasta_path", None),
        "primer_fasta": getattr(srv.state, "primer_fasta", None),
        "primer_blast_db": getattr(srv.state, "primer_blast_db", None),
    }
    try:
        srv.state.current_genome = "dm6"
        srv.state.fasta_path = None
        srv.state.primer_fasta = None
        srv.state.primer_blast_db = str(current)

        resp = client.get("/api/primer_config")

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["blast_db"] == str(matching)
        assert payload["current_genome"] == "dm6"
        assert payload["blast_db_warning"] is None
        assert srv.state.primer_blast_db == str(matching)
    finally:
        for key, value in old_values.items():
            setattr(srv.state, key, value)
