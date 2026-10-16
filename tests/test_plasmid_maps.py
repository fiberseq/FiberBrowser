from services.plasmid_maps import (
    parse_embl,
    parse_genbank,
    parse_plasmid_map,
    parse_sbol,
    parse_snapgene,
    plasmid_features_to_gtf_data,
)


def test_parse_genbank_plasmid_sequence_and_features(tmp_path):
    path = tmp_path / "test.gbk"
    path.write_text(
        """LOCUS       pTest        24 bp    DNA     circular SYN 01-JAN-2000
FEATURES             Location/Qualifiers
     gene            3..12
                     /gene="geneA"
     CDS             complement(15..22)
                     /label="geneB"
ORIGIN
        1 acgtacgtac gtacgtacgt acgt
//
""",
        encoding="utf-8",
    )

    plasmid = parse_genbank(str(path))
    gtf = plasmid_features_to_gtf_data(plasmid)

    assert plasmid.name == "pTest"
    assert plasmid.circular is True
    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert [(f.name, f.start, f.end, f.strand) for f in plasmid.features] == [
        ("geneA", 2, 12, "+"),
        ("geneB", 14, 22, "-"),
    ]
    assert len(gtf["transcripts"]) == 2
    assert list(gtf["transcripts"]["gene_name"]) == ["geneA", "geneB"]


def test_parse_genbank_feature_wrapping_origin(tmp_path):
    path = tmp_path / "wrap.gbk"
    path.write_text(
        """LOCUS       pWrap        24 bp    DNA     circular SYN 01-JAN-2000
FEATURES             Location/Qualifiers
     gene            join(20..24,1..4)
                     /gene="wrapGene"
ORIGIN
        1 acgtacgtac gtacgtacgt acgt
//
""",
        encoding="utf-8",
    )

    plasmid = parse_genbank(str(path))

    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert [(f.name, f.start, f.end, f.strand) for f in plasmid.features] == [
        ("wrapGene", 19, 28, "+"),
    ]


def test_parse_snapgene_warns_best_effort(tmp_path):
    path = tmp_path / "test.dna"
    path.write_bytes(b"header" + b"ACGT" * 20 + b"footer")

    plasmid = parse_snapgene(str(path))

    assert plasmid.sequence == "ACGT" * 20
    assert any("best-effort" in warning for warning in plasmid.warnings)


def test_parse_embl_sequence_and_features(tmp_path):
    path = tmp_path / "test.embl"
    path.write_text(
        """ID   pEmbl; circular; DNA; SYN; 24 BP.
FH   Key             Location/Qualifiers
FT   gene            3..12
FT                   /gene="geneA"
FT   CDS             complement(15..22)
FT                   /label="geneB"
SQ   Sequence 24 BP; 6 A; 6 C; 6 G; 6 T; 0 other;
     acgtacgtac gtacgtacgt acgt
//
""",
        encoding="utf-8",
    )

    plasmid = parse_embl(str(path))

    assert plasmid.name == "pEmbl"
    assert plasmid.circular is True
    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert [(f.name, f.start, f.end, f.strand) for f in plasmid.features] == [
        ("geneA", 2, 12, "+"),
        ("geneB", 14, 22, "-"),
    ]


def test_parse_fasta_with_gff3_companion(tmp_path):
    fasta = tmp_path / "plasmid.fa"
    gff = tmp_path / "plasmid.gff3"
    fasta.write_text(">pFasta circular\nACGTACGTACGTACGTACGTACGT\n", encoding="utf-8")
    gff.write_text(
        """##gff-version 3
pFasta\tFiberBrowser\tgene\t3\t12\t.\t+\t.\tID=geneA;Name=geneA
pFasta\tFiberBrowser\tCDS\t15\t22\t.\t-\t.\tID=cdsB;product=geneB
""",
        encoding="utf-8",
    )

    plasmid = parse_plasmid_map(str(fasta))

    assert plasmid.name == "pFasta"
    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert [(f.name, f.start, f.end, f.strand, f.kind) for f in plasmid.features] == [
        ("geneA", 2, 12, "+", "gene"),
        ("geneB", 14, 22, "-", "CDS"),
    ]


def test_parse_bed_with_fasta_companion_when_bed_is_loaded(tmp_path):
    fasta = tmp_path / "plasmid.fa"
    bed = tmp_path / "plasmid.bed"
    fasta.write_text(">pBed\nACGTACGTACGTACGTACGTACGT\n", encoding="utf-8")
    bed.write_text(
        """pBed\t2\t12\tgeneA\t0\t+
pBed\t14\t22\tgeneB\t0\t-
""",
        encoding="utf-8",
    )

    plasmid = parse_plasmid_map(str(bed))

    assert plasmid.name == "pBed"
    assert [(f.name, f.start, f.end, f.strand, f.kind) for f in plasmid.features] == [
        ("geneA", 2, 12, "+", "bed_feature"),
        ("geneB", 14, 22, "-", "bed_feature"),
    ]


def test_parse_sbol_rdf_xml_sequence_and_ranges(tmp_path):
    path = tmp_path / "plasmid.rdf"
    path.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:sbol="http://sbols.org/v2#">
  <sbol:Sequence rdf:about="http://example.org/pSbol_seq">
    <sbol:displayId>pSbol_seq</sbol:displayId>
    <sbol:elements>ACGTACGTACGTACGTACGTACGT</sbol:elements>
  </sbol:Sequence>
  <sbol:ComponentDefinition rdf:about="http://example.org/pSbol">
    <sbol:displayId>pSbol</sbol:displayId>
    <sbol:sequence rdf:resource="http://example.org/pSbol_seq"/>
    <sbol:sequenceAnnotation>
      <sbol:SequenceAnnotation rdf:about="http://example.org/ann1">
        <sbol:displayId>geneA</sbol:displayId>
        <sbol:location>
          <sbol:Range>
            <sbol:start>3</sbol:start>
            <sbol:end>12</sbol:end>
            <sbol:orientation rdf:resource="http://sbols.org/v2#inline"/>
          </sbol:Range>
        </sbol:location>
      </sbol:SequenceAnnotation>
    </sbol:sequenceAnnotation>
    <sbol:sequenceAnnotation>
      <sbol:SequenceAnnotation rdf:about="http://example.org/ann2">
        <sbol:displayId>geneB</sbol:displayId>
        <sbol:location>
          <sbol:Range>
            <sbol:start>15</sbol:start>
            <sbol:end>22</sbol:end>
            <sbol:orientation rdf:resource="http://sbols.org/v2#reverseComplement"/>
          </sbol:Range>
        </sbol:location>
      </sbol:SequenceAnnotation>
    </sbol:sequenceAnnotation>
  </sbol:ComponentDefinition>
</rdf:RDF>
""",
        encoding="utf-8",
    )

    plasmid = parse_sbol(str(path))

    assert plasmid.name == "pSbol"
    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert [(f.name, f.start, f.end, f.strand) for f in plasmid.features] == [
        ("geneA", 2, 12, "+"),
        ("geneB", 14, 22, "-"),
    ]
    assert any("best-effort" in warning for warning in plasmid.warnings)


def test_parse_sbol_turtle_sequence_only(tmp_path):
    path = tmp_path / "plasmid.ttl"
    path.write_text(
        """
@prefix sbol: <http://sbols.org/v2#> .
<http://example.org/pTtl> sbol:displayId "pTtl" ;
  sbol:elements "ACGTACGTACGTACGTACGTACGT" ;
  sbol:topology <http://identifiers.org/so/SO:0000988> .
""",
        encoding="utf-8",
    )

    plasmid = parse_plasmid_map(str(path))

    assert plasmid.name == "pTtl"
    assert plasmid.sequence == "ACGTACGTACGTACGTACGTACGT"
    assert plasmid.features == []
    assert any("sequence-only" in warning for warning in plasmid.warnings)
