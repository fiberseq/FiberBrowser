"""Audit (final 3.1.0, HIGH): on a lab server a FASTA inside the member's roots whose ``.fai`` is a link to a file
outside them never has that index read: not by /api/genome/fasta_assembly, and not by the recent-genome match
scoring (services/recent_genomes.fai_contigs), including from a copy cached by an earlier, unconfined read."""
from __future__ import annotations

from lab_fixtures import _lab, lab, member_client  # noqa: F401

HG38_CHR1 = 248_956_422


def _fasta_with_escaping_index(lab):
    secret_fai = lab.outside / "secret.fa.fai"
    secret_fai.write_text(f"chr1\t{HG38_CHR1}\t6\t60\t61\nsecret_contig\t1234\t0\t60\t61\n")
    fasta = lab.data / "ref.fa"
    fasta.write_text(">chr1\nACGT\n")
    (lab.data / "ref.fa.fai").symlink_to(secret_fai)
    inside = lab.data / "ok.fa"
    inside.write_text(">chrA\nACGT\n")
    (lab.data / "ok.fa.fai").write_text("chrA\t4\t6\t4\t5\n")
    return fasta, inside


def test_an_index_link_outside_the_roots_is_never_read(lab):
    from services import recent_genomes as RG
    from services.runtime import lab_request_context
    fasta, inside = _fasta_with_escaping_index(lab)
    # The server's own (unconfined) work may read and cache it ...
    assert "secret_contig" in RG.fai_contigs(str(fasta))
    # ... a member's request never gets it, cached or not.
    lab.users.add("carol", role="member", password="correct horse battery")
    with lab_request_context(lab.users.get("carol")):
        assert RG.fai_contigs(str(fasta)) == {}
        assert RG.fai_contigs(str(inside)) == {"chrA": 4}
    client = member_client(lab, "alice")
    r = client.get("/api/genome/fasta_assembly", params={"path": str(fasta)})
    assert r.status_code == 200 and r.json()["assembly"] is None
    r = client.get("/api/genome/fasta_assembly", params={"path": str(lab.outside / "secret.bam")})
    assert r.status_code == 403 or r.json() == {"exists": False, "assembly": None}
