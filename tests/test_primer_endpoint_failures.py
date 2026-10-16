import pytest


STANDARD_PAYLOAD = {"chrom": "chr1", "start": 100, "end": 200}
DAFC_PAYLOAD = {"chrom": "chr1", "x_start": 100, "x_end": 200, "y_start": 500, "y_end": 600}
FOURC_PAYLOAD = {"chrom": "chr1", "start": 100, "end": 300}


@pytest.fixture()
def primer_state_guard():
    import server as srv

    sentinel = object()
    keys = ("primer_fasta", "fasta_path", "primer_blast_db", "current_genome")
    old_values = {key: getattr(srv.state, key, sentinel) for key in keys}
    try:
        yield srv.state
    finally:
        for key, value in old_values.items():
            if value is sentinel:
                if hasattr(srv.state, key):
                    delattr(srv.state, key)
            else:
                setattr(srv.state, key, value)


@pytest.mark.parametrize(
    "endpoint,payload,expected",
    [
        ("/api/design_primers", STANDARD_PAYLOAD, "FASTA file not configured"),
        ("/api/design_dafc_primers", DAFC_PAYLOAD, "FASTA file not configured"),
        ("/api/design_4c_primers", FOURC_PAYLOAD, "FASTA file not configured"),
    ],
)
def test_primer_design_endpoints_report_missing_fasta(client, primer_state_guard, endpoint, payload, expected):
    primer_state_guard.primer_fasta = None
    primer_state_guard.fasta_path = None
    primer_state_guard.primer_blast_db = None

    resp = client.post(endpoint, json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert expected in body["message"]


@pytest.mark.parametrize(
    "endpoint,payload,expected",
    [
        ("/api/design_primers", STANDARD_PAYLOAD, "BLAST database not configured"),
        ("/api/design_dafc_primers", DAFC_PAYLOAD, "BLAST database not configured"),
        ("/api/design_4c_primers", FOURC_PAYLOAD, "BLAST database not configured"),
    ],
)
def test_primer_design_endpoints_report_missing_blast_db(client, primer_state_guard, tmp_path, endpoint, payload, expected):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr1\n" + "A" * 1000 + "\n")
    primer_state_guard.primer_fasta = None
    primer_state_guard.fasta_path = str(fasta)
    primer_state_guard.primer_blast_db = None
    primer_state_guard.current_genome = "dm6"

    resp = client.post(endpoint, json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert expected in body["message"]


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("/api/design_primers", STANDARD_PAYLOAD),
        ("/api/design_dafc_primers", DAFC_PAYLOAD),
        ("/api/design_4c_primers", FOURC_PAYLOAD),
    ],
)
def test_primer_design_endpoints_report_mismatched_blast_db(client, primer_state_guard, tmp_path, endpoint, payload):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr1\n" + "A" * 1000 + "\n")
    (tmp_path / "hg38.nin").write_text("")
    primer_state_guard.primer_fasta = None
    primer_state_guard.fasta_path = str(fasta)
    primer_state_guard.primer_blast_db = str(tmp_path / "hg38")
    primer_state_guard.current_genome = "dm6"

    resp = client.post(endpoint, json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert "doesn't match current genome 'dm6'" in body["message"]


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("/api/design_primers", STANDARD_PAYLOAD),
        ("/api/design_dafc_primers", DAFC_PAYLOAD),
        ("/api/design_4c_primers", FOURC_PAYLOAD),
    ],
)
def test_primer_design_endpoints_report_missing_blastn(
    client,
    primer_state_guard,
    tmp_path,
    monkeypatch,
    endpoint,
    payload,
):
    fasta = tmp_path / "dm6.fa"
    fasta.write_text(">chr1\n" + "A" * 1000 + "\n")
    (tmp_path / "dm6.nin").write_text("")
    primer_state_guard.primer_fasta = None
    primer_state_guard.fasta_path = str(fasta)
    primer_state_guard.primer_blast_db = str(tmp_path / "dm6")
    primer_state_guard.current_genome = "dm6"
    monkeypatch.setattr("services.external_tools.tool_path", lambda _tool, **_kw: None)

    resp = client.post(endpoint, json=payload)

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert body["missing_dependency"] is True
    assert body["dependency"] == "blastn"
    assert "conda install -c bioconda blast" in body["message"]
