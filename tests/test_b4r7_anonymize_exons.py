"""B4 round 7: anonymized sharing buckets a gene's exon/transcript coordinates too."""
import asyncio
import json

from routers import natural_language as nl


def _share(tmp_path, monkeypatch, **fields):
    monkeypatch.setattr(nl, "USAGE_LOG_DIR", tmp_path / "usage_logs")
    monkeypatch.setattr(nl, "SHARED_USAGE_FILE", tmp_path / "shared_usage.jsonl")
    asyncio.run(nl.log_session(nl.SessionLogRequest(session_id="s1", started_at=1.0, share=True, **fields)))
    return (tmp_path / "shared_usage.jsonl").read_text()


def test_selected_gene_exon_coordinates_are_bucketed(tmp_path, monkeypatch):
    gene = {"name": "TP53", "chrom": "chr17", "start": 7661779, "end": 7687538, "strand": "-",
            "exons": [{"start": 7661779, "end": 7662014}, [7668402, 7669690]],
            "transcripts": [{"id": "ENST00000269305", "exons": [{"start": 7673535, "end": 7673608}]}]}
    text = _share(tmp_path, monkeypatch,
                  snapshots=[{"label": "Select gene", "timestamp": 1, "state": {"selectedGenes": [gene]}}])
    for secret in ("7662014", "7668402", "7669690", "7673535", "7673608", "TP53", "ENST00000269305"):
        assert secret not in text, secret
    out = json.loads(text)["snapshots"][0]["state"]["selectedGenes"][0]
    assert out["exons"][0] == {"start": 7661000, "end": 7662000}
    assert out["exons"][1] == [7668000, 7669000]
    assert out["transcripts"][0]["exons"][0] == {"start": 7673000, "end": 7673000}
