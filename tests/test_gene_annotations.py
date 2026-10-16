import os
"""Regression tests for extracted gene annotation helpers."""

from services import gene_annotations


def test_attribute_parsers():
    gtf_attrs = 'gene_id "gene1"; transcript_id "tx1"; gene_name "Alpha";'
    gff3_attrs = "ID=tx1;Name=Alpha%20Gene;Parent=gene1"

    assert gene_annotations._parse_gtf_attrs(gtf_attrs) == {
        "gene_id": "gene1",
        "transcript_id": "tx1",
        "gene_name": "Alpha",
    }
    assert gene_annotations._parse_gff3_attrs(gff3_attrs)["Name"] == "Alpha Gene"


def test_load_gtf_parses_gtf_and_uses_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    gtf_path = tmp_path / "example.gtf"
    gtf_path.write_text(
        "\n".join(
            [
                'chr2L\tsrc\ttranscript\t10\t50\t.\t+\t.\tgene_id "gene1"; transcript_id "tx1"; gene_name "Alpha"; gene_biotype "protein_coding";',
                'chr2L\tsrc\texon\t10\t20\t.\t+\t.\tgene_id "gene1"; transcript_id "tx1";',
            ]
        )
        + "\n"
    )

    data = gene_annotations.load_gtf(str(gtf_path))
    transcripts = data["transcripts"]
    exons = data["exons"]

    assert list(transcripts["gene_name"]) == ["Alpha"]
    assert list(transcripts["transcript_id"]) == ["tx1"]
    assert list(transcripts["norm_chrom"]) == ["2l"]
    assert list(exons["transcript_id"]) == ["tx1"]
    assert "2l" in data["tx_by_chrom"]
    # GTF is 1-based inclusive; the browser is 0-based half-open.
    assert (int(transcripts["start"][0]), int(transcripts["end"][0])) == (9, 50)
    assert (int(exons["start"][0]), int(exons["end"][0])) == (9, 20)
    # The cache is FiberBrowser's own (never written next to the user's file).
    assert not (tmp_path / "example.gtf.fbcache.json").exists()
    assert os.path.exists(gene_annotations.annotation_cache_path(str(gtf_path)))

    cached = gene_annotations.load_gtf(str(gtf_path))
    assert cached["transcripts"].equals(transcripts)
    assert cached["exons"].equals(exons)
    assert "2l" in cached["tx_by_chrom"]


class _OpensAFile:
    """Unpickling this creates a file: proof that a pickle was loaded."""

    def __init__(self, path):
        self.path = path

    def __reduce__(self):
        return (open, (self.path, "w"))


def test_load_gtf_never_unpickles_a_cache_next_to_the_annotation(tmp_path):
    import os
    import pickle
    import time

    gtf_path = tmp_path / "example.gtf"
    gtf_path.write_text(
        'chr2L\tsrc\ttranscript\t10\t50\t.\t+\t.\tgene_id "g"; transcript_id "tx1"; gene_name "Alpha";\n'
    )
    marker = tmp_path / "unpickled"
    pkl = tmp_path / "example.gtf.pkl"
    pkl.write_bytes(pickle.dumps(_OpensAFile(str(marker))))
    later = time.time() + 5
    os.utime(pkl, (later, later))

    data = gene_annotations.load_gtf(str(gtf_path))
    assert list(data["transcripts"]["transcript_id"]) == ["tx1"]
    assert not marker.exists()


def test_gff3_coordinates_are_zero_based(tmp_path):
    gff_path = tmp_path / "example.gff3"
    gff_path.write_text(
        "##gff-version 3\n"
        "chrI\tsrc\tmRNA\t5\t20\t.\t+\t.\tID=tx1;Name=A\n"
        "chrI\tsrc\texon\t5\t12\t.\t+\t.\tParent=tx1\n"
    )
    data = gene_annotations.load_gtf(str(gff_path))
    assert (int(data["transcripts"]["start"][0]), int(data["transcripts"]["end"][0])) == (4, 20)
    assert (int(data["exons"]["start"][0]), int(data["exons"]["end"][0])) == (4, 12)


def test_load_gtf_synthesizes_gene_only_gff3_transcripts(tmp_path):
    gff_path = tmp_path / "example.gff3"
    gff_path.write_text(
        "\n".join(
            [
                "##gff-version 3",
                "chrI\tsrc\tgene\t5\t20\t.\t-\t.\tID=gene1;Name=My%20Gene;biotype=lnc_RNA",
            ]
        )
        + "\n"
    )

    data = gene_annotations.load_gtf(str(gff_path))
    transcript = data["transcripts"].iloc[0].to_dict()

    assert transcript["transcript_id"] == "gene1"
    assert transcript["gene_name"] == "My Gene"
    assert transcript["biotype"] == "lnc_RNA"
    assert transcript["norm_chrom"] == "1"


def test_clean_blast_name():
    raw_name = (
        "(52-240/254)-NP_610955.1-"
        "Activity-regulated-cytoskeleton-associated-protein-1-"
        "[Drosophila-melanogaster]_78067_78699"
    )

    assert gene_annotations._clean_blast_name(raw_name) == (
        "Activity regulated cytoskeleton associated protein 1"
    )
